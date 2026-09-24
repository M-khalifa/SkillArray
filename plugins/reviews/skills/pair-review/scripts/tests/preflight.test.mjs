// Tests for ../preflight.mjs. Spawns real `git`/`node` child processes
// against disposable temp git repos -- no network, no provider CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform as osPlatform } from 'node:process';
import {
  parseArgs, runTier1, runTier2, computeSnapshotHash, checkStale, run, RelayError,
} from '../preflight.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

async function makeGitRepo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'a@b.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(['add', 'a.txt'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

test('parseArgs: --cd is required', () => {
  assert.throws(() => parseArgs([]), /--cd/);
});

test('parseArgs: --exec may repeat, --timeout/--env-mode/--env-passthrough parse, defaults are sane', () => {
  const args = parseArgs(['--cd', '.', '--exec', 'a', '--exec', 'b']);
  assert.deepEqual(args.exec, ['a', 'b']);
  assert.equal(args.envMode, 'filtered');
  assert.ok(args.timeout > 0);
});

test('parseArgs: --env-mode rejects anything but filtered/inherit', () => {
  assert.throws(() => parseArgs(['--cd', '.', '--env-mode', 'bogus']), /filtered.*inherit/);
});

test('run(): a non-git directory gets a content-hash inventory snapshotHash, so its Tier 1/Tier 2 evidence is still bound to exact file contents', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'article.md'), 'draft\n', 'utf8');
  const result = await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(result.tier1.gitRepo, false);
  assert.equal(result.tier1.fileCount, 1);
  assert.match(result.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(result.tier2, null);

  const withExec = await run({ cd: dir, exec: ['echo hi'], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(withExec.tier2.results[0].exitCode, 0);
  assert.equal(withExec.snapshotHash, result.snapshotHash);
});

test('checkStale: a non-git directory reports stale after any file content changes, and fresh when nothing changed', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-nogit-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'article.md'), 'draft\n', 'utf8');
  const hash = await computeSnapshotHash(dir);
  assert.equal((await checkStale(dir, hash)).stale, false);
  await writeFile(path.join(dir, 'article.md'), 'edited\n', 'utf8');
  assert.equal((await checkStale(dir, hash)).stale, true);
});

test('computeSnapshotHash: in a monorepo, a commit or edit in a sibling folder does not make the --cd folder stale, but an edit inside it does', async (t) => {
  const dir = await makeGitRepo(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'apps', 'unity'), { recursive: true });
  await mkdir(path.join(dir, 'apps', 'pure'), { recursive: true });
  await writeFile(path.join(dir, 'apps', 'unity', 'api.py'), 'v1\n', 'utf8');
  await writeFile(path.join(dir, 'apps', 'pure', 'api.py'), 'v1\n', 'utf8');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'apps'], dir);
  const target = path.join(dir, 'apps', 'unity');
  const hash = await computeSnapshotHash(target);
  await writeFile(path.join(dir, 'apps', 'pure', 'api.py'), 'v2\n', 'utf8');
  assert.equal((await checkStale(target, hash)).stale, false, 'an uncommitted sibling edit');
  git(['commit', '-q', '-am', 'pure fix'], dir);
  assert.equal((await checkStale(target, hash)).stale, false, 'a sibling commit moves HEAD but not this tree');
  await writeFile(path.join(target, 'api.py'), 'v2\n', 'utf8');
  assert.equal((await checkStale(target, hash)).stale, true, 'an edit inside the target');
});

test('run(): a Tier 2 command that writes into the target is reported in touchedFiles and targetChanged, including a re-edit of an already-dirty file', async (t) => {
  const dir = await makeGitRepo(t);
  await writeFile(path.join(dir, 'a.txt'), 'dirty before preflight\n', 'utf8');
  const cmd = `node -e "require('fs').writeFileSync('dump.bin','x'); require('fs').appendFileSync('a.txt','more\\n')"`;
  const result = await run({ cd: dir, exec: [cmd], timeout: 30, envMode: 'filtered', envPassthrough: [] });
  assert.deepEqual(result.tier2.results[0].touchedFiles, ['a.txt', 'dump.bin']);
  assert.equal(result.tier2.targetChanged, true);
  const clean = await run({ cd: dir, exec: ['echo hi'], timeout: 30, envMode: 'filtered', envPassthrough: [] });
  assert.deepEqual(clean.tier2.results[0].touchedFiles, []);
  assert.equal(clean.tier2.targetChanged, false);
});

