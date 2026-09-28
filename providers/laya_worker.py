#!/usr/bin/env python3
"""
Laya worker for Codex Context Diet.

Two modes:

  serve  a unix-socket daemon that loads the model once and answers requests
  ask    a one-shot request on stdin, for tests and for the first warm-up

The protocol is newline-delimited JSON, one request and one response per line:

  {"op": "ping"}                                  -> model, device, loaded
  {"op": "ask", "state": ..., "questions": {...}} -> Laya answers plus usage
  {"op": "stop"}                                  -> the daemon exits

Question and answer shapes are Laya's own, which match the plugin's: noul,
choice and score, each with calibrated probabilities.
"""
import argparse
import errno
import fcntl
import json
import os
import signal
import socket
import sys
import time


def log(message):
    print(message, file=sys.stderr, flush=True)


class Engine:
    """Loads the checkpoint once and answers with it."""

    def __init__(self, model, subfolder, device):
      self.model_id = model
      self.subfolder = subfolder or None
      self.device = device or None
      self.agent = None
      self.loaded_at = None
      self.head = None
      self.head_path = None
      # The question ids the head was fitted for. Anything else must go to the
      # checkpoint's own heads: the probe answers the diet questions, and using
      # it for another question would return a verdict about the wrong thing.
      self.head_questions = None
      # Captured when this process starts, so a plugin update or a retrained
      # head retires the daemon instead of keeping its stale decisions.
      self.worker_mtime = None
      self.head_mtime = None

    def load_head(self, path):
      """A small linear head fitted on this machine to match the teacher model."""
      import json

      with open(path, 'r', encoding='utf-8') as handle:
        document = json.load(handle)
      self.head = {
        'drop': document['drop']['weights'],
        'drop_threshold': document['drop']['threshold'],
        'hazard': document['hazard']['weights'],
        'hazard_threshold': document['hazard']['threshold'],
        'feature_dim': document['featureDim'],
        'lambda': document['lambda'],
      }
      covered = document.get('questions')
      self.head_questions = [str(name) for name in covered] if isinstance(covered, list) else []
      self.head_path = path
      try:
          self.head_mtime = os.path.getmtime(path)
      except OSError:
          pass

    def _features(self, state):
        """Mean-pooled, normalised encoder state: the head's only input."""
        import torch

        encoder = self.agent.model.encoder.eval()
        tokenizer = self.agent.tok
        encoded = tokenizer([state], return_tensors='pt', padding=True, truncation=True, max_length=512)
        encoded = {key: value.to(self.agent.device) for key, value in encoded.items()}
        with torch.no_grad():
            hidden = encoder(**encoded).last_hidden_state
        mask = encoded['attention_mask'].unsqueeze(-1).float()
        pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-6)
        pooled = torch.nn.functional.normalize(pooled, dim=-1).float().cpu().numpy()[0]
        return pooled

    def head_scores(self, state):
        if self.head is None:
            return None
        features = list(self._features(state)) + [1.0]
        drop = sum(weight * value for weight, value in zip(self.head['drop'], features))
        hazard = sum(weight * value for weight, value in zip(self.head['hazard'], features))
        return {
            'drop': round(float(drop), 4),
            'hazard': round(float(hazard), 4),
            'dropThreshold': self.head['drop_threshold'],
            'hazardThreshold': self.head['hazard_threshold'],
        }
    def load(self):
        if self.agent is not None:
            return
        import laya

        started = time.time()
        self.agent = laya.load(self.model_id, device=self.device, subfolder=self.subfolder)
        self.loaded_at = time.time()
        log('laya: loaded %s%s in %.1fs on %s' % (
            self.model_id,
            '/' + self.subfolder if self.subfolder else '',
            self.loaded_at - started,
            self.agent.device,
        ))

    def info(self):
        import laya

        return {
            'laya': getattr(laya, '__version__', 'unknown'),
            'model': self.model_id,
            'subfolder': self.subfolder,
            'device': str(self.agent.device) if self.agent is not None else self.device,
            'loaded': self.agent is not None,
            'head': self.head_path,
            'workerMtime': self.worker_mtime,
            'headMtime': self.head_mtime,
        }

    def ask(self, state, questions):
        self.load()
        covered = (
            self.head is not None
            and self.head_questions is not None
            and all(name in self.head_questions for name in questions)
        )
        if covered:
            # Head mode answers from the encoder alone, so the question path is skipped.
            return {
                'answers': {},
                'usage': {'input_tokens': 0},
                'model': 'laya/' + self.model_id + (('/' + self.subfolder) if self.subfolder else '') + '+head',
                'head': self.head_scores(state),
            }
        result = self.agent.system_one(state, questions)
        return {
            'answers': result.get('answers', {}),
            'usage': result.get('usage', {}),
            'model': 'laya/' + self.model_id + (('/' + self.subfolder) if self.subfolder else ''),
            'head': None,
        }


