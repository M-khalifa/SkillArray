// Tests for ../preflight.mjs. Spawns real `git`/`node` child processes
// against disposable temp git repos -- no network, no provider CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform as osPlatform } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, runTier1, runTier2, computeSnapshotHash, checkStale, run, RelayError, repoFreshness, freshnessWarnings, findReviewArtifacts,
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

test('run(): --compact keeps pytest -q bare totals ("137 passed, 1 warning in 0.37s", "2 failed, 54 passed in 59.83s") in summary, but not a log line that merely mentions passed', async (t) => {
  const dir = await makeGitRepo(t);
  const logDir = path.join(dir, '..', `${path.basename(dir)}-qlogs`);
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const lines = ['137 passed, 1 warning in 0.37s', 'test_x passed', '2 failed, 54 passed in 59.83s', 'setting 3 passed to the next stage'];
  const cmd = `node -e "${lines.map((l) => `console.log('${l}')`).join(';')}"`;
  const result = await run({ cd: dir, exec: [cmd], timeout: 30, envMode: 'filtered', envPassthrough: [], compact: true, tail: 0, logDir });
  assert.deepEqual(result.tier2.results[0].stdout.summary, ['137 passed, 1 warning in 0.37s', '2 failed, 54 passed in 59.83s']);
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

test('run(): --source-snapshot records a plain export\'s stated repo and ref with its file count and content hash; a bad value or missing folder is refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  const snap = path.join(dir, 'svc-export');
  await Promise.all([mkdir(target), mkdir(snap)]);
  await writeFile(path.join(target, 'a.md'), 'x\n');
  await writeFile(path.join(snap, 'main.py'), 'print(1)\n');
  await writeFile(path.join(snap, 'README.md'), 'svc\n');
  const args = parseArgs(['--cd', target, '--source-snapshot', `${snap}=org/svc@1a2b3c4`]);
  assert.deepEqual(args.sourceSnapshots, [{ dir: snap, repo: 'org/svc', ref: '1a2b3c4' }]);
  const result = await run(args);
  assert.equal(result.sourceSnapshots.length, 1);
  const rec = result.sourceSnapshots[0];
  assert.deepEqual({ path: rec.path, repo: rec.repo, ref: rec.ref, fileCount: rec.fileCount }, { path: path.resolve(snap), repo: 'org/svc', ref: '1a2b3c4', fileCount: 2 });
  assert.match(rec.snapshotHash, /^[0-9a-f]{64}$/);
  await writeFile(path.join(snap, 'main.py'), 'print(2)\n');
  assert.notEqual((await run(args)).sourceSnapshots[0].snapshotHash, rec.snapshotHash, 'the hash pins the exported bytes');
  assert.ok(!('sourceSnapshots' in (await run(parseArgs(['--cd', target])))), 'absent without the flag');
  const hashBefore = (await run(args)).sourceSnapshots[0];
  assert.ok(!('skippedCacheCount' in hashBefore));
  await mkdir(path.join(snap, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(path.join(snap, 'pkg', '__pycache__', 'main.cpython-312.pyc'), 'bytecode');
  await mkdir(path.join(snap, '.pytest_cache'));
  await writeFile(path.join(snap, '.pytest_cache', 'README.md'), 'cache');
  await writeFile(path.join(snap, 'stray.pyc'), 'bytecode');
  const withCaches = (await run(args)).sourceSnapshots[0];
  assert.equal(withCaches.snapshotHash, hashBefore.snapshotHash, 'Python caches do not change a source snapshot hash');
  assert.equal(withCaches.fileCount, hashBefore.fileCount);
  assert.deepEqual(withCaches.skippedCaches, ['.pytest_cache/', 'pkg/__pycache__/', 'stray.pyc']);
  assert.equal(withCaches.skippedCacheCount, 3);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../preflight.mjs', import.meta.url)), '--cd', target, '--source-snapshot', `${snap}=org/svc@1a2b3c4`], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /WARNING: .* holds 3 Python cache item\(s\) \(\.pytest_cache\/, pkg\/__pycache__\/, stray\.pyc\); left out of its snapshotHash/);
  assert.throws(() => parseArgs(['--cd', target, '--source-snapshot', `${snap}=org/svc`]), /must look like <folder>=<repo>@<commit or tag>/);
  await assert.rejects(run(parseArgs(['--cd', target, '--source-snapshot', `${path.join(dir, 'nope')}=org/svc@abc`])), /does not exist or is not accessible/);
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

// A local bare "remote", a clone under review, and a second clone that pushes 2 newer commits.
async function staleCloneSetup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'preflight-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  git(['init', '-q', '-b', 'main', seed], root);
  for (const [k, v] of [['user.email', 'a@b.com'], ['user.name', 'test']]) git(['config', k, v], seed);
  await writeFile(path.join(seed, 'a.txt'), 'v1\n', 'utf8');
  git(['add', 'a.txt'], seed);
  git(['commit', '-q', '-m', 'v1'], seed);
  git(['clone', '-q', '--bare', seed, remote], root);
  const clone = path.join(root, 'clone');
  git(['clone', '-q', remote, clone], root);
  const pusher = path.join(root, 'pusher');
  git(['clone', '-q', remote, pusher], root);
  for (const [k, v] of [['user.email', 'a@b.com'], ['user.name', 'test']]) git(['config', k, v], pusher);
  for (const n of [2, 3]) {
    await writeFile(path.join(pusher, 'a.txt'), `v${n}\n`, 'utf8');
    git(['commit', '-q', '-am', `v${n}`], pusher);
  }
  git(['push', '-q', 'origin', 'main'], pusher);
  return { root, clone, remote };
}

test('parseArgs: --repo repeats and --fetch is a flag', () => {
  const args = parseArgs(['--cd', '.', '--repo', 'r1', '--repo', 'r2', '--fetch']);
  assert.deepEqual(args.repos, ['r1', 'r2']);
  assert.equal(args.fetch, true);
  assert.equal(parseArgs(['--cd', '.']).fetch, false);
});

test('repoFreshness: a clone 2 commits behind its remote reports behind 0 before a fetch (stale tracking ref, lastFetchedAt says how old) and behind 2 with --fetch', async (t) => {
  const { clone } = await staleCloneSetup(t);
  const before = await repoFreshness(clone, { role: 'cd' });
  assert.equal(before.branch, 'main');
  assert.equal(before.upstream, 'origin/main');
  assert.equal(before.defaultBranch, 'origin/main');
  assert.equal(before.behind, 0);
  assert.equal(before.ahead, 0);
  assert.equal(before.fetched, false);
  assert.equal(before.dirty, false);
  assert.match(before.head, /^[0-9a-f]{40}$/);
  const after = await repoFreshness(clone, { role: 'cd', fetch: true });
  assert.equal(after.fetched, true);
  assert.equal(after.behind, 2);
  assert.equal(after.behindDefault, 2);
  assert.ok(after.lastFetchedAt, 'a fetch leaves FETCH_HEAD, so lastFetchedAt is set');
  assert.deepEqual(freshnessWarnings([after]), [`preflight: WARNING: ${after.path} is 2 commit(s) behind origin/main`],
    'upstream and origin/HEAD are the same ref, so one warning, not two');
});

test('run(): --repo adds a record per repository after --cd, a plain folder gets gitRepo:false, a missing --repo is refused, and snapshotHash ignores --repo', async (t) => {
  const { root, clone } = await staleCloneSetup(t);
  const plain = path.join(root, 'plain');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(plain);
  const cd = await makeGitRepo(t);
  const base = { cd, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] };
  const result = await run({ ...base, repos: [clone, plain] });
  assert.deepEqual(result.repos.map((r) => [r.role, r.gitRepo]), [['cd', true], ['repo', true], ['repo', false]]);
  assert.equal(result.repos[0].upstream, null, 'a repo with no remote has no upstream');
  assert.equal(result.repos[0].behind, null);
  assert.equal(result.snapshotHash, (await run(base)).snapshotHash);
  await assert.rejects(run({ ...base, repos: [path.join(root, 'nope')] }), /--repo ".*nope" is not an accessible directory/);
});

test('run(): --watch-file names a packet file changed by upstream commits not in HEAD, skips an unchanged one, and lists a file outside every repo', async (t) => {
  const { root, clone } = await staleCloneSetup(t);
  await writeFile(path.join(clone, 'b.txt'), 'local only\n', 'utf8');
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], fetch: true,
    watchFiles: [path.join(clone, 'a.txt'), path.join(clone, 'b.txt'), path.join(root, 'elsewhere.txt')] });
  assert.deepEqual(result.repos[0].watchedChangedUpstream, [{ file: 'a.txt', ref: 'origin/main', commits: 2, contentDiffers: true }]);
  assert.deepEqual(result.watchFilesOutsideRepos, [path.join(root, 'elsewhere.txt')]);
  assert.ok(freshnessWarnings(result.repos).includes(`preflight: WARNING: a.txt in ${result.repos[0].path} changed in 2 commit(s) on origin/main not in HEAD and differs from HEAD`));
});

