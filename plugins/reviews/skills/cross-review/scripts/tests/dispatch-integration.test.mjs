import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESULT_REQUIRED_KEYS } from '../codex-dispatch.mjs';

function assertResultSchema(output) {
  for (const key of RESULT_REQUIRED_KEYS) {
    assert.ok(key in output, `result.json missing required key "${key}"`);
  }
}

// A fixture PATH narrowed to just a fake CLI's bin dir hides real git too, so isGitRepo()
// fails on ENOENT rather than on the target actually not being a repo. Append this instead.
function realGitDir() {
  const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout;
  return path.dirname(out.split(/\r?\n/)[0]);
}

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
    assertResultSchema(output);
    assert.equal(output.isolated, false);
    assert.equal(output.worktreePath, null);
  }
});

test('dispatcher kills a hung codex process on --timeout and writes status timed-out', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch timeout '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const pidFile = path.join(dir, 'fake.pid');
  // Emits thread.started, then never closes stdout/exits on its own -- the
  // dispatcher's --timeout is the only thing that ends this process. Writes
  // its own pid so the test can confirm the REAL node process behind the
  // .cmd shim died, not just cmd.exe (see codex.cmd wrapping the shim).
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({type:'thread.started', thread_id:'hung-thread'}));
setInterval(() => {}, 1000);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only', '--timeout', '2'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'timed-out');
  assert.match(output.error, /timeout 2s/);
  assertResultSchema(output);

  const fakePid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.throws(
    () => process.kill(fakePid, 0),
    'the real node process behind the .cmd shim must be dead, not just cmd.exe'
  );
});

test('opencode-dispatch kills a hung opencode process on --timeout and writes status timed-out', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode timeout '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Emits a sessionID event, then never closes stdout/exits on its own -- the
  // dispatcher's --timeout is the only thing that ends this process. Does not
  // read stdin: OPENCODE_SPAWN_STDIO sets the real child's stdin to 'ignore'.
  await fs.writeFile(fake, `console.log(JSON.stringify({sessionID:'hung-session', type:'step_start'}));
setInterval(() => {}, 1000);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir, '--timeout', '2'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'timed-out');
  assert.match(output.error, /timeout 2s/);
  assertResultSchema(output);
});

test('opencode-dispatch refuses to run unisolated when --isolate is requested against a non-git --cd', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-nongit '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const sentinel = path.join(dir, 'shim-was-invoked');
  const fake = path.join(bin, 'fake.mjs');
  // Sentinel proves the reviewer never launched, not just that its output was dropped.
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinel)}, '');
console.log(JSON.stringify({sessionID:'should-not-run', type:'step_start'}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'secret.txt'), 'must not be touched\n');

  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  // Brief lives at <run-dir>/phase1/brief.txt per phase-1-independent-passes.md, so
  // the dispatcher's briefDir/../worktree resolves to <run-dir>/worktree, not a path
  // outside this test's own mkdtemp dir shared with every other run.
  const phase1 = path.join(dir, 'phase1');
  await fs.mkdir(phase1);
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', target, '--isolate'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);

  const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assert.match(output.error, /not a git repository/);
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
  assertResultSchema(output);
  assert.ok('touchedFilesNote' in output, 'touchedFiles is null here; touchedFilesNote must explain why');
  await assert.rejects(fs.access(sentinel), 'the reviewer process must never launch when isolation fails closed');
  assert.equal(await fs.readFile(path.join(target, 'secret.txt'), 'utf8'), 'must not be touched\n');
});

test('opencode-dispatch refuses to run unisolated when --isolate worktree setup fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-setupfail '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const sentinel = path.join(dir, 'shim-was-invoked');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinel)}, '');
console.log(JSON.stringify({sessionID:'should-not-run', type:'step_start'}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });

  // A git repo with no commits: `git worktree add ... HEAD` has no HEAD to
  // resolve, so worktree setup fails deterministically without a fake shim.
  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  spawnSync('git', ['init', '-q'], { cwd: target });

  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const phase1 = path.join(dir, 'phase1');
  await fs.mkdir(phase1);
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', target, '--isolate'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);

  const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assert.match(output.error, /worktree setup failed/);
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
  assertResultSchema(output);
  await assert.rejects(fs.access(sentinel), 'the reviewer process must never launch when isolation fails closed');
});

test(
  'opencode-dispatch reports isolated:true/worktreePath truthfully when isolation succeeds but the dispatch itself fails afterward',
  { skip: process.platform !== 'win32' && 'this dispatch-failure trigger (a % in the brief path) is win32-specific; POSIX has no equivalent forced-reject path here' },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-then-fail '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    // A real commit, so worktree setup (which needs a HEAD) succeeds.
    const target = path.join(dir, 'target');
    await fs.mkdir(target);
    spawnSync('git', ['init', '-q'], { cwd: target });
    await fs.writeFile(path.join(target, 'tracked.txt'), 'content\n');
    spawnSync('git', ['add', '.'], { cwd: target });
    spawnSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: target });

    const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
    // Brief at <run-dir>/phase1/brief.txt so briefDir/../worktree stays inside dir.
    const phase1 = path.join(dir, 'phase1');
    await fs.mkdir(phase1);
    // "%" in the brief path: readBrief()/checkCdExists() run BEFORE isolation and don't
    // care about the character, but spawnCli's assertWin32Safe rejects it on every arg,
    // including -f <briefPath> -- so this throws synchronously INSIDE runOpencode's
    // try/catch, AFTER isolation has already succeeded. That ordering is the regression:
    // a hardcoded isolated:false written before isolation was even attempted would pass
    // this test only by accident; only a live read of isolated/worktreePath is correct.
    const brief = path.join(phase1, 'bri%ef.txt');
    await fs.writeFile(brief, 'fixture prompt');
    const args = [script, '--brief', brief, '--cd', target, '--isolate'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = realGitDir();
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /unsafe to pass through cmd\.exe/);

    const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
    assert.equal(output.status, 'error');
    assertResultSchema(output);
    assert.equal(output.isolated, true, 'isolation genuinely succeeded before the spawn failed; must be reported true');
    assert.ok(output.worktreePath, 'worktreePath must be the real path, not null, once isolation succeeded');
  }
);

test('dispatcher writes a full result.json schema on a codex error path (nonexistent --cd)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch cd-error '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const missingCd = path.join(dir, 'does-not-exist');
  const args = [script, '--brief', brief, '--cd', missingCd, '--sandbox', 'read-only',
    '--model', 'gpt-fixture', '--effort', 'high'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assertResultSchema(output);
  assert.equal(output.modelRequested, 'gpt-fixture');
  assert.equal(output.effortRequested, 'high');
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
});
