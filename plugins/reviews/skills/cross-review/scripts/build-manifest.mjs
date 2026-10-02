#!/usr/bin/env node
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
// codex-dispatch.mjs/opencode-dispatch.mjs's RESULT_REQUIRED_KEYS); this
// script does not duplicate them onto the manifest, it leaves them where
// the dispatcher that owns that data already wrote them. A harness seat (a
// Claude subagent) has no result.json, so --seat-transcript sums its token use from
// its own transcript and --seat-usage adds the duration, both as "seat_usage".

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

class RelayError extends Error {}

function printUsageAndExit(code) {
  process.stderr.write(
    `Usage: node build-manifest.mjs --in <manifest.json> --out <manifest.json>\n` +
      `  --task-packet <path> [--phase1 <path>]... [--phase2 <path>]...\n` +
      `  [--verification <path>]... [--findings <findings.json>]\n` +
      `  [--seat-transcript <A|B|auditor|verifier|orchestrator>=<transcript .jsonl | agent id>]...\n` +
      `  [--seat-usage <A|B|auditor>=<final context tokens|unknown>,<duration ms|unknown>[,estimated]]...\n` +
      `  [--reviewer-result <A|B>=<dispatcher result.json>]...\n` +
      `  [--falsification <file written by audit-prep --breakdown-out>]\n\n` +
      `--falsification fills falsification.breakdown and falsification.qualified_claims\n` +
      `(the disputed HIGH/CRITICAL count) from audit-prep's breakdown file, so nobody\n` +
      `retypes them. A value the body already sets is kept and a difference is reported\n` +
      `as a WARNING; requested and verifiers_run are still authored, and a WARNING\n` +
      `names either one the body leaves out.\n\n` +
      `--reviewer-result fills that role's reviewers[] entry from a Codex/OpenCode\n` +
      `dispatcher result.json: model_requested/_resolved, effort_requested/_resolved,\n` +
      `verification_note, isolated, worktreePath, isolationNote, webAccess, usage and\n` +
      `duration_ms. A field the body already sets is never changed; null and the\n` +
      `protocol example's placeholders (USER_SELECTED_OPENAI_MODEL, /abs/path/to/worktree,\n` +
      `"No runtime identity metadata available") count as not set. A missing entry is\n` +
      `created as {role}. provider and selection_source are still authored. A body value\n` +
      `that differs from result.json is kept and reported as a WARNING. Repeat the flag\n` +
      `for one role (Phase 1, exchange, redaction results): the files must agree on model,\n` +
      `effort and isolation; duration_ms is summed; usage_per_call lists each call; usage\n` +
      `is the last file's when all share one threadId (Codex totals), else the per-call sum.\n\n` +
      `skill_version is stamped from this skill's SKILL.md unless the body sets it.\n` +
      `skill_versions ({phase1: ..., phase2: ..., phase3: ...}) is filled from\n` +
      `skill-versions.jsonl in --out's folder, which build-brief appends to for every\n` +
      `brief; a body value is kept, and a mid-run version change is a WARNING.\n\n` +
      `--seat-transcript records a harness seat's real token use (a Claude subagent has\n` +
      `no result.json): give its transcript, A=<path to agent-<id>.jsonl>, or just its\n` +
      `agent id, A=a6674ae8f7845facb, which is looked up under ~/.claude/projects (or\n` +
      `CLAUDE_CONFIG_DIR). Every API call's usage is summed once, the same way a Codex\n` +
      `result.json counts, into seat_usage.A = {source: "transcript", calls,\n` +
      `input_tokens, cache_creation_input_tokens, cache_read_input_tokens,\n` +
      `total_input_tokens, max_context_tokens, models, duration_ms}; models counts the\n` +
      `calls per resolved model id, the evidence of which model the seat really ran;\n` +
      `output_tokens is null, since\n` +
      `a transcript logs it before each reply is written. Repeat it for\n` +
      `a seat that ran as several subagents. orchestrator=<session .jsonl> records the\n` +
      `orchestrator's own session, the one that ran this review, usually its largest cost.\n` +
      `Append @<ISO start>[/<ISO end>] (orchestrator=<session .jsonl>@2026-09-30T14:05:00Z/\n` +
      `2026-09-30T15:00:00Z) to count only entries in that window, for one review in a session\n` +
      `that ran several; without an end it runs to the end of the transcript.\n` +
      `active_ms is the seat's working time: every\n` +
      `gap between transcript entries except the wait after a final reply. It becomes\n` +
      `duration_ms (duration_source "transcript") unless --seat-usage gives the same seat\n` +
      `a ",clock" span; an estimated or harness figure is kept as duration_hand_ms.\n\n` +
      `--seat-usage records numbers you have by hand, e.g. --seat-usage A=250000,1656000,\n` +
      `as seat_usage.A = {final_context_tokens, duration_ms, source: "harness"}. The\n` +
      `harness's totalTokens is the size of the seat's LAST call, not what it used, so\n` +
      `it is stored as final_context_tokens; use --seat-transcript for consumption.\n` +
      `Write "unknown" for a number you\n` +
      `do not have (it is stored as null; both unknown gives source "unknown"), and append\n` +
      `",clock" (source "clock") for spans you timed yourself, as the protocol asks for a\n` +
      `Claude seat, or ",estimated" (source "estimated") for your own guess. When --in already\n` +
      `has seat_usage (a rebuilt manifest), a role it lacks is added and a role it has is refused.\n\n` +
      `Reads an orchestrator-authored manifest skeleton (topology, mode, reviewers,\n` +
      `exchange, falsification -- see review-protocol.md's Manifest and final output\n` +
      `section) from --in, adds a run_id and a sha256 "hashes" object computed from\n` +
      `the given artifact files, and writes the result to --out. Never invents or\n` +
      `overwrites any field the input manifest already set other than "run_id" and\n` +
      `"hashes" -- refuses if either key already exists in the input, to avoid\n` +
      `silently replacing a value someone else already computed.\n\n` +
      `--extra-artifact <name>=<path> (repeatable) hashes a file the protocol does not\n` +
      `name, such as an auditor's prose synthesis, into hashes.extra_artifacts.<name>.\n` +
      `Record why it exists in the body; the hash only proves which bytes it was.\n\n` +
      `Any of --task-packet/--phase1/--phase2/--verification/--findings may be\n` +
      `omitted; the corresponding hash is then omitted from the output rather than\n` +
      `fabricated as null, since "this artifact was not supplied" and "this artifact\n` +
      `hashed to a known value" are different facts.\n` +
      `--phase1/--phase2/--verification may repeat (one per seat/claim); each is\n` +
      `hashed individually and reported keyed by its own filename, since a single\n` +
      `combined hash across multiple files would not let a reader verify one file\n` +
      `in isolation.\n`
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    in: null, out: null, taskPacket: null,
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
      const m = /^(A|B)=(.+)$/.exec(v);
      if (!m) throw new RelayError(`--reviewer-result "${v}" must look like B=<path to result.json>`);
      (args.reviewerResults[m[1]] ??= []).push(m[2]);
    }
    else if (a === '-h' || a === '--help') printUsageAndExit(0);
    else throw new RelayError(`unrecognized argument: ${a}`);
  }
  if (!args.in || !args.out) throw new RelayError('--in and --out are both required');
  return args;
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
  if (args.phase1.length > 0) hashes.phase1 = await hashFileList(args.phase1, '--phase1');
  if (args.phase2.length > 0) hashes.phase2 = await hashFileList(args.phase2, '--phase2');
  if (args.verification.length > 0) hashes.verifications = await hashFileList(args.verification, '--verification');
  if (args.findings) hashes.findings_json = await hashFile(args.findings, '--findings');
  for (const [name, file] of args.extraArtifacts ?? []) {
    (hashes.extra_artifacts ??= {})[name] = await hashFile(file, `--extra-artifact ${name}`);
  }
  return hashes;
}

