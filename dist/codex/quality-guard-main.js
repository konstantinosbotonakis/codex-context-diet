#!/usr/bin/env node
import { handleStop } from './qualityGuard.js';
try {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    let payload = {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed && typeof parsed === 'object')
            payload = parsed;
    }
    catch {
        payload = {};
    }
    const output = await handleStop(payload, process.env);
    if (output)
        process.stdout.write(output);
}
catch {
    // fail open, always
}
process.exitCode = 0;
//# sourceMappingURL=quality-guard-main.js.map