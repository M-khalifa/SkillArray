import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, buildHashes, run, sha256, RelayError } from '../build-manifest.mjs';

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
    total_input_tokens: 2322, max_context_tokens: 1312, models: { 'claude-opus-5-5': 2, 'claude-sonnet-5-5': 1 }, active_ms: null, unparsed_lines: 1, duration_ms: null,
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