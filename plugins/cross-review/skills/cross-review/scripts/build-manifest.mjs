// Stamps deterministic fields onto an orchestrator-authored manifest.json
// skeleton: a run_id, and sha256 content hashes of the task packet, Phase 1
// outputs, Phase 2 outputs, verifier files, and findings.json.
//
// The orchestrator/model still authors the manifest's descriptive fields
// (topology, mode, reviewers[].provider/model_requested/..., exchange,
// falsification -- see review-protocol.md's Manifest and final output
// section) since those describe intent and configuration a script cannot
// observe. This script owns only what deterministic code can actually
// verify: a run identifier, and hashes proving which exact artifact bytes
// a report was generated from -- reproducibility and audit, not authorship
// of judgment calls.
//
// Each reviewer's own timing (startedAt/finishedAt/durationMs/timeoutS) and
// token/cost fields already live in that seat's own result.json (see
// the dispatchers' RESULT_REQUIRED_KEYS); this
// script does not duplicate them onto the manifest, it leaves them where
// the dispatcher that owns that data already wrote them. A harness seat (a
// Claude subagent) has no result.json, so --seat-transcript sums its token use from
// its own transcript and --seat-usage adds the duration, both as "seat_usage".

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolloutUsage, rolloutModel, rolloutCommands, findThreadRollout } from './rollout-utils.mjs';
import { findAgentTranscripts, findSessionTranscripts, transcriptCommands } from './native-agent.mjs';
import { readRunDescriptor } from './run-descriptor.mjs';
import { comparablePath } from './path-utils.mjs';
import { parseSeatFile } from './seat-file.mjs';
import { makeIo, refuseDirectRun, runStep as runStepWith } from './step-io.mjs';

class RelayError extends Error {}
const io = makeIo();

function parseArgs(argv) {
  const args = {
    in: null, out: null, taskPacket: null, reviewRules: null, runDir: null, init: false,
    phase1: [], phase2: [], verification: [], findings: null, seatUsage: {}, seatTranscripts: {}, reviewerResults: {}, extraArtifacts: [],
    falsification: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RelayError(`${a} requires a value`);
      return v;
    };
    if (a === '--in') args.in = takeValue();
    else if (a === '--out') args.out = takeValue();
    else if (a === '--run-dir') args.runDir = takeValue();
    else if (a === '--init') args.init = true;
    else if (a === '--task-packet') args.taskPacket = takeValue();
    else if (a === '--phase1') args.phase1.push(takeValue());
    else if (a === '--phase2') args.phase2.push(takeValue());
    else if (a === '--verification') args.verification.push(takeValue());
    else if (a === '--findings') args.findings = takeValue();
    else if (a === '--falsification') args.falsification = takeValue();
    else if (a === '--seat-usage') {
      const v = takeValue();
      const m = /^(A|B|auditor)=(\d+|unknown),(\d+|unknown)(?:,(estimated|clock))?$/.exec(v);
      if (!m) throw new RelayError(`--seat-usage "${v}" must look like A=250000,1656000 (seat A, B or auditor; total tokens; duration in ms; either number may be "unknown"; append ",clock" for a span you timed, ",estimated" for a number you did not measure)`);
      if (Object.hasOwn(args.seatUsage, m[1])) throw new RelayError(`--seat-usage given twice for ${m[1]}`);
      const num = (s) => (s === 'unknown' ? null : Number(s));
      const [tokens, ms] = [num(m[2]), num(m[3])];
      if (tokens === null && ms === null && m[4]) throw new RelayError(`--seat-usage "${v}": nothing to mark ${m[4]} when both numbers are unknown`);
      args.seatUsage[m[1]] = { final_context_tokens: tokens, duration_ms: ms, source: tokens === null && ms === null ? 'unknown' : m[4] ?? 'harness' };
    }
    else if (a === '--seat-transcript') {
      const v = takeValue();
      const m = /^(A|B|auditor|verifier|orchestrator)=(.+)$/.exec(v);
      if (!m) throw new RelayError(`--seat-transcript "${v}" must look like A=<subagent transcript .jsonl or agent id>`);
      (args.seatTranscripts[m[1]] ??= []).push(m[2]);
    }
    else if (a === '--extra-artifact') {
      const v = takeValue();
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)=(.+)$/.exec(v);
      if (!m) throw new RelayError(`--extra-artifact "${v}" must look like synthesis=<path> (a name of letters, digits, ".", "_" or "-")`);
      if (args.extraArtifacts.some(([name]) => name === m[1])) throw new RelayError(`--extra-artifact given twice for "${m[1]}"`);
      args.extraArtifacts.push([m[1], m[2]]);
    }
    else if (a === '--reviewer-result') {
      const v = takeValue();
      const m = /^(A|B|auditor|verifier-\d+)=(.+)$/.exec(v);
      if (!m) throw new RelayError(`--reviewer-result "${v}" must look like B=<path to result.json>`);
      (args.reviewerResults[m[1]] ??= []).push(m[2]);
    }
    else throw new RelayError(`unrecognized argument: ${a}`);
  }
  if (args.init && !args.runDir) throw new RelayError('--init needs --run-dir');
  if (!args.runDir && (!args.in || !args.out)) throw new RelayError('--in and --out are both required (or give --run-dir, which supplies both)');
  return args;
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(file) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

