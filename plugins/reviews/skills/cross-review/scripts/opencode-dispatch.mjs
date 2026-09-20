#!/usr/bin/env node
// Wraps `opencode run` for cross-review: sends a brief, captures the
// --format json event stream, writes a structured result.json next to the brief.
//
// Modeled on codex-opus-review's codex-dispatch.mjs (same shape: parse args,
// git before/after snapshot, spawn, parse a JSONL event stream, atomic
// result.json write) but every vendor-specific mechanic below was verified
// against the real OpenCode CLI (v1.18.25, 2026-08-30) rather
// than assumed from Codex's behavior. Three real differences from Codex,
// each confirmed by running the actual CLI before writing this code:
//
//   1. `opencode run` takes its message as a POSITIONAL ARGUMENT, not stdin;
//      the CONTENT of a piped stdin is not read as the message. It does
//      still wait for stdin to reach EOF before proceeding, though (see the
//      OPENCODE_SPAWN_STDIO comment below, this is NOT "stdin is ignored").
//      A long brief passed positionally risks Windows's ~8191-char
//      command-line limit, so this script attaches the caller's own --brief
//      file with `-f` instead of inlining it (no copy is made; the file is
//      read once only to confirm it is readable). Verified working:
//      OpenCode reads the attached file's content and follows its
//      instructions, not the wrapper message text.
//   2. Session resume is `-s <sessionID>`, not a `resume` subcommand, and it
//      does NOT drop --dir the way Codex's `exec resume` drops --cd/--sandbox,
//      --dir is still meaningful and forwarded on resume. This has not
//      been exhaustively verified across every flag; treat any assumption
//      not stated here as unconfirmed.
//   3. The JSON event vocabulary is entirely different from Codex's
//      (thread.started/item.completed/agent_message): OpenCode emits
//      step_start / text / step_finish events, each carrying `sessionID`
//      directly on the top-level object, and the final agent text lives at
//      `part.text` on a `type: "text"` event's `part.type === "text"`.
//
// Non-goals (same spirit as codex-dispatch.mjs's non-goals list): multi-model
// routing beyond a single `-m`/`--model` and `--variant` pass-through, provider
// auth setup (run `opencode auth` yourself first; this script assumes it
// already works, same as codex-dispatch.mjs assumes `codex login` already
// succeeded).

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildChildEnv } from './env-filter.mjs';
import {
  assertWin32Safe,
  winQuote,
  posixKillTree,
  killTree as killTreeShared,
  spawnCli,
} from './spawn-utils.mjs';

// Provisional -- see the matching comment in codex-dispatch.mjs's parseArgs.
const DEFAULT_TIMEOUT_S = 1800;

// killTree wired to this file's own log() so a taskkill failure is reported
// with this dispatcher's own message prefix, matching pre-extraction behavior.
function killTree(child) {
  return killTreeShared(child, { log });
}

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// detached:true (for posixKillTree's group-kill) moves the child out of this
// process's controlling-terminal group, so Ctrl+C no longer reaches it
// directly; without this, an interrupted dispatcher orphans the reviewer.
function installSignalForwarding(child, { proc = process, killTreeFn = killTree, exit = (code) => process.exit(code) } = {}) {
  const handlers = {};
  for (const sig of Object.keys(SIGNAL_EXIT_CODE)) {
    handlers[sig] = () => {
      log(`received ${sig}, terminating reviewer process`);
      killTreeFn(child).finally(() => exit(SIGNAL_EXIT_CODE[sig]));
    };
    proc.once(sig, handlers[sig]);
  }
  return () => {
    for (const [sig, handler] of Object.entries(handlers)) proc.off(sig, handler);
  };
}

