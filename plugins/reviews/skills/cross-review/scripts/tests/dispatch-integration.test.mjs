import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dispatcher passes selected model and effort to a fake CLI on fresh and resumed runs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch test '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message',
text:JSON.stringify({argv:process.argv.slice(2), input})}}));
`);
  // Only the fixture bin is on PATH, so this test cannot call a real Codex CLI.
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  for (const phase of ['fresh', 'resume']) {
    const folder = path.join(dir, phase);
    await fs.mkdir(folder);
    const brief = path.join(folder, 'brief.txt');
    await fs.writeFile(brief, 'fixture prompt with spaces');
    const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only',
      '--model', 'gpt-fixture', '--effort', 'high'];
    if (phase === 'resume') args.push('--session', 'fixture-thread');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = bin;
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    assert.equal(output.status, 'completed');
    const observed = JSON.parse(output.finalMessage);
    assert.equal(observed.input, 'fixture prompt with spaces');
    assert.equal(observed.argv[observed.argv.indexOf('--model') + 1], 'gpt-fixture');
    assert.equal(observed.argv[observed.argv.indexOf('-c') + 1], 'model_reasoning_effort=high');
    assert.equal(observed.argv.includes('-s'), phase === 'fresh');
    assert.equal(output.modelRequested, 'gpt-fixture');
    assert.equal(output.modelResolved, null);
    assert.equal(output.threadId, 'fixture-thread');
  }
});
