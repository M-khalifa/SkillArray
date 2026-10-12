import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnCli } from './spawn-utils.mjs';

function log(msg) {
  process.stderr.write(`relay: ${msg}\n`);
}

function runCapture(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawnCli(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCaptureBuffer(cmd, args, cwd, inputBuffer) {
  return new Promise((resolve) => {
    const child = spawnCli(cmd, args, { cwd });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
    if (inputBuffer !== undefined) {
      child.stdin.on('error', (err) => { log(`stdin write failed: ${err.message}`); });
      child.stdin.write(inputBuffer);
      child.stdin.end();
    }
  });
}

function snapshotMarkerPath(worktreeDir) {
  return `${worktreeDir}.snapshot-complete`;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizePath(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function computeSnapshotFingerprint(targetDir) {
  const toplevelRes = await runCapture('git', ['rev-parse', '--show-toplevel'], targetDir);
  if (toplevelRes.code !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed: ${toplevelRes.stderr.trim()}`);
  }
  const toplevel = toplevelRes.stdout.toString('utf8').trim();

  const headRes = await runCapture('git', ['rev-parse', 'HEAD'], targetDir);
  if (headRes.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${headRes.stderr.trim()}`);
  }
  const head = headRes.stdout.toString('utf8').trim();

  const diffRes = await runCaptureBuffer('git', ['diff', 'HEAD', '--binary'], targetDir);
  if (diffRes.code !== 0) {
    throw new Error(`git diff HEAD --binary failed: ${diffRes.stderr.trim()}`);
  }

  const untrackedRes = await runCapture(
    'git', ['ls-files', '--others', '--exclude-standard', '-z'], targetDir
  );
  if (untrackedRes.code !== 0) {
    throw new Error(`git ls-files --others failed: ${untrackedRes.stderr.trim()}`);
  }
  const rawUntracked = untrackedRes.stdout.split('\0').filter((p) => p.length > 0);
  const skippedDirs = rawUntracked.filter((p) => p.endsWith('/'));
  const untrackedPaths = rawUntracked.filter((p) => !p.endsWith('/'));

  const untracked = [];
  for (const rel of untrackedPaths.sort()) {
    const sha = await sha256OfFile(path.join(targetDir, rel));
    untracked.push({ path: rel, sha });
  }

  return {
    toplevel: process.platform === 'win32' ? toplevel.toLowerCase() : toplevel,
    head,
    diffSha: sha256(diffRes.stdout),
    diffBuffer: diffRes.stdout,
    untracked,
    skippedDirs: skippedDirs.sort(),
  };
}

function fingerprintsMatch(a, b) {
  try {
    if (a.toplevel !== b.toplevel || a.head !== b.head || a.diffSha !== b.diffSha) return false;
    if (a.skippedDirs.length !== b.skippedDirs.length) return false;
    if (a.skippedDirs.some((d, i) => d !== b.skippedDirs[i])) return false;
    if (a.untracked.length !== b.untracked.length) return false;
    for (let i = 0; i < a.untracked.length; i++) {
      if (a.untracked[i].path !== b.untracked[i].path || a.untracked[i].sha !== b.untracked[i].sha) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function setupRootWorktree(targetDir, worktreeDir) {
  const markerPath = snapshotMarkerPath(worktreeDir);

  let currentFingerprint;
  try {
    currentFingerprint = await computeSnapshotFingerprint(targetDir);
  } catch (err) {
    return { ok: false, reason: `snapshot fingerprint failed: ${err.message}` };
  }

  if (normalizePath(currentFingerprint.toplevel) !== normalizePath(targetDir)) {
    return {
      ok: false,
      reason:
        `--cd "${targetDir}" is not the repository root (root is "${currentFingerprint.toplevel}"); ` +
        '--isolate requires --cd to be the repository root, subdirectories are not supported',
    };
  }

  // Gitlinks come from the index: `git submodule status` needs sh on PATH and fails without it.
  const stageRes = await runCapture('git', ['ls-files', '--stage', '-z'], targetDir);
  if (stageRes.code !== 0) {
    return { ok: false, reason: `git ls-files --stage failed: ${stageRes.stderr.trim()}` };
  }
  if (stageRes.stdout.split('\0').some((entry) => entry.startsWith('160000 '))) {
    return {
      ok: false,
      reason:
        `"${targetDir}" has one or more git submodules; --isolate does not populate submodule ` +
        'working trees inside the worktree copy, so an isolated seat would see empty submodule ' +
        'directories instead of their real content -- use --no-isolate to run against the target',
    };
  }

  let markerText = null;
  try {
    markerText = await fs.readFile(markerPath, 'utf8');
    await fs.access(path.join(worktreeDir, '.git'));
  } catch {
    markerText = null;
  }

  if (markerText !== null) {
    let existingMarker;
    try {
      existingMarker = JSON.parse(markerText);
    } catch {
      return {
        ok: false,
        reason:
          'the worktree at this path has an unreadable snapshot marker; refusing to guess ' +
          'whether it is safe to reuse or rebuild — remove it manually and restart the ' +
          'affected review passes per review-protocol.md',
      };
    }
    if (!fingerprintsMatch(existingMarker, currentFingerprint)) {
      return {
        ok: false,
        reason:
          'snapshot fingerprint mismatch: the worktree at this path was built from a different ' +
          'target or the target has drifted since (toplevel/head/diff/untracked-files changed); ' +
          'refusing to reuse or silently rebuild it — remove the stale worktree and restart the ' +
          'affected review passes per review-protocol.md',
      };
    }
    let currentWorktreeFingerprint;
    try {
      currentWorktreeFingerprint = await computeSnapshotFingerprint(worktreeDir);
    } catch (err) {
      return { ok: false, reason: `worktree snapshot fingerprint failed: ${err.message}` };
    }
    if (!fingerprintsMatch(existingMarker.worktree, currentWorktreeFingerprint)) {
      return {
        ok: false,
        reason:
          'worktree snapshot mismatch: the isolated worktree itself was modified after it was ' +
          'built (its source-repo fingerprint still matches, but its own tracked/untracked ' +
          'content does not) — refusing to reuse or silently rebuild it; remove the stale ' +
          'worktree and restart the affected review passes per review-protocol.md',
      };
    }
    return { ok: true, reused: true, skippedDirs: currentFingerprint.skippedDirs };
  }

  let worktreeDirEntries = null;
  try {
    worktreeDirEntries = await fs.readdir(worktreeDir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return {
        ok: false,
        reason: `the path "${worktreeDir}" exists but is not a directory (${err.code}); refusing to delete it — remove it manually if it is safe to reuse`,
      };
    }
    worktreeDirEntries = null; // doesn't exist: nothing to protect, proceed to build
  }
  if (worktreeDirEntries !== null && worktreeDirEntries.length > 0) {
    let gitdirTarget;
    try {
      gitdirTarget = await fs.readFile(path.join(worktreeDir, '.git'), 'utf8');
    } catch {
      return {
        ok: false,
        reason:
          `the path "${worktreeDir}" already contains content this dispatcher did not create ` +
          '(no marker, no worktree .git file) — refusing to delete it; remove it manually if it ' +
          'is safe to reuse',
      };
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(gitdirTarget);
    if (!m) {
      return {
        ok: false,
        reason:
          `the path "${worktreeDir}" has a ".git" file that is not a recognizable worktree ` +
          'gitdir pointer; refusing to delete it — remove it manually if it is safe to reuse',
      };
    }
    const commonDirRes = await runCapture(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], targetDir
    );
    const gitdirResolved = normalizePath(m[1]);
    const targetCommonDir = commonDirRes.code === 0 ? normalizePath(commonDirRes.stdout.trim()) : null;
    const belongsToTarget =
      targetCommonDir !== null &&
      (gitdirResolved === targetCommonDir || gitdirResolved.startsWith(targetCommonDir + path.sep));
    if (!belongsToTarget) {
      return {
        ok: false,
        reason:
          `the path "${worktreeDir}" is a git worktree of a DIFFERENT repository than the ` +
          'current target; refusing to delete it — this would destroy that repository\'s ' +
          'working copy and orphan its own .git/worktrees/ registration',
      };
    }
  }

  const cleanup = async () => {
    await runCapture('git', ['worktree', 'remove', '--force', worktreeDir], targetDir).catch(() => {});
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(markerPath, { force: true }).catch(() => {});
  };
  const fail = async (reason) => {
    await cleanup();
    return { ok: false, reason };
  };

  try {
    await cleanup();
    await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
    const addRes = await runCapture(
      'git', ['worktree', 'add', '--detach', worktreeDir, currentFingerprint.head], targetDir
    );
    if (addRes.code !== 0) {
      return fail(`git worktree add failed: ${addRes.stderr.trim()}`);
    }

    if (currentFingerprint.diffBuffer.length > 0) {
      const applyRes = await runCaptureBuffer(
        'git', ['apply', '--binary'], worktreeDir, currentFingerprint.diffBuffer
      );
      if (applyRes.code !== 0) {
        return fail(`git apply --binary failed in worktree: ${applyRes.stderr.trim()}`);
      }
    }

    for (const { path: rel } of currentFingerprint.untracked) {
      const src = path.join(targetDir, rel);
      const dest = path.join(worktreeDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }

    let worktreeFingerprint;
    try {
      worktreeFingerprint = await computeSnapshotFingerprint(worktreeDir);
    } catch (err) {
      return fail(`worktree snapshot fingerprint failed: ${err.message}`);
    }

    await fs.writeFile(markerPath, JSON.stringify({
      toplevel: currentFingerprint.toplevel,
      head: currentFingerprint.head,
      diffSha: currentFingerprint.diffSha,
      untracked: currentFingerprint.untracked,
      skippedDirs: currentFingerprint.skippedDirs,
      worktree: {
        toplevel: worktreeFingerprint.toplevel,
        head: worktreeFingerprint.head,
        diffSha: worktreeFingerprint.diffSha,
        untracked: worktreeFingerprint.untracked,
        skippedDirs: worktreeFingerprint.skippedDirs,
      },
    }));
    return { ok: true, reused: false, skippedDirs: currentFingerprint.skippedDirs };
  } catch (err) {
    return fail(`worktree setup failed: ${err.message}`);
  }
}

// Opt-in subdirectory seats snapshot the entire root, including drift outside their cwd.
async function setupIsolatedWorktree(targetDir, worktreeDir, { allowSubdir = false } = {}) {
  if (!allowSubdir) return setupRootWorktree(targetDir, worktreeDir);
  let root;
  try {
    root = await runCapture('git', ['rev-parse', '--show-toplevel'], targetDir);
  } catch (err) {
    return { ok: false, reason: 'snapshot fingerprint failed: ' + err.message };
  }
  if (root.code !== 0) return { ok: false, reason: 'snapshot fingerprint failed: git rev-parse --show-toplevel failed: ' + root.stderr.trim() };
  const rootDir = root.stdout.trim();
  const relative = path.relative(rootDir, path.resolve(targetDir));
  const setup = await setupRootWorktree(rootDir, worktreeDir);
  if (!setup.ok) return setup;
  const cwd = path.join(worktreeDir, relative);
  try {
    await fs.mkdir(cwd, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'worktree seat cwd setup failed: ' + err.message };
  }
  return { ...setup, cwd };
}

export { setupIsolatedWorktree, runCaptureBuffer };
