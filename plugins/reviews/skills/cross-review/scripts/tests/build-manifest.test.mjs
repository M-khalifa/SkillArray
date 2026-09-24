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