test('run(): --compact keeps the test-runner total line in summary even when warnings push it out of --tail', async (t) => {
  const dir = await makeGitRepo(t);
  const logDir = path.join(dir, '..', `${path.basename(dir)}-sumlogs`);
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const cmd = `node -e "console.log('===== 212 passed, 3 warnings in 9.1s ====='); for (let i = 0; i < 10; i++) console.log('warning ' + i)"`;
  const result = await run({ cd: dir, exec: [cmd], timeout: 30, envMode: 'filtered', envPassthrough: [], compact: true, tail: 3, logDir });
  const out = result.tier2.results[0].stdout;
  assert.ok(!out.tail.some((l) => l.includes('212 passed')));
  assert.deepEqual(out.summary, ['===== 212 passed, 3 warnings in 9.1s =====']);
});

test('parseArgs: --compact without --log-dir or --out is refused, and with --out the log dir defaults next to it', () => {
  assert.throws(() => parseArgs(['--cd', '.', '--compact']), /--compact needs --log-dir/);
  const args = parseArgs(['--cd', '.', '--compact', '--out', 'pf.json', '--tail', '5']);
  assert.equal(args.logDir, 'pf.json.logs');
  assert.equal(args.tail, 5);
});

test('run(): --compact keeps byte counts, sha256, tail and fail/error lines in the JSON and writes the full stdout to a log whose hash matches', async (t) => {
  const dir = await makeGitRepo(t);
  const logDir = path.join(dir, '..', `${path.basename(dir)}-logs`);
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const cmd = `node -e "for (let i = 1; i <= 29; i++) console.log('ok ' + i); console.log('\\u2714 throws a descriptive error on bad input'); console.log('not ok 31 - broken')"`;
  const result = await run({
    cd: dir, exec: [cmd], timeout: 30, envMode: 'filtered', envPassthrough: [],
    compact: true, tail: 3, logDir,
  });
  const out = result.tier2.results[0].stdout;
  assert.equal(result.tier2.compact, true);
  assert.equal(out.lineCount, 31);
  assert.deepEqual(out.tail, ['ok 29', '✔ throws a descriptive error on bad input', 'not ok 31 - broken']);
  assert.deepEqual(out.matches, ['not ok 31 - broken'], 'a passing test whose name says "error" is not a failure line');
  assert.equal(typeof result.tier1.diff.sha256, 'string', 'the Tier 1 diff moves to a log in compact mode');
  assert.equal(await readFile(result.tier1.diff.log, 'utf8'), '');
  const full = await readFile(out.log, 'utf8');
  assert.equal(full.split(/\r?\n/).filter(Boolean).length, 31);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(Buffer.from(full, 'utf8')).digest('hex'), out.sha256);
});

test('run(): --cd pointing at a file (not a directory) is rejected with RelayError, not a raw git ENOTDIR crash', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'not-a-dir.txt');
  await writeFile(filePath, 'x', 'utf8');
  await assert.rejects(
    () => run({ cd: filePath, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] }),
    RelayError
  );
});

test('Tier 1 never executes anything the target defines, even when the target has a "test" script that writes a sentinel file', async (t) => {
  const dir = await makeGitRepo(t);
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('SENTINEL','x')\"" } }),
    'utf8'
  );
  git(['add', 'package.json'], dir);
  git(['commit', '-q', '-m', 'add script'], dir);

  await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] });

  await assert.rejects(() => readFile(path.join(dir, 'SENTINEL')));
});

test('Tier 2 is gated behind --exec: no commands given means tier2 is null', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(result.tier2, null);
});

