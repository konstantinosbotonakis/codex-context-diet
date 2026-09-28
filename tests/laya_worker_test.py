"""Exercise the real worker process/socket lifecycle without model downloads."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


WORKER = Path(__file__).resolve().parents[1] / 'providers' / 'laya_worker.py'


class WorkerLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cd-laya-', dir='/tmp')
        self.root = Path(self.temp.name)
        self.path = self.root / 'worker.sock'
        # Only ping is used. The SDK's version is the only model dependency.
        (self.root / 'laya.py').write_text('__version__ = "test"\n')
        self.env = {**os.environ, 'PYTHONPATH': str(self.root)}
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            child.stderr.close()
        self.temp.cleanup()

    def start(self, *args):
        child = subprocess.Popen(
            [sys.executable, str(WORKER), 'serve', '--socket', str(self.path), *args],
            env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self.children.append(child)
        return child

    def request(self, op='ping'):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(1)
            client.connect(str(self.path))
            client.sendall(json.dumps({'op': op}).encode() + b'\n')
            return json.loads(client.recv(4096))

    def ready(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                if self.request().get('ok'):
                    return
            except (OSError, ValueError):
                time.sleep(.02)
        self.fail('worker did not become ready')

    def test_duplicate_start_does_not_replace_live_socket(self):
        first = self.start()
        self.ready()
        inode = self.path.stat().st_ino
        second = self.start()
        self.assertEqual(second.wait(timeout=4), 0)
        self.assertIsNone(first.poll())
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertTrue(self.request()['ok'])

    def test_concurrent_cold_starts_leave_one_worker(self):
        children = [self.start() for _ in range(8)]
        self.ready()
        deadline = time.monotonic() + 4
        while sum(child.poll() is None for child in children) > 1 and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(sum(child.poll() is None for child in children), 1)
        self.assertTrue(self.request()['ok'])

    def test_busy_worker_keeps_ownership(self):
        first = self.start()
        self.ready()
        inode = self.path.stat().st_ino
        with socket.socket(socket.AF_UNIX) as held:
            held.connect(str(self.path))
            second = self.start()
            self.assertEqual(second.wait(timeout=4), 0)
            self.assertEqual(self.path.stat().st_ino, inode)
        self.assertIsNone(first.poll())
        self.assertTrue(self.request()['ok'])

    def test_idle_worker_exits_and_next_start_recovers(self):
        first = self.start('--idle-timeout', '0.3')
        self.ready()
        self.assertEqual(first.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())
        self.start()
        self.ready()

    def test_sigterm_cleans_socket_and_allows_restart(self):
        first = self.start()
        self.ready()
        first.terminate()
        first.wait(timeout=3)
        self.assertFalse(self.path.exists())
        self.start()
        self.ready()

    def test_killed_worker_leaves_recoverable_stale_socket(self):
        first = self.start()
        self.ready()
        first.kill()
        first.wait(timeout=3)
        self.assertTrue(self.path.exists())
        self.start()
        self.ready()

    def test_legacy_listener_without_lock_is_not_unlinked(self):
        with socket.socket(socket.AF_UNIX) as legacy:
            legacy.bind(str(self.path))
            legacy.listen(8)
            inode = self.path.stat().st_ino
            child = self.start()
            self.assertEqual(child.wait(timeout=3), 0)
            self.assertEqual(self.path.stat().st_ino, inode)

    def test_stop_only_unlinks_owned_socket(self):
        first = self.start()
        self.ready()
        with socket.socket(socket.AF_UNIX) as client, socket.socket(socket.AF_UNIX) as replacement:
            client.settimeout(1)
            client.connect(str(self.path))
            self.path.unlink()
            replacement.bind(str(self.path))
            inode = self.path.stat().st_ino
            client.sendall(b'{"op":"stop"}\n')
            self.assertTrue(json.loads(client.recv(4096))['stopping'])
            self.assertEqual(first.wait(timeout=3), 0)
            self.assertEqual(self.path.stat().st_ino, inode)

    def test_stalled_client_does_not_prevent_idle_exit(self):
        first = self.start('--idle-timeout', '0.3')
        self.ready()
        with socket.socket(socket.AF_UNIX) as held:
            held.connect(str(self.path))
            self.assertEqual(first.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())

    def test_disconnected_stop_caller_still_shuts_down_worker(self):
        first = self.start()
        self.ready()
        with socket.socket(socket.AF_UNIX) as client:
            client.connect(str(self.path))
            client.sendall(b'{"op":"stop"}\n')
        self.assertEqual(first.wait(timeout=3), 0)
        self.assertFalse(self.path.exists())


if __name__ == '__main__':
    unittest.main()
