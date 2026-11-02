#!/usr/bin/env node
// Thin sequencer over the scripts the phase files name, in the order they name them. It reads every
// actor from <run-dir>/run.json, keeps no state of its own, and stops at the first failed step.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  RunDescriptorError, readRunDescriptor, seatOutputDir, canonicalPath, privateOutputPath, channelFor, publishSeatOutput,
  assertGrantsIsolated,
} from './run-descriptor.mjs';
import { computeSnapshotHash, driftedFiles, fingerprintFiles, outsideReadWarning, packetReach } from './preflight.mjs';
import { parseFenceLines, refutesByInference, runStep as relabelStep, seatClaimProblems } from './blind-relabel.mjs';
import { runStep as exchangeStep } from './exchange.mjs';
import { runDirNamedIn, runStep as briefStep } from './build-brief.mjs';
import { firstBriefTime, hashFile, runStep as manifestStep } from './build-manifest.mjs';
import { runStep as reportStep } from './build-report.mjs';
import { runStep as recheckStep } from './build-recheck-packet.mjs';
import { parseSeatFile, hasPassContent } from './seat-file.mjs';
import { processExists, recordedWorkerProven, workerIsLive, retryDeadline, stopRecordedChild, stopRecordedWorker } from './detach-utils.mjs';
import { findAgentTranscripts, agentState, agentLastReply, agentStats } from './native-agent.mjs';
import { foldsCase, isMainModule, setFoldsCase } from './path-utils.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.basename(path.dirname(SCRIPTS));
let skillName = SKILL;
let stepsOverride = null;
const MAX_LINES = 10;
// One --wait call spends at most this many seconds in total across both seats (and an agent); it stays under a 10-minute tool limit with the work around it.
const DEFAULT_MAX_WAIT_S = 480;
const POLL_MS = 500;
const SEATS = ['A', 'B'];
const HALVES = { phase1: ['--start', '--wait'], phase2: ['--start', '--wait'], audit: ['--prepare', '--finish'] };
// Commands that hand their arguments to one step: the manifest, the report and the re-review packet.
// splice and scan are the redaction round's tools: put a seat's corrected block back, and scan a file again.
// verifier-brief builds a falsification verifier's brief (deep verify).
const FORWARD = {
  manifest: (argv) => manifestStep(argv), report: (argv, { tty }) => reportStep(argv, { tty }), recheck: (argv) => recheckStep(argv),
  splice: (argv) => relabelStep(['splice', ...argv]), scan: (argv) => relabelStep(['scan', ...argv]),
  'verifier-brief': (argv) => briefStep(['--mode', 'verifier', ...argv]),
};

const USAGE = `review-run.mjs -- run one documented step of a review from <run-dir>/run.json.

Usage:
  node review-run.mjs phase1 --run-dir <dir> --start | --wait [--max-wait <seconds>] [--native-done <A|B|A,B>] [--native-agent <A|B>=<agent id, Codex thread id or rollout path>] [--accept-drift] [--local]
  node review-run.mjs phase2 --run-dir <dir> --start | --wait [--max-wait <seconds>] [--native-done <A|B|A,B>] [--native-agent <A|B>=<agent id, Codex thread id or rollout path>] [--accept-drift] [--incomplete-seat <A|B>] [--local]
  node review-run.mjs status --run-dir <dir> [--run-dir <dir>]...
  node review-run.mjs cleanup --run-dir <dir> [--yes]
  node review-run.mjs manifest --run-dir <dir> [--seat-transcript <role>=<agent id, .jsonl or auto@<start>/<end>>]... [--seat-usage <role>=<tokens>,<ms>[,clock|estimated]]... [--reviewer-result <role>=<result.json>]... [--extra-artifact <name>=<path>]... [--init]
  node review-run.mjs report   --run-dir <dir> [--format text|chat [--all]] [--notes <file>] [--color auto|always|never] [--out <report.md>] [--json <report.json>] [--html <report.html>] [--change-diff <diff>]...
  node review-run.mjs recheck  --from-run <old-run-dir> --out <new-run-dir>/task-packet.md [--since-diff <diff> | --since-dirs <old> <new>... | --since-commit <commit>] [--preflight <evidence preflight.json>] [--since-only <path>]... [--target <dir>] [--repo-target <old>=<new>]... [--title <text>] [--skip F7,F8] [--drop-tag <tag>]... [--notes <file>] [--round N]
  node review-run.mjs splice   --file <seat file> (--match-heading "## A3" | --match-line <line> | --match-line-file <file>) (--with <reply file> | --with-result <result.json>)
  node review-run.mjs scan     --in <file> [--target-dir <dir>] [--phase1-dir <dir> --forbid-seats A|B|A,B] [--phase2-dir <dir>] [--tokens <a>,<b>] [--target-urls <file>] [--source-dir <dir>]... [--checklist <NAME>]...
  node review-run.mjs verifier-brief --claim <claim block file> --rebuttal <rebuttal file> --target-dir <dir> --out <brief.txt> [--source-dir <dir>]...
  node review-run.mjs audit  --run-dir <dir> --prepare | --finish [--max-wait <seconds>] [--native-done auditor] [--native-agent auditor=<agent id, Codex thread id or rollout path>] [--accept-missing-verifiers] [--accept-drift] [--local]

phase1 --start builds both Phase 1 briefs, starts every CLI seat detached and prints the brief of
each native seat. --wait waits for every seat, publishes file-channel seat output, checks that a
pair-review's seats are distinct, and runs blind-relabel validate.
phase2 --start runs exchange prepare and resumes every CLI seat on its Phase 1 session.
--wait waits, then runs exchange finish. Mode none (pair-review) skips Phase 2.
audit --prepare runs flip and audit-prep and stops, so verifiers can run. --finish builds the
auditor brief, dispatches a CLI auditor (a native auditor is spawned by you: rerun --finish
--native-done auditor once its agent replied written), then translate, scorecard, clear-cache and worktree cleanup.
--accept-drift (phase1 --wait, phase2, audit --finish): a target that changed after the Phase 1 snapshot (for example another
session's edit to files outside this review) is recorded in phase3/drift-accepted.json, which the manifest and the report
show, instead of stopping the step; without it the refusal names the changed files. phase1 --start never accepts it.
manifest writes <run-dir>/manifest.json from the run's files (hashes, run_id, every seat's recorded usage). report prints the
report built from them (--format chat for a chat window; --out, --json, --html also write files). recheck writes a draft
packet for a re-review of an earlier run (the references/phase-3-scorecard.md "Re-review" notes list every option).
splice puts a seat's corrected block back into its file during a redaction round; scan scans a file again (the
phase-2 file's "Redaction scope"). verifier-brief builds one falsification verifier's brief (phase-3 file, falsification).
status prints one line per run folder (its step, and each seat's progress during a phase) and runs nothing; use it for
several runs at once. cleanup lists the seats' scratch folders of a finished run with their sizes; --yes deletes them.
--local adds a first line with the current time on this machine's clock and in UTC.
A native seat's file alone never ends --wait (the agent writes findings as it goes): once its agent
replied "written", pass --native-done with its letter.
phase1, phase2 and audit print at most ${MAX_LINES} lines plus one "next:" line (the other commands print what they\nproduce). Exit 0 done, 1 failed step, 2 bad
arguments, 3 a seat is still running (rerun the same command). --max-wait defaults to ${DEFAULT_MAX_WAIT_S} s.
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
  if (command === 'status') {
    const runDirs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== '--run-dir' || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new UsageError('status takes one or more --run-dir <dir>');
      runDirs.push(rest[++i]);
    }
    if (runDirs.length === 0) throw new UsageError('status takes one or more --run-dir <dir>');
    return { command, runDirs };
  }
  if (command === 'cleanup') {
    const args = { command, runDir: null, yes: false };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--yes') args.yes = true;
      else if (rest[i] === '--run-dir' && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) args.runDir = rest[++i];
      else throw new UsageError('cleanup takes --run-dir <dir> [--yes]');
    }
    if (!args.runDir) throw new UsageError('cleanup takes --run-dir <dir> [--yes]');
    return args;
  }
  if (Object.hasOwn(FORWARD, command)) return { command, forward: rest };
  if (!Object.hasOwn(HALVES, command)) throw new UsageError(`first argument must be phase1, phase2, audit, manifest, report, recheck, splice, scan, verifier-brief, status or cleanup, got "${command}"`);
  const args = { command, runDir: null, half: null, maxWait: DEFAULT_MAX_WAIT_S, nativeDone: [], nativeAgents: {}, acceptMissingVerifiers: false, acceptDrift: false, local: false, incompleteSeat: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run-dir' || a === '--max-wait' || a === '--native-done') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      if (a === '--run-dir') args.runDir = v;
      else if (a === '--native-done') {
        // A repeated flag adds to the list (--native-done A --native-done B), as A,B does.
        const roles = v.split(',').map((s) => s.trim()).filter(Boolean);
        args.nativeDone = [...new Set([...(args.nativeDone ?? []), ...roles])];
        if (roles.length === 0 || args.nativeDone.some((r) => ![...SEATS, 'auditor'].includes(r))) throw new UsageError(`--native-done takes seat letters (${SEATS.join(',')}) or auditor, comma separated`);
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
    } else if (a === '--accept-missing-verifiers') {
      if (command !== 'audit') throw new UsageError('--accept-missing-verifiers is only accepted by audit');
      args.acceptMissingVerifiers = true;
    } else if (a === '--incomplete-seat') {
      // phase2 --wait: a seat whose exchange cannot be resumed; the exchange finishes without it and the review is incomplete.
      const v = rest[++i];
      if (command !== 'phase2') throw new UsageError('--incomplete-seat is only accepted by phase2 --wait');
      if (!SEATS.includes(v)) throw new UsageError(`--incomplete-seat takes one seat letter (${SEATS.join(' or ')})`);
      args.incompleteSeat = v;
    } else if (a === '--accept-drift') {
      if (command !== 'audit' && command !== 'phase1' && command !== 'phase2') throw new UsageError('--accept-drift is only accepted by phase1, phase2 and audit');
      args.acceptDrift = true;
    } else if (HALVES[command].includes(a)) {
      if (args.half !== null) throw new UsageError(`${command} takes exactly one of ${HALVES[command].join(' / ')}`);
      args.half = a.slice(2);
    } else if (a === '--audit-depth' || a.startsWith('--audit-depth=')) {
      throw new UsageError('--audit-depth is gone: every audit re-checks every claim; run the same command without it');
    } else {
      throw new UsageError(`unrecognized argument for ${command}: ${a}`);
    }
  }
  if (!args.runDir) throw new UsageError('--run-dir is required');
  if (args.half === null) throw new UsageError(`${command} needs one of ${HALVES[command].join(' / ')}`);
  if (args.incompleteSeat && args.half !== 'wait') throw new UsageError('--incomplete-seat is only accepted by phase2 --wait');
  return args;
}

// The pipeline steps run in-process; a seat dispatcher is a child process, since it starts and keeps the seat's worker.
const STEPS = { 'blind-relabel.mjs': relabelStep, 'exchange.mjs': exchangeStep, 'build-brief.mjs': briefStep };

async function callStep(name, argv) {
  if (stepsOverride) return stepsOverride(name, argv);
  if (STEPS[name]) {
    const r = await STEPS[name](argv);
    return { status: r.code, stdout: r.stdout, stderr: r.stderr };
  }
  return spawnSync(process.execPath, [path.join(SCRIPTS, name), ...argv], { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 });
}

// A script's output lines without stack frames ("at f (file:1:2)"), so a crash shows its error message, not its last frame.
const outputLines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^at .*(?::\d+:\d+\)?|\(index \d+\)|<anonymous>\)?)$/.test(l));

export function tail(text) {
  return (outputLines(text).at(-1) ?? 'no output').slice(0, 220);
}

// The lines a failing script printed before its last one (progress lines of the exchange left out, its refusals kept):
// the reasons a refusal lists, such as the blind-relabel lines that name the offending line. Each is cut at 160 characters.
export function failureDetail(text) {
  const refusal = (l) => /still names|refus|WARNING/.test(l);
  const lines = outputLines(text).slice(0, -1).map((l, i) => ({ l, i })).filter(({ l }) => !l.startsWith('exchange: ') || refusal(l));
  const first = lines.filter(({ l }) => refusal(l)).slice(-4);
  const kept = new Set([...first, ...lines.filter(({ l }) => !refusal(l)).slice(-(4 - first.length) || lines.length)].map(({ i }) => i));
  const reasons = lines.filter(({ i }) => kept.has(i)).map(({ l }) => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
  return reasons.length > 0 ? ' | reasons: ' + reasons.join(' | ').slice(0, 600) : '';
}

async function runScript(step, name, argv, { allow = [0] } = {}) {
  const r = await callStep(name, argv);
  if (r.error) throw new StepError(step, `could not start ${name}: ${r.error.message}`);
  if (!allow.includes(r.status)) {
    const err = new StepError(step, `${name} exited ${r.status}: ${tail(r.stderr || r.stdout)}${failureDetail(r.stderr || r.stdout)}`);
    // The whole last line, for a message that must not be cut (the reason sent back to the auditor).
    err.lastLine = outputLines(r.stderr || r.stdout).at(-1) ?? '';
    throw err;
  }
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

// A worker that finished between the read and the liveness check looks gone; it wrote its final record before it exited, so
// result.json is read once more before anything acts on a gone worker.
async function recheckGone(file, record) {
  return workerGone(record) ? (await readResultAt(file)) ?? record : record;
}

function endedBadly(record) {
  return Boolean(record) && ((record.status !== 'running' && record.status !== 'completed') || workerGone(record));
}

// A usage limit ends a call cleanly; running the next --wait at once only burns a new session against the same limit.
function rateLimitGate(label, record) {
  if (record?.status !== 'rate-limited') return;
  const deadline = retryDeadline(record.retryAfter, new Date(), { after: record.finishedAt ?? record.startedAt });
  if (deadline && Date.now() < deadline.getTime()) {
    throw new StillRunning(`${label} hit a usage limit until ${record.retryAfter} (this machine's clock); rerun this command after that time, it dispatches a new session then`);
  }
}