test('Tier 2 --exec runs the given command through a filtered environment: a secret-shaped env var does not leak into the child', async (t) => {
  const dir = await makeGitRepo(t);
  const sourceEnv = { ...process.env, PREFLIGHT_TEST_SECRET: 'leak-me' };
  const originalEnv = process.env.PREFLIGHT_TEST_SECRET;
  process.env.PREFLIGHT_TEST_SECRET = 'leak-me';
  t.after(() => {
    if (originalEnv === undefined) delete process.env.PREFLIGHT_TEST_SECRET;
    else process.env.PREFLIGHT_TEST_SECRET = originalEnv;
  });
  const result = await run({
    cd: dir,
    exec: [`node -e "process.stdout.write(process.env.PREFLIGHT_TEST_SECRET || 'absent')"`],
    timeout: 30,
    envMode: 'filtered',
    envPassthrough: [],
  });
  assert.equal(result.tier2.results[0].stdout, 'absent');
});

test('Tier 2 --exec with --env-mode inherit passes the secret through (the escape hatch, opt-in only)', async (t) => {
  const dir = await makeGitRepo(t);
  const originalEnv = process.env.PREFLIGHT_TEST_SECRET;
  process.env.PREFLIGHT_TEST_SECRET = 'leak-me';
  t.after(() => {
    if (originalEnv === undefined) delete process.env.PREFLIGHT_TEST_SECRET;
    else process.env.PREFLIGHT_TEST_SECRET = originalEnv;
  });
  const result = await run({
    cd: dir,
    exec: [`node -e "process.stdout.write(process.env.PREFLIGHT_TEST_SECRET || 'absent')"`],
    timeout: 30,
    envMode: 'inherit',
    envPassthrough: [],
  });
  assert.equal(result.tier2.results[0].stdout, 'leak-me');
});

test('Tier 2 records exit code, duration, and captures stdout/stderr verbatim', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({
    cd: dir,
    exec: ['node -e "console.log(\'to-stdout\'); console.error(\'to-stderr\'); process.exit(3)"'],
    timeout: 30,
    envMode: 'filtered',
    envPassthrough: [],
  });
  const r = result.tier2.results[0];
  assert.equal(r.exitCode, 3);
  assert.match(r.stdout, /to-stdout/);
  assert.match(r.stderr, /to-stderr/);
  assert.ok(typeof r.durationMs === 'number' && r.durationMs >= 0);
});

test('Tier 2 --timeout kills a hanging command and reports timedOut:true, exitCode:null', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({
    cd: dir,
    exec: ['node -e "setTimeout(()=>{}, 60000)"'],
    timeout: 1,
    envMode: 'filtered',
    envPassthrough: [],
  });
  const r = result.tier2.results[0];
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
});

test('Tier 2 --timeout: the child\'s own "close" event (fired by killTree\'s taskkill/SIGKILL terminating it) never overwrites timedOut back to false -- this was a real race, caught by a flaky CI run', async (t) => {
  const dir = await makeGitRepo(t);
  // Run several times: the original bug (timedOut set only inside killTree's
  // .finally(), racing against the child's own 'close' handler seeing the
  // taskkill-caused exit first and resolving {timedOut:false}) was
  // intermittent, not deterministic on every run.
  for (let i = 0; i < 5; i++) {
    const result = await run({
      cd: dir,
      exec: ['node -e "setTimeout(()=>{}, 60000)"'],
      timeout: 1,
      envMode: 'filtered',
      envPassthrough: [],
    });
    assert.equal(result.tier2.results[0].timedOut, true, `iteration ${i}: timedOut must be true`);
  }
});

test('runTier2 spawns the Tier-2 command with detached:true on a POSIX platform, and NOT on win32 -- without it, killTree\'s process.kill(-pid) targets a group the child was never the leader of', async (t) => {
  const dir = await makeGitRepo(t);
  const calls = [];
  const fakeSpawn = (command, opts) => {
    calls.push({ command, opts });
    return spawn(process.execPath, ['-e', 'process.exit(0)']);
  };
  await runTier2(
    { cd: dir, commands: ['echo hi'], timeout: 0, envMode: 'filtered', envPassthrough: [] },
    { spawnFn: fakeSpawn, platform: 'linux' }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.detached, true);

  const calls2 = [];
  const fakeSpawn2 = (command, opts) => {
    calls2.push({ command, opts });
    return spawn(process.execPath, ['-e', 'process.exit(0)']);
  };
  await runTier2(
    { cd: dir, commands: ['echo hi'], timeout: 0, envMode: 'filtered', envPassthrough: [] },
    { spawnFn: fakeSpawn2, platform: 'win32' }
  );
  assert.equal(calls2.length, 1);
  assert.ok(!calls2[0].opts.detached);
});

