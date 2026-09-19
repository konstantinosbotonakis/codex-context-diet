/**
 * `context-diet benchmark`: what the diet costs on this machine.
 *
 * Offline by default. A deterministic test asker stands in for Jev, so the
 * numbers show local processing and transport only. `--live` adds one real
 * request and reports the network latency separately.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { main as adapterMain } from './codex/adapter.js';
import { loadConfig } from './config.js';
import { resolveApiKey } from './key.js';
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
function stats(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    return {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p50: pick(0.5),
        p95: pick(0.95),
    };
}
const testAnswers = JSON.stringify({
    needs_contents: 0.05, replaceable: 0.9, keep_call: 0.9, agent_directed: 0.02, behaviour_change: 0.02,
});
function benchEnv() {
    const data = mkdtempSync(join(tmpdir(), 'cd-bench-'));
    writeFileSync(join(data, 'config.json'), JSON.stringify({ minTokens: 100 }));
    return { ...process.env, PLUGIN_DATA: data, CONTEXT_DIET_TEST_ANSWERS: testAnswers };
}
const bulk = 'bench output line with some bulk\n';
const output = (iteration) => 'run ' + iteration + '\n' + bulk.repeat(1600);
const payload = (iteration) => JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'bench',
    tool_name: 'Bash',
    tool_use_id: 't' + iteration,
    tool_input: { command: 'npm test -- ' + iteration },
    tool_response: { output: output(iteration) },
});
function mcpClient(env) {
    const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp-server.js')], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const text = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (text.length > 0) {
                try {
                    const message = JSON.parse(text);
                    const resolve = pending.get(Number(message.id));
                    if (resolve) {
                        pending.delete(Number(message.id));
                        resolve(message);
                    }
                }
                catch {
                    // A malformed line is ignored, exactly as a client would ignore it.
                }
            }
            index = buffer.indexOf('\n');
        }
    });
    let nextId = 0;
    return {
        call: (method, params) => new Promise((resolve) => {
            nextId += 1;
            pending.set(nextId, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }) + '\n');
        }),
        kill: () => {
            child.kill();
        },
    };
}
export async function runBenchmark(options = {}) {
    const iterations = Math.max(3, Math.min(200, Math.floor(options.iterations ?? 20)));
    const env = benchEnv();
    const resultChars = output(0).length;
    const localTimes = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const started = performance.now();
        await adapterMain(payload(iteration), env);
        localTimes.push(performance.now() - started);
    }
    const hookTimes = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const started = performance.now();
        spawnSync(process.execPath, [join(pluginRoot, 'dist', 'codex', 'adapter-main.js')], {
            input: payload(iteration),
            env,
            encoding: 'utf8',
        });
        hookTimes.push(performance.now() - started);
    }
    const client = mcpClient(env);
    const startupStart = performance.now();
    await client.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'benchmark', version: '1' },
    });
    const mcpStartupMs = performance.now() - startupStart;
    const mcpTimes = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const started = performance.now();
        await client.call('tools/call', {
            name: 'post_tool_use',
            arguments: JSON.parse(payload(iteration)),
        });
        mcpTimes.push(performance.now() - started);
    }
    client.kill();
    let liveMs = null;
    let liveNote = 'excluded, the test asker stands in for Jev';
    if (options.live) {
        const config = loadConfig(env);
        const { key } = resolveApiKey(config, process.env);
        if (key === null) {
            liveNote = 'skipped, no API key';
        }
        else {
            const started = performance.now();
            const { JevClient } = await import('./client.js');
            await new JevClient({ apiKey: key, model: config.model }).ask({ ping: 'ok' }, { reachable: { type: 'noul', instructions: 'This model is reachable and answering questions' } });
            liveMs = performance.now() - started;
            liveNote = 'one reachability request through the configured model';
        }
    }
    return {
        iterations,
        resultChars,
        local: stats(localTimes),
        commandHook: stats(hookTimes),
        mcp: stats(mcpTimes),
        mcpStartupMs,
        liveMs,
        liveNote,
    };
}
export function renderBenchmark(report) {
    const format = (value) => value.toFixed(1).padStart(7);
    const row = (label, stat) => label.padEnd(28) + format(stat.p50) + format(stat.p95) + format(stat.mean);
    const startupRow = (label, value) => label.padEnd(28) + format(value) + '      -        -   once per session';
    const lines = [
        'Context Diet benchmark',
        report.iterations + ' iterations, result size ' + report.resultChars + ' chars, one session, test asker',
        '',
        '                              p50    p95   mean',
        row('local pipeline (in-process)', report.local),
        row('command hook (node spawn)', report.commandHook),
        row('mcp tool call', report.mcp),
        startupRow('mcp startup', report.mcpStartupMs),
        '',
        report.liveMs === null
            ? 'Jev network latency: ' + report.liveNote
            : 'Jev network latency: ' + report.liveMs.toFixed(1) + ' ms  (' + report.liveNote + ')',
        'All numbers are milliseconds. Nothing leaves the machine unless --live is given.',
    ];
    return lines.join('\n') + '\n';
}
//# sourceMappingURL=bench.js.map