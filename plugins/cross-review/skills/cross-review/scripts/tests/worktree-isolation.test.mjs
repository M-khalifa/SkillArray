// setupIsolatedWorktree: the snapshot worktree a Claude CLI seat reviews (build, reuse, drift and refusal rules), and
// runCaptureBuffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupIsolatedWorktree, runCaptureBuffer } from '../worktree-utils.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const IS_WIN32 = process.platform === 'win32';

test('setupIsolatedWorktree: copies tracked modifications and untracked files into a fresh worktree, and reuses it on a second call [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-worktree-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], dir); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target); // deterministic bytes regardless of global git config
  await fs.writeFile(path.join(target, 'tracked.txt'), 'original\n');
  git(['add', 'tracked.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  // Dirty the working tree: a tracked modification and a brand-new untracked file.
  await fs.writeFile(path.join(target, 'tracked.txt'), 'modified\n');
  await fs.writeFile(path.join(target, 'untracked.txt'), 'new file\n');

  const worktreeDir = path.join(dir, 'worktree');
  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.reused, false);

  assert.equal(await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'modified\n');
  assert.equal(await fs.readFile(path.join(worktreeDir, 'untracked.txt'), 'utf8'), 'new file\n');

  // Reuse with the target unchanged: same fingerprint, worktree content untouched.
  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.reused, true);
  assert.equal(await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'modified\n');

  // Change the target further; a fingerprint mismatch must fail closed, never
  // silently reuse a stale worktree or silently rebuild over it.
  await fs.writeFile(path.join(target, 'tracked.txt'), 'changed again\n');
  const third = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(third.ok, false, 'drifted target must be refused, not silently reused or rebuilt');
  assert.match(third.reason, /snapshot fingerprint mismatch/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'modified\n',
    'a refused mismatch must leave the existing worktree exactly as it was'
  );

  // Phase 3 removes the worktree itself but not the sibling marker file. A
  // later run against the same run directory must rebuild, not report a
  // stale reuse against a worktree that no longer exists.
  git(['worktree', 'remove', '--force', worktreeDir], target);
  await fs.access(`${worktreeDir}.snapshot-complete`);
  const fourth = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(fourth.ok, true, fourth.reason);
  assert.equal(fourth.reused, false, 'a removed worktree must be rebuilt, not reported as reused');
  assert.equal(await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'changed again\n');

  // phase-3-scorecard.md's cleanup command, run against the target repo (not
  // the worktree) -- proves the -C form actually clears .git/worktrees/.
  git(['worktree', 'remove', '--force', worktreeDir], target);
  const worktreesDirAfterCleanup = path.join(target, '.git', 'worktrees');
  let remaining = [];
  try { remaining = await fs.readdir(worktreesDirAfterCleanup); } catch {}
  assert.deepEqual(remaining, [], '.git/worktrees/ must be empty after phase-3-scorecard.md\'s cleanup command');
});

test('setupIsolatedWorktree: a direct mutation inside the worktree itself is refused on reuse, even though the source repo never changed [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-worktree-mutation-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], dir); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, 'f.txt'), 'original\n');
  git(['add', 'f.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  const worktreeDir = path.join(dir, 'worktree');
  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.reused, false);

  // Mutate the WORKTREE directly, not the source repo -- exactly what a seat with no
  // CLI-enforced read-only sandbox could do. The source repo is untouched, so the source
  // fingerprint alone would still match.
  await fs.writeFile(path.join(worktreeDir, 'f.txt'), 'mutated\n');

  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, false, 'a mutated worktree must be refused, not silently reused');
  assert.match(second.reason, /worktree snapshot mismatch/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'f.txt'), 'utf8'), 'mutated\n',
    'a refused mismatch must leave the existing (mutated) worktree exactly as it was, never silently rebuilt over it'
  );
});

