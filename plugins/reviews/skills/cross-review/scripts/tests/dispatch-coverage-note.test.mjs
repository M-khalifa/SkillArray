import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEPENDENCIES_NOTE, DEFAULT_MAX_FILES } from '../snapshot-utils.mjs';

function realGitDir() {
  const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout;
  return path.dirname(out.split(/\r?\n/)[0]);
}

// One tree above the inventory limit, built once for the file: writing 20001 files is the slow part.
let bulkRoot = null;
function bulkTarget() {
  bulkRoot ??= (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coverage note bulk '));
    const modules = path.join(root, 'node_modules', 'pkg');
    mkdirSync(modules, { recursive: true });
    await fs.writeFile(path.join(root, 'article.md'), 'original\n');
    let next = 0;
    const worker = async () => {
      while (next <= DEFAULT_MAX_FILES) await (await fs.open(path.join(modules, `f${next++}.js`), 'w')).close();
    };
    await Promise.all(Array.from({ length: 64 }, worker));
    return root;
  })();
  return bulkRoot;
}

after(async () => {
  if (bulkRoot) await fs.rm(await bulkRoot, { recursive: true, force: true });
});

// Runs one dispatcher against a fake CLI on a non-git target. With `bulk`, the target holds more than the
// inventory limit of files under node_modules, so the dependency folder is not covered.
async function dispatchOnce(t, dispatcher, { bulk = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${dispatcher} coverage note `));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const phase1 = path.join(dir, 'phase1');
  await Promise.all([fs.mkdir(bin), fs.mkdir(phase1)]);
  let target;
  if (bulk) {
    target = await bulkTarget();
  } else {
    target = path.join(dir, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'article.md'), 'original\n');
  }
  t.after(() => fs.rm(path.join(target, 'scratch.txt'), { force: true }));
  const events = dispatcher === 'codex'
    ? `console.log(JSON.stringify({type:'thread.started', thread_id:'t1'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));`
    : `console.log(JSON.stringify({type:'text', sessionID:'s1', part:{type:'text', text:'done'}}));`;
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
let input = '';
if (!process.stdin.isTTY) { for await (const chunk of process.stdin) input += chunk; }
writeFileSync(${JSON.stringify(path.join(target, 'scratch.txt'))}, 'new\\n');
${events}
`);
  const shim = path.join(bin, process.platform === 'win32' ? `${dispatcher}.cmd` : dispatcher);
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const script = fileURLToPath(new URL(`../${dispatcher}-dispatch.mjs`, import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
}

for (const dispatcher of ['codex', 'opencode']) {
  test(`final-F8: ${dispatcher}-dispatch records the node_modules coverage gap in result.json, next to a clean touchedFiles list`, async (t) => {
    const output = await dispatchOnce(t, dispatcher, { bulk: true });
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.touchedFiles, ['scratch.txt']);
    assert.equal(output.touchedFilesNote, DEPENDENCIES_NOTE);
  });

  test(`final-F8: ${dispatcher}-dispatch writes no coverage note when node_modules was inventoried`, async (t) => {
    const output = await dispatchOnce(t, dispatcher);
    assert.deepEqual(output.touchedFiles, ['scratch.txt']);
    assert.equal(Object.hasOwn(output, 'touchedFilesNote'), false);
  });
}

test('final-F6: every OpenCode result.json states its usage semantics as per-call', async (t) => {
  const output = await dispatchOnce(t, 'opencode');
  assert.equal(output.usageSemantics, 'per-call');
});

test('final-F9: the codex-dispatch help text no longer says the non-git inventory skips node_modules', () => {
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  const text = `${help.stdout}${help.stderr}`.replace(/\s+/g, ' ');
  assert.equal(text.includes('skipping .git/ and node_modules/'), false);
  assert.match(text, /skipping \.git\/; node_modules too only when the tree is too large, logged as such/);
});