// Null only when the file is absent: a file that is there but is not one JSON object ("null" included) stops the run instead
// of being read as missing.
async function readJsonOrAbsent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new RelayError(`${file} cannot be read: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new RelayError(`${file} is not valid JSON (${err.message}); fix or remove it, then rerun`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new RelayError(`${file} must hold one JSON object; fix it, then rerun`);
  return data;
}

// The minimal valid body for a run, from run.json and the files the run left; the orchestrator adds only what it knows.
// A fresh initBody value wins; the edited body fills what initBody leaves null or does not compute, one level deep.
// initBody writes these exchange keys only while they apply, so an edited body's copy of one that no longer applies is dropped.
const RUN_EXCHANGE_KEYS = ['seat_to_audit_label', 'incomplete_seats', 'reason', 'no_peer_claims'];
function mergeEditedBody(edited, fresh) {
  const out = { ...edited };
  // Written only while it applies: a seat file restored since --init is no longer missing.
  if (!('missing_seat_files' in fresh)) delete out.missing_seat_files;
  if (!('format_refused' in fresh)) delete out.format_refused;
  if (!('blocked_no_findings' in fresh)) delete out.blocked_no_findings;
  if (!('seat_format_notes' in fresh)) delete out.seat_format_notes;
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  for (const [key, value] of Object.entries(fresh)) {
    if (key === 'reviewers' && Array.isArray(value) && Array.isArray(edited[key])) {
      // Entry by entry on role: a hand-added field stays, a value the run computes wins when it is not null.
      const byRole = new Map(edited[key].filter(plain).map((e) => [e.role, e]));
      const merged = value.map((f) => ({ ...(byRole.get(f.role) ?? {}), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined)) }));
      out[key] = [...merged, ...edited[key].filter((e) => !plain(e) || !value.some((f) => f.role === e.role))];
    } else if (value === null || value === undefined) { if (!(key in edited)) out[key] = value; }
    else if (plain(value) && plain(edited[key])) {
      const kept = { ...edited[key] };
      if (key === 'exchange') for (const k of RUN_EXCHANGE_KEYS) delete kept[k];
      out[key] = { ...kept, ...value };
    }
    else out[key] = value;
  }
  return out;
}

export async function initBody(descriptor, runDir) {
  const phase3 = path.join(runDir, 'phase3');
  const verifications = (await readdir(phase3).catch(() => [])).filter((f) => /^verification-.+[.]md$/.test(f));
  const mapping = await readJsonOrAbsent(path.join(runDir, 'phase3-private', 'seat-to-audit-label.json'));
  // Only a findings.json that parses as a JSON object with its findings list is a finished audit; an empty, cut-off or
  // empty-object file is not.
  const findingsDoc = await readJsonIfPresent(path.join(phase3, 'findings.json'));
  const finished = findingsDoc !== null && typeof findingsDoc === 'object' && !Array.isArray(findingsDoc) && Array.isArray(findingsDoc.findings);
  // exchange.mjs finish records which seats could not complete the exchange; a run that lost one is not a completed review.
  const exchangeResult = await readJsonOrAbsent(path.join(runDir, 'phase2', 'exchange-result.json'));
  const incompleteSeats = Array.isArray(exchangeResult?.incomplete) ? exchangeResult.incomplete : [];
  // A run missing a seat's Phase 1 file, or holding one with no claim and no "## No findings" or no section heading
  // (empty, cut off, a heading only inside a fence), is not a two-seat review. Any other format problem comes from a file
  // written before the current rule (phase1 --wait refuses it in a new run): it is a note, not an incomplete review.
  const missingSeatFiles = [];
  const seatFormatNotes = {};
  // review-run records a seat whose file was refused again after its one rewrite: that is a refusal, not an old file.
  const formatRefused = await readJsonOrAbsent(path.join(runDir, 'phase1', 'format-refused.json'));
  // A No findings seat that names a block is no clean pass; any seat's block is a caveat, also without review-run.
  const blockedNoFindings = [];
  const parsedBlind = {};
  for (const role of ['A', 'B']) {
    // The untouched Phase 1 copy once the exchange made one, else the working file.
    const seatText = await readFile(path.join(runDir, 'phase1', 'original', `${role}-findings.md`), 'utf8')
      .catch(() => readFile(path.join(runDir, 'phase1', `${role}-findings.md`), 'utf8')).catch(() => '');
    const parsed = parseSeatFile(seatText, role, { sameShape: false });
    if (parsed.section === null || (parsed.claims.length === 0 && parsed.section !== 'No findings')) missingSeatFiles.push(role);
    else if (parsed.problems.length > 0 && !(formatRefused && typeof formatRefused === 'object' && role in formatRefused)) seatFormatNotes[role] = parsed.problems[0];
    if (!missingSeatFiles.includes(role) && parsed.blocked) {
      parsedBlind[role] = [`Blocked: ${parsed.blocked}`];
      if (parsed.section === 'No findings') blockedNoFindings.push(role);
    }
  }
  const noPeerClaims = Array.isArray(exchangeResult?.no_peer_claims) ? exchangeResult.no_peer_claims : [];
  // review-run audit --finish --accept-drift records a target that changed after Phase 1; the report shows it as a caveat.
  const drift = await readJsonOrAbsent(path.join(phase3, 'drift-accepted.json'));
  // review-run phase1 --wait records seats whose own lines say a read or command was blocked.
  const blind = (await readJsonOrAbsent(path.join(runDir, 'seat-warnings-phase1.json')))?.blind ?? parsedBlind;
  // review-run records a CLI seat or auditor whose output stayed open after it was stopped past its answer.
  const stopIncomplete = await readJsonOrAbsent(path.join(runDir, 'stop-incomplete.json'));
  const family = descriptor.auditor.provider === descriptor.seatA.provider ? 'same-as-reviewer-A'
    : descriptor.auditor.provider === descriptor.seatB.provider ? 'same-as-reviewer-B' : 'other';
  return {
    source_write: null,
    falsification: { requested: descriptor.flags.falsification === true, verifiers_run: verifications.length },
    topology: descriptor.skill === 'cross-review' ? 'cross-vendor' : 'same-vendor',
    mode: descriptor.flags.mode,
    status: finished && incompleteSeats.length === 0 && missingSeatFiles.length === 0 && blockedNoFindings.length === 0 && !formatRefused ? 'completed' : 'incomplete',
    ...(missingSeatFiles.length > 0 ? { missing_seat_files: missingSeatFiles } : {}),
    ...(blockedNoFindings.length > 0 ? { blocked_no_findings: blockedNoFindings } : {}),
    ...(formatRefused ? { format_refused: formatRefused } : {}),
    ...(Object.keys(seatFormatNotes).length > 0 ? { seat_format_notes: seatFormatNotes } : {}),
    protocol: 'review-protocol-v1.3',
    reviewers: [
      // The requested model comes from run.json, so a native seat with no dispatcher result.json still records it.
      { role: 'A', provider: descriptor.seatA.provider, model_requested: descriptor.seatA.model ?? null, selection_source: descriptor.seatA.selectionSource ?? 'explicit' },
      { role: 'B', provider: descriptor.seatB.provider, model_requested: descriptor.seatB.model ?? null, selection_source: descriptor.seatB.selectionSource ?? 'explicit' },
    ],
    exchange: {
      // What ran: a blind exchange when exchange finish appended a seat's rebuttals (or, in a run older than that record,
      // a rebuttal section is in a Phase 1 file); an auditor when it wrote its file or non-zero-claim findings exist.
      // An older record has its counts but no appended list: its rebuttal sections decide, as with no record.
      blinded: exchangeResult !== null && typeof exchangeResult === 'object' && Array.isArray(exchangeResult.appended)
        ? exchangeResult.appended.length > 0
        : (await Promise.all(['A', 'B'].map((role) => readFile(path.join(runDir, 'phase1', `${role}-findings.md`), 'utf8').catch(() => ''))))
          .some((text) => /^## Rebuttals \(from [A-Z]\) of [A-Z] claims\s*$/m.test(text)),
      ...(mapping ? { seat_to_audit_label: mapping } : {}),
      auditor_model_family: family,
      auditor: (await readJsonIfPresent(path.join(phase3, 'findings.audit.json'))) !== null || (finished && findingsDoc.zero_claims !== true) ? 'fresh-context' : 'none',
      audit_depth: descriptor.flags.auditDepth,
      ...(incompleteSeats.length > 0 ? { incomplete_seats: incompleteSeats, reason: `the exchange finished without seat ${incompleteSeats.join(', ')}` } : {}),
      ...(noPeerClaims.length > 0 ? { no_peer_claims: noPeerClaims } : {}),
    },
    ...(Array.isArray(drift?.accepted) && drift.accepted.length > 0 ? { drift_accepted: drift.accepted } : {}),
    ...(blind && typeof blind === 'object' && Object.keys(blind).length > 0 ? { seat_blind_lines: blind } : {}),
    ...(stopIncomplete && typeof stopIncomplete === 'object' && Object.keys(stopIncomplete).length > 0 ? { stop_incomplete: Object.keys(stopIncomplete) } : {}),
    ...(descriptor.reviewRules ? { review_rules: { mode: descriptor.reviewRules.mode ?? null, changed_by_target: descriptor.reviewRules.changedByTarget === true, ...(descriptor.reviewRules.baseUnknown === true ? { base_unknown: true } : {}), files: descriptor.reviewRules.files ?? [] } } : {}),
  };
}

// With --run-dir, every input the run left is passed unless its own flag was given: the packet, both untouched Phase 1 files, both
// peer views, the verification files, findings.json, the falsification breakdown and every completed dispatcher result.json
// and result.attempt-<n>.json. An attempt that ended without completing is not counted.
async function collectFromRun(args) {
  const runDir = path.resolve(args.runDir);
  let descriptor;
  try {
    descriptor = await readRunDescriptor(runDir);
  } catch (err) {
    // With --in and --out the run folder only supplies host, support and agent ids (read loosely below); nothing is collected.
    if (args.init || !args.in) throw new RelayError(`--run-dir ${args.runDir}: ${err.message}`);
    return null;
  }
  const first = async (...candidates) => {
    for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
    return null;
  };
  if (!args.taskPacket) args.taskPacket = await first(path.join(runDir, 'task-packet.md'));
  if (descriptor.reviewRules) args.reviewRules = await first(path.join(runDir, 'review-rules.md'));
  // The untouched Phase 1 copies prove what each seat wrote before it saw its peer; the peer views are what each seat was shown.
  if (args.phase1.length === 0) for (const role of ['A', 'B']) { const f = await first(path.join(runDir, 'phase1', 'original', `${role}-findings.md`), path.join(runDir, 'phase1', `${role}-findings.md`)); if (f) args.phase1.push(f); }
  if (args.phase2.length === 0) for (const role of ['A', 'B']) { const f = await first(path.join(runDir, 'phase2', `peer-view-for-${role}.md`)); if (f) args.phase2.push(f); }
  const phase3 = path.join(runDir, 'phase3');
  if (args.verification.length === 0) for (const f of (await readdir(phase3).catch(() => [])).filter((name) => /^verification-.+[.]md$/.test(name)).sort()) args.verification.push(path.join(phase3, f));
  if (!args.findings) args.findings = await first(path.join(phase3, 'findings.json'));
  if (!args.falsification && descriptor.flags.falsification === true) args.falsification = await first(path.join(phase3, 'falsification-breakdown.json'));
  const completed = async (file) => (await readJsonIfPresent(file))?.status === 'completed';
  const explicit = new Set(Object.keys(args.reviewerResults));
  const collect = async (role, file) => { if (!explicit.has(role) && (await completed(file))) (args.reviewerResults[role] ??= []).push(file); };
  // A retried call's earlier attempts (result.attempt-<n>.json, in number order), then its result.json.
  const collectDir = async (role, dir) => {
    for (const entry of (await readdir(dir).catch(() => [])).filter((name) => /^result\.attempt-\d+\.json$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]))) {
      await collect(role, path.join(dir, entry));
    }
    await collect(role, path.join(dir, 'result.json'));
  };
  for (const role of ['A', 'B']) {
    await collectDir(role, path.join(runDir, 'phase1', role));
    await collectDir(role, path.join(runDir, 'phase2', role));
    for (const entry of (await readdir(phase3).catch(() => [])).filter((name) => name.startsWith(`redact-${role}`)).sort()) await collectDir(role, path.join(phase3, entry));
  }
  await collectDir('auditor', path.join(path.dirname(runDir), `${path.basename(runDir)}-audit-dispatch`));
  for (const entry of (await readdir(phase3).catch(() => [])).filter((name) => /^verifier-\d+$/.test(name)).sort()) await collectDir(entry, path.join(phase3, entry));
  if (!args.out) args.out = args.init ? path.join(phase3, 'manifest-body.json') : path.join(runDir, 'manifest.json');
  return descriptor;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function hashFile(filePath, flag) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    throw new RelayError(`${flag} "${filePath}" cannot be read (${err.code || err.message}); pass only files that exist, and leave out a seat whose exchange is incomplete`);
  }
  return sha256(buf);
}

async function hashFileList(paths, flag) {
  const entries = {};
  for (const p of paths) {
    const key = path.basename(p);
    // Entries are keyed by filename, so a second same-named file would silently replace the first hash.
    if (Object.hasOwn(entries, key)) {
      throw new RelayError(`${flag} was given two files named "${key}"; rename one so each hash stays verifiable`);
    }
    entries[key] = await hashFile(p, flag);
  }
  return entries;
}

async function buildHashes(args) {
  const hashes = {};
  if (args.taskPacket) hashes.task_packet = await hashFile(args.taskPacket, '--task-packet');
  if (args.reviewRules) hashes.review_rules = await hashFile(args.reviewRules, 'review-rules.md');
  if (args.phase1.length > 0) hashes.phase1 = await hashFileList(args.phase1, '--phase1');
  if (args.phase2.length > 0) hashes.phase2 = await hashFileList(args.phase2, '--phase2');
  if (args.verification.length > 0) hashes.verifications = await hashFileList(args.verification, '--verification');
  if (args.findings) hashes.findings_json = await hashFile(args.findings, '--findings');
  for (const [name, file] of args.extraArtifacts ?? []) {
    (hashes.extra_artifacts ??= {})[name] = await hashFile(file, `--extra-artifact ${name}`);
  }
  return hashes;
}

// result.json key -> manifest reviewers[] or actors[] key.
const REVIEWER_FIELDS = [
  ['modelRequested', 'model_requested'], ['modelResolved', 'model_resolved'],
  ['host', 'host'], ['transport', 'transport'], ['readOnly', 'readOnly'],
  ['effortRequested', 'effort_requested'], ['effortResolved', 'effort_resolved'],
  ['selectionNote', 'verification_note'], ['isolated', 'isolated'], ['worktreePath', 'worktreePath'],
  ['isolationNote', 'isolationNote'], ['webAccess', 'webAccess'], ['usage', 'usage'], ['durationMs', 'duration_ms'],
];

// Exactly the placeholder strings older copies of the protocol's manifest example used; a real value
// that merely looks like one (an upper-case identifier) is kept.
const LEGACY_PLACEHOLDERS = new Set(['USER_SELECTED_OPENAI_MODEL', '/abs/path/to/worktree', 'No runtime identity metadata available']);

function isUnset(entry, key) {
  if (!Object.hasOwn(entry, key)) return true;
  const v = entry[key];
  return v === null || (typeof v === 'string' && LEGACY_PLACEHOLDERS.has(v));
}

// A saved "default" effort and the null a dispatcher stores mean the same thing.
function sameEffort(field, value) {
  return (field === 'effort_requested' || field === 'effort_resolved') && (value === 'default' || value === undefined) ? null : value;
}

const IDENTITY_FIELDS = ['modelRequested', 'modelResolved', 'effortRequested', 'effortResolved', 'isolated', 'worktreePath', 'host', 'transport', 'readOnly'];

// The calls that report numbers are summed; a call with none (a rate-limited or failed call) is not counted as zero but
// named: the sum is then a lower bound (calls_without_usage). A field some reporting call lacks stays unknown (null).
function sumUsages(usages, source) {
  const numeric = (u) => u && typeof u === 'object' && u.source !== 'unavailable' && Object.values(u).some((v) => typeof v === 'number');
  const known = usages.filter(numeric);
  if (known.length === 0) return { source: 'unavailable', note: 'no call has usable usage numbers; see usage_per_call' };
  const sum = { source };
  const keys = new Set();
  for (const u of known) for (const [k, v] of Object.entries(u)) if (typeof v === 'number') keys.add(k);
  for (const k of keys) sum[k] = known.every((u) => typeof u[k] === 'number') ? known.reduce((s, u) => s + u[k], 0) : null;
  const missing = usages.length - known.length;
  if (missing > 0) Object.assign(sum, { calls_without_usage: missing, note: `lower bound: ${missing} call(s) reported no usage; see usage_per_call` });
  return sum;
}

const hasUsableUsage = (u) => u != null && typeof u === 'object' && u.source !== 'unavailable' && Object.values(u).some((v) => typeof v === 'number');
// An OpenCode result from before it was stamped: a sessionId, no threadId, no usageSemantics. Each is one call.
const isUnstampedOpenCode = (r) => !r.usageSemantics && r.threadId == null && typeof r.sessionId === 'string';

// Per-call results are summed, and so is every set of results that all carry a usable usage_delta (a thread that had
// usage before the review then counts only this review). Other cumulative results (explicit, or older files with no
// usageSemantics and no usage_delta) take each thread's last total, and different threads add up. Results with no
// threadId count as one thread.
// One result alone: a cumulative thread total holds work from before this review, so its usable delta is counted instead.
const ownUsage = (r) => (r.usageSemantics !== 'per-call' && hasUsableUsage(r.usage_delta) ? r.usage_delta : r.usage);

function mergedUsage(results) {
  if (results.length === 1) return ownUsage(results[0]);
  // A call that reported no usage (rate-limited, failed) is left out before the merge is chosen and named: the rest is a lower bound.
  const usable = results.filter((r) => hasUsableUsage(r.usage) || hasUsableUsage(r.usage_delta));
  if (usable.length === 0) return results[results.length - 1].usage;
  const missing = results.length - usable.length;
  const merged = mergeUsable(usable);
  if (missing === 0 || merged == null) return merged;
  const total = (merged.calls_without_usage ?? 0) + missing;
  return { ...merged, calls_without_usage: total, note: `lower bound: ${total} call(s) reported no usage; see usage_per_call` };
}

function mergeUsable(results) {
  if (results.length === 1) return ownUsage(results[0]);
  const last = results[results.length - 1].usage;
  const threads = new Set(results.map((r) => r.threadId ?? null));
  const everyDelta = results.every((r) => hasUsableUsage(r.usage_delta));
  if (!everyDelta && results.every((r) => !r.usageSemantics) && threads.size === 1 && !threads.has(null)) return last;
  const legacyCumulative = results.every((r) => !r.usageSemantics && r.usage_delta == null && !isUnstampedOpenCode(r));
  if (legacyCumulative || (!everyDelta && !results.some((r) => r.usageSemantics === 'per-call') && results.some((r) => r.usageSemantics === 'cumulative'))) {
    const finals = new Map();
    for (const r of results) finals.set(r.threadId ?? null, r);
    if (finals.size === 1) return last;
    return sumUsages([...finals.values()].map((r) => r.usage), 'summed-per-thread');
  }
  return sumUsages(results.map((r) => (r.usageSemantics === 'per-call' ? r.usage : r.usage_delta ?? r.usage)), 'summed-per-call');
}

const BREAKDOWN_KEYS = ['high_or_critical', 'disputed', 'conceded', 'unaddressed'];

// audit-prep's own counts go in unchanged; a value the body already set is kept and a mismatch warned.
async function fillFalsification(existing, file, warnings) {
  let parsed;
  try {
    parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new RelayError(`failed to read/parse --falsification "${file}": ${err.message}`);
  }
  const breakdown = parsed?.falsificationBreakdown ?? parsed;
  for (const key of BREAKDOWN_KEYS) {
    if (!Number.isInteger(breakdown?.[key]) || breakdown[key] < 0) {
      throw new RelayError(`--falsification "${file}" has no whole-number "${key}"; pass the file audit-prep --breakdown-out wrote`);
    }
  }
  const counts = Object.fromEntries(BREAKDOWN_KEYS.map((k) => [k, breakdown[k]]));
  const out = { ...(existing ?? {}) };
  const setOrWarn = (field, value) => {
    if (out[field] === undefined || out[field] === null) out[field] = value;
    else if (JSON.stringify(out[field]) !== JSON.stringify(value)) {
      warnings.push(`falsification.${field} in the body (${JSON.stringify(out[field])}) differs from audit-prep's ${JSON.stringify(value)}; kept the body's value`);
    }
  };
  setOrWarn('breakdown', counts);
  setOrWarn('qualified_claims', counts.disputed);
  if (Array.isArray(breakdown.disputed_ids) && breakdown.disputed_ids.every((id) => typeof id === 'string')) setOrWarn('disputed_ids', breakdown.disputed_ids);
  // Only the orchestrator knows whether falsification ran, so a missing value is reported, never guessed.
  for (const field of ['requested', 'verifiers_run']) {
    if (out[field] === undefined || out[field] === null) {
      warnings.push(`falsification.${field} is not set in the body; write it (for example requested: false, verifiers_run: 0 when falsification was not asked for)`);
    }
  }
  return out;
}

// The earliest phase1 brief's write time (a native seat's brief-<seat>.txt or a CLI seat's <seat>/brief.txt), or null.
async function firstBriefTime(runDir) {
  const files = ['brief-A.txt', 'brief-B.txt', path.join('A', 'brief.txt'), path.join('B', 'brief.txt')].map((f) => path.join(runDir, 'phase1', f));
  const times = (await Promise.all(files.map((f) => stat(f).then((s) => s.mtimeMs, () => null)))).filter((ms) => ms !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

async function fillReviewers(manifest, reviewerResults, warnings = [], collection = 'reviewers') {
  const reviewers = Array.isArray(manifest[collection]) ? manifest[collection].map((r) => ({ ...r })) : [];
  for (const [role, fileOrFiles] of Object.entries(reviewerResults)) {
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    const results = [];
    for (const file of files) {
      let result;
      try {
        result = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      } catch (err) {
        throw new RelayError(`--reviewer-result ${role}: failed to read/parse "${file}": ${err.message}`);
      }
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'modelRequested')) {
        throw new RelayError(`--reviewer-result ${role}: "${file}" is not a dispatcher result.json (no modelRequested)`);
      }
      if (result.status === 'running') {
        throw new RelayError(
          `--reviewer-result ${role}: "${file}" has status "running" (the dispatcher was killed before codex finished); ` +
            'pass the result.json of the call that resumed that thread instead -- a Codex thread\'s usage is cumulative, so it covers the interrupted work'
        );
      }
      if (result.usageSemantics !== undefined && !['cumulative', 'per-call'].includes(result.usageSemantics)) {
        throw new RelayError(`--reviewer-result ${role}: "${file}" has invalid usageSemantics; expected cumulative or per-call`);
      }
      results.push(result);
    }
    // Every call of one seat must be the same model, effort and isolation; a mis-dispatched call
    // must not disappear into a merged entry. Each auditor or verifier dispatch gets its own temporary worktree.
    for (const key of IDENTITY_FIELDS.filter((k) => !(collection === 'actors' && k === 'worktreePath'))) {
      const values = [...new Set(results.map((r) => JSON.stringify(r[key] ?? null)))];
      if (values.length > 1) {
        throw new RelayError(`--reviewer-result ${role}: the result files disagree on ${key} (${values.join(' vs ')}); pass only calls of one seat`);
      }
    }
    let entry = reviewers.find((r) => r && r.role === role);
    if (!entry) {
      entry = { role };
      reviewers.push(entry);
    }
    const merged = { ...results[0], usage: mergedUsage(results) };
    if (collection === 'actors' && Object.hasOwn(results.at(-1), 'worktreePath')) merged.worktreePath = results.at(-1).worktreePath;
    for (const field of ['host', 'transport', 'readOnly']) merged[field] ??= null;
    if (merged.usage == null || (results.some((r) => r.usageSemantics) && (merged.usage.source === 'unavailable' || !Object.values(merged.usage).some(Number.isFinite)))) {
      merged.usage_reason = merged.usage?.note ?? merged.usage?.reason ?? 'dispatcher reported no usable usage numbers; see usage_per_call';
      merged.usage = null;
    }
    if (results.every((r) => typeof r.durationMs === 'number')) merged.durationMs = results.reduce((s, r) => s + r.durationMs, 0);
    for (const [from, to] of REVIEWER_FIELDS) {
      if (!Object.hasOwn(merged, from)) continue;
      if (isUnset(entry, to)) {
        entry[to] = merged[from];
      } else if (to !== 'usage' && to !== 'duration_ms' && JSON.stringify(sameEffort(to, entry[to])) !== JSON.stringify(sameEffort(to, merged[from]))) {
        warnings.push(`${collection}[${role}].${to} is ${JSON.stringify(entry[to])} in the body but ${JSON.stringify(merged[from])} in ${files[0]}; kept the body's value`);
      }
    }
    if (results.length > 1 && isUnset(entry, 'usage_per_call')) {
      entry.usage_per_call = results.map((r) => (r.usageSemantics === 'per-call' ? r.usage : r.usage_delta ?? r.usage) ?? null);
    }
    if (merged.usage_reason && isUnset(entry, 'usage_reason')) entry.usage_reason = merged.usage_reason;
    // Agents a Codex seat spawned bill the same account but are not in "usage".
    const children = results.flatMap((r) => (Array.isArray(r.childThreads) ? r.childThreads : []));
    if (children.length > 0 && isUnset(entry, 'child_threads')) {
      entry.child_threads = children;
      warnings.push(`${collection}[${role}]: the seat spawned ${children.length} agent thread(s) whose tokens are not in usage; see child_threads`);
    }
    if (isUnset(entry, 'commands')) {
      const commands = await resultCommands(results);
      if (commands) entry.commands = commands;
    }
  }
  return reviewers;
}