test('setupIsolatedWorktree: a gitignored file created directly inside the worktree is NOT detected as contamination (documented limitation, not a bug) [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-worktree-ignored-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], dir); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, '.gitignore'), 'tmp/\n');
  await fs.writeFile(path.join(target, 'f.txt'), 'original\n');
  git(['add', 'f.txt', '.gitignore'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  const worktreeDir = path.join(dir, 'worktree');
  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);

  // Create a gitignored file directly inside the worktree -- exactly what a seat's own test
  // suite would do (pytest __pycache__, node_modules, build caches). This is a documented,
  // deliberate exclusion (matches normal `git status` semantics for both source and worktree
  // self-fingerprints), not a gap this test is asserting should be fixed here.
  await fs.mkdir(path.join(worktreeDir, 'tmp'));
  await fs.writeFile(path.join(worktreeDir, 'tmp', 'poison.txt'), 'not tracked, not detected\n');

  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.reused, true, 'a gitignored addition inside the worktree does not block reuse -- documented residual limitation');
  await assert.doesNotReject(fs.access(path.join(worktreeDir, 'tmp', 'poison.txt')));
});

test('setupIsolatedWorktree: a marker from before worktree-fingerprinting existed (missing the "worktree" field) fails closed instead of being trusted [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-worktree-old-marker-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], dir); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, 'f.txt'), 'original\n');
  git(['add', 'f.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  const worktreeDir = path.join(dir, 'worktree');
  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);

  // Simulate a marker written by a pre-fingerprinting version: same source fields, no "worktree" key.
  const markerPath = `${worktreeDir}.snapshot-complete`;
  const oldShapeMarker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  delete oldShapeMarker.worktree;
  await fs.writeFile(markerPath, JSON.stringify(oldShapeMarker));

  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, false, 'a marker missing the worktree field must fail closed, not be trusted as a match');
  assert.match(second.reason, /worktree snapshot mismatch/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'f.txt'), 'utf8'), 'original\n',
    'a refused mismatch must leave the existing worktree exactly as it was'
  );
});

async function makeSimpleRepo(dir, name, sentinel) {
  const target = path.join(dir, name);
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, 'file.txt'), `${sentinel}\n`);
  git(['add', 'file.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);
  return target;
}

test('setupIsolatedWorktree: pointing a second, different repo at the same worktree path is refused, never served from the first repo\'s content [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-cross-repo-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'r1')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const r1 = await makeSimpleRepo(dir, 'r1', 'SECRET-OF-R1');
  const r2 = await makeSimpleRepo(dir, 'r2', 'SECRET-OF-R2');
  const worktreeDir = path.join(dir, 'worktree');

  const first = await setupIsolatedWorktree(r1, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  assert.equal(await fs.readFile(path.join(worktreeDir, 'file.txt'), 'utf8'), 'SECRET-OF-R1\n');

  const second = await setupIsolatedWorktree(r2, worktreeDir);
  assert.equal(second.ok, false, 'a different target repo at the same worktree path must be refused');
  assert.match(second.reason, /snapshot fingerprint mismatch/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'file.txt'), 'utf8'), 'SECRET-OF-R1\n',
    'the refused mismatch must not have touched the existing worktree content'
  );
});

test('setupIsolatedWorktree: editing the content of an already-untracked file is drift and is refused on reuse, even though the file list itself is unchanged [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-untracked-drift-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'target')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = await makeSimpleRepo(dir, 'target', 'tracked-original');
  await fs.writeFile(path.join(target, 'notes.txt'), 'first version\n');
  const worktreeDir = path.join(dir, 'worktree');

  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  assert.equal(await fs.readFile(path.join(worktreeDir, 'notes.txt'), 'utf8'), 'first version\n');

  // Same path, same tracked state, same untracked FILE -- but its content changed.
  await fs.writeFile(path.join(target, 'notes.txt'), 'edited version\n');
  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, false, 'an edited untracked file must count as drift even with an unchanged file list');
  assert.match(second.reason, /snapshot fingerprint mismatch/);
});

