import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginDataDir } from '../config.js';
function logDir(env) {
    return join(pluginDataDir(env), 'log');
}
export function logPath(env) {
    return join(logDir(env), 'events.jsonl');
}
/** Local date, YYYY-MM-DD. Rotation is a daily event, and local is what a user means by a day. */
export function dayKey(date) {
    return (date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0'));
}
/**
 * Drops events older than logRetentionDays. Runs at most once a day, tracked by
 * a marker file, so the usual append stays a single small write.
 */
export function rotateLog(env, config, now = new Date()) {
    if (!config.debug || config.logRetentionDays <= 0)
        return false;
    const path = logPath(env);
    if (!existsSync(path))
        return false;
    const marker = join(logDir(env), '.rotated');
    const today = dayKey(now);
    try {
        if (readFileSync(marker, 'utf8').trim() === today)
            return false;
    }
    catch {
        // no marker yet
    }
    try {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - config.logRetentionDays);
        const kept = [];
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (line.trim().length === 0)
                continue;
            try {
                const at = Date.parse(String(JSON.parse(line).at));
                if (!Number.isFinite(at) || at >= cutoff.getTime())
                    kept.push(line);
            }
            catch {
                // A corrupt line is kept: dropping it silently would hide a real bug.
                kept.push(line);
            }
        }
        const tmp = path + '.' + process.pid + '.tmp';
        writeFileSync(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '');
        renameSync(tmp, path);
        writeFileSync(marker, today + '\n');
        return true;
    }
    catch {
        return false;
    }
}
/** One JSON line in $PLUGIN_DATA/log/events.jsonl when debug is on. Never throws. */
export function appendEvent(env, config, event) {
    if (!config.debug)
        return;
    try {
        mkdirSync(logDir(env), { recursive: true });
        appendFileSync(logPath(env), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
        rotateLog(env, config);
    }
    catch {
        // diagnostics never break a run
    }
}
//# sourceMappingURL=log.js.map