const USAGE = `opencode-dispatch.mjs — dispatch a brief to OpenCode CLI ("opencode run") and capture the result as JSON.

Usage:
  node opencode-dispatch.mjs --brief <path> --cd <path> [--session <sessionID>]
                 [--model <provider/model>] [--variant <level>] [--timeout <seconds>] [--isolate]
                 [--env-mode filtered|inherit] [--env-passthrough NAME,NAME]

Required:
  --brief <path>         Path to a text file containing the prompt/brief. Attached via
                         OpenCode's -f flag, NOT passed as the positional message — a long
                         brief passed positionally risks Windows's command-line length limit,
                         and the CONTENT of piped stdin is not read as the message by
                         "opencode run" (verified). It still waits for stdin EOF before
                         proceeding — this script's stdin is explicitly 'ignore'd for exactly
                         that reason (see OPENCODE_SPAWN_STDIO in the source).
  --cd <path>            Working directory ("opencode run --dir"). Forwarded on resume too —
                         unlike Codex's "exec resume", OpenCode's "-s" resume does not drop it
                         (see the file-header note; not exhaustively verified beyond this flag).

Optional:
  --session <sessionID>  Resume an existing OpenCode session ("opencode run -s <sessionID>")
                         instead of starting a new one.
  --model <spec>         Passed through to "opencode run -m <spec>", format "provider/model"
                         (e.g. "anthropic/claude-opus-5"). Omit to use OpenCode's own default.
  --variant <level>      Passed through to "opencode run --variant <level>" — OpenCode's name
                         for reasoning effort (e.g. high, max, minimal). Omit to use the
                         model's own default. "--effort" is accepted as an alias so the
                         orchestrator can pass one flag name to either dispatcher.
  --skip-git-repo-check  No-op here (OpenCode has no equivalent flag); accepted only so a
                         caller that always passes it for parity with codex-dispatch.mjs does
                         not need a vendor-specific branch.
  --timeout <seconds>    Kill opencode run (whole process tree on win32, process group on
                         POSIX) if it hasn't closed within this many seconds, and write
                         status "timed-out" instead of
                         "completed" or "error". 0 means unlimited (never times out). Default
                         when omitted: 1800 (30 minutes) -- a provisional value, not derived
                         from measured run durations; result.json's durationMs field exists
                         precisely so this default can be re-derived from real data.
  --env-mode <mode>      "filtered" (default) or "inherit". "filtered" passes the spawned
                         opencode process only a base OS allowlist and anything named in
                         --env-passthrough, excluding everything else in this process's
                         environment (AWS_*, GITHUB_TOKEN, database passwords, etc.) that the
                         REVIEWED repository's own code could otherwise read if opencode
                         executes a command against it. OpenCode's own credentials live in a
                         local database located via HOME/XDG_DATA_HOME, both already
                         allowlisted. "inherit" passes the full parent environment unfiltered,
                         matching pre-1.4.0 behavior.
  --env-passthrough <names>  Comma-separated extra environment variable names to allow through
                         under --env-mode filtered. Ignored under --env-mode inherit.
  --web                  Accepted for call-site parity with codex-dispatch.mjs, but NOT wired
                         to anything: "opencode run --help" has no web/search/fetch flag on
                         this CLI (confirmed), and OpenCode is never given web access as a
                         silent fallback through some other mechanism. result.json's
                         webAccess is always false for this dispatcher regardless of this
                         flag. A run that genuinely needs web verification for an OpenCode
                         seat has no supported path today; that gap is not solved by this flag.
  --isolate              Run OpenCode against a disposable git worktree of --cd instead of
                         --cd itself, since OpenCode has no --sandbox read-only equivalent
                         (see model-capabilities.md). The worktree is created once under
                         <directory containing --brief>/../worktree/ and REUSED when a later
                         --brief shares that same GRANDPARENT directory, not merely the same
                         parent -- e.g. <run-dir>/phase1/brief.txt and
                         <run-dir>/phase2/delta-brief.txt are siblings one level below
                         <run-dir>, and both resolve to <run-dir>/worktree. A --brief placed
                         directly in the run directory (no phaseN/ level) puts the worktree
                         in the run directory's PARENT instead, which is very likely wrong;
                         follow review-protocol.md's run-directory layout. Reuse is gated on a
                         fingerprint of --cd's current snapshot (repo toplevel, HEAD, dirty
                         diff, untracked file hashes), not merely on sharing the grandparent
                         directory: a fingerprint mismatch (a different target, or drift since
                         the worktree was built) is refused, never silently served stale or
                         rebuilt. This script never
                         removes the worktree or its sibling <worktree>.snapshot-complete
                         marker file; the caller (per phase-3-scorecard.md) runs
                         "git -C <target-dir> worktree remove --force <path>" (and deletes
                         the marker) once the run is fully done.
                         Requires --cd to be a git repository ROOT (a subdirectory is refused,
                         not supported) and worktree setup to succeed; if either fails, the
                         dispatcher exits non-zero with status "error" rather than falling back
                         to running against --cd directly.
  -h, --help             Print this message and exit 0.

Output:
  Writes <directory containing --brief>/result.json (atomic write via temp file + rename).
  result.json fields:
    sessionId     string|null   OpenCode session id, if one was observed.
    finalMessage  string        Last "text" event's part.text seen in the event stream.
    touchedFiles  string[]|null Same git-porcelain-diff mechanism as codex-dispatch.mjs.
                                 null (not []) when --cd is not a git repo. Under --isolate,
                                 this is measured against the worktree, so a nonempty value
                                 means OpenCode wrote into its own disposable copy, not --cd.
    touchedFilesNote string     Present only when touchedFiles is null; explains why.
    modelRequested string|null  --model as passed, unverified against the actual runtime.
    effortRequested string|null --variant (or its --effort alias) as passed, unverified.
    modelResolved  null         Always null; the JSON event stream carries no verified
                                 effective model identity (see selectionNote).
    effortResolved null         Always null, same reason as modelResolved.
    selectionNote  string       States the modelResolved/effortResolved limitation above.
    isolated      boolean       True when OpenCode actually ran against a worktree copy of
                                 --cd rather than --cd itself.
    worktreePath  string|null   The worktree's path when isolated is true; null otherwise.
    isolationNote string|null   Set when isolated is true: whether the worktree was reused or
                                 rebuilt, and any untracked nested-git-repo directories that were
                                 skipped rather than copied in. Always null when isolated is false.
    webAccess     false         Always false: OpenCode's CLI has no web/search/fetch flag to
                                 wire --web to. Present so this shares a schema with
                                 codex-dispatch.mjs's result.json.
    status        "completed"|"error"|"timed-out"
    error         string        Present when status is "error" or "timed-out"; failure reason.
    usage         object        {input_tokens, cached_input_tokens, cache_write_input_tokens,
                                 output_tokens, reasoning_tokens, estimated_cost_usd, source, raw}
                                 when OpenCode's own step_finish event was observed (source:
                                 "provider"), or {source: "unavailable"} otherwise. "raw" is the
                                 verbatim step_finish.part object (OpenCode's own field names
                                 differ from codex's/Claude's -- see the code comment on
                                 buildUsageField). estimated_cost_usd is always null even though
                                 OpenCode's own event carries a "cost" field: a live call using
                                 21,703 tokens reported cost:0, an unreliable signal for this
                                 provider -- see "raw" for OpenCode's own reported value instead.

Exit code: 0 on success, non-zero on failure (missing brief/--cd, opencode not found or
not authenticated, opencode exited non-zero, etc).
`;