// result.json key -> manifest reviewers[] key.
const REVIEWER_FIELDS = [
  ['modelRequested', 'model_requested'], ['modelResolved', 'model_resolved'],
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

const IDENTITY_FIELDS = ['modelRequested', 'modelResolved', 'effortRequested', 'effortResolved', 'isolated', 'worktreePath'];

// One Codex thread reports cumulative usage, so its last call already holds the total. Anything
// else (several threads, OpenCode's per-call counts) is summed field by field from each call's own usage.
function mergedUsage(results) {
  const last = results[results.length - 1].usage;
  if (results.length === 1) return last;
  const threads = new Set(results.map((r) => r.threadId ?? null));
  if (threads.size === 1 && !threads.has(null)) return last;
  const sum = { source: 'summed-per-call' };
  for (const r of results) {
    const u = r.usage_delta ?? r.usage;
    // A call without its own numbers makes any sum wrong; say so instead of counting it as zero.
    const numeric = u && typeof u === 'object' && u.source !== 'unavailable' && Object.values(u).some((v) => typeof v === 'number');
    if (!numeric) return { source: 'unavailable', note: 'a call has no usable usage numbers; see usage_per_call' };
    for (const [k, v] of Object.entries(u)) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
  }
  return sum;
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
  // Only the orchestrator knows whether falsification ran, so a missing value is reported, never guessed.
  for (const field of ['requested', 'verifiers_run']) {
    if (out[field] === undefined || out[field] === null) {
      warnings.push(`falsification.${field} is not set in the body; write it (for example requested: false, verifiers_run: 0 when falsification was not asked for)`);
    }
  }
  return out;
}

async function fillReviewers(manifest, reviewerResults, warnings = []) {
  const reviewers = Array.isArray(manifest.reviewers) ? manifest.reviewers.map((r) => ({ ...r })) : [];
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
      results.push(result);
    }
    // Every call of one seat must be the same model, effort and isolation; a mis-dispatched call
    // must not disappear into a merged entry.
    for (const key of IDENTITY_FIELDS) {
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
    if (results.every((r) => typeof r.durationMs === 'number')) merged.durationMs = results.reduce((s, r) => s + r.durationMs, 0);
    for (const [from, to] of REVIEWER_FIELDS) {
      if (!Object.hasOwn(merged, from)) continue;
      if (isUnset(entry, to)) {
        entry[to] = merged[from];
      } else if (to !== 'usage' && to !== 'duration_ms' && JSON.stringify(entry[to]) !== JSON.stringify(merged[from])) {
        warnings.push(`reviewers[${role}].${to} is ${JSON.stringify(entry[to])} in the body but ${JSON.stringify(merged[from])} in ${files[0]}; kept the body's value`);
      }
    }
    if (results.length > 1 && isUnset(entry, 'usage_per_call')) {
      entry.usage_per_call = results.map((r) => r.usage_delta ?? r.usage ?? null);
    }
    // Agents a Codex seat spawned bill the same account but are not in "usage".
    const children = results.flatMap((r) => (Array.isArray(r.childThreads) ? r.childThreads : []));
    if (children.length > 0 && isUnset(entry, 'child_threads')) {
      entry.child_threads = children;
      warnings.push(`reviewers[${role}]: the seat spawned ${children.length} agent thread(s) whose tokens are not in usage; see child_threads`);
    }
  }
  return reviewers;
}

