import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';

// No test reads this machine's real Codex or Claude sessions: both homes point at an empty temp folder.
const ISOLATED_HOME = mkdtempSync(path.join(os.tmpdir(), 'build-manifest-homes-'));
process.env.CODEX_HOME = path.join(ISOLATED_HOME, 'codex');
process.env.CLAUDE_CONFIG_DIR = path.join(ISOLATED_HOME, 'claude');
process.on('exit', () => rmSync(ISOLATED_HOME, { recursive: true, force: true }));
import { parseArgs, buildHashes, run, sha256, initBody, RelayError } from '../build-manifest.mjs';

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-manifest-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseArgs: --in and --out are both required', () => {
  assert.throws(() => parseArgs(['--in', 'x.json']), RelayError);
  assert.throws(() => parseArgs(['--out', 'y.json']), RelayError);
  const ok = parseArgs(['--in', 'x.json', '--out', 'y.json']);
  assert.equal(ok.in, 'x.json');
  assert.equal(ok.out, 'y.json');
});

test('parseArgs: --phase1/--phase2/--verification accumulate as arrays across repeats', () => {
  const args = parseArgs([
    '--in', 'a', '--out', 'b',
    '--phase1', 'p1-A.md', '--phase1', 'p1-B.md',
    '--phase2', 'p2-A.md',
    '--verification', 'v-X1.md', '--verification', 'v-Y3.md',
  ]);
  assert.deepEqual(args.phase1, ['p1-A.md', 'p1-B.md']);
  assert.deepEqual(args.phase2, ['p2-A.md']);
  assert.deepEqual(args.verification, ['v-X1.md', 'v-Y3.md']);
});

test('parseArgs: a flag with no value (end of argv or next token looks like a flag) throws, never silently consumes the next flag as its value', () => {
  assert.throws(() => parseArgs(['--in']), /requires a value/);
  assert.throws(() => parseArgs(['--in', '--out', 'y']), /requires a value/);
});

test('sha256: deterministic and matches an independent Node crypto computation', () => {
  const buf = Buffer.from('hello world');
  const expected = createHash('sha256').update(buf).digest('hex');
  assert.equal(sha256(buf), expected);
});

test('buildHashes: computes task_packet, phase1 (keyed by basename), phase2, verifications, and findings_json hashes', async (t) => {
  const dir = await tmpDir(t);
  const taskPacket = path.join(dir, 'task.md');
  const phase1A = path.join(dir, 'A-findings.md');
  const findings = path.join(dir, 'findings.json');
  await fs.writeFile(taskPacket, 'task content');
  await fs.writeFile(phase1A, 'phase1 content');
  await fs.writeFile(findings, '{"findings":[]}');

  const hashes = await buildHashes({
    taskPacket, phase1: [phase1A], phase2: [], verification: [], findings,
  });

  assert.equal(hashes.task_packet, sha256(Buffer.from('task content')));
  assert.deepEqual(hashes.phase1, { 'A-findings.md': sha256(Buffer.from('phase1 content')) });
  assert.equal(hashes.findings_json, sha256(Buffer.from('{"findings":[]}')));
  assert.ok(!('phase2' in hashes), 'an empty --phase2 list must be omitted, not an empty object');
  assert.ok(!('verifications' in hashes), 'an empty --verification list must be omitted, not an empty object');
});

test('buildHashes: two --phase1 files with the same basename are refused, never silently collapsed to one hash keyed by that name', async (t) => {
  const dir = await tmpDir(t);
  await fs.mkdir(path.join(dir, 'original'));
  const appended = path.join(dir, 'A-findings.md');
  const original = path.join(dir, 'original', 'A-findings.md');
  await fs.writeFile(appended, 'phase1 plus rebuttals');
  await fs.writeFile(original, 'phase1 only');
  await assert.rejects(
    buildHashes({ taskPacket: null, phase1: [appended, original], phase2: [], verification: [], findings: null }),
    (err) => err instanceof RelayError && /--phase1 was given two files named "A-findings\.md"/.test(err.message)
  );
});

test('buildHashes: an artifact category with zero paths is omitted entirely, not present as null or {}', async () => {
  const hashes = await buildHashes({ taskPacket: null, phase1: [], phase2: [], verification: [], findings: null });
  assert.deepEqual(hashes, {});
});

test('buildHashes: a missing artifact file is a RelayError naming its flag and path, never a raw ENOENT stack trace', async (t) => {
  const dir = await tmpDir(t);
  const missing = path.join(dir, 'A-rebuttals-raw.md');
  const empty = { taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  for (const [args, flag] of [
    [{ ...empty, phase2: [missing] }, '--phase2'],
    [{ ...empty, phase1: [missing] }, '--phase1'],
    [{ ...empty, verification: [missing] }, '--verification'],
    [{ ...empty, taskPacket: missing }, '--task-packet'],
    [{ ...empty, findings: missing }, '--findings'],
  ]) {
    await assert.rejects(
      buildHashes(args),
      (err) => err instanceof RelayError && err.message.startsWith(`${flag} "${missing}" cannot be read (ENOENT)`)
    );
  }
});

test('run: adds run_id (a real UUID) and hashes to the manifest, preserving every existing field untouched', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'manifest.in.json');
  const outPath = path.join(dir, 'manifest.out.json');
  const taskPacket = path.join(dir, 'task.md');
  await fs.writeFile(taskPacket, 'content');
  const skeleton = {
    protocol: 'review-protocol-v1.3',
    topology: 'cross-vendor',
    mode: 'adversarial',
    status: 'completed',
    reviewers: [{ role: 'A', provider: 'anthropic' }],
  };
  await fs.writeFile(inPath, JSON.stringify(skeleton));

  const result = await run({ in: inPath, out: outPath, taskPacket, phase1: [], phase2: [], verification: [], findings: null });

  assert.equal(result.protocol, skeleton.protocol);
  assert.equal(result.topology, skeleton.topology);
  assert.deepEqual(result.reviewers, skeleton.reviewers);
  assert.match(result.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(result.hashes, { task_packet: sha256(Buffer.from('content')) });

  const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.deepEqual(written, result);
});

test('run: refuses (fail-closed) if the input manifest already has a run_id, never silently overwrites it', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'out.json');
  await fs.writeFile(inPath, JSON.stringify({ run_id: 'already-set' }));
  await assert.rejects(
    () => run({ in: inPath, out: outPath, taskPacket: null, phase1: [], phase2: [], verification: [], findings: null }),
    /already has a "run_id" field/
  );
});

test('run: refuses (fail-closed) if the input manifest already has a hashes field, never silently overwrites it', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'out.json');
  await fs.writeFile(inPath, JSON.stringify({ hashes: { foo: 'bar' } }));
  await assert.rejects(
    () => run({ in: inPath, out: outPath, taskPacket: null, phase1: [], phase2: [], verification: [], findings: null }),
    /already has a "hashes" field/
  );
});

test('run: throws a descriptive error on invalid/missing --in JSON, rather than an unhandled parse exception', async (t) => {
  const dir = await tmpDir(t);
  const outPath = path.join(dir, 'out.json');
  await assert.rejects(
    () => run({ in: path.join(dir, 'does-not-exist.json'), out: outPath, taskPacket: null, phase1: [], phase2: [], verification: [], findings: null }),
    /failed to read\/parse/
  );
});

test('run: accepts a manifest skeleton that starts with a UTF-8 BOM (PowerShell Set-Content -Encoding utf8)', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'manifest.json');
  await fs.writeFile(inPath, '\uFEFF' + JSON.stringify({ protocol: 'review-protocol-v1.3' }), 'utf8');
  const result = await run({ in: inPath, out: path.join(dir, 'out.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null });
  assert.equal(result.protocol, 'review-protocol-v1.3');
});

test('--falsification: fills breakdown and qualified_claims from audit-prep\'s file, keeps a body value with a WARNING, and refuses a file without the counts', async (t) => {
  assert.equal(parseArgs(['--in', 'i', '--out', 'o', '--falsification', 'f.json']).falsification, 'f.json');
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  const file = path.join(dir, 'breakdown.json');
  await fs.writeFile(file, '\uFEFF' + JSON.stringify({ falsificationBreakdown: { high_or_critical: 21, disputed: 1, conceded: 20, unaddressed: 0 } }) + '\n');
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null, falsification: file };
  await fs.writeFile(inPath, JSON.stringify({ falsification: { requested: false, verifiers_run: 0 } }));
  const filled = await run(base);
  assert.deepEqual(filled.falsification, {
    requested: false, verifiers_run: 0, breakdown: { high_or_critical: 21, disputed: 1, conceded: 20, unaddressed: 0 }, qualified_claims: 1,
  });
  assert.deepEqual(filled.warnings, []);
  await fs.writeFile(inPath, JSON.stringify({}));
  const bare = await run(base);
  assert.equal(bare.falsification.qualified_claims, 1);
  assert.match(bare.warnings.join('\n'), /falsification\.requested is not set in the body/);
  assert.match(bare.warnings.join('\n'), /falsification\.verifiers_run is not set in the body/);
  assert.ok(!('requested' in bare.falsification), 'the script never guesses whether falsification ran');
  await fs.writeFile(inPath, JSON.stringify({ falsification: { requested: false, verifiers_run: 0, qualified_claims: 2 } }));
  const kept = await run(base);
  assert.equal(kept.falsification.qualified_claims, 2);
  assert.match(kept.warnings.join('\n'), /falsification\.qualified_claims in the body \(2\) differs from audit-prep's 1/);
  await fs.writeFile(file, JSON.stringify({ falsificationBreakdown: { high_or_critical: 3 } }));
  await assert.rejects(run(base), /has no whole-number "disputed"/);
});

test('--falsification: a requested pass that ran fewer verifiers than claims qualified marks the run incomplete; 0 qualified with 0 run stays completed', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  const file = path.join(dir, 'breakdown.json');
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null, falsification: file };
  await fs.writeFile(file, JSON.stringify({ falsificationBreakdown: { high_or_critical: 3, disputed: 2, conceded: 1, unaddressed: 0 } }));
  await fs.writeFile(inPath, JSON.stringify({ status: 'completed', falsification: { requested: true, verifiers_run: 1 } }));
  const short = await run(base);
  assert.equal(short.status, 'incomplete');
  assert.match(short.warnings.join('\n'), /2 claim\(s\) qualified, but 1 verifier\(s\) ran; status is incomplete/);
  await fs.writeFile(file, JSON.stringify({ falsificationBreakdown: { high_or_critical: 1, disputed: 0, conceded: 1, unaddressed: 0 } }));
  await fs.writeFile(inPath, JSON.stringify({ status: 'completed', falsification: { requested: true, verifiers_run: 0 } }));
  assert.equal((await run(base)).status, 'completed', 'nothing qualified, so nothing is missing');
  // A qualified count typed into the body does not hide the measured one.
  await fs.writeFile(file, JSON.stringify({ falsificationBreakdown: { high_or_critical: 2, disputed: 2, conceded: 0, unaddressed: 0 } }));
  await fs.writeFile(inPath, JSON.stringify({ status: 'completed', falsification: { requested: true, verifiers_run: 0, qualified_claims: 0 } }));
  assert.equal((await run(base)).status, 'incomplete');
});

