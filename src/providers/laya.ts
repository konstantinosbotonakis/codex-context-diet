/**
 * Laya provider: a local System 1 decision model instead of TypeSafe's Jev.
 *
 * Laya answers the same three primitives the plugin asks for (noul, choice,
 * score), so the mapping is direct. The model lives in a Python worker that
 * loads the checkpoint once and serves answers over a unix socket, because a
 * cold load takes tens of seconds and a hook cannot wait for that on every
 * call. The first caller starts the daemon; every later caller reuses it.
 *
 * Every failure here throws, and the caller fails open: an unavailable model
 * keeps the tool result rather than guessing a decision.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDataDir, type DietConfig } from '../config.js';
import type { JevAnswer, JevQuestions, JevResponse, JevState } from '../types.js';

const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface LayaPaths {
  dir: string;
  socket: string;
  log: string;
  worker: string;
  venvPython: string;
  headDir: string;
  head: string;
}

export function layaPaths(env: NodeJS.ProcessEnv): LayaPaths {
  const dir = join(pluginDataDir(env), 'providers', 'laya');
  const headDir = join(pluginRoot, 'calibration');
  return {
    dir,
    socket: join(dir, 'worker.sock'),
    log: join(dir, 'worker.log'),
    worker: join(pluginRoot, 'providers', 'laya_worker.py'),
    venvPython: join(dir, 'venv', 'bin', 'python'),
    headDir,
    head: join(headDir, 'laya-head.json'),
  };
}

/**
 * The head trained for the configured checkpoint, or an empty string.
 *
 * Heads are fitted per checkpoint, so a subfolder without a measured head
 * falls back to Laya's own answers rather than reading a mismatched probe.
 */
export function layaHeadPath(config: DietConfig, env: NodeJS.ProcessEnv): string {
  if (!config.layaHead) return '';
  const paths = layaPaths(env);
  const file = config.layaSubfolder.length > 0
    ? join(paths.headDir, 'laya-head-' + config.layaSubfolder.replace(/[^a-z0-9-]/gi, '-') + '.json')
    : paths.head;
  return existsSync(file) ? file : '';
}

/** Config first, then the managed venv, then whatever python3 is on PATH. */
export function resolveLayaPython(config: DietConfig, env: NodeJS.ProcessEnv): string {
  const paths = layaPaths(env);
  if (config.layaPython.length > 0) return config.layaPython;
  if (existsSync(paths.venvPython)) return paths.venvPython;
  return 'python3';
}

interface LayaAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface LayaReply {
  ok?: boolean;
  error?: string;
  answers?: Record<string, LayaAnswer>;
  usage?: { input_tokens?: number };
  model?: string;
  device?: string;
  laya?: string;
  loaded?: boolean;
  subfolder?: string | null;
  head?: LayaHeadScores | null;
  workerMtime?: number | null;
  headMtime?: number | null;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export interface LayaHeadScores {
  drop: number;
  hazard: number;
  dropThreshold: number;
  hazardThreshold: number;
}

/**
 * The head's verdict, written in the policy's own language.
 *
 * The trained head decides drop or keep from the state itself, because Laya's
 * own question heads carry almost no signal on this task. The deterministic
 * policy still makes the call: these answers are just what it reads.
 */
export function headAnswers(head: LayaHeadScores): Record<string, JevAnswer> {
  const drop = head.drop > head.dropThreshold;
  const hazard = head.hazard > head.hazardThreshold;
  const hazardProbability = hazard ? 0.99 : 0.02;
  return {
    needs_contents: { type: 'noul', noul: drop ? 0.05 : 0.9 },
    replaceable: { type: 'noul', noul: drop ? 0.9 : 0.1 },
    keep_call: { type: 'noul', noul: 0.5 },
    agent_directed: { type: 'noul', noul: hazardProbability },
    behaviour_change: { type: 'noul', noul: hazardProbability },
  };
}

function connectOnce(socket: string, timeoutMs: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const socketClient = connect(socket);
    const timer = setTimeout(() => {
      socketClient.destroy();
      reject(new Error('laya worker did not answer within ' + timeoutMs + ' ms'));
    }, timeoutMs);
    socketClient.once('connect', () => {
      clearTimeout(timer);
      resolve(socketClient);
    });
    socketClient.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** One request and one response over a fresh connection to the daemon. */
async function request(config: DietConfig, env: NodeJS.ProcessEnv, payload: unknown, timeoutMs: number): Promise<LayaReply> {
  const paths = layaPaths(env);
  const client = await connectOnce(paths.socket, Math.min(timeoutMs, 5_000));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('laya worker did not answer within ' + timeoutMs + ' ms'));
    }, timeoutMs);
    const finish = (reply: LayaReply): void => {
      clearTimeout(timer);
      // Destroy rather than end: the daemon closes its side lazily, and a
      // half-closed socket would keep this process alive.
      client.destroy();
      resolve(reply);
    };
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, index)) as LayaReply);
      } catch (error) {
        clearTimeout(timer);
        client.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    client.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.write(JSON.stringify(payload) + '\n');
  });
}

