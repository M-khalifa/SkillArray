import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { comparablePath, copyEntry, isInsidePath, realPath, entrySha256, entryKey, entryPath, gitNames, nameBytes } from '../path-utils.mjs';
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
  assert.equal(realPath(path.join(link, 'not', 'yet')), path.join(realpathSync(real), 'not', 'yet'));
  assert.equal(comparablePath(link), comparablePath(real));
  assert.ok(isInsidePath(path.join(link, 'phase1', 'seat-A'), real));
  assert.ok(!isInsidePath(path.join(link, '..', 'other'), real));
  assert.ok(isInsidePath(path.join(real, 'phase1', 'B-findings.md'), link), 'a grant spelled through the link still covers the real folder');
});

test('a script started through a linked folder runs instead of exiting 0 with no output [slow]', async (t) => {
  const root = await tempDir(t, 'path-utils-main-');
  const link = path.join(root, 'scripts-link');
  await fs.symlink(SCRIPTS, link, 'junction');
  const r = spawnSync(process.execPath, [path.join(link, 'exchange.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});

test('claude-dispatch grants the out folder under its typed and its real spelling', async (t) => {
  const { real, link } = await linkedFolder(t);
  const args = buildClaudeArgs({ model: 'm', outDir: path.join(link, 'out') });
  const rules = args.filter((a) => a.startsWith('Edit('));
  assert.equal(rules.length, 2, rules.join(' '));
  const realOut = path.join(realpathSync(real), 'out');
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
  const env = { ...process.env, TEMP: otherTemp, TMP: otherTemp, TMPDIR: otherTemp };
  const scan = (...extra) => spawnSync(process.execPath, [path.join(SCRIPTS, 'blind-relabel.mjs'), 'scan', '--in', input, ...extra], { encoding: 'utf8', env });
  assert.notEqual(scan().status, 0, 'without the run folder the vendor word in the path is a hit');
  const r = scan('--phase1-dir', path.join(run, 'phase1'), '--forbid-seats', 'B');
  assert.equal(r.status, 0, r.stdout + r.stderr);
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