test('--reviewer-result refuses a "running" result.json (a killed dispatch) and names the resumed call instead', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B' }] }));
  const killed = path.join(dir, 'result.attempt-1.json');
  await fs.writeFile(killed, JSON.stringify({ modelRequested: 'gpt-x', status: 'running', threadId: 't1', durationMs: null }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  await assert.rejects(run({ ...base, reviewerResults: { B: [killed] } }), /has status "running" .*pass the result\.json of the call that resumed that thread/);
});

test('--seat-usage: records a harness seat\'s tokens and duration as seat_usage, rejects a malformed or repeated value, and refuses an input that already has seat_usage', async (t) => {
  const args = parseArgs(['--in', 'i', '--out', 'o', '--seat-usage', 'A=250000,1656000', '--seat-usage', 'auditor=138000,246000']);
  assert.deepEqual(args.seatUsage, {
    A: { final_context_tokens: 250000, duration_ms: 1656000, source: 'harness' },
    auditor: { final_context_tokens: 138000, duration_ms: 246000, source: 'harness' },
  });
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--seat-usage', 'A=250k,27min']), /must look like A=250000,1656000/);
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--seat-usage', 'C=1,2']), /must look like/);
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--seat-usage', 'A=1,2', '--seat-usage', 'A=3,4']), /given twice for A/);
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const stamped = await run({ ...base, seatUsage: args.seatUsage });
  assert.deepEqual(stamped.seat_usage, args.seatUsage);
  assert.ok(!('seat_usage' in (await run({ ...base, seatUsage: {} }))), 'no --seat-usage, no seat_usage key');
  const earlier = { A: { calls: 41, source: 'transcript' } };
  await fs.writeFile(inPath, JSON.stringify({ seat_usage: earlier }));
  await assert.rejects(run({ ...base, seatUsage: args.seatUsage }), /already has a different seat_usage for A; refusing to overwrite it\. Pass only the roles to add/);
  const same = await run({ ...base, seatUsage: { A: earlier.A } });
  assert.deepEqual(same.seat_usage, earlier, 'passing an identical role again is not a conflict');
  const added = await run({ ...base, seatUsage: { verifier: { final_context_tokens: null, duration_ms: 51000, source: 'clock' } } });
  assert.deepEqual(added.seat_usage, { ...earlier, verifier: { final_context_tokens: null, duration_ms: 51000, source: 'clock' } }, 'a rebuilt manifest gains a role it lacks and keeps the rest');
  await fs.writeFile(inPath, JSON.stringify({ seat_usage: [] }));
  await assert.rejects(run({ ...base, seatUsage: args.seatUsage }), /"seat_usage" that is not an object/);
});

test('--seat-usage: "unknown" is stored as null and ",estimated" marks a number nobody measured, so a hand-entered guess never reads as source "harness"', () => {
  const su = (...vals) => parseArgs(['--in', 'i', '--out', 'o', ...vals.flatMap((v) => ['--seat-usage', v])]).seatUsage;
  assert.deepEqual(su('auditor=unknown,unknown').auditor, { final_context_tokens: null, duration_ms: null, source: 'unknown' });
  assert.deepEqual(su('A=261000,unknown').A, { final_context_tokens: 261000, duration_ms: null, source: 'harness' });
  assert.deepEqual(su('auditor=150000,480000,estimated').auditor, { final_context_tokens: 150000, duration_ms: 480000, source: 'estimated' });
  assert.deepEqual(su('B=unknown,480000,estimated').B, { final_context_tokens: null, duration_ms: 480000, source: 'estimated' });
  assert.throws(() => su('A=unknown,unknown,estimated'), /nothing to mark estimated/);
  assert.throws(() => su('A=1,2,guess'), /must look like/);
  assert.throws(() => su('A=unknown'), /must look like/);
  assert.throws(() => su('A=,2'), /must look like/);
});

test('--reviewer-result: fills a reviewers[] entry from a dispatcher result.json without overwriting authored fields, creates a missing entry, and refuses a file that is not a result.json', async (t) => {
  const dir = await tmpDir(t);
  const resultPath = path.join(dir, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify({
    modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: null, effortResolved: null,
    selectionNote: 'Requested flags are recorded', isolated: false, worktreePath: null, isolationNote: null,
    webAccess: true, usage: { source: 'provider', input_tokens: 412000 }, durationMs: 237000, finalMessage: 'long text',
  }));
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'A', provider: 'anthropic' }, { role: 'B', provider: 'openai', model_requested: 'authored' }] }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const out = await run({ ...base, reviewerResults: { B: resultPath } });
  const b = out.reviewers.find((r) => r.role === 'B');
  assert.equal(b.provider, 'openai');
  assert.equal(b.model_requested, 'authored', 'an authored field is never replaced');
  assert.equal(b.webAccess, true);
  assert.equal(b.duration_ms, 237000);
  assert.deepEqual(b.usage, { source: 'provider', input_tokens: 412000 });
  assert.ok(!('finalMessage' in b), 'only the mapped fields are copied');
  assert.deepEqual(out.reviewers.find((r) => r.role === 'A'), { role: 'A', provider: 'anthropic' });
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'x' }));
  assert.equal((await run({ ...base, reviewerResults: { B: resultPath } })).reviewers[0].model_requested, 'gpt-6-sol');
  await fs.writeFile(path.join(dir, 'bad.json'), '{"findings":[]}');
  await assert.rejects(run({ ...base, reviewerResults: { B: path.join(dir, 'bad.json') } }), /is not a dispatcher result\.json/);
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--reviewer-result', 'X=r.json']), /must look like B=/);
});

test('--reviewer-result: null and the protocol example placeholders count as unset, and repeated files for one role sum duration and keep each call\'s usage', async (t) => {
  const dir = await tmpDir(t);
  const p1 = path.join(dir, 'p1.json');
  const p2 = path.join(dir, 'p2.json');
  await fs.writeFile(p1, JSON.stringify({ modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: null, isolated: true,
    worktreePath: 'C:/wt', selectionNote: 'flags recorded', usage: { input_tokens: 100 }, usage_delta: { input_tokens: 100 }, durationMs: 1000 }));
  await fs.writeFile(p2, JSON.stringify({ modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: null, isolated: true,
    worktreePath: 'C:/wt', usage: { input_tokens: 150 }, usage_delta: { input_tokens: 50 }, durationMs: 300 }));
  const inPath = path.join(dir, 'm.json');
  // The documented example body (review-protocol.md, Manifest and final output).
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', provider: 'openai', model_requested: 'USER_SELECTED_OPENAI_MODEL',
    model_resolved: null, effort_requested: 'default', verification_note: 'No runtime identity metadata available',
    isolated: true, worktreePath: '/abs/path/to/worktree' }] }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const parsed = parseArgs(['--in', 'i', '--out', 'o', '--reviewer-result', `B=${p1}`, '--reviewer-result', `B=${p2}`]);
  assert.deepEqual(parsed.reviewerResults, { B: [p1, p2] });
  const b = (await run({ ...base, reviewerResults: parsed.reviewerResults })).reviewers[0];
  assert.equal(b.model_requested, 'gpt-6-sol');
  assert.equal(b.verification_note, 'flags recorded');
  assert.equal(b.worktreePath, 'C:/wt');
  assert.equal(b.effort_requested, 'default', 'a real authored value is kept');
  assert.equal(b.duration_ms, 1300);
  assert.deepEqual(b.usage, { source: 'summed-per-call', input_tokens: 150 }, 'no shared thread: per-call usage is summed');
  assert.deepEqual(b.usage_per_call, [{ input_tokens: 100 }, { input_tokens: 50 }]);
});

test('--reviewer-result: files of one Codex thread take the last (cumulative) usage, files that disagree on model or effort are refused, and a body value that differs from result.json is kept with a WARNING', async (t) => {
  const dir = await tmpDir(t);
  const write = async (name, obj) => { const p = path.join(dir, name); await fs.writeFile(p, JSON.stringify(obj)); return p; };
  const common = { modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: 'high', effortResolved: null, isolated: false, threadId: 't1', webAccess: false };
  const p1 = await write('p1.json', { ...common, usage: { input_tokens: 100 }, durationMs: 10 });
  const p2 = await write('p2.json', { ...common, usage: { input_tokens: 180 }, durationMs: 5 });
  const other = await write('other.json', { ...common, effortRequested: 'low', usage: {}, durationMs: 1 });
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', webAccess: true }] }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const out = await run({ ...base, reviewerResults: { B: [p1, p2] } });
  assert.deepEqual(out.reviewers[0].usage, { input_tokens: 180 });
  assert.equal(out.reviewers[0].webAccess, true);
  assert.match(out.warnings.join('\n'), /reviewers\[B\]\.webAccess is true in the body but false in .*p1\.json/);
  await assert.rejects(run({ ...base, reviewerResults: { B: [p1, other] } }), /disagree on effortRequested \("high" vs "low"\)/);
});

test('--reviewer-result: an authored upper-case value is kept with a WARNING (only the exact legacy placeholders count as unset), an unavailable call makes the merged usage unavailable, and different worktrees are refused', async (t) => {
  const dir = await tmpDir(t);
  const write = async (name, obj) => { const p = path.join(dir, name); await fs.writeFile(p, JSON.stringify(obj)); return p; };
  const common = { modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: null, effortResolved: null, isolated: true, worktreePath: 'C:/wt' };
  const p1 = await write('p1.json', { ...common, threadId: 'a', usage: { input_tokens: 10 }, usage_delta: { input_tokens: 10, source: 'fresh-thread' }, durationMs: 1 });
  const p2 = await write('p2.json', { ...common, threadId: 'b', usage: { source: 'unavailable' }, usage_delta: { source: 'unavailable' }, durationMs: 1 });
  const otherWt = await write('p3.json', { ...common, worktreePath: 'C:/other', usage: {}, durationMs: 1 });
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', model_requested: 'MY_PINNED_MODEL', effort_requested: 'USER_SELECTED_OPENAI_MODEL' }] }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const out = await run({ ...base, reviewerResults: { B: [p1, p2] } });
  const b = out.reviewers[0];
  assert.equal(b.model_requested, 'MY_PINNED_MODEL', 'a real upper-case value is kept');
  assert.equal(b.effort_requested, null, 'the exact legacy placeholder counts as unset');
  assert.match(out.warnings.join('\n'), /model_requested is "MY_PINNED_MODEL" in the body but "gpt-6-sol"/);
  assert.equal(b.usage.source, 'unavailable', 'a call without numbers is never counted as zero');
  await assert.rejects(run({ ...base, reviewerResults: { B: [p1, otherWt] } }), /disagree on worktreePath/);
});

