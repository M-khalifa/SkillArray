// Replays a stored run folder through the review pipeline (validate, exchange, audit-prep, translate, scorecard,
// manifest, report) and returns every step's result and output, normalized. The one place that knows how the
// pipeline steps are called, so a restructure changes this file and keeps the fixtures.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStep as relabelStep } from '../blind-relabel.mjs';
import { runStep as exchangeStep } from '../exchange.mjs';
import { runStep as manifestStep } from '../build-manifest.mjs';
import { runStep as reportStep } from '../build-report.mjs';

const SCRIPTS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_DIR = path.dirname(SCRIPTS);

// The only differences a replay may show from a stored result: the replay folder's own location, run_id,
// orchestrator usage, worktree paths, start/end times and durations, and a brief's byte count (it holds the replay path).
export const NORMALIZED = ['replay folder path', 'run_id', 'orchestrator usage', 'worktree paths', 'start/end times', 'durations', 'brief byte counts', 'skill name and version line', 'manifest skill_version'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function spellingsOf(p) {
  const fwd = p.replace(/\\/g, '/');
  const gb = /^[A-Za-z]:\//.test(fwd) ? `/${fwd[0].toLowerCase()}${fwd.slice(2)}` : fwd;
  return { native: p, json: JSON.stringify(p).slice(1, -1), fwd, gb };
}

function fill(text, tokens) {
  let out = text;
  for (const [name, p] of Object.entries(tokens)) {
    const s = spellingsOf(p);
    out = out.replaceAll(`@@${name}_JSON@@`, s.json).replaceAll(`@@${name}_FWD@@`, s.fwd).replaceAll(`@@${name}_GB@@`, s.gb).replaceAll(`@@${name}@@`, s.native);
  }
  return out;
}

function copyFilled(from, to, tokens) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyFilled(src, dst, tokens);
    else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fill(fs.readFileSync(src, 'utf8'), tokens));
    }
  }
}

function normalizer(tmp) {
  const real = fs.realpathSync.native(tmp);
  const roots = [...new Set([tmp, real])].flatMap((p) => Object.values(spellingsOf(p)));
  const rootRe = new RegExp([...new Set(roots)].sort((a, b) => b.length - a.length).map(esc).join('|'), 'gi');
  return (text) => String(text ?? '')
    .replace(rootRe, '<REPLAY>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<UUID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIME>')
    // The line each output ends with names the skill (pair-review or cross-review) and its version.
    .replace(/^(_?)Reviewed with \S+ \S+ \(SkillArray, MIT license\): \S+?(_?)$/gm, '$1<GENERATOR>$2');
}

// A step's own "build-brief: wrote <path> (N bytes)" line: the count holds the replay path's length. Step output only,
// never a stored file (a seat may quote such a line as evidence).
function maskBriefBytes(text) {
  return text.replace(/^(build-brief: wrote .*)\(\d+ bytes\)/gm, '$1(<N> bytes)');
}

// The keys of manifest.json a replay cannot reproduce: run_id, the orchestrator's usage, worktree paths and the replaying
// skill's own version. A file hash is replaced by "matches <file>" when it is the hash of that file in the replay (the
// files hold the replay path).
function normalizeManifest(text, run) {
  const data = JSON.parse(text);
  const fileHash = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
  const check = (value, rel) => (value === fileHash(path.join(run, rel)) ? `matches ${rel.replace(/\\/g, '/')}` : value);
  const h = data.hashes ?? {};
  if (h.task_packet) h.task_packet = check(h.task_packet, 'task-packet.md');
  if (h.review_rules) h.review_rules = check(h.review_rules, 'review-rules.md');
  if (h.findings_json) h.findings_json = check(h.findings_json, path.join('phase3', 'findings.json'));
  for (const [key, dir] of [['phase1', path.join('phase1', 'original')], ['phase2', 'phase2'], ['verifications', 'phase3']]) {
    for (const name of Object.keys(h[key] ?? {})) h[key][name] = check(h[key][name], path.join(dir, name));
  }
  delete data.run_id;
  if ('skill_version' in data) data.skill_version = '<VERSION>';
  if (data.seat_usage) delete data.seat_usage.orchestrator;
  for (const list of [data.reviewers, data.actors]) for (const r of Array.isArray(list) ? list : []) if (r && 'worktreePath' in r) r.worktreePath = '<WORKTREE>';
  return `${JSON.stringify(data, null, 2)}\n`;
}