// Shell commands a CLI seat tried over all its calls, each session or thread read once: a Claude CLI session transcript
// (the result has a sessionId) or a Codex thread rollout. A call whose record cannot be found or read makes it unknown (null).
async function resultCommands(results) {
  const sessionsDir = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  const seen = new Set();
  const sum = { tried: 0, failed: 0, source: null };
  for (const r of results) {
    const claude = typeof r.sessionId === 'string';
    const id = claude ? r.sessionId : r.threadId;
    if (typeof id !== 'string' || !id) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    const files = claude ? await findSessionTranscripts(id) : [await findThreadRollout(id, sessionsDir)].filter(Boolean);
    if (files.length !== 1) return null;
    const text = await readFile(files[0], 'utf8').catch(() => null);
    const counted = text === null ? null : claude ? transcriptCommands(text) : rolloutCommands(text);
    const source = claude ? 'claude-transcript' : 'codex-rollout';
    if (!counted || (sum.source !== null && sum.source !== source)) return null;
    sum.tried += counted.tried;
    sum.failed += counted.failed;
    if (counted.scripts) {
      sum.scripts = (sum.scripts ?? 0) + counted.scripts;
      sum.scriptsFailed = (sum.scriptsFailed ?? 0) + counted.scriptsFailed;
    }
    sum.source = source;
  }
  return sum.source === null ? null : sum;
}

