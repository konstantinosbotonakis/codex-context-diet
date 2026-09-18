#!/usr/bin/env node
import { main } from './session.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const output = await main(Buffer.concat(chunks).toString('utf8'), process.env);
  if (output) process.stdout.write(output);
} catch {
  // fail open, always
}
process.exitCode = 0;