test('setupIsolatedWorktree: an unreadable/garbage snapshot marker fails closed instead of silently rebuilding over an existing worktree [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-garbage-marker-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'target')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = await makeSimpleRepo(dir, 'target', 'tracked-original');
  const worktreeDir = path.join(dir, 'worktree');

  const first = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(first.ok, true, first.reason);

  await fs.writeFile(`${worktreeDir}.snapshot-complete`, 'not json');
  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, false, 'a present but unparseable marker must be refused, never silently rebuilt over');
  assert.match(second.reason, /unreadable snapshot marker/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'file.txt'), 'utf8'), 'tracked-original\n',
    'the existing worktree must be left untouched, not silently rebuilt'
  );
});

test('setupIsolatedWorktree: an untracked nested git repository is skipped (not copied, never crashes) and reported in skippedDirs [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-nested-repo-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'target')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = await makeSimpleRepo(dir, 'target', 'tracked-original');
  await makeSimpleRepo(target, 'nested', 'nested-repo-content');
  const worktreeDir = path.join(dir, 'worktree');

  const result = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.skippedDirs, ['nested/']);
  await assert.rejects(
    fs.access(path.join(worktreeDir, 'nested')),
    'a nested untracked repo must not be copied into the worktree'
  );

  // Reuse must still work: the nested repo is part of the fingerprint (skippedDirs), unchanged.
  const second = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(second.ok, true, second.reason);
  assert.equal(second.reused, true);
});

test('setupIsolatedWorktree: a worktree removed by deleting its directory directly (scratchpad wipe before cleanup ran) leaves a stale .git/worktrees/ entry that "git worktree prune" clears [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-prune-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  await fs.writeFile(path.join(target, 'tracked.txt'), 'original\n');
  git(['add', 'tracked.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  const worktreeDir = path.join(dir, 'worktree');
  const setup = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(setup.ok, true, setup.reason);

  // Simulates the scratchpad (holding the worktree) being cleared before
  // phase-3-scorecard.md's cleanup command ran -- "git worktree remove" has
  // nothing left to target from this side.
  await fs.rm(worktreeDir, { recursive: true, force: true });
  const worktreesDir = path.join(target, '.git', 'worktrees');
  assert.deepEqual(await fs.readdir(worktreesDir), ['worktree'], 'the stale entry must still be registered');

  // mutation-test: N/A -- exercises git's own "worktree prune", not this repo's code.
  git(['worktree', 'prune'], target);
  let afterPrune = [];
  try { afterPrune = await fs.readdir(worktreesDir); } catch {}
  assert.deepEqual(afterPrune, [], 'worktree prune must clear the stale .git/worktrees/ entry');
});

test('setupIsolatedWorktree: reports failure without throwing when the target is not a git repo', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-nongit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  const result = await setupIsolatedWorktree(target, path.join(dir, 'worktree'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /snapshot fingerprint failed/);
});

test('setupIsolatedWorktree: a worktree left registered but never snapshotted is not silently treated as reused [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-poisoned-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], dir); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, 'tracked.txt'), 'original\n');
  git(['add', 'tracked.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);
  await fs.writeFile(path.join(target, 'tracked.txt'), 'modified\n');
  await fs.writeFile(path.join(target, 'untracked.txt'), 'new file\n');

  const worktreeDir = path.join(dir, 'worktree');

  // Interrupt after git worktree add (which checks out HEAD) but before any dirty-state copy; the
  // dispatcher's .snapshot-building file is still there, as an interrupted build leaves it.
  await fs.writeFile(`${worktreeDir}.snapshot-building`, '');
  git(['worktree', 'add', '--detach', worktreeDir, 'HEAD'], target);
  await fs.access(path.join(worktreeDir, '.git'));
  assert.equal(await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'original\n');
  await assert.rejects(fs.access(path.join(worktreeDir, 'untracked.txt')));

  const result = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(result.ok, true, result.reason);
  assert.equal(
    result.reused,
    false,
    'a worktree with no completed snapshot must be redone, not reported as reused'
  );
  assert.equal(await fs.readFile(path.join(worktreeDir, 'tracked.txt'), 'utf8'), 'modified\n');
  assert.equal(await fs.readFile(path.join(worktreeDir, 'untracked.txt'), 'utf8'), 'new file\n');
});

test('setupIsolatedWorktree: --cd pointing at a repository SUBDIRECTORY is refused with a clear reason, instead of silently building a corrupted worktree [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-subdir-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = await makeSimpleRepo(dir, 'target', 'root-file-content');
  const subdir = path.join(target, 'subdir');
  await fs.mkdir(subdir);
  await fs.writeFile(path.join(subdir, 'nested.txt'), 'nested\n');
  git(['add', 'subdir/nested.txt'], target);
  git(['commit', '-q', '-m', 'add subdir'], target);
  await fs.writeFile(path.join(subdir, 'untracked-in-subdir.txt'), 'x\n');

  const worktreeDir = path.join(dir, 'worktree');
  const result = await setupIsolatedWorktree(subdir, worktreeDir);
  assert.equal(result.ok, false, '--cd at a subdirectory must be refused, not silently isolated');
  assert.match(result.reason, /not the repository root/);
  await assert.rejects(fs.access(worktreeDir), 'no worktree should have been built for a refused subdirectory --cd');
});

test('setupIsolatedWorktree: an ordinary pre-existing directory with no marker and no worktree .git is refused, never destroyed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-userdata-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = await makeSimpleRepo(dir, 'target', 'tracked-original');
  const worktreeDir = path.join(dir, 'worktree');
  await fs.mkdir(worktreeDir);
  await fs.writeFile(path.join(worktreeDir, 'UNRELATED-USER-DATA.txt'), 'do not delete me');

  const result = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(result.ok, false, 'must refuse, not silently build a worktree over unrelated content');
  assert.match(result.reason, /already holds files and has no snapshot marker/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'UNRELATED-USER-DATA.txt'), 'utf8'),
    'do not delete me',
    'the unrelated directory must be left untouched'
  );
});

