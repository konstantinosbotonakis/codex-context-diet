#!/usr/bin/env node
import { main } from './adapter.js';
try {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    const output = await main(Buffer.concat(chunks).toString('utf8'), process.env);
    if (output)
        process.stdout.write(output);
}
catch {
    // fail open, always
}
process.exitCode = 0;
//# sourceMappingURL=adapter-main.js.map