// An agent id (the Agent tool's agentId) is looked up as <config>/projects/*/*/subagents/agent-<id>.jsonl.
async function resolveTranscript(role, value) {
  if (!/^a[0-9a-f]{8,}$/.test(value)) return value;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
  const found = [];
  for (const proj of await readdir(projects).catch(() => [])) {
    for (const session of await readdir(path.join(projects, proj)).catch(() => [])) {
      const f = path.join(projects, proj, session, 'subagents', `agent-${value}.jsonl`);
      if (await stat(f).then((s) => s.isFile(), () => false)) found.push(f);
    }
  }
  if (found.length !== 1) {
    throw new RelayError(`--seat-transcript ${role}: agent id "${value}" matched ${found.length} transcripts under ${projects}; pass the .jsonl path instead`);
  }
  return found[0];
}

// Sums every API call's own usage, each message id once (one reply is written as several lines).
// This is the same quantity a Codex result.json reports: input re-sent on every call counts every time.
async function transcriptUsage(role, files) {
  const calls = new Map();
  const used = [];
  let skipped = 0;
  let activeMs = 0;
  let timed = false;
  let since = null;
  let until = null;
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
    if (at) since = at[1];
    if (at?.[2]) until = at[2];
    const file = await resolveTranscript(role, value);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new RelayError(`--seat-transcript ${role}: failed to read "${file}": ${err.message}`);
    }
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
      if (e?.type === 'assistant' && m?.id && m.usage && typeof m.usage === 'object') calls.set(`${file}\0${m.id}`, { usage: m.usage, model: typeof m.model === 'string' ? m.model : null });
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
    used.push(path.basename(file));
  }
  if (calls.size === 0) throw new RelayError(`--seat-transcript ${role}: no API usage found in ${used.join(', ')}; is it a subagent transcript?`);
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
  out.active_ms = timed ? activeMs : null;
  if (since !== null) out.counted_from = since;
  if (until !== null) out.counted_until = until;
  if (skipped > 0) out.unparsed_lines = skipped;
  return out;
}