function printUsageAndExit(code) {
  process.stdout.write(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    brief: null,
    cd: null,
    session: null,
    model: null,
    variant: null,
    skipGitRepoCheck: false,
    timeout: null,
    isolate: false,
    envMode: 'filtered',
    envPassthrough: [],
    web: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Same guard as codex-dispatch.mjs: a bare trailing --session (or one
    // followed by another flag) must error, not silently become a fresh run.
    const takeValue = () => {
      const value = argv[++i];
      if (!value || value.startsWith('-')) {
        throw new RelayError(`${tok} requires a value`);
      }
      return value;
    };
    switch (tok) {
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      case '--brief':
        args.brief = takeValue();
        break;
      case '--cd':
        args.cd = takeValue();
        break;
      case '--session':
        args.session = takeValue();
        break;
      case '--model':
        args.model = takeValue();
        break;
      case '--variant':
      case '--effort':
        args.variant = takeValue();
        break;
      case '--skip-git-repo-check':
        args.skipGitRepoCheck = true;
        break;
      case '--timeout':
        args.timeout = takeValue();
        break;
      case '--env-mode':
        args.envMode = takeValue();
        break;
      case '--env-passthrough':
        args.envPassthrough = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--isolate':
        args.isolate = true;
        break;
      case '--web':
        // Accepted, not wired: OpenCode's CLI surface has no web/search/fetch flag
        // at all (confirmed against "opencode run --help") -- this is never a
        // silent fallback to some other web mechanism. Recorded as-requested so
        // result.json's webAccess is always false for this dispatcher, matching
        // codex-dispatch.mjs's schema so a manifest reader never needs to
        // special-case which runtime a seat used.
        args.web = true;
        break;
      default:
        throw new RelayError(`unrecognized argument: ${tok}`);
    }
  }
  if (!args.brief) throw new RelayError('--brief <path> is required');
  if (!args.cd) throw new RelayError('--cd <path> is required');
  if (args.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(args.model)) {
    throw new RelayError('--model must be a model ID, not a shell expression');
  }
  if (args.variant !== null && !/^[a-z][a-z0-9_-]*$/.test(args.variant)) {
    throw new RelayError('--variant must be a level token; omit it for default effort');
  }
  if (args.timeout !== null) {
    if (!/^[0-9]+$/.test(args.timeout)) {
      throw new RelayError('--timeout must be a whole number of seconds, 0 for unlimited');
    }
    args.timeout = Number(args.timeout);
  } else {
    // Provisional default: see the matching comment in codex-dispatch.mjs.
    args.timeout = DEFAULT_TIMEOUT_S;
  }
  if (args.envMode !== 'filtered' && args.envMode !== 'inherit') {
    throw new RelayError('--env-mode must be "filtered" or "inherit"');
  }
  for (const name of args.envPassthrough) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RelayError(`--env-passthrough: "${name}" is not a valid environment variable name`);
    }
  }
  return args;
}

