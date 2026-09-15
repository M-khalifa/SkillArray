#!/usr/bin/env node
// Wraps `codex exec` for cross-review: sends a brief, captures the
// --json event stream, writes a structured result.json next to the brief.

// `exec resume` doesn't accept -s/--sandbox or -C/--cd, it reuses the resumed
// session's own sandbox and cwd. Prompt goes over stdin ("-"); finalMessage
// is the last item.completed agent_message seen.

// Non-goals: multi-provider routing, --clean-env/--keep-env, --resume-last, --out-dir.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// codex resolves to a .cmd shim on Windows; spawn needs shell:true to exec
// it (shell:false fails ENOENT/EINVAL against a .cmd path).
const NEEDS_SHELL = process.platform === 'win32';

// cmd.exe can break out of a quoted arg on an embedded `"`, `%VAR%` expansion,
// or trailing `\` (arg injection), so reject those instead of trying to escape them.
const WIN32_UNSAFE_CHARS = /["%]|\\$/;

function assertWin32Safe(arg, { platform = process.platform } = {}) {
  if (platform === 'win32' && WIN32_UNSAFE_CHARS.test(String(arg))) {
    throw new RelayError(
      `argument "${arg}" contains a character unsafe to pass through cmd.exe on Windows ` +
        `(a double quote, a percent sign, or a trailing backslash) — rename the path/value ` +
        `to avoid these characters`
    );
  }
  return arg;
}

function winQuote(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

// child.killed means the signal was sent, not that the process exited, so it
// never reflects whether SIGTERM actually worked; escalation must wait for
// the real 'exit' event instead. Killing the negative pid targets the whole
// process group (spawnCli sets detached:true on POSIX for this reason), not
// just the direct child, so a forked grandchild doesn't get orphaned.
function posixKillTree(child, { kill = (pid, sig) => process.kill(pid, sig), escalateMs = 5000 } = {}) {
  return new Promise((resolvePromise) => {
    if (!child.pid) { resolvePromise(); return; }
    let exited = false;
    child.once('exit', () => { exited = true; resolvePromise(); });
    const send = (sig) => {
      try { kill(-child.pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    };
    send('SIGTERM');
    setTimeout(() => {
      if (exited) return;
      send('SIGKILL');
      // Bound the wait even if the group ignores SIGKILL (e.g. already reaped).
      setTimeout(() => { if (!exited) resolvePromise(); }, 1000);
    }, escalateMs);
  });
}

// On win32, spawnCli runs the child under cmd.exe (shell:true), so child.pid is
// cmd.exe's PID and child.kill() only terminates cmd.exe; codex.exe behind the
// .cmd shim would be orphaned and keep running. taskkill /T kills the whole
// process tree.
function killTree(child) {
  if (NEEDS_SHELL) {
    // Absolute path, not "taskkill": a caller may have narrowed PATH down to
    // just the CLI it wants dispatched, and taskkill.exe would not resolve.
    const taskkillPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise((resolvePromise) => {
      const killer = spawn(taskkillPath, ['/pid', String(child.pid), '/T', '/F']);
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolvePromise(); } };
      killer.on('error', (err) => { log(`taskkill failed: ${err.message}`); finish(); });
      killer.on('close', finish);
      setTimeout(finish, 5000);
    });
  }
  return posixKillTree(child);
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

// spawnFn/platform are overridable so tests can assert the exact options passed to spawn() on
// a POSIX branch (detached:true, shell:false) without needing to actually run on POSIX.
function spawnCli(cmd, args, opts, { spawnFn = spawn, platform = process.platform } = {}) {
  const needsShell = platform === 'win32';
  if (needsShell) {
    for (const a of [cmd, ...args]) assertWin32Safe(a, { platform });
    const cmdLine = [winQuote(cmd), ...args.map(winQuote)].join(' ');
    return spawnFn(cmdLine, { ...opts, shell: true });
  }
  // detached:true puts the child in its own process group so posixKillTree
  // can kill(-pid) the whole group, not just the direct child.
  return spawnFn(cmd, args, { ...opts, shell: false, detached: true });
}

const USAGE = `codex-dispatch.mjs — dispatch a brief to Codex CLI ("codex exec") and capture the result as JSON.

Usage:
  node codex-dispatch.mjs --brief <path> --cd <path> [--session <threadId>]
                 [--sandbox <mode>] [--skip-git-repo-check] [--model <id>] [--effort <level>]
                 [--timeout <seconds>]

Required:
  --brief <path>         Path to a text file containing the prompt/brief to send to Codex.
  --cd <path>            Working directory to run "codex exec" in (the target repo), and the
                         directory the touchedFiles git snapshots are taken in. NOT forwarded
                         to "codex exec resume" (which reuses the original session's cwd), but
                         still REQUIRED on a resume and must be the SAME path Phase 1 used --
                         passing a different one audits the wrong directory.

Optional:
  --model <id>          Explicit model, forwarded on fresh and resumed runs.
  --effort <level>      model_reasoning_effort override, forwarded on both runs.
                         Omit to retain runtime default. Verify model support before dispatch;
                         this wrapper does not verify the effective runtime effort.
  --session <threadId>   Resume an existing Codex session/thread (codex exec resume
                         <threadId>) instead of starting a new one. NOTE: on the current
                         Codex CLI, "codex exec resume" does not accept --sandbox or --cd,
                         so those flags are not forwarded when --session is used.
  --sandbox <mode>       Sandbox policy passed to "codex exec -s/--sandbox". One of:
                         read-only, workspace-write, danger-full-access.
                         Default: read-only. Ignored when --session is given.
  --skip-git-repo-check  Pass through to codex exec as --skip-git-repo-check. Note:
                         codex-dispatch.mjs also auto-detects whether --cd is a git repo on
                         its own (for touchedFiles tracking), and forwards
                         --skip-git-repo-check to codex automatically whenever it
                         is not — so the run still proceeds even without this
                         flag. touchedFiles in result.json is null (with a
                         touchedFilesNote) whenever --cd is not a git repo,
                         regardless of this flag.
  --timeout <seconds>    Kill codex exec (whole process tree on win32, process group on POSIX)
                         if it hasn't closed within this
                         many seconds, and write status "timed-out" instead of "completed" or
                         "error". Omit for no limit (backward-compatible default).
  -h, --help             Print this message and exit 0.

Output:
  Writes <directory containing --brief>/result.json (atomic write via temp file + rename).
  result.json fields:
    threadId      string|null   Codex session/thread id, if one was observed.
    finalMessage  string        Last agent_message text observed in the event stream.
    touchedFiles  string[]|null List of paths changed/added/removed during the run,
                                 computed from a git status snapshot taken BEFORE the
                                 run and one taken AFTER the run. null (not []) when
                                 --cd is not a git repo, since an empty array would
                                 wrongly claim "confirmed nothing touched" instead of
                                 "unknown". Reliable against a clean baseline; may
                                 under-report a file that was already dirty before the
                                 run and was modified again during it (the before/after
                                 status line can be identical in that case).
    touchedFilesNote string     Present only when touchedFiles is null; explains why
                                 (not a git repo, or the git probe itself failed).
    modelRequested string|null  --model as passed, unverified against the actual runtime.
    effortRequested string|null --effort as passed, unverified against the actual runtime.
    modelResolved  null         Always null; the JSON event stream carries no verified
                                 effective model identity (see selectionNote).
    effortResolved null         Always null, same reason as modelResolved.
    selectionNote  string       States the modelResolved/effortResolved limitation above.
    isolated       false        Always false: Codex's read-only guarantee is its own
                                 --sandbox flag, not a worktree. Present so this shares a
                                 schema with opencode-dispatch.mjs's result.json.
    worktreePath   null         Always null, same reason as isolated.
    isolationNote  null         Always null, same reason as isolated.
    status        "completed"|"error"|"timed-out"
    error         string        Present when status is "error" or "timed-out"; failure reason.

  Session identity: on --session, the resumed run must emit a thread.started event whose
  thread_id equals the requested session. If it does not, the run fails closed with status
  "error" and one of: "session mismatch: requested ... but observed thread_id ..." or "resume
  requested session ... but no thread.started event was observed". A resume is never reported
  completed unless the correct session is confirmed. A THIRD error shape reaches this same
  status "error" without ever running that check: if --session names a thread codex itself
  doesn't recognize (mistyped, or wiped from local session storage), codex exec exits non-zero
  first with an error containing "no rollout found for thread id ..." (and no mention of the
  word "session" at all) -- treat any status:"error" here as a hard stop regardless of which of
  the three shapes it is.

Exit code: 0 on success, non-zero on failure (missing brief/--cd, codex not found or
not authenticated, codex exited non-zero, etc).
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
    effort: null,
    sandbox: 'read-only',
    skipGitRepoCheck: false,
    timeout: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
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
      case '--effort':
        args.effort = takeValue();
        break;
      case '--sandbox':
        args.sandbox = takeValue();
        break;
      case '--timeout':
        args.timeout = takeValue();
        break;
      case '--skip-git-repo-check':
        args.skipGitRepoCheck = true;
        break;
      case '--isolate':
        throw new RelayError(
          '--isolate is opencode-dispatch.mjs only; Codex has its own real read-only ' +
            'sandbox (--sandbox read-only) and does not need a disposable worktree'
        );
      default:
        throw new RelayError(`unrecognized argument: ${tok}`);
    }
  }
  if (!args.brief) throw new RelayError('--brief <path> is required');
  if (!args.cd) throw new RelayError('--cd <path> is required');
  const validSandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
  if (!validSandboxModes.includes(args.sandbox)) {
    throw new RelayError(
      `--sandbox must be one of ${validSandboxModes.join(', ')}, got "${args.sandbox}"`
    );
  }
  if (args.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(args.model)) {
    throw new RelayError('--model must be a model ID, not a shell expression');
  }
  if (args.effort !== null && (!/^[a-z][a-z0-9_-]*$/.test(args.effort) || args.effort === 'default')) {
    throw new RelayError('--effort must be a level token; omit it for default effort');
  }
  if (args.timeout !== null) {
    if (!/^[1-9][0-9]*$/.test(args.timeout)) {
      throw new RelayError('--timeout must be a positive whole number of seconds');
    }
    args.timeout = Number(args.timeout);
  }
  return args;
}

class RelayError extends Error {}

function log(msg) {
  process.stderr.write(`relay: ${msg}\n`);
}

// For the small git probes below; the codex exec run itself streams via spawn directly.
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

async function gitStatusPorcelain(cwd) {
  // -z gives NUL-delimited paths, never quoted/octal-escaped for spaces or non-ASCII bytes.
  const res = await runCapture('git', ['status', '--porcelain', '-z'], cwd);
  if (res.code !== 0) {
    throw new RelayError(`git status --porcelain -z failed in ${cwd}: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

// { code, paths } per record, paths has length 2 for rename/copy
// ([newPath, oldPath], two consecutive NUL-terminated -z fields), else 1.
// Structured, not joined-then-split, so a filename containing " -> " isn't
// misparsed as a rename.
function parsePorcelainRecords(porcelainZ) {
  const records = [];
  const fields = porcelainZ.split('\0').filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const code = field.slice(0, 2);
    const path = field.slice(3); // strip the 2-char status code + 1 space
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

// Keyed on code+paths, not just paths: a status-code-only change (" M" -> "MM")
// is still a real diff. NUL-joined since it's the one byte -z guarantees absent from a path.
function recordKey(record) {
  return record.code + '\0' + record.paths.join('\0');
}

// Reliable against a clean baseline; can under-report a path already dirty before
// the run and touched again (before/after status can be byte-identical).
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

// Spawns codex exec (fresh or resume), feeds the brief over stdin, parses the JSONL stream.
// forceSkipGitCheck: set when --cd isn't a git repo, so codex still runs
// without --skip-git-repo-check needing to be typed explicitly.
function buildCodexArgs({ cd, session, sandbox, skipGitRepoCheck, forceSkipGitCheck, model, effort }) {
  const args = ['exec'];
  if (session) {
    args.push('resume', session);
  } else {
    args.push('-C', cd, '-s', sandbox);
  }
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (skipGitRepoCheck || forceSkipGitCheck) args.push('--skip-git-repo-check');
  args.push('--json', '-');
  return args;
}

function runCodex(options) {
  const { briefText, cd, timeout } = options;
  return new Promise((resolve, reject) => {
    const args = buildCodexArgs(options);

    let child;
    try {
      child = spawnCli('codex', args, { cwd: cd });
    } catch (err) {
      reject(new RelayError(`failed to spawn "codex": ${err.message}`));
      return;
    }

    const uninstallSignalForwarding = installSignalForwarding(child);

    child.on('error', (err) => {
      uninstallSignalForwarding();
      reject(new RelayError(`failed to spawn "codex": ${err.message}`));
    });

    let threadId = null;
    let finalMessage = null;
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
          resolve({ code: null, threadId, finalMessage, stderr: stderrBuf, badLines, timedOut });
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
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        threadId = evt.thread_id;
      } else if (
        evt.type === 'item.completed' &&
        evt.item &&
        evt.item.type === 'agent_message' &&
        typeof evt.item.text === 'string'
      ) {
        finalMessage = evt.item.text;
      }
    });

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    // Without this, a codex process dying before it reads a large brief crashes the
    // whole script via an unhandled stdin error, skipping writeErrorResult() entirely.
    child.stdin.on('error', (err) => {
      log(`stdin write failed: ${err.message}`);
    });
    child.stdin.write(briefText);
    child.stdin.end();

    child.on('close', (code) => {
      uninstallSignalForwarding();
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      rl.close();
      resolve({ code, threadId, finalMessage, stderr: stderrBuf, badLines, timedOut });
    });
  });
}

// Fails closed rather than trusting whatever thread_id the child emits: a
// resume must echo back the exact requested id, or a caller can silently get
// a fresh, context-free session instead of the one it asked to resume.
function checkSessionIdentity({ session, observedThreadId }) {
  if (!observedThreadId) {
    return session
      ? `resume requested session "${session}" but no thread.started event was observed on the ` +
          `resumed run — cannot confirm the correct session actually continued`
      : `no thread.started event was observed on stdout — cannot confirm a session was started`;
  }
  if (session && observedThreadId !== session) {
    return (
      `session mismatch: requested "${session}" but observed thread_id "${observedThreadId}" — ` +
      `codex may have silently started a different session instead of resuming the requested one`
    );
  }
  return null; // confirmed: session identity is sound
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.result.json.tmp-${process.pid}`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, filePath);
}

// Every result.json write from either dispatcher carries these keys (plus its
// own session-id key: threadId here, sessionId in opencode-dispatch.mjs), so
// review-protocol.md's manifest fields always exist regardless of which
// runtime dispatched a seat. touchedFilesNote and error are conditional.
const RESULT_REQUIRED_KEYS = [
  'finalMessage', 'touchedFiles',
  'modelRequested', 'effortRequested', 'modelResolved', 'effortResolved', 'selectionNote',
  'isolated', 'worktreePath', 'isolationNote', 'status',
];

async function main() {
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

  const writeErrorResult = async (message) => {
    try {
      await atomicWriteJson(resultPath, {
        threadId: null,
        finalMessage: '',
        touchedFiles: null,
        touchedFilesNote: 'dispatch failed before touched-files tracking completed',
        modelRequested: args.model, effortRequested: args.effort,
        modelResolved: null, effortResolved: null,
        selectionNote: 'Requested flags are recorded; the JSON event stream does not verify effective model or effort.',
        isolated: false, worktreePath: null, isolationNote: null,
        status: 'error',
        error: message,
      });
    } catch (writeErr) {
      log(`additionally failed to write result.json: ${writeErr.message}`);
    }
  };

  let briefText;
  let cdAbs;
  try {
    cdAbs = path.resolve(args.cd);
    await checkCdExists(cdAbs);
    briefText = await readBrief(args.brief);
  } catch (err) {
    const msg = err instanceof RelayError ? err.message : String(err);
    log(msg);
    await writeErrorResult(msg);
    process.exit(1);
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

  let codexResult;
  try {
    codexResult = await runCodex({
      briefText,
      cd: cdAbs,
      session: args.session,
      model: args.model,
      effort: args.effort,
      sandbox: args.sandbox,
      skipGitRepoCheck: args.skipGitRepoCheck,
      forceSkipGitCheck: !gitTracked, // --cd already known not to be a git repo
      timeout: args.timeout,
    });
  } catch (err) {
    const msg = err instanceof RelayError ? err.message : String(err);
    log(msg);
    await writeErrorResult(msg);
    process.exit(1);
  }

  if (codexResult.badLines.length > 0) {
    log(
      `${codexResult.badLines.length} non-JSON line(s) on codex stdout were ignored ` +
        `(first: ${codexResult.badLines[0].slice(0, 200)})`
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
    threadId: codexResult.threadId, touchedFiles,
    modelRequested: args.model, effortRequested: args.effort,
    modelResolved: null, effortResolved: null,
    selectionNote: 'Requested flags are recorded; the JSON event stream does not verify effective model or effort.',
    // Codex's read-only guarantee is its own --sandbox flag, not a worktree;
    // these stay constant so both dispatchers' result.json feed the same manifest fields.
    isolated: false, worktreePath: null, isolationNote: null,
  };
  if (touchedFiles === null && touchedFilesNote) {
    baseFields.touchedFilesNote = touchedFilesNote;
  }

  if (codexResult.timedOut) {
    const msg = `codex exec killed after exceeding --timeout ${args.timeout}s`;
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: codexResult.finalMessage || '',
      status: 'timed-out',
      error: msg,
    });
    process.exit(1);
  }

  if (codexResult.code !== 0) {
    const msg =
      `codex exec exited with code ${codexResult.code}` +
      (codexResult.stderr.trim() ? `: ${codexResult.stderr.trim()}` : '');
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: codexResult.finalMessage || '',
      status: 'error',
      error: msg,
    });
    process.exit(1);
  }

  if (codexResult.finalMessage === null) {
    const msg = 'codex exec exited 0 but no agent_message event was observed on stdout';
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
    observedThreadId: codexResult.threadId,
  });
  if (identityError) {
    log(identityError);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: codexResult.finalMessage,
      status: 'error',
      error: identityError,
    });
    process.exit(1);
  }

  await atomicWriteJson(resultPath, {
    ...baseFields,
    finalMessage: codexResult.finalMessage,
    status: 'completed',
  });

  process.stdout.write(`relay: done. result written to ${resultPath}\n`);
  process.exit(0);
}

// Lets the test file import the pure functions below without triggering a live
// run. pathToFileURL, not string concat: a hand-built file:// URL is missing
// the third slash a Windows drive letter needs and silently never matches.
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
  buildCodexArgs,
  parsePorcelainRecords,
  parsePorcelainPaths,
  diffTouchedFiles,
  assertWin32Safe,
  winQuote,
  checkSessionIdentity,
  parseArgs,
  RelayError,
  posixKillTree,
  installSignalForwarding,
  RESULT_REQUIRED_KEYS,
  spawnCli,
};