test('--reviewer-result: effort "default" in the body equals null in result.json for requested and resolved; any other difference still warns', async (t) => {
  const dir = await tmpDir(t);
  const attempt = async (bodyEffort, resultEffort) => {
    const result = path.join(dir, 'r.json');
    await fs.writeFile(result, JSON.stringify({ modelRequested: 'gpt-6-sol', modelResolved: null, effortRequested: resultEffort, effortResolved: resultEffort, isolated: true, worktreePath: 'C:/wt', usage: {}, durationMs: 1 }));
    const inPath = path.join(dir, 'm.json');
    await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', effort_requested: bodyEffort, effort_resolved: bodyEffort }] }));
    const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
    return (await run({ ...base, reviewerResults: { B: [result] } })).warnings.filter((w) => /effort_/.test(w));
  };
  assert.deepEqual(await attempt('default', null), []);
  assert.equal((await attempt('high', null)).length, 2);
  assert.match((await attempt('high', null))[0], /effort_requested is "high" in the body but null in /);
  assert.equal((await attempt('high', 'low')).length, 2);
});

test('run: stamps skill_version from this skill\'s SKILL.md, and keeps one the body already set', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'x' }));
  const skillMd = await fs.readFile(new URL('../../SKILL.md', import.meta.url), 'utf8');
  assert.equal((await run(base)).skill_version, /^\s+version:\s*(\S+)/m.exec(skillMd)[1]);
  await fs.writeFile(inPath, JSON.stringify({ skill_version: '9.9.9' }));
  assert.equal((await run(base)).skill_version, '9.9.9');
});

test('run: two runs against the same artifacts produce identical hashes but different run_ids', async (t) => {
  const dir = await tmpDir(t);
  const taskPacket = path.join(dir, 'task.md');
  await fs.writeFile(taskPacket, 'stable content');
  const skeleton = { protocol: 'review-protocol-v1.3' };

  const in1 = path.join(dir, 'm1.json');
  const in2 = path.join(dir, 'm2.json');
  await fs.writeFile(in1, JSON.stringify(skeleton));
  await fs.writeFile(in2, JSON.stringify(skeleton));

  const r1 = await run({ in: in1, out: path.join(dir, 'o1.json'), taskPacket, phase1: [], phase2: [], verification: [], findings: null });
  const r2 = await run({ in: in2, out: path.join(dir, 'o2.json'), taskPacket, phase1: [], phase2: [], verification: [], findings: null });

  assert.deepEqual(r1.hashes, r2.hashes);
  assert.notEqual(r1.run_id, r2.run_id);
});

test('CLI end-to-end: node build-manifest.mjs writes a valid stamped manifest to --out', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await tmpDir(t);
  const script = fileURLToPath(new URL('../build-manifest.mjs', import.meta.url));
  const inPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'out.json');
  const taskPacket = path.join(dir, 'task.md');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  await fs.writeFile(taskPacket, 'cli test content');

  const result = spawnSync(process.execPath, [script, '--in', inPath, '--out', outPath, '--task-packet', taskPacket], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.ok(output.run_id);
  assert.equal(output.hashes.task_packet, sha256(Buffer.from('cli test content')));
  assert.match(result.stdout, new RegExp(`build-manifest: wrote .*\\(run_id ${output.run_id}\\)`),
    'success must print a line, so a wrapper can tell success from silence');
});

test('--seat-transcript: sums every API call once from a subagent transcript, the same quantity Codex reports, and keeps the last-call size apart', async (t) => {
  const dir = await tmpDir(t);
  const cfg = path.join(dir, 'cfg');
  const sub = path.join(cfg, 'projects', 'C--proj', 'sess-1', 'subagents');
  await fs.mkdir(sub, { recursive: true });
  const u = (i, cw, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o });
  const lines = [
    { type: 'user', message: { role: 'user', content: 'brief' } },
    { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: u(10, 1000, 0, 5) } },
    { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: u(10, 1000, 0, 5) } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', usage: u(2, 300, 1010, 40) } },
    { type: 'assistant', message: { id: 'msg_3', model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: 0 } } },
  ].map((l) => JSON.stringify(l));
  const file = path.join(sub, 'agent-a0123456789abcdef.jsonl');
  await fs.writeFile(file, lines.join('\n') + '\n{"type":"assistant","message":{"id":"msg_4","us');
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null };
  const expected = {
    source: 'transcript', transcripts: ['agent-a0123456789abcdef.jsonl'], calls: 3,
    input_tokens: 12, cache_creation_input_tokens: 1300, cache_read_input_tokens: 1010,
    output_tokens: null, output_tokens_note: 'not in the transcript: it records output_tokens from the start of each reply, before the reply is written',
    total_input_tokens: 2322, max_context_tokens: 1312, models: { 'claude-opus-5-5': 2, 'claude-sonnet-5-5': 1 }, new_input_tokens: 1312, context_reread_tokens: 1010, usage_note: 'total_input_tokens counts the whole context re-sent on every call; new_input_tokens is what this actor added, context_reread_tokens is the cached context read again', active_ms: null, unparsed_lines: 1,
    commands: { tried: 0, failed: 0, source: 'transcript' }, duration_ms: null,
  };
  const byPath = await run({ ...base, seatUsage: {}, seatTranscripts: { A: [file] } });
  assert.deepEqual(byPath.seat_usage.A, expected);

  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  const args = parseArgs(['--in', inPath, '--out', base.out, '--seat-transcript', 'A=a0123456789abcdef', '--seat-usage', 'A=1312,600000']);
  const byId = await run(args);
  assert.deepEqual(byId.seat_usage.A, { ...expected, duration_ms: 600000, duration_source: 'harness' });
  const clocked = await run(parseArgs(['--in', inPath, '--out', base.out, '--seat-transcript', 'A=a0123456789abcdef', '--seat-usage', 'A=unknown,810000,clock']));
  assert.deepEqual(clocked.seat_usage.A, { ...expected, duration_ms: 810000, duration_source: 'clock' }, 'a timed span is labeled clock, not harness');
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--seat-usage', 'A=unknown,unknown,clock']), /nothing to mark clock/);
  await assert.rejects(run({ ...base, seatUsage: {}, seatTranscripts: { A: ['a00000000deadbeef'] } }), /matched 0 transcripts/);

  const empty = path.join(dir, 'empty.jsonl');
  await fs.writeFile(empty, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  await assert.rejects(run({ ...base, seatUsage: {}, seatTranscripts: { auditor: [empty] } }), /no API usage found/);
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--seat-transcript', 'C=x.jsonl']), /must look like/);
  const verifiers = await run({ ...base, seatUsage: {}, seatTranscripts: { verifier: [file, file] } });
  assert.equal(verifiers.seat_usage.verifier.calls, 3, 'falsification verifiers are summed under their own role, each call once');
  const orchestrator = await run({ ...base, seatUsage: {}, seatTranscripts: { orchestrator: [file] } });
  assert.equal(orchestrator.seat_usage.orchestrator.total_input_tokens, 2322, 'the orchestrator session is recorded under its own role');
  assert.equal(parseArgs(['--in', 'i', '--out', 'o', '--seat-transcript', 'orchestrator=s.jsonl']).seatTranscripts.orchestrator[0], 's.jsonl');
});
test('--reviewer-result: agent threads a Codex seat spawned reach the manifest as child_threads with a WARNING; an older result.json without the field still merges', async (t) => {
  const dir = await tmpDir(t);
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', provider: 'openai' }] }));
  const base = { in: inPath, out: path.join(dir, 'o.json'), taskPacket: null, phase1: [], phase2: [], verification: [], findings: null, seatUsage: {} };
  const common = { modelRequested: 'gpt-x', modelResolved: null, effortRequested: null, effortResolved: null, isolated: false, worktreePath: null, status: 'completed', threadId: 'th', durationMs: 5 };
  const p1 = path.join(dir, 'p1.json');
  const p2 = path.join(dir, 'p2.json');
  const kid = { threadId: 'kid', parentThreadId: 'th', agentPath: '/root/a', depth: 1, usage: { input_tokens: 40 } };
  await fs.writeFile(p1, JSON.stringify({ ...common, usage: { input_tokens: 10 }, childThreads: [kid] }));
  await fs.writeFile(p2, JSON.stringify({ ...common, usage: { input_tokens: 12 } }));
  const out = await run({ ...base, reviewerResults: { B: [p1, p2] } });
  assert.deepEqual(out.reviewers[0].child_threads, [kid]);
  assert.ok(out.warnings.some((w) => /spawned 1 agent thread/.test(w)));
  const clean = await run({ ...base, reviewerResults: { B: [p2] } });
  assert.ok(!('child_threads' in clean.reviewers[0]));
  assert.equal(clean.warnings.length, 0);
});

test('--seat-transcript: the wait after a SubagentHandback, or after end_turn followed by harness bookkeeping entries, is not working time', async (t) => {
  const dir = await tmpDir(t);
  const at = (s) => new Date(Date.UTC(2026, 8, 30, 21, 0, s)).toISOString();
  const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  // Shapes copied from real transcripts: a subagent hands back with a tool call and gets a
  // tool_result; an orchestrator's end_turn is followed by stop_hook_summary and turn_duration.
  const seat = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'phase 1 brief' } },
    { type: 'assistant', timestamp: at(50), message: { id: 'h1', stop_reason: 'tool_use', usage: u, content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: {} }] } },
    { type: 'user', timestamp: at(51), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'attachment', timestamp: at(52) },
    { type: 'user', timestamp: at(3651), message: { role: 'user', content: 'phase 2 brief' } },
    { type: 'assistant', timestamp: at(3671), message: { id: 'h2', stop_reason: 'end_turn', usage: u } },
  ];
  const orchestrator = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'start' } },
    { type: 'assistant', timestamp: at(30), message: { id: 'o1', stop_reason: 'end_turn', usage: u } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: at(31) },
    { type: 'system', subtype: 'turn_duration', timestamp: at(32) },
    { type: 'queue-operation', timestamp: at(4000) },
    { type: 'user', timestamp: at(4001), message: { role: 'user', content: 'tokens are back' } },
    { type: 'assistant', timestamp: at(4011), message: { id: 'o2', stop_reason: 'end_turn', usage: u } },
  ];
  const write = async (name, entries) => {
    const f = path.join(dir, name);
    await fs.writeFile(f, entries.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return f;
  };
  const a = await write('agent-a0000000000000002.jsonl', seat);
  const o = await write('orchestrator.jsonl', orchestrator);
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const out = await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o.json'), '--seat-transcript', `A=${a}`, '--seat-transcript', `orchestrator=${o}`]));
  assert.equal(out.seat_usage.A.active_ms, 70000, '50 s of phase 1 plus 20 s of phase 2; the hour after the handback is left out');
  assert.equal(out.seat_usage.orchestrator.active_ms, 40000, '30 s plus 10 s; the wait for the user is left out');
});