test('setupIsolatedWorktree: a worktree belonging to a DIFFERENT repo (marker deleted by hand) is refused rather than destroyed and rebuilt from the new target [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-crossrepo-nomark-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'repoA')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const repoA = await makeSimpleRepo(dir, 'repoA', 'SECRET-OF-REPOA');
  const repoB = await makeSimpleRepo(dir, 'repoB', 'SECRET-OF-REPOB');
  const worktreeDir = path.join(dir, 'worktree');

  const first = await setupIsolatedWorktree(repoA, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  assert.equal(await fs.readFile(path.join(worktreeDir, 'file.txt'), 'utf8'), 'SECRET-OF-REPOA\n');

  // Simulate the marker being deleted by hand (or lost before the crash-write completed),
  // leaving a worktree that still legitimately belongs to repoA.
  await fs.rm(`${worktreeDir}.snapshot-complete`, { force: true });

  const second = await setupIsolatedWorktree(repoB, worktreeDir);
  assert.equal(second.ok, false, 'a worktree belonging to a different repo must be refused, not rebuilt');
  assert.match(second.reason, /already holds files and has no snapshot marker/);
  assert.equal(
    await fs.readFile(path.join(worktreeDir, 'file.txt'), 'utf8'), 'SECRET-OF-REPOA\n',
    'repoA\'s worktree content must survive untouched'
  );
  const repoAWorktrees = await fs.readdir(path.join(repoA, '.git', 'worktrees'));
  assert.deepEqual(repoAWorktrees, ['worktree'], 'repoA\'s own worktree registration must not be orphaned');
});

test('setupIsolatedWorktree: a plain FILE sitting at the worktree path is refused, never deleted as if it were an empty/missing directory', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-fileatpath-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = await makeSimpleRepo(dir, 'target', 'tracked-original');
  const worktreeDir = path.join(dir, 'worktree');
  await fs.writeFile(worktreeDir, 'not a directory, do not delete me');

  const result = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(result.ok, false, 'a plain file at the worktree path must never be silently rebuilt over');
  assert.match(result.reason, /is not a directory/);
  assert.equal(
    await fs.readFile(worktreeDir, 'utf8'),
    'not a directory, do not delete me',
    'the file must be left untouched'
  );
});

