#!/usr/bin/env node
import { countSessions } from './cache.js';
import { configPath, loadConfig, pluginDataDir } from './config.js';
import { JEV_REASON_VALUES } from './codex/diet.js';
import { keyFilePath, resolveApiKey } from './key.js';
import { readUsageInput, renderUsage, summarizeUsage, WINDOWS } from './stats.js';
import { PRESSURE_THRESHOLDS } from './pressure.js';
import { resolveEffectivePolicy } from './policy.js';
import { fakeAsker, throwingAsker, verifyCompaction } from './verify.js';
const USAGE = [
    'context-diet <command>',
    '',
    '  status   show configuration, key source and data directory (offline)',
    '  stats    usage totals for today, 7 days and 30 days (offline)',
    '  policy   the size gate, thresholds and pressure scaling per tool (offline)',
    '  verify   run the offline verification harness (no network)',
    '  test     send one real request to TypeSafe/Jev (needs a key)',
    '',
].join('\n');
async function status() {
    const env = process.env;
    const config = loadConfig(env);
    const { key, source } = resolveApiKey(config, env);
    process.stdout.write([
        'config:   ' + configPath(env),
        'data:     ' + pluginDataDir(env),
        'enabled:  ' + config.enabled,
        'mode:     ' + config.mode + (config.dryRun ? ' (dryRun)' : ''),
        'state:    ' + config.stateSource,
        'model:    ' + config.model,
        'key:      ' + source + (key === null ? ' (not configured)' : ''),
        'key file: ' + keyFilePath(env),
        'sessions: ' + countSessions(env),
    ].join('\n') + '\n');
    return 0;
}
async function verify() {
    const good = await verifyCompaction({
        asker: fakeAsker({ keep_result: 0.1, keep_call: 0.9, injection: 0.05 }),
    });
    const broken = await verifyCompaction({ asker: throwingAsker('verify: a broken asker must fail closed') });
    const failed = broken.checks.filter((check) => !check.ok).map((check) => check.name).join(',');
    const pass = good.ok && !broken.ok && failed === 'asker-contract,decide-call';
    process.stdout.write([
        ...good.checks.map((check) => (check.ok ? '  ok   ' : '  FAIL ') + check.name + ': ' + check.detail),
        '  --',
        '  good asker:   ok=' + good.ok + ', reduction=' + Math.round(good.stats.reduction * 100) + '%',
        '  broken asker: ok=' + broken.ok + ' (expected false), failed=' + (failed || 'none'),
        pass ? 'verify: pass' : 'verify: fail',
    ].join('\n') + '\n');
    return pass ? 0 : 1;
}
async function live() {
    const env = process.env;
    const config = loadConfig(env);
    const { key, source } = resolveApiKey(config, env);
    if (key === null) {
        process.stdout.write('no API key. Checked TYPESAFE_API_KEY, ' + keyFilePath(env) + ', and the apiKey field in ' +
            configPath(env) + '.\n');
        return 1;
    }
    const started = Date.now();
    try {
        const { JevClient } = await import('./client.js');
        const response = await new JevClient({ apiKey: key, model: config.model }).ask({ ping: 'ok' }, {
            reachable: { type: 'noul', instructions: 'This model is reachable and answering questions' },
            sane: { type: 'noul', instructions: 'This request is well formed and can be answered' },
        });
        process.stdout.write([
            'key source: ' + source,
            'model:      ' + (response.model ?? config.model),
            'latency:    ' + (Date.now() - started) + ' ms',
            'answers:    ' + JSON.stringify(response.answers),
            'usage:      ' + JSON.stringify(response.usage ?? {}),
        ].join('\n') + '\n');
        return 0;
    }
    catch (error) {
        process.stdout.write('live request failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
        return 1;
    }
}
async function stats() {
    const all = process.argv.includes('--all');
    const asJson = process.argv.includes('--json');
    const input = readUsageInput(process.env, { all });
    const report = summarizeUsage(input, JEV_REASON_VALUES, WINDOWS, input.pricePerMillionInputTokens);
    if (asJson) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return 0;
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.stdout.write(renderUsage(report, { timeZone, stores: input.stores }) + '\n');
    return 0;
}
/** Shows which size gate and thresholds each tool would get, and why. */
async function policyReport() {
    const config = loadConfig(process.env);
    const floor = (value) => (value > 0 ? value : config.minTokens);
    const lines = [
        'Context Diet policy',
        '',
        'base:            minTokens ' + config.minTokens + ', keep ' + config.keepThreshold + ', drop ' + config.dropThreshold,
        'contextPressure: ' + (config.contextPressure ? 'on' : 'off'),
        '  floors:        low ' + floor(config.pressureLowTokens) +
            ', moderate ' + floor(config.pressureModerateTokens) +
            ', high ' + floor(config.pressureHighTokens) +
            ', critical ' + floor(config.pressureCriticalTokens),
        '  stage marks:   moderate >= ' + PRESSURE_THRESHOLDS.moderate +
            ', high >= ' + PRESSURE_THRESHOLDS.high +
            ', critical >= ' + PRESSURE_THRESHOLDS.critical + ' retained tokens',
        'toolPolicies:    ' + config.toolPolicies.length,
    ];
    for (const item of config.toolPolicies) {
        const overrides = [
            item.minTokens !== undefined ? 'minTokens ' + item.minTokens : null,
            item.keepThreshold !== undefined ? 'keep ' + item.keepThreshold : null,
            item.dropThreshold !== undefined ? 'drop ' + item.dropThreshold : null,
        ].filter((value) => value !== null);
        lines.push('  ' + item.match + ' -> ' + (overrides.length > 0 ? overrides.join(', ') : 'no overrides'));
    }
    const examples = [
        { toolName: 'Bash', inputLine: 'npm test' },
        { toolName: 'Bash', inputLine: 'npm run build' },
        { toolName: 'Bash', inputLine: 'git status' },
        { toolName: 'Read', inputLine: '/repo/src/app.ts' },
    ];
    for (const stage of ['low', 'high', 'critical']) {
        lines.push('', 'resolution at ' + stage + ' pressure:');
        for (const example of examples) {
            const resolved = resolveEffectivePolicy(config, {
                toolName: example.toolName,
                inputLine: example.inputLine,
                outputClass: '',
                pressure: stage,
            });
            lines.push('  ' + example.toolName + ' ' + example.inputLine + ' -> minTokens ' + resolved.minTokens +
                ', keep ' + resolved.keepThreshold + ', drop ' + resolved.dropThreshold + '  [' + resolved.source + ']');
        }
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
}
const command = process.argv[2] ?? '';
if (command === 'status')
    process.exitCode = await status();
else if (command === 'stats')
    process.exitCode = await stats();
else if (command === 'policy')
    process.exitCode = await policyReport();
else if (command === 'verify')
    process.exitCode = await verify();
else if (command === 'test')
    process.exitCode = await live();
else
    process.stdout.write(USAGE);
//# sourceMappingURL=cli.js.map