test('run(): --watch-file reports contentDiffers:false and only a note when the upstream change already reached HEAD another way', async (t) => {
  const { clone } = await staleCloneSetup(t);
  // The same final content, committed locally: upstream commits are still not in HEAD, the file is identical.
  git(['config', 'user.email', 'a@b.com'], clone);
  git(['config', 'user.name', 'test'], clone);
  await writeFile(path.join(clone, 'a.txt'), 'v3\n', 'utf8');
  git(['commit', '-q', '-am', 'same change, other path'], clone);
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], fetch: true, watchFiles: [path.join(clone, 'a.txt')] });
  assert.deepEqual(result.repos[0].watchedChangedUpstream, [{ file: 'a.txt', ref: 'origin/main', commits: 2, contentDiffers: false }]);
  const lines = freshnessWarnings(result.repos);
  assert.ok(lines.some((l) => /note: a\.txt .* content is identical to HEAD/.test(l)));
  assert.ok(!lines.some((l) => /WARNING: a\.txt/.test(l)));
});

test('run(): --watch-file before any fetch sees no upstream change (stale tracking ref), so the packet must say whether --fetch ran', async (t) => {
  const { clone } = await staleCloneSetup(t);
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], watchFiles: [path.join(clone, 'a.txt')] });
  assert.deepEqual(result.repos[0].watchedChangedUpstream, []);
  assert.equal(result.repos[0].fetched, false);
});