test('Tier 2 --timeout: the timed-out command is actually terminated, not just reported as timedOut -- the real, deepest child (not just the shell wrapper) is confirmed dead', async (t) => {
  const dir = await makeGitRepo(t);
  const pidfile = path.join(dir, 'child.pid');
  // node -e forks a real grandchild under the shell wrapper -- the same shape as a Tier-2
  // "npm test"/"pytest" invocation -- and writes ITS OWN pid so this test checks the actual
  // worker process, not just whether the outer shell exited. The whole exec string goes through
  // shell:true (cmd.exe on win32, sh on POSIX), so the -e script must not contain any double
  // quote -- JSON.stringify(pidfile) would embed one and truncate cmd.exe's own outer "..."
  // wrapper before the real script even runs. Pass the path via an env var instead.
  const script =
    "const fs=require('fs');fs.writeFileSync(process.env.PIDFILE,String(process.pid));" +
    'setTimeout(()=>{}, 60000)';
  const previousPidfileEnv = process.env.PIDFILE;
  process.env.PIDFILE = pidfile;
  t.after(() => {
    if (previousPidfileEnv === undefined) delete process.env.PIDFILE;
    else process.env.PIDFILE = previousPidfileEnv;
  });
  const result = await run({
    cd: dir,
    exec: [`node -e "${script}"`],
    // A generous bound: per-spawn overhead on a loaded machine (AV scanning, CI runner
    // contention) has been observed well past 1s; a too-tight timeout here risks the
    // grandchild not having written its pidfile yet when the timer fires, which is a
    // false test failure unrelated to whether the kill itself works.
    timeout: 5,
    envMode: 'filtered',
    envPassthrough: ['PIDFILE'],
  });
  assert.equal(result.tier2.results[0].timedOut, true);

  let pidText;
  try {
    pidText = await readFile(pidfile, 'utf8');
  } catch (err) {
    throw new Error(
      `child never wrote its pidfile within the timeout -- spawn was slower than the ` +
        `bound, or the command itself is broken (original: ${err.message})`
    );
  }
  const pid = Number(pidText);
  assert.ok(Number.isInteger(pid) && pid > 0, `pidfile did not contain a valid pid: ${pidText}`);
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  });

  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code !== 'ESRCH' ? true : false;
    }
  };
  // A freshly-killed POSIX process can remain a zombie (kill(pid,0) still succeeds) until
  // reaped; poll briefly rather than asserting dead on the very next tick. Checked on both
  // platforms: win32's taskkill /T /F is synchronous but this still confirms the real,
  // deepest grandchild died, not just that the outer shell exited.
  const deadline = Date.now() + 5000;
  let alive = isAlive();
  while (alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    alive = isAlive();
  }
  assert.equal(alive, false, `pid ${pid} is still alive after run() returned -- the timed-out command was reported dead but the real process kept running`);
});

test('computeSnapshotHash: identical state produces identical hashes across independent calls (deterministic)', async (t) => {
  const dir = await makeGitRepo(t);
  const a = await computeSnapshotHash(dir);
  const b = await computeSnapshotHash(dir);
  assert.equal(a, b);
});

test('checkStale: a tracked-file modification after capture is detected as stale', async (t) => {
  const dir = await makeGitRepo(t);
  const hash = await computeSnapshotHash(dir);
  await writeFile(path.join(dir, 'a.txt'), 'modified\n', 'utf8');
  const result = await checkStale(dir, hash);
  assert.equal(result.stale, true);
});

test('checkStale: a NEW untracked file after capture is detected as stale (creation, not just modification of a tracked file)', async (t) => {
  const dir = await makeGitRepo(t);
  const hash = await computeSnapshotHash(dir);
  await writeFile(path.join(dir, 'brand-new.txt'), 'new content\n', 'utf8');
  const result = await checkStale(dir, hash);
  assert.equal(result.stale, true);
});

