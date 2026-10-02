#!/usr/bin/env node
// Wraps `codex exec` for cross-review: sends a brief, captures the
// --json event stream, writes a structured result.json next to the brief.

// `exec resume` doesn't accept -s/--sandbox or -C/--cd, it reuses the resumed
// session's own sandbox and cwd. Prompt goes over stdin ("-"); finalMessage
// is the last item.completed agent_message seen.

// Non-goals: multi-provider routing, --clean-env/--keep-env, --resume-last, --out-dir.

import { appendFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildChildEnv as buildChildEnvShared } from './env-filter.mjs';
import { hashInventory, diffInventories } from './snapshot-utils.mjs';
import {
  assertWin32Safe,
  winQuote,
  posixKillTree,
  killTree as killTreeShared,
  spawnCli,
  preserveEarlierResult,
  completedRunRefusal,
  writeFinalMessage,
} from './spawn-utils.mjs';

// Provisional -- see the --timeout default-assignment comment in parseArgs.
const DEFAULT_TIMEOUT_S = 1800;

// Observed from codex 0.156: "You've hit your usage limit. ... or try again at 10:51 AM."
const USAGE_LIMIT_RE = /\b(usage|rate) limit\b/i;
const RETRY_AT_RE = /\btry again (?:at|in) ([^.]+?)\.?\s*$/i;

// codex's own credential-locator variable (not a secret itself -- see
// env-filter.mjs's module comment for the threat model this addresses).
// Auth is file-based (~/.codex/auth.json, config.toml), read via HOME on
// POSIX and USERPROFILE on Windows, or this override.
const CODEX_ENV_ALLOWLIST = ['CODEX_HOME'];

// Thin wrapper over the shared filter: fixes in codex's own credential-locator
// allowlist so every call site here doesn't need to repeat it.
function buildChildEnv(opts) {
  return buildChildEnvShared({ ...opts, providerAllowlist: CODEX_ENV_ALLOWLIST });
}

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