// An agent id (the Agent tool's agentId) is looked up as <config>/projects/*/*/subagents/agent-<id>.jsonl, a Codex thread id as its rollout.
async function resolveTranscript(role, value) {
  const found = await findAgentTranscripts(value);
  if (found.length === 0) throw new RelayError(`--seat-transcript ${role}: no agent with id "${value}" under the Claude projects folder or the Codex sessions folder: check the id the Agent tool returned, or pass the .jsonl path`);
  if (found.length !== 1) {
    throw new RelayError(`--seat-transcript ${role}: agent id "${value}" matched ${found.length} transcripts under the Claude projects folder or the Codex sessions folder; pass the .jsonl path instead`);
  }
  return found[0];
}

// Sums every API call's own usage, each message id once (one reply is written as several lines).
// This is the same quantity a Codex result.json reports: input re-sent on every call counts every time.
async function transcriptUsage(role, files) {
  const calls = new Map();
  const used = [];
  const read = [];
  const commands = { tried: 0, failed: 0, source: 'transcript' };
  let skipped = 0;
  let activeMs = 0;
  let timed = false;
  let since = null;
  let until = null;
  // Of the copies of one session (the same file name in several project folders, with the same window) only the newest is counted.
  const groups = new Map();
  const starts = [];
  const ends = [];
  let bare = 0;
  for (const raw of files) {
    // "<transcript>@<ISO start>[/<ISO end>]" counts only entries in that window: one review in a
    // shared session. Without an end, it runs to the end of the transcript.
    const at = /@(\d{4}-\d{2}-\d{2}T[^@/]+)(?:\/(\d{4}-\d{2}-\d{2}T[^@/]+))?$/.exec(raw);
    const value = at ? raw.slice(0, at.index) : raw;
    const fromMs = at ? Date.parse(at[1]) : null;
    const toMs = at?.[2] ? Date.parse(at[2]) : null;
    if (at && !Number.isFinite(fromMs)) throw new RelayError(`--seat-transcript ${role}: "${at[1]}" after @ is not a date and time such as 2026-09-30T14:05:00Z`);
    if (at?.[2] && !Number.isFinite(toMs)) throw new RelayError(`--seat-transcript ${role}: "${at[2]}" after / is not a date and time such as 2026-09-30T15:00:00Z`);
    if (toMs !== null && toMs <= fromMs) throw new RelayError(`--seat-transcript ${role}: the end ${at[2]} is not after the start ${at[1]}`);
    if (at) starts.push({ ms: fromMs, text: at[1] });
    else bare++;
    if (at?.[2]) ends.push({ ms: toMs, text: at[2] });
    const file = await resolveTranscript(role, value);
    const key = `${path.basename(file)}\0${fromMs ?? ''}\0${toMs ?? ''}`;
    if (!groups.has(key)) groups.set(key, { fromMs, toMs, copies: [] });
    groups.get(key).copies.push(file);
  }
  // The span from the earliest start to the latest end (of one instant spelled two ways, the last given); a bound is
  // left out when a transcript was given without it.
  if (bare === 0 && starts.length > 0) since = starts.reduce((min, s) => (s.ms <= min.ms ? s : min)).text;
  if (ends.length > 0 && ends.length === files.length) until = ends.reduce((max, e) => (e.ms >= max.ms ? e : max)).text;
  for (const { fromMs, toMs, copies } of groups.values()) {
    // The copy with the latest entry, then the most lines, then the first given.
    let best = null;
    for (const copy of copies) {
      let text;
      try {
        text = await readFile(copy, 'utf8');
      } catch (err) {
        throw new RelayError(`--seat-transcript ${role}: failed to read "${copy}": ${err.message}`);
      }
      const lines = text.split('\n').filter((line) => line.trim());
      const latest = lines.reduce((max, line) => {
        try { const ms = Date.parse(JSON.parse(line).timestamp); return ms > max ? ms : max; } catch { return max; }
      }, -Infinity);
      if (!best || latest > best.latest || (latest === best.latest && lines.length > best.lines)) best = { file: copy, text, latest, lines: lines.length };
    }
    const { file, text } = best;
    let first;
    try { first = JSON.parse(text.replace(/^\uFEFF/, '').split('\n', 1)[0]); } catch {}
    if (first?.type === 'session_meta') {
      if (files.length !== 1) throw new RelayError(`--seat-transcript ${role}: pass one Codex rollout per role, with one usage window`);
      const timestamps = text.split('\n').flatMap((line) => {
        try { const ms = Date.parse(JSON.parse(line).timestamp); return Number.isFinite(ms) ? [ms] : []; } catch { return []; }
      });
      const usage = rolloutUsage(text.replace(/^\uFEFF/, ''), { start: fromMs, end: fromMs !== null ? toMs ?? timestamps.reduce((latest, ms) => Math.max(latest, ms), fromMs) : null });
      const commands = rolloutCommands(text, { start: fromMs, end: toMs });
      return {
        ...usage, source: 'codex-rollout', transcripts: [path.basename(file)],
        model_resolved: rolloutModel(text), model_resolved_note: 'the model in the thread rollout turn_context: the configured model, as for a Codex CLI seat',
        ...(usage.source === 'unavailable' ? { input_tokens: null, cached_input_tokens: null, cache_write_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null } : {}),
        active_ms: null, active_ms_note: 'working time is not recorded by rollout token events',
        ...(since !== null ? { counted_from: since } : {}),
        ...(until !== null ? { counted_until: until } : {}),
        ...(commands ? { commands: { ...commands, source: 'codex-rollout' } } : {}),
      };
    }
    const claude = text.split('\n').some((line) => {
      try { const e = JSON.parse(line); return e.type === 'assistant' && e.message && typeof e.message === 'object'; } catch { return false; }
    });
    if (!claude) throw new RelayError(`--seat-transcript ${role}: neither a Codex rollout (session_meta first line) nor a Claude session transcript; no API usage found in ${file}`);
    used.push(path.basename(file));
    read.push(file);
    // Working time: a gap counts only when it ends in the model's reply or a tool result, and not
    // while waiting after a final reply (stop_reason "end_turn" or a SubagentHandback tool call).
    // A gap that ends at a new prompt, an interrupt or a queued message was a wait.
    let prevAt = null;
    let prevEnded = false;
    let awaitingTool = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }
      const m = e?.message;
      const entryAt = Date.parse(e?.timestamp);
      if (fromMs !== null && !(entryAt >= fromMs)) continue;
      if (toMs !== null && !(entryAt < toMs)) continue;
      if (e?.type === 'assistant' && m?.id && m.usage && typeof m.usage === 'object') calls.set(m.id, { usage: m.usage, model: typeof m.model === 'string' ? m.model : null });
      const at = entryAt;
      if (Number.isFinite(at)) {
        const content = Array.isArray(m?.content) ? m.content : [];
        const isToolResult = e?.type === 'user' && content.some((c) => c?.type === 'tool_result');
        const isWork = e?.type === 'assistant' || isToolResult;
        // A running tool is work even when a queued message is logged before its result.
        if (prevAt !== null && !prevEnded && (isWork || awaitingTool) && at > prevAt) activeMs += at - prevAt;
        if (prevAt !== null) timed = true;
        prevAt = at;
        if (e?.type === 'assistant') {
          const handsBack = content.some((c) => c?.type === 'tool_use' && c.name === 'SubagentHandback');
          prevEnded = m?.stop_reason === 'end_turn' || handsBack;
          awaitingTool = m?.stop_reason === 'tool_use' && !handsBack;
        } else if (e?.type === 'user') {
          awaitingTool = false;
          if (!isToolResult) prevEnded = false;
        }
      }
    }
    const tally = transcriptCommands(text, { start: fromMs, end: toMs });
    commands.tried += tally.tried;
    commands.failed += tally.failed;
  }
  if (calls.size === 0) throw new RelayError(`--seat-transcript ${role}: no API usage found in ${read.join(', ')}; is it a subagent transcript?`);
  const out = {
    source: 'transcript', transcripts: used, calls: calls.size,
    input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    // The transcript keeps the usage snapshot from the start of each reply: input is final there,
    // output is not (a 28k-character reply is logged as 3 output tokens).
    output_tokens: null, output_tokens_note: 'not in the transcript: it records output_tokens from the start of each reply, before the reply is written',
    total_input_tokens: 0, max_context_tokens: 0, models: {},
  };
  for (const { usage: u, model } of calls.values()) {
    if (model) out.models[model] = (out.models[model] ?? 0) + 1;
    const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0);
    const ctx = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    out.input_tokens += n('input_tokens');
    out.cache_creation_input_tokens += n('cache_creation_input_tokens');
    out.cache_read_input_tokens += n('cache_read_input_tokens');
    out.total_input_tokens += ctx;
    out.max_context_tokens = Math.max(out.max_context_tokens, ctx);
  }
  const inputKeys = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  const missing = [...calls.values()].some(({ usage }) => !inputKeys.some((key) => Number.isFinite(usage[key]))) ? inputKeys : [];
  if (missing.length > 0) {
    for (const key of missing) out[key] = null;
    out.total_input_tokens = null;
    out.max_context_tokens = null;
    out.reason = `missing transcript usage fields: ${missing.join(', ')}`;
  } else {
    out.new_input_tokens = out.input_tokens + out.cache_creation_input_tokens;
    out.context_reread_tokens = out.cache_read_input_tokens;
    out.usage_note = 'total_input_tokens counts the whole context re-sent on every call; new_input_tokens is what this actor added, context_reread_tokens is the cached context read again';
  }
  out.active_ms = timed ? activeMs : null;
  if (since !== null) out.counted_from = since;
  if (until !== null) out.counted_until = until;
  if (skipped > 0) out.unparsed_lines = skipped;
  out.commands = commands;
  return out;
}