class RelayError extends Error {}

function log(msg) {
  process.stderr.write(`relay: ${msg}\n`);
}

// Same git-porcelain helpers as codex-dispatch.mjs, vendor-agnostic, reused verbatim.
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

async function isGitRepo(cwd) {
  const res = await runCapture('git', ['rev-parse', '--git-dir'], cwd);
  return res.code === 0;
}

// Buffer-based capture for binary-safe git output (a tracked-file diff can
// contain non-UTF8 bytes); runCapture above decodes as utf8 and would corrupt it.
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
      // Without this, a process dying before it reads a large buffer (e.g. git apply
      // rejecting a malformed patch) crashes the whole script via an unhandled stdin error.
      child.stdin.on('error', (err) => { log(`stdin write failed: ${err.message}`); });
      child.stdin.write(inputBuffer);
      child.stdin.end();
    }
  });
}

// Sibling of worktreeDir, not inside it: proves the snapshot copy finished, and never appears as an untracked file to the reviewer.
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

// Streamed so a large untracked file doesn't load whole into memory just to fingerprint it.
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Every field must match for reuse; untracked entries carry content hashes, and trailing-slash
// entries are nested repos (ls-files reports the directory, not its contents) that get skipped.
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

// A marker of unexpected shape (hand-edited, future schema) must read as a mismatch, not throw
// past setupIsolatedWorktree's never-throws contract.
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