def handle(engine, request):
    op = request.get('op', 'ask')
    if op == 'ping':
        return {'ok': True, **engine.info()}
    if op == 'warm':
        try:
            engine.load()
        except Exception as error:  # noqa: BLE001 - a bad checkpoint must not kill the daemon
            return {'error': str(error)[:400]}
        return {'ok': True, **engine.info()}
    if op == 'stop':
        return {'ok': True, 'stopping': True}
    if op == 'ask':
        state = request.get('state')
        questions = request.get('questions') or {}
        if not isinstance(questions, dict) or not questions:
            return {'error': 'questions must be a non-empty object'}
        try:
            return {'ok': True, **engine.ask(state, questions)}
        except Exception as error:  # noqa: BLE001 - the client turns this into a keep
            return {'error': str(error)[:400]}
    return {'error': 'unknown op: ' + str(op)[:40]}


def serve(engine, socket_path, preload, idle_timeout=900):
    os.makedirs(os.path.dirname(socket_path), exist_ok=True)
    # Keep the lock file: unlinking it would let callers lock different inodes.
    # The OS releases this lifetime lock even after SIGKILL or a crash.
    with open(socket_path + '.lock', 'a') as lock:
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    return
                time.sleep(.05)

        # Older workers have no lock. Never unlink an accepting listener, even
        # if it is too busy loading/inferencing to answer a ping.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(.5)
            try:
                probe.connect(socket_path)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                    return
            else:
                return
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(socket_path)
            owned = os.stat(socket_path)
            try:
                server.listen(8)
                if preload:
                    engine.load()
                log('laya: listening on ' + socket_path)
                last_active = time.monotonic()
                while True:
                    remaining = idle_timeout - (time.monotonic() - last_active)
                    if remaining <= 0:
                        return
                    server.settimeout(min(1, remaining))
                    try:
                        connection, _ = server.accept()
                    except socket.timeout:
                        continue
                    with connection:
                        # A stalled client must not pin the daemon indefinitely.
                        connection.settimeout(min(5, remaining))
                        with connection.makefile('r', encoding='utf-8') as reader:
                            try:
                                # The client protocol uses one request per connection.
                                line = reader.readline()
                                if not line.strip():
                                    continue
                                try:
                                    request = json.loads(line)
                                except ValueError:
                                    connection.sendall(b'{"error":"invalid json"}\n')
                                    continue
                                response = handle(engine, request)
                                try:
                                    connection.sendall((json.dumps(response) + '\n').encode())
                                except OSError:
                                    # A cancelled caller does not discard the loaded model.
                                    pass
                                if response.get('stopping'):
                                    return
                                last_active = time.monotonic()
                            except OSError:
                                pass
            finally:
                # A legacy worker or external process might have replaced the path.
                try:
                    current = os.stat(socket_path)
                    if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                        os.unlink(socket_path)
                except FileNotFoundError:
                    pass


def main():
    parser = argparse.ArgumentParser(description='Laya worker for Codex Context Diet')
    parser.add_argument('mode', choices=['serve', 'ask'])
    parser.add_argument('--socket', default='')
    parser.add_argument('--model', default='convaiinnovations/laya')
    parser.add_argument('--subfolder', default='multilingual')
    parser.add_argument('--device', default='')
    parser.add_argument('--preload', action='store_true')
    parser.add_argument('--head', default='')
    parser.add_argument('--idle-timeout', type=float, default=900)
    args = parser.parse_args()

    engine = Engine(args.model, args.subfolder, args.device)
    try:
        engine.worker_mtime = os.path.getmtime(__file__)
    except OSError:
        pass
    if args.head:
        try:
            engine.load_head(args.head)
        except Exception as error:  # noqa: BLE001 - a bad head falls back to raw answers
            log('laya: head not loaded: ' + str(error)[:200])
    if args.mode == 'ask':
        request = json.loads(sys.stdin.read() or '{}')
        response = handle(engine, {**request, 'op': request.get('op', 'ask')})
        sys.stdout.write(json.dumps(response) + '\n')
        return 0 if 'error' not in response else 1
    if not args.socket:
        log('serve mode needs --socket')
        return 2
    if not 0 < args.idle_timeout < float('inf'):
        parser.error('--idle-timeout must be a finite positive number')

    def shutdown(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    serve(engine, args.socket, args.preload, args.idle_timeout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