async function agentTranscript(value, role) {
  const files = await findAgentTranscripts(value);
  if (files.length === 0) throw new StepError(`native agent ${role}`, `no agent with id ${value} under this host's Claude or Codex transcripts: check the id the Agent tool returned (an id guessed before it returned matches nothing), or pass the transcript .jsonl path`);
  if (files.length !== 1) throw new StepError(`native agent ${role}`, `${value} matched ${files.length} transcripts; pass the transcript .jsonl path instead`);
  return files[0];
}

// A Codex turn that was cut off has ended too; checkFinalReply then refuses its file.
const agentEnded = (state) => state === 'done' || state === 'aborted';

async function agentFinished(value, role, seconds) {
  const files = [await agentTranscript(value, role)];
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (agentEnded(await agentState(files[0]))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// A finished agent whose file has content but whose last reply is "blocked: ..." stopped part way: the file is not a full pass.
// A reply that is not "written" only warns, so an agent that worded its reply differently does not stall a healthy run.
async function checkFinalReply(step, transcript, file, report) {
  if ((await agentState(transcript)) === 'aborted') {
    throw new StepError(step, `its agent's last turn was aborted, so ${file} may be partial; resume the same agent to finish it (never respawn it or write its file by hand), then rerun this command`);
  }
  const reply = await agentLastReply(transcript);
  if (reply !== null && /^\W*blocked\s*:/i.test(reply)) {
    throw new StepError(step, `its agent replied "${reply}", so ${file} is from an unfinished pass. If that reports a tool, shell or permission failure it is a host failure, not a finding: keep the agent and the run folder, report the review incomplete, and resume the same agent when the tools work (never respawn it or write its file by hand)`);
  }
  if (reply !== null && !/\bwritten\b/i.test(reply)) report.lines.push(`warning: ${step}'s agent finished with "${reply}", not "written"; check ${file} is complete before going on`);
  // A turn that ended with no reply at all (the file may be from an earlier turn) gets the same warning.
  if (reply === null) report.lines.push(`warning: ${step}'s agent finished its last turn with no reply, not "written"; check ${file} is complete before going on`);
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
  phase1: (brief, output) => `Read your complete instructions from ${brief} and follow them exactly. Write your findings to ${output}, adding each finding to the file as you confirm it. When finished, reply with only the word written and your finding counts. Do not read any other file in the run folder except the brief, the task packet it names, your own findings file and your own scratch folder. Do not edit any file except your own findings file and the files you create in your own scratch folder. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
  phase2: (brief, output) => `Phase 2. Read your delta brief from ${brief} and follow it exactly. Write your rebuttal entries to ${output} in one write at the end. Do not read any other file in the run folder except the delta brief, your Phase 1 brief, the task packet, your rebuttal file and your own scratch folder. Do not edit any file except your rebuttal file and the files you create in your own scratch folder. Reply with only the word written and your concede / dispute counts. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
  auditor: (brief, output) => `You are a fresh independent auditor. Read your complete instructions from ${brief} and follow them exactly. Write your result to ${output} in one write at the end, in the brief's JSON schema: every finding object has an "id" ("F1", "F2", ...) and every key the schema shows. Read only the files the brief names. Do not edit any other file. Reply with only the word written and one line of counts. If you cannot read the brief or write the file, reply with blocked: and the error message, then stop.`,
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

// The files that changed since preflight recorded fingerprint-files.json, or null for a run without that record.
async function driftList(desc) {
  const before = await readResultAt(path.join(desc.runDir, 'fingerprint-files.json'));
  if (!before || typeof before.files !== 'object') return null;
  return driftedFiles(before, await fingerprintFiles(desc.targetDir));
}

// With acceptDrift (audit --finish --accept-drift) a changed target is recorded in phase3/drift-accepted.json, which
// the manifest and the report show, instead of stopping the run.
async function assertFingerprint(desc, { acceptDrift = false, report = null, step = 'phase' } = {}) {
  acceptDrift = acceptDrift || report?.acceptDrift === true;
  await warnExtraRepos(desc);
  if (!desc.fingerprint?.snapshotHash) return;
  const current = await computeSnapshotHash(desc.targetDir);
  if (current === desc.fingerprint.snapshotHash) return;
  const files = await driftList(desc);
  const named = files === null ? 'the changed files are not recorded for this run' : files.length > 0 ? `changed: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}` : 'no listed file differs (a folder or link changed)';
  if (acceptDrift) {
    const record = path.join(desc.runDir, 'phase3', 'drift-accepted.json');
    const earlier = await readResultAt(record);
    const entries = Array.isArray(earlier?.accepted) ? earlier.accepted : [];
    // The same drift seen again by a later check of this command or a rerun is recorded once.
    if (JSON.stringify(entries.at(-1)?.files) !== JSON.stringify(files ?? [])) {
      entries.push({ at: new Date().toISOString(), step, files: files ?? [] });
      await fs.mkdir(path.dirname(record), { recursive: true });
      await fs.writeFile(record, `${JSON.stringify({ accepted: entries }, null, 2)}\n`, 'utf8');
    }
    // One line per command: the check runs at several points of one audit --finish.
    if (report && !report.driftNoted) {
      report.driftNoted = true;
      report.lines.push(`warning: the target changed after Phase 1 (${named}); accepted with --accept-drift and recorded for the manifest and report; ${step === 'audit' ? 'the auditor reads the current target, so it may have read the changed files' : 'a seat still working may have read the changed files'}`);
    }
    return;
  }
  const err = new StepError('fingerprint', `the target no longer matches the fingerprint recorded for Phase 1 (${named}); the review describes the Phase 1 snapshot`);
  err.next = step === 'audit'
    ? `if those files are outside what this review covers, rerun: review-run audit --run-dir ${desc.runDir} --finish --accept-drift (the manifest and the report record the drift); otherwise restore them, or start a new run`
    : step === 'phase1' || step === 'phase2'
    ? `if those files are outside what this review covers (another session's work), rerun this command with --accept-drift (the manifest and the report record the drift); otherwise restore them, or start a new run`
    : 'restore those files and rerun this command, or start a new run (the seats must review one snapshot)';
  throw err;
}

// A header-only file is not a finished seat: Phase 1 needs one of the seat's own claim headings or the No findings heading, Phase 2 one P block.
function hasClaimHeading(text, phase, role) {
  if (phase === 'phase1') return hasPassContent(text, role);
  return parseFenceLines(text).lines.some((l) => !l.inFence && /^###?\s+P\d+\b/.test(l.text));
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
function timeoutFlags(desc) {
  return ['--timeout', String(desc.flags.timeoutS ?? 0)];
}

// Outside checklist labels (flags.checklists) the scanner and validator should not read as claim IDs.
function checklistFlags(desc) {
  return (desc.flags.checklists ?? []).flatMap((name) => ['--checklist', name]);
}

function sourceFlags(desc) {
  return (desc.sourceDirs ?? []).flatMap((d) => ['--source-dir', d]);
}

// preflight wrote review-rules.md (the repositories' REVIEW.md text) when run.json has reviewRules.
function rulesFlags(desc) {
  return desc.reviewRules ? ['--rules', path.join(desc.runDir, 'review-rules.md')] : [];
}

function effortFlags(actor) {
  return actor.effort && actor.effort !== 'default' ? ['--effort', actor.effort] : [];
}

// run.json's env setting for a CLI actor (names only), as its dispatcher's flags.
function envFlags(actor) {
  const env = actor.env ?? {};
  return [...(env.mode === 'inherit' ? ['--env-mode', 'inherit'] : []), ...(env.pass?.length > 0 ? ['--env-passthrough', env.pass.join(',')] : []), ...(env.apiKey === true ? ['--use-api-key'] : [])];
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
  return { claude: 'claude-dispatch.mjs', codex: 'codex-dispatch.mjs' }[actor.runtime];
}

// The session to resume: from previousResult when the caller kept one (a rewrite's own failed attempt may have no id),
// else from the Phase 1 result.json, else from run.json.
async function previousSession(desc, role, phase, resume = phase !== 'phase1', previousResult = null) {
  const actor = desc[`seat${role}`];
  if (!resume) return { session: null, previous: null, worktree: (await readResultAt(resultFile(desc, 'phase1', role)))?.worktreePath ?? actor.worktreePath };
  const current = resultFile(desc, 'phase1', role);
  for (const file of previousResult ? [previousResult, current] : [current]) {
    const record = (await readResultAt(file)) ?? {};
    const session = record.sessionId ?? record.threadId;
    if (session) return { session, previous: file, worktree: record.worktreePath ?? actor.worktreePath };
  }
  if (!actor.sessionId) throw new StepError(`resume seat ${role}`, `no session id for seat ${role} in ${previousResult ? `${previousResult}, ` : ''}${current} or run.json; Phase 1 must have completed`);
  return { session: actor.sessionId, previous: previousResult ?? current, worktree: actor.worktreePath };
}

async function startSeat(desc, role, phase, brief, { resume = phase !== 'phase1', previousResult = null } = {}) {
  const actor = desc[`seat${role}`];
  const web = desc.flags.repoOnly !== true;
  const found = await previousSession(desc, role, phase, resume, previousResult);
  const { session, worktree } = found;
  const previous = previousResult ?? found.previous;
  const raw = canonicalPath(desc, phase, role);
  let argv;
  if (actor.runtime === 'claude') {
    argv = ['--brief', brief, '--cd', desc.targetDir, '--model', actor.model, ...effortFlags(actor), ...envFlags(actor), '--out-dir', seatOutputDir(desc, phase, role),
      ...sourceFlags(desc), ...(session ? ['--session', session] : []), ...(worktree ? ['--worktree', worktree] : []), ...(web ? ['--web'] : []), ...timeoutFlags(desc),
      ...(channelFor(actor, desc.host) === 'final-message' ? ['--final-message-out', raw] : []), '--detach'];
  } else if (actor.runtime === 'codex') {
    argv = ['--brief', brief, '--cd', desc.targetDir, ...(session ? ['--session', session, '--previous-result', previous] : ['--sandbox', 'read-only']),
      '--model', actor.model, ...effortFlags(actor), ...envFlags(actor), ...(web ? ['--web'] : []), ...timeoutFlags(desc), '--final-message-out', raw, '--detach'];
  } else {
    throw new StepError(`start seat ${role}`, `no dispatcher is defined for runtime "${actor.runtime}"`);
  }
  await runScript(`start seat ${role}`, dispatcherFor(actor), argv);
}

async function waitCli(desc, role, phase, maxWait) {
  const r = await runScript(`wait seat ${role}`, dispatcherFor(desc[`seat${role}`]), ['--wait', resultFile(desc, phase, role), '--max-wait', String(maxWait)], { allow: [0, 3] });
  return r.status === 0;
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
      const prior = await recheckGone(resultFile(desc, phase, role), await readResult(desc, phase, role));
      rateLimitGate(`seat ${role}`, prior);
      const brief = path.join(dispatchDir(desc, phase, role), phase === 'phase1' ? 'brief.txt' : 'delta-brief.txt');
      // No result.json and no dispatcher record: an earlier --start stopped before it started this seat, and a second
      // phase2 --start cannot help (exchange prepare refuses to run twice), so the seat is started here from its brief.
      // Only an absent result.json: one that exists but cannot be read yet belongs to a seat that is running.
      let neverStarted = false;
      if (!prior && !(await exists(resultFile(desc, phase, role)))) {
        const shared = briefOf(desc, role)[0];
        if (phase === 'phase2' && !(await exists(brief)) && await exists(shared)) {
          await fs.mkdir(path.dirname(brief), { recursive: true });
          await fs.copyFile(shared, brief);
        }
        neverStarted = await exists(brief);
      }
      if (endedBadly(prior) || neverStarted) {
        stopRecordedChild(prior);
        await checkTouched(`seat ${role}`, resultFile(desc, phase, role));
        await assertFingerprint(desc, { report, step: phase });
        // A format rewrite that failed is dispatched again as the rewrite, on the same session, not as a new pass.
        const rewriteBrief = path.join(dispatchDir(desc, phase, role), 'rewrite-brief.txt');
        const rewriting = phase === 'phase1' && Boolean((await readResultAt(rewritesFile(desc)))?.[role]) && (await exists(rewriteBrief));
        if (rewriting) await startSeat(desc, role, phase, rewriteBrief, { resume: true, previousResult: path.join(dispatchDir(desc, phase, role), 'result.before-rewrite.json') });
        else await startSeat(desc, role, phase, brief);
        report.lines.push(prior
          ? `seat ${role}: previous attempt ended with status ${endedAs(prior)}; dispatched again (the earlier result is kept as an attempt file)`
          : `seat ${role}: not started by an earlier --start (no result.json); dispatched now`);
      }
      let done;
      try {
        // At least 1 s: a dispatcher's --wait reads 0 as "wait without limit".
        done = await waitCli(desc, role, phase, Math.max(1, budget()));
      } catch (err) {
        // A failed attempt whose output stayed open is recorded too: a process it started may still be running.
        await noteAnswerStop(desc, await readResult(desc, phase, role), `seat ${role}`, phase, report);
        if (err instanceof StepError) throw new StepError(err.step, `${err.message}; rerunning this command dispatches seat ${role} again`);
        throw err;
      }
      if (!done) throw new StillRunning(`seat ${role} (${actor.runtime}) is still running; rerun this command`);
      const note = await checkTouched(`seat ${role}`, resultFile(desc, phase, role));
      report.lines.push(`seat ${role}: completed (cli ${actor.runtime})${note ? `; ${note}` : ''}`);
      await noteAnswerStop(desc, await readResult(desc, phase, role), `seat ${role}`, phase, report);
    } else {
      const file = nativeOutput(role);
      const declared = nativeDone.includes(role);
      const transcript = !declared && nativeAgents[role] ? await agentTranscript(nativeAgents[role], role) : null;
      // An agent declared finished gets only the final write's grace, not the whole wait budget.
      const state = await waitForNative(file, phase, role, declared ? Math.min(budget(), fileGraceS()) : budget(), transcript ? async () => agentEnded(await agentState(transcript)) : null);
      if (declared && (state === 'missing' || state === 'no-claims')) {
        throw new StepError(`seat ${role}`, `--native-done ${role} says its agent finished, but ${file} ${state === 'missing' ? 'does not exist' : `has no claim heading (${phase === 'phase1' ? `"## ${role}<n>" or "## No findings"` : '"### P<n>"'})`}; return the file to the seat to rewrite (do not hand-edit), or drop --native-done ${role} if it is still working`);
      }
      if (state === 'agent-ended') {
        const reply = await agentLastReply(transcript);
        throw new StepError(`seat ${role}`, `its agent finished without a usable ${file}; last reply: ${reply === null ? '(none found)' : `"${reply}"`}. If that reports a tool, shell or permission failure it is a host failure, not a finding: keep the agent and the run folder, report the review incomplete, and resume the same agent when the tools work (never respawn it or write its file by hand). Otherwise return the file to the agent`);
      }
      // With the agent's transcript known the seat was spawned; only a seat with no known agent may still need spawning.
      // An ended agent is only reported as such after the file's grace time (fileGraceS), so a short --max-wait can stop first.
      if (state === 'missing' && transcript && agentEnded(await agentState(transcript))) {
        throw new StillRunning(`seat ${role}: its agent's transcript shows it finished, but ${file} is not there yet; rerun this command with --max-wait ${fileGraceS() + 5} or more, so the final write has its ${fileGraceS()} s grace and an agent that ended without it is reported with its last reply`);
      }
      if (state === 'missing') throw new StillRunning(transcript
        ? `seat ${role}: its agent is still working and has not written ${file} yet; rerun this command, the agent id stays remembered`
        : `native seat ${role} has not written ${file}; spawn it with its brief if not done, then rerun this command`);
      if (state === 'no-claims' && transcript && !agentEnded(await agentState(transcript))) {
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
          await checkFinalReply(`seat ${role}`, await agentTranscript(nativeAgents[role], role), file, report);
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

// A CLI seat with a result.json was already started; --wait owns every retry.
async function alreadyStarted(desc, role, phase) {
  const record = await readResultAt(resultFile(desc, phase, role));
  return record ? `result.json says ${record.status}` : null;
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
  // Free check of the paths the packet names: another review's run folder holds that run's findings, and a Linux Codex
  // read-only sandbox was seen refusing a path outside the target (Permission denied).
  const reach = await packetReach(await fs.readFile(task, 'utf8').catch(() => ''), { cdAbs: desc.targetDir, runDir: desc.runDir });
  if (reach.notFound.length > 0) report.lines.push(`warning: the packet names ${reach.notFound.length} path(s) that do not exist here (${reach.notFound.slice(0, 2).join(', ')}${reach.notFound.length > 2 ? ', ...' : ''}); no seat can read them`);
  for (const { path: p, run } of reach.otherRuns.slice(0, 2)) report.lines.push(`warning: the packet names ${p}, inside another review's run folder ${run}; the seats can read that run's findings there (fine for a re-review that means to)`);
  const codexSeat = SEATS.some((role) => desc[`seat${role}`].runtime === 'codex' && isCli(desc[`seat${role}`]));
  const tools = await readResultAt(path.join(desc.runDir, 'seat-tools.json'));
  const cannot = Object.entries(tools && typeof tools === 'object' ? tools : {}).filter(([, v]) => v?.ok === false).map(([k]) => k);
  if (codexSeat && cannot.length > 0) report.lines.push(`warning: preflight found that the Codex seat's sandbox cannot run ${cannot.join(', ')} (seat-tools.json); it reviews those parts by reading only`);
  // A reach probe of this run that read a path already answers for it: only the paths it did not read are named.
  const probe = await readResultAt(path.join(desc.runDir, 'reach-probe.json'));
  const read = new Set((probe?.ran === true && Array.isArray(probe.results) ? probe.results : []).filter((r) => r?.ok === true && typeof r.item === 'string' && r.item.startsWith('READ ')).map((r) => r.item.slice(5)));
  const unread = reach.outside.filter((p) => !read.has(p));
  const outsideWarning = codexSeat ? outsideReadWarning(unread) : null;
  if (outsideWarning) report.lines.push(`warning: ${outsideWarning.replace('--host ...', `--host ${desc.host} --cd <target> --run-dir ${desc.runDir}`)} (no reach probe of this run read them)`);
  for (const role of SEATS) {
    const actor = desc[`seat${role}`];
    const cli = isCli(actor);
    const channel = channelFor(actor, desc.host);
    const earlier = cli ? await alreadyStarted(desc, role, 'phase1') : null;
    if (earlier) {
      report.lines.push(`seat ${role}: already started (${earlier}); not started again, --wait handles a failed one`);
      continue;
    }
    // A seat started again, or a brief built again, makes an earlier "Phase 1 finished" record stale.
    await fs.rm(phase1DoneFile(desc), { force: true });
    const brief = cli ? path.join(dispatchDir(desc, 'phase1', role), 'brief.txt') : path.join(desc.runDir, 'phase1', `brief-${role}.txt`);
    await fs.mkdir(path.dirname(brief), { recursive: true });
    if (cli && channel === 'file') await fs.mkdir(seatOutputDir(desc, 'phase1', role), { recursive: true });
    const output = channel !== 'file' ? [] : ['--output-path', cli ? privateOutputPath(desc, 'phase1', role) : canonicalPath(desc, 'phase1', role)];
    await runScript(`build seat ${role} brief`, 'build-brief.mjs', ['--mode', 'phase1', '--packet', task, '--seat', role, '--out', brief, '--channel', channel, '--run-dir', desc.runDir, '--target-dir', desc.targetDir, ...output,
      ...(desc.flags.repoOnly === true ? ['--repo-only'] : []), ...rulesFlags(desc)]);
    if (cli) {
      await startSeat(desc, role, 'phase1', brief);
      report.lines.push(`seat ${role}: started (cli ${actor.runtime}, ${channel} channel); status record ${resultFile(desc, 'phase1', role)}`);
    } else {
      const prompt = await writePrompt(desc, 'phase1', role, brief, canonicalPath(desc, 'phase1', role));
      report.lines.push(`seat ${role}: native ${actor.runtime}; spawn it with brief ${brief}; it writes ${canonicalPath(desc, 'phase1', role)}; prompt to give it: ${prompt}`);
    }
  }
  const native = SEATS.some((role) => !isCli(desc[`seat${role}`]));
  report.next = `${native ? 'spawn each native seat, then run' : 'run'}: review-run phase1 --run-dir ${desc.runDir} --wait${native ? ' --native-agent <seat>=<agent id> (it waits on the agent itself; or --native-done <seat> once the agent replied "written")' : ''}`;
}

const NO_FINDINGS_RE = /^##\s+No findings\s*$/;
const SEAT_EXEC_FAILED_RE = /exec_command failed|failed to create unified exec process|CreateProcess \{/gi;

export function execFailureCount(stderrText) {
  // One failed command logs one line that can match several patterns, so lines are counted, not matches.
  return String(stderrText ?? '').split(/\r?\n/).filter((line) => line.match(SEAT_EXEC_FAILED_RE)).length;
}

// How much a Phase 1 seat did: its claim headings and the queries plus fetches on its "web:" line (null when it has none).
export function seatDepth(text, role) {
  const own = parseFenceLines(String(text ?? '')).lines.filter((l) => !l.inFence).map((l) => l.text);
  const web = own.map((l) => /^web:\s*(\d+)\s+quer\w*,\s*(\d+)\s+page/i.exec(l.trim())).find(Boolean);
  return { claims: parseSeatFile(text, role).claims.length, web: web ? Number(web[1]) + Number(web[2]) : null };
}

// A seat far below its peer (a quarter or less of the claims, and of the web use when both report it) may have stopped early
// without hitting a sandbox error: a field run passed one 61-second, one-claim seat as clean. Only a warning, never a failure.
export function shallowSeatNote([a, b]) {
  // Claims and web use are separate signals: either gap alone (a quarter or less of the peer's) is worth a look.
  const gap = (x, y, floor) => (x === null || y === null ? null : x >= floor && y * 4 <= x ? 'B' : y >= floor && x * 4 <= y ? 'A' : null);
  const claimLow = gap(a.claims, b.claims, 4);
  const webLow = gap(a.web, b.web, 8);
  const low = claimLow ?? webLow;
  if (!low) return null;
  const [lo, hi, peer] = low === 'A' ? [a, b, 'B'] : [b, a, 'A'];
  const parts = [...(claimLow === low ? [`${lo.claims} claim(s) against seat ${peer}'s ${hi.claims}`] : []), ...(webLow === low ? [`web use ${lo.web} against ${hi.web}`] : [])];
  return `seat ${low} did far less than seat ${peer} (${parts.join('; ')}); check seat ${low}'s Checks performed for an early stop before trusting its share of the result`;
}

// A CLI stopped after its answer (its dispatcher's result.json says so) is noted; one whose output stayed open after the
// stop may have left a process running: that is a warning, and stop-incomplete.json carries it to the manifest and report.
async function noteAnswerStop(desc, record, who, step, report) {
  if (record?.stoppedAfterAnswer) report.lines.push(`${who}: ran on past its final answer; the answer was kept`);
  if (record?.leftoversStopped?.length > 0) report.lines.push(`${who}: its CLI left ${record.leftoversStopped.length} process(es) running; they were stopped`);
  if (typeof record?.jobRefused === 'string') report.lines.push(`warning: ${who} could not run in a job object (${record.jobRefused.slice(0, 120)}); a process it started can outlive it`);
  if (!record?.stopIncomplete) return;
  report.lines.push(record.stoppedAfterAnswer
    ? `warning: ${who}'s output stayed open after its answer: a process it started may still be running; check the process list`
    : `warning: ${who} exited without an answer, but its output stayed open: a process it started may still be running; check the process list`);
  const file = path.join(desc.runDir, 'stop-incomplete.json');
  const seen = (await readResultAt(file)) ?? {};
  await fs.writeFile(file, `${JSON.stringify({ ...seen, [`${who} (${step})`]: true }, null, 2)}\n`, 'utf8');
}

// Runs after the format check, so each file has exactly one Blocked: line. A No findings seat that names a block, or whose
// stderr shows failed commands, is incomplete; a seat with claims and a block gets the "may have reviewed blind" caveat.
async function assertSeatsRan(desc, report) {
  const blind = {};
  for (const role of SEATS) {
    const findings = await fs.readFile(canonicalPath(desc, 'phase1', role), 'utf8').catch(() => '');
    const record = isCli(desc[`seat${role}`]) ? await readResult(desc, 'phase1', role) : null;
    const stderr = isCli(desc[`seat${role}`]) ? await fs.readFile(record?.stderrLog ?? path.join(dispatchDir(desc, 'phase1', role), 'result.stderr.log'), 'utf8').catch(() => '') : '';
    const failures = execFailureCount(stderr);
    const { blocked, section } = parseSeatFile(findings, role);
    const incomplete = 'This is an incomplete seat, not a clean result: fix the cause, keep the run folder, and run the seat again in a new run; do not continue with one seat\'s verdict as a two-seat review';
    // The next: line says the same as the message: a new run, never a rerun of this --wait (it would stop the same way).
    const newRun = (message) => Object.assign(new StepError(`seat ${role}`, message), { next: `fix what blocked seat ${role}, then start a new run with the same packet (preflight --host ... --run-dir <a new run folder>); keep ${desc.runDir} as it is` });
    if (section === 'No findings') {
      if (blocked) throw newRun(`wrote "No findings" but says it was blocked ("Blocked: ${blocked.slice(0, 160)}"). ${incomplete}`);
      const failed = String(stderr).match(SEAT_EXEC_FAILED_RE);
      if (failed) throw newRun(`wrote "No findings" but its stderr shows "${failed[0].trim()}" (it could not run commands). ${incomplete}`);
    }
    if (failures > 0) report.lines.push(`warning: seat ${role} logged ${failures} exec_command failure(s) in its stderr; its sandbox was unstable, so its verdict may rest on fewer checks than it states`);
    if (blocked) {
      blind[role] = [`Blocked: ${blocked.length > 192 ? `${blocked.slice(0, 189)}...` : blocked}`];
      report.lines.push(`warning: seat ${role} says it was blocked: "${blind[role][0].slice(0, 140)}"; check its Checks performed before trusting a short or clean result`);
    }
  }
  const depth = await Promise.all(SEATS.map(async (role) => seatDepth(await fs.readFile(canonicalPath(desc, 'phase1', role), 'utf8').catch(() => ''), role)));
  const note = shallowSeatNote(depth);
  if (note) report.lines.push(`warning: ${note}`);
  // The manifest copies this, and the report shows it as a caveat.
  const file = path.join(desc.runDir, 'seat-warnings-phase1.json');
  if (Object.keys(blind).length > 0) await fs.writeFile(file, `${JSON.stringify({ blind }, null, 2)}\n`, 'utf8');
  else await fs.rm(file, { force: true });
}

const rewritesFile = (desc) => path.join(desc.runDir, 'phase1', 'rewrites.json');
const refusedFile = (desc) => path.join(desc.runDir, 'phase1', 'format-refused.json');

// The strict format check: a refused seat file goes back to its seat once, for one rewrite (a CLI seat is resumed on its
// Phase 1 session, a native one gets a message file); refused again after that, the seat is incomplete and so is the review.
// A seat's live worker is asked to stop first (on SIGTERM it stops its CLI's tree and what that left, by group and by run id),
// and killed if it is still there 10 s later. Windows stops the worker's tree and its CLI's job at once.
async function stopSeatWorker(record) {
  if (process.platform !== 'win32' && recordedWorkerProven(record)) {
    try { process.kill(record.workerPid, 'SIGTERM'); } catch { /* it exited meanwhile */ }
    for (let i = 0; i < 50 && processExists(record.workerPid); i += 1) await new Promise((r) => setTimeout(r, 200));
    if (!processExists(record.workerPid)) return true;
  }
  return stopRecordedWorker(record);
}

// The section format and the claim-level defects the validate step finds (a missing or invalid field, a duplicate or
// malformed heading, an unterminated fence, a peer's claim ID in code) get the same one rewrite.
async function checkSeatFormat(desc, report) {
  const refused = [];
  const texts = {};
  for (const role of SEATS) {
    const text = await fs.readFile(canonicalPath(desc, 'phase1', role), 'utf8').catch(() => null);
    if (text !== null) texts[role] = text;
  }
  // An unreadable target or source folder stops the step with its FAILED and next: lines, not a stack trace.
  const claims = Object.keys(texts).length > 0
    ? await seatClaimProblems(texts, { targetDir: desc.targetDir, sourceDirs: desc.sourceDirs ?? [] }).catch((err) => { throw new StepError('seat format', err.message); })
    : {};
  for (const role of SEATS) {
    const problems = [...parseSeatFile(texts[role] ?? '', role).problems, ...(claims[role] ?? [])];
    if (problems.length > 0) refused.push({ role, problems });
  }
  if (refused.length === 0) return;
  const rewrites = (await readResultAt(rewritesFile(desc))) ?? {};
  const again = refused.filter(({ role }) => rewrites[role]);
  if (again.length > 0) {
    await fs.writeFile(refusedFile(desc), `${JSON.stringify(Object.fromEntries(again.map(({ role, problems }) => [role, problems])), null, 2)}\n`, 'utf8');
    const err = new StepError('seat format', `seat ${again.map((r) => r.role).join(' and ')}'s file was refused again after its one rewrite (${again[0].problems[0].slice(0, 160)}): the review is INCOMPLETE, recorded in ${refusedFile(desc)}`);
    err.next = `report the review as INCOMPLETE: run review-run manifest --run-dir ${desc.runDir}, then review-run report --run-dir ${desc.runDir} (both record the refusal); a new run starts the seats again`;
    throw err;
  }
  // Each seat's rewrite is recorded as soon as it is sent, so a failure for the other seat cannot give it a second one.
  for (const { role, problems } of refused) {
    await requestRewrite(desc, role, problems, report);
    rewrites[role] = { at: new Date().toISOString(), problems };
    await fs.writeFile(rewritesFile(desc), `${JSON.stringify(rewrites, null, 2)}\n`, 'utf8');
  }
  await fs.rm(phase1DoneFile(desc), { force: true });
  throw new StillRunning(refused.length > 1
    ? `seats ${refused.map((r) => r.role).join(' and ')} rewrite their refused findings files (one rewrite each; the reasons are in ${rewritesFile(desc)})`
    : `seat ${refused[0].role} rewrites its refused findings file (one rewrite; the reasons are in ${rewritesFile(desc)})`);
}

// The refused file is kept as <role>-findings.refused.md; the seat writes its whole file again in the strict format.
async function requestRewrite(desc, role, problems, report) {
  const actor = desc[`seat${role}`];
  const canonical = canonicalPath(desc, 'phase1', role);
  const output = isCli(actor) && channelFor(actor, desc.host) === 'file' ? privateOutputPath(desc, 'phase1', role) : canonical;
  const refusedCopy = path.join(path.dirname(canonical), `${role}-findings.refused.md`);
  await fs.rename(canonical, refusedCopy);
  const nl = String.fromCharCode(10);
  const file = channelFor(actor, desc.host) === 'file';
  const where = file ? `Write it again to ${output} in one write` : 'Reply with the whole file again as your final message';
  const text = [
    'Your Phase 1 findings file was refused by the review\'s format check:',
    ...problems.map((p) => `- ${p}`),
    '',
    `${where}, in the format your Phase 1 brief gives: each claim under "## ${role}<n> ...", then exactly "## Checks performed" (or only "## No findings" when you have no claim), and in that section exactly one line "Blocked: none" or "Blocked: <what>: <the error>"; every claim has a "Same shape elsewhere:" line (the other places with the same shape, or "none found" and what you searched). Quote any other Blocked text inside a code fence. Add a missing required line; change nothing else: keep every claim, its fields, evidence and wording. This is the only rewrite.`,
    file ? 'Reply with only the word written when the file is written.' : 'Your final message is the whole file and nothing else.',
    '',
  ].join(nl);
  if (isCli(actor)) {
    const brief = path.join(dispatchDir(desc, 'phase1', role), 'rewrite-brief.txt');
    await fs.writeFile(brief, text, 'utf8');
    // The dispatcher moves result.json aside as an attempt file; a copy keeps the earlier call for the usage delta.
    const previousResult = path.join(dispatchDir(desc, 'phase1', role), 'result.before-rewrite.json');
    await fs.copyFile(resultFile(desc, 'phase1', role), previousResult).catch((err) => {
      report.lines.push(`warning: seat ${role}: its Phase 1 result.json was not copied for the rewrite (${err.code ?? err.message}); the rewrite's own token count may be unknown`);
    });
    try {
      await startSeat(desc, role, 'phase1', brief, { resume: true, previousResult });
    } catch (err) {
      // A rewrite that could not be sent leaves the run as it was, so a rerun asks for it again.
      await fs.rename(refusedCopy, canonical);
      throw err;
    }
    report.lines.push(`seat ${role}: its file was refused (${problems.length} reason(s), e.g. ${problems[0].slice(0, 90)}); resumed once to rewrite it`);
  } else {
    const prompt = path.join(desc.runDir, 'phase1', `prompt-rewrite-${role}.txt`);
    await fs.writeFile(prompt, text, 'utf8');
    report.lines.push(`seat ${role}: its file was refused (${problems.length} reason(s), e.g. ${problems[0].slice(0, 90)}); send its agent the message in ${prompt}`);
  }
}

// A wait rerun after a later step finished repeats nothing and points to the step after that one: the audit's
// findings.json, or the exchange-result.json that exchange finish writes. Only a file that parses as a JSON object counts:
// an empty or cut-off one is a step that did not finish.
// A finished step's record: a JSON object with a field that step always writes (an empty object is not finished; an older
// exchange record has its counts but no appended list).
const RECORD_FIELD = { 'findings.json': (d) => Array.isArray(d.findings), 'exchange-result.json': (d) => Array.isArray(d.appended) || typeof d.concede === 'number', 'manifest.json': (d) => typeof d.status === 'string' };
async function finishedRecord(file) {
  const data = await readResultAt(file);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  return (RECORD_FIELD[path.basename(file)] ?? (() => true))(data);
}

async function laterStepDone(desc, phase, report) {
  if (await finishedRecord(path.join(desc.runDir, 'phase3', 'findings.json'))) {
    report.lines.push(`${phase}: already done, and the audit has finished; nothing was run`);
    // The finished result was checked against the target when it was written; a later change does not make it wrong.
    if (desc.fingerprint?.snapshotHash && (await computeSnapshotHash(desc.targetDir).catch(() => null)) !== desc.fingerprint.snapshotHash) {
      report.lines.push('note: the target changed after the review finished; the results describe the Phase 1 snapshot');
    }
    report.next = `run: review-run manifest --run-dir ${desc.runDir}, then review-run report --run-dir ${desc.runDir}`;
    return true;
  }
  const exchangeFile = path.join(desc.runDir, 'phase2', 'exchange-result.json');
  if (await finishedRecord(exchangeFile)) {
    report.lines.push(`${phase}: already done (exchange finished); nothing was run`);
    report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
    return true;
  }
  return false;
}

async function phase1Wait(desc, args, report) {
  if (await laterStepDone(desc, 'phase1', report)) return;
  await waitSeats(desc, 'phase1', SEATS, args.maxWait, report, (role) => canonicalPath(desc, 'phase1', role), args.nativeDone, args.nativeAgents);
  await assertFingerprint(desc, { report, step: 'phase1' });
  for (const role of SEATS) {
    const actor = desc[`seat${role}`];
    if (isCli(actor) && channelFor(actor, desc.host) === 'file') report.lines.push(`seat ${role}: published ${path.basename(canonicalPath(desc, 'phase1', role))} (${await publishOnce(desc, 'phase1', role)})`);
    else await requireFile(`seat ${role} output`, canonicalPath(desc, 'phase1', role), `seat ${role}'s findings`);
  }
  await checkSeatFormat(desc, report);
  await assertSeatsRan(desc, report);
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
  const validated = await runScript('validate Phase 1', 'blind-relabel.mjs', ['validate', '--phase1-dir', path.join(desc.runDir, 'phase1'), '--target-dir', desc.targetDir, ...sourceFlags(desc), ...checklistFlags(desc),
    ...((await exists(task)) ? ['--packet', task] : [])]);
  const validateWarnings = String(validated.stderr ?? '').split(/\r?\n/).filter((line) => line.includes('WARNING: ')).map((line) => line.slice(line.indexOf('WARNING: ') + 9));
  const firstWarning = validateWarnings[0]?.length > 160 ? `${validateWarnings[0].slice(0, 157)}...` : validateWarnings[0];
  report.lines.push(validateWarnings.length === 0 ? 'validate Phase 1: clean'
    : `validate Phase 1: clean, ${validateWarnings.length} warning(s), e.g. ${firstWarning}`);
  report.next = skillName === 'pair-review' && desc.flags.mode === 'none'
    ? `mode none skips Phase 2: run review-run audit --run-dir ${desc.runDir} --prepare`
    : `run: review-run phase2 --run-dir ${desc.runDir} --start`;
  // status reads this: a validated Phase 1 otherwise looks the same as one still running.
  await fs.writeFile(phase1DoneFile(desc), `${JSON.stringify({ at: new Date().toISOString(), next: report.next }, null, 2)}\n`, 'utf8');
}

function phase1DoneFile(desc) {
  return path.join(desc.runDir, 'phase1-done.json');
}

function skipsPhase2(desc) {
  return skillName === 'pair-review' && desc.flags.mode === 'none';
}

function briefOf(desc, role) {
  const p2 = path.join(desc.runDir, 'phase2');
  return [path.join(p2, `delta-brief-${role}.txt`), path.join(p2, role, 'delta-brief.txt')];
}

// A seat's Phase 1 scratch folder left in the run folder (test files, a link, a mock run with peer-named files) would stop
// the exchange's grant check: it is moved beside the run folder, to <run-dir>-scratch-kept, and kept.
// Whether dir is the real folder expected (no link or junction at it or above it inside the run): null when it does not exist.
// expected is compared as written: resolving it again would follow the same link (a linked phase folder hides its seat folders).
async function isOwnFolder(dir, expected) {
  // Only a missing folder is skipped quietly: an access or I/O error stops the step instead of reading as "nothing here".
  const real = await fs.realpath(dir).catch((err) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new StepError('scratch folders', `cannot read ${dir}: ${err.code ?? err.message}`);
  });
  // A dangling link is still a link, not a missing folder.
  if (real === null) return (await fs.lstat(dir).catch(() => null)) === null ? null : false;
  const same = (a, b) => (foldsCase() ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(path.resolve(real), path.resolve(expected)) && (await fs.lstat(dir)).isDirectory();
}

async function moveLeftoverScratch(desc, report) {
  const kept = `${desc.runDir}-scratch-kept`;
  // Folder to the seat that owns it; the shared phase1 folder has none.
  const dirs = new Map([[path.join(desc.runDir, 'phase1'), null], ...SEATS.map((role) => [seatOutputDir(desc, 'phase1', role), role])]);
  const realRun = await fs.realpath(desc.runDir);
  // The destination too: a linked <run-dir>-scratch-kept would move the scratch folders into the link's target.
  if ((await isOwnFolder(kept, path.join(await fs.realpath(path.dirname(desc.runDir)), path.basename(kept)))) === false) {
    report.lines.push(`warning: ${kept} is a link or lies behind one; no scratch folder was moved there`);
    return;
  }
  for (const [dir, role] of dirs) {
    // A linked phase or seat folder is not searched: its target's scratch folders are not this run's to move.
    if ((await isOwnFolder(dir, path.join(realRun, path.relative(desc.runDir, dir)))) === false) {
      report.lines.push(`warning: ${dir} is a link or lies behind one; nothing under it was moved`);
      continue;
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^scratch-[0-9a-f]{8}$/.test(entry.name)) continue;
      await fs.mkdir(kept, { recursive: true });
      let to = path.join(kept, entry.name);
      for (let n = 2; await exists(to); n += 1) to = path.join(kept, `${entry.name}-${n}`);
      await fs.rename(path.join(dir, entry.name), to);
      report.lines.push(`${role ? `seat ${role}'s` : "a seat's"} scratch folder ${entry.name} was moved out of the run folder to ${to} (normal; review-run cleanup deletes it)`);
    }
  }
}

// The seats' scratch folders of a run (in its phase folders and in <run-dir>-scratch-kept), with their sizes; with yes,
// deleted. A seat may not be able to delete its own folder (a host safety check), so the orchestrator does it here.
export async function cleanupScratch(runDir, yes) {
  const desc = await readRunDescriptor(runDir);
  setFoldsCase(desc.flags.foldsCase);
  for (const phase of ['phase1', 'phase2']) {
    for (const role of SEATS) {
      const record = await readResultAt(resultFile(desc, phase, role));
      if (record?.status === 'running' && !workerGone(record)) throw new StepError('cleanup', `seat ${role} (${phase}) is still running; run cleanup after it ends`);
    }
  }
  const kept = `${desc.runDir}-scratch-kept`;
  const dirs = new Set([kept, ...['phase1', 'phase2'].flatMap((phase) => [path.join(desc.runDir, phase), ...SEATS.map((role) => seatOutputDir(desc, phase, role))])]);
  const found = [];
  const skipped = [];
  // A folder searched here must be the real folder it names: a link anywhere below the run folder's own parent would
  // send the delete into the link's target.
  const realRun = await fs.realpath(desc.runDir);
  const realParent = await fs.realpath(path.dirname(desc.runDir));
  for (const dir of dirs) {
    const expected = dir === kept ? path.join(realParent, path.basename(kept)) : path.join(realRun, path.relative(desc.runDir, dir));
    const own = await isOwnFolder(dir, expected);
    if (own === null) continue;
    if (!own) {
      skipped.push(dir);
      continue;
    }
    // Only a missing folder is empty: any other error stops the command, so it never reports "no scratch" it did not see.
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
      throw new StepError('cleanup', `cannot list ${dir}: ${err.code ?? err.message}`);
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^scratch-[0-9a-f]{8}(?:-\d+)?$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // The size is for the listing only; a part that cannot be read leaves it unknown.
      let bytes = 0;
      try {
        for (const item of await fs.readdir(full, { recursive: true, withFileTypes: true })) {
          if (item.isFile()) bytes += (await fs.lstat(path.join(item.parentPath ?? item.path, item.name))).size;
        }
      } catch {
        bytes = null;
      }
      found.push({ full, bytes });
    }
  }
  const mb = (n) => (n === null ? 'size unknown' : `${(n / 1048576).toFixed(1)} MB`);
  const failed = [];
  if (yes) {
    // A folder in use (Windows EBUSY, EPERM) stays; the rest are still deleted and every one is named.
    for (const f of found) await fs.rm(f.full, { recursive: true, force: true }).catch((err) => { failed.push({ ...f, code: err.code ?? err.message }); });
    await fs.rmdir(kept).catch(() => {});
  }
  const done = found.filter((f) => !failed.includes(f) && !failed.some((x) => x.full === f.full));
  const lines = [
    ...skipped.map((d) => `skipped ${d}: it is a link or lies behind one, so nothing under it is touched`),
    ...(yes ? done : found).map((f) => `${yes ? 'deleted' : 'would delete'} ${f.full} (${mb(f.bytes)})`),
    ...failed.map((f) => `could not delete ${f.full}: ${f.code} (a process may still use it)`),
  ];
  const known = (list) => (list.some((f) => f.bytes === null) ? `${mb(list.reduce((n, f) => n + (f.bytes ?? 0), 0))} or more` : mb(list.reduce((n, f) => n + f.bytes, 0)));
  lines.push(found.length === 0 ? 'no seat scratch folder in this run' : yes ? `${done.length} of ${found.length} scratch folder(s) deleted, ${known(done)}` : `${found.length} scratch folder(s), ${known(found)}`);
  if (failed.length > 0) throw Object.assign(new StepError('cleanup', `${failed.length} scratch folder(s) could not be deleted`), { lines });
  lines.push(found.length > 0 && !yes ? `next: rerun with --yes to delete them, once every native seat's agent has finished: review-run cleanup --run-dir ${desc.runDir} --yes` : 'next: nothing left to delete');
  return lines;
}

async function phase2Start(desc, args, report) {
  if (skipsPhase2(desc)) {
    report.lines.push('mode none: Phase 2 skipped, no exchange');
    report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
    return;
  }
  await assertFingerprint(desc, { report, step: 'phase2' });
  if (!(await finishedRecord(phase1DoneFile(desc)))) {
    const err = new StepError('phase2', `Phase 1 has not finished (no ${phase1DoneFile(desc)}): a seat may still be running, or its findings were not validated yet (a run started before this version has no marker: one phase1 --wait validates it and writes it)`);
    err.next = `run: review-run phase1 --run-dir ${desc.runDir} --wait (rerun it while it exits 3), then phase2 --start`;
    throw err;
  }
  await moveLeftoverScratch(desc, report);
  const prepared = await runScript('exchange prepare', 'exchange.mjs', ['prepare', '--run-dir', desc.runDir, '--target-dir', desc.targetDir, '--tokens', tokens(desc), ...sourceFlags(desc), ...checklistFlags(desc)]);
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
  const nativeRoles = SEATS.filter((role) => !isCli(desc[`seat${role}`]) && !out.skipped?.[role] && out.briefs?.[role]);
  // Agent ids given to phase1 --wait are kept in native-agents.json and used again.
  const known = (await readResultAt(path.join(desc.runDir, 'native-agents.json'))) ?? {};
  const missing = nativeRoles.filter((role) => typeof known[role] !== 'string');
  const hint = nativeRoles.length === 0 ? ''
    : missing.length === 0 ? ` (the phase 1 agent id of seat ${nativeRoles.join(' and ')} is remembered; no flag needed)`
      : ` ${missing.map((role) => `--native-agent ${role}=<agent id>`).join(' ')} (or --native-done <seat> once the agent replied "written")`;
  report.next = `${nativeRoles.length > 0 ? 'resume each native seat, then run' : 'run'}: review-run phase2 --run-dir ${desc.runDir} --wait${hint}`;
}

async function phase2Wait(desc, args, report) {
  if (skipsPhase2(desc)) {
    report.lines.push('mode none: Phase 2 skipped, no exchange');
    report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
    return;
  }
  if (await laterStepDone(desc, 'phase2', report)) return;
  const roles = [];
  for (const role of SEATS) {
    if (role === args.incompleteSeat) {
      report.lines.push(`seat ${role}: declared incomplete (--incomplete-seat); its exchange is skipped and the review is incomplete`);
      // A CLI seat still working on its exchange is stopped first, so nothing writes its rebuttals after the finish.
      const record = isCli(desc[`seat${role}`]) ? await readResult(desc, 'phase2', role) : null;
      if (record?.status === 'running') {
        // Its worker first: before it has started the CLI, the worker is the only process to stop.
        const worker = await stopSeatWorker(record);
        const child = stopRecordedChild(record);
        report.lines.push(worker || child
          ? `seat ${role}: its Phase 2 ${[worker && 'worker', child && 'CLI'].filter(Boolean).join(' and ')} ${worker && child ? 'were' : 'was'} still running and ${worker && child ? 'were' : 'was'} stopped`
          : `warning: seat ${role}: its Phase 2 CLI is recorded as running but could not be stopped (worker pid ${record.workerPid ?? 'unknown'}, CLI pid ${record.childPid ?? 'unknown'}); check the process list`);
        // A worker stopped by its signal writes what its CLI left only to its log, not to result.json.
        const left = (record.workerLog ? await fs.readFile(record.workerLog, 'utf8').catch(() => '') : '').split(/\r?\n/).filter((l) => /left \d+ process\(es\) running/.test(l)).at(-1);
        if (left) report.lines.push(`warning: seat ${role}: ${left.replace(/^relay:\s*(?:WARNING:\s*)?/, '')}`);
      } else if (!isCli(desc[`seat${role}`])) {
        report.lines.push(`seat ${role}: a native agent is not stopped from here; make sure it no longer writes ${canonicalPath(desc, 'phase2', role)}`);
      }
    } else if ((await Promise.all(briefOf(desc, role).map(exists))).some(Boolean)) roles.push(role);
    else report.lines.push(`seat ${role}: no delta brief, nothing to wait for`);
  }
  await waitSeats(desc, 'phase2', roles, args.maxWait, report, (role) => canonicalPath(desc, 'phase2', role), args.nativeDone, args.nativeAgents);
  await assertFingerprint(desc, { report, step: 'phase2' });
  const finished = await runScript('exchange finish', 'exchange.mjs', ['finish', '--run-dir', desc.runDir, '--target-dir', desc.targetDir, ...sourceFlags(desc), ...checklistFlags(desc), ...(args.incompleteSeat ? ['--incomplete-seats', args.incompleteSeat] : [])]);
  let summary = '';
  try {
    const out = JSON.parse(finished.stdout);
    summary = ` (appended ${out.appended?.join(',') || 'none'}; concede ${out.concede}, dispute ${out.dispute})`;
  } catch {
    summary = '';
  }
  report.lines.push(`exchange finish: done${summary}`);
  const warnings = String(finished.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('WARNING'));
  for (const warning of warnings) report.lines.push(warning.length > 230 ? `${warning.slice(0, 227)}...` : warning);
  report.next = `run: review-run audit --run-dir ${desc.runDir} --prepare`;
}

// Both seats raised no claim: there is nothing for an auditor to confirm or refute, so the findings file is written empty.
// Only when each staged file carries its seat's own "No findings" marker: an empty or cut-off file is not a clean review.
async function zeroClaimRun(ai) {
  for (const name of ['X-findings.md', 'Y-findings.md']) {
    const text = await fs.readFile(path.join(ai, name), 'utf8').catch(() => null);
    if (text === null || !text.split(/\r?\n/).some((line) => NO_FINDINGS_RE.test(line))) return false;
  }
  return (await stagedClaimIds(ai)).size === 0;
}

async function finishZeroClaimRun(desc, report, args) {
  // The same target check as the auditor path: a changed target makes the empty result stale too.
  await assertFingerprint(desc, { acceptDrift: args.acceptDrift, report, step: 'audit' });
  const file = path.join(desc.runDir, 'phase3', 'findings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  // An earlier file is kept only when it is the finished zero-claim record at this audit depth; an empty, cut-off or
  // other-depth one is written again.
  const earlier = await readResultAt(file);
  if (earlier?.zero_claims !== true || earlier.audit_depth !== desc.flags.auditDepth) {
    const temp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(temp, `${JSON.stringify({ audit_depth: desc.flags.auditDepth, zero_claims: true, findings: [] }, null, 2)}${String.fromCharCode(10)}`, 'utf8');
    await fs.rename(temp, file);
  }
  report.lines.push('no claims from either seat: the auditor and the scorecard are not needed; wrote phase3/findings.json with no findings');
  await runScript('clear-cache', 'blind-relabel.mjs', ['clear-cache']);
  await removeWorktrees(desc, report);
  report.next = `run: review-run manifest --run-dir ${desc.runDir}, then review-run report --run-dir ${desc.runDir}`;
}

async function auditPrepare(desc, args, report) {
  const p1 = path.join(desc.runDir, 'phase1');
  const p2 = path.join(desc.runDir, 'phase2');
  const mapping = mappingFile(desc);
  const ai = auditInputDir(desc);
  const breakdown = path.join(desc.runDir, 'phase3', 'falsification-breakdown.json');
  const staged = await exists(ai) && (await fs.readdir(ai)).length > 0;
  if (staged) {
    throw new StepError('audit-prep', `${ai} is not empty; audit-prep needs a new empty folder (set auditor.outputDir in run.json to a new one after a redaction)`);
  }
  await fs.mkdir(path.dirname(mapping), { recursive: true });
  await fs.mkdir(path.join(desc.runDir, 'phase3'), { recursive: true });
  if (await exists(mapping)) {
    report.lines.push('flip: kept the earlier coin flip');
  } else {
    await runScript('flip', 'blind-relabel.mjs', ['flip', '--out', mapping]);
    report.lines.push('flip: decided');
  }
  await fs.mkdir(ai, { recursive: true });
  const task = path.join(desc.runDir, 'task-packet.md');
  await runScript('audit-prep', 'blind-relabel.mjs', ['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', ai, '--target-dir', desc.targetDir, '--tokens', tokens(desc),
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
    await finishZeroClaimRun(desc, report, args);
    return;
  }
  report.next = desc.flags.falsification && qualified > 0
    ? `run ${qualified} verifier(s) on the qualified claims and save their verification-<id>.md files in ${path.join(desc.runDir, 'phase3')}, then run: review-run audit --run-dir ${desc.runDir} --finish${nativeAuditorHint(desc)}`
    : `run: review-run audit --run-dir ${desc.runDir} --finish${nativeAuditorHint(desc)}`;
}

// A native auditor is spawned between the two finish runs; the second one needs the flag.
function nativeAuditorHint(desc) {
  return isCli(desc.auditor) ? '' : ' (it prints the auditor brief; spawn the auditor, then rerun with --native-agent auditor=<its agent id>, or --native-done auditor once it replied "written")';
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

// Verification files are staged whenever they exist (also the post-audit deep verify of a run that started without
// falsification); only a run that requested falsification requires one for every qualifying claim.
// gate: the missing-verifier check, run when the brief is built; a later call only stages files that arrived since.
async function stageVerification(desc, ai, args, report, { gate = true } = {}) {
  const p3 = path.join(desc.runDir, 'phase3');
  const files = (await fs.readdir(p3).catch(() => [])).filter((f) => /^verification-.+\.md$/.test(f));
  if (desc.flags.falsification !== true && files.length === 0) return 0;
  const breakdown = (await readResultAt(path.join(p3, 'falsification-breakdown.json')))?.falsificationBreakdown;
  const qualified = breakdown?.disputed ?? 0;
  // The claims that qualify, by anonymous ID: a file for some other claim does not cover them. A breakdown written
  // before disputed_ids existed has only the count.
  const have = new Set(files.map((f) => /^verification-([XY]\d+)\.md$/.exec(f)?.[1]).filter(Boolean));
  const missing = Array.isArray(breakdown?.disputed_ids) ? breakdown.disputed_ids.filter((id) => !have.has(id)) : null;
  if (gate && desc.flags.falsification === true && (missing ? missing.length > 0 : files.length < qualified)) {
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
    await runScript('stage verification', 'blind-relabel.mjs', ['scan', '--in', path.join(p3, f), '--target-dir', desc.targetDir, '--tokens', tokens(desc), ...sourceFlags(desc), ...checklistFlags(desc),
      '--phase1-dir', path.join(desc.runDir, 'phase1'), '--forbid-seats', 'A,B', ...(skipsPhase2(desc) ? [] : ['--phase2-dir', path.join(desc.runDir, 'phase2')])]);
    // A verifier's file that names this run's folder would point the auditor at the real-ID files, as a packet would.
    const text = await fs.readFile(path.join(p3, f), 'utf8');
    const named = runDirNamedIn(text, desc.runDir, desc.targetDir);
    if (named) throw new StepError('stage verification', `${f} names the run folder (${named.leaked}); have its verifier cite a copy outside the run folder, then rerun`);
    if (refutesByInference(text)) throw new StepError('stage verification', `${f} says Verdict REFUTED with Basis INFERENCE, which translate refuses: a refutation needs a command and its output or the cited lines; have its verifier rerun the check or write INCONCLUSIVE, then rerun`);
  }
  for (const f of files) await copyOnce(path.join(p3, f), path.join(ai, f), 'stage verification');
  return files.length;
}

async function archiveFindings(p3) {
  let n = 1;
  while (await exists(path.join(p3, `findings.attempt-${n}.json`))) n += 1;
  const name = `findings.attempt-${n}.json`;
  await fs.rename(path.join(p3, 'findings.json'), path.join(p3, name));
  return name;
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
  const prior = await recheckGone(result, await readResultAt(result));
  rateLimitGate('the auditor', prior);
  if (!prior && outputExists) throw new StepError('auditor output', `the auditor output exists but there is no result.json at ${result}, so the CLI auditor's completion cannot be confirmed; remove the output file to dispatch the auditor again`);
  const redispatch = !prior || endedBadly(prior);
  if (redispatch) {
    stopRecordedChild(prior);
    if (prior) await checkTouched('auditor', result);
    await assertFingerprint(desc, { acceptDrift: args.acceptDrift, report, step: 'audit' });
    const leftover = path.join(auditInputDir(desc), 'findings.audit.json');
    if (await exists(leftover)) report.lines.push(`auditor: the failed attempt's output is kept as ${await archiveAuditOutput(path.join(desc.runDir, 'phase3'), leftover)}`);
    const argv = auditor.runtime === 'claude'
      ? ['--brief', briefPath, '--cd', desc.targetDir, '--model', auditor.model, ...effortFlags(auditor), ...envFlags(auditor), '--out-dir', auditInputDir(desc),
        ...sourceFlags(desc), ...(auditor.worktreePath ? ['--worktree', auditor.worktreePath] : []), ...timeoutFlags(desc),
        ...(channelFor(auditor, desc.host) === 'final-message' ? ['--final-message-out', path.join(auditInputDir(desc), 'findings.audit.json')] : []), '--detach']
      : ['--brief', briefPath, '--cd', desc.targetDir, '--sandbox', 'read-only', '--model', auditor.model, ...effortFlags(auditor), ...envFlags(auditor), ...timeoutFlags(desc),
        '--final-message-out', path.join(auditInputDir(desc), 'findings.audit.json'), '--detach'];
    await runScript('auditor dispatch', dispatcher, argv);
    report.lines.push(prior ? `auditor: previous attempt ended with status ${endedAs(prior)}; dispatched again (the earlier result is kept as an attempt file)` : `auditor: dispatched (cli ${auditor.runtime})`);
  }
  if (redispatch || prior.status === 'running') {
    let waited;
    try {
      waited = await runScript('auditor wait', dispatcher, ['--wait', result, '--max-wait', String(args.maxWait)], { allow: [0, 3] });
    } catch (err) {
      await noteAnswerStop(desc, await readResultAt(result), 'auditor', 'audit', report);
      if (err instanceof StepError) throw new StepError(err.step, `${err.message}; rerunning this command dispatches the auditor again`);
      throw err;
    }
    if (waited.status === 3) throw new StillRunning('the auditor is still running; rerun this command');
  }
  const note = await checkTouched('auditor', result);
  report.lines.push(`auditor: completed${note ? `; ${note}` : ''}`);
  await noteAnswerStop(desc, await readResultAt(result), 'auditor', 'audit', report);
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
  // Counts only the worktrees still on disk and removed now, so a rerun after cleanup reports 0.
  let removed = 0;
  for (const wt of worktrees) {
    if (await exists(wt)) {
      const r = spawnSync('git', ['-C', desc.targetDir, 'worktree', 'remove', '--force', wt], { windowsHide: true, encoding: 'utf8' });
      if (r.status !== 0) throw new StepError('worktree cleanup', `git worktree remove ${wt} failed: ${tail(r.stderr)}`);
      removed++;
    }
    await fs.rm(`${wt}.snapshot-complete`, { force: true });
  }
  if (worktrees.size > 0) {
    const r = spawnSync('git', ['-C', desc.targetDir, 'worktree', 'prune'], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new StepError('worktree cleanup', `git worktree prune failed: ${tail(r.stderr)}`);
  }
  report.lines.push(`worktrees: removed ${removed}`);
}

async function auditFinish(desc, args, report) {
  const ai = auditInputDir(desc);
  if (await zeroClaimRun(ai)) {
    await finishZeroClaimRun(desc, report, args);
    return;
  }
  if (!(await exists(path.join(ai, 'task-packet.md')))) {
    throw new StepError('audit prepare', `the staged audit folder ${ai} is missing or incomplete: run review-run audit --prepare first (it needs the exchange finished); nothing was started`);
  }
  const p1 = path.join(desc.runDir, 'phase1');
  const p3 = path.join(desc.runDir, 'phase3');
  const task = path.join(ai, 'task-packet.md');
  // "full" for every new run; translate reads an older run by the depth it ran with.
  const depth = desc.flags.auditDepth;
  const cliAuditor = isCli(desc.auditor);
  const briefPath = cliAuditor ? path.join(auditDispatchDir(desc), 'auditor-brief.txt') : path.join(ai, 'auditor-brief.txt');
  const audited = path.join(ai, 'findings.audit.json');
  await checkVerifiers(desc, report);
  // Only a brief that existed before this call can have an auditor that finished: a fresh brief always prints the spawn line.
  const briefWasThere = await exists(briefPath);
  if (!briefWasThere) {
    await assertFingerprint(desc, { acceptDrift: args.acceptDrift, report, step: 'audit' });
    const staged = await stageVerification(desc, ai, args, report);
    await fs.mkdir(path.dirname(briefPath), { recursive: true });
    await runScript('auditor brief', 'build-brief.mjs', ['--mode', 'auditor', '--packet', task, '--audit-dir', ai, '--target-dir', desc.targetDir, '--run-dir', desc.runDir, '--out', briefPath,
      ...(channelFor(desc.auditor, desc.host) === 'file' ? ['--output-path', audited] : []), '--channel', channelFor(desc.auditor, desc.host), ...sourceFlags(desc), ...rulesFlags(desc)]);
    report.lines.push(`auditor brief: built (every claim is re-checked${staged > 0 ? `, ${staged} verification file(s) staged` : ''})`);
  } else if (await exists(path.join(desc.runDir, 'phase3', 'findings.json'))) {
    // A deep verify after the finished audit: its verification files are scanned and staged for the resumed auditor. Only a
    // native auditor can be resumed (phase-3 file); a CLI auditor's run takes a new run with falsification.
    // Only files new to the auditor's folder count; the step stops on them, so translate never reads the unchanged answer.
    const before = new Set(await fs.readdir(ai).catch(() => []));
    await stageVerification(desc, ai, args, report, { gate: false });
    const fresh = (await fs.readdir(ai).catch(() => [])).filter((f) => /^verification-.+\.md$/.test(f) && !before.has(f));
    if (fresh.length > 0 && cliAuditor) throw new StepError('stage verification', `${fresh.join(', ')} staged after the audit, but a CLI auditor cannot be resumed to read them: run the review again with falsification (review-config seats --falsification) for these claims`);
    if (fresh.length > 0) throw new StillRunning(`${fresh.join(', ')} staged for the auditor: resume the same auditor to add verifications[] and update final_state for those findings, then rerun with --native-done auditor once it replied`);
  } else {
    // Verifiers run between audit --prepare and --finish: a file that arrived after the brief was built is not in the
    // auditor's inputs and the audit cannot cite it, so the step stops on it instead of dropping it.
    const staged = new Set(await fs.readdir(ai).catch(() => []));
    const late = (await fs.readdir(p3).catch(() => [])).filter((f) => /^verification-.+\.md$/.test(f) && !staged.has(f));
    if (late.length > 0) throw new StepError('stage verification', `${late.join(', ')} arrived after the auditor brief was built, so the auditor cannot cite it; run verifiers between audit --prepare and --finish, or move the file out of phase3 to go on without it`);
    // translate publishes the phase3 copy: one that changed after it was staged would publish evidence the auditor never read.
    for (const f of [...staged].filter((n) => /^verification-.+\.md$/.test(n))) {
      const now = await fs.readFile(path.join(p3, f)).catch(() => null);
      if (now !== null && !now.equals(await fs.readFile(path.join(ai, f)))) throw new StepError('stage verification', `${f} changed after it was staged for the auditor, which read the earlier copy; put the staged copy back in phase3, or run the review again with the new verification`);
    }
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
    } else if (args.nativeDone.includes('auditor') && briefWasThere) {
      if (!(await fileAppears(audited, fileGraceS()))) {
        throw new StepError('auditor output', `--native-done auditor says its agent finished, but ${audited} does not exist (waited ${fileGraceS()} s for the write); return it to the agent to write the file (never write it yourself), or drop --native-done auditor if it is still working`);
      }
    } else {
      const prompt = await writePrompt(desc, 'auditor', 'auditor', briefPath, audited);
      report.lines.push(`auditor: native; spawn it with brief ${briefPath}; it writes ${audited}; prompt to give it: ${prompt}`);
      report.next = `spawn the auditor, then rerun: review-run audit --run-dir ${desc.runDir} --finish --native-agent auditor=<its agent id> (or --native-done auditor once it replied "written")`;
      return;
    }
  }
  // A native auditor's file is new to this step when no copy was taken yet or it differs from that copy (a resumed auditor
  // after a finished audit): only then must its agent be shown finished.
  const takenCopy = path.join(p3, 'findings.audit.json');
  const freshAuditorFile = !(await exists(takenCopy)) || !(await fs.readFile(takenCopy)).equals(await fs.readFile(audited));
  if (!cliAuditor && !args.nativeDone.includes('auditor') && args.nativeAgents.auditor && freshAuditorFile) {
    if (!(await agentFinished(args.nativeAgents.auditor, 'auditor', args.maxWait))) throw new StillRunning("the auditor's agent is still working (its transcript has no final reply yet)");
    await checkFinalReply('auditor output', await agentTranscript(args.nativeAgents.auditor, 'auditor'), audited, report);
    report.lines.push('auditor: transcript shows the agent finished');
  } else if (!cliAuditor && !args.nativeDone.includes('auditor') && freshAuditorFile) {
    throw new StillRunning(`the native auditor's file ${audited} ${(await exists(takenCopy)) ? 'changed since the audit finished (a resumed auditor)' : 'exists'} but a file alone cannot show the agent finished; once it replied "written", rerun this command with --native-done auditor`);
  }
  await assertFingerprint(desc, { acceptDrift: args.acceptDrift, report, step: 'audit' });
  await checkVerifiers(desc);
  const audit = path.join(p3, 'findings.audit.json');
  const translated = await exists(path.join(p3, 'findings.json'));
  if (await exists(audit) && !(await fs.readFile(audit)).equals(await fs.readFile(audited))) {
    // After a finished audit a changed auditor file is the resumed auditor's (the post-audit deep verify): the earlier
    // output and findings are kept and the findings built again; before it, the changed file replaces a refused one.
    report.lines.push(`the ${translated ? 'earlier' : 'refused'} auditor output is kept as ${await archiveAuditOutput(p3, audit)}`);
    if (translated) report.lines.push(`the earlier findings are kept as ${await archiveFindings(p3)}`);
  }
  await copyOnce(audited, audit, 'copy auditor output');
  const findings = path.join(p3, 'findings.json');
  try {
    await runScript('translate', 'blind-relabel.mjs', ['translate', '--in', audit, '--out', findings, '--mapping', mappingFile(desc), '--phase1-dir', p1,
      ...(desc.flags.falsification === true || (await fs.readdir(p3).catch(() => [])).some((f) => /^verification-.+\.md$/.test(f)) ? ['--verification-dir', p3] : []), '--audit-depth', depth, ...checklistFlags(desc)]);
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    // A crash or an unreadable run file is not the auditor's to fix: the step fails as before.
    if (/unexpected failure|could not read|cannot read|ENOENT|EACCES|EPERM|--mapping|--phase1-dir|--verification-dir/i.test(err.message)) throw err;
    // A refused auditor file goes back to the auditor (never edited by hand). Both copies are moved aside, so a rerun waits for
    // the rewritten file instead of refusing the same one again.
    const kept = await archiveAuditOutput(p3, audit);
    await archiveAuditOutput(path.dirname(audited), audited);
    // A CLI auditor's result.json is moved aside too, so the rerun dispatches it again with no file removed by hand.
    const cliResult = path.join(path.dirname(briefPath), 'result.json');
    if (cliAuditor && await exists(cliResult)) {
      let n = 1;
      while (await exists(path.join(path.dirname(cliResult), `result.attempt-${n}.json`))) n += 1;
      await fs.rename(cliResult, path.join(path.dirname(cliResult), `result.attempt-${n}.json`));
    }
    const fix = path.join(p3, 'prompt-auditor-fix.txt');
    const reason = (err.lastLine || err.message).replace(/^blind-relabel\.mjs exited \d+: /, '').replace(/^blind-relabel: /, '');
    // translate checks the ids after mapping them to seat letters; the auditor only ever sees the blind X/Y labels.
    const labels = (await readResultAt(mappingFile(desc))) ?? {};
    const toLabel = (whole, seat, rest) => (typeof labels[seat] === 'string' ? `${labels[seat]}${rest}` : whole);
    const blindReason = reason.replace(/\b([AB])(\d+)\b/g, toLabel).replace(/\b([AB])(-findings\.md|-rebuttals-raw\.md)\b/g, toLabel);
    // A seat letter that still shows (a file name, "seat A") would tell the auditor which seat a label is: the orchestrator handles it.
    if (/\b[AB]-[a-z-]+\.md\b|\b[Ss]eat [AB]\b/.test(blindReason)) throw new StepError('auditor output', `the auditor's file was refused (kept as ${kept}) for a reason that names a seat, so it is not sent back to the auditor: ${reason}`);
    await fs.writeFile(fix, `Your audit file ${audited} was refused: ${blindReason}. Read the Output section of your brief ${briefPath} again, correct the file to that schema and rewrite it in one write. Do not edit any other file. Reply with only the word written.${String.fromCharCode(10)}`, 'utf8');
    const failed = new StepError('auditor output', `the auditor's file was refused (kept as ${kept}): ${reason}`);
    failed.next = cliAuditor
      ? `rerun: review-run audit --run-dir ${desc.runDir} --finish (it dispatches the auditor again, a new paid run; the refused attempt is kept)`
      : `send the auditor agent the message in ${fix} (never edit its file yourself), then rerun: review-run audit --run-dir ${desc.runDir} --finish --native-agent auditor=<its agent id>`;
    throw failed;
  }
  // The auditor's file passed: an earlier refusal's fix message is done with.
  await fs.rm(path.join(p3, 'prompt-auditor-fix.txt'), { force: true });
  await runScript('scorecard', 'blind-relabel.mjs', ['scorecard', '--in', findings, '--out', path.join(p3, 'scorecard.md'), '--phase1-dir', p1]);
  await runScript('clear-cache', 'blind-relabel.mjs', ['clear-cache']);
  report.lines.push('translate, scorecard, clear-cache: done');
  await removeWorktrees(desc, report);
  report.next = `run: review-run manifest --run-dir ${desc.runDir}, then review-run report --run-dir ${desc.runDir}`;
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
        const state = { done: 'finished', aborted: 'turn aborted' }[await agentState(file)] ?? 'working';
        lines.push(`seat ${role}: native agent ${state}${stats.startedAtMs ? ` ${formatElapsed(nowMs - stats.startedAtMs)}` : ''}, ${stats.calls} tool call(s)`);
      }
    } else {
      lines.push(`seat ${role}: native; pass --native-agent ${role}=<agent id> to see its progress`);
    }
  }
  return lines;
}

// One line for a run folder: the step it has reached, and during a phase each seat's progress (runs nothing).
// The first brief's time is the latest safe start of an orchestrator usage window (auto@<start>/<end>): a later start drops work.
async function runStatus(dir) {
  const line = await runStatusLine(dir);
  const first = await firstBriefTime(path.resolve(dir));
  return first === null ? line : `${line} (first brief ${new Date(first).toISOString()})`;
}

async function runStatusLine(dir) {
  let desc;
  try {
    desc = await readRunDescriptor(dir);
  } catch (err) {
    // The message repeats the run folder already printed in front of it; the cause (ENOENT, not valid JSON) is what is new.
    return `run.json not readable (${err.message.split(path.join(path.resolve(dir), 'run.json')).join('run.json').slice(0, 160)})`;
  }
  const refused = await readResultAt(refusedFile(desc));
  const refusedLine = refused && typeof refused === 'object' ? `INCOMPLETE: seat ${Object.keys(refused).join(' and ')}'s findings file was refused again after its one rewrite (${refusedFile(desc)})` : null;
  const findingsFile = path.join(desc.runDir, 'phase3', 'findings.json');
  if (await finishedRecord(path.join(desc.runDir, 'manifest.json'))) {
    const manifest = await readResultAt(path.join(desc.runDir, 'manifest.json'));
    const status = manifest?.status;
    // A manifest from a failed chain hides the audit that finished after it: its findings hash differs, or it has none and
    // is not complete (a completed manifest built without --findings is trusted).
    const recorded = manifest?.hashes?.findings_json;
    if (await finishedRecord(findingsFile) && (recorded ? recorded !== await hashFile(findingsFile, 'phase3/findings.json') : status !== 'completed')) return 'audit finished after manifest.json was built; next: review-run manifest (rebuilds it), then review-run report';
    // A re-audit after the manifest moved findings.json aside: until audit --finish passes again the run is not finished.
    const reAudit = (await fs.readdir(path.join(desc.runDir, 'phase3')).catch(() => [])).some((f) => /^findings\.attempt-\d+\.json$/.test(f));
    if (!(await finishedRecord(findingsFile)) && (reAudit || await exists(path.join(desc.runDir, 'phase3', 'prompt-auditor-fix.txt')))) {
      return `audit: the auditor is working or its output waits for audit --finish (${reAudit ? 'a re-audit after manifest.json was built' : "the auditor's file was refused after manifest.json was built"})`;
    }
    if (refusedLine) return `${refusedLine}; manifest.json is written (review-run report prints the report)`;
    return status === 'completed' ? 'finished: manifest.json is written (review-run report prints the report)' : `finished INCOMPLETE: manifest.json status is "${status}" (review-run report prints why)`;
  }
  if (await finishedRecord(path.join(desc.runDir, 'phase3', 'findings.json'))) return 'audit finished; next: review-run manifest, then review-run report';
  const agents = (await readResultAt(path.join(desc.runDir, 'native-agents.json'))) ?? {};
  if (await exists(path.join(auditInputDir(desc), 'auditor-brief.txt')) || await exists(path.join(auditDispatchDir(desc), 'auditor-brief.txt'))) {
    return `audit: the auditor is working or its output waits for audit --finish${isCli(desc.auditor) || typeof agents.auditor === 'string' ? '' : ' (pass --native-agent auditor=<id> to wait on the native auditor)'}`;
  }
  if ((await fs.readdir(auditInputDir(desc)).catch(() => [])).length > 0) return 'audit prepared; next: audit --finish';
  if (refusedLine) return refusedLine;
  if (await finishedRecord(path.join(desc.runDir, 'phase2', 'exchange-result.json'))) return 'exchange finished; next: audit --prepare';
  for (const phase of ['phase2', 'phase1']) {
    const marks = phase === 'phase2' ? SEATS.flatMap((role) => briefOf(desc, role)) : SEATS.flatMap((role) => [path.join(desc.runDir, 'phase1', `brief-${role}.txt`), path.join(desc.runDir, 'phase1', role)]);
    const started = (await Promise.all(marks.map(exists))).some(Boolean);
    if (!started) continue;
    if (phase === 'phase1' && (await finishedRecord(phase1DoneFile(desc)))) return `phase1 finished; next: ${(await readResultAt(phase1DoneFile(desc))).next ?? `review-run phase2 --run-dir ${desc.runDir} --start`}`;
    return `${phase}: ${(await seatStatusLines(desc, phase, agents)).join('; ')}`;
  }
  return 'not started; next: phase1 --start';
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
  // Over the cap the last line stays (it is the FAILED line when a step failed), and warning and failure lines are kept
  // before routine progress lines; the kept lines stay in their order.
  let lines = report.lines;
  if (lines.length > MAX_LINES) {
    const body = lines.slice(0, -1).map((text, i) => ({ text, i, warns: /warning|WARNING|FAILED|INCOMPLETE|refused/.test(text) }));
    const warns = body.filter((l) => l.warns);
    if (warns.length > MAX_LINES - 2) {
      // More warnings than room: the first ones stay whole and the rest share one line, each cut to its start, so none
      // is dropped; the line also counts the progress lines left out.
      const rest = warns.slice(MAX_LINES - 2).map((l) => (l.text.length > 120 ? `${l.text.slice(0, 117)}...` : l.text)).join(' | ');
      const routine = body.length - warns.length;
      lines = [...warns.slice(0, MAX_LINES - 2).map((l) => l.text), `${warns.length - (MAX_LINES - 2)} more warning(s): ${rest}${routine > 0 ? `; ${routine} more line(s) omitted` : ''}`, lines.at(-1)];
    } else {
      const keep = new Set([...warns, ...body.filter((l) => !l.warns)].slice(0, MAX_LINES - 2).map((l) => l.i));
      lines = [...body.filter((l) => keep.has(l.i)).map((l) => l.text), `... ${body.length - keep.size} more line(s) omitted`, lines.at(-1)];
    }
  }
  out.write(`${lines.join('\n')}${lines.length > 0 ? '\n' : ''}next: ${report.next}\n`);
}

async function run(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const errOut = io.stderr ?? process.stderr;
  stepsOverride = io.steps ?? null;
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
  if (args.forward) {
    // The step has no help text of its own: --help prints this command's usage lines.
    if (args.forward.includes('--help') || args.forward.includes('-h')) {
      out.write(`${USAGE.split(String.fromCharCode(10)).filter((l) => l.startsWith(`  node review-run.mjs ${args.command} `)).join(String.fromCharCode(10))}${String.fromCharCode(10)}`);
      return 0;
    }
    // The step's own refusal goes to stderr, its output to stdout; its exit code is review-run's.
    const r = await FORWARD[args.command](args.forward, { tty: out.isTTY === true });
    out.write(r.stdout);
    errOut.write(r.stderr);
    return r.code;
  }
  if (args.command === 'status') {
    const lines = [];
    for (const dir of args.runDirs) lines.push(`${path.resolve(dir)}: ${await runStatus(dir)}`);
    // No line cap here: every run gets its line.
    out.write([...lines, 'next: act on each run with its own command; rerun status to refresh', ''].join(String.fromCharCode(10)));
    return 0;
  }
  if (args.command === 'cleanup') {
    try {
      out.write([...await cleanupScratch(args.runDir, args.yes), ''].join(String.fromCharCode(10)));
      return 0;
    } catch (err) {
      if (!(err instanceof StepError) && !(err instanceof RunDescriptorError)) throw err;
      out.write([...(err.lines ?? []), `FAILED cleanup: ${err.message}`, `next: rerun review-run cleanup --run-dir ${path.resolve(args.runDir)} once that is fixed`, ''].join(String.fromCharCode(10)));
      return 1;
    }
  }
  const report = { lines: [], next: '', clock: args.local, acceptDrift: args.acceptDrift === true };
  const rerun = `review-run ${args.command} --run-dir ${path.resolve(args.runDir)} --${args.half}`;
  let loadedDesc = null;
  try {
    const desc = await readRunDescriptor(args.runDir);
    loadedDesc = desc;
    // The steps run in this process: they read the run folder's letter case as preflight found it.
    setFoldsCase(desc.flags.foldsCase);
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
      const hold = args.command === 'phase1' ? '; do not start phase2 until this exits 0' : args.command === 'phase2' ? '; do not run audit --prepare until this exits 0' : '';
      report.next = `${err.message}${others}: ${rerun}${hold}`;
      print(report, out);
      return 3;
    }
    const step = err instanceof StepError ? err.step : err instanceof RunDescriptorError ? 'run.json' : null;
    if (step === null) throw err;
    report.lines.push(`FAILED ${step}: ${err.message}`);
    // No run.json means the host preflight never wrote it (it refused, or was not run): rerunning that is the fix.
    const noDescriptor = err instanceof RunDescriptorError && !(await exists(path.join(path.resolve(args.runDir), 'run.json')));
    report.next = err.next ?? (noDescriptor
      ? `run.json is written by the host preflight: run preflight.mjs --host <host> --cd <target> --run-dir ${path.resolve(args.runDir)} --seats <seats.json> (if it refused, fix what it reported first), then rerun: ${rerun}`
      : `fix "${step}" (every artifact is kept under ${path.resolve(args.runDir)}), then rerun: ${rerun}`);
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
