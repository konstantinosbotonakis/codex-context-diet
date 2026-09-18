#!/usr/bin/env node
import { main } from './session.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  await main(Buffer.concat(chunks).toString('utf8'), process.env);
} catch {
  // fail open, always
}
process.exitCode = 0;