const USAGE = `codex-dispatch.mjs — dispatch a brief to Codex CLI ("codex exec") and capture the result as JSON.

Usage:
  node codex-dispatch.mjs --brief <path> --cd <path> [--session <threadId>]
                 [--sandbox <mode>] [--skip-git-repo-check] [--model <id>] [--effort <level>]
                 [--timeout <seconds>] [--env-mode filtered|inherit] [--env-passthrough NAME,NAME]
                 [--web] [--previous-result <result.json>] [--detach] [--keep-user-extensions]
  node codex-dispatch.mjs --wait <result.json> [--max-wait <seconds>]
  node codex-dispatch.mjs --wait-retry <result.json> [--max-wait <seconds>]

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
                         flag. For a --cd that is not a git repo, touchedFiles
                         comes from a before/after content-hash inventory
                         instead (snapshot-utils.mjs), regardless of this flag.
  --timeout <seconds>    Kill codex exec (whole process tree on win32, process group on POSIX)
                         if it hasn't closed within this
                         many seconds, and write status "timed-out" instead of "completed" or
                         "error". 0 means unlimited (never times out). Default when omitted:
                         1800 (30 minutes) -- a provisional value, not derived from measured
                         run durations; result.json's durationMs field exists precisely so
                         this default can be re-derived from real data once runs accumulate.
  --env-mode <mode>      "filtered" (default) or "inherit". "filtered" passes the spawned
                         codex process only a base OS allowlist, codex's own credential-locator
                         variables (CODEX_HOME; auth itself is file-based under HOME/USERPROFILE,
                         also allowlisted), and anything named in --env-passthrough -- excluding
                         everything else in this process's environment (AWS_*, GITHUB_TOKEN,
                         database passwords, etc.) that the REVIEWED repository's own code could
                         otherwise read if codex executes a command against it. "inherit" passes
                         the full parent environment unfiltered.
  --env-passthrough <names>  Comma-separated extra environment variable names to allow through
                         under --env-mode filtered (e.g. a provider auth var this allowlist
                         doesn't already cover). Ignored under --env-mode inherit.
  Web record: with --web, result.json "webCalls" lists every web_search item codex reported:
                         {action, queries, url, resultUrls}. queries lists every query of
                         the call (one batched call can carry several; count queries, not
                         entries, against the web cap). resultUrls are the pages the search
                         returned (the seat saw their snippets); url is set when the action
                         opened a page. An empty list means no web search ran.
  Failed runs: result.json "error" starts with codex's own failure events ("codex reported:
                         ...", also listed in "codexErrors"); codex's MCP client log lines
                         ("rmcp::...") are left out of it unless nothing else explains the
                         failure. Any stderr is saved whole to result.stderr.log ("stderrLog").
                         An existing result.json (and result.stderr.log) in the brief's folder
                         is first renamed to result.attempt-<n>.*, so a retry never overwrites
                         earlier evidence.
  --previous-result <path>  On a --session resume, the result.json of the previous call on
                         the same thread; used only to compute usage_delta (this call's own
                         tokens). It never changes what codex runs.
  --final-message-out <path>  Also write finalMessage to this file (UTF-8, no BOM, exact
                         text), e.g. phase1/B-findings.md. Written only when status is
                         "completed"; on any other status an existing file there is left
                         as it was. result.json records the path as "finalMessageOut".
  --web                 Enable Codex's native live web search (the Responses API's
                         web_search tool) by passing --search to "codex". This flag is
                         GLOBAL on the codex CLI and must precede the "exec" subcommand
                         in argv (confirmed empirically: "codex exec --search" is
                         rejected as an unrecognized argument, but "codex --search exec"
                         works and was independently verified to produce real
                         "web search:" tool-call traces and genuinely fetched page
                         content, both on a fresh dispatch and on "exec resume"). Sets
                         result.json's webAccess to true; false when omitted.
  --detach               Start the dispatch as a separate worker process and return at once,
                         so a harness that stops long background shells (low memory) does not
                         stop Codex with it. On Windows the worker is started through WMI
                         (Win32_Process.Create): a plain detached child is still killed with
                         the shell's job there. result.json gets status "running" with
                         detached:true, workerPid and workerLog (dispatch-worker.log next to
                         the brief, where the worker writes what would go to stdout/stderr).
                         The worker keeps PATH and CODEX_HOME from this shell (in
                         dispatch-job.json); other --env-passthrough variables must be set for
                         the user, since the job file never stores them.
  --replace-completed    Run even though the --final-message-out file already exists. Without
                         it the dispatcher refuses (exit 2) before starting, so a duplicate
                         call never replaces a seat's finished answer.
  --keep-user-extensions Start the seat with the user's Codex sub-agents, plugins, apps and
                         skills catalog. By default every call (fresh and resumed) passes
                         -c agents.enabled=false, features.multi_agent=false,
                         features.plugins=false, features.apps=false,
                         features.skill_search=false and skills.max_context_tokens=1: a seat
                         is one reviewer, and a spawned agent's tokens are billed but never
                         appear in "usage" (one seat started a 3-level chain that used 6.2M
                         input tokens more than its result.json showed). The user's
                         config.toml still loads, so its sandbox settings keep working.
                         result.json "configOverrides" lists what was passed ([] with this flag).
                         "childThreads" lists every agent thread this call spawned, found in
                         CODEX_HOME/sessions ([] when none; null when the scan failed), each
                         with its own usage; a non-empty list is also printed as a WARNING.
  --wait <result.json>   Wait for a detached dispatch. Exit 0 when result.json says completed,
                         1 on any other final status or when the worker is gone while the file
                         still says running (it prints the threadId to resume), 3 when
                         --max-wait seconds pass first (default 540, under a 10-minute tool
                         limit; 0 waits without limit). It only reads files, so stopping and
                         rerunning it is always safe.
  --wait-retry <result.json>
                         Wait until a "rate-limited" call's retryAfter time (a clock time such
                         as "3:06 PM", this machine's local time), then exit 0 and print the
                         threadId to resume. Exit 3 when --max-wait passes first (default 540,
                         so a foreground call returns before a 10-minute tool limit; 0 waits
                         without limit, for a background shell),
                         2 when the status is not rate-limited or retryAfter is not a clock time.
  -h, --help             Print this message and exit 0.

Output:
  Writes <directory containing --brief>/result.json (atomic write via temp file + rename).
  result.json fields:
    threadId      string|null   Codex session/thread id, if one was observed.
    finalMessage  string        Last agent_message text observed in the event stream.
    touchedFiles  string[]|null List of paths changed/added/removed during the run,
                                 computed from a git status snapshot taken BEFORE the
                                 run and one taken AFTER the run; for a non-git --cd,
                                 from a before/after content hash of every file
                                 (skipping .git/ and node_modules/). null (not []) when
                                 either probe fails, since an empty array would
                                 wrongly claim "confirmed nothing touched" instead of
                                 "unknown". The git path may under-report a file that
                                 was already dirty before the run and was modified
                                 again during it (the before/after status line can be
                                 identical in that case); the inventory path does not.
    touchedFilesNote string     Present only when touchedFiles is null; explains why
                                 (a git or inventory probe failed).
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
    webAccess      boolean      true when --web was passed (codex was launched with the
                                 global --search flag ahead of "exec"), false otherwise.
                                 Records that the flag was requested, not that a search
                                 actually occurred during the run -- Phase 3's auditor
                                 reads this to decide whether a seat could have verified
                                 a URL-backed claim at all.
    status        "completed"|"error"|"timed-out"|"rate-limited"|"running".
                                 "rate-limited": codex reported a usage or rate limit; the
                                 thread is intact, so resume it (--session threadId) after
                                 "retryAfter" (codex's own text such as "10:51 AM", in that
                                 machine's local time, or null). Exit code is 1 as for an error.
                                 "running" is written as soon
                                 as codex reports its thread (threadId set, finishedAt null) and
                                 replaced when codex exits; a "running" file left behind means
                                 the dispatcher was killed, and its threadId can be resumed.
    error         string        Present when status is "error" or "timed-out"; failure reason.
    usage         object        {input_tokens, cached_input_tokens, cache_write_input_tokens,
                                 output_tokens, reasoning_tokens, estimated_cost_usd, source, raw}
                                 when codex's own turn.completed event was observed
                                 (source: "provider"), or {source: "unavailable"} otherwise
                                 (e.g. killed by --timeout before completion). Fields are
                                 recorded exactly as codex reports them -- cached_input_tokens
                                 is NOT assumed to be a subset of, or additive with,
                                 input_tokens; no derived/combined total is computed here.
                                 "raw" is codex's own turn.completed.usage object verbatim.
                                 estimated_cost_usd is always null: no price table is embedded
                                 in this dispatcher, cost is computed downstream from an
                                 explicit, versioned price file.
                                 usage is CUMULATIVE for the whole codex thread: a resumed
                                 call reports everything the thread has used so far.
    usage_delta   object        This call's own cost. A fresh thread: the same numbers as usage
                                 (source "fresh-thread"). A resume given --previous-result
                                 <that thread's last result.json>: usage minus that file's
                                 usage (source "delta-from-previous-result"). Otherwise
                                 {source: "unavailable", reason}.

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
    envMode: 'filtered',
    envPassthrough: [],
    web: false,
    userExtensions: false,
    replaceCompleted: false,
    previousResult: null,
    finalMessageOut: null,
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
      case '--previous-result':
        args.previousResult = takeValue();
        break;
      case '--final-message-out':
        args.finalMessageOut = takeValue();
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
      case '--env-mode':
        args.envMode = takeValue();
        break;
      case '--env-passthrough':
        args.envPassthrough = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--skip-git-repo-check':
        args.skipGitRepoCheck = true;
        break;
      case '--web':
        args.web = true;
        break;
      case '--detach':
        args.detach = true;
        break;
      case '--keep-user-extensions':
        args.userExtensions = true;
        break;
      case '--replace-completed':
        args.replaceCompleted = true;
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
    if (!/^[0-9]+$/.test(args.timeout)) {
      throw new RelayError('--timeout must be a whole number of seconds, 0 for unlimited');
    }
    args.timeout = Number(args.timeout);
  } else {
    // Provisional default: no manifest timing data exists yet from any real run
    // (this is exactly what Phase I's startedAt/finishedAt/durationMs fields are
    // for). 1800s (30 minutes) is a placeholder chosen for a code review against
    // a real repository at default effort, not derived from measured data.
    // Re-derive this once result.json durationMs data exists from real runs.
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

// For the small git probes below; the codex exec run itself streams via spawnCli too (see runCodex).
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
//
// --search is a GLOBAL codex flag, not an "exec" subcommand flag (confirmed:
// "codex exec --search" is rejected as an unrecognized argument; "codex
// --search exec ..." works). It must be the first element, ahead of "exec",
// on both the fresh and resume argv shapes -- pushing it anywhere after
// "exec" reproduces that rejection.
// A review seat is one reviewer: no spawned sub-agents (their tokens never reach this thread's
// usage), and none of the user's plugins, apps or skills catalog. Each key is in Codex's config
// reference; the user's config.toml still loads, so its sandbox settings keep working.
const SEAT_CONFIG_OVERRIDES = [
  'agents.enabled=false',
  'features.multi_agent=false',
  'features.plugins=false',
  'features.apps=false',
  'features.skill_search=false',
  'skills.max_context_tokens=1',
];

function buildCodexArgs({ cd, session, sandbox, skipGitRepoCheck, forceSkipGitCheck, model, effort, web, userExtensions = false }) {
  const args = [];
  if (web) args.push('--search');
  args.push('exec');
  if (session) {
    args.push('resume', session);
  } else {
    args.push('-C', cd, '-s', sandbox);
  }
  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (!userExtensions) for (const o of SEAT_CONFIG_OVERRIDES) args.push('-c', o);
  if (skipGitRepoCheck || forceSkipGitCheck) args.push('--skip-git-repo-check');
  args.push('--json', '-');
  return args;
}

function runCodex(options) {
  const { briefText, cd, timeout, envMode, envPassthrough } = options;
  return new Promise((resolve, reject) => {
    const args = buildCodexArgs(options);
    const env = buildChildEnv({ envMode, envPassthrough });

    let child;
    try {
      child = spawnCli('codex', args, { cwd: cd, env });
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
    let usage = null;
    let stderrBuf = '';
    let timedOut = false;
    let settled = false;
    const badLines = [];
    const codexErrors = [];
    const webCalls = [];

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
          resolve({ code: null, threadId, finalMessage, usage, stderr: stderrBuf, badLines, timedOut, codexErrors, webCalls });
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
        if (options.onThreadStarted) options.onThreadStarted(threadId);
      } else if (
        evt.type === 'item.completed' &&
        evt.item &&
        evt.item.type === 'agent_message' &&
        typeof evt.item.text === 'string'
      ) {
        finalMessage = evt.item.text;
      } else if (evt.type === 'turn.completed' && evt.usage && typeof evt.usage === 'object') {
        usage = evt.usage;
      } else if (evt.type === 'item.completed' && evt.item && evt.item.type === 'web_search') {
        // Shape observed from codex 0.156: {query, action: {type, query? | queries?, url?}, results: [{url, ...}]}.
        // A batched call lists every query in action.queries; its top-level query is a shortened "..." summary.
        const it = evt.item;
        const queries = Array.isArray(it.action?.queries)
          ? it.action.queries.filter((q) => typeof q === 'string' && q !== '')
          : [it.action?.query || it.query].filter((q) => typeof q === 'string' && q !== '');
        webCalls.push({
          action: it.action?.type ?? null,
          queries,
          url: it.action?.url ?? null,
          resultUrls: Array.isArray(it.results) ? it.results.map((r) => r?.url).filter((u) => typeof u === 'string') : [],
        });
      } else if (evt.type === 'error' || evt.type === 'turn.failed') {
        const text = describeCodexError(evt.type === 'error' ? evt.message : evt.error?.message);
        if (text && !codexErrors.includes(text)) codexErrors.push(text);
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
      resolve({ code, threadId, finalMessage, usage, stderr: stderrBuf, badLines, timedOut, codexErrors, webCalls });
    });
  });
}

// codex --json reports a failed turn on stdout ("error" / "turn.failed" events); its message is
// often the provider's JSON body, e.g. {"status":400,"error":{"message":"..."}}.
function describeCodexError(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const body = JSON.parse(raw);
    const inner = body?.error?.message;
    if (typeof inner === 'string') return `${body.status ? `HTTP ${body.status}: ` : ''}${inner}`;
  } catch {
    // Not JSON: the message is already plain text.
  }
  return raw.trim();
}

// Only codex's MCP client logger ("rmcp::..."); any other line that mentions MCP stays visible.
const MCP_STDERR_RE = /\brmcp::/;
const MAX_ERROR_STDERR_CHARS = 4000;

// The error field leads with codex's own failure events, then stderr without MCP connector lines
// (a broken connector, such as one with an expired key, can fill stderr and hide the real cause).
// The full stderr is in result.stderr.log (stderrLog), so nothing filtered here is lost.
function composeRunError(prefix, codexResult, stderrLog = null) {
  const parts = [prefix];
  if (codexResult.codexErrors?.length > 0) parts.push(`codex reported: ${codexResult.codexErrors.join(' | ')}`);
  const lines = codexResult.stderr.split(/\r?\n/).filter((l) => l.trim() !== '');
  const mcp = lines.filter((l) => MCP_STDERR_RE.test(l)).length;
  const clip = (s) => (s.length > MAX_ERROR_STDERR_CHARS ? `...${s.slice(-MAX_ERROR_STDERR_CHARS)}` : s);
  const rest = lines.filter((l) => !MCP_STDERR_RE.test(l)).join('\n');
  if (rest) parts.push(`stderr: ${clip(rest)}`);
  if (mcp > 0 && (rest || codexResult.codexErrors?.length > 0)) {
    parts.push(`(${mcp} stderr line(s) from MCP connectors not shown)`);
  } else if (mcp > 0) {
    // Nothing else to go on: show the connector lines rather than an empty error.
    parts.push(`stderr (MCP connector lines only): ${clip(lines.join('\n'))}`);
  }
  if (stderrLog) parts.push(`full stderr: ${stderrLog}`);
  return parts.join('\n');
}

// Maps the raw turn.completed.usage event (or its absence) to result.json's
// "usage" field, with explicit provenance. Never assumes a relationship
// between cached_input_tokens and input_tokens (e.g. that one is a subset of
// the other) -- codex's own event does not disclose that, so the fields are
// recorded exactly as reported, with no derived/combined total computed here.
// "raw" keeps codex's own event verbatim: opencode-dispatch.mjs's equivalent
// function normalizes a differently-named field set (cache.read/cache.write
// vs. codex's cached_input_tokens/cache_write_input_tokens), so the raw copy
// is what lets a reader recover the exact original shape from either CLI
// without needing to trust the normalization was lossless.
function buildUsageField(rawUsage) {
  if (!rawUsage) {
    return { source: 'unavailable' };
  }
  return {
    input_tokens: rawUsage.input_tokens ?? null,
    cached_input_tokens: rawUsage.cached_input_tokens ?? null,
    cache_write_input_tokens: rawUsage.cache_write_input_tokens ?? null,
    output_tokens: rawUsage.output_tokens ?? null,
    reasoning_tokens: rawUsage.reasoning_output_tokens ?? null,
    estimated_cost_usd: null,
    source: 'provider',
    raw: rawUsage,
  };
}

// Codex writes a spawned agent's rollout with session_meta.source.subagent.thread_spawn.parent_thread_id.
// Returns every descendant of threadId whose rollout changed since sinceMs, each with its own total usage.
async function findChildThreads(threadId, sinceMs, sessionsDir) {
  if (!threadId) return [];
  const files = [];
  const walk = async (dir) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (/^rollout-.*\.jsonl$/.test(d.name)) files.push(p);
    }
  };
  // Date folders (YYYY/MM/DD) older than the call's start day, less one for time zones, cannot hold its children.
  const since = new Date(sinceMs - 86400000);
  const minDay = `${since.getFullYear()}${String(since.getMonth() + 1).padStart(2, '0')}${String(since.getDate()).padStart(2, '0')}`;
  for (const y of await fs.readdir(sessionsDir).catch(() => [])) {
    for (const m of await fs.readdir(path.join(sessionsDir, y)).catch(() => [])) {
      for (const day of await fs.readdir(path.join(sessionsDir, y, m)).catch(() => [])) {
        if (`${y}${m}${day}` >= minDay) await walk(path.join(sessionsDir, y, m, day));
      }
    }
  }
  const byParent = new Map();
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null);
    if (!st || st.mtimeMs < sinceMs) continue;
    const text = await fs.readFile(f, 'utf8').catch(() => '');
    const firstLine = text.split('\n', 1)[0];
    let meta;
    try { meta = JSON.parse(firstLine)?.payload; } catch { continue; }
    const spawn = meta?.source?.subagent?.thread_spawn;
    if (!spawn?.parent_thread_id) continue;
    let usage = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"total_token_usage"')) continue;
      try { usage = JSON.parse(line).payload?.info?.total_token_usage ?? usage; } catch { /* partial last line */ }
    }
    const entry = { threadId: meta.id ?? meta.session_id ?? null, parentThreadId: spawn.parent_thread_id, agentPath: spawn.agent_path ?? null, depth: spawn.depth ?? null, usage };
    (byParent.get(spawn.parent_thread_id) ?? byParent.set(spawn.parent_thread_id, []).get(spawn.parent_thread_id)).push(entry);
  }
  const out = [];
  const queue = [threadId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      out.push(child);
      if (child.threadId) queue.push(child.threadId);
    }
  }
  return out;
}

const USAGE_DELTA_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_tokens'];

// Codex reports usage cumulatively for a thread, so a resumed call's own cost is its total minus
// the previous call's total on the same thread; a fresh thread's total is already its own cost.
function buildUsageDelta(usage, { session, threadId, previous }) {
  if (usage.source !== 'provider') return { source: 'unavailable', reason: 'no usage reported for this call' };
  const pick = (u) => Object.fromEntries(USAGE_DELTA_KEYS.map((k) => [k, u[k] ?? null]));
  if (!session) return { ...pick(usage), source: 'fresh-thread' };
  if (!previous) return { source: 'unavailable', reason: 'resumed thread: pass --previous-result <the last result.json of this thread>' };
  if (previous.threadId !== threadId || previous.usage?.source !== 'provider') {
    return { source: 'unavailable', reason: '--previous-result is not a completed result for this thread' };
  }
  const delta = {};
  for (const k of USAGE_DELTA_KEYS) {
    const now = usage[k];
    const before = previous.usage[k];
    delta[k] = Number.isFinite(now) && Number.isFinite(before) ? now - before : null;
  }
  return { ...delta, source: 'delta-from-previous-result' };
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
//
// startedAt/finishedAt/durationMs/timeoutS are stamped here, by this script,
// not authored by the orchestrator or any model -- deterministic code owns
// timing data. "usage" is populated from codex's own turn.completed event
// when one was observed (source: "provider"); {source: "unavailable"}
// otherwise (e.g. the process was killed by --timeout before completing, or
// codex's event stream omitted the event for some other reason). See
// buildUsageField() above and docs/design/structured-artifacts.md.
const RESULT_REQUIRED_KEYS = [
  'finalMessage', 'touchedFiles',
  'modelRequested', 'effortRequested', 'modelResolved', 'effortResolved', 'selectionNote',
  'isolated', 'worktreePath', 'isolationNote', 'status',
  'startedAt', 'finishedAt', 'durationMs', 'timeoutS',
  'usage',
  'envMode',
  'webAccess',
];

const JOB_FILE = 'dispatch-job.json';
const DEFAULT_MAX_WAIT_S = 540;
const WORKER_LOG = 'dispatch-worker.log';

// The in-progress record: written by --detach before the worker starts, and by the worker itself.
function runningRecord(args, { startedAt, threadId = null, worker = null }) {
  return {
    threadId, finalMessage: '', touchedFiles: null,
    touchedFilesNote: 'run still in progress; touchedFiles is computed when codex exits',
    modelRequested: args.model, effortRequested: args.effort,
    modelResolved: null, effortResolved: null,
    selectionNote: 'Requested flags are recorded; the JSON event stream does not verify effective model or effort.',
    isolated: false, worktreePath: null, isolationNote: null,
    webAccess: args.web,
    status: 'running',
    startedAt, finishedAt: null, durationMs: null, timeoutS: args.timeout,
    usage: buildUsageField(null), envMode: args.envMode,
    ...(worker ?? {}),
  };
}

// Windows: the harness kills every process in a background shell's job, detached or not, so the
// worker is started through WMI (Win32_Process.Create), which runs it outside that job.
// Elsewhere a detached process group is enough.
function launchWorker(jobPath, cwd) {
  const script = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    const q = (s) => s.replace(/'/g, "''");
    const commandLine = `"${process.execPath}" "${script}" --job "${jobPath}"`;
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(commandLine)}'; CurrentDirectory = '${q(cwd)}' }; ` +
      '"$($r.ReturnValue) $($r.ProcessId)"';
    // Full path: a filtered or test PATH may not include System32.
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    const m = /^(\d+) (\d+)\s*$/.exec((res.stdout || '').trim());
    if (res.status !== 0 || !m || m[1] !== '0') {
      throw new RelayError(`could not start the detached worker through WMI: ${(res.stderr || res.stdout || '').trim() || res.error?.message || `exit ${res.status}`}`);
    }
    return Number(m[2]);
  }
  const child = spawn(process.execPath, [script, '--job', jobPath], { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

async function runDetach(args, argv) {
  const briefDir = path.dirname(path.resolve(args.brief));
  const resultPath = path.join(briefDir, 'result.json');
  if (!args.replaceCompleted) {
    const refusal = await completedRunRefusal(args.finalMessageOut);
    if (refusal) {
      log(refusal);
      process.exit(2);
    }
  }
  const kept = await preserveEarlierResult(resultPath);
  if (kept) log(`kept the earlier result.json as ${path.basename(kept)}`);
  const jobPath = path.join(briefDir, JOB_FILE);
  const workerLog = path.join(briefDir, WORKER_LOG);
  // Only the variables codex needs to be found and to find its login travel in the job file;
  // --env-passthrough names can hold secrets, so those must be set for the user, not written here.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(path|codex_home)$/i.test(k)) env[k] = v;
  await fs.writeFile(jobPath, JSON.stringify({ argv: argv.filter((a) => a !== '--detach'), cwd: process.cwd(), env }, null, 2) + '\n', 'utf8');
  await fs.rm(workerLog, { force: true });
  const startedAt = new Date().toISOString();
  await atomicWriteJson(resultPath, runningRecord(args, { startedAt, worker: { detached: true, workerPid: null, workerLog } }));
  const pid = launchWorker(jobPath, process.cwd());
  process.stdout.write(
    `relay: detached worker pid ${pid} started; its log is ${workerLog}.\n` +
      `relay: wait with: node "${fileURLToPath(import.meta.url)}" --wait "${resultPath}"\n`
  );
  process.exit(0);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A non-zero exit repeats its reason on stderr, so a wrapper that drops stdout still sees why.
function waitExit(line, code) {
  process.stdout.write(line);
  if (code !== 0) process.stderr.write(line);
  process.exit(code);
}

// --wait <result.json> [--max-wait <seconds>]: polls until the detached worker finishes. Safe to stop
// and rerun at any time; it only reads files.
async function runWait(argv) {
  const resultPath = argv[0];
  if (!resultPath || resultPath.startsWith('--')) throw new RelayError('--wait requires the path of a result.json');
  // Under the harness's 10-minute tool limit, so a foreground --wait returns before it is cut off.
  let maxWait = DEFAULT_MAX_WAIT_S;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--max-wait' && /^[0-9]+$/.test(argv[i + 1] ?? '')) maxWait = Number(argv[++i]);
    else throw new RelayError(`--wait accepts only --max-wait <seconds>, got "${argv[i]}"`);
  }
  const began = Date.now();
  for (;;) {
    let rec = null;
    try {
      rec = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw new RelayError(`cannot read ${resultPath}: ${err.message}`);
    }
    if (rec && rec.status !== 'running') {
      waitExit(`relay: finished with status "${rec.status}"${rec.threadId ? `, threadId ${rec.threadId}` : ''}\n`, rec.status === 'completed' ? 0 : 1);
    }
    if (rec && rec.workerPid && !processAlive(rec.workerPid)) {
      waitExit(
        `relay: worker ${rec.workerPid} is gone but result.json still says "running"` +
          (rec.threadId ? `; resume thread ${rec.threadId} with --session` : '; no thread was started, so dispatch again') +
          `. Its log: ${rec.workerLog ?? WORKER_LOG}\n`,
        1
      );
    }
    if (rec && !rec.workerPid && Date.now() - Date.parse(rec.startedAt) > 120000) {
      waitExit(`relay: the detached worker never started (no workerPid after 2 minutes); see ${rec.workerLog ?? WORKER_LOG}\n`, 1);
    }
    if (maxWait && Date.now() - began > maxWait * 1000) {
      waitExit('relay: still running; run --wait again\n', 3);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// retryAfter as a local clock time ("3:06 PM"); null for any other wording. A time more than 12 hours
// behind now is taken as tomorrow ("1:00 AM" read at 11 PM).
function retryDeadline(text, now = new Date()) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*$/i.exec(text ?? '');
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
  const at = new Date(now);
  at.setHours((Number(m[1]) % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0), Number(m[2]), 0, 0);
  if (now - at > 12 * 3600 * 1000) at.setDate(at.getDate() + 1);
  return at;
}

// --wait-retry <result.json> [--max-wait <seconds>]: waits until a rate-limited call's retryAfter time.
// Same exit codes as --wait, so it is stopped and rerun the same way.
async function runWaitRetry(argv) {
  const resultPath = argv[0];
  if (!resultPath || resultPath.startsWith('--')) throw new RelayError('--wait-retry requires the path of a result.json');
  let maxWait = DEFAULT_MAX_WAIT_S;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--max-wait' && /^[0-9]+$/.test(argv[i + 1] ?? '')) maxWait = Number(argv[++i]);
    else throw new RelayError(`--wait-retry accepts only --max-wait <seconds>, got "${argv[i]}"`);
  }
  let rec;
  try {
    rec = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new RelayError(`cannot read ${resultPath}: ${err.message}`);
  }
  if (rec.status !== 'rate-limited') throw new RelayError(`${resultPath} has status "${rec.status}", not "rate-limited"; there is no limit to wait for`);
  const deadline = retryDeadline(rec.retryAfter);
  if (!deadline) throw new RelayError(`retryAfter ${JSON.stringify(rec.retryAfter)} is not a plain clock time such as "3:06 PM"; wait until then yourself`);
  const resume = rec.threadId ? `resume thread ${rec.threadId} with --session, or start a new dispatch` : 'no thread was started, so dispatch again';
  const began = Date.now();
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      process.stdout.write(`relay: the usage limit ended at ${deadline.toLocaleTimeString()}; ${resume}\n`);
      process.exit(0);
    }
    if (maxWait && Date.now() - began >= maxWait * 1000) {
      waitExit(`relay: ${Math.ceil(left / 1000)} s left until ${deadline.toLocaleTimeString()}; run --wait-retry again\n`, 3);
    }
    const untilMax = maxWait ? maxWait * 1000 - (Date.now() - began) : left;
    await new Promise((r) => setTimeout(r, Math.max(50, Math.min(30000, left, untilMax))));
  }
}

// --job <file>: the detached worker. Runs the dispatch the job file describes, logging to a file
// because nothing is attached to its stdout or stderr.
async function runJob(jobPath) {
  let job;
  try {
    job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  } catch (err) {
    throw new RelayError(`cannot read job file ${jobPath}: ${err.message}`);
  }
  const logPath = path.join(path.dirname(jobPath), WORKER_LOG);
  const toLog = (chunk, enc, cb) => {
    appendFileSync(logPath, chunk);
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  process.stdout.write = toLog;
  process.stderr.write = toLog;
  for (const k of Object.keys(process.env)) if (/^(path|codex_home)$/i.test(k)) delete process.env[k];
  Object.assign(process.env, job.env ?? {});
  process.chdir(job.cwd);
  return dispatch(job.argv, { worker: { detached: true, workerPid: process.pid, workerLog: logPath } });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);
  try {
    if (argv[0] === '--wait') return await runWait(argv.slice(1));
    if (argv[0] === '--wait-retry') return await runWaitRetry(argv.slice(1));
    if (argv[0] === '--job') return await runJob(argv[1]);
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      process.exit(2);
    }
    throw err;
  }
  return dispatch(argv);
}

