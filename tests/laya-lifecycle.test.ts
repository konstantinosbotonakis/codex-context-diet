import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ensureLayaDaemon } from '../src/providers/laya.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listener(reply: (client: Socket, request: string) => void) {
  const dir = mkdtempSync('/tmp/cd-laya-client-');
  const marker = join(dir, 'spawned');
  const python = join(dir, 'python');
  // A real spawn leaves evidence but never launches an uncontrolled daemon.
  writeFileSync(python, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o700 });
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('data', (data) => reply(client, data.toString()));
  });
  mkdirSync(join(dir, 'providers', 'laya'), { recursive: true });
  await new Promise<void>((resolve) => server.listen(join(dir, 'providers', 'laya', 'worker.sock'), resolve));
  cleanups.push(async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config: { ...DEFAULT_CONFIG, layaPython: python, layaWarmTimeoutMs: 300 },
    env: { ...process.env, PLUGIN_DATA: dir },
    marker,
  };
}

it('does not spawn a replacement when an existing worker is busy', async () => {
  const setup = await listener(() => {});
  await expect(ensureLayaDaemon(setup.config, setup.env)).rejects.toThrow();
  expect(existsSync(setup.marker)).toBe(false);
});

it('does not replace a mismatched worker whose stop request times out', async () => {
  const setup = await listener((client, request) => {
    if (JSON.parse(request).op === 'ping') client.write('{"ok":true,"model":"old"}\n');
  });
  await expect(ensureLayaDaemon(setup.config, setup.env)).rejects.toThrow();
  expect(existsSync(setup.marker)).toBe(false);
});

it('does not spawn after an existing worker closes a request without a reply', async () => {
  const setup = await listener((client) => client.end());
  await expect(ensureLayaDaemon(setup.config, setup.env)).rejects.toThrow('closed the connection');
  expect(existsSync(setup.marker)).toBe(false);
});

it('verifies Python worker ownership, concurrency, idle exit and crash recovery', () => {
  const result = spawnSync('python3', [join(root, 'tests', 'laya_worker_test.py')], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);