test('a completed result.json under the run dir that no --reviewer-result names is reported as a WARNING', async (t) => {
  const dir = await tmpDir(t);
  const write = async (rel, obj) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), JSON.stringify(obj));
  };
  const result = { status: 'completed', modelRequested: 'gpt-6-sol', usage: { input_tokens: 10 }, usage_delta: { input_tokens: 10 }, durationMs: 100 };
  await write('phase1/B/result.json', result);
  // A brief left in phase2/ itself makes the dispatcher write phase2/result.json (a real run's shape).
  await write('phase2/result.json', result);
  await write('phase2/B/result.attempt-1.json', { ...result, status: 'rate-limited' });
  await write('phase3/redact-B/result.json', { ...result, status: 'error' });
  const inPath = path.join(dir, 'body.json');
  await fs.writeFile(inPath, JSON.stringify({ reviewers: [{ role: 'B', provider: 'openai', selection_source: 'saved' }] }));
  const build = (...files) => run(parseArgs(['--in', inPath, '--out', path.join(dir, 'manifest.json'), ...files.flatMap((f) => ['--reviewer-result', `B=${path.join(dir, f)}`])]));
  const one = await build('phase1/B/result.json');
  const missing = one.warnings.filter((w) => /not passed to --reviewer-result/.test(w));
  assert.equal(missing.length, 1, 'only the completed, unlisted call is reported');
  assert.match(missing[0], /phase2[\\/]result\.json/);
  const both = await build('phase1/B/result.json', 'phase2/result.json');
  assert.equal(both.warnings.filter((w) => /not passed to --reviewer-result/.test(w)).length, 0);
});

test('--seat-transcript: a wait that ends at an interrupt, an idle notification or a queued message is not working time; a tool still running is', async (t) => {
  const dir = await tmpDir(t);
  const at = (s) => new Date(Date.UTC(2026, 9, 1, 22, 0, s)).toISOString();
  const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const tool = (id) => ({ type: 'assistant', message: { id, stop_reason: 'tool_use', usage: u, content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: {} }] } });
  const result = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: 'ok' }] } });
  // Shapes copied from real transcripts: a seat stalls after a tool result and is interrupted, then
  // resumed hours later; an orchestrator logs a task notification while idle and starts its turn
  // only hours later; a coordinator message is queued while a tool is still running.
  const entries = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'brief' } },
    { ...tool('a1'), timestamp: at(10) },
    { ...result('a1'), timestamp: at(20) },
    { type: 'attachment', timestamp: at(21) },
    { type: 'user', timestamp: at(1300), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', timestamp: at(15000), message: { role: 'user', content: '<task-notification>seat stopped</task-notification>' } },
    { type: 'queue-operation', timestamp: at(29000) },
    { ...tool('a2'), timestamp: at(29030) },
    { type: 'queue-operation', timestamp: at(29100) },
    { ...result('a2'), timestamp: at(29200) },
    { type: 'assistant', timestamp: at(29210), message: { id: 'a3', stop_reason: 'end_turn', usage: u } },
  ];
  const file = path.join(dir, 'agent-a0000000000000003.jsonl');
  await fs.writeFile(file, entries.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const out = await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o.json'), '--seat-transcript', `A=${file}`]));
  // 10 s + 10 s before the stall; 30 s to the next reply after the queued message; 170 s of a
  // tool run with a message queued in the middle; 10 s to the final reply.
  assert.equal(out.seat_usage.A.active_ms, 230000);
});

test('--seat-transcript: duration_ms is the seat\'s working time from its transcript, leaving out the wait after a final reply; only a clock span given by hand overrides it', async (t) => {
  const dir = await tmpDir(t);
  const at = (s) => new Date(Date.UTC(2026, 8, 28, 4, 0, s)).toISOString();
  const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const lines = [
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'phase 1 brief' } },
    { type: 'assistant', timestamp: at(10), message: { id: 'm1', stop_reason: 'tool_use', usage: u } },
    { type: 'user', timestamp: at(70), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', timestamp: at(100), message: { id: 'm2', stop_reason: 'end_turn', usage: u } },
    { type: 'user', timestamp: at(5000), message: { role: 'user', content: 'phase 2 brief' } },
    { type: 'assistant', timestamp: at(5020), message: { id: 'm3', stop_reason: 'end_turn', usage: u } },
  ].map((l) => JSON.stringify(l));
  const file = path.join(dir, 'agent-a0000000000000001.jsonl');
  await fs.writeFile(file, lines.join('\n') + '\n');
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const build = (...extra) => run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o.json'), '--seat-transcript', `A=${file}`, ...extra]));
  const plain = (await build()).seat_usage.A;
  assert.equal(plain.active_ms, 120000, '100 s of phase 1 plus 20 s of phase 2; the 4,900 s wait after end_turn is left out');
  assert.equal(plain.duration_ms, 120000);
  assert.equal(plain.duration_source, 'transcript');
  const estimated = (await build('--seat-usage', 'A=unknown,999000,estimated')).seat_usage.A;
  assert.deepEqual([estimated.duration_ms, estimated.duration_source, estimated.duration_hand_ms, estimated.duration_hand_source], [120000, 'transcript', 999000, 'estimated']);
  const harness = (await build('--seat-usage', 'A=unknown,999000')).seat_usage.A;
  assert.deepEqual([harness.duration_ms, harness.duration_source, harness.duration_hand_source], [120000, 'transcript', 'harness']);
  const clock = (await build('--seat-usage', 'A=unknown,130000,clock')).seat_usage.A;
  assert.deepEqual([clock.duration_ms, clock.duration_source], [130000, 'clock']);
  assert.ok(!('duration_hand_ms' in clock));
});