// skill_versions from <run-dir>/skill-versions.jsonl, which build-brief appends to for every brief:
// {phase1: "1.8.13", phase2: "1.8.14", ...}, a list when one phase used several, and the skill name
// in front when the run moved between skills. Null when the file is absent.
// Completed dispatcher result.json and result.attempt-<n>.json files under the run dir (a dispatcher writes
// one next to each brief), and in the auditor's <run-dir>-audit-dispatch beside it, that no --reviewer-result names.
// Only a folder with phase1/ is treated as a run dir.
async function unlistedResults(runDir, reviewerResults) {
  const passed = new Set(Object.values(reviewerResults).flat().map(comparablePath));
  const found = [];
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && /^result(?:\.attempt-\d+)?\.json$/.test(e.name) && !passed.has(comparablePath(p))) {
        try {
          if (JSON.parse(await readFile(p, 'utf8')).status === 'completed') found.push(p);
        } catch {
          // Not a dispatcher result; nothing to report.
        }
      }
    }
  };
  try {
    if (!(await stat(path.join(runDir, 'phase1'))).isDirectory()) return found;
  } catch {
    return found;
  }
  await walk(runDir, 0);
  await walk(path.join(path.dirname(runDir), `${path.basename(runDir)}-audit-dispatch`), 3);
  return found.sort();
}