// The report's run time ends at findings.json's file time, which a replay writes now: its "wall" duration line is masked.
const normalizeReport = (text) => text.split('\n').map((line) => (/\bwall\b/.test(line) ? line.replace(/\b\d[\dhms. ]*(?:min|s|h|m)\b/g, '<DUR>') : line)).join('\n');

const STEPS = {
  'blind-relabel.mjs': relabelStep, 'exchange.mjs': exchangeStep, 'build-manifest.mjs': manifestStep, 'build-report.mjs': reportStep,
};

// One step in-process with the replay's environment set for the call.
async function callStep(script, argv, env) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await STEPS[script](argv);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// Seats' rebuttals and the auditor's file wait outside the run folder until their step, as in a live run.
const HELD = ['phase2/A-rebuttals-raw.md', 'phase2/B-rebuttals-raw.md', 'phase3/findings.audit.json'];

// corrected: replay with the seat files in <fixture>/corrected/ in place of the stored ones the seat-file reader refuses.
export async function replayRun(fixtureDir, { corrected = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const run = path.join(tmp, 'run');
  const target = path.join(tmp, 'target');
  const held = path.join(tmp, 'held');
  // A stand-in target: the reviewed repository's file names (empty files) and the vendor words its docs use, which is what
  // the identity scan takes as target-derived.
  const stub = path.join(path.dirname(fixtureDir), 'target');
  for (const rel of fs.readFileSync(path.join(stub, 'files.txt'), 'utf8').split(/\r?\n/).filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), '');
  }
  fs.mkdirSync(path.join(target, 'references'), { recursive: true });
  fs.copyFileSync(path.join(stub, 'vocabulary.md'), path.join(target, 'references', 'vocabulary.md'));
  for (const d of ['claude-config', 'codex-home']) fs.mkdirSync(path.join(tmp, d));
  copyFilled(path.join(fixtureDir, 'input'), tmp, { RUN: run, TARGET: target });
  const descFile = path.join(run, 'run.json');
  const desc = JSON.parse(fs.readFileSync(descFile, 'utf8'));
  desc.skillDir = SKILL_DIR;
  fs.writeFileSync(descFile, `${JSON.stringify(desc, null, 2)}\n`);
  for (const seat of ['A', 'B']) fs.copyFileSync(path.join(run, 'phase1', 'original', `${seat}-findings.md`), path.join(run, 'phase1', `${seat}-findings.md`));
  if (corrected) copyFilled(path.join(fixtureDir, 'corrected'), path.join(run, 'phase1'), { RUN: run, TARGET: target });
  fs.rmSync(path.join(run, 'phase1', 'original'), { recursive: true });
  for (const rel of HELD) {
    if (!fs.existsSync(path.join(run, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(held, rel)), { recursive: true });
    fs.renameSync(path.join(run, rel), path.join(held, rel));
  }
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'), CODEX_HOME: path.join(tmp, 'codex-home'), NO_COLOR: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.FORCE_COLOR;
  const norm = normalizer(tmp);
  const steps = [];
  const p1 = path.join(run, 'phase1');
  const p2 = path.join(run, 'phase2');
  const p3 = path.join(run, 'phase3');
  const ai = path.resolve(desc.auditor.outputDir);
  const tokens = `${desc.seatA.model},${desc.seatB.model}`;
  const noExchange = desc.skill === 'pair-review' && desc.flags.mode === 'none';
  const step = async (name, script, argv) => {
    const r = await callStep(script, argv, env);
    steps.push({ name, code: r.code, stdout: maskBriefBytes(norm(r.stdout)), stderr: maskBriefBytes(norm(r.stderr)) });
    return r.code === 0;
  };
  const restore = (rel) => {
    const from = path.join(held, rel);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(run, rel));
  };
  const pipeline = async () => {
    if (!await step('validate', 'blind-relabel.mjs', ['validate', '--phase1-dir', p1, '--target-dir', target, '--packet', path.join(run, 'task-packet.md')])) return;
    if (!noExchange) {
      if (!await step('exchange prepare', 'exchange.mjs', ['prepare', '--run-dir', run, '--target-dir', target, '--tokens', tokens])) return;
      restore('phase2/A-rebuttals-raw.md');
      restore('phase2/B-rebuttals-raw.md');
      if (!await step('exchange finish', 'exchange.mjs', ['finish', '--run-dir', run, '--target-dir', target])) return;
    }
    fs.mkdirSync(ai, { recursive: true });
    if (!await step('audit-prep', 'blind-relabel.mjs', ['audit-prep', '--phase1-dir', p1, '--mapping', path.join(run, 'phase3-private', 'seat-to-audit-label.json'), '--out-dir', ai,
      '--target-dir', target, '--tokens', tokens, ...(noExchange ? [] : ['--phase2-dir', p2]), '--packet', path.join(run, 'task-packet.md'),
      '--breakdown-out', path.join(p3, 'falsification-breakdown.json')])) return;
    restore('phase3/findings.audit.json');
    if (!await step('translate', 'blind-relabel.mjs', ['translate', '--in', path.join(p3, 'findings.audit.json'), '--out', path.join(p3, 'findings.json'),
      '--mapping', path.join(run, 'phase3-private', 'seat-to-audit-label.json'), '--phase1-dir', p1, '--audit-depth', desc.flags.auditDepth])) return;
    if (!await step('scorecard', 'blind-relabel.mjs', ['scorecard', '--in', path.join(p3, 'findings.json'), '--out', path.join(p3, 'scorecard.md'), '--phase1-dir', p1])) return;
    // The delta briefs the replay rebuilt appended to skill-versions.jsonl; the manifest reads the stored run's record.
    const versions = path.join(fixtureDir, 'input', 'run', 'skill-versions.jsonl');
    if (fs.existsSync(versions)) fs.writeFileSync(path.join(run, 'skill-versions.jsonl'), fs.readFileSync(versions, 'utf8'));
    else fs.rmSync(path.join(run, 'skill-versions.jsonl'), { force: true });
    if (!await step('manifest', 'build-manifest.mjs', ['--run-dir', run])) return;
    await step('report chat', 'build-report.mjs', ['--run-dir', run, '--format', 'chat']);
    await step('report chat all', 'build-report.mjs', ['--run-dir', run, '--format', 'chat', '--all', '--out', path.join(tmp, 'report.md'), '--json', path.join(tmp, 'report.json')]);
  };
  try {
    await pipeline();
    const outputs = {};
    const keep = (name, file, transform = (t) => t) => {
      if (fs.existsSync(file)) outputs[name] = transform(norm(fs.readFileSync(file, 'utf8')));
    };
    for (const seat of ['A', 'B']) {
      keep(`phase1/${seat}-findings.md`, path.join(p1, `${seat}-findings.md`));
      keep(`phase2/peer-view-for-${seat}.md`, path.join(p2, `peer-view-for-${seat}.md`));
    }
    keep('phase2/exchange-result.json', path.join(p2, 'exchange-result.json'));
    for (const f of fs.existsSync(ai) ? fs.readdirSync(ai).sort() : []) if (/^[XY]-findings\.md$/.test(f)) keep(`audit-input/${f}`, path.join(ai, f));
    keep('phase3/falsification-breakdown.json', path.join(p3, 'falsification-breakdown.json'));
    keep('phase3/findings.json', path.join(p3, 'findings.json'));
    keep('phase3/scorecard.md', path.join(p3, 'scorecard.md'));
    keep('manifest.json', path.join(run, 'manifest.json'), (text) => normalizeManifest(text, run));
    keep('report.md', path.join(tmp, 'report.md'), normalizeReport);
    for (const s of steps) if (s.name.startsWith('report')) s.stdout = normalizeReport(s.stdout);
    return { steps, outputs };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A platform-neutral summary of a replay: each step's exit code and its WARNING lines' count, the manifest status and the report's status line.
export function summaryOf({ steps, outputs }) {
  const manifest = outputs['manifest.json'] ? JSON.parse(outputs['manifest.json']) : null;
  const findings = outputs['phase3/findings.json'] ? JSON.parse(outputs['phase3/findings.json']).findings ?? [] : [];
  const states = {};
  for (const f of findings) states[f.final_state] = (states[f.final_state] ?? 0) + 1;
  return {
    steps: steps.map((s) => `${s.name}: exit ${s.code}, ${`${s.stdout}\n${s.stderr}`.split('\n').filter((l) => l.includes('WARNING')).length} warning(s)`),
    status: manifest?.status ?? null,
    missing_seat_files: manifest?.missing_seat_files ?? null,
    findings: findings.length,
    states,
    report_status: /\b(COMPLETE|INCOMPLETE|NOT FINAL)\b/.exec(steps.find((s) => s.name === 'report chat')?.stdout ?? '')?.[1] ?? null,
  };
}