test('skill_versions is filled from <run-dir>/skill-versions.jsonl next to --out, with a WARNING when the version changed; a body value is kept', async (t) => {
  const run = await tmpDir(t);
  const inPath = path.join(run, 'body.json');
  const row = (phase, version, skill = 'cross-review') => JSON.stringify({ phase, mode: 'x', seat: null, skill, version, at: '2026-09-29T00:00:00Z' });
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const none = await run_(inPath, path.join(run, 'm0.json'));
  assert.ok(!('skill_versions' in none), 'no file, no field');
  await fs.writeFile(path.join(run, 'skill-versions.jsonl'), [row('phase1', '1.8.13'), row('phase1', '1.8.13'), row('phase2', '1.8.14'), row('phase3', '1.8.14'), 'not json'].join('\n') + '\n');
  const out = await run_(inPath, path.join(run, 'manifest.json'));
  assert.deepEqual(out.skill_versions, { phase1: '1.8.13', phase2: '1.8.14', phase3: '1.8.14' });
  assert.ok(out.warnings.some((w) => /skill version changed during the run: 1\.8\.13, 1\.8\.14/.test(w)));
  await fs.writeFile(path.join(run, 'skill-versions.jsonl'), [row('phase1', '1.8.12', 'cross-review'), row('phase1', '1.8.12', 'pair-review'), row('phase3', '1.8.12', 'pair-review')].join('\n') + '\n');
  const moved = await run_(inPath, path.join(run, 'manifest2.json'));
  assert.deepEqual(moved.skill_versions, { phase1: ['cross-review 1.8.12', 'pair-review 1.8.12'], phase3: 'pair-review 1.8.12' }, 'a run moved between skills names the skill');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3', skill_versions: { phase1: '1.8.0' } }));
  const kept = await run_(inPath, path.join(run, 'manifest3.json'));
  assert.deepEqual(kept.skill_versions, { phase1: '1.8.0' });
  assert.ok(kept.warnings.some((w) => /body's skill_versions .* differs from what build-brief recorded/.test(w)));
});

async function run_(inPath, outPath) {
  return run(parseArgs(['--in', inPath, '--out', outPath]));
}

test('--seat-transcript <file>@<ISO time> counts only entries from that time on, so one review in a shared session gets its own figure', async (t) => {
  const dir = await tmpDir(t);
  const at = (s) => new Date(Date.UTC(2026, 8, 30, 12, 0, s)).toISOString();
  const u = (i) => ({ input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 });
  const lines = [
    { type: 'assistant', timestamp: at(0), message: { id: 'old1', stop_reason: 'tool_use', usage: u(1000) } },
    { type: 'assistant', timestamp: at(10), message: { id: 'old2', stop_reason: 'end_turn', usage: u(2000) } },
    { type: 'user', timestamp: at(100), message: { role: 'user', content: 'next review' } },
    { type: 'assistant', timestamp: at(110), message: { id: 'new1', stop_reason: 'tool_use', usage: u(5) } },
    { type: 'assistant', timestamp: at(130), message: { id: 'new2', stop_reason: 'end_turn', usage: u(7) } },
  ].map((l) => JSON.stringify(l));
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, lines.join('\n') + '\n');
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const out = await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o.json'), '--seat-transcript', `orchestrator=${file}@${at(100)}`]));
  const o = out.seat_usage.orchestrator;
  assert.deepEqual([o.calls, o.input_tokens, o.active_ms, o.counted_from], [2, 12, 30000, at(100)]);
  const whole = await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o2.json'), '--seat-transcript', `orchestrator=${file}`]));
  assert.equal(whole.seat_usage.orchestrator.calls, 4);
  assert.ok(!('counted_from' in whole.seat_usage.orchestrator));
  await assert.rejects(run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o3.json'), '--seat-transcript', `orchestrator=${file}@2026-13-45Tnope`])), /is not a date and time/);
  const windowed = (await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o4.json'), '--seat-transcript', `orchestrator=${file}@${at(0)}/${at(100)}`]))).seat_usage.orchestrator;
  assert.deepEqual([windowed.calls, windowed.input_tokens, windowed.counted_from, windowed.counted_until], [2, 3000, at(0), at(100)], 'an end time closes the window, so the first review is counted alone');
  await assert.rejects(run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o5.json'), '--seat-transcript', `orchestrator=${file}@${at(100)}/${at(0)}`])), /the end .* is not after the start/);
});

test('--extra-artifact: hashes a named file the protocol does not name into hashes.extra_artifacts, refuses a repeated name, a bad form and a missing file', async (t) => {
  const dir = await tmpDir(t);
  const synthesis = path.join(dir, 'synthesis.md');
  await fs.writeFile(synthesis, '# Recommendation\n');
  const inPath = path.join(dir, 'm.json');
  await fs.writeFile(inPath, JSON.stringify({ protocol: 'review-protocol-v1.3' }));
  const out = await run(parseArgs(['--in', inPath, '--out', path.join(dir, 'o.json'), '--extra-artifact', `synthesis=${synthesis}`]));
  assert.deepEqual(out.hashes.extra_artifacts, { synthesis: createHash('sha256').update('# Recommendation\n').digest('hex') });
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--extra-artifact', 's=a', '--extra-artifact', 's=b']), /given twice for "s"/);
  assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--extra-artifact', 'no-equals']), /must look like synthesis=<path>/);
  await assert.rejects(
    buildHashes({ taskPacket: null, phase1: [], phase2: [], verification: [], findings: null, extraArtifacts: [['gone', path.join(dir, 'gone.md')]] }),
    (e) => e instanceof RelayError && /^--extra-artifact gone ".*gone\.md" cannot be read \(ENOENT\)/.test(e.message)
  );
});
const fixturePath = (name) => new URL('fixtures/' + name, import.meta.url);
const resultFixtures = ['phase1-result.json', 'phase2-result.json'].map((name) => fixturePath('claude-session/' + name));

test('--reviewer-result: per-call Phase 1 and Phase 2 usage is summed even with one threadId', async (t) => {
  const dir = await tmpDir(t);
  const files = await Promise.all(resultFixtures.map(async (url, i) => {
    const file = path.join(dir, 'phase' + (i + 1) + '.json');
    await fs.copyFile(url, file);
    return file;
  }));
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const out = await run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'),
    ...files.flatMap((file) => ['--reviewer-result', 'A=' + file])]));
  const calls = await Promise.all(resultFixtures.map(async (url) => JSON.parse(await fs.readFile(url, 'utf8'))));
  const expected = { source: 'summed-per-call' };
  for (const call of calls) for (const [key, value] of Object.entries(call.usage)) {
    if (typeof value === 'number') expected[key] = (expected[key] ?? 0) + value;
  }
  assert.deepEqual(out.reviewers[0].usage, expected);
  assert.notDeepEqual(out.reviewers[0].usage, calls[1].usage);
  assert.deepEqual(out.reviewers[0].usage_per_call, calls.map((call) => call.usage));
  assert.equal(out.reviewers[0].duration_ms, calls.reduce((sum, call) => sum + call.durationMs, 0));
  assert.deepEqual([out.reviewers[0].host, out.reviewers[0].transport, out.reviewers[0].readOnly],
    [calls[0].host, calls[0].transport, calls[0].readOnly]);
});

test('--reviewer-result: auditor and repeated verifier roles populate actors and do not warn as unlisted', async (t) => {
  const dir = await tmpDir(t);
  const files = [];
  for (const [i, url] of resultFixtures.entries()) {
    const file = path.join(dir, 'phase' + (i + 1), 'auditor', 'result.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(url, file);
    files.push(file);
  }
  const input = path.join(dir, 'body.json');
  const authored = { role: 'A', host: 'claude-code', transport: 'native', readOnly: { shell: 'prompt-only' } };
  await fs.writeFile(input, JSON.stringify({ reviewers: [authored], actors: [{ role: 'auditor', host: 'claude-code' }] }));
  const flags = ['--in', input, '--out', path.join(dir, 'manifest.json'),
    ...['auditor', 'verifier-1', 'verifier-2'].flatMap((role) => files.flatMap((file) => ['--reviewer-result', role + '=' + file]))];
  const out = await run(parseArgs(flags));
  assert.deepEqual(out.reviewers, [authored]);
  assert.deepEqual(out.actors.map((actor) => actor.role), ['auditor', 'verifier-1', 'verifier-2']);
  for (const actor of out.actors) {
    assert.equal(actor.usage.input_tokens, 17);
    assert.equal(actor.duration_ms, 3000);
    assert.equal(actor.transport, 'cli');
  }
  assert.equal(out.actors[0].host, 'claude-code');
  assert.match(out.warnings.join('\n'), /actors\[auditor\]\.host/);
  assert.ok(!out.warnings.some((warning) => /not passed to --reviewer-result/.test(warning)));
  for (const role of ['verifier', 'verifier-x', 'orchestrator', 'C']) {
    assert.throws(() => parseArgs(['--in', 'i', '--out', 'o', '--reviewer-result', role + '=x']), /must look like/);
  }
});

test('--reviewer-result: explicit cumulative semantics wins without threadId; unknown provenance stays null', async (t) => {
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const common = { modelRequested: 'gpt-fixture', usageSemantics: 'cumulative', status: 'completed' };
  const files = [];
  for (const [i, count] of [10, 30].entries()) {
    const file = path.join(dir, 'r' + i + '.json');
    await fs.writeFile(file, JSON.stringify({ ...common, usage: { input_tokens: count } }));
    files.push(file);
  }
  const build = () => run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'),
    ...files.flatMap((file) => ['--reviewer-result', 'B=' + file])]));
  const entry = (await build()).reviewers[0];
  assert.deepEqual(entry.usage, { input_tokens: 30 });
  assert.deepEqual([entry.host, entry.transport, entry.readOnly], [null, null, null]);
  await fs.writeFile(files[1], JSON.stringify({ ...common, usage: { source: 'unavailable' } }));
  const missing = (await build()).reviewers[0];
  assert.equal(missing.usage, null);
  assert.match(missing.usage_reason, /no usable usage/);
  await fs.writeFile(files[1], JSON.stringify({ ...common, usageSemantics: 'guess' }));
  await assert.rejects(build(), /invalid usageSemantics/);
});

test('--reviewer-result: provenance is preserved in body with warnings and mismatched calls are refused', async (t) => {
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  const first = JSON.parse(await fs.readFile(resultFixtures[0], 'utf8'));
  const file = path.join(dir, 'result.json');
  await fs.writeFile(file, JSON.stringify(first));
  const body = { role: 'A', host: 'claude-code', transport: 'native', readOnly: { shell: 'prompt-only', cwd: 'target' } };
  await fs.writeFile(input, JSON.stringify({ reviewers: [body] }));
  const base = ['--in', input, '--out', path.join(dir, 'manifest.json'), '--reviewer-result', 'A=' + file];
  const out = await run(parseArgs(base));
  for (const key of ['host', 'transport', 'readOnly']) {
    assert.deepEqual(out.reviewers[0][key], body[key]);
    assert.ok(out.warnings.some((warning) => warning.includes('reviewers[A].' + key)));
    const second = path.join(dir, key + '.json');
    await fs.writeFile(second, JSON.stringify({ ...first, [key]: body[key] }));
    await assert.rejects(run(parseArgs([...base, '--reviewer-result', 'A=' + second])), new RegExp('disagree on ' + key));
  }
});

test('--seat-transcript: orchestrator detects Codex rollouts, subtracts window counters and leaves missing usage null', async (t) => {
  const { fileURLToPath } = await import('node:url');
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const file = fileURLToPath(fixturePath('rollout/orchestrator.jsonl'));
  const build = (value) => run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'), '--seat-transcript', 'orchestrator=' + value]));
  const start = '2026-10-04T12:00:10Z';
  const end = '2026-10-04T12:00:30Z';
  const out = (await build(file + '@' + start + '/' + end)).seat_usage.orchestrator;
  assert.equal(out.source, 'codex-rollout');
  assert.deepEqual([out.input_tokens, out.cached_input_tokens, out.output_tokens, out.total_tokens], [60, 20, 15, 75]);
  assert.deepEqual([out.counted_from, out.counted_until], [start, end]);
  assert.equal(out.active_ms, null);
  assert.equal(out.duration_ms, null);
  assert.match(out.active_ms_note, /not recorded/);
  assert.equal((await build(file)).seat_usage.orchestrator.input_tokens, 300);
  assert.equal((await build(file + '@' + start)).seat_usage.orchestrator.input_tokens, 200);
  const missing = (await build(fileURLToPath(fixturePath('rollout/no-usage.jsonl')))).seat_usage.orchestrator;
  assert.equal(missing.source, 'codex-rollout');
  assert.equal(missing.input_tokens, null);
  assert.equal(missing.total_tokens, null);
  assert.match(missing.reason, /no rollout token usage/);
  const baseline = (await build(file + '@2026-10-03T12:00:00Z/2026-10-03T13:00:00Z')).seat_usage.orchestrator;
  assert.equal(baseline.input_tokens, null);
  assert.match(baseline.reason, /no rollout token usage/);
  const invalid = path.join(dir, 'invalid.jsonl');
  await fs.writeFile(invalid, '{"type":"unrelated","usage":{"input_tokens":500}}\n');
  await assert.rejects(build(invalid), /neither a Codex rollout .* nor a Claude session transcript/);
});

test('--seat-transcript: real lean Claude session reports independently counted calls, models and active time', async (t) => {
  const { fileURLToPath } = await import('node:url');
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const fixture = fixturePath('claude-session/lean-session.jsonl');
  const text = await fs.readFile(fixture, 'utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  const calls = Object.fromEntries(rows.filter((row) => row.type === 'assistant' && row.message?.id && row.message.usage)
    .map((row) => [row.message.id, row.message]));
  const models = {};
  for (const call of Object.values(calls)) models[call.model] = (models[call.model] ?? 0) + 1;
  assert.deepEqual(Object.keys(models), ['claude-haiku-4-5-20251001']);
  assert.equal(rows.filter((row) => row.type === 'user' && typeof row.message?.content === 'string').length, 2);
  const timeline = rows.filter((row) => Number.isFinite(Date.parse(row.timestamp)));
  let active = 0;
  for (let i = 1; i < timeline.length; i++) {
    const row = timeline[i];
    const previous = timeline[i - 1];
    const lastMessage = timeline.slice(0, i).findLast((entry) => entry.type === 'assistant' || entry.type === 'user');
    const toolResult = row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some((item) => item.type === 'tool_result');
    const toolPending = lastMessage?.type === 'assistant' && lastMessage.message.stop_reason === 'tool_use';
    const finished = lastMessage?.type === 'assistant' && lastMessage.message.stop_reason === 'end_turn';
    if (!finished && (row.type === 'assistant' || toolResult || toolPending)) {
      active += Math.max(0, Date.parse(row.timestamp) - Date.parse(previous.timestamp));
    }
  }
  assert.ok(active > 0);
  const out = await run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'), '--seat-transcript', 'A=' + fileURLToPath(fixture)]));
  assert.equal(out.seat_usage.A.source, 'transcript');
  assert.equal(out.seat_usage.A.calls, Object.keys(calls).length);
  assert.deepEqual(out.seat_usage.A.models, models);
  assert.equal(out.seat_usage.A.active_ms, active);
  assert.equal(out.seat_usage.A.duration_ms, active);
  assert.ok(Buffer.byteLength(text) <= 102400);
  assert.doesNotMatch(text, /mkhalifa|Mahmoud|C:[\\/]+Users[\\/]+mkhalifa|@/i);
});

