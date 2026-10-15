#!/usr/bin/env node
// Thin sequencer over the scripts the phase files name, in the order they name them. It reads every
// actor from <run-dir>/run.json, keeps no state of its own, and stops at the first failed step.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  RunDescriptorError, readRunDescriptor, seatOutputDir, canonicalPath, privateOutputPath, channelFor, publishSeatOutput,
  assertGrantsIsolated,
} from './run-descriptor.mjs';
import { computeSnapshotHash } from './preflight.mjs';
import { parseFenceLines } from './blind-relabel.mjs';
import { workerIsLive, processStartToken, retryDeadline, stopRecordedChild } from './detach-utils.mjs';
import { findAgentTranscripts, agentState, agentLastReply, agentStats } from './native-agent.mjs';
import { preserveEarlierResult } from './spawn-utils.mjs';
import { isMainModule } from './path-utils.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.basename(path.dirname(SCRIPTS));
let skillName = SKILL;
let runnerOverride = null;
const MAX_LINES = 10;
// One --wait call spends at most this many seconds in total across both seats (and an agent); it stays under a 10-minute tool limit with the work around it.
const DEFAULT_MAX_WAIT_S = 480;
const POLL_MS = 500;
const SEATS = ['A', 'B'];
const HALVES = { phase1: ['--start', '--wait'], phase2: ['--start', '--wait'], audit: ['--prepare', '--finish'] };

const USAGE = `review-run.mjs -- run one documented step of a review from <run-dir>/run.json.

Usage:
  node review-run.mjs phase1 --run-dir <dir> --start | --wait [--max-wait <seconds>] [--native-done <A|B|A,B>] [--native-agent <A|B>=<agent id, Codex thread id or rollout path>] [--local]
  node review-run.mjs phase2 --run-dir <dir> --start | --wait [--max-wait <seconds>] [--native-done <A|B|A,B>] [--native-agent <A|B>=<agent id, Codex thread id or rollout path>]
  node review-run.mjs audit  --run-dir <dir> --prepare | --finish [--max-wait <seconds>] [--audit-depth <light|full>] [--native-done auditor] [--native-agent auditor=<agent id, Codex thread id or rollout path>] [--accept-missing-verifiers]

phase1 --start builds both Phase 1 briefs, starts every CLI seat detached and prints the brief of
each native seat. --wait waits for every seat, publishes file-channel seat output, checks that a
pair-review's seats are distinct, and runs blind-relabel validate.
phase2 --start runs exchange prepare and resumes every CLI seat on its Phase 1 session.
--wait waits, then runs exchange finish. Mode none (pair-review) skips Phase 2.
audit --prepare runs flip and audit-prep and stops, so verifiers can run. --finish builds the
auditor brief, dispatches a CLI auditor (a native auditor is spawned by you: rerun --finish
--native-done auditor once its agent replied written), then translate, scorecard, clear-cache and worktree cleanup.
--local adds a first line with the current time on this machine's clock and in UTC.
A native seat's file alone never ends --wait (the agent writes findings as it goes): once its agent
replied "written", pass --native-done with its letter.
Output is at most ${MAX_LINES} lines plus one "next:" line. Exit 0 done, 1 failed step, 2 bad
arguments, 3 a seat is still running (rerun the same command). --max-wait defaults to ${DEFAULT_MAX_WAIT_S} s.
Test hook: REVIEW_RUN_SCRIPTS_DIR names a folder whose files replace same-named scripts.
`;

class UsageError extends Error {}
class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}
class StillRunning extends Error {}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') return { help: true };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(HALVES, command)) throw new UsageError(`first argument must be phase1, phase2 or audit, got "${command}"`);
  const args = { command, runDir: null, half: null, maxWait: DEFAULT_MAX_WAIT_S, nativeDone: [], nativeAgents: {}, acceptMissingVerifiers: false, auditDepth: null, local: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run-dir' || a === '--max-wait' || a === '--native-done') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      if (a === '--run-dir') args.runDir = v;
      else if (a === '--native-done') {
        args.nativeDone = v.split(',').map((s) => s.trim()).filter(Boolean);
        if (args.nativeDone.length === 0 || args.nativeDone.some((r) => ![...SEATS, 'auditor'].includes(r))) throw new UsageError(`--native-done takes seat letters (${SEATS.join(',')}) or auditor, comma separated`);
      }
      // 0 is refused: a dispatcher's --wait reads 0 as "no limit", which would block past the tool's time limit.
      else if (/^[0-9]+$/.test(v) && Number(v) > 0) args.maxWait = Number(v);
      else throw new UsageError('--max-wait must be a whole number of seconds, at least 1');
    } else if (a === '--native-agent') {
      const m = /^(A|B|auditor)=(.+)$/.exec(rest[++i] ?? '');
      if (!m) throw new UsageError('--native-agent takes ROLE=<agent id, Codex thread id or transcript path>, ROLE being A, B or auditor');
      args.nativeAgents[m[1]] = m[2];
    } else if (a === '--local') {
      args.local = true;
    } else if (a === '--audit-depth') {
      if (command !== 'audit') throw new UsageError('--audit-depth is only accepted by audit');
      const v = rest[++i];
      if (!['light', 'full'].includes(v)) throw new UsageError('--audit-depth must be light or full');
      args.auditDepth = v;
    } else if (a === '--accept-missing-verifiers') {
      if (command !== 'audit') throw new UsageError('--accept-missing-verifiers is only accepted by audit');
      args.acceptMissingVerifiers = true;
    } else if (HALVES[command].includes(a)) {
      if (args.half !== null) throw new UsageError(`${command} takes exactly one of ${HALVES[command].join(' / ')}`);
      args.half = a.slice(2);
    } else {
      throw new UsageError(`unrecognized argument for ${command}: ${a}`);
    }
  }
  if (!args.runDir) throw new UsageError('--run-dir is required');
  if (args.half === null) throw new UsageError(`${command} needs one of ${HALVES[command].join(' / ')}`);
  return args;
}

let scriptsOverride = null;

function scriptPath(name) {
  const hook = scriptsOverride ?? process.env.REVIEW_RUN_SCRIPTS_DIR;
  if (hook && existsSync(path.join(hook, name))) return path.join(hook, name);
  return path.join(SCRIPTS, name);
}

// A script's output lines without stack frames ("at f (file:1:2)"), so a crash shows its error message, not its last frame.
const outputLines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^at .*(?::\d+:\d+\)?|\(index \d+\)|<anonymous>\)?)$/.test(l));

export function tail(text) {
  return (outputLines(text).at(-1) ?? 'no output').slice(0, 220);
}

// The lines a failing script printed before its last one (progress lines of the exchange left out): the reasons a
// refusal lists, such as the blind-relabel lines that name the offending line. Each is cut at 160 characters.
export function failureDetail(text) {
  const reasons = outputLines(text).slice(0, -1).filter((l) => !l.startsWith('exchange: ')).slice(-4).map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
  return reasons.length > 0 ? ' | reasons: ' + reasons.join(' | ').slice(0, 600) : '';
}

