/**
 * `context-diet doctor`: a local health check for one machine.
 *
 * Every probe here is offline and bounded. No Jev request is made and nothing
 * leaves the machine. The report turns "the plugin is quiet" into a specific
 * answer: which layer is working, which is degraded, and what to do about it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachePath, countSessions, sessionsDir } from './cache.js';
import { configPath, loadConfig, pluginDataDir } from './config.js';
import { keyFilePath, resolveApiKey } from './key.js';
import { layaHeadPath, layaPaths, resolveLayaPython } from './providers/laya.js';
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { value: null, error: 'not a JSON object' };
        }
        return { value: parsed, error: null };
    }
    catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
}
function versionOf(path) {
    const parsed = readJson(path);
    const version = parsed.value?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
}
function dirSize(path) {
    let files = 0;
    let bytes = 0;
    try {
        for (const name of readdirSync(path)) {
            const stat = statSync(join(path, name));
            if (stat.isFile()) {
                files += 1;
                bytes += stat.size;
            }
        }
    }
    catch {
        // A missing directory is a normal first-run state.
    }
    return { files, bytes };
}
/** One MCP stdio round trip: initialize, then list the tools it advertises. */
function mcpHandshake(env, serverPath) {
    const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    const response = spawnSync(process.execPath, [serverPath], {
        input: request(1, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'doctor', version: '1' },
        }) + request(2, 'tools/list', {}),
        encoding: 'utf8',
        timeout: 5000,
        env,
    });
    const stdout = typeof response.stdout === 'string' ? response.stdout : '';
    return stdout.includes('"serverInfo"') ? stdout : null;
}
export function runDoctor(env) {
    const checks = [];
    const config = loadConfig(env);
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({
        name: 'node.js',
        status: major >= 20 ? 'ok' : 'warn',
        detail: 'v' + process.versions.node + (major >= 20 ? '' : ', 20 or newer recommended'),
    });
    const configFile = configPath(env);
    if (!existsSync(configFile)) {
        checks.push({ name: 'config', status: 'ok', detail: 'no file, built-in defaults in use' });
    }
    else {
        const parsed = readJson(configFile);
        checks.push(parsed.error === null
            ? {
                name: 'config',
                status: 'ok',
                detail: 'parses; enabled=' + config.enabled + ', mode=' + config.mode +
                    ', minTokens=' + config.minTokens + ', privacy=' + config.privacyMode,
            }
            : {
                name: 'config',
                status: 'fail',
                detail: configFile + ' is not valid JSON (' + parsed.error + '); defaults are in use and edits are ignored',
            });
    }
    const { key, source } = resolveApiKey(config, env);
    checks.push(key === null
        ? {
            name: 'jev key',
            status: 'warn',
            detail: 'not found. Checked TYPESAFE_API_KEY, ' + keyFilePath(env) +
                ', and the apiKey config field. Deterministic filters still run and each session says Jev was skipped.',
        }
        : { name: 'jev key', status: 'ok', detail: 'found via ' + source });
    if (config.provider === 'laya') {
        const paths = layaPaths(env);
        const python = resolveLayaPython(config, env);
        const head = layaHeadPath(config, env);
        const workerReady = existsSync(paths.worker);
        const pythonReady = existsSync(python);
        checks.push({
            name: 'provider',
            status: workerReady && pythonReady ? 'ok' : 'fail',
            detail: workerReady
                ? (pythonReady
                    ? 'laya ' + config.layaModel + '/' + config.layaSubfolder + ' via ' + python +
                        '. Head: ' + (head.length > 0 ? head : 'none for this checkpoint, so Laya answers raw') +
                        '. Live status: `context-diet provider`. Warm it: `context-diet provider warm`.'
                    : 'laya configured but python is missing at ' + python +
                        '. Run `context-diet setup --provider laya --install`.')
                : 'laya worker script is missing: ' + paths.worker,
        });
    }
    else {
        checks.push({ name: 'provider', status: 'ok', detail: 'jev, model ' + config.model });
    }
    const dataDir = pluginDataDir(env);
    try {
        mkdirSync(dataDir, { recursive: true });
        const probe = join(dataDir, '.doctor-probe');
        writeFileSync(probe, String(process.pid));
        unlinkSync(probe);
        checks.push({ name: 'data directory', status: 'ok', detail: dataDir + ' is writable' });
    }
    catch (error) {
        checks.push({
            name: 'data directory',
            status: 'fail',
            detail: dataDir + ' is not writable: ' + (error instanceof Error ? error.message : String(error)),
        });
    }
    const sessions = sessionsDir(env);
    let cacheFiles = 0;
    let corrupt = 0;
    try {
        for (const name of readdirSync(sessions)) {
            if (!statSync(join(sessions, name)).isDirectory())
                continue;
            const file = cachePath(env, name);
            if (!existsSync(file))
                continue;
            cacheFiles += 1;
            if (readJson(file).error !== null)
                corrupt += 1;
        }
    }
    catch {
        // Same first-run situation as the directory probe above.
    }
    checks.push({
        name: 'cache',
        status: corrupt > 0 ? 'warn' : 'ok',
        detail: cacheFiles + ' session cache file(s), ' + countSessions(env) + ' session(s) recorded' +
            (corrupt > 0 ? ', ' + corrupt + ' unreadable and ignored on read' : ''),
    });
    const logDir = join(pluginDataDir(env), 'log');
    const logs = dirSize(logDir);
    checks.push({
        name: 'logs',
        status: 'ok',
        detail: logDir + ': ' + logs.files + ' file(s), ' + Math.round(logs.bytes / 1024) +
            ' KB, retention ' + (config.logRetentionDays > 0 ? config.logRetentionDays + ' days' : 'unlimited'),
    });
    const versions = [
        versionOf(join(pluginRoot, 'package.json')),
        versionOf(join(pluginRoot, 'plugin.json')),
        versionOf(join(pluginRoot, '.codex-plugin', 'plugin.json')),
    ];
    const versionsMatch = versions.every((value) => value !== null) && new Set(versions).size === 1;
    checks.push({
        name: 'manifest',
        status: versionsMatch ? 'ok' : 'fail',
        detail: 'package ' + (versions[0] ?? 'missing') + ', plugin.json ' + (versions[1] ?? 'missing') +
            ', .codex-plugin ' + (versions[2] ?? 'missing'),
    });
    const hooks = readJson(join(pluginRoot, 'hooks', 'hooks.json'));
    const wired = hooks.value?.hooks && typeof hooks.value.hooks === 'object'
        ? Object.keys(hooks.value.hooks)
        : [];
    checks.push({
        name: 'hooks',
        status: hooks.error === null && wired.length > 0 ? 'ok' : 'fail',
        detail: hooks.error !== null
            ? 'hooks/hooks.json: ' + hooks.error
            : wired.length + ' event(s) wired: ' + wired.join(', '),
    });
    const commandHooks = readJson(join(pluginRoot, 'hooks', 'hooks.command.json'));
    const referenced = new Set(['dist/cli.js', 'dist/mcp-server.js']);
    const walk = (value) => {
        if (typeof value === 'string') {
            for (const match of value.matchAll(/dist\/[A-Za-z0-9/._-]+\.js/g))
                referenced.add(match[0]);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value)
                walk(item);
            return;
        }
        if (value && typeof value === 'object') {
            for (const item of Object.values(value))
                walk(item);
        }
    };
    walk(commandHooks.value);
    const missing = [...referenced].filter((relative) => !existsSync(join(pluginRoot, relative)));
    checks.push({
        name: 'build',
        status: missing.length === 0 ? 'ok' : 'fail',
        detail: missing.length === 0
            ? referenced.size + ' entry point(s) present, dist matches the hook wiring'
            : 'missing from dist: ' + missing.join(', ') + '; run npm run build',
    });
    const mcpServer = join(pluginRoot, 'dist', 'mcp-server.js');
    const mcpManifest = readJson(join(pluginRoot, '.mcp.json'));
    if (mcpManifest.error !== null) {
        checks.push({ name: 'mcp', status: 'fail', detail: '.mcp.json: ' + mcpManifest.error });
    }
    else if (!existsSync(mcpServer)) {
        checks.push({ name: 'mcp', status: 'fail', detail: 'dist/mcp-server.js is missing; run npm run build' });
    }
    else {
        const stdout = mcpHandshake(env, mcpServer);
        const tools = stdout === null ? 0 : (stdout.match(/"inputSchema"/g) ?? []).length;
        checks.push(stdout === null
            ? { name: 'mcp', status: 'fail', detail: 'no stdio handshake within 5s' }
            : { name: 'mcp', status: 'ok', detail: 'stdio handshake answered, ' + tools + ' tool(s) advertised' });
    }
    return checks;
}
export function renderDoctor(checks) {
    const width = Math.max(0, ...checks.map((check) => check.name.length));
    const lines = ['Context Diet doctor', ''];
    for (const check of checks) {
        lines.push('  ' + check.status.padEnd(5) + check.name.padEnd(width + 2) + check.detail);
    }
    const counts = { ok: 0, warn: 0, fail: 0 };
    for (const check of checks)
        counts[check.status] += 1;
    lines.push('', counts.ok + ' ok, ' + counts.warn + ' warn, ' + counts.fail + ' fail');
    return lines.join('\n') + '\n';
}
export function doctorExitCode(checks) {
    return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
//# sourceMappingURL=doctor.js.map