test('protocol manifest example covers every key stamped on a complete fixture run', async (t) => {
  const { fileURLToPath } = await import('node:url');
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, JSON.stringify({ falsification: { requested: true, verifiers_run: 1 } }));
  const flags = ['--in', input, '--out', path.join(dir, 'manifest.json')];
  for (const [flag, names] of [
    ['--task-packet', ['task.md']], ['--phase1', ['A.md', 'B.md']],
    ['--phase2', ['A.md', 'B.md']], ['--verification', ['X1.md']], ['--findings', ['findings.json']],
  ]) {
    for (const name of names) {
      const file = path.join(dir, flag.slice(2) + '-' + name);
      await fs.writeFile(file, '{}\n');
      flags.push(flag, file);
    }
  }
  const synthesis = path.join(dir, 'synthesis.md');
  await fs.writeFile(synthesis, 'synthesis');
  flags.push('--extra-artifact', 'synthesis=' + synthesis);
  const breakdown = path.join(dir, 'breakdown.json');
  await fs.writeFile(breakdown, JSON.stringify({ high_or_critical: 2, disputed: 1, conceded: 1, unaddressed: 0 }));
  flags.push('--falsification', breakdown);
  await fs.writeFile(path.join(dir, 'skill-versions.jsonl'), JSON.stringify({ phase: 'phase1', skill: 'fixture', version: '1.0.0' }) + '\n');
  for (const role of ['A', 'B', 'auditor']) {
    for (const [i, url] of resultFixtures.entries()) {
      const result = JSON.parse(await fs.readFile(url, 'utf8'));
      if (role === 'B' && i === 0) result.childThreads = [{ threadId: 'CHILD', parentThreadId: 'PARENT', agentPath: '/root/child', depth: 1, usage: { input_tokens: 2 } }];
      const file = path.join(dir, role + i + '.json');
      await fs.writeFile(file, JSON.stringify(result));
      flags.push('--reviewer-result', role + '=' + file);
    }
  }
  const verifier = path.join(dir, 'verifier.json');
  await fs.writeFile(verifier, JSON.stringify({ modelRequested: 'haiku', usageSemantics: 'per-call', usage: { source: 'unavailable' } }));
  flags.push('--reviewer-result', 'verifier-1=' + verifier);
  flags.push('--seat-transcript', 'A=' + fileURLToPath(fixturePath('claude-session/lean-session.jsonl')),
    '--seat-usage', 'A=unknown,999000,estimated',
    '--seat-transcript', 'orchestrator=' + fileURLToPath(fixturePath('rollout/orchestrator.jsonl')) + '@2026-10-04T12:00:10Z/2026-10-04T12:00:30Z');
  const stamped = await run(parseArgs(flags));
  const protocol = await fs.readFile(new URL('../../references/review-protocol.md', import.meta.url), 'utf8');
  const section = protocol.slice(protocol.indexOf('## Manifest and final output'));
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)[1]);
  const keyPaths = (value, prefix = '') => {
    if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, prefix + '[]'));
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const current = prefix ? prefix + '.' + key : key;
      return [current, ...keyPaths(child, current)];
    });
  };
  const documented = new Set(keyPaths(example));
  const missing = [...new Set(keyPaths(JSON.parse(await fs.readFile(flags[3], 'utf8'))))].filter((key) => !documented.has(key));
  assert.deepEqual(missing, [], 'example omits keys observed in build-manifest fixture output');
  assert.ok(Object.keys(stamped).length > 5);
});

test('--seat-transcript: missing Claude token fields remain null with a reason', async (t) => {
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  const transcript = path.join(dir, 'partial.jsonl');
  await fs.writeFile(input, '{}');
  await fs.writeFile(transcript, JSON.stringify({ type: 'assistant', message: { id: 'partial', model: 'fixture', usage: {} } }) + '\n');
  const out = await run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'), '--seat-transcript', 'A=' + transcript]));
  assert.equal(out.seat_usage.A.input_tokens, null);
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens', 'total_input_tokens', 'max_context_tokens']) {
    assert.equal(out.seat_usage.A[key], null);
  }
  assert.match(out.seat_usage.A.reason, /missing transcript usage fields/);
  assert.equal(out.seat_usage.A.active_ms, null);
});

async function usageOf(t, results, role = 'A') {
  const dir = await tmpDir(t);
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const files = [];
  for (const [i, result] of results.entries()) {
    const file = path.join(dir, 'r' + i + '.json');
    await fs.writeFile(file, JSON.stringify({ modelRequested: 'm', status: 'completed', ...result }));
    files.push(file);
  }
  const out = await run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'),
    ...files.flatMap((file) => ['--reviewer-result', role + '=' + file])]));
  return out.reviewers[0];
}

test('--reviewer-result: a token field that one per-call result lacks is unknown in the sum, not a partial total', async (t) => {
  const entry = await usageOf(t, [
    { usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: 100, output_tokens: 10, cached_input_tokens: null } },
    { usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: null, output_tokens: 20, cached_input_tokens: 5 } },
  ]);
  assert.equal(entry.usage.input_tokens, null, 'input is unknown when one call did not report it');
  assert.equal(entry.usage.cached_input_tokens, null, 'a field reported by only one call is unknown too');
  assert.equal(entry.usage.output_tokens, 30, 'a field every call reports is still summed');
  const all = await usageOf(t, [
    { usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: 1, output_tokens: 2 } },
    { usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: 3, output_tokens: 4 } },
  ]);
  assert.deepEqual([all.usage.input_tokens, all.usage.output_tokens], [4, 6]);
});

test('--reviewer-result: explicit cumulative results from different threads add each thread\'s final total', async (t) => {
  const cumulative = (threadId, input) => ({ usageSemantics: 'cumulative', threadId, usage: { source: 'provider', input_tokens: input } });
  const two = await usageOf(t, [cumulative('thread-1', 100), cumulative('thread-2', 200)]);
  assert.equal(two.usage.input_tokens, 300, 'the first session is not dropped');
  const resumed = await usageOf(t, [cumulative('thread-1', 100), cumulative('thread-1', 150), cumulative('thread-2', 200)]);
  assert.equal(resumed.usage.input_tokens, 350, 'one thread counts its last total only');
  const same = await usageOf(t, [cumulative('thread-1', 100), cumulative('thread-1', 150)]);
  assert.equal(same.usage.input_tokens, 150, 'one shared thread still takes the last total');
});

test('the shipped Claude session fixture carries no provider request, message or tool-use IDs and no thinking signatures', async () => {
  const text = await fs.readFile(fixturePath('claude-session/lean-session.jsonl'), 'utf8');
  assert.equal(/(?<![A-Za-z0-9])(?:req|msg|toolu)_(?!PLACEHOLDER_\d+(?![A-Za-z0-9]))[A-Za-z0-9]+/.test(text), false, 'every req_, msg_ and toolu_ value is a placeholder');
  assert.equal(/"signature":"[^"]/.test(text), false, 'thinking signatures are blank');
  const messageIds = new Set([...text.matchAll(/"id":"(msg_PLACEHOLDER_\d+)"/g)].map((m) => m[1]));
  assert.ok(messageIds.size > 1 && messageIds.size < [...text.matchAll(/"id":"msg_PLACEHOLDER_\d+"/g)].length, 'repeated message ids map to one placeholder, so the per-message dedupe still applies');
});

test('R2-F13: legacy cumulative results (no usageSemantics, no usage_delta) from several threads take each thread\'s final total', async (t) => {
  const legacy = (threadId, input) => ({ threadId, usage: { source: 'provider', input_tokens: input } });
  const resumed = await usageOf(t, [legacy('thread-1', 100), legacy('thread-1', 150), legacy('thread-2', 200)]);
  assert.equal(resumed.usage.input_tokens, 350, 'thread-1 counts its final 150 once, plus thread-2');
  assert.equal(resumed.usage.source, 'summed-per-thread');
  const two = await usageOf(t, [legacy('thread-1', 100), legacy('thread-2', 200)]);
  assert.equal(two.usage.input_tokens, 300);
  const same = await usageOf(t, [legacy('thread-1', 100), legacy('thread-1', 150)]);
  assert.equal(same.usage.input_tokens, 150, 'one shared thread still takes the last total');
  const withDelta = await usageOf(t, [{ threadId: 'thread-1', usage: { input_tokens: 100 }, usage_delta: { input_tokens: 100 } }, { threadId: 'thread-1', usage: { input_tokens: 150 }, usage_delta: { input_tokens: 50 } }, { threadId: 'thread-2', usage: { input_tokens: 200 }, usage_delta: { input_tokens: 200 } }]);
  assert.equal(withDelta.usage.input_tokens, 350, 'records with a usage_delta are still summed by their deltas');
});

test('final-F2: results of one resumed thread that carry usage_delta are summed through the deltas, not read as the last cumulative total', async (t) => {
  const resumedPreUsed = await usageOf(t, [
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 900 }, usage_delta: { source: 'delta-from-previous-result', input_tokens: 100 } },
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 950 }, usage_delta: { source: 'delta-from-previous-result', input_tokens: 50 } },
  ]);
  assert.equal(resumedPreUsed.usage.input_tokens, 150, 'only this review\'s own cost is counted');
  assert.equal(resumedPreUsed.usage.source, 'summed-per-call');
  assert.deepEqual(resumedPreUsed.usage_per_call.map((u) => u.input_tokens), [100, 50], 'the total agrees with usage_per_call');
  const fresh = await usageOf(t, [
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 100 }, usage_delta: { source: 'fresh-thread', input_tokens: 100 } },
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 150 }, usage_delta: { source: 'delta-from-previous-result', input_tokens: 50 } },
  ]);
  assert.equal(fresh.usage.input_tokens, 150, 'a fresh thread still totals its final cumulative value');
  const unavailable = await usageOf(t, [
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 100 }, usage_delta: { source: 'fresh-thread', input_tokens: 100 } },
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 150 }, usage_delta: { source: 'unavailable', reason: 'resumed thread' } },
  ]);
  assert.equal(unavailable.usage.input_tokens, 150, 'a call whose delta is unavailable keeps the last-total reading');
});