async function recordedSkillVersions(runDir) {
  let text;
  try {
    text = await readFile(path.join(runDir, 'skill-versions.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new RelayError(`failed to read ${path.join(runDir, 'skill-versions.jsonl')}: ${err.message}`);
  }
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r?.phase && r.version);
  if (rows.length === 0) return null;
  const skills = new Set(rows.map((r) => r.skill));
  const byPhase = {};
  for (const r of rows) {
    const label = skills.size > 1 ? `${r.skill} ${r.version}` : r.version;
    const list = (byPhase[r.phase] ??= []);
    if (!list.includes(label)) list.push(label);
  }
  const out = {};
  for (const phase of Object.keys(byPhase).sort()) out[phase] = byPhase[phase].length === 1 ? byPhase[phase][0] : byPhase[phase];
  return out;
}

// The version line of the SKILL.md next to this script's folder ("metadata: version: 1.6.7").
async function ownSkillVersion() {
  try {
    const skillMd = await readFile(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'SKILL.md'), 'utf8');
    return /^\s+version:\s*(\S+)\s*$/m.exec(skillMd)?.[1] ?? null;
  } catch {
    return null;
  }
}

// --seat-transcript <role>=auto[@window]: this session's own transcript, named by the host's environment (Claude Code's
// CLAUDE_CODE_SESSION_ID is the transcript's file name even after a resume; Codex's CODEX_THREAD_ID is a thread id). A session
// that moved to another project folder has a file of that name in each; all with a reply are given, and the newest is counted.
export async function resolveAutoTranscript(spec, env = process.env) {
  const m = /^auto(@.*)?$/.exec(spec);
  if (!m) return spec;
  const window = m[1] ?? '';
  if (env.CLAUDE_CODE_SESSION_ID) {
    const files = await findSessionTranscripts(env.CLAUDE_CODE_SESSION_ID, env);
    // A copy with no reply (a stub left in another project folder) is skipped while another copy has one.
    const replied = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.includes('"assistant"') && text.split('\n').some((line) => {
        try { const e = JSON.parse(line); return e.type === 'assistant' && e.message && typeof e.message === 'object'; } catch { return false; }
      })) replied.push(file);
    }
    if (files.length > 0) return (replied.length > 0 ? replied : files).map((file) => `${file}${window}`);
    throw new RelayError(`--seat-transcript ...=auto: no transcript <config>/projects/*/${env.CLAUDE_CODE_SESSION_ID}.jsonl for this Claude Code session; pass its path`);
  }
  if (env.CODEX_THREAD_ID) return `${env.CODEX_THREAD_ID}${window}`;
  throw new RelayError("--seat-transcript ...=auto needs CLAUDE_CODE_SESSION_ID (Claude Code) or CODEX_THREAD_ID (Codex) in the environment: run review-run manifest from the orchestrator's own shell, or pass the transcript path");
}

