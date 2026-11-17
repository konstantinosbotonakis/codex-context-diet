import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Check } from './doctor.js';

const pluginId = 'codex-context-diet@context-diet';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summarizeHookTrust(result: unknown): Check {
  const name = 'Codex hook trust';
  const entry = record(result) && Array.isArray(result.data) ? result.data[0] : undefined;
  if (!record(entry) || !Array.isArray(entry.hooks)) {
    return { name, status: 'warn', detail: 'Codex returned no hook inventory' };
  }
  const hooks = entry.hooks.filter((hook) => record(hook) && hook.pluginId === pluginId);
  if (!hooks.length) return { name, status: 'warn', detail: 'Context Diet is absent from the Codex hook inventory for this directory' };
  const trusted = hooks.filter((hook) => hook.trustStatus === 'trusted').length;
  const enabled = hooks.filter((hook) => hook.enabled === true).length;
  const needsTrust = hooks.some((hook) => hook.enabled === true && hook.trustStatus !== 'trusted');
  return {
    name, status: needsTrust ? 'fail' : enabled < hooks.length ? 'warn' : 'ok',
    detail: trusted + '/' + hooks.length + ' trusted, ' + enabled + ' enabled in a fresh Codex session' +
      (needsTrust ? '. Review Context Diet in /hooks.' : ''),
  };
}

/** Exchange only initialize and hooks/list. No thread, model turn or approval is created. */
export async function checkHookTrust(env: NodeJS.ProcessEnv): Promise<Check> {
  const child = spawn(env.CODEX_BIN || 'codex', ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const unavailable = (detail: string): Check => ({ name: 'Codex hook trust', status: 'warn', detail });
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve) => {
    let finished = false;
    const finish = (check: Check) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(check);
    };
    const timer = setTimeout(() => finish(unavailable('Codex hook inventory timed out')), 5000);
    child.once('error', () => finish(unavailable('Codex app-server unavailable')));
    child.once('close', () => finish(unavailable('Codex exited before returning its hook inventory')));
    child.stdin.on('error', () => finish(unavailable('Codex closed the hook inventory connection')));
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
    lines.on('line', (line) => {
      let reply: unknown;
      try { reply = JSON.parse(line); } catch { return; }
      if (!record(reply)) return;
      if (reply.id === 1 && record(reply.result)) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [process.cwd()] } });
      } else if (reply.id === 2) {
        finish(summarizeHookTrust(reply.result));
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'context-diet-doctor', version: '1' }, capabilities: { experimentalApi: true },
    } });
  });
}

interface Execution { time: string; event: string; status: string; approval: boolean }

function execution(line: string, thread: string | undefined): Execution | undefined {
  if (!line.includes('hook/completed') || !line.includes('/codex-context-diet/')) return;
  const header = /^\[([^\]]+)\] [^:]+: /.exec(line);
  if (!header || !Number.isFinite(Date.parse(header[1]))) return;
  let row;
  try { row = JSON.parse(line.slice(header[0].length)); } catch { return; }
  const payload = row?.event?.payload;
  const run = payload?.params?.run;
  if (row?.event?.direction !== 'incoming' || payload?.method !== 'hook/completed' ||
      (thread && payload.params.threadId !== thread) || run?.source !== 'plugin' ||
      typeof run.sourcePath !== 'string' || !/\/codex-context-diet\/[^/]+\/hooks\/hooks\.json$/.test(run.sourcePath) ||
      typeof run.eventName !== 'string' || typeof run.status !== 'string') return;
  const approval = Array.isArray(run.entries) && run.entries.some((e: unknown) =>
    record(e) && e.kind === 'error' && typeof e.text === 'string' && e.text.includes('hook approval required'));
  return { time: header[1], event: run.eventName, status: run.status, approval };
}

/** Inspect only this thread's log, including its previous rotation. Skip partial first lines. */
function readTail(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 10 * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    const bytes = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8', 0, bytes).split('\n');
    if (start) lines.shift();
    return lines.reverse();
  } finally { closeSync(fd); }
}

export function checkThreadExecution(env: NodeJS.ProcessEnv): Check | undefined {
  const thread = env.T3CODE_THREAD_ID;
  if (!thread) return;
  const name = 'T3 thread hooks';
  const home = env.T3CODE_HOME || join(env.HOME ?? '.', '.t3');
  const path = join(home, 'userdata', 'logs', 'provider', 'events.' + thread.replace(/[^A-Za-z0-9_-]/g, '-') + '.log');
  let latest: Execution | undefined;
  let success: Execution | undefined;
  for (const file of [path, path + '.1']) {
    let lines;
    try { lines = readTail(file); } catch { continue; }
    for (const line of lines) {
      const run = execution(line, env.CODEX_THREAD_ID);
      if (!run) continue;
      latest ??= run;
      if (run.status === 'completed') { success = run; break; }
    }
    if (success) break;
  }
  if (!latest) return { name, status: 'warn', detail: 'No matching hook completion found in the recent log for this thread' };
  const describe = (run: Execution) => run.time + ' ' + run.event + ' ' + run.status;
  return {
    name, status: latest.status === 'completed' ? 'ok' : latest.status === 'failed' ? 'fail' : 'warn',
    detail: 'Latest: ' + describe(latest) + (latest.approval ? ' (approval required)' : '') +
      (latest === success ? '' : '. Last success: ' + (success ? describe(success) : 'none in the recent thread log')),
  };
}