test('final-F6: OpenCode results are summed per call, stamped or not; a Codex thread without deltas still takes its last total', async (t) => {
  const stamped = await usageOf(t, [
    { sessionId: 'ses-1', usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: 1000, output_tokens: 10 } },
    { sessionId: 'ses-1', usageSemantics: 'per-call', usage: { source: 'provider', input_tokens: 300, output_tokens: 10 } },
  ]);
  assert.deepEqual([stamped.usage.source, stamped.usage.input_tokens, stamped.usage.output_tokens], ['summed-per-call', 1300, 20]);
  const legacyOpenCode = await usageOf(t, [
    { sessionId: 'ses-1', usage: { source: 'provider', input_tokens: 1000, output_tokens: 10 } },
    { sessionId: 'ses-1', usage: { source: 'provider', input_tokens: 300, output_tokens: 10 } },
  ]);
  assert.deepEqual([legacyOpenCode.usage.source, legacyOpenCode.usage.input_tokens], ['summed-per-call', 1300], 'an OpenCode result from before the stamp is summed as 1.0.0 did');
  const codex = await usageOf(t, [
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 100 } },
    { threadId: 'thread-1', usage: { source: 'provider', input_tokens: 150 } },
  ]);
  assert.equal(codex.usage.input_tokens, 150);
});

test('a native Codex seat: --seat-transcript A=<rollout> records usage and the rollout model, and --run-dir copies host, support rows and host_status', async (t) => {
  const dir = await tmpDir(t);
  const line = (o) => JSON.stringify(o);
  const rollout = [
    line({ type: 'session_meta', timestamp: '2026-10-07T13:05:41.000Z', payload: { id: 'agent-thread', timestamp: '2026-10-07T13:05:41.000Z' } }),
    line({ type: 'turn_context', timestamp: '2026-10-07T13:05:42.000Z', payload: { model: 'gpt-5.6-terra', effort: 'medium' } }),
    line({ type: 'event_msg', timestamp: '2026-10-07T13:09:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, cache_write_input_tokens: 0, output_tokens: 90, reasoning_output_tokens: 20, total_tokens: 4090 } } } }),
  ].join('\n') + '\n';
  const file = path.join(dir, 'rollout-agent.jsonl');
  await fs.writeFile(file, rollout);
  const run = path.join(dir, 'run');
  await fs.mkdir(run);
  const rows = [{ role: 'A', runtime: 'codex', transport: 'native', status: 'trial' }, { role: 'auditor', runtime: 'codex', transport: 'native', status: 'trial' }];
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ host: 'codex', support: rows }));
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const out = await run_(input, path.join(dir, 'manifest.json'));
  assert.ok(!('support' in out), 'no --run-dir, no support record');
  const manifest = await runCli(['--in', input, '--out', path.join(dir, 'm2.json'), '--run-dir', run, '--seat-transcript', 'A=' + file]);
  assert.equal(manifest.seat_usage.A.source, 'codex-rollout');
  assert.equal(manifest.seat_usage.A.input_tokens, 4000);
  assert.equal(manifest.seat_usage.A.model_resolved, 'gpt-5.6-terra');
  assert.match(manifest.seat_usage.A.model_resolved_note, /configured model/);
  assert.equal(manifest.host, 'codex');
  assert.deepEqual(manifest.support, rows);
  assert.equal(manifest.host_status, 'trial');
  await fs.writeFile(input, JSON.stringify({ host_status: 'supported' }));
  const kept = await runCli(['--in', input, '--out', path.join(dir, 'm3.json'), '--run-dir', run]);
  assert.equal(kept.host_status, 'supported', 'a body value is kept');
  const missing = await runCli(['--in', input, '--out', path.join(dir, 'm4.json'), '--run-dir', path.join(dir, 'no-such-run')]);
  assert.ok(missing.warnings.some((w) => /run\.json could not be read/.test(w)));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ host: 'codex', support: rows, auditor: { role: 'auditor', provider: 'anthropic' }, verifiers: [{ role: 'verifier-1', provider: 'openai' }] }));
  await fs.writeFile(input, JSON.stringify({ actors: [{ role: 'auditor' }, { role: 'verifier-1', provider: 'opencode' }] }));
  const stamped = await runCli(['--in', input, '--out', path.join(dir, 'm5.json'), '--run-dir', run]);
  assert.deepEqual(stamped.actors.map((a) => a.provider), ['anthropic', 'opencode'], 'run.json fills a missing actor provider; a body value is kept');
});

function runCli(args) {
  return run(parseArgs(args));
}

test('a native seat read cold: reviewers[A] points to its seat_usage and carries the single transcript model; native-agents.json supplies the transcript', async (t) => {
  const dir = await tmpDir(t);
  const at = (s) => new Date(Date.UTC(2026, 9, 7, 13, 0, s)).toISOString();
  const entry = (id, stop, input, create, read) => JSON.stringify({ type: 'assistant', timestamp: at(Number(id.slice(1))), message: { id, model: 'claude-opus-5-5', stop_reason: stop, usage: { input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: read, output_tokens: 1 } } });
  const transcript = path.join(dir, 'agent-a.jsonl');
  await fs.writeFile(transcript, [entry('m1', 'tool_use', 5, 100, 1000), entry('m2', 'end_turn', 5, 20, 1200)].join('\n') + '\n');
  const run = path.join(dir, 'run');
  await fs.mkdir(run);
  await fs.writeFile(path.join(run, 'native-agents.json'), JSON.stringify({ A: transcript }));
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, JSON.stringify({ reviewers: [{ role: 'A', provider: 'anthropic' }, { role: 'B', provider: 'openai' }] }));
  const out = await runCli(['--in', input, '--out', path.join(dir, 'manifest.json'), '--run-dir', run]);
  const usage = out.seat_usage.A;
  assert.equal(usage.calls, 2);
  assert.equal(usage.new_input_tokens, 130, 'plain input plus cache creation');
  assert.equal(usage.context_reread_tokens, 2200, 'cache reads are the context read again');
  assert.equal(usage.total_input_tokens, 2330);
  assert.match(usage.usage_note, /whole context re-sent on every call/);
  const a = out.reviewers.find((r) => r.role === 'A');
  assert.equal(a.usage_ref, 'seat_usage.A');
  assert.equal(a.model_resolved, 'claude-opus-5-5');
  assert.equal(a.model_resolved_source, 'transcript');
  const b = out.reviewers.find((r) => r.role === 'B');
  assert.ok(!('usage_ref' in b), 'a seat without seat_usage gets no pointer');
  const explicit = await runCli(['--in', input, '--out', path.join(dir, 'm2.json'), '--run-dir', run, '--seat-transcript', 'A=' + transcript + '@2026-10-07T13:00:02Z']);
  assert.equal(explicit.seat_usage.A.calls, 1, 'an explicit --seat-transcript wins over native-agents.json');
});

async function fixtureRun(t) {
  const { writeRunDescriptor } = await import('../run-descriptor.mjs');
  const dir = await tmpDir(t);
  const runDir = path.join(dir, 'run');
  const actor = (role, extra = {}) => ({ role, provider: 'anthropic', runtime: 'claude', model: 'opus', effort: null, transport: 'cli', sessionId: null, outputDir: path.join(dir, role), resultPath: null, worktreePath: null, ...extra });
  await fs.mkdir(path.join(runDir, 'phase1', 'B'), { recursive: true });
  await writeRunDescriptor(runDir, {
    skill: 'cross-review', skillDir: path.join(dir, 'skill'), targetDir: dir, host: 'claude-code',
    flags: { auditDepth: 'full', falsification: false, mode: 'adversarial' }, fingerprint: null,
    seatA: actor('A', { transport: 'native' }), seatB: actor('B', { provider: 'openai', runtime: 'codex', model: 'gpt-5.6-terra' }), auditor: actor('auditor', { transport: 'native', outputDir: `${runDir}-audit-input` }), verifiers: [],
  });
  return { dir, runDir };
}

test('--init writes the minimal body from run.json and refuses to overwrite it', async (t) => {
  const { runDir } = await fixtureRun(t);
  await fs.mkdir(path.join(runDir, 'phase3-private'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'phase3-private', 'seat-to-audit-label.json'), JSON.stringify({ A: 'Y', B: 'X' }));
  const out = path.join(runDir, 'body.json');
  assert.equal(await run(parseArgs(['--init', '--run-dir', runDir, '--out', out])), null);
  const body = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(body.reviewers.map((r) => [r.role, r.provider]), [['A', 'anthropic'], ['B', 'openai']]);
  assert.equal(body.topology, 'cross-vendor');
  assert.equal(body.mode, 'adversarial');
  assert.equal(body.status, 'incomplete', 'no findings.json yet');
  assert.deepEqual(body.exchange, { blinded: true, seat_to_audit_label: { A: 'Y', B: 'X' }, auditor_model_family: 'same-as-reviewer-A', auditor: 'fresh-context', audit_depth: 'full' });
  assert.deepEqual(body.falsification, { requested: false, verifiers_run: 0 });
  await assert.rejects(run(parseArgs(['--init', '--run-dir', runDir, '--out', out])), /EEXIST|exists/);
  assert.throws(() => parseArgs(['--init', '--out', out]), /--init needs --run-dir/);
});

test('--run-dir after --init reads the edited body without --in', async (t) => {
  const { runDir } = await fixtureRun(t);
  assert.equal(await run(parseArgs(['--init', '--run-dir', runDir])), null);
  const bodyPath = path.join(runDir, 'phase3', 'manifest-body.json');
  const body = JSON.parse(await fs.readFile(bodyPath, 'utf8'));
  body.source_write = 'edited by the orchestrator';
  body.status = 'completed';
  await fs.writeFile(bodyPath, JSON.stringify(body));
  const manifest = await run(parseArgs(['--run-dir', runDir]));
  assert.equal(manifest.source_write, 'edited by the orchestrator', 'a hand-added value is kept');
  assert.equal(manifest.status, 'incomplete', 'the status is read from the run again (no findings.json), not from an older body');
});

