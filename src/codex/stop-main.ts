#!/usr/bin/env node
import { handleStopGuard } from './stopGuard.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const output = handleStopGuard(payload, process.env);
  if (output) process.stdout.write(output);
} catch {
  // fail open, always
}
process.exitCode = 0;

