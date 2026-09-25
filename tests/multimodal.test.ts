import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/codex/adapter.js';
import { readCache } from '../src/cache.js';
import { toolResultText } from '../src/codex/payload.js';

const text = 'A long description of this result. '.repeat(600);
const image = { type: 'image', data: 'A'.repeat(10000), mimeType: 'image/png' };
const cases: [string, unknown][] = [
  ['image block', { content: [image] }],
  ['text and image', { content: [{ type: 'text', text }, image] }],
  ['audio block', { content: [{ type: 'audio', data: 'A'.repeat(10000), mimeType: 'audio/wav' }] }],
  ['image data URL', { image_url: 'data:image/png;base64,' + 'A'.repeat(10000) }],
  ['binary resource', { content: [{ type: 'resource', resource: { uri: 'file:///image', mimeType: 'image/png', blob: 'A'.repeat(10000) } }] }],
  ['top-level block array', [{ type: 'text', text }, image]],
];

describe('media preservation', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it.each(cases)('never replaces a %s with a text-only capsule', async (_name, response) => {
    expect(toolResultText('mcp__media__render', response)).toBeNull();
    const dir = mkdtempSync('/tmp/cd-media-');
    dirs.push(dir);
    const env = { PLUGIN_DATA: dir, CONTEXT_DIET_TEST_ANSWERS: JSON.stringify({
      needs_contents: 0, replaceable: 1, keep_call: 1, agent_directed: 0, behaviour_change: 0,
    }) };
    for (const id of ['first', 'second']) {
      expect(await main(JSON.stringify({
        hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'mcp__media__render',
        tool_use_id: id, tool_input: {}, tool_response: response,
      }), env)).toBe('');
    }
    expect(readCache(env, 's')).toHaveLength(0);
  });

  it('preserves native image tools even when the host supplies a plain string', () => {
    expect(toolResultText('view_image', text)).toBeNull();
  });

  it('continues to support text-only MCP blocks and ordinary JSON data', () => {
    expect(toolResultText('mcp__text', { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
    expect(toolResultText('mcp__data', { count: 42 })).toBe('{"count":42}');
  });
});