test('--run-dir alone collects the packet, both phases, findings and every completed result.json; an explicit flag wins', async (t) => {
  const { dir, runDir } = await fixtureRun(t);
  const write = (file, text) => fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, text));
  await write(path.join(runDir, 'task-packet.md'), 'packet');
  for (const role of ['A', 'B']) {
    await write(path.join(runDir, 'phase1', 'original', `${role}-findings.md`), `## ${role}1\n`);
    await write(path.join(runDir, 'phase1', `${role}-findings.md`), `## ${role}1\nrebuttal appended\n`);
    await write(path.join(runDir, 'phase2', `peer-view-for-${role}.md`), '## P1\n');
  }
  await write(path.join(runDir, 'phase3', 'findings.json'), '{}');
  await write(path.join(runDir, 'phase3', 'verification-X1.md'), 'v');
  const results = await Promise.all(resultFixtures.map(async (url) => fs.readFile(url, 'utf8')));
  await write(path.join(runDir, 'phase1', 'B', 'result.json'), results[0]);
  await write(path.join(runDir, 'phase2', 'B', 'result.json'), results[1]);
  await write(path.join(runDir, 'phase2', 'B', 'result.attempt-1.json'), results[0]);
  const manifest = await run(parseArgs(['--run-dir', runDir]));
  assert.equal(manifest.status, 'completed', 'findings.json exists');
  assert.equal(manifest.falsification.verifiers_run, 1);
  assert.deepEqual(Object.keys(manifest.hashes).sort().slice(0, 4), ['findings_json', 'phase1', 'phase2', 'task_packet'].sort());
  assert.equal(Object.keys(manifest.hashes.phase1).length, 2);
  assert.equal(Object.keys(manifest.hashes.phase2).length, 2);
  const b = manifest.reviewers.find((r) => r.role === 'B');
  assert.equal(b.usage_per_call.length, 2, 'both completed B calls are summed; the attempt file is not');
  assert.ok(await fs.stat(path.join(runDir, 'manifest.json')), 'default output is <run-dir>/manifest.json');
  const explicit = await run(parseArgs(['--run-dir', runDir, '--out', path.join(dir, 'm2.json'), '--task-packet', path.join(runDir, 'phase1', 'A-findings.md')]));
  assert.equal(explicit.hashes.task_packet, sha256(Buffer.from('## A1\nrebuttal appended\n')), 'an explicit --task-packet is kept');
  assert.deepEqual(Object.keys(manifest.hashes.phase1).sort(), ['A-findings.md', 'B-findings.md'], 'the untouched originals are hashed, not the working files');
  assert.equal(manifest.hashes.phase1['A-findings.md'], sha256(Buffer.from('## A1\n')));
  assert.deepEqual(Object.keys(manifest.hashes.phase2).sort(), ['peer-view-for-A.md', 'peer-view-for-B.md']);
});

// CODEX_HOME and CLAUDE_CONFIG_DIR point at a temp folder, so no test reads this machine's real sessions.
async function commandHomes(t) {
  const dir = await tmpDir(t);
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = path.join(dir, 'codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const fixture = (name) => fileURLToPath(fixturePath('commands/' + name));
  const rollout = async (name, threadId) => {
    const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '08');
    await fs.mkdir(day, { recursive: true });
    await fs.copyFile(fixture(name), path.join(day, `rollout-2026-10-08T11-59-10-${threadId}.jsonl`));
  };
  const input = path.join(dir, 'body.json');
  await fs.writeFile(input, '{}');
  const build = (...flags) => run(parseArgs(['--in', input, '--out', path.join(dir, 'manifest.json'), ...flags]));
  return { dir, fixture, rollout, build, input };
}

test('commands: a Codex CLI seat counts its thread rollout once over phase 1 and 2; no rollout or no items leaves it unknown', async (t) => {
  const { dir, fixture, rollout, build } = await commandHomes(t);
  const result = JSON.parse(await fs.readFile(fixture('codex-seat-result.json'), 'utf8'));
  const p1 = path.join(dir, 'p1.json');
  const p2 = path.join(dir, 'p2.json');
  await fs.writeFile(p1, JSON.stringify(result));
  await fs.writeFile(p2, JSON.stringify(result));
  assert.ok(!('commands' in (await build('--reviewer-result', 'B=' + p1)).reviewers[0]), 'no rollout found: no count, never 0');
  await rollout('codex-sandbox-rollout.jsonl', result.threadId);
  const seat = (await build('--reviewer-result', 'B=' + p1, '--reviewer-result', 'B=' + p2)).reviewers[0];
  assert.deepEqual(seat.commands, { tried: 2, failed: 2, source: 'codex-rollout' }, 'run4 seat B: both commands refused by the sandbox, the shared thread counted once');
  const auditor = (await build('--reviewer-result', 'auditor=' + p1)).actors[0];
  assert.deepEqual(auditor.commands, { tried: 2, failed: 2, source: 'codex-rollout' }, 'a CLI auditor is counted the same way');
  const other = path.join(dir, 'other.json');
  await fs.writeFile(other, JSON.stringify({ ...result, threadId: '01a0e4ee-d854-74c2-a1b9-3f5c9cea44a3' }));
  await rollout('codex-child-no-items.jsonl', '01a0e4ee-d854-74c2-a1b9-3f5c9cea44a3');
  assert.ok(!('commands' in (await build('--reviewer-result', 'B=' + p1, '--reviewer-result', 'B=' + other)).reviewers[0]), 'one thread that cannot be counted makes the seat unknown');
  const noThread = path.join(dir, 'nothread.json');
  await fs.writeFile(noThread, JSON.stringify({ ...result, threadId: null }));
  assert.ok(!('commands' in (await build('--reviewer-result', 'B=' + noThread)).reviewers[0]));
});

test('commands: a Claude CLI seat counts its session transcript; a body value is kept; an OpenCode session is not counted', async (t) => {
  const { dir, fixture, build, input } = await commandHomes(t);
  const result = JSON.parse(await fs.readFile(fixture('claude-cli-result.json'), 'utf8'));
  const file = path.join(dir, 'result.json');
  await fs.writeFile(file, JSON.stringify(result));
  assert.ok(!('commands' in (await build('--reviewer-result', 'A=' + file)).reviewers[0]), 'no session transcript: unknown');
  const session = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'C--target', `${result.sessionId}.jsonl`);
  await fs.mkdir(path.dirname(session), { recursive: true });
  await fs.copyFile(fixture('claude-cli-session.jsonl'), session);
  assert.deepEqual((await build('--reviewer-result', 'A=' + file)).reviewers[0].commands, { tried: 2, failed: 0, source: 'claude-transcript' });
  await fs.writeFile(input, JSON.stringify({ reviewers: [{ role: 'A', commands: { tried: 9, failed: 0, source: 'hand' } }] }));
  assert.deepEqual((await build('--reviewer-result', 'A=' + file)).reviewers[0].commands, { tried: 9, failed: 0, source: 'hand' });
  await fs.writeFile(input, '{}');
  const opencode = path.join(dir, 'opencode.json');
  await fs.writeFile(opencode, JSON.stringify({ modelRequested: 'x', status: 'completed', sessionId: 'ses_abc', usageSemantics: 'per-call', usage: { input_tokens: 1 } }));
  assert.ok(!('commands' in (await build('--reviewer-result', 'B=' + opencode)).reviewers[0]));
});

test('commands: a native seat transcript records its Bash calls in seat_usage, inside the usage window', async (t) => {
  const { fixture, build } = await commandHomes(t);
  const file = fixture('claude-agent-transcript.jsonl');
  assert.deepEqual((await build('--seat-transcript', 'A=' + file)).seat_usage.A.commands, { tried: 2, failed: 1, source: 'transcript' });
  const windowed = (await build('--seat-transcript', 'auditor=' + file + '@2026-10-10T15:03:00Z/2026-10-10T15:05:00Z')).seat_usage.auditor;
  assert.deepEqual(windowed.commands, { tried: 1, failed: 0, source: 'transcript' }, 'the failed call at 15:10 is outside the window');
  const codex = (await build('--seat-transcript', 'A=' + fixture('codex-sandbox-rollout.jsonl'))).seat_usage.A;
  assert.deepEqual(codex.commands, { tried: 2, failed: 2, source: 'codex-rollout' }, 'a native Codex seat rollout');
  assert.ok(!('commands' in (await build('--seat-transcript', 'A=' + fixture('codex-child-no-items.jsonl'))).seat_usage.A), 'items missing: unknown');
});

test('initBody: a run whose exchange finished with an incomplete seat is incomplete, and the exchange record names the seat and the no-claims seats', async (t) => {
  const dir = await tmpDir(t);
  await fs.mkdir(path.join(dir, 'phase2'), { recursive: true });
  await fs.mkdir(path.join(dir, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), '{}');
  const descriptor = {
    skill: 'cross-review', flags: { falsification: false, mode: 'adversarial', auditDepth: 'light' },
    seatA: { provider: 'anthropic' }, seatB: { provider: 'openai' }, auditor: { provider: 'anthropic' },
  };
  // No exchange-result.json (a run that never recorded one): the old behavior, completed.
  assert.equal((await initBody(descriptor, dir)).status, 'completed');
  await fs.writeFile(path.join(dir, 'phase2', 'exchange-result.json'), JSON.stringify({ appended: ['B'], incomplete: [], no_peer_claims: ['A'] }));
  const clean = await initBody(descriptor, dir);
  assert.equal(clean.status, 'completed');
  assert.deepEqual(clean.exchange.no_peer_claims, ['A']);
  assert.equal(clean.exchange.incomplete_seats, undefined);
  await fs.writeFile(path.join(dir, 'phase2', 'exchange-result.json'), JSON.stringify({ appended: ['B'], incomplete: ['A'], no_peer_claims: [] }));
  const lost = await initBody(descriptor, dir);
  assert.equal(lost.status, 'incomplete');
  assert.deepEqual(lost.exchange.incomplete_seats, ['A']);
  assert.match(lost.exchange.reason, /seat A/);
});

test('falsification completeness is decided by claim: a verification file for another claim leaves the status incomplete, the right one completes it', async (t) => {
  const dir = await tmpDir(t);
  const breakdown = path.join(dir, 'breakdown.json');
  await fs.writeFile(breakdown, JSON.stringify({ falsificationBreakdown: { high_or_critical: 2, disputed: 1, conceded: 1, unaddressed: 0, disputed_ids: ['Y2'] } }));
  const body = path.join(dir, 'body.json');
  await fs.writeFile(body, JSON.stringify({ falsification: { requested: true, verifiers_run: 1 } }));
  const build = async (name) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, 'v');
    return run(parseArgs(['--in', body, '--out', path.join(dir, 'm.json'), '--falsification', breakdown, '--verification', file]));
  };
  const wrong = await build('verification-X1.md');
  assert.equal(wrong.status, 'incomplete');
  assert.deepEqual(wrong.falsification.disputed_ids, ['Y2']);
  assert.ok(wrong.warnings.some((w) => /no verification file names Y2/.test(w)), wrong.warnings.join(' | '));
  const right = await build('verification-Y2.md');
  assert.notEqual(right.status, 'incomplete');
});