function spawnDaemon(config: DietConfig, env: NodeJS.ProcessEnv): void {
  const paths = layaPaths(env);
  const python = resolveLayaPython(config, env);
  const args = [
    paths.worker, 'serve',
    '--socket', paths.socket,
    '--model', config.layaModel,
    '--subfolder', config.layaSubfolder,
  ];
  if (config.layaDevice.length > 0) args.push('--device', config.layaDevice);
  const head = layaHeadPath(config, env);
  if (head.length > 0) args.push('--head', head);
  let logFd: number | null = null;
  try {
    mkdirSync(paths.dir, { recursive: true });
    logFd = openSync(paths.log, 'a');
  } catch {
    // the daemon still runs without a log file
  }
  const child = spawn(python, args, {
    detached: true,
    stdio: ['ignore', 'ignore', logFd === null ? 'ignore' : logFd],
  });
  // A missing python must fail the call, not the process: without this the
  // spawn error is an unhandled event and takes the hook down with it.
  child.on('error', () => {});
  child.unref();
  if (logFd !== null) closeSync(logFd);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a file's modification time matches what the running daemon reported. */
function fresh(reported: number | null | undefined, file: string): boolean {
  if (file.length === 0) return true;
  try {
    return Math.abs(statSync(file).mtimeMs / 1000 - (reported ?? 0)) < 0.01;
  } catch {
    return false;
  }
}

/**
 * The daemon, started on demand. A cold start loads a checkpoint, so the wait
 * is the warm timeout, not the per-answer timeout.
 */
export async function ensureLayaDaemon(config: DietConfig, env: NodeJS.ProcessEnv): Promise<void> {
  const paths = layaPaths(env);
  try {
    const running = await request(config, env, { op: 'ping' }, 1_000);
    // One worker serves one checkpoint, so a different model or subfolder
    // needs a fresh process.
    const sameModel = running.model === config.layaModel;
    const runningSub = running.subfolder ?? '';
    const sameSub = runningSub === (config.layaSubfolder.length > 0 ? config.layaSubfolder : null) ||
      (runningSub === '' && config.layaSubfolder.length === 0);
    const wantedHead = layaHeadPath(config, env);
    const sameHead = (running.head ?? '') === wantedHead && fresh(running.headMtime, wantedHead);
    // The worker script and the head ship with the plugin, so an updated
    // plugin retires the old daemon instead of keeping its decisions.
    const sameWorker = fresh(running.workerMtime, paths.worker);
    if (sameModel && sameSub && sameHead && sameWorker) return;
    try {
      await request(config, env, { op: 'stop' }, 2_000);
    } catch {
      // it may already be gone; the spawn below still works
    }
    await sleep(300);
  } catch {
    // not running, or not started yet
  }
  if (!existsSync(paths.worker)) throw new Error('laya worker script is missing: ' + paths.worker);
  spawnDaemon(config, env);
  const deadline = Date.now() + config.layaWarmTimeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      await request(config, env, { op: 'ping' }, 2_000);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error('laya worker did not start within ' + config.layaWarmTimeoutMs + ' ms (' + last + ')');
}

/** Loads the checkpoint in the daemon so the first real answer is not the slow one. */
export async function warmLaya(config: DietConfig, env: NodeJS.ProcessEnv): Promise<LayaReply> {
  await ensureLayaDaemon(config, env);
  const reply = await request(config, env, { op: 'warm' }, config.layaWarmTimeoutMs);
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply;
}

export async function layaStatus(config: DietConfig, env: NodeJS.ProcessEnv): Promise<LayaReply | null> {
  try {
    return await request(config, env, { op: 'ping' }, 1_500);
  } catch {
    return null;
  }
}

/**
 * Laya's answers in the plugin's own shape. A score arrives as the expected
 * level index, which is normalised to 0..1 so both providers read the same,
 * and the probabilities are keyed by the level labels the caller supplied.
 */
export function mapLayaAnswers(questions: JevQuestions, answers: Record<string, LayaAnswer>): Record<string, JevAnswer> {
  const mapped: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (answer === undefined) continue;
    if (question.type === 'noul') {
      if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) continue;
      mapped[id] = { type: 'noul', noul: clamp01(answer.noul) };
      continue;
    }
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string') continue;
      mapped[id] = {
        type: 'choice',
        choice: answer.choice,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : 1,
        probabilities: answer.probabilities ?? {},
      };
      continue;
    }
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) continue;
    const levels = Array.isArray(question.criteria) ? question.criteria : [];
    const scale = levels.length > 1 ? levels.length - 1 : 1;
    const probabilities: Record<string, number> = {};
    for (const [key, value] of Object.entries(answer.probabilities ?? {})) {
      const index = Number(key);
      const label = Number.isInteger(index) && levels[index] !== undefined ? levels[index] : key;
      probabilities[label] = value;
    }
    mapped[id] = {
      type: 'score',
      score: clamp01(answer.score / scale),
      confidence: typeof answer.confidence === 'number' ? answer.confidence : 1,
      probabilities,
    };
  }
  return mapped;
}

/** The asker the diet path uses when the provider is Laya. */
export function createLayaAsker(config: DietConfig, env: NodeJS.ProcessEnv) {
  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      await ensureLayaDaemon(config, env);
      // The state travels as the exact text the head was trained on.
      const stateText = typeof state === 'string' ? state : JSON.stringify(state);
      const reply = await request(config, env, { op: 'ask', state: stateText, questions }, config.layaTimeoutMs);
      if (reply.error !== undefined) throw new Error('laya: ' + reply.error);
      const head = reply.head ?? null;
      const answers = head === null
        ? mapLayaAnswers(questions, reply.answers ?? {})
        : headAnswers(head);
      return {
        answers,
        model: reply.model ?? 'laya/' + config.layaModel,
        usage: { input_tokens: reply.usage?.input_tokens ?? 0, output_tokens: 0 },
      };
    },
  };
}
