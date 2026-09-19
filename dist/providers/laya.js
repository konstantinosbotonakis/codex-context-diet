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
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDataDir } from '../config.js';
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));
export function layaPaths(env) {
    const dir = join(pluginDataDir(env), 'providers', 'laya');
    return {
        dir,
        socket: join(dir, 'worker.sock'),
        log: join(dir, 'worker.log'),
        worker: join(pluginRoot, 'providers', 'laya_worker.py'),
        venvPython: join(dir, 'venv', 'bin', 'python'),
    };
}
/** Config first, then the managed venv, then whatever python3 is on PATH. */
export function resolveLayaPython(config, env) {
    const paths = layaPaths(env);
    if (config.layaPython.length > 0)
        return config.layaPython;
    if (existsSync(paths.venvPython))
        return paths.venvPython;
    return 'python3';
}
const clamp01 = (value) => Math.min(1, Math.max(0, value));
function connectOnce(socket, timeoutMs) {
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
async function request(config, env, payload, timeoutMs) {
    const paths = layaPaths(env);
    const client = await connectOnce(paths.socket, Math.min(timeoutMs, 5_000));
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => {
            client.destroy();
            reject(new Error('laya worker did not answer within ' + timeoutMs + ' ms'));
        }, timeoutMs);
        const finish = (reply) => {
            clearTimeout(timer);
            // Destroy rather than end: the daemon closes its side lazily, and a
            // half-closed socket would keep this process alive.
            client.destroy();
            resolve(reply);
        };
        client.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const index = buffer.indexOf('\n');
            if (index < 0)
                return;
            try {
                finish(JSON.parse(buffer.slice(0, index)));
            }
            catch (error) {
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
function spawnDaemon(config, env) {
    const paths = layaPaths(env);
    const python = resolveLayaPython(config, env);
    const args = [
        paths.worker, 'serve',
        '--socket', paths.socket,
        '--model', config.layaModel,
        '--subfolder', config.layaSubfolder,
    ];
    if (config.layaDevice.length > 0)
        args.push('--device', config.layaDevice);
    let logFd = null;
    try {
        mkdirSync(paths.dir, { recursive: true });
        logFd = openSync(paths.log, 'a');
    }
    catch {
        // the daemon still runs without a log file
    }
    const child = spawn(python, args, {
        detached: true,
        stdio: ['ignore', 'ignore', logFd === null ? 'ignore' : logFd],
    });
    // A missing python must fail the call, not the process: without this the
    // spawn error is an unhandled event and takes the hook down with it.
    child.on('error', () => { });
    child.unref();
    if (logFd !== null)
        closeSync(logFd);
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * The daemon, started on demand. A cold start loads a checkpoint, so the wait
 * is the warm timeout, not the per-answer timeout.
 */
export async function ensureLayaDaemon(config, env) {
    try {
        const running = await request(config, env, { op: 'ping' }, 1_000);
        // One worker serves one checkpoint, so a different model or subfolder
        // needs a fresh process.
        const sameModel = running.model === config.layaModel;
        const runningSub = running.subfolder ?? '';
        const sameSub = runningSub === (config.layaSubfolder.length > 0 ? config.layaSubfolder : null) ||
            (runningSub === '' && config.layaSubfolder.length === 0);
        if (sameModel && sameSub)
            return;
        try {
            await request(config, env, { op: 'stop' }, 2_000);
        }
        catch {
            // it may already be gone; the spawn below still works
        }
        await sleep(300);
    }
    catch {
        // not running, or not started yet
    }
    const paths = layaPaths(env);
    if (!existsSync(paths.worker))
        throw new Error('laya worker script is missing: ' + paths.worker);
    spawnDaemon(config, env);
    const deadline = Date.now() + config.layaWarmTimeoutMs;
    let last = 'no response';
    while (Date.now() < deadline) {
        await sleep(250);
        try {
            await request(config, env, { op: 'ping' }, 2_000);
            return;
        }
        catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error('laya worker did not start within ' + config.layaWarmTimeoutMs + ' ms (' + last + ')');
}
/** Loads the checkpoint in the daemon so the first real answer is not the slow one. */
export async function warmLaya(config, env) {
    await ensureLayaDaemon(config, env);
    const reply = await request(config, env, { op: 'warm' }, config.layaWarmTimeoutMs);
    if (reply.error !== undefined)
        throw new Error(reply.error);
    return reply;
}
export async function layaStatus(config, env) {
    try {
        return await request(config, env, { op: 'ping' }, 1_500);
    }
    catch {
        return null;
    }
}
/**
 * Laya's answers in the plugin's own shape. A score arrives as the expected
 * level index, which is normalised to 0..1 so both providers read the same,
 * and the probabilities are keyed by the level labels the caller supplied.
 */
export function mapLayaAnswers(questions, answers) {
    const mapped = {};
    for (const [id, question] of Object.entries(questions)) {
        const answer = answers[id];
        if (answer === undefined)
            continue;
        if (question.type === 'noul') {
            if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul))
                continue;
            mapped[id] = { type: 'noul', noul: clamp01(answer.noul) };
            continue;
        }
        if (question.type === 'choice') {
            if (typeof answer.choice !== 'string')
                continue;
            mapped[id] = {
                type: 'choice',
                choice: answer.choice,
                confidence: typeof answer.confidence === 'number' ? answer.confidence : 1,
                probabilities: answer.probabilities ?? {},
            };
            continue;
        }
        if (typeof answer.score !== 'number' || !Number.isFinite(answer.score))
            continue;
        const levels = Array.isArray(question.criteria) ? question.criteria : [];
        const scale = levels.length > 1 ? levels.length - 1 : 1;
        const probabilities = {};
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
export function createLayaAsker(config, env) {
    return {
        async ask(state, questions) {
            await ensureLayaDaemon(config, env);
            const reply = await request(config, env, { op: 'ask', state, questions }, config.layaTimeoutMs);
            if (reply.error !== undefined)
                throw new Error('laya: ' + reply.error);
            const answers = mapLayaAnswers(questions, reply.answers ?? {});
            return {
                answers,
                model: reply.model ?? 'laya/' + config.layaModel,
                usage: { input_tokens: reply.usage?.input_tokens ?? 0, output_tokens: 0 },
            };
        },
    };
}
//# sourceMappingURL=laya.js.map