test('checkStale: no change after capture reports not stale', async (t) => {
  const dir = await makeGitRepo(t);
  const hash = await computeSnapshotHash(dir);
  const result = await checkStale(dir, hash);
  assert.equal(result.stale, false);
  assert.equal(result.currentSnapshotHash, hash);
});

test('run(): tier1.snapshotHash and tier2.snapshotHash agree in the same invocation (same underlying git state)', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: ['echo hi'], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(result.snapshotHash, result.tier2.snapshotHash);
});

test('run(): this is a thin executor, never an analyzer -- the output carries only the documented fact fields, no interpretive text', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: ['echo hi'], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  const tier1Keys = new Set(Object.keys(result.tier1));
  for (const k of tier1Keys) {
    assert.ok(
      ['gitRepo', 'diff', 'status', 'changedFiles', 'fileStats', 'note'].includes(k),
      `unexpected key on tier1 output: "${k}"`
    );
  }
  const tier2ResultKeys = new Set(Object.keys(result.tier2.results[0]));
  for (const k of tier2ResultKeys) {
    assert.ok(
      ['command', 'startedAt', 'finishedAt', 'durationMs', 'exitCode', 'timedOut', 'touchedFiles', 'stdout', 'stderr'].includes(k),
      `unexpected key on a tier2 result: "${k}"`
    );
  }
});

test('runTier1: changedFiles includes fileStats (size/mtime) for a currently-existing changed file', async (t) => {
  const dir = await makeGitRepo(t);
  await writeFile(path.join(dir, 'a.txt'), 'changed content here\n', 'utf8');
  const tier1 = await runTier1(dir);
  assert.ok(tier1.changedFiles.includes('a.txt'));
  assert.equal(typeof tier1.fileStats['a.txt'].sizeBytes, 'number');
  assert.equal(typeof tier1.fileStats['a.txt'].mtime, 'string');
});

test('runTier1: a changed file that was subsequently deleted from the working tree is omitted from fileStats, not fabricated', async (t) => {
  const dir = await makeGitRepo(t);
  await rm(path.join(dir, 'a.txt'));
  const tier1 = await runTier1(dir);
  assert.ok(tier1.changedFiles.includes('a.txt'));
  assert.equal(Object.hasOwn(tier1.fileStats, 'a.txt'), false);
});

test('runTier1: a STAGED change (git add, not yet committed) appears in changedFiles/diff -- git diff HEAD, not bare git diff', async (t) => {
  const dir = await makeGitRepo(t);
  await writeFile(path.join(dir, 'a.txt'), 'staged content\n', 'utf8');
  git(['add', 'a.txt'], dir);
  const tier1 = await runTier1(dir);
  assert.ok(tier1.changedFiles.includes('a.txt'), 'a staged-only change must appear in changedFiles');
  assert.match(tier1.diff, /staged content/);
});

test('runTier1: a new UNTRACKED file appears in changedFiles/fileStats, not just tracked changes', async (t) => {
  const dir = await makeGitRepo(t);
  await writeFile(path.join(dir, 'brand-new.txt'), 'new file content\n', 'utf8');
  const tier1 = await runTier1(dir);
  assert.ok(tier1.changedFiles.includes('brand-new.txt'));
  assert.equal(typeof tier1.fileStats['brand-new.txt'].sizeBytes, 'number');
});

test('runTier1: cd as a SUBDIRECTORY produces cd-relative changedFiles/fileStats, not repo-root-relative paths', async (t) => {
  const dir = await makeGitRepo(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'sub', 'b.txt'), 'hello\n', 'utf8');
  git(['add', 'sub/b.txt'], dir);
  git(['commit', '-q', '-m', 'add sub/b.txt'], dir);
  await writeFile(path.join(dir, 'sub', 'b.txt'), 'changed\n', 'utf8');
  const tier1 = await runTier1(path.join(dir, 'sub'));
  assert.deepEqual(tier1.changedFiles, ['b.txt']);
  assert.equal(typeof tier1.fileStats['b.txt'].sizeBytes, 'number');
});
