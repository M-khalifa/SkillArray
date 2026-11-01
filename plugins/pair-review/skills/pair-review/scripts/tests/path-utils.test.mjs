import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gitConfigNoFsmonitor, comparablePath, copyEntry, decodeFileUrls, expandPathVars, expandWorkingFolderForms, probeFoldsCase, setFoldsCase, isInsidePath, realPath, entrySha256, entryKey, entryPath, gitNames, gitRepoFromProbe, linkSpellingOf, nameBytes, pathSpellingsOf, scrubDir, foldsCase, continuesName } from '../path-utils.mjs';
import { buildClaudeArgs } from '../claude-dispatch.mjs';
import { scanText } from '../blind-relabel.mjs';
import { computeSnapshotHash, runTier1, runTier2, runWithTimeout } from '../preflight.mjs';
import { setupIsolatedWorktree } from '../worktree-utils.mjs';
import { diffInventories, hashInventory } from '../snapshot-utils.mjs';

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A folder and a link to it; a junction needs no privilege on Windows and is a plain symlink elsewhere.
async function linkedFolder(t) {
  const root = await tempDir(t, 'path-utils-');
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  await fs.mkdir(real);
  await fs.symlink(real, link, 'junction');
  return { root, real, link };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
}

async function repository(t) {
  const dir = path.join(await tempDir(t, 'path-utils-repo-'), 'repo');
  await fs.mkdir(dir);
  git(dir, 'init', '-q');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('gitNames: a name that is not valid UTF-8 keeps its bytes for the file system; a valid one stays a plain string', () => {
  const bad = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const list = Buffer.concat([Buffer.from('a.txt\0café.txt\0', 'utf8'), Buffer.from('sub/', 'utf8'), bad, Buffer.from('\0dir/\0', 'utf8')]);
  const entries = gitNames(list);
  assert.deepEqual(entries.map((e) => e.raw === null), [true, true, false, true]);
  assert.equal(entries[1].text, 'café.txt');
  const p = entryPath('/r', entries[2]);
  assert.ok(Buffer.isBuffer(p), 'the invalid name is opened by its bytes');
  assert.ok(p.equals(Buffer.concat([Buffer.from(`/r${path.sep}sub/`), bad])));
  assert.equal(entryPath('/r', entries[0]), path.join('/r', 'a.txt'));
  assert.ok(nameBytes(entries[1]).equals(Buffer.from('café.txt', 'utf8')), 'a valid name hashes as the UTF-8 text it hashed as before');
  assert.ok(nameBytes(entries[2]).equals(Buffer.concat([Buffer.from('sub/'), bad])));
  assert.deepEqual(gitNames('x\0y\0').map((e) => e.text), ['x', 'y'], 'a string input still splits');
  // Two different invalid names decode to the same text; their keys stay apart, a valid name's key is its text.
  const twins = gitNames(Buffer.from([0x61, 0xff, 0, 0x61, 0xfe, 0]));
  assert.equal(twins[0].text, twins[1].text);
  assert.notEqual(entryKey(twins[0]), entryKey(twins[1]));
  assert.equal(entryKey(entries[1]), 'café.txt');
});

test('realPath and comparablePath see through a link, also for a path that does not exist yet', async (t) => {
  const { real, link } = await linkedFolder(t);
  assert.equal(realPath(path.join(link, 'not', 'yet')), path.join(realpathSync.native(real), 'not', 'yet'));
  assert.equal(comparablePath(link), comparablePath(real));
  assert.ok(isInsidePath(path.join(link, 'phase1', 'seat-A'), real));
  assert.ok(!isInsidePath(path.join(link, '..', 'other'), real));
  assert.ok(isInsidePath(path.join(real, 'phase1', 'B-findings.md'), link), 'a grant spelled through the link still covers the real folder');
});

test('a script started through a linked folder runs instead of exiting 0 with no output [slow]', async (t) => {
  const root = await tempDir(t, 'path-utils-main-');
  const link = path.join(root, 'scripts-link');
  await fs.symlink(SCRIPTS, link, 'junction');
  const r = spawnSync(process.execPath, [path.join(link, 'review-run.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});

test('gitRepoFromProbe: exit 0 is a repository unless git says "false", "not a git repository" is a plain folder, any other failure throws', () => {
  assert.equal(gitRepoFromProbe({ code: 0, stdout: 'true\n' }, 'x'), true);
  assert.equal(gitRepoFromProbe({ code: 0, stdout: '.git\n' }, 'x'), true, 'the --git-dir form');
  assert.equal(gitRepoFromProbe({ code: 0, stdout: 'false\n' }, 'x'), false, 'inside .git itself');
  assert.equal(gitRepoFromProbe({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }, 'x'), false);
  assert.throws(() => gitRepoFromProbe({ code: 128, stderr: "fatal: detected dubious ownership in repository at '/r'\n" }, '/r'), /git cannot open the repository at \/r \(exit 128\): fatal: detected dubious ownership/);
  // git's full message: the reason first, the safe.directory command last; both are kept.
  assert.throws(() => gitRepoFromProbe({ code: 128, stderr: "fatal: detected dubious ownership in repository at '/r'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /r\n" }, '/r'),
    /dubious ownership in repository at '\/r'; fix: git config --global --add safe\.directory \/r$/);
  // A warning git prints before the fatal line is not the reason.
  assert.throws(() => gitRepoFromProbe({ code: 128, stderr: "warning: unable to access '/h/.config/git/attributes'\nfatal: detected dubious ownership in repository at '/r'\n" }, '/r'),
    /\(exit 128\): fatal: detected dubious ownership/);
});

test('a repository git refuses to open (here a newer format version) fails preflight and the identity scan instead of being read as a plain folder [slow]', async (t) => {
  const repo = await repository(t);
  git(repo, 'config', 'core.repositoryformatversion', '99');
  await assert.rejects(computeSnapshotHash(repo).then(() => runTier1(repo)), /git cannot open the repository/);
  await assert.rejects(scanText('A line.\n', repo, []), /git cannot open the repository/);
});

test('a git diff that fails (a bad diff setting in the repository config) stops the snapshot hash instead of hashing empty output [slow]', async (t) => {
  const repo = await repository(t);
  git(repo, 'config', 'diff.algorithm', 'invalid-review-algorithm');
  await fs.writeFile(path.join(repo, 'a.txt'), 'dirty\n');
  await assert.rejects(computeSnapshotHash(repo), /git diff .* failed in .*\(exit \d+\)/);
  await assert.rejects(runTier1(repo), /failed in/);
});

test('a repository with no commits names git\'s "fatal:" reason and the likely cause, not git\'s usage text [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-utils-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x\n');
  await assert.rejects(runTier1(dir), (err) => /fatal: .*HEAD/.test(err.message) && /no commits yet/.test(err.message) && !/<command>/.test(err.message));
});

test('linkSpellingOf: a path under macOS /tmp, /var or /etc gets its /private spelling and back; other paths get none', () => {
  assert.equal(linkSpellingOf('/private/tmp/run x/a'), '/tmp/run x/a');
  assert.equal(linkSpellingOf('/private/var/folders/q/T/run'), '/var/folders/q/T/run');
  assert.equal(linkSpellingOf('/tmp/run'), '/private/tmp/run');
  assert.equal(linkSpellingOf('/var'), '/private/var');
  for (const other of ['/private/tmpx/a', '/tmpdir/a', '/Users/me/tmp', '/private/home/a', 'C:\\tmp\\a']) assert.equal(linkSpellingOf(other), null, other);
});

test('identity scan and auditor guard on macOS: a run folder given as /private/tmp/... is also known as /tmp/... [darwin only]', { skip: process.platform !== 'darwin' }, async (t) => {
  const run = path.join(realpathSync('/tmp'), `path-utils-link-${process.pid}`);
  await fs.mkdir(run, { recursive: true });
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  assert.ok(pathSpellingsOf(run).includes(run.replace(/^\/private/, '')), pathSpellingsOf(run).join(' '));
});

test('claude-dispatch grants the out folder under its typed and its real spelling', async (t) => {
  const { real, link } = await linkedFolder(t);
  const args = buildClaudeArgs({ model: 'm', outDir: path.join(link, 'out') });
  const rules = args.filter((a) => a.startsWith('Edit('));
  assert.equal(rules.length, pathSpellingsOf(path.join(link, 'out')).length, rules.join(' '));
  assert.ok(rules.length >= 2, rules.join(' '));
  const realOut = path.join(realpathSync.native(real), 'out');
  assert.ok(args.includes(realOut) && args.includes(path.join(link, 'out')), args.join(' '));
});

test('identity scan: a vendor word inside the target or temp folder path is not a leak, the same word in prose still is', async (t) => {
  const target = await tempDir(t, 'claude-sandbox-');
  const clean = await scanText(`The file ${path.join(target, 'f.py')} is wrong.\n`, target, []);
  assert.deepEqual(clean.identityHits, []);
  const leak = await scanText(`The Claude reviewer says ${path.join(target, 'f.py')} is wrong.\n`, target, []);
  assert.equal(leak.identityHits.length, 1);
  // Only a whole path part is hidden: a sibling folder that continues the name is still scanned.
  const sibling = await scanText('I am C:/review/OpenAI reviewer.\n', undefined, [], null, ['C:/review/Open']);
  assert.equal(sibling.selfIdHits.length, 1);
});

test('entrySha256 and copyEntry treat a dangling link as a link, not as its missing target', async (t) => {
  const { root, real, link } = await linkedFolder(t);
  await fs.rm(real, { recursive: true });
  const sha = await entrySha256(link);
  assert.match(sha, /^link:[0-9a-f]{64}$/, 'a link hash cannot equal the hash of a file whose bytes are the link text');
  const copy = path.join(root, 'copy');
  await copyEntry(link, copy);
  assert.equal(await fs.readlink(copy), await fs.readlink(link));
  assert.equal(await entrySha256(copy), sha);
});

test('identity scan: a citation of the run\'s evidence folder under a vendor-named parent is not a leak [slow]', async (t) => {
  const root = await tempDir(t, 'path-utils-scan-');
  // A separate temp folder for the child, so the temp-folder mask does not hide the run folder.
  const otherTemp = path.join(root, 'other-temp');
  const run = path.join(root, 'Claude Temp', 'run1');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(otherTemp);
  await fs.writeFile(path.join(run, 'phase1', 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const input = path.join(root, 'in.md');
  await fs.writeFile(input, `- Ran the suite with TEMP set to ${path.join(root, 'Claude Temp', 'run1-evidence', 'tmp')}; 12 pass.\n`);
  const { runStep } = await import('../blind-relabel.mjs');
  const scan = async (...extra) => {
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    Object.assign(process.env, { TEMP: otherTemp, TMP: otherTemp, TMPDIR: otherTemp });
    try {
      return await runStep(['scan', '--in', input, ...extra]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  assert.notEqual((await scan()).code, 0, 'without the run folder the vendor word in the path is a hit');
  const r = await scan('--phase1-dir', path.join(run, 'phase1'), '--forbid-seats', 'B');
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('plain-folder inventory records a link, so retargeting it changes the snapshot hash', async (t) => {
  const root = await tempDir(t, 'path-utils-inv-');
  for (const [name, text] of [['one', 'first'], ['two', 'second']]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'f.txt'), text);
  }
  const link = path.join(root, 'current');
  await fs.symlink(path.join(root, 'one'), link, 'junction');
  const before = await hashInventory(root);
  assert.ok(Object.hasOwn(before.files, 'current'), Object.keys(before.files).join(' '));
  await fs.rm(link, { recursive: false, force: true });
  await fs.symlink(path.join(root, 'two'), link, 'junction');
  const after = await hashInventory(root);
  assert.notEqual(after.snapshotHash, before.snapshotHash);
  assert.deepEqual(diffInventories(before.files, after.files), ['current']);
});

test('snapshot hash and worktree accept a dangling untracked symlink and recreate it [slow]', async (t) => {
  const repo = await repository(t);
  try {
    await fs.symlink('missing-target.txt', path.join(repo, 'dangling'), 'file');
  } catch (err) {
    t.skip(`cannot create a file symlink here: ${err.code}`);
    return;
  }
  assert.match(await entrySha256(path.join(repo, 'dangling')), /^link:[0-9a-f]{64}$/);
  assert.match(await computeSnapshotHash(repo), /^[0-9a-f]{64}$/);
  const worktree = path.join(path.dirname(repo), 'wt');
  const setup = await setupIsolatedWorktree(repo, worktree);
  assert.equal(setup.ok, true, setup.reason);
  assert.equal(await fs.readlink(path.join(worktree, 'dangling')), 'missing-target.txt');
});

test('worktree snapshot applies under a user git config with noprefix, forced colour and zero context lines [slow]', async (t) => {
  const repo = await repository(t);
  git(repo, 'config', 'diff.noprefix', 'true');
  git(repo, 'config', 'color.diff', 'always');
  git(repo, 'config', 'diff.context', '0');
  await fs.writeFile(path.join(repo, 'b.txt'), 'l1\nl2\nl3\nl4\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'b');
  await fs.writeFile(path.join(repo, 'b.txt'), 'l1\nl2 changed\nl3\nl4\n');
  await fs.writeFile(path.join(repo, 'a.txt'), 'two\n');
  const worktree = path.join(path.dirname(repo), 'wt');
  const setup = await setupIsolatedWorktree(repo, worktree);
  assert.equal(setup.ok, true, setup.reason);
  assert.equal((await fs.readFile(path.join(worktree, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'two\n');
  assert.equal((await fs.readFile(path.join(worktree, 'b.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'l1\nl2 changed\nl3\nl4\n');
});

test('worktree setup never deletes a markerless worktree of the same repository, which may hold uncommitted work [slow]', async (t) => {
  const repo = await repository(t);
  const dev = path.join(path.dirname(repo), 'dev');
  git(repo, 'worktree', 'add', '-q', '-b', 'dev', dev);
  t.after(() => { try { git(repo, 'worktree', 'remove', '--force', dev); } catch {} });
  await fs.writeFile(path.join(dev, 'precious-uncommitted.txt'), 'keep me\n');
  const setup = await setupIsolatedWorktree(repo, dev);
  assert.equal(setup.ok, false);
  assert.match(setup.reason, /no snapshot marker.*git worktree remove --force/s);
  assert.equal(await fs.readFile(path.join(dev, 'precious-uncommitted.txt'), 'utf8'), 'keep me\n');
});

test('worktree setup: a .snapshot-building FOLDER does not count as the dispatcher\'s own interrupted build [slow]', async (t) => {
  const repo = await repository(t);
  const wt = path.join(path.dirname(repo), 'wt');
  await fs.mkdir(wt);
  await fs.writeFile(path.join(wt, 'keep.txt'), 'keep me\n');
  await fs.mkdir(`${wt}.snapshot-building`);
  const setup = await setupIsolatedWorktree(repo, wt);
  assert.equal(setup.ok, false);
  assert.equal(await fs.readFile(path.join(wt, 'keep.txt'), 'utf8'), 'keep me\n');
});

test('worktree setup: a stale .snapshot-building file next to a folder that is not a detached worktree of the target does not let it be deleted [slow]', async (t) => {
  const repo = await repository(t);
  const wt = path.join(path.dirname(repo), 'wt');
  await fs.mkdir(wt);
  await fs.writeFile(path.join(wt, 'mine.txt'), 'keep me\n');
  await fs.writeFile(`${wt}.snapshot-building`, '');
  const setup = await setupIsolatedWorktree(repo, wt);
  assert.equal(setup.ok, false);
  assert.equal(await fs.readFile(path.join(wt, 'mine.txt'), 'utf8'), 'keep me\n');
});

test('worktree setup accepts a repository root given through a link [slow]', async (t) => {
  const repo = await repository(t);
  const link = path.join(path.dirname(repo), 'repo-link');
  await fs.symlink(repo, link, 'junction');
  const setup = await setupIsolatedWorktree(link, path.join(path.dirname(repo), 'wt'));
  assert.equal(setup.ok, true, setup.reason);
});

test('preflight tier 1 lists a changed file with a non-ASCII name as written', async (t) => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'café.txt'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'add');
  await fs.writeFile(path.join(repo, 'café.txt'), 'y\n');
  await fs.writeFile(path.join(repo, 'naïve.txt'), 'new\n');
  const tier1 = await runTier1(repo);
  assert.deepEqual([...tier1.changedFiles].sort(), ['café.txt', 'naïve.txt']);
});

test('preflight --exec: a stop signal to preflight kills the command and exits with 128 + n [slow]', { timeout: 30000 }, async () => {
  const proc = new EventEmitter();
  let exited;
  const done = new Promise((resolve) => { exited = resolve; });
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const run = runWithTimeout(command, { cd: process.cwd(), env: process.env, timeout: 60 }, { proc, exit: (code) => exited(code) });
  setTimeout(() => proc.emit('SIGINT'), 500);
  assert.equal(await done, 130);
  const result = await run;
  assert.notEqual(result.code, 0);
  assert.equal(proc.listenerCount('SIGINT'), 0, 'the handlers are removed once the command ended');
});

test('preflight --exec: a command that closes while a stop signal is being handled does not settle as finished', async () => {
  const proc = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: 4194301, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  const exits = [];
  const run = runWithTimeout('ignored', { cd: process.cwd(), env: process.env, timeout: 60 }, { spawnFn: () => child, proc, exit: (code) => exits.push(code) });
  proc.emit('SIGHUP');
  child.emit('close', 1);
  const result = await run;
  assert.deepEqual(exits, [129]);
  assert.equal(result.interrupted, true, 'settled by the stop, not by the close');
});

test('macOS round: preflight --exec does not wait for output a process outside the group holds open, and reports a stopped group', async (t) => {
  process.env.REVIEW_CLOSE_GRACE_MS = '200';
  t.after(() => { delete process.env.REVIEW_CLOSE_GRACE_MS; });
  const fake = () => {
    const stream = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
    return Object.assign(new EventEmitter(), { pid: 4194301, stdout: stream(), stderr: stream(), exitCode: null, signalCode: null });
  };
  const opts = (child, kill) => ({ spawnFn: () => child, platform: 'linux', proc: new EventEmitter(), exit: () => {}, kill });
  // The command exits; its output never closes (a setsid child holds it): settled after the grace, with the exit code.
  const held = fake();
  const started = Date.now();
  const run = runWithTimeout('ignored', { cd: process.cwd(), env: process.env, timeout: 60 }, opts(held, () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }));
  held.emit('exit', 0, null);
  const r = await run;
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.outputHeldOpen, true);
  assert.equal(r.leftoverGroupStopped, undefined, 'the group was already empty');
  assert.ok(held.stdout.destroyed && held.stderr.destroyed, 'the held streams are let go');
  assert.ok(Date.now() - started < 5000, 'not the 60 s timeout');
  // A timeout due during the grace does not turn a clean exit into a timeout, and kills nothing.
  process.env.REVIEW_CLOSE_GRACE_MS = '1500';
  const late = fake();
  const lateKills = [];
  const lateRun = runWithTimeout('ignored', { cd: process.cwd(), env: process.env, timeout: 1 }, { ...opts(late, (pid, sig) => { lateKills.push([pid, sig]); throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }) });
  late.emit('exit', 0, null);
  const lr = await lateRun;
  assert.deepEqual([lr.code, lr.timedOut, lr.outputHeldOpen], [0, false, true]);
  assert.deepEqual(lateKills, [[-4194301, 'SIGKILL']], 'only the group kill on exit, no timeout kill');
  process.env.REVIEW_CLOSE_GRACE_MS = '200';
  // A normal close: no flag. A group kill that reached something: leftoverGroupStopped.
  for (const [killThrows, expected] of [[true, undefined], [false, true]]) {
    const child = fake();
    const kills = [];
    const done = runWithTimeout('ignored', { cd: process.cwd(), env: process.env, timeout: 60 }, opts(child, (pid, sig) => { kills.push([pid, sig]); if (killThrows) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }));
    child.emit('exit', 0, null);
    child.emit('close', 0);
    const c = await done;
    assert.deepEqual(kills, [[-4194301, 'SIGKILL']]);
    assert.equal(c.outputHeldOpen, undefined);
    assert.equal(c.leftoverGroupStopped, expected);
  }
});

test('preflight --exec: Ctrl-C pressed again during the kill is caught and ignored, so preflight still waits for the kill', async () => {
  const proc = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: 4194301, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  const exits = [];
  const run = runWithTimeout('ignored', { cd: process.cwd(), env: process.env, timeout: 60 }, { spawnFn: () => child, proc, exit: (code) => exits.push(code) });
  proc.emit('SIGINT');
  assert.equal(proc.listenerCount('SIGINT'), 1, 'still caught while the kill runs');
  proc.emit('SIGINT');
  await run;
  assert.deepEqual(exits, [130]);
  assert.equal(proc.listenerCount('SIGINT'), 0, 'removed once preflight exits');
});

test('preflight --exec: after a stop signal no further --exec command starts before preflight exits [slow]', { timeout: 30000 }, async (t) => {
  const cd = await fs.mkdtemp(path.join(os.tmpdir(), 'tier2-stop-'));
  t.after(() => fs.rm(cd, { recursive: true, force: true }));
  const proc = new EventEmitter();
  let spawned = 0;
  const spawnFn = (...a) => { spawned += 1; if (spawned === 1) setTimeout(() => proc.emit('SIGHUP'), 500); return spawn(...a); };
  let atExit = null;
  const commands = [`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, `"${process.execPath}" -e ""`];
  await runTier2({ cd, commands, timeout: 60, envMode: 'inherit', envPassthrough: [] }, { spawnFn, proc, exit: (code) => { atExit ??= { code, spawned }; } });
  assert.deepEqual(atExit, { code: 129, spawned: 1 });
});

test('Linux round 2 F8: expandPathVars expands $VAR, ${VAR}, $env:VAR and %VAR%, and on Linux and macOS a backslash after it is a separator', () => {
  const env = { TEMP: '/tmp/u', TMPDIR: '/var/folders/x/T', HOME: '/home/u' };
  const posix = (t) => expandPathVars(t, { env, platform: 'linux' });
  assert.equal(posix('Log: %TEMP%\\reviews\\run1\\since.diff'), 'Log: /tmp/u/reviews/run1/since.diff');
  assert.equal(posix('Log: $env:TEMP\\reviews\\run1\\x.log'), 'Log: /tmp/u/reviews/run1/x.log');
  assert.equal(posix('Log: ${TMPDIR}/run1/x and $HOME/y'), 'Log: /var/folders/x/T/run1/x and /home/u/y');
  assert.equal(posix('Unset $UNSET_VAR/x and $HOMEBREW/x stay'), 'Unset $UNSET_VAR/x and $HOMEBREW/x stay');
  assert.equal(expandPathVars('%TEMP%\\run1\\x', { env: { TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp' }, platform: 'win32' }), 'C:\\Users\\u\\AppData\\Local\\Temp\\run1\\x');
  // Round 5 F2: PowerShell's ${env:X}, cmd's %HOMEDRIVE%%HOMEPATH% (and the $env: pair), %APPDATA%.
  const win = (t) => expandPathVars(t, { env: { USERPROFILE: 'C:\\Users\\u', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u', APPDATA: 'C:\\A' }, platform: 'win32' });
  for (const t of ['${env:USERPROFILE}\\run1\\x', '%HOMEDRIVE%%HOMEPATH%\\run1\\x', '$env:HOMEDRIVE$env:HOMEPATH\\run1\\x']) assert.equal(win(t), 'C:\\Users\\u\\run1\\x', t);
  assert.equal(win('%APPDATA%\\run1'), 'C:\\A\\run1');
  assert.equal(win('${env:NOPE}\\x and %HOMEDRIVE%\\x'), '${env:NOPE}\\x and %HOMEDRIVE%\\x');
  assert.equal(posix('${env:TEMP}\\run1\\x'), '/tmp/u/run1/x');
  // Round 7 F11: a folder with a space after the variable is converted whole; separate paths stay separate.
  assert.equal(posix('Log: %TEMP%\\run space\\phase1\\x.log for details'), 'Log: /tmp/u/run space/phase1/x.log for details');
  assert.equal(posix('Log: %TEMP%\\run1\\x and %TEMP%\\y'), 'Log: /tmp/u/run1/x and /tmp/u/y');
});

test('Run-folder guard matrix, Linux and macOS spellings: every variable form and a file:/// URL give the real run-folder path, with and without a space in its name', () => {
  const BS = String.fromCharCode(92);
  const env = { TEMP: '/tmp/u', TMP: '/tmp/u', TMPDIR: '/var/folders/x/T', HOME: '/home/u' };
  const failures = [];
  let rows = 0;
  for (const platform of ['linux', 'darwin']) {
    for (const name of ['run1', 'run space']) {
      const rel = [name, 'phase1', 'B-findings.md'];
      for (const v of ['TEMP', 'TMP', 'TMPDIR', 'HOME']) {
        const want = `Log: ${env[v]}/${rel.join('/')} for details.`;
        const forms = [`%${v}%${BS}${rel.join(BS)}`, `$env:${v}${BS}${rel.join(BS)}`, '$' + `{env:${v}}${BS}${rel.join(BS)}`,
          `$${v}/${rel.join('/')}`, '$' + `{${v}}/${rel.join('/')}`, `$${v}${BS}${rel.join(BS)}`, `%${v}%/${rel.join('/')}`];
        for (const form of forms) {
          rows++;
          const got = expandPathVars(`Log: ${form} for details.`, { env, platform });
          if (got !== want) failures.push(`${platform} ${form} -> ${got}`);
        }
      }
      for (const url of [`file:///tmp/u/${rel.join('/').replace(/ /g, '%20')}`, `file://localhost/tmp/u/${rel.join('/').replace(/ /g, '%20')}`]) {
        rows++;
        const got = expandPathVars(decodeFileUrls(`Log: ${url} for details.`), { env, platform });
        if (got !== `Log: /tmp/u/${rel.join('/')} for details.`) failures.push(`${platform} ${url} -> ${got}`);
      }
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${rows} rows failed`);
});

test('Linux round: scrubDir writes every spelling of the run folder as <run-dir> and leaves its siblings and parent alone', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  await fs.mkdir(run);
  const fwd = run.split(path.sep).join('/');
  const back = run.split('/').join('\\');
  const mixed = fwd.replace(/\/([^/]*)$/, '\\$1');
  const rows = [
    [`${run}${path.sep}phase1${path.sep}B.md`, `<run-dir>${path.sep}phase1${path.sep}B.md`],
    // Closing round 3: letter case counts only where the file system ignores it (on Linux it is another folder).
    [`refused (${run.toUpperCase()}${path.sep}x)`, foldsCase() ? `refused (<run-dir>${path.sep}x)` : `refused (${run.toUpperCase()}${path.sep}x)`],
    [`${fwd}é/x`, `${fwd}é/x`],
    [`${fwd}+1/x`, `${fwd}+1/x`],
    [`${fwd}@x`, `${fwd}@x`],
    [`${fwd}(2)/x`, `${fwd}(2)/x`],
    [`${fwd}/run.json`, '<run-dir>/run.json'],
    [`${back.replace(/\\/g, '\\\\')}\\\\run.json`, '<run-dir>\\\\run.json'],
    [`${mixed}/run.json`, '<run-dir>/run.json'],
    [`ended at ${fwd}.`, 'ended at <run-dir>.'],
    [`${fwd}-evidence/a.log`, `${fwd}-evidence/a.log`],
    [`${fwd}.bak/x`, `${fwd}.bak/x`],
    [`${fwd}ner/x`, `${fwd}ner/x`],
    [`data${fwd}/y`, `data${fwd}/y`],
    [`${root.split(path.sep).join('/')}/other`, `${root.split(path.sep).join('/')}/other`],
  ];
  if (process.platform === 'win32') rows.push([`/mnt/${fwd[0].toLowerCase()}${fwd.slice(2)}/x`, '<run-dir>/x'], [`/${fwd[0].toLowerCase()}${fwd.slice(2)}/x`, '<run-dir>/x']);
  const failures = rows.filter(([input, want]) => scrubDir(input, run).text !== want).map(([input, want]) => `${input} -> ${scrubDir(input, run).text} (want ${want})`);
  assert.deepEqual(failures, []);
  assert.equal(scrubDir(`${fwd}/a and ${fwd}/b`, run).count, 2);
});

test('closing round 4: a user-name variable inside a path expands to the one folder it stands for; USERPROFILE still wins over USER', () => {
  const env = { USERNAME: 'bob', USER: 'bob', USERPROFILE: 'C:\\Users\\bob', HOME: '/home/bob' };
  assert.equal(expandPathVars('C:\\Users\\%USERNAME%\\runs\\run\\x', { env, platform: 'win32' }), 'C:\\Users\\bob\\runs\\run\\x');
  assert.equal(expandPathVars('C:\\Users\\$env:USERNAME\\runs', { env, platform: 'win32' }), 'C:\\Users\\bob\\runs');
  assert.equal(expandPathVars('/home/$USER/runs/run/x', { env, platform: 'linux' }), '/home/bob/runs/run/x');
  assert.equal(expandPathVars('%USERPROFILE%\\x', { env, platform: 'win32' }), 'C:\\Users\\bob\\x');
  // Closing round 5 F6: each user-name variable falls back to the other where only one is set.
  const win = { USERNAME: 'bob' };
  for (const spelling of ['C:\\Users\\$USER\\runs', 'C:\\Users\\%USER%\\runs', 'C:\\Users\\$env:USER\\runs', 'C:\\Users\\${USER}\\runs']) {
    assert.equal(expandPathVars(spelling, { env: win, platform: 'win32' }), 'C:\\Users\\bob\\runs', spelling);
  }
  assert.equal(expandPathVars('/home/$USERNAME/runs', { env: { USER: 'bob' }, platform: 'linux' }), '/home/bob/runs');
  assert.equal(expandPathVars('/home/$USER/runs', { env: {}, platform: 'linux' }), '/home/$USER/runs');
});

test('decodeFileUrls decodes %XX inside a file URL only, an encoded drive colon included', () => {
  assert.equal(decodeFileUrls('C:\\x\\100%20done.txt and /home/u/50%25.log'), 'C:\\x\\100%20done.txt and /home/u/50%25.log');
  assert.equal(decodeFileUrls('see file:///C:/a%20b/c.txt, then 100%20.txt'), 'see C:/a b/c.txt, then 100%20.txt');
  assert.equal(decodeFileUrls('file:///c%3A/x/b.log'), 'c:/x/b.log');
  assert.equal(decodeFileUrls('`file:///home/u/a%20b.log`'), '`/home/u/a b.log`');
  assert.equal(decodeFileUrls('file:///bad%E0%A4'), '/bad%E0%A4');
});

test('closing round 4: the leak guard, the scrub and the packet rewrite agree on where a named run folder ends', async () => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const { rewritePaths } = await import('../build-recheck-packet.mjs');
  const run = path.join(os.tmpdir(), 'skillarray-boundary-none', 'run');
  const sibling = ['2', '-evidence', '.bak', '_old', 'é', '+1', '@x', '(2)', 'Ω'];
  const itself = ['', '/x', `${path.sep}x`, '.', '. Next', ' and', ':', ',', '"', ')', '#x', '=x', '.-x'];
  for (const [suffix, isSibling] of [...sibling.map((s) => [s, true]), ...itself.map((s) => [s, false])]) {
    const text = `see ${run}${suffix}`;
    assert.equal(continuesName(suffix), isSibling, `continuesName ${JSON.stringify(suffix)}`);
    assert.equal(runDirNamedIn(text, run) === null, isSibling, `leak guard ${JSON.stringify(suffix)}`);
    assert.equal(scrubDir(text, run).count === 0, isSibling, `scrub ${JSON.stringify(suffix)}`);
    assert.equal(rewritePaths(text, [[run, '/new']]) === text, isSibling, `rewrite ${JSON.stringify(suffix)}`);
  }
});

test('Linux round linux-r1 F2 (linux-r2 F3: another process\'s /proc/<pid>/cwd is its own folder, read through its link): working-folder forms start in the reader folder; a named home comes from the password file', () => {
  const homes = { root: '/root', alice: '/home/alice' };
  const homeOf = (u) => homes[u] ?? null;
  const base = '/srv/target';
  const cases = [
    ['$PWD/../run/x', '/srv/target/../run/x'], ['${PWD}/../run/x', '/srv/target/../run/x'], ['$env:PWD\\..\\run', '/srv/target\\..\\run'],
    ['/proc/self/cwd/../run', '/srv/target/../run'], ['/proc/thread-self/cwd/x', '/srv/target/x'], ['/proc/1234/cwd/x', '/proc/1234/cwd/x'],
    ['see ~root/run/x and ~alice/y', 'see /root/run/x and /home/alice/y'],
    ['$PWDX/a', '$PWDX/a'], ['/proc/self/cwdx/a', '/proc/self/cwdx/a'], ['~nobodyhere/a', '~nobodyhere/a'], ['a~root/b', 'a~root/b'], ['~/a', '~/a'],
  ];
  for (const [input, want] of cases) assert.equal(expandWorkingFolderForms(input, base, { homeOf }), want, input);
  assert.equal(expandWorkingFolderForms('$PWD/../run ~root/x', null, { homeOf }), '$PWD/../run /root/x', 'no reader folder: the working-folder forms stay');
});

test('Linux round linux-r1 F3: the run folder\'s own file system decides letter case once preflight probed it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-probe-'));
  t.after(async () => { setFoldsCase(null); await fs.rm(dir, { recursive: true, force: true }); });
  const folds = probeFoldsCase(path.join(dir, 'not', 'yet'));
  assert.equal(folds, process.platform === 'win32' || process.platform === 'darwin', 'the platform default file systems');
  assert.deepEqual(await fs.readdir(dir), [], 'the probe file is removed');
  const run = path.join(dir, 'Run');
  await fs.mkdir(run);
  const lower = `see ${run.toLowerCase()}${path.sep}x`;
  setFoldsCase(true);
  assert.equal(scrubDir(lower, run).count, 1, 'a folding run folder: another case is the same folder');
  assert.equal(comparablePath(run), comparablePath(run.toUpperCase()));
  setFoldsCase(false);
  assert.equal(scrubDir(lower, run).count, process.platform === 'win32' ? 1 : 0, 'Windows paths always fold; elsewhere a case-sensitive run folder does not');
  setFoldsCase(null);
  assert.equal(foldsCase(), process.platform === 'win32' || process.platform === 'darwin', 'no run value: the platform default');
});
test('git calls of these scripts turn off fsmonitor through GIT_CONFIG_COUNT on git 2.36 or later, after any count already set', () => {
  const v = (s) => () => s;
  assert.deepEqual(gitConfigNoFsmonitor({}, v('git version 2.35.1')), {}, 'before 2.36 core.fsmonitor names a hook: left alone');
  assert.deepEqual(gitConfigNoFsmonitor({}, v('')), {}, 'no git: left alone');
  const env = gitConfigNoFsmonitor({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }, v('git version 2.52.0.windows.1'));
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'false');
  assert.equal(env.GIT_CONFIG_KEY_0, 'a.b', 'the existing entry is kept');
  assert.equal(gitConfigNoFsmonitor(env, v('git version 2.52.0')).GIT_CONFIG_COUNT, '2', 'a child that imports this again adds nothing');
});

test('a run folder stored decomposed (NFD) and quoted composed (NFC), or the other way, is the same folder: both spellings are rewritten', () => {
  // "Revue" + a combining acute accent: the decomposed form of "Revué".
  const nfd = path.join(os.tmpdir(), `Revue${String.fromCharCode(0x301)}-run`);
  const nfc = nfd.normalize('NFC');
  assert.notEqual(nfc, nfd, 'the two forms differ as strings');
  const spellings = pathSpellingsOf(nfd, { real: (p) => path.resolve(p) });
  assert.ok(spellings.includes(nfc) && spellings.includes(nfd));
  for (const quoted of [nfc, nfd]) {
    const out = scrubDir(`see ${path.join(quoted, 'phase1', 'x.md')}`, nfd);
    assert.equal(out.count, 1, quoted === nfc ? 'composed quote' : 'decomposed quote');
  }
});