async function run(args) {
  let initial = null;
  for (const [role, specs] of Object.entries(args.seatTranscripts ?? {})) args.seatTranscripts[role] = (await Promise.all(specs.map((s) => resolveAutoTranscript(s)))).flat();
  if (args.runDir) {
    const descriptor = await collectFromRun(args);
    if (args.init) {
      // --init writes no usage; a --seat-transcript given here (the orchestrator's own) is kept for the run without --init.
      if (Object.keys(args.seatTranscripts).length > 0) {
        const file = path.join(path.resolve(args.runDir), 'seat-transcripts.json');
        const kept = await readJsonOrAbsent(file) ?? {};
        await writeFile(file, `${JSON.stringify({ ...kept, ...args.seatTranscripts }, null, 2)}\n`, 'utf8');
      }
      await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await writeFile(path.resolve(args.out), JSON.stringify(await initBody(descriptor, path.resolve(args.runDir)), null, 2) + String.fromCharCode(10), { flag: 'wx' });
      io.out(`build-manifest: wrote the minimal body ${path.resolve(args.out)}; add what only you know, then run without --init\n`);
      return null;
    }
    if (!args.in && descriptor) {
      initial = await initBody(descriptor, path.resolve(args.runDir));
      // A body written with --init keeps what only the orchestrator added; the fields read from the run are recomputed
      // now, so a body written before the review finished cannot leave a stale status.
      const bodyPath = path.join(path.resolve(args.runDir), 'phase3', 'manifest-body.json');
      const edited = await readJsonOrAbsent(bodyPath);
      if (edited) {
        initial = mergeEditedBody(edited, initial);
        // stdout: on stderr PowerShell 5.1 shows this note as an error at exit 0.
        io.out(`build-manifest: kept the hand-added fields of ${bodyPath}\n`);
      }
    }
  }
  if (args.runDir) {
    let agents = null;
    try {
      agents = JSON.parse(await readFile(path.join(args.runDir, 'native-agents.json'), 'utf8'));
    } catch { /* none recorded */ }
    for (const role of ['A', 'B', 'auditor']) {
      if (agents && typeof agents[role] === 'string' && !(args.seatTranscripts[role]?.length > 0)) (args.seatTranscripts[role] ??= []).push(agents[role]);
    }
    // Transcripts given to --init; one given now for the same role wins.
    const kept = await readJsonOrAbsent(path.join(args.runDir, 'seat-transcripts.json'));
    for (const [role, specs] of Object.entries(kept ?? {})) {
      if (Array.isArray(specs) && !(args.seatTranscripts[role]?.length > 0)) args.seatTranscripts[role] = specs.filter((s) => typeof s === 'string');
    }
  }
  let manifest = initial;
  if (initial === null) try {
    // A BOM (PowerShell Set-Content -Encoding utf8 writes one) is not valid JSON.
    manifest = JSON.parse((await readFile(args.in, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new RelayError(`failed to read/parse --in "${args.in}": ${err.message}`);
  }

  if (Object.hasOwn(manifest, 'run_id')) {
    throw new RelayError(
      `--in "${args.in}" already has a "run_id" field; refusing to overwrite it. ` +
        `build-manifest.mjs only adds these fields, it never replaces an existing value.`
    );
  }
  if (Object.hasOwn(manifest, 'hashes')) {
    throw new RelayError(
      `--in "${args.in}" already has a "hashes" field; refusing to overwrite it. ` +
        `build-manifest.mjs only adds these fields, it never replaces an existing value.`
    );
  }

  const seatUsage = { ...(args.seatUsage ?? {}) };
  const warnings = [];
  for (const [role, files] of Object.entries(args.seatTranscripts ?? {})) {
    let fromTranscript;
    try {
      fromTranscript = await transcriptUsage(role, files);
    } catch (err) {
      // The orchestrator's own cost is extra: its transcript with no usage in the window is a warning. A mistyped window or
      // a file that is no transcript still stops.
      if (role !== 'orchestrator' || !(err instanceof RelayError) || !/: no API usage found in .*; is it a subagent transcript\?$/.test(err.message)) throw err;
      warnings.push(`seat_usage.orchestrator is not counted: ${err.message}`);
      continue;
    }
    // A Codex rollout with no token events in the window is recorded as unknown (with its reason) and said here too.
    if (role === 'orchestrator' && fromTranscript.total_tokens === null && fromTranscript.source === 'codex-rollout') {
      warnings.push(`seat_usage.orchestrator is not counted: no token usage in ${fromTranscript.transcripts?.join(', ') ?? 'the rollout'} in that window`);
    }
    // --seat-usage for the same seat still supplies the clock duration a transcript cannot give.
    const hand = seatUsage[role];
    // The transcript's own working time beats a hand figure unless that figure is a clock span:
    // the harness duration of a Claude seat is unreliable, and an estimate is not a measurement.
    const handMs = hand?.duration_ms ?? null;
    const handWins = handMs !== null && (hand.source === 'clock' || fromTranscript.active_ms === null);
    seatUsage[role] = {
      ...fromTranscript,
      duration_ms: handWins ? handMs : fromTranscript.active_ms,
      ...(handWins ? { duration_source: hand.source } : fromTranscript.active_ms !== null ? { duration_source: 'transcript' } : {}),
      ...(handMs !== null && !handWins ? { duration_hand_ms: handMs, duration_hand_source: hand.source } : {}),
    };
  }
  // A body's own seat_usage (a rebuilt manifest) may gain a role it lacks, such as a later verifier,
  // but a role it already records is never replaced.
  const bodyUsage = Object.hasOwn(manifest, 'seat_usage') ? manifest.seat_usage : null;
  if (bodyUsage !== null) {
    if (typeof bodyUsage !== 'object' || Array.isArray(bodyUsage)) throw new RelayError(`--in "${args.in}" has a "seat_usage" that is not an object`);
    // Passing the same transcript again yields the same record, so only a different value is refused.
    const clash = Object.keys(seatUsage).filter((role) => Object.hasOwn(bodyUsage, role) && JSON.stringify(bodyUsage[role]) !== JSON.stringify(seatUsage[role]));
    if (clash.length > 0) {
      throw new RelayError(`--in "${args.in}" already has a different seat_usage for ${clash.join(', ')}; refusing to overwrite it. Pass only the roles to add.`);
    }
  }

  const reviewerResults = args.reviewerResults ?? {};
  // A window started from a late timestamp (run.json is rewritten late) silently drops most of the orchestrator's work.
  const firstBrief = args.runDir ? await firstBriefTime(path.resolve(args.runDir)) : null;
  for (const [role, u] of Object.entries(seatUsage)) {
    if (firstBrief !== null && u?.counted_from && Date.parse(u.counted_from) > firstBrief + 60000) {
      warnings.push(`seat_usage.${role} counts from ${u.counted_from}, but the first brief was written at ${new Date(firstBrief).toISOString()}: the work before it is not counted; pass @${new Date(firstBrief).toISOString()} (or earlier) as the start`);
    }
  }
  // The orchestrator's own cost is counted only from its transcript: say which flag adds it. A body entry counts only with a number in it.
  const bodyOrchestrator = bodyUsage?.orchestrator;
  const bodyCounted = bodyOrchestrator !== null && typeof bodyOrchestrator === 'object' && !Array.isArray(bodyOrchestrator) && Object.values(bodyOrchestrator).some(Number.isFinite);
  if (firstBrief !== null && !(args.seatTranscripts?.orchestrator?.length > 0) && !Object.hasOwn(seatUsage, 'orchestrator') && !bodyCounted) {
    warnings.push(`seat_usage.orchestrator is not counted: no --seat-transcript orchestrator was given; to count this session's own cost, rerun review-run manifest with --seat-transcript orchestrator=auto@${new Date(firstBrief).toISOString()} (the first brief time; or the session .jsonl path with that @start)`);
  }
  const seats = Object.fromEntries(Object.entries(reviewerResults).filter(([role]) => role === 'A' || role === 'B'));
  const actors = Object.fromEntries(Object.entries(reviewerResults).filter(([role]) => role !== 'A' && role !== 'B'));
  if (Object.keys(seats).length > 0) manifest.reviewers = await fillReviewers(manifest, seats, warnings);
  if (Object.keys(actors).length > 0) manifest.actors = await fillReviewers(manifest, actors, warnings, 'actors');
  if (args.falsification) manifest.falsification = await fillFalsification(manifest.falsification, args.falsification, warnings);
  // A deep-verify pass that was asked for and ran fewer verifiers than claims qualified (audit --accept-missing-verifiers) is not complete.
  // The measured count from audit-prep's breakdown wins over a value typed into the body.
  const fals = manifest.falsification;
  const qualified = Number.isInteger(fals?.breakdown?.disputed) ? fals.breakdown.disputed : fals?.qualified_claims;
  // By claim when audit-prep named them and verification files were passed: a file for another claim does not cover one.
  const verified = new Set((args.verification ?? []).map((f) => /^verification-([XY]\d+)\.md$/.exec(path.basename(f))?.[1]).filter(Boolean));
  const uncovered = Array.isArray(fals?.disputed_ids) && verified.size > 0 ? fals.disputed_ids.filter((id) => !verified.has(id)) : null;
  const short = uncovered ? uncovered.length > 0 : Number.isInteger(qualified) && Number.isInteger(fals?.verifiers_run) && fals.verifiers_run < qualified;
  if (fals?.requested === true && short) {
    manifest.status = 'incomplete';
    warnings.push(uncovered
      ? `falsification was requested and ${qualified} claim(s) qualified, but no verification file names ${uncovered.join(', ')}; status is incomplete`
      : `falsification was requested and ${qualified} claim(s) qualified, but ${fals.verifiers_run} verifier(s) ran; status is incomplete`);
  }
  const recorded = await recordedSkillVersions(path.dirname(path.resolve(args.out)));
  if (recorded) {
    if (!Object.hasOwn(manifest, 'skill_versions')) manifest.skill_versions = recorded;
    else if (JSON.stringify(manifest.skill_versions) !== JSON.stringify(recorded)) {
      warnings.push(`the body's skill_versions ${JSON.stringify(manifest.skill_versions)} differs from what build-brief recorded, ${JSON.stringify(recorded)}; the body is kept`);
    }
    const distinct = [...new Set(Object.values(recorded).flat())];
    if (distinct.length > 1) warnings.push(`the skill version changed during the run: ${distinct.join(', ')}`);
  }
  if (args.runDir) {
    let descriptor = null;
    try {
      const raw = await readFile(path.join(args.runDir, 'run.json'), 'utf8');
      descriptor = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (err) {
      warnings.push(`--run-dir ${args.runDir}: run.json could not be read (${err.message}); no support record was added`);
    }
    // A result.json does not say which provider ran it; run.json does, and the report's cost table reads the usage shape from it.
    for (const actor of descriptor && Array.isArray(manifest.actors) ? manifest.actors : []) {
      const planned = actor.role === 'auditor' ? descriptor.auditor : (descriptor.verifiers ?? []).find((v) => v?.role === actor.role);
      if (isUnset(actor, 'provider') && planned?.provider) actor.provider = planned.provider;
    }
    if (descriptor && Array.isArray(descriptor.support)) {
      if (!Object.hasOwn(manifest, 'host')) manifest.host = descriptor.host;
      if (!Object.hasOwn(manifest, 'support')) manifest.support = descriptor.support;
      if (!Object.hasOwn(manifest, 'host_status')) manifest.host_status = descriptor.support.some((row) => row.status === 'trial') ? 'trial' : 'supported';
    }
  }
  const hasPhase1 = args.runDir && (await stat(path.join(args.runDir, 'phase1')).then((s) => s.isDirectory(), () => false));
  for (const file of await unlistedResults(hasPhase1 ? path.resolve(args.runDir) : path.dirname(path.resolve(args.out)), reviewerResults)) {
    warnings.push(`${file} is a completed call that was not passed to --reviewer-result (a session probe, an earlier attempt, or a seat call left out); its tokens and duration are not in this manifest`);
  }
  for (const w of warnings) io.err(`build-manifest: WARNING: ${w}\n`);

  const hashes = await buildHashes(args);
  const stamped = { ...manifest, run_id: randomUUID(), hashes };
  if (Object.keys(seatUsage).length > 0) stamped.seat_usage = { ...(bodyUsage ?? {}), ...seatUsage };
  // A reviewer entry read on its own looks free when its cost sits in seat_usage; point to it and carry the model.
  for (const reviewer of Array.isArray(stamped.reviewers) ? stamped.reviewers : []) {
    const used = stamped.seat_usage?.[reviewer.role];
    if (!used) continue;
    if (isUnset(reviewer, 'usage') && isUnset(reviewer, 'usage_ref')) reviewer.usage_ref = `seat_usage.${reviewer.role}`;
    // A Claude transcript lists its models; a Codex rollout names the one model it ran.
    const models = used.models ? Object.keys(used.models) : typeof used.model_resolved === 'string' ? [used.model_resolved] : [];
    if (isUnset(reviewer, 'model_resolved') && models.length === 1) {
      reviewer.model_resolved = models[0];
      reviewer.model_resolved_source = 'transcript';
    }
  }
  if (!Object.hasOwn(stamped, 'skill_version')) {
    const version = await ownSkillVersion();
    if (version) stamped.skill_version = version;
  }

  await writeFile(args.out, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  // Not part of the manifest JSON; lets a caller (and the tests) see what was reported.
  Object.defineProperty(stamped, 'warnings', { value: warnings, enumerable: false });
  return stamped;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      io.err(`build-manifest: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  try {
    const stamped = await run(args);
    if (stamped) io.out(`build-manifest: wrote ${args.out} (run_id ${stamped.run_id})\n`);
    return 0;
  } catch (err) {
    if (err instanceof RelayError) {
      io.err(`build-manifest: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// One manifest build in-process: { code, stdout, stderr }.
const runStep = (argv) => runStepWith('build-manifest', io, main, argv);

export { parseArgs, buildHashes, run, sha256, hashFile, RelayError, runStep, firstBriefTime };

refuseDirectRun(import.meta.url, 'build-manifest.mjs');
