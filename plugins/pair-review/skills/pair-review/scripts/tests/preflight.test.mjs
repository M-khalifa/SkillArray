// Tests for ../preflight.mjs. Spawns real `git`/`node` child processes
// against disposable temp git repos -- no network, no provider CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform as osPlatform } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertNodeVersion, parseArgs, runTier1, runTier2, computeSnapshotHash, checkStale, run, RelayError, repoFreshness, freshnessWarnings, findReviewArtifacts, summaryLine,
  jobLeftovers, stopLeftovers, runWithTimeout, codexToolProbe, toolProbeWarnings, outsideReadWarning, changeSizeWarning, copyTarget, hostToolPath, sandboxArgs, claudeProjectsWritable,
} from '../preflight.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

async function makeGitRepo(t) {
  // The real path: a child's process.cwd() is the real one, and macOS's default temp folder (/var) is a link into /private/var.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'preflight-test-')));
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

test('run(): a non-git directory gets a content-hash inventory snapshotHash, so its Tier 1/Tier 2 evidence is still bound to exact file contents [slow]', async (t) => {
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

test('computeSnapshotHash: in a monorepo, a commit or edit in a sibling folder does not make the --cd folder stale, but an edit inside it does [slow]', async (t) => {
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

test('run(): a Tier 2 command that writes into the target is reported in touchedFiles and targetChanged, including a re-edit of an already-dirty file [slow]', async (t) => {
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

test('run(): --compact keeps the test-runner total line in summary even when warnings push it out of --tail [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const logDir = path.join(dir, '..', `${path.basename(dir)}-sumlogs`);
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const cmd = `node -e "console.log('===== 212 passed, 3 warnings in 9.1s ====='); for (let i = 0; i < 10; i++) console.log('warning ' + i)"`;
  const result = await run({ cd: dir, exec: [cmd], timeout: 30, envMode: 'filtered', envPassthrough: [], compact: true, tail: 3, logDir });
  const out = result.tier2.results[0].stdout;
  assert.ok(!out.tail.some((l) => l.includes('212 passed')));
  assert.deepEqual(out.summary, ['===== 212 passed, 3 warnings in 9.1s =====']);
});

test('run(): --compact keeps pytest -q bare totals ("137 passed, 1 warning in 0.37s", "2 failed, 54 passed in 59.83s") in summary, but not a log line that merely mentions passed [slow]', async (t) => {
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

test('run(): --compact keeps byte counts, sha256, tail and fail/error lines in the JSON and writes the full stdout to a log whose hash matches [slow]', async (t) => {
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

test('run(): --source-snapshot records a plain export\'s stated repo and ref with its file count and content hash; a bad value or missing folder is refused [slow]', async (t) => {
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
  assert.match(cli.stderr, /WARNING: .* holds 3 Python or Gradle cache item\(s\) \(\.pytest_cache\/, pkg\/__pycache__\/, stray\.pyc\); left out of its snapshotHash/);
  // With --out stdout is plain lines, so the note goes there (PowerShell 5.1 shows any stderr line as an error).
  const withOut = spawnSync(process.execPath, [fileURLToPath(new URL('../preflight.mjs', import.meta.url)), '--cd', target, '--source-snapshot', `${snap}=org/svc@1a2b3c4`, '--out', path.join(target, '..', 'pf-out.json')], { encoding: 'utf8' });
  assert.equal(withOut.status, 0, withOut.stderr);
  assert.match(withOut.stdout, /^preflight: wrote .*\npreflight: WARNING: .* holds 3 Python or Gradle cache item\(s\)/);
  assert.equal(withOut.stderr, '');
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

test('Tier 1 never executes anything the target defines, even when the target has a "test" script that writes a sentinel file [slow]', async (t) => {
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

test('Tier 2 is gated behind --exec: no commands given means tier2 is null [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(result.tier2, null);
});

test('Tier 2 --exec runs the given command through a filtered environment: a secret-shaped env var does not leak into the child [slow]', async (t) => {
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

test('Tier 2 --exec in the filtered environment keeps the proxy and CA variables, as the dispatchers do [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
  process.env.HTTPS_PROXY = 'http://proxy.example:8080';
  process.env.NODE_EXTRA_CA_CERTS = 'corp-ca.pem';
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const result = await run({
    cd: dir,
    exec: [`node -e "process.stdout.write((process.env.HTTPS_PROXY || 'none') + ' ' + (process.env.NODE_EXTRA_CA_CERTS || 'none'))"`],
    timeout: 30,
    envMode: 'filtered',
    envPassthrough: [],
  });
  assert.equal(result.tier2.results[0].stdout, 'http://proxy.example:8080 corp-ca.pem');
});

test('Tier 2 --exec with --env-mode inherit passes the secret through (the escape hatch, opt-in only) [slow]', async (t) => {
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

test('Tier 2 records exit code, duration, and captures stdout/stderr verbatim [slow]', async (t) => {
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

test('Tier 2 --timeout kills a hanging command and reports timedOut:true, exitCode:null [slow]', async (t) => {
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

test('Tier 2 --timeout: the child\'s own "close" event (fired by killTree\'s taskkill/SIGKILL terminating it) never overwrites timedOut back to false -- this was a real race, caught by a flaky CI run [slow]', async (t) => {
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

test('runTier2 spawns the Tier-2 command with detached:true on a POSIX platform, and NOT on win32 -- without it, killTree\'s process.kill(-pid) targets a group the child was never the leader of [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const calls = [];
  const fakeSpawn = (command, opts) => {
    calls.push({ command, opts });
    return spawn(process.execPath, ['-e', 'process.exit(0)']);
  };
  const tier2 = await runTier2(
    { cd: dir, commands: ['echo hi'], timeout: 0, envMode: 'filtered', envPassthrough: [] },
    { spawnFn: fakeSpawn, platform: 'linux' }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(tier2.results[0].timeoutS, 0, 'each record keeps the limit it ran under, for the timeout line');

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

test('Tier 2 --timeout: the timed-out command is actually terminated, not just reported as timedOut -- the real, deepest child (not just the shell wrapper) is confirmed dead [slow]', async (t) => {
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

test('computeSnapshotHash: identical state produces identical hashes across independent calls (deterministic) [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const a = await computeSnapshotHash(dir);
  const b = await computeSnapshotHash(dir);
  assert.equal(a, b);
});

test('checkStale: a tracked-file modification after capture is detected as stale [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const hash = await computeSnapshotHash(dir);
  await writeFile(path.join(dir, 'a.txt'), 'modified\n', 'utf8');
  const result = await checkStale(dir, hash);
  assert.equal(result.stale, true);
});

test('checkStale: a NEW untracked file after capture is detected as stale (creation, not just modification of a tracked file) [slow]', async (t) => {
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

test('run(): tier1.snapshotHash and tier2.snapshotHash agree in the same invocation (same underlying git state) [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: ['echo hi'], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  assert.equal(result.snapshotHash, result.tier2.snapshotHash);
});

test('run(): --base lists committed work since that commit in Tier 1 and leaves snapshotHash alone; a bad commit or --host is refused [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const base = git(['rev-parse', 'HEAD'], dir).trim();
  await writeFile(path.join(dir, 'b.txt'), 'committed', 'utf8');
  git(['add', 'b.txt'], dir);
  git(['commit', '-q', '-m', 'work'], dir);
  await writeFile(path.join(dir, 'a.txt'), 'edited', 'utf8');
  const plain = await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  const since = await run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], base: base.slice(0, 7) });
  assert.deepEqual(plain.tier1.changedFiles, ['a.txt']);
  assert.deepEqual([...since.tier1.changedFiles].sort(), ['a.txt', 'b.txt']);
  assert.equal(since.tier1.base, base);
  assert.ok(since.tier1.diff.includes('+committed'), since.tier1.diff);
  assert.equal(since.snapshotHash, plain.snapshotHash);
  assert.ok(summaryLine(since, 'x.json').includes(`2 changed file(s) since ${base.slice(0, 12)}`), summaryLine(since, 'x.json'));
  await assert.rejects(run({ cd: dir, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], base: 'no-such-ref' }), /--base no-such-ref is not a commit/);
  assert.throws(() => parseArgs(['--cd', dir, '--host', 'claude-code', '--run-dir', dir, '--seats', 's.json', '--base', base]), /--base is not used with --host/);
});

test('runTier1 and fingerprintFiles: a renamed file lists its old path too, staged or committed since --base [slow]', async (t) => {
  const { fingerprintFiles } = await import('../preflight.mjs');
  const dir = await makeGitRepo(t);
  const base = git(['rev-parse', 'HEAD'], dir).trim();
  git(['mv', 'a.txt', 'b.txt'], dir);
  const staged = await runTier1(dir);
  assert.deepEqual([...staged.changedFiles].sort(), ['a.txt', 'b.txt']);
  assert.equal((await fingerprintFiles(dir)).files['a.txt'], 'deleted');
  git(['commit', '-q', '-m', 'rename'], dir);
  const since = await runTier1(dir, null, base);
  assert.deepEqual([...since.changedFiles].sort(), ['a.txt', 'b.txt']);
  // A command that renames a file touched both paths.
  const moved = await run({ cd: dir, exec: ['git mv b.txt c.txt'], timeout: 30, envMode: 'filtered', envPassthrough: [] });
  assert.equal(moved.tier2.results[0].exitCode, 0, moved.tier2.results[0].stderr);
  assert.deepEqual([...moved.tier2.results[0].touchedFiles].sort(), ['b.txt', 'c.txt']);
});

test('run(): this is a thin executor, never an analyzer -- the output carries only the documented fact fields, no interpretive text [slow]', async (t) => {
  const dir = await makeGitRepo(t);
  const result = await run({ cd: dir, exec: ['echo hi'], timeout: 10, envMode: 'filtered', envPassthrough: [] });
  const tier1Keys = new Set(Object.keys(result.tier1));
  for (const k of tier1Keys) {
    assert.ok(
      ['gitRepo', 'base', 'diff', 'status', 'changedFiles', 'fileStats', 'note'].includes(k),
      `unexpected key on tier1 output: "${k}"`
    );
  }
  const tier2ResultKeys = new Set(Object.keys(result.tier2.results[0]));
  for (const k of tier2ResultKeys) {
    assert.ok(
      ['command', 'startedAt', 'finishedAt', 'durationMs', 'exitCode', 'timedOut', 'timeoutS', 'touchedFiles', 'stdout', 'stderr'].includes(k),
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

test('repoFreshness: a clone 2 commits behind its remote reports behind 0 before a fetch (stale tracking ref, lastFetchedAt says how old) and behind 2 with --fetch [slow]', async (t) => {
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

test('run(): --repo adds a record per repository after --cd, a plain folder gets gitRepo:false, a missing --repo is refused, and snapshotHash ignores --repo [slow]', async (t) => {
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

test('run(): --watch-file names a packet file changed by upstream commits not in HEAD, skips an unchanged one, and lists a file outside every repo [slow]', async (t) => {
  const { root, clone } = await staleCloneSetup(t);
  await writeFile(path.join(clone, 'b.txt'), 'local only\n', 'utf8');
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], fetch: true,
    watchFiles: [path.join(clone, 'a.txt'), path.join(clone, 'b.txt'), path.join(root, 'elsewhere.txt')] });
  assert.deepEqual(result.repos[0].watchedChangedUpstream, [{ file: 'a.txt', ref: 'origin/main', commits: 2, contentDiffers: true }]);
  assert.deepEqual(result.watchFilesOutsideRepos, [path.join(root, 'elsewhere.txt')]);
  assert.ok(freshnessWarnings(result.repos).includes(`preflight: WARNING: a.txt in ${result.repos[0].path} changed in 2 commit(s) on origin/main not in HEAD and differs from HEAD`));
});

test('Mac round 5 F5: a --watch-file spelled through a link to --cd (macOS /tmp for /private/tmp) is inside it, not outside every repo [slow]', async (t) => {
  const { root, clone } = await staleCloneSetup(t);
  const linked = path.join(root, 'clone-link');
  try {
    await symlink(clone, linked, 'junction');
  } catch (err) {
    t.skip(`cannot create links here: ${err.code}`);
    return;
  }
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], fetch: true, watchFiles: [path.join(linked, 'a.txt')] });
  assert.equal(result.watchFilesOutsideRepos, undefined);
  assert.deepEqual(result.repos[0].watchedChangedUpstream, [{ file: 'a.txt', ref: 'origin/main', commits: 2, contentDiffers: true }]);
});

test('run(): --watch-file reports contentDiffers:false and only a note when the upstream change already reached HEAD another way [slow]', async (t) => {
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

test('run(): --watch-file before any fetch sees no upstream change (stale tracking ref), so the packet must say whether --fetch ran [slow]', async (t) => {
  const { clone } = await staleCloneSetup(t);
  const result = await run({ cd: clone, exec: [], timeout: 10, envMode: 'filtered', envPassthrough: [], watchFiles: [path.join(clone, 'a.txt')] });
  assert.deepEqual(result.repos[0].watchedChangedUpstream, []);
  assert.equal(result.repos[0].fetched, false);
});

test('run(): a past run\'s findings files inside the target are reported as reviewArtifactFiles with a WARNING; ordinary files are not [slow]', async (t) => {
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

test('run() --compact: a rerun into the same --log-dir deletes only this script\'s own earlier logs (a stale command-2 log from a longer run), lists them, and keeps other files [slow]', async (t) => {
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

test('CLI: with no git on PATH preflight says git is required, not an ENOENT stack [slow]', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-nogit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = path.join(dir, 'empty-bin');
  await mkdir(empty);
  await writeFile(path.join(dir, 'a.md'), 'x\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  env.PATH = empty;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../preflight.mjs', import.meta.url)), '--cd', dir], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /git is required and was not found on PATH/);
  assert.doesNotMatch(r.stderr, /unexpected failure|ENOENT/);
});

test('run() --compact: a rerun that clears earlier logs also removes the earlier --out file, which cites them, before any command runs [slow]', async (t) => {
  const cd = await makeGitRepo(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-out-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'preflight.json');
  const base = { cd, timeout: 10, envMode: 'filtered', envPassthrough: [], compact: true, logDir: `${out}.logs`, tail: 5, out };
  await run({ ...base, exec: ['echo first-run'] });
  await writeFile(out, '{"command":"echo first-run"}');
  // run() itself never writes --out (main does, at the end): what is left after it is what a stopped rerun leaves.
  await run({ ...base, exec: ['echo second-run'] });
  await assert.rejects(readFile(out, 'utf8'), { code: 'ENOENT' });
});

test('CLI: --fetch against a repo behind its remote prints a WARNING on stderr and keeps the JSON raw [slow]', async (t) => {
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

test('parseArgs: --exec-in takes a path and a command, and may repeat', () => {
  const args = parseArgs(['--cd', '.', '--exec-in', 'b', 'x', '--exec-in', 'b', 'y']);
  assert.deepEqual(args.execIn, [{ dir: 'b', command: 'x' }, { dir: 'b', command: 'y' }]);
  assert.throws(() => parseArgs(['--cd', '.', '--exec-in', 'b']), /--exec-in requires a value/);
});

test('run(): --exec-in runs in the other repo and binds results to that repo\'s own snapshotHash and touchedFiles [slow]', async (t) => {
  const repoA = await makeGitRepo(t);
  const repoB = await makeGitRepo(t);
  await writeFile(path.join(repoB, 'only-b.txt'), 'b\n', 'utf8');
  const cmd = `"${process.execPath}" -e "require('fs').writeFileSync('made-by-cmd.txt','x');console.log(process.cwd())"`;
  const result = await run({
    cd: repoA, exec: [], execIn: [{ dir: repoB, command: cmd }, { dir: repoB, command: 'echo second' }],
    timeout: 30, envMode: 'filtered', envPassthrough: [],
  });
  assert.equal(result.tier2, null);
  assert.equal(result.tier2Repos.length, 1);
  const entry = result.tier2Repos[0];
  assert.equal(path.resolve(entry.path), path.resolve(repoB));
  assert.equal(path.resolve(entry.results[0].stdout.trim()), path.resolve(repoB));
  assert.equal(entry.snapshotHashAfter, await computeSnapshotHash(path.resolve(repoB)));
  assert.notEqual(entry.snapshotHash, entry.snapshotHashAfter);
  assert.notEqual(entry.snapshotHash, result.snapshotHash);
  assert.equal(entry.targetChanged, true);
  assert.ok(entry.results[0].touchedFiles.some((f) => JSON.stringify(f).includes('made-by-cmd.txt')));
  assert.equal(entry.results[1].exitCode, 0);
  assert.equal(result.snapshotHash, await computeSnapshotHash(repoA));
});

test('run(): --exec-in with --compact continues command-N log numbering after --exec [slow]', async (t) => {
  const repoA = await makeGitRepo(t);
  const repoB = await makeGitRepo(t);
  const logDir = await mkdtemp(path.join(tmpdir(), 'preflight-execin-logs-'));
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const result = await run({
    cd: repoA, exec: ['echo one'], execIn: [{ dir: repoB, command: 'echo two' }],
    timeout: 30, envMode: 'filtered', envPassthrough: [], compact: true, tail: 1, logDir,
  });
  assert.match(result.tier2.results[0].stdout.log, /command-1\.stdout\.log$/);
  assert.match(result.tier2Repos[0].results[0].stdout.log, /command-2\.stdout\.log$/);
  assert.match(await readFile(result.tier2Repos[0].results[0].stdout.log, 'utf8'), /two/);
});

test('run(): --exec-in rejects a missing directory', async (t) => {
  const repoA = await makeGitRepo(t);
  await assert.rejects(
    run({ cd: repoA, exec: [], execIn: [{ dir: path.join(repoA, 'nope'), command: 'echo x' }], timeout: 5, envMode: 'filtered', envPassthrough: [] }),
    /--exec-in .* does not exist/,
  );
});

test('summaryLine: names the hash and each command exit code, with --exec-in entries and a timeout', () => {
  const r = (exitCode, timedOut = false) => ({ exitCode, timedOut, timeoutS: 1800 });
  const line = summaryLine({
    snapshotHash: 'abc', tier2: { targetChanged: false, results: [r(0), r(1)] },
    tier2Repos: [{ path: '/b', targetChanged: true, results: [r(null, true)] }],
  }, 'pf.json');
  // Field run: a timeout names its limit and the flag that raises it.
  assert.equal(line, 'preflight: wrote pf.json; snapshotHash abc; tier2: 2 command(s), exit 0, 1, targetChanged false; tier2Repos /b: 1 command(s), exit timeout after 1800 s (raise with --timeout <seconds>, 0 = unlimited), targetChanged true');
  assert.equal(summaryLine({ snapshotHash: 'abc', tier2: null }, 'pf.json'), 'preflight: wrote pf.json; snapshotHash abc; no Tier 2 command');
});

test('run(): every --exec-in folder is checked before any command runs', async (t) => {
  const repoA = await makeGitRepo(t);
  const wrote = path.join(repoA, 'wrote.txt').split(path.sep).join('/');
  await assert.rejects(
    run({ cd: repoA, exec: [`"${process.execPath}" -e "require('fs').writeFileSync('${wrote}','x')"`], execIn: [{ dir: path.join(repoA, 'nope'), command: 'echo y' }], timeout: 30, envMode: 'filtered', envPassthrough: [] }),
    /--exec-in .* does not exist/,
  );
  assert.equal(await readFile(path.join(repoA, 'wrote.txt'), 'utf8').then(() => true, () => false), false, 'the --exec command did not run');
});

test('run(): an --exec-in command that writes into the --cd target is reported, not silent [slow]', async (t) => {
  const repoA = await makeGitRepo(t);
  const repoB = await makeGitRepo(t);
  const injected = path.join(repoA, 'injected.txt').split(path.sep).join('/');
  const clean = await run({ cd: repoA, exec: [], execIn: [{ dir: repoB, command: 'echo ok' }], timeout: 30, envMode: 'filtered', envPassthrough: [] });
  assert.equal(clean.execInChangedTarget, undefined);
  const result = await run({
    cd: repoA, exec: [], execIn: [{ dir: repoB, command: `"${process.execPath}" -e "require('fs').writeFileSync('${injected}','x')"` }],
    timeout: 30, envMode: 'filtered', envPassthrough: [],
  });
  assert.equal(result.execInChangedTarget, true);
  assert.equal(result.tier2Repos[0].targetChanged, false, 'repo B itself was not changed');
  assert.equal((await checkStale(repoA, result.snapshotHash)).stale, true, 'the --cd hash is stale, as the flag says');
});

test('summaryLine: the last summary line each compact command printed sits next to its exit code', () => {
  const r = (exitCode, summary) => ({ exitCode, timedOut: false, stdout: { summary } });
  const line = summaryLine({
    snapshotHash: 'abc', tier2: { targetChanged: false, results: [r(0, ['collected 152 items', '152 passed in 4.2s']), r(1, []), r(0, undefined)] },
    tier2Repos: [{ path: '/b', targetChanged: false, results: [r(0, ['48 passed'])] }],
  }, 'pf.json');
  assert.equal(line, 'preflight: wrote pf.json; snapshotHash abc; tier2: 3 command(s), exit 0 (152 passed in 4.2s), 1, 0, targetChanged false; tier2Repos /b: 1 command(s), exit 0 (48 passed), targetChanged false');
});

test('CLI: [slow] --fail-on-command-error exits 4 after writing the result when a --exec command fails; without it the exit stays 0', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-failflag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.md'), 'x\n');
  const script = fileURLToPath(new URL('../preflight.mjs', import.meta.url));
  const base = [script, '--cd', dir, '--exec', 'node -e "process.exit(3)"'];
  const plain = spawnSync(process.execPath, base, { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  const strict = spawnSync(process.execPath, [...base, '--fail-on-command-error'], { encoding: 'utf8' });
  assert.equal(strict.status, 4, strict.stderr);
  assert.match(strict.stderr, /1 command\(s\) failed or timed out/);
  assert.equal(JSON.parse(strict.stdout).tier2.results[0].exitCode, 3, 'the result is still written');
  const ok = spawnSync(process.execPath, [script, '--cd', dir, '--exec', 'node -e "0"', '--fail-on-command-error'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('CLI: [slow] --exec-file runs each line exactly as written: quotes and a path with spaces survive, # and blank lines are skipped', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight exec file '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.md'), 'x\n');
  const out = path.join(dir, 'sub dir', 'seen - out.txt');
  const file = path.join(dir, 'commands.txt');
  await writeFile(file, `\uFEFF# checks\r\n\r\n"${process.execPath}" -e "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});require('fs').writeFileSync(process.argv[1],'ok')" "${out}"\r\n"${process.execPath}" -e "process.exit(0)"   \r\n`);
  const script = fileURLToPath(new URL('../preflight.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--cd', dir, '--exec-file', file, '--fail-on-command-error'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const results = JSON.parse(r.stdout).tier2.results;
  assert.equal(results.length, 2);
  assert.ok(results.every((x) => x.exitCode === 0), JSON.stringify(results));
  assert.match(results[1].command, /process\.exit\(0\)" {3}$/, 'trailing spaces reach the shell too');
  // --exec-in-file reads the same file form for another repository: one --exec-in per command line.
  const other = path.join(dir, 'other repo - with dash');
  const parsed = parseArgs(['--cd', dir, '--exec-in-file', other, file]);
  assert.deepEqual(parsed.execIn.map((e) => e.dir), [other, other]);
  assert.match(parsed.execIn[0].command, /writeFileSync\(process\.argv\[1\],'ok'\)" ".*seen - out\.txt"$/);
  assert.equal(await readFile(out, 'utf8'), 'ok');
  const empty = path.join(dir, 'empty.txt');
  await writeFile(empty, '# nothing\n');
  assert.match(spawnSync(process.execPath, [script, '--cd', dir, '--exec-file', empty], { encoding: 'utf8' }).stderr, /holds no command/);
  assert.match(spawnSync(process.execPath, [script, '--cd', dir, '--exec-file', path.join(dir, 'missing.txt')], { encoding: 'utf8' }).stderr, /cannot be read/);
  // What PowerShell 5.1's "> file" writes: UTF-16LE with a byte-order mark.
  const utf16 = path.join(dir, 'utf16.txt');
  await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('node -e "0"\r\n', 'utf16le')]));
  const refused = spawnSync(process.execPath, [script, '--cd', dir, '--exec-file', utf16], { encoding: 'utf8' });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /is not UTF-8 text \(UTF-16 or NUL bytes\)/);
  assert.doesNotMatch(refused.stderr, /unexpected failure|at runWithTimeout/, 'a refusal, not a stack trace');
});

test('CLI: a reader that closes stdout early does not fail the script (EPIPE exits 0) [slow]', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-epipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a.md'), 'x\n');
  const script = fileURLToPath(new URL('../preflight.mjs', import.meta.url));
  for (let i = 0; i < 3; i += 1) {
    const child = spawn(process.execPath, [script, '--cd', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, 'exit code with the reader gone');
  }
});

test('summaryLine: the changed-file count and the untracked file names are in the one-line summary', () => {
  const nl = String.fromCharCode(10);
  const tier1 = { changedFiles: ['a.py', 'new1.py', 'new2.py'], status: [' M a.py', '?? new1.py', '?? new2.py', ''].join(nl) };
  const line = summaryLine({ tier1, tier2: null, snapshotHash: 'abc' }, 'out.json');
  assert.match(line, /; 3 changed file\(s\) \(2 untracked: new1\.py, new2\.py\); no Tier 2 command$/);
  assert.equal(summaryLine({ tier1: { changedFiles: ['a.py'], status: ' M a.py' }, tier2: null, snapshotHash: 'abc' }, 'o').includes('untracked'), false);
  assert.equal(summaryLine({ tier2: null, snapshotHash: 'abc' }, 'o'), 'preflight: wrote o; snapshotHash abc; no Tier 2 command');
  const folder = { changedFiles: ['a.py', 'dir/x', 'dir/y', 'dir/z'], status: [' M a.py', '?? dir/', ''].join(nl) };
  assert.match(summaryLine({ tier1: folder, tier2: null, snapshotHash: 'abc' }, 'o'), /; 4 changed file\(s\) \(3 untracked: dir\/\);/, 'a new folder counts its files, as git ls-files does');
  const quoted = { changedFiles: ['sp ace.txt', 'plain.txt'], status: ['?? "sp ace.txt"', '?? plain.txt', ''].join(nl) };
  assert.match(summaryLine({ tier1: quoted, tier2: null, snapshotHash: 'abc' }, 'o'), / \(2 untracked: /, 'a name git quotes still counts');
});

test('assertNodeVersion: Node 22 and newer pass, older Node stops preflight with a message that names the version', () => {
  assert.doesNotThrow(() => assertNodeVersion('22.0.0'));
  assert.doesNotThrow(() => assertNodeVersion('24.3.1'));
  assert.throws(() => assertNodeVersion('20.18.0'), (e) => e instanceof RelayError && /Node\.js 22 or newer.*20\.18\.0/.test(e.message));
  assert.throws(() => assertNodeVersion('not-a-version'), RelayError);
  assert.doesNotThrow(() => assertNodeVersion());
});

test('Mac round 4 F5: for a subfolder target, status and the summary line count and name only untracked files inside it', async (t) => {
  const repo = await makeGitRepo(t);
  await mkdir(path.join(repo, 'sub'));
  await writeFile(path.join(repo, 'sub', 'a.txt'), 'x\n');
  git(['add', 'sub/a.txt'], repo);
  git(['commit', '-q', '-m', 'sub'], repo);
  for (const f of ['other1.txt', 'other2.txt', path.join('sub', 'new.txt')]) await writeFile(path.join(repo, f), 'u\n');
  const tier1 = await runTier1(path.join(repo, 'sub'));
  assert.deepEqual(tier1.changedFiles, ['new.txt']);
  assert.equal(tier1.status, '?? sub/new.txt\n');
  assert.match(summaryLine({ snapshotHash: 'h', tier1 }, 'out.json'), /; 1 changed file\(s\) \(1 untracked: new\.txt\); no Tier 2 command$/);
});

test('round 5: the job report gives the leftover pids; without a usable job the parent-chain scan runs and stops only the command\'s tree', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'job-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = path.join(dir, 'job.txt');
  const logged = [];
  const log = (m) => logged.push(m);
  await writeFile(report, 'left 41 42');
  assert.deepEqual(jobLeftovers(report, { log }), [41, 42]);
  await writeFile(report, 'left ');
  assert.deepEqual(jobLeftovers(report, { log }), []);
  assert.equal(logged.length, 0);
  await writeFile(report, 'nojob AssignProcessToJobObject failed: 5');
  assert.equal(jobLeftovers(report, { log }), null);
  assert.match(logged.at(-1), /could not run in a job object \(AssignProcessToJobObject failed: 5\); scanning/);
  assert.equal(jobLeftovers(path.join(dir, 'missing.txt'), { log }), null);
  assert.match(logged.at(-1), /could not be read \(ENOENT\)/);
  // The scan: a child and grandchild of the shell created after it started are stopped through the child; an older
  // process with a reused parent pid, and an unrelated one, are not.
  const start = 1_000_000;
  const table = ['500 100 1000500', '600 500 1000600', '700 100 900000', '800 999 1000700'].join('\n');
  const calls = [];
  const fake = (file, args) => { calls.push([path.basename(file), ...args]); return /powershell/i.test(file) ? { status: 0, stdout: table, stderr: '' } : { status: 0 }; };
  assert.deepEqual(stopLeftovers(100, start, { run: fake, log }), [500]);
  assert.deepEqual(calls.filter((c) => c[0] === 'taskkill.exe').map((c) => c.slice(1)), [['/pid', '500', '/T', '/F']]);
  assert.match(logged.at(-1), /left 1 process\(es\) running \(pid 500\); they were stopped/);
});

test('closing round 4: a stop signal never kills the tree of a command that already exited (its pid may now be another process), and still kills one that has not', async (t) => {
  const { stopOnSignal } = await import('../preflight.mjs');
  const { EventEmitter } = await import('node:events');
  // An --exec command leads its own process group on POSIX (detached), which the stop signals.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  t.after(() => { try { other.kill(); } catch { /* already gone */ } });
  await new Promise((r) => other.once('spawn', r));
  const alive = () => { try { process.kill(other.pid, 0); return true; } catch { return false; } };
  const run = async (fields) => {
    const proc = new EventEmitter();
    const exited = [];
    const guard = stopOnSignal(Object.assign(new EventEmitter(), { pid: other.pid }, fields), { proc, exit: (c) => exited.push(c) });
    proc.emit('SIGINT');
    for (let i = 0; i < 100 && exited.length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    guard.uninstall();
    return exited;
  };
  assert.deepEqual(await run({ exitCode: 0 }), [130]);
  assert.equal(alive(), true, 'the process now holding the exited command\'s pid was not stopped');
  assert.deepEqual(await run({ exitCode: null, signalCode: null }), [130]);
  for (let i = 0; i < 50 && alive(); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, 'a running command is still stopped');
});

test('field run: on a plain folder the drift check ignores Python and Gradle caches a build wrote, but not a source change', async (t) => {
  const { fingerprintFiles, driftedFiles } = await import('../preflight.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-plain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'main.py'), 'print(1)');
  const before = await fingerprintFiles(dir);
  await mkdir(path.join(dir, '__pycache__'), { recursive: true });
  await writeFile(path.join(dir, '__pycache__', 'main.cpython-311.pyc'), 'x');
  await mkdir(path.join(dir, 'app', '.gradle', '8.9'), { recursive: true });
  await writeFile(path.join(dir, 'app', '.gradle', '8.9', 'file.lock'), 'x');
  assert.deepEqual(driftedFiles(before, await fingerprintFiles(dir)), []);
  await writeFile(path.join(dir, 'new.py'), 'x');
  assert.deepEqual(driftedFiles(before, await fingerprintFiles(dir)), ['new.py']);
});

test('changeSizeWarning: a change over 500 files or 8,000 lines suggests scoped runs; at or under both, nothing', () => {
  assert.equal(changeSizeWarning(500, 8000), null);
  assert.match(changeSizeWarning(501, 0), /large \(501 changed file\(s\), 0 changed line\(s\) in tracked files\).*several runs/);
  assert.match(changeSizeWarning(3, 8001), /3 changed file\(s\), 8001 changed line\(s\)/);
  assert.equal(changeSizeWarning(20, 300, { maxFiles: 10 }) !== null, true, 'the limits can be set');
});

test('restructure round 2 F3: an --exec command that times out with no job object still says a process it started may be running [slow]', { skip: process.platform !== 'win32' }, async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'preflight-nojob-')));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = temp;
  process.env.TMP = temp;
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const env = { ...process.env };
  assert.equal((await runWithTimeout('exit 0', { cd: temp, env, timeout: 60 })).code, 0, 'a first run builds the job helper in the private TEMP');
  const { readdir } = await import('node:fs/promises');
  const dll = (await readdir(temp)).find((name) => /^review-preflight-job-.*\.dll$/.test(name));
  assert.ok(dll, 'the job helper DLL was built');
  await writeFile(path.join(temp, dll), 'not an assembly');
  const written = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return write(chunk, ...rest); };
  try {
    const r = await runWithTimeout('ping -n 30 127.0.0.1 >nul', { cd: temp, env, timeout: 3 });
    assert.equal(r.timedOut, true);
    // The killed wrapper's exit, which reads the job report, can come just after the timeout resolves the run.
    for (let i = 0; i < 50 && !/could not run in a job object/.test(written.join('')); i += 1) await new Promise((done) => setTimeout(done, 100));
  } finally {
    process.stderr.write = write;
  }
  assert.match(written.join(''), /could not run in a job object \(.+\); a process it started may still be running/);
});

test('Linux round linux-r2 F2 and F11: an --exec command stopped by its timeout or by a signal still stops what left its group, by run id', { skip: process.platform !== 'linux' }, async (t) => {
  const { EventEmitter } = await import('node:events');
  const temp = await mkdtemp(path.join(tmpdir(), 'preflight-escaped-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // A double fork: its parent exits at once, so the tree walk cannot reach it and only the run id finds it.
  const escaped = (file) => `(setsid sh -c 'echo $$ > ${file}; exec sleep 300' >/dev/null 2>&1 </dev/null &); sleep 60`;
  const waitFor = async (file) => { for (let i = 0; i < 100; i += 1) { const v = Number((await readFile(file, 'utf8').catch(() => '')).trim()); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`${file} was not written`); };
  const timedOut = await runWithTimeout(escaped(path.join(temp, 'a.pid')), { cd: temp, env: process.env, timeout: 2 });
  const a = await waitFor(path.join(temp, 'a.pid'));
  t.after(() => { try { process.kill(a, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(timedOut.leftoversStopped, [a], 'the timeout names what it stopped');
  for (let i = 0; i < 40 && alive(a); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(a), false, 'stopped after the timeout');
  const proc = new EventEmitter();
  const exits = [];
  const running = runWithTimeout(escaped(path.join(temp, 'b.pid')), { cd: temp, env: process.env, timeout: 0 }, { proc, exit: (c) => exits.push(c) });
  const b = await waitFor(path.join(temp, 'b.pid'));
  t.after(() => { try { process.kill(b, 'SIGKILL'); } catch { /* gone */ } });
  proc.emit('SIGTERM');
  await running;
  assert.deepEqual(exits, [143]);
  for (let i = 0; i < 40 && alive(b); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(b), false, 'stopped after a stop signal');
});

test('field feedback S2: the Codex seat tool probe names a tool the sandbox cannot start and why, with the host copy under the user profile', async () => {
  const runs = { python: { code: 1, text: 'windows sandbox failed: runner failed during SpawnChild: CreateProcessAsUserW failed: 2 (The system cannot find the file specified.) | cwd=C:\\t | cmd=python --version' }, rg: { code: 101, text: "\nthread 'main' (2) panicked at linux-sandbox/src/linux_run_main.rs:1602:5:" }, git: { code: 0, text: 'git version 2.43.0' } };
  // The profile check reads paths with this host's rules: a Windows path on Windows, a POSIX one elsewhere.
  const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
  const hosts = { python: path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.EXE'), rg: null, git: 'C:\\Program Files\\Git\\cmd\\git.EXE' };
  const result = await codexToolProbe('C:\\t', { tools: ['python', 'rg', 'git'], run: async (tool) => runs[tool], where: (tool) => hosts[tool] });
  assert.deepEqual(result.git, { ok: true });
  assert.equal(result.python.why, 'windows sandbox failed: runner failed during SpawnChild: CreateProcessAsUserW failed: 2 (The system cannot find the file specified.)', 'cut before the cwd/cmd tail');
  assert.match(result.rg.why, /panicked at linux-sandbox/);
  const warnings = toolProbeWarnings(result, { home, platform: 'win32' });
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /can run none of python, rg: it will review by reading files only, so expect fewer claims/);
  assert.equal(toolProbeWarnings({ python: result.python, git: result.git }, { home, platform: 'win32' }).length, 1, 'one missing tool gets no summary line');
  const outside = ['/x/a.log', '/x/b.log', '/x/c.log'];
  assert.match(outsideReadWarning(outside, { platform: 'win32' }), /names 3 path\(s\) outside the target \(\/x\/a\.log, \/x\/b\.log, \.\.\.\)/);
  assert.ok(outsideReadWarning(outside, { platform: 'linux' }));
  assert.equal(outsideReadWarning(outside, { platform: 'darwin' }), null, 'not seen on macOS');
  assert.equal(outsideReadWarning([], { platform: 'win32' }), null);
  assert.match(warnings[0], /cannot run python .*under the user profile \(.*AppData.*python\.EXE\), which the Windows sandbox account cannot start: install it for all users, or put a copy under Program Files on PATH \(the per-user one can stay first\), or run the tests in preflight --exec/);
  assert.match(warnings[1], /cannot run rg .*rg is not on this host's PATH either: install it, or run the tests in preflight --exec/);
  // Windows probes through PowerShell, the seat's own shell: started directly the sandbox fails on a program PowerShell can start.
  assert.deepEqual(sandboxArgs('python', 'win32'), ['sandbox', '--', 'powershell', '-NoProfile', '-Command', 'python --version']);
  assert.deepEqual(sandboxArgs('python3', 'linux'), ['sandbox', '--', 'python3', '--version']);
  assert.deepEqual(sandboxArgs('rg', 'darwin'), ['sandbox', '--', 'rg', '--version']);
  // A tool PowerShell cannot find: its "is not recognized" line is the reason, not the first line of the output.
  const missing = await codexToolProbe('C:\\t', { tools: ['rg'], run: async () => ({ code: 1, text: "At line:1 char:1\r\nrg : The term 'rg' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n+ rg --version" }), where: () => null });
  assert.match(missing.rg.why, /^rg : The term 'rg' is not recognized as the name of a cmdlet/);
  assert.equal(hostToolPath('tool', { env: { PATH: ['/a', '/b'].join(path.delimiter) }, platform: 'linux', exists: (p) => p === path.join('/b', 'tool') }), path.join('/b', 'tool'));
  assert.equal(hostToolPath('tool', { env: { PATH: '/a' }, platform: 'linux', exists: () => false }), null);
});

test('field run: copyTarget keeps the reviewed files byte for byte, leaves out ignored files, caches and links, and refuses over its limits', async (t) => {
  const { createHash } = await import('node:crypto');
  const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
  const make = async (dir) => {
    await mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
    await writeFile(path.join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
    await writeFile(path.join(dir, 'src', 'deep', 'bytes.bin'), Buffer.from([0x00, 0x80, 0xff, 0x0a, 0x0d]));
    await writeFile(path.join(dir, 'src', 'café.py'), 'print("é")\n');
    await mkdir(path.join(dir, '__pycache__'));
    await writeFile(path.join(dir, '__pycache__', 'x.cpython-311.pyc'), 'cache');
  };
  const kept = ['crlf.txt', 'src/deep/bytes.bin', 'src/café.py'];
  const root = await mkdtemp(path.join(tmpdir(), 'copy-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A plain folder: the drift check's list, so caches stay out.
  const plain = path.join(root, 'plain');
  await mkdir(plain);
  await make(plain);
  if (process.platform !== 'win32') await symlink(path.join(plain, 'crlf.txt'), path.join(plain, 'link.txt'));
  const plainCopy = path.join(root, 'plain-copy');
  const p = await copyTarget(plain, plainCopy);
  assert.equal(p.copied, true, p.reason);
  assert.equal(p.files, 3);
  for (const rel of kept) assert.equal(await sha(path.join(plainCopy, rel)), await sha(path.join(plain, rel)), rel);
  await assert.rejects(readFile(path.join(plainCopy, '__pycache__', 'x.cpython-311.pyc')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(plainCopy, 'link.txt')), { code: 'ENOENT' }, 'a link is never followed');
  // A git repository: tracked plus untracked files git does not ignore.
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await make(repo);
  await writeFile(path.join(repo, '.gitignore'), '__pycache__/\n.venv/\n');
  await mkdir(path.join(repo, '.venv'));
  await writeFile(path.join(repo, '.venv', 'python.exe'), 'not source');
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('add', 'crlf.txt', '.gitignore');
  git('commit', '-q', '-m', 'base');
  const repoCopy = path.join(root, 'repo-copy');
  const g = await copyTarget(repo, repoCopy);
  assert.equal(g.copied, true, g.reason);
  for (const rel of [...kept, '.gitignore']) assert.equal(await sha(path.join(repoCopy, rel)), await sha(path.join(repo, rel)), rel);
  await assert.rejects(readFile(path.join(repoCopy, '.venv', 'python.exe')), { code: 'ENOENT' }, 'an ignored file is not copied');
  await assert.rejects(readFile(path.join(repoCopy, '__pycache__', 'x.cpython-311.pyc')), { code: 'ENOENT' });
  // Over a limit nothing is created.
  const big = await copyTarget(plain, path.join(root, 'too-big'), { maxFiles: 2 });
  assert.equal(big.copied, false);
  assert.match(big.reason, /3 file\(s\).*over the 2-file/);
  await assert.rejects(readFile(path.join(root, 'too-big', 'crlf.txt')), { code: 'ENOENT' });
});

test('claudeProjectsWritable: a writable projects folder passes and keeps no probe file; a refused write names the folder before any paid call', async (t) => {
  const config = await mkdtemp(path.join(tmpdir(), 'preflight-claude-config-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: config };
  const ok = await claudeProjectsWritable(env);
  assert.deepEqual(ok, { ok: true, dir: path.join(config, 'projects') });
  assert.deepEqual(await (await import('node:fs/promises')).readdir(ok.dir), [], 'the probe file is removed');
  const denied = Object.assign(new Error('Access is denied'), { code: 'EPERM' });
  const refused = await claudeProjectsWritable(env, { writeFileFn: async () => { throw denied; } });
  assert.deepEqual(refused, { ok: false, dir: path.join(config, 'projects'), error: 'EPERM', refused: true });
  const other = await claudeProjectsWritable(env, { writeFileFn: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } });
  assert.deepEqual(other, { ok: false, dir: path.join(config, 'projects'), error: 'ENOSPC', refused: false }, 'another error also stops before the paid probe, but is not read as a sandbox refusal');
});