test('setupIsolatedWorktree: a worktree path that is merely a same-prefixed SIBLING of the target\'s git dir is refused, not misidentified as belonging to the target [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-prefix-sibling-'));
  t.after(async () => {
    try { git(['worktree', 'remove', '--force', path.join(dir, 'worktree')], path.join(dir, 'repo')); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });

  const repo = await makeSimpleRepo(dir, 'repo', 'SECRET-OF-REPO');
  const repoSuffixed = await makeSimpleRepo(dir, 'repo-old', 'SECRET-OF-REPO-OLD');
  const worktreeDir = path.join(dir, 'worktree');

  // Build a real worktree belonging to repo-old, whose .git-common-dir path is
  // <dir>/repo-old/.git -- a string-prefix (without separator) of <dir>/repo/.git would
  // never actually match here, but this guards the reverse-length case symmetrically.
  const first = await setupIsolatedWorktree(repoSuffixed, worktreeDir);
  assert.equal(first.ok, true, first.reason);
  await fs.rm(`${worktreeDir}.snapshot-complete`, { force: true });

  const second = await setupIsolatedWorktree(repo, worktreeDir);
  assert.equal(second.ok, false, 'must refuse a worktree belonging to a differently-named sibling repo');
  assert.match(second.reason, /already holds files and has no snapshot marker/);
});

test('setupIsolatedWorktree: B4 -- a target repo with a git submodule is refused outright, not silently worktree-copied with an empty submodule directory [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-submodule-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const subRepo = await makeSimpleRepo(dir, 'sub', 'SUBMODULE-CONTENT');
  const mainRepo = await makeSimpleRepo(dir, 'main', 'MAIN-CONTENT');
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepo, 'subdir'], mainRepo);
  git(['commit', '-q', '-m', 'add submodule'], mainRepo);

  const worktreeDir = path.join(dir, 'worktree');
  const result = await setupIsolatedWorktree(mainRepo, worktreeDir);
  assert.equal(result.ok, false, 'a submodule-containing repo must be refused, not silently isolated');
  assert.match(result.reason, /submodule/);
  await assert.rejects(fs.access(worktreeDir), 'no worktree should have been built at all');
});

test('setupIsolatedWorktree: an fs error during setup returns a structured failure, never throws [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolate-fserror-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  git(['init', '-q'], target);
  git(['config', 'user.email', 'test@example.com'], target);
  git(['config', 'user.name', 'Test'], target);
  git(['config', 'core.autocrlf', 'false'], target);
  await fs.writeFile(path.join(target, 'tracked.txt'), 'x\n');
  git(['add', 'tracked.txt'], target);
  git(['commit', '-q', '-m', 'initial'], target);

  // worktreeDir's parent is a plain file, so fs.mkdir(parent) throws before git worktree add runs.
  await fs.writeFile(path.join(dir, 'blocker'), '');
  const worktreeDir = path.join(dir, 'blocker', 'worktree');

  const result = await setupIsolatedWorktree(target, worktreeDir);
  assert.equal(result.ok, false);
  assert.match(result.reason, /worktree setup failed|is not a directory/);
  await assert.rejects(fs.access(`${worktreeDir}.snapshot-complete`));
});

test('runCaptureBuffer: a large stdin write to a process that exits before reading it resolves cleanly instead of crashing on an unhandled stdin error', async () => {
  const cmd = IS_WIN32 ? 'cmd' : 'true';
  const args = IS_WIN32 ? ['/c', 'exit', '0'] : [];
  const big = Buffer.alloc(20 * 1024 * 1024, 65);
  const result = await runCaptureBuffer(cmd, args, process.cwd(), big);
  assert.equal(typeof result.code, 'number');
});
