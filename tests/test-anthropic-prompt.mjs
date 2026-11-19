import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import register from '../bin/anthropic-prompt.ts';

const tmp = mkdtempSync(join(tmpdir(), 'pi-provider-prompt-'));
try {
  const file = join(tmp, 'prompt file');
  writeFileSync(file, 'custom preamble\n');
  process.env.PI_PROMPT_FILE = file;
  let handler;
  register({ on(name, fn) { assert.equal(name, 'before_agent_start'); handler = fn; } });
  const options = { customPrompt: 'default preamble', addendum: 'project instructions' };
  const event = { systemPromptOptions: options, get systemPrompt() { return `${options.customPrompt}\n${options.addendum}`; } };
  for (const provider of ['openai', 'anthropic', 'openrouter', undefined, 'anthropic']) {
    const result = handler(event, { model: { provider } });
    assert.equal(result?.systemPrompt, provider === 'anthropic' ? 'custom preamble\nproject instructions' : undefined);
    assert.equal(options.customPrompt, 'default preamble');
  }
  const wrapper = fileURLToPath(new URL('../bin/pi', import.meta.url));
  const extension = fileURLToPath(new URL('../bin/anthropic-prompt.ts', import.meta.url));
  const fake = join(tmp, 'pi-real');
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const argv = (args, env = {}) => execFileSync(wrapper, args, { encoding: 'utf8', env: { ...process.env, PI_REAL: fake, PI_NO_SPOOF: '0', ...env } }).trimEnd().split('\n');
  assert.deepEqual(argv(['hello world']), ['-e', extension, 'hello world']);
  for (const args of [['--system-prompt', 'mine'], ['--system-prompt-file', file], ['--version']]) assert.deepEqual(argv(args), args);
  assert.deepEqual(argv(['hello'], { PI_NO_SPOOF: '1' }), ['hello']);
  assert.deepEqual(argv(['hello'], { PI_PROMPT_FILE: join(tmp, 'missing') }), ['hello']);
  console.log('Provider prompt and wrapper checks passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