// skill_versions from <run-dir>/skill-versions.jsonl, which build-brief appends to for every brief:
// {phase1: "1.8.13", phase2: "1.8.14", ...}, a list when one phase used several, and the skill name
// in front when the run moved between skills. Null when the file is absent.
// Completed dispatcher result.json files under the run dir (a dispatcher writes one next to each
// brief) that no --reviewer-result names. Only a folder with phase1/ is treated as a run dir.
async function unlistedResults(runDir, reviewerResults) {
  const passed = new Set(Object.values(reviewerResults).flat().map((f) => path.resolve(f).toLowerCase()));
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
      else if (e.isFile() && e.name === 'result.json' && !passed.has(path.resolve(p).toLowerCase())) {
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

async function run(args) {
  let manifest;
  try {
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
  for (const [role, files] of Object.entries(args.seatTranscripts ?? {})) {
    const fromTranscript = await transcriptUsage(role, files);
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
  const warnings = [];
  if (Object.keys(reviewerResults).length > 0) manifest.reviewers = await fillReviewers(manifest, reviewerResults, warnings);
  if (args.falsification) manifest.falsification = await fillFalsification(manifest.falsification, args.falsification, warnings);
  const recorded = await recordedSkillVersions(path.dirname(path.resolve(args.out)));
  if (recorded) {
    if (!Object.hasOwn(manifest, 'skill_versions')) manifest.skill_versions = recorded;
    else if (JSON.stringify(manifest.skill_versions) !== JSON.stringify(recorded)) {
      warnings.push(`the body's skill_versions ${JSON.stringify(manifest.skill_versions)} differs from what build-brief recorded, ${JSON.stringify(recorded)}; the body is kept`);
    }
    const distinct = [...new Set(Object.values(recorded).flat())];
    if (distinct.length > 1) warnings.push(`the skill version changed during the run: ${distinct.join(', ')}`);
  }
  for (const file of await unlistedResults(path.dirname(path.resolve(args.out)), reviewerResults)) {
    warnings.push(`${file} is a completed seat call that was not passed to --reviewer-result; its tokens and duration are not in this manifest`);
  }
  for (const w of warnings) process.stderr.write(`build-manifest: WARNING: ${w}\n`);

  const hashes = await buildHashes(args);
  const stamped = { ...manifest, run_id: randomUUID(), hashes };
  if (Object.keys(seatUsage).length > 0) stamped.seat_usage = { ...(bodyUsage ?? {}), ...seatUsage };
  if (!Object.hasOwn(stamped, 'skill_version')) {
    const version = await ownSkillVersion();
    if (version) stamped.skill_version = version;
  }

  await writeFile(args.out, JSON.stringify(stamped, null, 2) + '\n', 'utf8');
  // Not part of the manifest JSON; lets a caller (and the tests) see what was reported.
  Object.defineProperty(stamped, 'warnings', { value: warnings, enumerable: false });
  return stamped;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      // The error goes last and alone: the full help would scroll it off the screen.
      process.stderr.write(`Run with --help for every option.\nbuild-manifest.mjs: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  try {
    const stamped = await run(args);
    process.stdout.write(`build-manifest: wrote ${args.out} (run_id ${stamped.run_id})\n`);
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`build-manifest.mjs: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`build-manifest.mjs: unexpected failure: ${err.stack || err}\n`);
    process.exit(1);
  });
}

export { parseArgs, buildHashes, run, sha256, hashFile, RelayError };