function runScript(step, name, argv, { allow = [0] } = {}) {
  const r = runnerOverride ? runnerOverride(name, argv) : spawnSync(process.execPath, [scriptPath(name), ...argv], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) throw new StepError(step, `could not start ${name}: ${r.error.message}`);
  if (!allow.includes(r.status)) throw new StepError(step, `${name} exited ${r.status}: ${tail(r.stderr || r.stdout)}${failureDetail(r.stderr || r.stdout)}`);
  return r;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

async function readResultAt(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

const START_WINDOW_MS = 120000;

// A detached worker that left result.json at running: its pid is gone or reused, or it never recorded a pid in the start window.
function workerGone(record) {
  if (!record || record.status !== 'running') return false;
  if (record.workerPid) return !workerIsLive(record.workerPid, record.workerStartedAt, { recordedToken: record.workerStartToken });
  return Date.now() - Date.parse(record.startedAt) > START_WINDOW_MS;
}

function endedBadly(record) {
  return Boolean(record) && ((record.status !== 'running' && record.status !== 'completed') || workerGone(record));
}

// A usage limit ends a call cleanly; running the next --wait at once only burns a new session against the same limit.
function rateLimitGate(label, record) {
  if (record?.status !== 'rate-limited') return;
  const deadline = retryDeadline(record.retryAfter);
  if (deadline && Date.now() < deadline.getTime()) {
    throw new StillRunning(`${label} hit a usage limit until ${record.retryAfter} (this machine's clock); rerun this command after that time, it dispatches a new session then`);
  }
}

async function agentTranscript(value, role) {
  const files = await findAgentTranscripts(value);
  if (files.length !== 1) throw new StepError(`native agent ${role}`, `${value} matched ${files.length} transcripts; pass the transcript .jsonl path instead`);
  return files[0];
}

async function agentFinished(value, role, seconds) {
  const files = [await agentTranscript(value, role)];
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if ((await agentState(files[0])) === 'done') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// The transcript can show a turn as ended just before that turn's final write lands; wait briefly for the file.
function fileGraceS() {
  const set = process.env.REVIEW_FILE_GRACE_S;
  return set !== undefined && Number.isFinite(Number(set)) ? Number(set) : 15;
}

async function fileAppears(file, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await exists(file)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// The message to give a native seat or auditor, written next to the run so the orchestrator pastes it instead of retyping it
// (and the blinding rule with it); the brief stays the real instruction.
const PROMPTS = {
  phase1: (brief, output) => `Read your complete instructions from ${brief} and follow them exactly. Write your findings to ${output}, adding each finding to the file as you confirm it. When finished, reply with only the word written and your finding counts. Do not read any other file in the run folder except the brief and the task packet it names. Do not edit any file except your own findings file. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
  phase2: (brief, output) => `Phase 2. Read your delta brief from ${brief} and follow it exactly. Write your rebuttal entries to ${output} in one write at the end. Do not read any other file in the run folder. Do not edit any other file. Reply with only the word written and your concede / dispute counts. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
  auditor: (brief, output) => `You are a fresh independent auditor. Read your complete instructions from ${brief} and follow them exactly. Write your result to ${output} in one write at the end. Read only the files the brief names. Do not edit any other file. Reply with only the word written and one line of counts. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
};

async function writePrompt(desc, kind, role, brief, output) {
  const file = path.join(desc.runDir, kind === 'auditor' ? 'phase3' : kind, `prompt-${role}.txt`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, PROMPTS[kind](brief, output) + String.fromCharCode(10), 'utf8');
  return file;
}

function endedAs(record) {
  return record.status === 'running' ? 'running (its worker is gone)' : record.status;
}

// The dispatcher's last log line says it ended: its own done/failure lines, or an argument error printed after the help hint.
function dispatcherLogEnded(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  if (/^relay: (done\.|unexpected failure:|--final-message-out .* already exists)/.test(last)) return true;
  return last.startsWith('relay: ') && lines.at(-2) === 'Run with --help for every option.';
}

// A CLI actor that changed the real target fails its step, whichever attempt recorded the write; an unrecorded
// inventory is reported, not assumed clean.
async function checkTouched(label, file) {
  const dir = path.dirname(file);
  const attempts = (await fs.readdir(dir).catch(() => [])).filter((f) => /^result\.attempt-\d+\.json$/.test(f)).sort();
  for (const name of [path.basename(file), ...attempts]) {
    const touched = (await readResultAt(path.join(dir, name)))?.touchedFiles;
    if (Array.isArray(touched) && touched.length > 0) {
      throw new StepError(`${label} touched files`, `${label} wrote into the target (${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', ...' : ''}; recorded in ${name}); a review must leave the target unchanged`);
    }
  }
  const record = await readResultAt(file);
  const note = typeof record?.touchedFilesNote === 'string' ? record.touchedFilesNote : '';
  if (record?.touchedFiles == null) return `touchedFiles unavailable, check the target by hand${note ? ` (${note})` : ''}`;
  return note;
}

// Every verifier folder, registered in run.json or found under phase3, is held to the same no-write rule as a seat.
async function checkVerifiers(desc, report = null) {
  const dirs = new Set(desc.verifiers.map((v) => path.resolve(v.outputDir)));
  const p3 = path.join(desc.runDir, 'phase3');
  if (await exists(p3)) for (const entry of await fs.readdir(p3, { withFileTypes: true })) if (entry.isDirectory()) dirs.add(path.join(p3, entry.name));
  const notes = [];
  let checked = 0;
  for (const dir of [...dirs].sort()) {
    if (!(await exists(dir)) || !(await fs.readdir(dir)).some((f) => /^result(\.attempt-\d+)?\.json$/.test(f))) continue;
    checked += 1;
    const note = await checkTouched(`verifier ${path.basename(dir)}`, path.join(dir, 'result.json'));
    if (note) notes.push(`${path.basename(dir)}: ${note}`);
  }
  if (report && checked > 0) report.lines.push(`verifiers: checked ${checked} folder(s), ${notes.length > 0 ? notes.join('; ') : 'no target writes recorded'}`);
}

const warnedRepos = new Set();

// A repository the review also reads (preflight --host --repo) is not the target: a change there is a warning, not a stop.
export async function warnExtraRepos(desc) {
  for (const repo of desc.extraRepos ?? []) {
    if (warnedRepos.has(repo.dir)) continue;
    let current = null;
    try {
      current = await computeSnapshotHash(repo.dir);
    } catch (err) {
      process.stderr.write(`review-run: WARNING: cannot check ${repo.dir}: ${err.message}\n`);
      continue;
    }
    if (current !== repo.snapshotHash) {
      warnedRepos.add(repo.dir);
      process.stderr.write(`review-run: WARNING: ${repo.dir} changed since preflight (recorded ${repo.snapshotHash.slice(0, 12)}, now ${current.slice(0, 12)}); the seats read it too, so treat findings that cite it as stale\n`);
    }
  }
}

async function assertFingerprint(desc) {
  await warnExtraRepos(desc);
  if (!desc.fingerprint?.snapshotHash) return;
  const current = await computeSnapshotHash(desc.targetDir);
  if (current !== desc.fingerprint.snapshotHash) throw new StepError('fingerprint', 'the target no longer matches the fingerprint recorded for Phase 1 (HEAD, diff or untracked files changed); the auditor must read the Phase 1 snapshot');
}

// A header-only file is not a finished seat: Phase 1 needs one of the seat's own claim headings or the No findings marker, Phase 2 one P block.
function hasClaimHeading(text, phase, role) {
  const claim = phase === 'phase1' ? new RegExp(`^##\\s+(?:${role}\\d+\\b|No findings\\s*$)`) : /^###?\s+P\d+\b/;
  return parseFenceLines(text).lines.some((l) => !l.inFence && claim.test(l.text));
}

// With agentDone (a probe on the seat's transcript) a seat whose agent ended without a usable file returns 'agent-ended'
// once the file has had the grace time to appear, instead of waiting out the whole budget.
async function waitForNative(file, phase, role, maxWaitS, agentDone = null) {
  const deadline = Date.now() + maxWaitS * 1000;
  let state = 'missing';
  let endedAt = null;
  for (;;) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      state = text.length > 0 ? (hasClaimHeading(text, phase, role) ? 'ready' : 'no-claims') : 'missing';
    } catch {
      state = 'missing';
    }
    if (state === 'ready' || Date.now() >= deadline) return state;
    if (agentDone && (await agentDone())) {
      endedAt ??= Date.now();
      if (Date.now() - endedAt >= fileGraceS() * 1000) return 'agent-ended';
    } else {
      endedAt = null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function isCli(actor) {
  return actor.transport === 'cli';
}

// A seat is never time-limited unless run.json flags.timeoutS says so (0 or absent: no limit); every dispatcher defaults to 1800 s when --timeout is omitted.
function timeoutFlags(desc, actor) {
  return ['--timeout', String(desc.flags.timeoutS ?? 0)];
}

// Outside checklist labels (flags.checklists) the scanner and validator should not read as claim IDs.
function checklistFlags(desc) {
  return (desc.flags.checklists ?? []).flatMap((name) => ['--checklist', name]);
}

function sourceFlags(desc) {
  return (desc.sourceDirs ?? []).flatMap((d) => ['--source-dir', d]);
}

function effortFlags(actor) {
  return actor.effort && actor.effort !== 'default' ? ['--effort', actor.effort] : [];
}

function dispatchDir(desc, phase, role) {
  return path.join(desc.runDir, phase, role);
}

function resultFile(desc, phase, role) {
  return path.join(dispatchDir(desc, phase, role), 'result.json');
}

function auditInputDir(desc) {
  return path.resolve(desc.auditor.outputDir);
}

function auditDispatchDir(desc) {
  return `${desc.runDir}-audit-dispatch`;
}

function mappingFile(desc) {
  return path.join(desc.runDir, 'phase3-private', 'seat-to-audit-label.json');
}

function tokens(desc) {
  return `${desc.seatA.model},${desc.seatB.model}`;
}

function dispatcherFor(actor) {
  return { claude: 'claude-dispatch.mjs', codex: 'codex-dispatch.mjs', opencode: 'opencode-dispatch.mjs' }[actor.runtime];
}

async function previousSession(desc, role, phase) {
  const actor = desc[`seat${role}`];
  if (phase === 'phase1') return { session: null, previous: null, worktree: (await readResultAt(resultFile(desc, 'phase1', role)))?.worktreePath ?? actor.worktreePath };
  const previous = resultFile(desc, 'phase1', role);
  let record = {};
  try {
    record = await readJson(previous);
  } catch {
    record = {};
  }
  const session = record.sessionId ?? record.threadId ?? actor.sessionId;
  if (!session) throw new StepError(`resume seat ${role}`, `no session id for seat ${role} in ${previous} or run.json; Phase 1 must have completed`);
  return { session, previous, worktree: record.worktreePath ?? actor.worktreePath };
}

// The earlier attempt's result.json, worker log and pid record move aside before a new dispatcher starts, so the
// first poll of the new attempt cannot read the old attempt's outcome and a quick rerun sees only live state.
async function archiveOpencodeAttempt(folder) {
  await preserveEarlierResult(path.join(folder, 'result.json'));
  await fs.rm(path.join(folder, 'dispatch-pid.json'), { force: true });
  await fs.rm(path.join(folder, 'child.json'), { force: true });
  const workerLog = path.join(folder, 'dispatch-worker.log');
  if (!(await exists(workerLog))) return;
  let n = 1;
  while (await exists(path.join(folder, `dispatch-worker.attempt-${n}.log`))) n += 1;
  await fs.rename(workerLog, path.join(folder, `dispatch-worker.attempt-${n}.log`));
}

// The OpenCode dispatcher recorded in dispatch-pid.json, and whether it is gone or its log says it ended.
async function opencodeDispatcher(folder) {
  const dispatcher = await readResultAt(path.join(folder, 'dispatch-pid.json'));
  if (!dispatcher?.pid) return null;
  const logText = await fs.readFile(path.join(folder, 'dispatch-worker.log'), 'utf8').catch(() => '');
  const ended = dispatcherLogEnded(logText) || !workerIsLive(dispatcher.pid, dispatcher.startedAt, { recordedToken: dispatcher.startToken });
  return { pid: dispatcher.pid, logText, ended };
}

async function startSeat(desc, role, phase, brief) {
  const actor = desc[`seat${role}`];
  const web = desc.flags.repoOnly !== true;
  const { session, previous, worktree } = await previousSession(desc, role, phase);
  const raw = canonicalPath(desc, phase, role);
  let argv;
  if (actor.runtime === 'claude') {
    argv = ['--brief', brief, '--cd', desc.targetDir, '--model', actor.model, ...effortFlags(actor), '--out-dir', seatOutputDir(desc, phase, role),
      ...sourceFlags(desc), ...(session ? ['--session', session] : []), ...(worktree ? ['--worktree', worktree] : []), ...(web ? ['--web'] : []), ...timeoutFlags(desc, actor), '--detach'];
  } else if (actor.runtime === 'codex') {
    argv = ['--brief', brief, '--cd', desc.targetDir, ...(session ? ['--session', session, '--previous-result', previous] : ['--sandbox', 'read-only']),
      '--model', actor.model, ...effortFlags(actor), ...(web ? ['--web'] : []), ...timeoutFlags(desc, actor), '--final-message-out', raw, '--detach'];
  } else if (actor.runtime === 'opencode') {
    argv = ['--brief', brief, '--cd', desc.targetDir, ...(session ? ['--session', session] : []), '--model', actor.model, ...effortFlags(actor),
      '--isolate', '--worktree', worktree ?? `${desc.runDir}-worktree`, ...(web ? ['--web'] : []), ...timeoutFlags(desc, actor), '--final-message-out', raw];
  } else {
    throw new StepError(`start seat ${role}`, `no dispatcher is defined for runtime "${actor.runtime}"`);
  }
  const name = dispatcherFor(actor);
  if (actor.runtime !== 'opencode') {
    runScript(`start seat ${role}`, name, argv);
    return;
  }
  await archiveOpencodeAttempt(path.dirname(brief));
  const log = openSync(path.join(path.dirname(brief), 'dispatch-worker.log'), 'a');
  try {
    const child = spawn(process.execPath, [scriptPath(name), ...argv], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    if (!child.pid) throw new StepError(`start seat ${role}`, `could not start ${name}`);
    await fs.writeFile(path.join(path.dirname(brief), 'dispatch-pid.json'), `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), startToken: processStartToken(child.pid) })}\n`, 'utf8');
  } finally {
    closeSync(log);
  }
}

async function waitCli(desc, role, phase, maxWait) {
  const actor = desc[`seat${role}`];
  const result = resultFile(desc, phase, role);
  if (actor.runtime !== 'opencode') {
    const r = runScript(`wait seat ${role}`, dispatcherFor(actor), ['--wait', result, '--max-wait', String(maxWait)], { allow: [0, 3] });
    return r.status === 0;
  }
  const deadline = Date.now() + maxWait * 1000;
  const folder = path.dirname(result);
  for (;;) {
    const record = await readResultAt(result);
    if (record && record.status !== 'running') {
      if (record.status !== 'completed') throw new StepError(`wait seat ${role}`, `seat ${role} ended with status ${record.status}: ${String(record.error ?? '').slice(0, 160)}`);
      return true;
    }
    const dispatcher = await opencodeDispatcher(folder);
    if (dispatcher?.ended) {
      const settled = await readResultAt(result);
      if (!settled || settled.status === 'running') {
        throw new StepError(`wait seat ${role}`, `the opencode dispatcher (pid ${dispatcher.pid}) exited ${settled ? 'while result.json still says running' : 'without writing a result.json'}: ${tail(dispatcher.logText)}`);
      }
      continue;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function readResult(desc, phase, role) {
  try {
    return await readJson(resultFile(desc, phase, role));
  } catch {
    return null;
  }
}

async function publishOnce(desc, phase, role) {
  const source = privateOutputPath(desc, phase, role);
  const destination = canonicalPath(desc, phase, role);
  if (await exists(destination)) {
    if (!(await exists(source)) || !(await fs.readFile(source)).equals(await fs.readFile(destination))) {
      throw new StepError(`publish seat ${role}`, `${destination} already exists and differs from the seat's own file ${source}`);
    }
    return 'kept';
  }
  try {
    return (await publishSeatOutput(desc, phase, role)).destinationSha256.slice(0, 12);
  } catch (err) {
    if (err instanceof RunDescriptorError) throw new StepError(`publish seat ${role}`, err.message);
    throw err;
  }
}

async function waitSeats(desc, phase, roles, maxWait, report, nativeOutput, nativeDone = [], nativeAgents = {}) {
  const began = Date.now();
  const budget = () => Math.max(0, Math.floor(maxWait - (Date.now() - began) / 1000));
  for (const role of roles) {
    const actor = desc[`seat${role}`];
    if (isCli(actor)) {
      let prior = await readResult(desc, phase, role);
      rateLimitGate(`seat ${role}`, prior);
      let gone = !prior && actor.runtime === 'opencode' ? await opencodeDispatcher(dispatchDir(desc, phase, role)) : null;
      // The dispatcher writes result.json and then its closing log line: a result read before it was written must not
      // be trusted once the log says the dispatcher ended, so read the result again before dispatching a second one.
      if (gone?.ended && !prior) {
        prior = await readResult(desc, phase, role);
        if (prior) gone = null;
      }
      const brief = path.join(dispatchDir(desc, phase, role), phase === 'phase1' ? 'brief.txt' : 'delta-brief.txt');
      // No result.json and no dispatcher record: an earlier --start stopped before it started this seat, and a second
      // phase2 --start cannot help (exchange prepare refuses to run twice), so the seat is started here from its brief.
      // Only an absent result.json: one that exists but cannot be read yet belongs to a seat that is running.
      let neverStarted = false;
      if (!prior && !gone && !(await exists(resultFile(desc, phase, role)))) {
        const shared = briefOf(desc, role)[0];
        if (phase === 'phase2' && !(await exists(brief)) && await exists(shared)) {
          await fs.mkdir(path.dirname(brief), { recursive: true });
          await fs.copyFile(shared, brief);
        }
        neverStarted = await exists(brief);
      }
      if (endedBadly(prior) || gone?.ended || neverStarted) {
        // An OpenCode dispatcher that ended without result.json left its seat CLI's record in child.json.
        stopRecordedChild(prior ?? (gone?.ended ? await readResultAt(path.join(dispatchDir(desc, phase, role), 'child.json')) : null));
        await checkTouched(`seat ${role}`, resultFile(desc, phase, role));
        await assertFingerprint(desc);
        await startSeat(desc, role, phase, brief);
        report.lines.push(prior
          ? `seat ${role}: previous attempt ended with status ${endedAs(prior)}; dispatched again (the earlier result is kept as an attempt file)`
          : neverStarted
            ? `seat ${role}: not started by an earlier --start (no result.json); dispatched now`
            : `seat ${role}: the previous opencode dispatcher (pid ${gone.pid}) ended without a result.json; dispatched again (its worker log is kept as an attempt file)`);
      }
      let done;
      try {
        // At least 1 s: a dispatcher's --wait reads 0 as "wait without limit".
        done = await waitCli(desc, role, phase, Math.max(1, budget()));
      } catch (err) {
        if (err instanceof StepError) throw new StepError(err.step, `${err.message}; rerunning this command dispatches seat ${role} again`);
        throw err;
      }
      if (!done) throw new StillRunning(`seat ${role} (${actor.runtime}) is still running; rerun this command`);
      const note = await checkTouched(`seat ${role}`, resultFile(desc, phase, role));
      report.lines.push(`seat ${role}: completed (cli ${actor.runtime})${note ? `; ${note}` : ''}`);
    } else {
      const file = nativeOutput(role);
      const transcript = !nativeDone.includes(role) && nativeAgents[role] ? await agentTranscript(nativeAgents[role], role) : null;
      const state = await waitForNative(file, phase, role, budget(), transcript ? async () => (await agentState(transcript)) === 'done' : null);
      if (state === 'agent-ended') {
        const reply = await agentLastReply(transcript);
        throw new StepError(`seat ${role}`, `its agent finished without a usable ${file}; last reply: ${reply === null ? '(none found)' : `"${reply}"`}. If that reports a tool, shell or permission failure it is a host failure, not a finding: keep the agent and the run folder, report the review incomplete, and resume the same agent when the tools work (never respawn it or write its file by hand). Otherwise return the file to the agent`);
      }
      if (state === 'missing') throw new StillRunning(`native seat ${role} has not written ${file}; spawn it with its brief if not done, then rerun this command`);
      if (state === 'no-claims' && transcript && (await agentState(transcript)) !== 'done') {
        throw new StillRunning(`seat ${role}: its agent is still working (its transcript has no final reply yet) and ${file} has no claims yet; rerun this command, the agent id stays remembered in native-agents.json`);
      }
      if (state === 'no-claims' && transcript) {
        throw new StepError(`seat ${role}`, `its agent finished, but ${file} has no claim heading (${phase === 'phase1' ? `"## ${role}<n>" or "## No findings"` : '"### P<n>"'}); a byte-order mark, a wrong heading level or a missing heading are the usual causes: return the file to the seat to rewrite (do not hand-edit)`);
      }
      if (state === 'no-claims') throw new StillRunning(`seat ${role}: ${file} has no claims yet, the agent may still be running; if it already replied "written", the file is malformed: return it to the seat (do not hand-edit)`);
      let how = 'agent reported done';
      if (!nativeDone.includes(role)) {
        if (nativeAgents[role]) {
          if (!(await agentFinished(nativeAgents[role], role, budget()))) {
            throw new StillRunning(`seat ${role}'s agent is still working (its transcript has no final reply yet)`);
          }
          how = 'transcript shows the agent finished';
        } else {
          throw new StillRunning(`seat ${role} is native: ${file} exists but a file alone cannot show the agent finished (it writes findings as it confirms them). Once its agent replied "written", rerun this command with --native-done ${role}, or pass --native-agent ${role}=<agent id> to wait on its transcript`);
        }
      }
      report.lines.push(`seat ${role}: output found (native, ${how})`);
    }
  }
}

function requireFile(step, file, what) {
  return exists(file).then((ok) => {
    if (!ok) throw new StepError(step, `${what} ${file} does not exist`);
  });
}

// A CLI seat with a result.json, or an OpenCode dispatcher still alive, was already started; --wait owns every retry.
async function alreadyStarted(desc, role, phase) {
  const record = await readResultAt(resultFile(desc, phase, role));
  if (record) return `result.json says ${record.status}`;
  if (desc[`seat${role}`].runtime === 'opencode') {
    const dispatcher = await opencodeDispatcher(dispatchDir(desc, phase, role));
    if (dispatcher && !dispatcher.ended) return 'its dispatcher (pid ' + dispatcher.pid + ') is running';
  }
  return null;
}

async function phase1Start(desc, args, report) {
  await assertGrantsIsolated(desc);
  await assertFingerprint(desc);
  const task = path.join(desc.runDir, 'task-packet.md');
  await requireFile('phase1 briefs', task, 'the task packet');
  if (desc.flags.repoOnly !== true && /web verification is off/i.test(await fs.readFile(task, 'utf8').catch(() => ''))) {
    const warning = 'warning: the task packet says web verification is off but run.json flags.repoOnly is not true; CLI seats are started with web access on (build the seats file with "review-config seats --repo-only", or set flags.repoOnly, in a new run folder)';
    process.stderr.write(`${warning}
`);
    report.lines.push(warning);
  }
  for (const role of SEATS) {
    const actor = desc[`seat${role}`];
    const cli = isCli(actor);
    const channel = channelFor(actor);
    const earlier = cli ? await alreadyStarted(desc, role, 'phase1') : null;
    if (earlier) {
      report.lines.push(`seat ${role}: already started (${earlier}); not started again, --wait handles a failed one`);
      continue;
    }
    const brief = cli ? path.join(dispatchDir(desc, 'phase1', role), 'brief.txt') : path.join(desc.runDir, 'phase1', `brief-${role}.txt`);
    await fs.mkdir(path.dirname(brief), { recursive: true });
    if (cli && channel === 'file') await fs.mkdir(seatOutputDir(desc, 'phase1', role), { recursive: true });
    const output = channel !== 'file' ? [] : ['--output-path', cli ? privateOutputPath(desc, 'phase1', role) : canonicalPath(desc, 'phase1', role)];
    runScript(`build seat ${role} brief`, 'build-brief.mjs', ['--mode', 'phase1', '--packet', task, '--seat', role, '--out', brief, '--channel', channel, ...output,
      ...(desc.flags.repoOnly === true ? ['--repo-only'] : [])]);
    if (cli) {
      await startSeat(desc, role, 'phase1', brief);
      report.lines.push(`seat ${role}: started (cli ${actor.runtime}, ${channel} channel); status record ${resultFile(desc, 'phase1', role)}`);
    } else {
      const prompt = await writePrompt(desc, 'phase1', role, brief, canonicalPath(desc, 'phase1', role));
      report.lines.push(`seat ${role}: native ${actor.runtime}; spawn it with brief ${brief}; it writes ${canonicalPath(desc, 'phase1', role)}; prompt to give it: ${prompt}`);
    }
  }
  const native = SEATS.some((role) => !isCli(desc[`seat${role}`]));
  report.next = `${native ? 'spawn each native seat, then run' : 'run'}: review-run phase1 --run-dir ${desc.runDir} --wait${native ? ' (add --native-done <seat> once the seat agent replied "written")' : ''}`;
}

const NO_FINDINGS_RE = /^##\s+No findings\s*$/;
// The seat's own statement opens its "No findings" text; the same words inside a sentence about the target do not count.
const SEAT_INCOMPLETE_RE = /^[\s*_>#-]*(?:review incomplete|command execution failed|could not (?:read|run|execute|start)\b|no (?:target|source|evidence) files? could be read)/i;
const SEAT_EXEC_FAILED_RE = /exec_command failed|failed to create unified exec process|CreateProcess \{/gi;

// A "## No findings" file from a CLI seat that says its own review was incomplete, or whose stderr shows it could not start
// any command, is a failed seat, not a clean zero-findings verdict.
export function seatRanNothing(findingsText, stderrText) {
  // A fence closes only on its own character and length, as validate reads it.
  const lines = parseFenceLines(String(findingsText ?? '')).lines.map((l) => (l.inFence ? null : l.text));
  let marker = -1;
  let hasClaim = false;
  lines.forEach((line, i) => {
    if (line === null) return;
    if (marker < 0 && NO_FINDINGS_RE.test(line)) marker = i;
    if (/^##\s+[AB]\d+\b/.test(line)) hasClaim = true;
  });
  // A file with claims is judged by validate, not here.
  if (marker < 0 || hasClaim) return null;
  for (const line of lines.slice(marker + 1)) {
    if (line === null) continue;
    if (/^##\s/.test(line)) break;
    const said = SEAT_INCOMPLETE_RE.exec(line);
    if (said) return `its file says "${said[0].replace(/^[\s*_>#-]+/, '').trim()}"`;
  }
  const failed = String(stderrText ?? '').match(SEAT_EXEC_FAILED_RE);
  return failed ? `its stderr shows "${failed[0].trim()}"` : null;
}

export function execFailureCount(stderrText) {
  // One failed command logs one line that can match several patterns, so lines are counted, not matches.
  return String(stderrText ?? '').split(/\r?\n/).filter((line) => line.match(SEAT_EXEC_FAILED_RE)).length;
}

async function assertSeatsRan(desc, phase, report) {
  for (const role of SEATS) {
    const findings = await fs.readFile(canonicalPath(desc, phase, role), 'utf8').catch(() => '');
    // A native seat has no stderr record; its own "No findings" statement is still checked.
    const record = isCli(desc[`seat${role}`]) ? await readResult(desc, phase, role) : null;
    const stderr = isCli(desc[`seat${role}`]) ? await fs.readFile(record?.stderrLog ?? path.join(dispatchDir(desc, phase, role), 'result.stderr.log'), 'utf8').catch(() => '') : '';
    const why = seatRanNothing(findings, stderr);
    if (why) {
      throw new StepError(`seat ${role}`, `wrote "No findings" but did not review: ${why}. This is an incomplete seat, not a clean result: fix the cause (the seat could not run commands), keep the run folder, and run the seat again in a new run; do not continue with one seat's verdict as a two-seat review`);
    }
    const failures = execFailureCount(stderr);
    if (failures > 0) report.lines.push(`warning: seat ${role} logged ${failures} exec_command failure(s) in its stderr; its sandbox was unstable, so its verdict may rest on fewer checks than it states`);
  }
}

async function phase1Wait(desc, args, report) {
  await waitSeats(desc, 'phase1', SEATS, args.maxWait, report, (role) => canonicalPath(desc, 'phase1', role), args.nativeDone, args.nativeAgents);
  await assertFingerprint(desc);
  for (const role of SEATS) {
    const actor = desc[`seat${role}`];
    if (isCli(actor) && channelFor(actor) === 'file') report.lines.push(`seat ${role}: published ${path.basename(canonicalPath(desc, 'phase1', role))} (${await publishOnce(desc, 'phase1', role)})`);
    else await requireFile(`seat ${role} output`, canonicalPath(desc, 'phase1', role), `seat ${role}'s findings`);
  }
  await assertSeatsRan(desc, 'phase1', report);
  if (skillName === 'pair-review') {
    const ids = [];
    for (const role of SEATS) {
      const actor = desc[`seat${role}`];
      ids.push(isCli(actor) ? (await readResult(desc, 'phase1', role))?.modelResolved ?? null : null);
    }
    const bothResolved = ids.every((id) => typeof id === 'string' && id.length > 0);
    if (SEATS.every((role) => isCli(desc[`seat${role}`]))) {
      const missing = SEATS.filter((role, i) => !(typeof ids[i] === 'string' && ids[i].length > 0));
      if (missing.length > 0) throw new StepError('distinct models', `seat ${missing.join(' and ')} has no init model id in its result.json; two CLI seats are compared by init model id only, so distinct models cannot be shown`);
    }
    const compared = bothResolved ? ids : [desc.seatA.model, desc.seatB.model];
    if (compared[0].toLowerCase() === compared[1].toLowerCase()) {
      throw new StepError('distinct models', `both seats ran ${compared[0]}${bothResolved ? ' (init model id)' : ' (requested id)'}; pair-review needs two distinct models`);
    }
    report.lines.push(bothResolved ? 'models distinct: init ids differ' : 'models distinct: requested ids differ; effective distinctness unverified (recorded family-distinct)');
  }
  const task = path.join(desc.runDir, 'task-packet.md');
  runScript('validate Phase 1', 'blind-relabel.mjs', ['validate', '--phase1-dir', path.join(desc.runDir, 'phase1'), '--target-dir', desc.targetDir, ...sourceFlags(desc), ...checklistFlags(desc),
    ...((await exists(task)) ? ['--packet', task] : [])]);
  report.lines.push('validate Phase 1: clean');
  report.next = skillName === 'pair-review' && desc.flags.mode === 'none'
    ? `mode none skips Phase 2: run review-run audit --run-dir ${desc.runDir} --prepare`
    : `run: review-run phase2 --run-dir ${desc.runDir} --start`;
}

function skipsPhase2(desc) {
  return skillName === 'pair-review' && desc.flags.mode === 'none';
}

function briefOf(desc, role) {
  const p2 = path.join(desc.runDir, 'phase2');
  return [path.join(p2, `delta-brief-${role}.txt`), path.join(p2, role, 'delta-brief.txt')];
}

async function phase2Start(desc, args, report) {
  if (skipsPhase2(desc)) {
    report.lines.push('mode none: Phase 2 skipped, no exchange');
    report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
    return;
  }
  await assertFingerprint(desc);
  const prepared = runScript('exchange prepare', 'exchange.mjs', ['prepare', '--run-dir', desc.runDir, '--target-dir', desc.targetDir, '--tokens', tokens(desc), ...sourceFlags(desc), ...checklistFlags(desc)]);
  let out;
  try {
    out = JSON.parse(prepared.stdout);
  } catch {
    throw new StepError('exchange prepare', 'exchange.mjs did not print its JSON result');
  }
  report.lines.push('exchange prepare: peer views and delta briefs built');
  for (const role of SEATS) {
    const skipped = out.skipped?.[role];
    const brief = out.briefs?.[role];
    const actor = desc[`seat${role}`];
    if (skipped || !brief) {
      report.lines.push(`seat ${role}: skipped (${skipped ?? 'no brief'})`);
    } else if (isCli(actor) && await alreadyStarted(desc, role, 'phase2')) {
      report.lines.push(`seat ${role}: exchange already started (${await alreadyStarted(desc, role, 'phase2')}); not resumed again`);
    } else if (isCli(actor)) {
      const own = path.join(dispatchDir(desc, 'phase2', role), 'delta-brief.txt');
      if (path.resolve(brief) !== path.resolve(own)) {
        await fs.mkdir(path.dirname(own), { recursive: true });
        await fs.copyFile(brief, own);
      }
      await startSeat(desc, role, 'phase2', own);
      report.lines.push(`seat ${role}: resumed (cli ${actor.runtime})`);
    } else {
      const prompt = await writePrompt(desc, 'phase2', role, brief, canonicalPath(desc, 'phase2', role));
      report.lines.push(`seat ${role}: native; resume it with brief ${brief}; it writes ${canonicalPath(desc, 'phase2', role)}; prompt to send it: ${prompt}`);
    }
  }
  const native = SEATS.some((role) => !isCli(desc[`seat${role}`]) && !out.skipped?.[role] && out.briefs?.[role]);
  report.next = `${native ? 'resume each native seat, then run' : 'run'}: review-run phase2 --run-dir ${desc.runDir} --wait${native ? ' (add --native-done <seat> once the seat agent replied "written")' : ''}`;
}

async function phase2Wait(desc, args, report) {
  if (skipsPhase2(desc)) {
    report.lines.push('mode none: Phase 2 skipped, no exchange');
    report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
    return;
  }
  const roles = [];
  for (const role of SEATS) {
    if ((await Promise.all(briefOf(desc, role).map(exists))).some(Boolean)) roles.push(role);
    else report.lines.push(`seat ${role}: no delta brief, nothing to wait for`);
  }
  await waitSeats(desc, 'phase2', roles, args.maxWait, report, (role) => canonicalPath(desc, 'phase2', role), args.nativeDone, args.nativeAgents);
  await assertFingerprint(desc);
  const finished = runScript('exchange finish', 'exchange.mjs', ['finish', '--run-dir', desc.runDir, '--target-dir', desc.targetDir, ...sourceFlags(desc), ...checklistFlags(desc)]);
  let summary = '';
  let conceded = null;
  let disputed = null;
  try {
    const out = JSON.parse(finished.stdout);
    conceded = out.concede ?? null;
    disputed = out.dispute ?? null;
    summary = ` (appended ${out.appended?.join(',') || 'none'}; concede ${out.concede}, dispute ${out.dispute})`;
  } catch {
    summary = '';
  }
  report.lines.push(`exchange finish: done${summary}`);
  const warnings = String(finished.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('WARNING'));
  // The all-rebuttals-conceded warning already covers each seat's own concede-all warning.
  const allConceded = warnings.some((line) => line.includes('none disputed'));
  for (const warning of warnings.filter((line) => !(allConceded && /conceded all \d+ peer claims/.test(line)))) report.lines.push(warning.length > 230 ? `${warning.slice(0, 227)}...` : warning);
  const wantsFull = warnings.some((line) => line.includes('audit-depth full')) && desc.flags.auditDepth !== 'full';
  const small = wantsFull && disputed === 0 && conceded !== null && conceded <= 3;
  report.next = small
    ? `run: review-run audit --run-dir ${desc.runDir} --prepare --audit-depth full (all ${conceded} claim(s) were conceded, so a light audit would re-check none; a full audit re-checks them and is cheap at this size; use --audit-depth light to keep the light audit)`
    : wantsFull
    ? `decide the audit depth first: ${disputed === 0 ? 'after a zero-dispute exchange' : 'when one seat conceded all its claims'} a full audit is the safer choice; run: review-run audit --run-dir ${desc.runDir} --prepare --audit-depth full (or --audit-depth light to keep the light audit)`
    : `run: review-run audit --run-dir ${desc.runDir} --prepare`;
}

// --audit-depth sets run.json's flags.auditDepth (the auditor brief and translate both read it), so it must be chosen before the
// auditor brief exists; it is written into run.json so a rerun keeps it.
async function applyAuditDepth(desc, args, report) {
  if (!args.auditDepth || args.auditDepth === desc.flags.auditDepth) return;
  for (const brief of [path.join(auditInputDir(desc), 'auditor-brief.txt'), path.join(auditDispatchDir(desc), 'auditor-brief.txt')]) {
    if (await exists(brief)) throw new StepError('audit depth', `the auditor brief was already built at depth ${desc.flags.auditDepth} (${brief}); a different depth would not match it`);
  }
  const file = path.join(desc.runDir, 'run.json');
  const data = await readJson(file);
  data.flags = { ...data.flags, auditDepth: args.auditDepth };
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + String.fromCharCode(10), 'utf8');
  await fs.rename(temp, file);
  desc.flags.auditDepth = args.auditDepth;
  report.lines.push(`audit depth: ${args.auditDepth} (written to run.json)`);
}

// Both seats raised no claim: there is nothing for an auditor to confirm or refute, so the findings file is written empty.
async function zeroClaimRun(ai) {
  if (!(await exists(path.join(ai, 'X-findings.md'))) || !(await exists(path.join(ai, 'Y-findings.md')))) return false;
  return (await stagedClaimIds(ai)).size === 0;
}

async function finishZeroClaimRun(desc, report) {
  const file = path.join(desc.runDir, 'phase3', 'findings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!(await exists(file))) {
    await fs.writeFile(file, `${JSON.stringify({ audit_depth: desc.flags.auditDepth, zero_claims: true, findings: [] }, null, 2)}${String.fromCharCode(10)}`, 'utf8');
  }
  report.lines.push('no claims from either seat: the auditor and the scorecard are not needed; wrote phase3/findings.json with no findings');
  runScript('clear-cache', 'blind-relabel.mjs', ['clear-cache']);
  await removeWorktrees(desc, report);
  report.next = `run: build-manifest.mjs --run-dir ${desc.runDir}, then build-report.mjs --run-dir ${desc.runDir}`;
}

async function auditPrepare(desc, args, report) {
  await applyAuditDepth(desc, args, report);
  const p1 = path.join(desc.runDir, 'phase1');
  const p2 = path.join(desc.runDir, 'phase2');
  const mapping = mappingFile(desc);
  const ai = auditInputDir(desc);
  await fs.mkdir(path.dirname(mapping), { recursive: true });
  await fs.mkdir(path.join(desc.runDir, 'phase3'), { recursive: true });
  if (await exists(mapping)) {
    report.lines.push('flip: kept the earlier coin flip');
  } else {
    runScript('flip', 'blind-relabel.mjs', ['flip', '--out', mapping]);
    report.lines.push('flip: decided');
  }
  if (await exists(ai) && (await fs.readdir(ai)).length > 0) {
    throw new StepError('audit-prep', `${ai} is not empty; audit-prep needs a new empty folder (set auditor.outputDir in run.json to a new one after a redaction)`);
  }
  await fs.mkdir(ai, { recursive: true });
  const breakdown = path.join(desc.runDir, 'phase3', 'falsification-breakdown.json');
  const task = path.join(desc.runDir, 'task-packet.md');
  runScript('audit-prep', 'blind-relabel.mjs', ['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', ai, '--target-dir', desc.targetDir, '--tokens', tokens(desc),
    ...(skipsPhase2(desc) ? [] : ['--phase2-dir', p2]), ...((await exists(task)) ? ['--packet', task] : []), '--breakdown-out', breakdown, ...sourceFlags(desc), ...checklistFlags(desc)]);
  report.lines.push(`audit-prep: staged ${ai}`);
  let qualified = 0;
  try {
    qualified = (await readJson(breakdown)).falsificationBreakdown?.disputed ?? 0;
  } catch (err) {
    throw new StepError('audit-prep', `could not read ${breakdown}: ${err.message}`);
  }
  report.lines.push(`falsification: ${desc.flags.falsification ? 'requested' : 'not requested'}; qualified claims: ${qualified}`);
  if (await zeroClaimRun(ai)) {
    await finishZeroClaimRun(desc, report);
    return;
  }
  report.next = desc.flags.falsification && qualified > 0
    ? `run ${qualified} verifier(s) on the qualified claims and save their verification-<id>.md files in ${path.join(desc.runDir, 'phase3')}, then run: review-run audit --run-dir ${desc.runDir} --finish${nativeAuditorHint(desc)}`
    : `run: review-run audit --run-dir ${desc.runDir} --finish${nativeAuditorHint(desc)}`;
}

// A native auditor is spawned between the two finish runs; the second one needs the flag.
function nativeAuditorHint(desc) {
  return isCli(desc.auditor) ? '' : ' (it prints the auditor brief; spawn the auditor, then rerun with --native-done auditor once it replied "written")';
}

async function copyOnce(source, destination, step) {
  if (await exists(destination)) {
    if (!(await fs.readFile(source)).equals(await fs.readFile(destination))) throw new StepError(step, `${destination} already exists and differs from ${source}`);
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function stagedClaimIds(ai) {
  const ids = new Set();
  for (const f of await fs.readdir(ai)) {
    if (!/^[XY]-findings\.md$/.test(f)) continue;
    const text = parseFenceLines(await fs.readFile(path.join(ai, f), 'utf8')).lines.map((l) => (l.inFence ? '' : l.text)).join('\n');
    for (const m of text.matchAll(/^#{1,6}[ \t]+([XY]\d+)\b/gm)) ids.add(m[1]);
  }
  return ids;
}

async function stageVerification(desc, ai, args, report) {
  if (desc.flags.falsification !== true) return 0;
  const p3 = path.join(desc.runDir, 'phase3');
  const files = (await fs.readdir(p3)).filter((f) => /^verification-.+\.md$/.test(f));
  const breakdown = (await readResultAt(path.join(p3, 'falsification-breakdown.json')))?.falsificationBreakdown;
  const qualified = breakdown?.disputed ?? 0;
  // The claims that qualify, by anonymous ID: a file for some other claim does not cover them. A breakdown written
  // before disputed_ids existed has only the count.
  const have = new Set(files.map((f) => /^verification-([XY]\d+)\.md$/.exec(f)?.[1]).filter(Boolean));
  const missing = Array.isArray(breakdown?.disputed_ids) ? breakdown.disputed_ids.filter((id) => !have.has(id)) : null;
  if (missing ? missing.length > 0 : files.length < qualified) {
    const gap = missing
      ? `falsification was requested and ${qualified} disputed HIGH/CRITICAL claim(s) qualify, but no verification file names ${missing.join(', ')}`
      : `falsification was requested and ${qualified} disputed HIGH/CRITICAL claim(s) qualify, but ${files.length} verification file(s) exist`;
    if (!args.acceptMissingVerifiers) throw new StepError('verifiers', `${gap}; run the missing verifier(s) and save their verification-<id>.md files in ${p3}, or rerun with --accept-missing-verifiers to go on and report the pass as incomplete`);
    report.lines.push(`falsification INCOMPLETE: ${gap}; the report must say so`);
  }
  const claims = await stagedClaimIds(ai);
  for (const f of files) {
    const id = /^verification-([XY]\d+)\.md$/.exec(f)?.[1];
    if (!id) throw new StepError('stage verification', `${f} is not named for an anonymous claim ID (verification-X<n>.md or verification-Y<n>.md); a real-ID name would leak seat identity to the auditor`);
    if (!claims.has(id)) throw new StepError('stage verification', `${f} names ${id}, which is not a claim in the staged findings`);
    runScript('stage verification', 'blind-relabel.mjs', ['scan', '--in', path.join(p3, f), '--target-dir', desc.targetDir, '--tokens', tokens(desc), ...sourceFlags(desc), ...checklistFlags(desc),
      '--phase1-dir', path.join(desc.runDir, 'phase1'), '--forbid-seats', 'A,B', ...(skipsPhase2(desc) ? [] : ['--phase2-dir', path.join(desc.runDir, 'phase2')])]);
  }
  for (const f of files) await copyOnce(path.join(p3, f), path.join(ai, f), 'stage verification');
  return files.length;
}

async function archiveAuditOutput(p3, file) {
  let n = 1;
  while (await exists(path.join(p3, `findings.audit.attempt-${n}.json`))) n += 1;
  const name = `findings.audit.attempt-${n}.json`;
  await fs.mkdir(p3, { recursive: true });
  await fs.rename(file, path.join(p3, name));
  return name;
}

async function dispatchAuditor(desc, args, report, briefPath, outputExists) {
  const auditor = desc.auditor;
  if (auditor.runtime !== 'claude' && auditor.runtime !== 'codex') throw new StepError('auditor dispatch', `a CLI auditor runs through claude-dispatch or codex-dispatch; runtime "${auditor.runtime}" is not supported`);
  const dispatcher = dispatcherFor(auditor);
  const dir = path.dirname(briefPath);
  const result = path.join(dir, 'result.json');
  const prior = await readResultAt(result);
  rateLimitGate('the auditor', prior);
  if (!prior && outputExists) throw new StepError('auditor output', `the auditor output exists but there is no result.json at ${result}, so the CLI auditor's completion cannot be confirmed; remove the output file to dispatch the auditor again`);
  const redispatch = !prior || endedBadly(prior);
  if (redispatch) {
    stopRecordedChild(prior);
    if (prior) await checkTouched('auditor', result);
    await assertFingerprint(desc);
    const leftover = path.join(auditInputDir(desc), 'findings.audit.json');
    if (await exists(leftover)) report.lines.push(`auditor: the failed attempt's output is kept as ${await archiveAuditOutput(path.join(desc.runDir, 'phase3'), leftover)}`);
    const argv = auditor.runtime === 'claude'
      ? ['--brief', briefPath, '--cd', desc.targetDir, '--model', auditor.model, ...effortFlags(auditor), '--out-dir', auditInputDir(desc),
        ...sourceFlags(desc), ...(auditor.worktreePath ? ['--worktree', auditor.worktreePath] : []), ...timeoutFlags(desc, auditor), '--detach']
      : ['--brief', briefPath, '--cd', desc.targetDir, '--sandbox', 'read-only', '--model', auditor.model, ...effortFlags(auditor), ...timeoutFlags(desc, auditor),
        '--final-message-out', path.join(auditInputDir(desc), 'findings.audit.json'), '--detach'];
    runScript('auditor dispatch', dispatcher, argv);
    report.lines.push(prior ? `auditor: previous attempt ended with status ${endedAs(prior)}; dispatched again (the earlier result is kept as an attempt file)` : `auditor: dispatched (cli ${auditor.runtime})`);
  }
  if (redispatch || prior.status === 'running') {
    let waited;
    try {
      waited = runScript('auditor wait', dispatcher, ['--wait', result, '--max-wait', String(args.maxWait)], { allow: [0, 3] });
    } catch (err) {
      if (err instanceof StepError) throw new StepError(err.step, `${err.message}; rerunning this command dispatches the auditor again`);
      throw err;
    }
    if (waited.status === 3) throw new StillRunning('the auditor is still running; rerun this command');
  }
  const note = await checkTouched('auditor', result);
  report.lines.push(`auditor: completed${note ? `; ${note}` : ''}`);
}

async function removeWorktrees(desc, report) {
  const results = new Set();
  const addResult = (file) => results.add(path.resolve(file));
  for (const phase of ['phase1', 'phase2']) {
    for (const role of SEATS) {
      const dir = dispatchDir(desc, phase, role);
      if (!(await exists(dir))) continue;
      for (const f of await fs.readdir(dir)) if (/^result(\.attempt-\d+)?\.json$/.test(f)) addResult(path.join(dir, f));
    }
  }
  const auditDir = auditDispatchDir(desc);
  if (await exists(auditDir)) for (const f of await fs.readdir(auditDir)) if (/^result(\.attempt-\d+)?\.json$/.test(f)) addResult(path.join(auditDir, f));
  const phase3 = path.join(desc.runDir, 'phase3');
  if (await exists(phase3)) {
    for (const entry of await fs.readdir(phase3, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const f of await fs.readdir(path.join(phase3, entry.name))) if (/^result(\.attempt-\d+)?\.json$/.test(f)) addResult(path.join(phase3, entry.name, f));
    }
  }
  for (const verifier of desc.verifiers) {
    const dir = path.resolve(verifier.outputDir);
    if (!(await exists(dir))) continue;
    for (const f of await fs.readdir(dir)) if (/^result(\.attempt-\d+)?\.json$/.test(f)) addResult(path.join(dir, f));
  }
  const actors = [desc.seatA, desc.seatB, desc.auditor, ...desc.verifiers];
  for (const actor of actors) if (actor.resultPath) addResult(actor.resultPath);
  const worktrees = new Set(actors.map((a) => a.worktreePath).filter(Boolean));
  for (const file of results) {
    try {
      const wt = (await readJson(file)).worktreePath;
      if (typeof wt === 'string' && wt) worktrees.add(path.resolve(wt));
    } catch {
      // a missing or unreadable result lists no worktree
    }
  }
  for (const wt of worktrees) {
    if (await exists(wt)) {
      const r = spawnSync('git', ['-C', desc.targetDir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
      if (r.status !== 0) throw new StepError('worktree cleanup', `git worktree remove ${wt} failed: ${tail(r.stderr)}`);
    }
    await fs.rm(`${wt}.snapshot-complete`, { force: true });
  }
  if (worktrees.size > 0) {
    const r = spawnSync('git', ['-C', desc.targetDir, 'worktree', 'prune'], { encoding: 'utf8' });
    if (r.status !== 0) throw new StepError('worktree cleanup', `git worktree prune failed: ${tail(r.stderr)}`);
  }
  report.lines.push(`worktrees: removed ${worktrees.size}`);
}

async function auditFinish(desc, args, report) {
  await applyAuditDepth(desc, args, report);
  const ai = auditInputDir(desc);
  if (await zeroClaimRun(ai)) {
    await finishZeroClaimRun(desc, report);
    return;
  }
  if (!(await exists(path.join(ai, 'task-packet.md')))) {
    throw new StepError('audit prepare', `the staged audit folder ${ai} is missing or incomplete: run review-run audit --prepare first (it needs the exchange finished); nothing was started`);
  }
  if (desc.flags.falsification !== true) {
    const phase3 = path.join(desc.runDir, 'phase3');
    const ignored = ((await exists(phase3)) ? await fs.readdir(phase3) : []).filter((f) => /^verification-.+\.md$/.test(f));
    if (ignored.length > 0) report.lines.push(`warning: ${ignored.length} verification file(s) in phase3 are ignored because run.json flags.falsification is false (this command does not stage them; the post-audit "Deep verify" steps in phase-3-scorecard.md do, or enable the flag for a new run with "review-config seats --falsification" before preflight --host)`);
  }
  const p1 = path.join(desc.runDir, 'phase1');
  const p3 = path.join(desc.runDir, 'phase3');
  const task = path.join(ai, 'task-packet.md');
  const depth = desc.flags.auditDepth;
  const cliAuditor = isCli(desc.auditor);
  const briefPath = cliAuditor ? path.join(auditDispatchDir(desc), 'auditor-brief.txt') : path.join(ai, 'auditor-brief.txt');
  const audited = path.join(ai, 'findings.audit.json');
  await checkVerifiers(desc, report);
  if (!(await exists(briefPath))) {
    await assertFingerprint(desc);
    const staged = await stageVerification(desc, ai, args, report);
    await fs.mkdir(path.dirname(briefPath), { recursive: true });
    runScript('auditor brief', 'build-brief.mjs', ['--mode', 'auditor', '--packet', task, '--audit-dir', ai, '--target-dir', desc.targetDir, '--run-dir', desc.runDir, '--out', briefPath,
      ...(channelFor(desc.auditor) === 'file' ? ['--output-path', audited] : []), '--audit-depth', depth, '--channel', channelFor(desc.auditor), ...sourceFlags(desc)]);
    report.lines.push(`auditor brief: built (${depth} audit${staged > 0 ? `, ${staged} verification file(s) staged` : ''})`);
  }
  if (cliAuditor) {
    await dispatchAuditor(desc, args, report, briefPath, await exists(audited));
    if (!(await exists(audited))) {
      const result = path.join(path.dirname(briefPath), 'result.json');
      throw new StepError('auditor output', `the CLI auditor completed but did not write ${audited}; either save the finalMessage from ${result} as that file with a script, or remove ${result} so the next run dispatches the auditor again`);
    }
  } else if (!(await exists(audited))) {
    // With the auditor's agent id the sequencer waits for the agent itself instead of printing the spawn line again.
    if (args.nativeAgents.auditor) {
      if (!(await agentFinished(args.nativeAgents.auditor, 'auditor', args.maxWait))) throw new StillRunning("the auditor's agent is still working (its transcript has no final reply yet)");
      if (!(await fileAppears(audited, fileGraceS()))) {
        throw new StepError('auditor output', `the auditor's agent finished but ${audited} does not exist (waited ${fileGraceS()} s for the write); return it to the agent to write the file (never write it yourself)`);
      }
    } else {
      const prompt = await writePrompt(desc, 'auditor', 'auditor', briefPath, audited);
      report.lines.push(`auditor: native; spawn it with brief ${briefPath}; it writes ${audited}; prompt to give it: ${prompt}`);
      report.next = `spawn the auditor, then rerun: review-run audit --run-dir ${desc.runDir} --finish --native-agent auditor=<its agent id> (or --native-done auditor once it replied "written")`;
      return;
    }
  }
  if (!cliAuditor && !args.nativeDone.includes('auditor') && args.nativeAgents.auditor && !(await exists(path.join(p3, 'findings.audit.json')))) {
    if (!(await agentFinished(args.nativeAgents.auditor, 'auditor', args.maxWait))) throw new StillRunning("the auditor's agent is still working (its transcript has no final reply yet)");
    report.lines.push('auditor: transcript shows the agent finished');
  } else if (!cliAuditor && !args.nativeDone.includes('auditor') && !(await exists(path.join(p3, 'findings.audit.json')))) {
    throw new StillRunning(`the native auditor's file ${audited} exists but a file alone cannot show the agent finished; once it replied "written", rerun this command with --native-done auditor`);
  }
  await assertFingerprint(desc);
  await checkVerifiers(desc);
  const audit = path.join(p3, 'findings.audit.json');
  const translated = await exists(path.join(p3, 'findings.json'));
  if (!translated && await exists(audit) && !(await fs.readFile(audit)).equals(await fs.readFile(audited))) {
    report.lines.push(`the refused auditor output is kept as ${await archiveAuditOutput(p3, audit)}`);
  }
  await copyOnce(audited, audit, 'copy auditor output');
  const findings = path.join(p3, 'findings.json');
  runScript('translate', 'blind-relabel.mjs', ['translate', '--in', audit, '--out', findings, '--mapping', mappingFile(desc), '--phase1-dir', p1,
    ...(desc.flags.falsification === true ? ['--verification-dir', p3] : []), '--audit-depth', depth, ...checklistFlags(desc)]);
  runScript('scorecard', 'blind-relabel.mjs', ['scorecard', '--in', findings, '--out', path.join(p3, 'scorecard.md'), '--phase1-dir', p1]);
  runScript('clear-cache', 'blind-relabel.mjs', ['clear-cache']);
  report.lines.push('translate, scorecard, clear-cache: done');
  await removeWorktrees(desc, report);
  report.next = `write the manifest and the report from ${path.join(p3, 'scorecard.md')} (build-manifest.mjs), then finish`;
}

const HANDLERS = {
  phase1: { start: phase1Start, wait: phase1Wait },
  phase2: { start: phase2Start, wait: phase2Wait },
  audit: { prepare: auditPrepare, finish: auditFinish },
};

// The scripts keep every time in UTC; --local adds the current time on this machine's clock with UTC beside it.
export function clockLine(now = new Date()) {
  const local = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const utc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `time: ${local} (${utc} UTC)`;
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown time';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// One line per seat for a "still running" exit: how long it has run and, from its own logs, whether it is healthy.
export async function seatStatusLines(desc, phase, nativeAgents = {}, nowMs = Date.now()) {
  const lines = [];
  for (const role of SEATS) {
    const actor = desc[`seat${role}`];
    if (isCli(actor)) {
      const record = await readResult(desc, phase, role);
      if (!record) {
        lines.push(`seat ${role}: ${actor.runtime} cli, no status record yet`);
      } else if (record.status === 'running') {
        const live = await fs.readFile(path.join(dispatchDir(desc, phase, role), 'result.stderr.live.log'), 'utf8').catch(() => '');
        const failures = execFailureCount(live);
        lines.push(`seat ${role}: ${actor.runtime} running ${formatElapsed(nowMs - Date.parse(record.startedAt))}${failures > 0 ? `, ${failures} exec_command failure(s) so far` : ''}`);
      } else {
        lines.push(`seat ${role}: ${actor.runtime} ${record.status}${Number.isFinite(record.durationMs) ? ` in ${formatElapsed(record.durationMs)}` : ''}`);
      }
    } else if (nativeAgents[role]) {
      const file = await agentTranscript(nativeAgents[role], role).catch(() => null);
      const stats = file ? await agentStats(file) : null;
      if (!stats) {
        lines.push(`seat ${role}: native agent, transcript not readable yet`);
      } else {
        const state = (await agentState(file)) === 'done' ? 'finished' : 'working';
        lines.push(`seat ${role}: native agent ${state}${stats.startedAtMs ? ` ${formatElapsed(nowMs - stats.startedAtMs)}` : ''}, ${stats.calls} tool call(s)`);
      }
    } else {
      lines.push(`seat ${role}: native; pass --native-agent ${role}=<agent id> to see its progress`);
    }
  }
  return lines;
}

// The wait stops at the first unfinished seat; name the other seats that are not finished either.
export function otherPendingSeats(message, statusLines) {
  const named = /seat ([AB])/.exec(message)?.[1];
  const pending = statusLines
    .map((l) => /^seat ([AB]): (.*)$/.exec(l))
    .filter((m) => m && m[1] !== named && /running|working|no status record|not readable|pass --native-agent/.test(m[2]))
    .map((m) => m[1]);
  return pending.length > 0 ? ` (seat ${pending.join(', ')} is not finished either)` : '';
}

export function print(report, out) {
  if (report.clock) report.lines = [clockLine(), ...report.lines];
  // Over the cap the last line stays: it is the FAILED line when a step failed.
  const lines = report.lines.length > MAX_LINES ? [...report.lines.slice(0, MAX_LINES - 2), `... ${report.lines.length - MAX_LINES + 1} more line(s) omitted`, report.lines.at(-1)] : report.lines;
  out.write(`${lines.join('\n')}${lines.length > 0 ? '\n' : ''}next: ${report.next}\n`);
}

async function run(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const errOut = io.stderr ?? process.stderr;
  scriptsOverride = io.scriptsDir ?? null;
  runnerOverride = io.runner ?? null;
  skillName = io.skill ?? SKILL;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    errOut.write(`review-run: ${err.message}\n`);
    out.write('next: fix the arguments (review-run --help)\n');
    return 2;
  }
  if (args.help) {
    out.write(USAGE);
    return 0;
  }
  const report = { lines: [], next: '', clock: args.local };
  const rerun = `review-run ${args.command} --run-dir ${path.resolve(args.runDir)} --${args.half}`;
  let loadedDesc = null;
  try {
    const desc = await readRunDescriptor(args.runDir);
    loadedDesc = desc;
    const agentsFile = path.join(desc.runDir, 'native-agents.json');
    const known = await readResultAt(agentsFile);
    args.nativeAgents = { ...(known && typeof known === 'object' ? known : {}), ...args.nativeAgents };
    if (Object.keys(args.nativeAgents).length > 0 && JSON.stringify(args.nativeAgents) !== JSON.stringify(known)) {
      await fs.writeFile(agentsFile, JSON.stringify(args.nativeAgents, null, 2) + String.fromCharCode(10), 'utf8');
    }
    if (desc.skill !== skillName) throw new StepError('run.json', `run.json was made for ${desc.skill}, but this is ${skillName}'s review-run`);
    await HANDLERS[args.command][args.half](desc, args, report);
    print(report, out);
    return 0;
  } catch (err) {
    if (err instanceof StillRunning) {
      let others = '';
      if (loadedDesc && (args.command === 'phase1' || args.command === 'phase2')) {
        try {
          const status = await seatStatusLines(loadedDesc, args.command, args.nativeAgents);
          report.lines.push(...status);
          others = otherPendingSeats(err.message, status);
        } catch (statusErr) {
          report.lines.push(`seat status unavailable: ${statusErr.message}`);
        }
      }
      report.next = `${err.message}${others}: ${rerun}`;
      print(report, out);
      return 3;
    }
    const step = err instanceof StepError ? err.step : err instanceof RunDescriptorError ? 'run.json' : null;
    if (step === null) throw err;
    report.lines.push(`FAILED ${step}: ${err.message}`);
    report.next = `fix "${step}" (every artifact is kept under ${path.resolve(args.runDir)}), then rerun: ${rerun}`;
    print(report, out);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  // A reader that stops early (head, Select-Object -First) closes the pipe: the rest of the output is dropped, the exit code stays.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`review-run: unexpected failure: ${err.stack || err}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, run };