test('run(): a past run\'s findings files inside the target are reported as reviewArtifactFiles with a WARNING; ordinary files are not', async (t) => {
  const cd = await makeGitRepo(t);
  const base = { cd, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] };
  assert.equal((await run(base)).repos[0].reviewArtifactCount, undefined);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(cd, 'old-run'));
  await writeFile(path.join(cd, 'old-run', 'findings.json'), '{"findings":[{"id":"F1","origins": ["A3","B7"],"final_state":"settled-agree"}]}\n', 'utf8');
  await writeFile(path.join(cd, 'old-run', 'A-findings.md'), '# Seat A findings\n\n## A1 — t\n', 'utf8');
  await writeFile(path.join(cd, 'old-run', 'notes.md'), '## B3 — retry loop\nSeverity: HIGH\n', 'utf8');
  // Ordinary text that the first version flagged: product headings, the protocol's own schema
  // example, and a script that only mentions "origins" in its help text.
  await writeFile(path.join(cd, 'notes.md'), '## B2B integration\n## A100 nodes\nPart A4 paper\n', 'utf8');
  await writeFile(path.join(cd, 'review-protocol.md'), '# Shared Review Protocol v1.3\n\n## A1 — <claim>\nSeverity: CRITICAL | HIGH\n', 'utf8');
  await writeFile(path.join(cd, 'tool.mjs'), 'const help = `findings.json "origins": ["A1"...]`;\n', 'utf8');
  const r = (await run(base)).repos[0];
  assert.equal(r.reviewArtifactCount, 3);
  assert.deepEqual(r.reviewArtifactFiles, ['old-run/A-findings.md', 'old-run/findings.json', 'old-run/notes.md']);
  assert.equal(r.reviewArtifactCountIsLowerBound, undefined);
  assert.match(freshnessWarnings([r])[0], /3 file\(s\) in .* hold review output with real claim IDs/);
});