// Mismatch fails closed without cleanup: on a cross-repo mismatch, cleanup would
// run `git worktree remove` against the wrong repo.
async function setupIsolatedWorktree(targetDir, worktreeDir) {
  const markerPath = snapshotMarkerPath(worktreeDir);

  let currentFingerprint;
  try {
    currentFingerprint = await computeSnapshotFingerprint(targetDir);
  } catch (err) {
    return { ok: false, reason: `snapshot fingerprint failed: ${err.message}` };
  }

  // git ls-files/diff run cwd-relative, so a targetDir below the repo root produces untracked
  // paths relative to targetDir while the worktree is built at the repo root -- silently wrong.
  if (normalizePath(currentFingerprint.toplevel) !== normalizePath(targetDir)) {
    return {
      ok: false,
      reason:
        `--cd "${targetDir}" is not the repository root (root is "${currentFingerprint.toplevel}"); ` +
        '--isolate requires --cd to be the repository root, subdirectories are not supported',
    };
  }

  // git worktree add links a submodule's gitlink but leaves its working tree empty
  // until a separate `submodule update` runs.
  const submoduleRes = await runCapture('git', ['submodule', 'status'], targetDir);
  if (submoduleRes.code === 0 && submoduleRes.stdout.trim().length > 0) {
    return {
      ok: false,
      reason:
        `"${targetDir}" has one or more git submodules; --isolate does not populate submodule ` +
        'working trees inside the worktree copy, so an isolated seat would see empty submodule ' +
        'directories instead of their real content -- not currently supported',
    };
  }

  let markerText = null;
  try {
    markerText = await fs.readFile(markerPath, 'utf8');
    await fs.access(path.join(worktreeDir, '.git'));
  } catch {
    markerText = null;
  }

  // A marker file is present (even if unparseable) but the worktree's .git is gone: the marker
  // is stale bookkeeping for a worktree that no longer exists, safe to clean up and rebuild.
  // A marker present AND the worktree still exists but the marker can't be parsed is different:
  // fail closed rather than silently rebuilding over content that might belong to another target.
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
    // Source fingerprint matching is not enough: OpenCode has no CLI-enforced read-only sandbox,
    // so the worktree ITSELF may have been directly mutated after it was built, independent of
    // any change to the source repo the worktree was built from. Recompute and compare the
    // worktree's own fingerprint too; a marker missing this field (old shape) fails closed via
    // fingerprintsMatch's try/catch, same as any other malformed marker.
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

  // No marker: only an orphaned worktree of targetDir itself (a deleted marker) is safe to
  // rebuild over. Anything else here -- unrelated content, another repo's worktree -- must refuse.
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
    // Belongs to targetDir itself: an orphaned worktree with a deleted marker, the legitimate
    // crash-recovery case. Falls through to cleanup() + rebuild below.
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

    // Tracked modifications: the SAME diff buffer just fingerprinted, applied inside the worktree,
    // so the marker records exactly what was applied, not a value recomputed moments later.
    if (currentFingerprint.diffBuffer.length > 0) {
      const applyRes = await runCaptureBuffer(
        'git', ['apply', '--binary'], worktreeDir, currentFingerprint.diffBuffer
      );
      if (applyRes.code !== 0) {
        return fail(`git apply --binary failed in worktree: ${applyRes.stderr.trim()}`);
      }
    }

    // Untracked files: git diff never sees these, so copy each one by hand. Directories that are
    // themselves git repos (currentFingerprint.skippedDirs) cannot be copied via copyFile and are
    // deliberately left out of the worktree; the caller sees them in the returned skippedDirs.
    for (const { path: rel } of currentFingerprint.untracked) {
      const src = path.join(targetDir, rel);
      const dest = path.join(worktreeDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }

    // Fingerprint the WORKTREE itself, not just its source, after it is fully built (tracked
    // diff applied, untracked files copied) so a direct mutation inside the worktree afterward
    // (OpenCode has no CLI-enforced read-only sandbox) is detectable on the next reuse attempt,
    // not just a change to the original source repository the worktree was built from.
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

async function gitStatusPorcelain(cwd) {
  const res = await runCapture('git', ['status', '--porcelain', '-z'], cwd);
  if (res.code !== 0) {
    throw new RelayError(`git status --porcelain -z failed in ${cwd}: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

function parsePorcelainRecords(porcelainZ) {
  const records = [];
  const fields = porcelainZ.split('\0').filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const code = field.slice(0, 2);
    const path = field.slice(3);
    const isRenameOrCopy = /^[RC]/.test(code[0]) || /^[RC]/.test(code[1]);
    if (isRenameOrCopy) {
      const oldPath = fields[++i] ?? '';
      records.push({ code, paths: [path, oldPath] });
    } else {
      records.push({ code, paths: [path] });
    }
  }
  return records;
}

function parsePorcelainPaths(record) {
  return new Set(record.paths);
}

function recordKey(record) {
  return record.code + '\0' + record.paths.join('\0');
}

function diffTouchedFiles(beforePorcelainZ, afterPorcelainZ) {
  const beforeRecords = parsePorcelainRecords(beforePorcelainZ);
  const afterRecords = parsePorcelainRecords(afterPorcelainZ);
  const beforeKeys = new Set(beforeRecords.map(recordKey));
  const afterKeys = new Set(afterRecords.map(recordKey));
  const changedRecords = [
    ...beforeRecords.filter((r) => !afterKeys.has(recordKey(r))),
    ...afterRecords.filter((r) => !beforeKeys.has(recordKey(r))),
  ];
  const result = new Set();
  for (const record of changedRecords) {
    for (const p of parsePorcelainPaths(record)) result.add(p);
  }
  return [...result].sort();
}

async function readBrief(briefPath) {
  try {
    return await fs.readFile(briefPath, 'utf8');
  } catch (err) {
    throw new RelayError(`could not read --brief file "${briefPath}": ${err.message}`);
  }
}

async function checkCdExists(cdPath) {
  try {
    const st = await fs.stat(cdPath);
    if (!st.isDirectory()) {
      throw new RelayError(`--cd "${cdPath}" exists but is not a directory`);
    }
  } catch (err) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(`--cd path "${cdPath}" not found: ${err.message}`);
  }
}

// Builds the argv for `opencode run` (fresh or resume), attaching the brief as
// a file (verified: OpenCode reads and follows an attached file's content).
//
// NOTE on stdin: OpenCode does not take the brief FROM stdin, but it does not
// ignore stdin either, it waits for EOF on it. See the stdio comment in
// runOpencode below; passing an open, never-ended stdin pipe hangs the run
// forever.
function buildOpencodeArgs({ briefPath, cd, session, model, variant }) {
  const args = ['run', 'Read the attached brief file and follow its instructions exactly.'];
  args.push('-f', briefPath);
  args.push('--dir', cd);
  if (session) args.push('-s', session);
  if (model) args.push('-m', model);
  if (variant) args.push('--variant', variant);
  args.push('--format', 'json');
  return args;
}

// stdin MUST be 'ignore', not the default 'pipe'. With a default (open,
// never-ended) stdin pipe, `opencode run` blocks forever and emits ZERO bytes
// on stdout, it's waiting on stdin EOF. Confirmed both directions: 'ignore'
// completes in ~29s exit 0, and an explicit child.stdin.end() immediately
// after spawn also completes (~28s), so the trigger is the missing EOF, not
// the pipe's existence.
//
// Extracted to its own constant (rather than inlined in the spawnCli call
// below) so a unit test can assert on it without spawning a live process;
// runOpencode's actual spawn behavior can't otherwise be exercised without a
// real `opencode` binary. See scripts/tests/opencode-dispatch.test.mjs.
const OPENCODE_SPAWN_STDIO = ['ignore', 'pipe', 'pipe'];

function runOpencode({ briefPath, cd, session, model, variant, timeout, envMode, envPassthrough }) {
  return new Promise((resolve, reject) => {
    const args = buildOpencodeArgs({ briefPath, cd, session, model, variant });
    // No providerAllowlist: OpenCode's own credentials resolve via
    // env-filter.mjs's already-allowlisted vars (XDG_DATA_HOME/HOME), unlike
    // codex's CODEX_HOME.
    const env = buildChildEnv({ envMode, envPassthrough });

    let child;
    try {
      child = spawnCli('opencode', args, { cwd: cd, stdio: OPENCODE_SPAWN_STDIO, env });
    } catch (err) {
      reject(new RelayError(`failed to spawn "opencode": ${err.message}`));
      return;
    }

    const uninstallSignalForwarding = installSignalForwarding(child);

    child.on('error', (err) => {
      uninstallSignalForwarding();
      reject(new RelayError(`failed to spawn "opencode": ${err.message}`));
    });

    let sessionId = null;
    let finalMessage = null;
    let tokens = null;
    let stderrBuf = '';
    let timedOut = false;
    let settled = false;
    const badLines = [];

    const rl = readline.createInterface({ input: child.stdout });

    let timer = null;
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // killTree can silently fail to reach the real process (a missing
        // taskkill, a process that ignores the signal). Resolve on a grace
        // period regardless, so --timeout always bounds wall-clock time
        // rather than only bounding it when the kill happens to work.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          rl.close();
          resolve({ code: null, sessionId, finalMessage, tokens, stderr: stderrBuf, badLines, timedOut });
        }, 5000);
      }, timeout * 1000);
    }

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        badLines.push(trimmed);
        return;
      }
      if (typeof evt.sessionID === 'string') {
        sessionId = evt.sessionID;
      }
      if (
        evt.type === 'text' &&
        evt.part &&
        evt.part.type === 'text' &&
        typeof evt.part.text === 'string'
      ) {
        // Verified: the LAST such event in the stream is OpenCode's actual
        // final response, matching how codex-dispatch.mjs takes the last
        // agent_message rather than the first.
        finalMessage = evt.part.text;
      } else if (
        evt.type === 'step_finish' &&
        evt.part &&
        evt.part.type === 'step-finish' &&
        evt.part.tokens
      ) {
        // Verified live (single-turn call): step_finish.part.tokens carries
        // {total, input, output, reasoning, cache:{write,read}} plus a
        // top-level cost. NOT verified whether tokens is cumulative across
        // multiple step_finish events in a multi-turn run or per-step only
        // -- the live call used to confirm this shape only had one turn.
        // Taking the LAST step_finish seen, same "last wins" rule as
        // finalMessage above; if a future multi-turn verification shows this
        // is per-step rather than cumulative, this must change to SUM across
        // events instead of overwrite.
        tokens = evt.part;
      }
    });

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    child.on('close', (code) => {
      uninstallSignalForwarding();
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      rl.close();
      resolve({ code, sessionId, finalMessage, tokens, stderr: stderrBuf, badLines, timedOut });
    });
  });
}

// Maps a step_finish.part event (or its absence) to result.json's "usage"
// field, with explicit provenance. Includes a "raw" copy of the observed
// part verbatim: OpenCode's cache vocabulary (cache.read/cache.write) differs
// from codex's (cached_input_tokens/cache_write_input_tokens) and from
// Claude's own JSON output (cache_read_input_tokens/cache_creation_input_tokens)
// -- three different CLIs, three different field names for conceptually the
// same thing. Rather than pick one normalized name and lose the others'
// exact original shape, this keeps the provider's own field names in "raw"
// alongside a normalized view, so no future rename question needs revisiting
// here. estimated_cost_usd stays null even when a "cost" field is present:
// a live call using 21,703 tokens reported cost:0, which is not a credible
// "this used no money" signal (likely subscription billing, or the field
// simply isn't populated for this provider/plan) -- treat OpenCode's own
// cost field as unreliable rather than propagate a bare 0 as ground truth.
function buildUsageField(rawPart) {
  if (!rawPart || !rawPart.tokens) {
    return { source: 'unavailable' };
  }
  const t = rawPart.tokens;
  return {
    input_tokens: t.input ?? null,
    cached_input_tokens: t.cache ? (t.cache.read ?? null) : null,
    cache_write_input_tokens: t.cache ? (t.cache.write ?? null) : null,
    output_tokens: t.output ?? null,
    reasoning_tokens: t.reasoning ?? null,
    estimated_cost_usd: null,
    source: 'provider',
    raw: rawPart,
  };
}

// Same fail-closed principle as codex-dispatch.mjs's checkSessionIdentity: a
// resume must echo back the exact requested sessionID.
function checkSessionIdentity({ session, observedSessionId }) {
  if (!observedSessionId) {
    return session
      ? `resume requested session "${session}" but no sessionID was observed on the resumed ` +
          `run — cannot confirm the correct session actually continued`
      : `no sessionID was observed on stdout — cannot confirm a session was started`;
  }
  if (session && observedSessionId !== session) {
    return (
      `session mismatch: requested "${session}" but observed sessionID "${observedSessionId}" — ` +
      `opencode may have silently started a different session instead of resuming the requested one`
    );
  }
  return null;
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.result.json.tmp-${process.pid}`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, filePath);
}

// Every result.json write from either dispatcher carries these keys (plus its
// own session-id key: sessionId here, threadId in codex-dispatch.mjs), so
// review-protocol.md's manifest fields always exist regardless of which
// runtime dispatched a seat. touchedFilesNote and error are conditional.
//
// startedAt/finishedAt/durationMs/timeoutS are stamped here, by this script,
// not authored by the orchestrator or any model -- deterministic code owns
// timing data. "usage" is populated from OpenCode's own step_finish.part.tokens
// event when one was observed (source: "provider", verified live), or
// {source: "unavailable"} otherwise. See buildUsageField() above and
// docs/design/structured-artifacts.md.
const RESULT_REQUIRED_KEYS = [
  'finalMessage', 'touchedFiles',
  'modelRequested', 'effortRequested', 'modelResolved', 'effortResolved', 'selectionNote',
  'isolated', 'worktreePath', 'isolationNote', 'status',
  'startedAt', 'finishedAt', 'durationMs', 'timeoutS',
  'usage',
  'envMode',
  'webAccess',
];

async function main() {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      process.stderr.write('\n' + USAGE);
      process.exit(2);
    }
    throw err;
  }

  const briefDir = path.dirname(path.resolve(args.brief));
  const resultPath = path.join(briefDir, 'result.json');
  const timingFields = (tokensObserved = null) => {
    const finishedAt = new Date().toISOString();
    return {
      startedAt, finishedAt, durationMs: Date.now() - startedAtMs,
      timeoutS: args.timeout,
      usage: buildUsageField(tokensObserved),
      envMode: args.envMode,
    };
  };

  // Declared before writeErrorResult so its closure reads the LIVE values: an
  // isolation failure after a successful worktree setup must still report
  // isolated/worktreePath truthfully, not a value hardcoded before isolation ran.
  let isolated = false;
  let worktreePath = null;
  let isolationNote = null;

  const writeErrorResult = async (message) => {
    try {
      await atomicWriteJson(resultPath, {
        sessionId: null,
        finalMessage: '',
        touchedFiles: null,
        touchedFilesNote: 'dispatch failed before touched-files tracking completed',
        modelRequested: args.model, effortRequested: args.variant,
        modelResolved: null, effortResolved: null,
        selectionNote: 'Requested flags are recorded; the JSON event stream does not verify effective model or effort.',
        isolated, worktreePath, isolationNote,
        webAccess: false,
        status: 'error',
        error: message,
        ...timingFields(),
      });
    } catch (writeErr) {
      log(`additionally failed to write result.json: ${writeErr.message}`);
    }
  };

  let briefAbsPath;
  let cdAbs;
  try {
    cdAbs = path.resolve(args.cd);
    await checkCdExists(cdAbs);
    await readBrief(args.brief); // just to confirm it's readable before spawning
    briefAbsPath = path.resolve(args.brief);
  } catch (err) {
    const msg = err instanceof RelayError ? err.message : String(err);
    log(msg);
    await writeErrorResult(msg);
    process.exit(1);
  }

  if (args.isolate) {
    const targetGitTracked = await isGitRepo(cdAbs);
    if (!targetGitTracked) {
      const msg = `--isolate requested but --cd "${cdAbs}" is not a git repository; refusing to run unisolated`;
      log(msg);
      await writeErrorResult(msg);
      process.exit(1);
    }
    const wt = path.join(briefDir, '..', 'worktree');
    const setup = await setupIsolatedWorktree(cdAbs, wt);
    if (!setup.ok) {
      const msg = `--isolate requested but worktree setup failed (${setup.reason}); refusing to run unisolated`;
      log(msg);
      await writeErrorResult(msg);
      process.exit(1);
    }
    isolated = true;
    worktreePath = wt;
    if (setup.skippedDirs && setup.skippedDirs.length > 0) {
      isolationNote =
        `reused=${setup.reused}; untracked director${setup.skippedDirs.length === 1 ? 'y' : 'ies'} ` +
        `not copied into the worktree (nested git repos cannot be snapshotted this way): ` +
        `${setup.skippedDirs.join(', ')}`;
      log(isolationNote);
    } else {
      isolationNote = `reused=${setup.reused}`;
    }
    cdAbs = wt;
  }

  let gitTracked = false;
  let beforeStatus = null;
  let touchedFilesNote;
  try {
    gitTracked = await isGitRepo(cdAbs);
    if (gitTracked) {
      beforeStatus = await gitStatusPorcelain(cdAbs);
    } else {
      touchedFilesNote = `--cd "${cdAbs}" is not a git repository; file changes cannot be tracked`;
      log(touchedFilesNote);
    }
  } catch (err) {
    gitTracked = false;
    touchedFilesNote = `git baseline capture failed, touchedFiles tracking disabled: ${err.message}`;
    log(touchedFilesNote);
  }

  let opencodeResult;
  try {
    opencodeResult = await runOpencode({
      briefPath: briefAbsPath,
      cd: cdAbs,
      session: args.session,
      model: args.model,
      variant: args.variant,
      timeout: args.timeout,
      envMode: args.envMode,
      envPassthrough: args.envPassthrough,
    });
  } catch (err) {
    const msg = err instanceof RelayError ? err.message : String(err);
    log(msg);
    await writeErrorResult(msg);
    process.exit(1);
  }

  if (opencodeResult.badLines.length > 0) {
    log(
      `${opencodeResult.badLines.length} non-JSON line(s) on opencode stdout were ignored ` +
        `(first: ${opencodeResult.badLines[0].slice(0, 200)})`
    );
  }

  let touchedFiles = null;
  if (gitTracked) {
    try {
      const afterStatus = await gitStatusPorcelain(cdAbs);
      touchedFiles = diffTouchedFiles(beforeStatus, afterStatus);
    } catch (err) {
      touchedFilesNote = `git after-run status failed, touchedFiles will be null: ${err.message}`;
      log(touchedFilesNote);
      touchedFiles = null;
    }
  }

  const baseFields = {
    sessionId: opencodeResult.sessionId, touchedFiles,
    modelRequested: args.model, effortRequested: args.variant,
    modelResolved: null, effortResolved: null,
    selectionNote: 'Requested flags are recorded; the JSON event stream does not verify effective model or effort.',
    isolated, worktreePath, isolationNote,
    webAccess: false,
    ...timingFields(opencodeResult.tokens),
  };
  if (touchedFiles === null && touchedFilesNote) {
    baseFields.touchedFilesNote = touchedFilesNote;
  }

  if (opencodeResult.timedOut) {
    const msg = `opencode run killed after exceeding --timeout ${args.timeout}s`;
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: opencodeResult.finalMessage || '',
      status: 'timed-out',
      error: msg,
    });
    process.exit(1);
  }

  if (opencodeResult.code !== 0) {
    const msg =
      `opencode run exited with code ${opencodeResult.code}` +
      (opencodeResult.stderr.trim() ? `: ${opencodeResult.stderr.trim()}` : '');
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: opencodeResult.finalMessage || '',
      status: 'error',
      error: msg,
    });
    process.exit(1);
  }

  if (opencodeResult.finalMessage === null) {
    const msg = 'opencode run exited 0 but no text event was observed on stdout';
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: '',
      status: 'error',
      error: msg,
    });
    process.exit(1);
  }

  const identityError = checkSessionIdentity({
    session: args.session,
    observedSessionId: opencodeResult.sessionId,
  });
  if (identityError) {
    log(identityError);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: opencodeResult.finalMessage,
      status: 'error',
      error: identityError,
    });
    process.exit(1);
  }

  await atomicWriteJson(resultPath, {
    ...baseFields,
    finalMessage: opencodeResult.finalMessage,
    status: 'completed',
  });

  process.stdout.write(`relay: done. result written to ${resultPath}\n`);
  process.exit(0);
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    log(`unexpected failure: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

export {
  parsePorcelainRecords,
  parsePorcelainPaths,
  diffTouchedFiles,
  assertWin32Safe,
  winQuote,
  buildOpencodeArgs,
  checkSessionIdentity,
  parseArgs,
  RelayError,
  OPENCODE_SPAWN_STDIO,
  setupIsolatedWorktree,
  posixKillTree,
  installSignalForwarding,
  RESULT_REQUIRED_KEYS,
  runCaptureBuffer,
  spawnCli,
  buildChildEnv,
  buildUsageField,
};
