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
//   1. `opencode run` takes its message as a POSITIONAL ARGUMENT, not stdin —
//      the CONTENT of a piped stdin is not read as the message. It does
//      still wait for stdin to reach EOF before proceeding, though (see the
//      OPENCODE_SPAWN_STDIO comment below — this is NOT "stdin is ignored").
//      A long brief passed positionally risks Windows's ~8191-char
//      command-line limit, so this script attaches the caller's own --brief
//      file with `-f` instead of inlining it (no copy is made; the file is
//      read once only to confirm it is readable) — verified working:
//      OpenCode reads the attached file's content and follows its
//      instructions, not the wrapper message text.
//   2. Session resume is `-s <sessionID>`, not a `resume` subcommand, and it
//      does NOT drop --dir the way Codex's `exec resume` drops --cd/--sandbox
//      -- --dir is still meaningful and forwarded on resume. This has not
//      been exhaustively verified across every flag; treat any assumption
//      not stated here as unconfirmed.
//   3. The JSON event vocabulary is entirely different from Codex's
//      (thread.started/item.completed/agent_message): OpenCode emits
//      step_start / text / step_finish events, each carrying `sessionID`
//      directly on the top-level object, and the final agent text lives at
//      `part.text` on a `type: "text"` event's `part.type === "text"`.
//
// Non-goals (same spirit as codex-dispatch.mjs's non-goals list): multi-model
// routing beyond a single `-m`/`--model` and `--variant` pass-through,
// --timeout/watchdog, provider auth setup (run `opencode auth` yourself
// first — this script assumes it already works, exactly as codex-dispatch.mjs
// assumes `codex login` already succeeded).

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const NEEDS_SHELL = process.platform === 'win32';

const WIN32_UNSAFE_CHARS = /["%]|\\$/;

function assertWin32Safe(arg) {
  if (NEEDS_SHELL && WIN32_UNSAFE_CHARS.test(String(arg))) {
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

function spawnCli(cmd, args, opts) {
  if (NEEDS_SHELL) {
    for (const a of [cmd, ...args]) assertWin32Safe(a);
    const cmdLine = [winQuote(cmd), ...args.map(winQuote)].join(' ');
    return spawn(cmdLine, { ...opts, shell: true });
  }
  return spawn(cmd, args, { ...opts, shell: false });
}

const USAGE = `opencode-dispatch.mjs — dispatch a brief to OpenCode CLI ("opencode run") and capture the result as JSON.

Usage:
  node opencode-dispatch.mjs --brief <path> --cd <path> [--session <sessionID>]
                 [--model <provider/model>] [--variant <level>]

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
                         model's own default.
  --skip-git-repo-check  No-op here (OpenCode has no equivalent flag); accepted only so a
                         caller that always passes it for parity with codex-dispatch.mjs does
                         not need a vendor-specific branch.
  -h, --help             Print this message and exit 0.

Output:
  Writes <directory containing --brief>/result.json (atomic write via temp file + rename).
  result.json fields:
    sessionId     string|null   OpenCode session id, if one was observed.
    finalMessage  string        Last "text" event's part.text seen in the event stream.
    touchedFiles  string[]|null Same git-porcelain-diff mechanism as codex-dispatch.mjs.
                                 null (not []) when --cd is not a git repo.
    touchedFilesNote string     Present only when touchedFiles is null; explains why.
    status        "completed"|"error"
    error         string        Present only when status is "error"; failure reason.

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
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    // Same guard as codex-dispatch.mjs: a bare trailing --session (or one
    // followed by another flag) must error, not silently become a fresh run.
    const takeValue = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
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
        args.variant = takeValue();
        break;
      case '--skip-git-repo-check':
        args.skipGitRepoCheck = true;
        break;
      default:
        throw new RelayError(`unrecognized argument: ${tok}`);
    }
  }
  if (!args.brief) throw new RelayError('--brief <path> is required');
  if (!args.cd) throw new RelayError('--cd <path> is required');
  return args;
}

class RelayError extends Error {}

function log(msg) {
  process.stderr.write(`relay: ${msg}\n`);
}

// Same git-porcelain helpers as codex-dispatch.mjs — vendor-agnostic, reused verbatim.
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
// ignore stdin either — it waits for EOF on it. See the stdio comment in
// runOpencode below; passing an open, never-ended stdin pipe hangs the run
// forever. "stdin is not read at all" (an earlier note here) is wrong.
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

// stdin MUST be 'ignore', not the default 'pipe'. Verified 2026-08-30: with a
// default (open, never-ended) stdin pipe, `opencode run` blocks forever and
// emits ZERO bytes on stdout — the whole dispatch hangs. It is waiting on
// stdin EOF. Confirmed both directions: 'ignore' completes in ~29s exit 0,
// and an explicit child.stdin.end() immediately after spawn also completes
// (~28s), proving the trigger is the missing EOF rather than the pipe's
// existence. The file-header note "opencode run does not read stdin" was
// verified by piping content IN (write-then-close, which supplies EOF) —
// open-and-idle was the untested case, and it hangs.
//
// Extracted to its own constant (rather than inlined in the spawnCli call
// below) specifically so a unit test can assert on it without spawning a
// live process — this exact regression (an edit accidentally reverting to
// the default stdio) is otherwise invisible to the pure-function test suite,
// since runOpencode's actual spawn behavior can't be exercised without a
// real `opencode` binary. See scripts/tests/opencode-dispatch.test.mjs.
const OPENCODE_SPAWN_STDIO = ['ignore', 'pipe', 'pipe'];

function runOpencode({ briefPath, cd, session, model, variant }) {
  return new Promise((resolve, reject) => {
    const args = buildOpencodeArgs({ briefPath, cd, session, model, variant });

    let child;
    try {
      child = spawnCli('opencode', args, { cwd: cd, stdio: OPENCODE_SPAWN_STDIO });
    } catch (err) {
      reject(new RelayError(`failed to spawn "opencode": ${err.message}`));
      return;
    }

    child.on('error', (err) => {
      reject(new RelayError(`failed to spawn "opencode": ${err.message}`));
    });

    let sessionId = null;
    let finalMessage = null;
    let stderrBuf = '';
    const badLines = [];

    const rl = readline.createInterface({ input: child.stdout });
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
      }
    });

    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    child.on('close', (code) => {
      rl.close();
      resolve({ code, sessionId, finalMessage, stderr: stderrBuf, badLines });
    });
  });
}

// Same fail-closed principle as codex-dispatch.mjs's checkSessionIdentity:
// a resume must echo back the exact requested sessionID.
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
        sessionId: null,
        finalMessage: '',
        touchedFiles: null,
        status: 'error',
        error: message,
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

  const baseFields = { sessionId: opencodeResult.sessionId, touchedFiles };
  if (touchedFiles === null && touchedFilesNote) {
    baseFields.touchedFilesNote = touchedFilesNote;
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
};