test('run(): the review-artifact scan stops reading after 50 hits in a plain folder and marks the count as a lower bound', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-artifact-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 120; i++) await writeFile(path.join(dir, `A-findings-${i}.md`), '# Seat A findings\n', 'utf8');
  const r = (await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] })).repos[0];
  assert.equal(r.gitRepo, false);
  assert.equal(r.reviewArtifactFiles.length, 50);
  assert.ok(r.reviewArtifactCount >= 50 && r.reviewArtifactCount < 120, `count ${r.reviewArtifactCount} is a partial count`);
  assert.equal(r.reviewArtifactCountIsLowerBound, true);
  assert.match(freshnessWarnings([r])[0], /\d+\+ file\(s\)/);
});

test('findReviewArtifacts: stops taking names from the lister once 50 hits are found (lazy listing), and reports a lower bound', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-lazy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 60; i++) await writeFile(path.join(dir, `hit-${i}.md`), '# Seat A findings\n', 'utf8');
  let pulled = 0;
  async function* lister() {
    for (let i = 0; i < 60; i++) { pulled++; yield `hit-${i}.md`; }
    for (let i = 0; i < 100000; i++) { pulled++; yield `missing-${i}.md`; }
  }
  const r = await findReviewArtifacts(dir, async () => lister());
  assert.equal(r.capped, true);
  assert.ok(r.count >= 50);
  assert.ok(pulled < 200, `only about 50-70 names should be pulled, pulled ${pulled}`);
});

test('run() --compact: a rerun into the same --log-dir deletes only this script\'s own earlier logs (a stale command-2 log from a longer run), lists them, and keeps other files', async (t) => {
  const cd = await makeGitRepo(t);
  const logDir = await mkdtemp(path.join(tmpdir(), 'preflight-logs-'));
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const base = { cd, timeout: 10, envMode: 'filtered', envPassthrough: [], compact: true, logDir, tail: 5 };
  await run({ ...base, exec: ['echo one', 'echo two'] });
  await writeFile(path.join(logDir, 'gui-capture.png'), 'x');
  const second = await run({ ...base, exec: ['echo only'] });
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(logDir)).sort(), ['command-1.stderr.log', 'command-1.stdout.log', 'gui-capture.png', 'tier1.diff']);
  assert.deepEqual(second.clearedEarlierLogs, ['command-1.stderr.log', 'command-1.stdout.log', 'command-2.stderr.log', 'command-2.stdout.log', 'tier1.diff']);
  assert.match(await readFile(path.join(logDir, 'command-1.stdout.log'), 'utf8'), /only/);
});

test('CLI: --fetch against a repo behind its remote prints a WARNING on stderr and keeps the JSON raw', async (t) => {
  const { clone } = await staleCloneSetup(t);
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../preflight.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--cd', clone, '--fetch'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /preflight: WARNING: .* is 2 commit\(s\) behind origin\/main/);
  const out = JSON.parse(r.stdout);
  assert.equal(out.repos[0].behind, 2);
  assert.doesNotMatch(r.stdout, /WARNING/);
});