async function dispatch(argv, { worker = null } = {}) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      // The error goes last and alone: the full help would scroll it off the screen.
      process.stderr.write('Run with --help for every option.\n');
      log(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (args.detach && !worker) {
    try {
      return await runDetach(args, argv);
    } catch (err) {
      if (!(err instanceof RelayError)) throw err;
      log(err.message);
      process.exit(1);
    }
  }

  const briefDir = path.dirname(path.resolve(args.brief));
  const resultPath = path.join(briefDir, 'result.json');
  // Read --previous-result first: when it is this folder's result.json, the retry below renames it.
  let previousText = null;
  let previousError = null;
  if (args.previousResult) {
    try {
      previousText = await fs.readFile(args.previousResult, 'utf8');
    } catch (err) {
      previousError = err;
    }
  }
  // A detached worker's parent already kept the earlier result and wrote the placeholder it now replaces.
  if (worker) {
    await atomicWriteJson(resultPath, runningRecord(args, { startedAt, worker }));
  } else {
    if (!args.replaceCompleted) {
      const refusal = await completedRunRefusal(args.finalMessageOut);
      if (refusal) {
        log(refusal);
        process.exit(2);
      }
    }
    const kept = await preserveEarlierResult(resultPath);
    if (kept) log(`kept the earlier result.json as ${path.basename(kept)}`);
  }
  const timingFields = (usage = null) => {
    const finishedAt = new Date().toISOString();
    return {
      startedAt, finishedAt, durationMs: Date.now() - startedAtMs,
      timeoutS: args.timeout,
      usage: buildUsageField(usage),
      envMode: args.envMode,
    };
  };

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
        webAccess: args.web,
        ...(worker ?? {}),
        status: 'error',
        error: message,
        ...timingFields(),
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
  let beforeInventory = null;
  let touchedFilesNote;
  try {
    gitTracked = await isGitRepo(cdAbs);
    if (gitTracked) {
      beforeStatus = await gitStatusPorcelain(cdAbs);
    } else {
      beforeInventory = (await hashInventory(cdAbs)).files;
    }
  } catch (err) {
    gitTracked = false;
    beforeInventory = null;
    touchedFilesNote = `baseline capture failed, touchedFiles tracking disabled: ${err.message}`;
    log(touchedFilesNote);
  }

  // Written as soon as codex names its thread, so a dispatch killed from outside (low memory, a
  // stopped background task) still leaves a threadId to resume instead of starting over.
  let runningWrite = Promise.resolve();
  const writeRunningResult = (threadId) => {
    runningWrite = atomicWriteJson(resultPath, runningRecord(args, { startedAt, threadId, worker }))
      .catch((err) => log(`could not write the in-progress result.json: ${err.message}`));
  };

  let codexResult;
  try {
    codexResult = await runCodex({
      onThreadStarted: writeRunningResult,
      briefText,
      cd: cdAbs,
      session: args.session,
      model: args.model,
      effort: args.effort,
      sandbox: args.sandbox,
      skipGitRepoCheck: args.skipGitRepoCheck,
      forceSkipGitCheck: !gitTracked, // --cd already known not to be a git repo
      web: args.web,
      userExtensions: args.userExtensions,
      timeout: args.timeout,
      envMode: args.envMode,
      envPassthrough: args.envPassthrough,
    });
  } catch (err) {
    const msg = err instanceof RelayError ? err.message : String(err);
    log(msg);
    await runningWrite;
    await writeErrorResult(msg);
    process.exit(1);
  }
  // The final write below must land after the in-progress one, never race it.
  await runningWrite;

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
  } else if (beforeInventory) {
    try {
      touchedFiles = diffInventories(beforeInventory, (await hashInventory(cdAbs)).files);
    } catch (err) {
      touchedFilesNote = `after-run file inventory failed, touchedFiles will be null: ${err.message}`;
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
    webAccess: args.web,
    ...(worker ?? {}),
    ...timingFields(codexResult.usage),
  };
  if (touchedFiles === null && touchedFilesNote) {
    baseFields.touchedFilesNote = touchedFilesNote;
  }
  let previous = null;
  if (args.previousResult) {
    try {
      if (previousError) throw previousError;
      previous = JSON.parse(previousText.replace(/^\uFEFF/, ''));
    } catch (err) {
      log(`--previous-result unreadable, usage_delta will be unavailable: ${err.message}`);
    }
  }
  baseFields.usage_delta = buildUsageDelta(baseFields.usage, {
    session: args.session, threadId: codexResult.threadId, previous,
  });
  baseFields.configOverrides = args.userExtensions ? [] : [...SEAT_CONFIG_OVERRIDES];
  // Spawned agents bill the same account but are not in "usage"; list them so the cost is not hidden.
  const sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  baseFields.childThreads = await findChildThreads(codexResult.threadId, startedAtMs, sessionsDir).catch((err) => {
    log(`could not scan ${sessionsDir} for spawned agents: ${err.message}`);
    return null;
  });
  if (baseFields.childThreads?.length > 0) {
    const input = baseFields.childThreads.reduce((s, c) => s + (c.usage?.input_tokens ?? 0), 0);
    log(`WARNING: codex spawned ${baseFields.childThreads.length} agent thread(s) using ${input} more input tokens, not counted in "usage"; see childThreads`);
  }

  if (codexResult.codexErrors.length > 0) baseFields.codexErrors = codexResult.codexErrors;
  // With --web, every web search the seat ran, so a TRUST-BOUNDARY hit can be checked against it.
  if (args.web) baseFields.webCalls = codexResult.webCalls;
  let stderrLog = null;
  if (codexResult.stderr.trim() !== '') {
    stderrLog = path.join(briefDir, 'result.stderr.log');
    try {
      await fs.writeFile(stderrLog, codexResult.stderr, 'utf8');
      baseFields.stderrLog = stderrLog;
    } catch (err) {
      log(`could not write ${stderrLog}: ${err.message}`);
      stderrLog = null;
    }
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
    const msg = composeRunError(`codex exec exited with code ${codexResult.code}`, codexResult, stderrLog);
    log(msg);
    // An account limit is a wait, not a broken run: the thread survives and can be resumed later.
    const limit = codexResult.codexErrors.find((e) => USAGE_LIMIT_RE.test(e));
    const limited = limit
      ? { status: 'rate-limited', retryAfter: RETRY_AT_RE.exec(limit)?.[1] ?? null,
          retryAfterNote: 'as printed by the Codex CLI, in that machine\'s local time; null when codex gave no time' }
      : { status: 'error' };
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: codexResult.finalMessage || '',
      ...limited,
      error: msg,
    });
    process.exit(1);
  }

  if (codexResult.finalMessage === null) {
    const msg = composeRunError('codex exec exited 0 but no agent_message event was observed on stdout', codexResult, stderrLog);
    log(msg);
    await atomicWriteJson(resultPath, {
      ...baseFields,
      finalMessage: '',
      status: 'error',
      error: msg,
    });
    process.exit(1);
  }

  // A seat always answers with text; an empty last message is a failed turn, and writing it to
  // --final-message-out would leave a 0-byte answer file that later steps misread.
  if (codexResult.finalMessage.trim() === '') {
    const msg = composeRunError('codex exec exited 0 but its last agent_message was empty; resume the same thread to ask again', codexResult, stderrLog);
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

  if (args.finalMessageOut) {
    const outPath = path.resolve(args.finalMessageOut);
    try {
      await writeFinalMessage(outPath, codexResult.finalMessage);
      baseFields.finalMessageOut = outPath;
    } catch (err) {
      const msg = `could not write --final-message-out ${outPath}: ${err.message}`;
      log(msg);
      await atomicWriteJson(resultPath, {
        ...baseFields,
        finalMessage: codexResult.finalMessage,
        status: 'error',
        error: msg,
      });
      process.exit(1);
    }
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
  SEAT_CONFIG_OVERRIDES,
  findChildThreads,
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
  DEFAULT_MAX_WAIT_S,
  retryDeadline,
  spawnCli,
  buildChildEnv,
  buildUsageField,
  buildUsageDelta,
  killTree,
};
