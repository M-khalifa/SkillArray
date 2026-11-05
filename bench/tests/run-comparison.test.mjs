// Provider-independent tests for ../run-comparison.mjs, exercised against
// bench/adapters/fake.mjs -- no network, no spawned process, no provider
// credentials. Run: node --test bench/tests/run-comparison.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, parseArgs, validateArmResult, RunComparisonError, KNOWN_ARMS, aggregateArms } from '../run-comparison.mjs';
import { makeFakeAdapter } from '../adapters/fake.mjs';

const CASE_DIR = fileURLToPath(new URL('../cases/fixture-trivial-defect', import.meta.url));

async function withTmpOut(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'run-comparison-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const COMPLETED_EMPTY = { status: 'completed', findings: [], usage: { source: 'unavailable' }, artifacts: [], deviations: [] };

test('parseArgs: requires --case, --out, and a valid --adapter', () => {
  assert.throws(() => parseArgs(['--out', 'x', '--adapter', 'fake']), /--case/);
  assert.throws(() => parseArgs(['--case', 'x', '--adapter', 'fake']), /--out/);
  assert.throws(() => parseArgs(['--case', 'x', '--out', 'y']), /--adapter/);
  assert.throws(() => parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'bogus']), /must be "fake" or "live"/);
});

test('parseArgs: --arms rejects an unknown arm name', () => {
  assert.throws(
    () => parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'fake', '--arms', 'not-a-real-arm']),
    /unknown arm/
  );
});

test('parseArgs: --trials must be a positive integer', () => {
  assert.throws(() => parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'fake', '--trials', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'fake', '--trials', '-1']), /positive integer/);
  assert.equal(parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'fake', '--trials', '3']).trials, 3);
});

test('parseArgs: defaults to all four known arms and 1 trial', () => {
  const args = parseArgs(['--case', 'x', '--out', 'y', '--adapter', 'fake']);
  assert.deepEqual(args.arms, KNOWN_ARMS);
  assert.equal(args.trials, 1);
});

test('run(): case loading fails closed on a missing case.json/ground-truth.json', async (t) => {
  const out = await withTmpOut(t);
  const args = { case: path.join(tmpdir(), 'does-not-exist'), out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  await assert.rejects(() => run(args, { runArm: makeFakeAdapter({}) }), RunComparisonError);
});

test('run(): a completed arm writes result.json and score.json under trial-N/<arm>/', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({ 'claude-alone': COMPLETED_EMPTY });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });

  const resultPath = path.join(out, 'trial-1', 'claude-alone', 'result.json');
  const scorePath = path.join(out, 'trial-1', 'claude-alone', 'score.json');
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  const score = JSON.parse(await readFile(scorePath, 'utf8'));
  assert.equal(result.status, 'completed');
  assert.equal(score.counts.total_defects, 1, 'ground-truth.json\'s one fixture defect must reach scoreRun');
  assert.equal(summary.trials.length, 1);
  assert.equal(summary.trials[0].arms[0].arm, 'claude-alone');
});

test('run(): --trials N repeats every arm N times in trial-major order (all arms trial 1, then all arms trial 2)', async (t) => {
  const out = await withTmpOut(t);
  const order = [];
  const runArm = makeFakeAdapter({
    'claude-alone': (packet, trialIndex) => { order.push(`claude-alone:${trialIndex}`); return COMPLETED_EMPTY; },
    'codex-alone': (packet, trialIndex) => { order.push(`codex-alone:${trialIndex}`); return COMPLETED_EMPTY; },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone', 'codex-alone'], trials: 2 };
  await run(args, { runArm });
  assert.deepEqual(order, ['claude-alone:0', 'codex-alone:0', 'claude-alone:1', 'codex-alone:1']);
});

test('run(): a failed arm is recorded with status "failed" and no findings/score, never a fabricated result', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({
    'claude-alone': { status: 'failed', findings: null, error: 'fixture: dispatch refused', usage: { source: 'unavailable' }, artifacts: [], deviations: [] },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  assert.equal(summary.trials[0].arms[0].status, 'failed');
  assert.equal(summary.trials[0].arms[0].score, null);
  const result = JSON.parse(await readFile(path.join(out, 'trial-1', 'claude-alone', 'result.json'), 'utf8'));
  assert.equal(result.findings, null);
});

test('run(): a timed_out arm is recorded distinctly from failed', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({
    'claude-alone': { status: 'timed_out', findings: null, error: 'fixture: exceeded timeout', usage: { source: 'unavailable' }, artifacts: [], deviations: [] },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  assert.equal(summary.trials[0].arms[0].status, 'timed_out');
});

test('validateArmResult: rejects an unknown status string rather than passing it through', () => {
  assert.throws(() => validateArmResult({ status: 'done' }, 'claude-alone'), /unknown status/);
});

test('validateArmResult: a "completed" status with non-array findings is rejected -- the malformed-result case', () => {
  assert.throws(
    () => validateArmResult({ status: 'completed', findings: 'not-an-array' }, 'claude-alone'),
    /findings is not an array/
  );
});

test('validateArmResult: a non-"completed" status carrying findings is rejected -- a failed arm must not also report findings', () => {
  assert.throws(
    () => validateArmResult({ status: 'failed', findings: [] }, 'claude-alone'),
    /must not report findings/
  );
});

test('run(): an adapter that throws for an arm is caught and recorded as status "malformed", never crashes the whole run', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({
    'claude-alone': new Error('fixture: adapter internal error'),
    'codex-alone': COMPLETED_EMPTY,
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone', 'codex-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  assert.equal(summary.trials[0].arms[0].status, 'malformed');
  assert.equal(summary.trials[0].arms[1].status, 'completed', 'one arm\'s crash must not prevent a later arm in the same trial from running');
});

test('run(): an adapter returning malformed JSON-shaped garbage (not an Error, not a valid ArmResult) is caught as "malformed"', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({ 'claude-alone': 'just a string, not an ArmResult object' });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  assert.equal(summary.trials[0].arms[0].status, 'malformed');
});

test('run(): a completed arm with a real (non-empty) finding scores a true positive against ground truth', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({
    'claude-alone': {
      status: 'completed',
      findings: [{ id: 'F1', severity: 'LOW', evidence: ['fixture-defect-marker found in src/x.py'] }],
      usage: { source: 'unavailable' },
      artifacts: [],
      deviations: [],
    },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  await run(args, { runArm });
  const score = JSON.parse(await readFile(path.join(out, 'trial-1', 'claude-alone', 'score.json'), 'utf8'));
  assert.equal(score.counts.true_positives, 1, 'the fixture ground-truth defect D1 must be matched by its substring hint');
  assert.equal(score.recall, 1);
});

test('run(): every arm in every trial receives the SAME packet object (fairness invariance -- one task packet per case, no arm-specific field)', async (t) => {
  const out = await withTmpOut(t);
  const seenPackets = [];
  const runArm = makeFakeAdapter({
    'claude-alone': (packet) => { seenPackets.push(packet); return COMPLETED_EMPTY; },
    'codex-alone': (packet) => { seenPackets.push(packet); return COMPLETED_EMPTY; },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone', 'codex-alone'], trials: 2 };
  await run(args, { runArm });
  assert.equal(seenPackets.length, 4);
  assert.ok(seenPackets.every((p) => p === seenPackets[0]), 'the exact same packet object must reach every arm/trial');
  assert.equal(seenPackets[0].arm, undefined, 'packet must not carry an arm-specific field');
});

test('run(): a completed arm\'s usage and deviations reach summary.json, not just result.json', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({
    'claude-alone': {
      status: 'completed',
      findings: [],
      usage: { source: 'provider', input_tokens: 100, raw: {} },
      artifacts: [],
      deviations: ['fixture: arm-specific deviation'],
    },
  });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  const outcome = summary.trials[0].arms[0];
  assert.equal(outcome.usage.source, 'provider');
  assert.equal(outcome.usage.input_tokens, 100);
  assert.deepEqual(outcome.deviations, ['fixture: arm-specific deviation']);
});

test('run(): a malformed/thrown arm still reports usage:{source:"unavailable"} and deviations:[] in summary.json', async (t) => {
  const out = await withTmpOut(t);
  const runArm = makeFakeAdapter({ 'claude-alone': new Error('fixture: adapter internal error') });
  const args = { case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 1 };
  const summary = await run(args, { runArm });
  const outcome = summary.trials[0].arms[0];
  assert.deepEqual(outcome.usage, { source: 'unavailable' });
  assert.deepEqual(outcome.deviations, []);
});

test('makeFakeAdapter: throws a clear error for an arm with no script entry, rather than silently defaulting', async () => {
  const runArm = makeFakeAdapter({ 'claude-alone': COMPLETED_EMPTY });
  await assert.rejects(
    () => runArm({ arm: 'codex-alone', caseDir: CASE_DIR, packet: {}, runDir: '/tmp/x', config: {}, trialIndex: 0 }),
    /no script entry for arm "codex-alone"/
  );
});

test('aggregateArms: score mean and spread over completed runs, p50/p95 wall time over all runs, new tokens when metered', () => {
  const arm = (status, recall, ms, usage = { source: 'unavailable' }) => ({ arm: 'skillarray', status, score: status === 'completed' ? { recall, precision: 1, f1: recall } : null, duration_ms: ms, usage });
  const trials = [
    { trial: 1, arms: [arm('completed', 0.5, 1000, { source: 'provider', input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 5 })] },
    { trial: 2, arms: [arm('completed', 1, 3000, { source: 'provider', input_tokens: 30, output_tokens: 10 })] },
    { trial: 3, arms: [arm('failed', null, 2000)] },
  ];
  const a = aggregateArms(trials).skillarray;
  assert.equal(a.runs, 3);
  assert.equal(a.completed, 2);
  assert.equal(a.recall.mean, 0.75);
  assert.equal(Number(a.recall.stddev.toFixed(4)), 0.3536);
  assert.deepEqual(a.duration_ms, { p50: 2000, p95: 3000 });
  assert.deepEqual(a.new_tokens, { mean: 30, stddev: Number(a.new_tokens.stddev), n: 2, metered_runs: 2 });
  assert.equal(Number(a.new_tokens.stddev.toFixed(4)), 14.1421);
  const one = aggregateArms([{ trial: 1, arms: [arm('timed_out', null, 5)] }]).skillarray;
  assert.deepEqual([one.recall.mean, one.recall.stddev, one.new_tokens.metered_runs], [null, null, 0]);
});

test('aggregateArms: new tokens of a cache-inclusive (Codex) record are input minus cached input plus output', () => {
  const one = (usage) => aggregateArms([{ trial: 1, arms: [{ arm: 'codex-alone', status: 'completed', score: { recall: 1, precision: 1, f1: 1 }, duration_ms: 1, usage }] }])['codex-alone'].new_tokens;
  assert.equal(one({ source: 'provider', input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }).mean, 30);
  assert.equal(one({ source: 'provider', input_tokens: 100000, cached_input_tokens: 90000, cache_write_input_tokens: 0, output_tokens: 2000 }).mean, 12000);
  assert.deepEqual(one({ source: 'provider', input_tokens: 10, cached_input_tokens: 80, output_tokens: 10 }), { mean: null, stddev: null, n: 0, metered_runs: 0 }, 'more cached than input is not this shape');
});

test('aggregateArms: new tokens of a separate-cache (Claude) record are input plus the cache write plus output; the cache read is not counted', () => {
  const one = (usage) => aggregateArms([{ trial: 1, arms: [{ arm: 'claude-alone', status: 'completed', score: { recall: 1, precision: 1, f1: 1 }, duration_ms: 1, usage }] }])['claude-alone'].new_tokens.mean;
  assert.equal(one({ source: 'provider', input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 5 }), 20);
  assert.equal(one({ source: 'provider', input_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: 900, output_tokens: 5 }), 15);
  assert.equal(one({ source: 'provider', input_tokens: 10, cache_write_input_tokens: 7, output_tokens: 5 }), 22);
});

test('run(): the summary carries a per-arm aggregate and each arm run its wall time', async (t) => {
  const out = await withTmpOut(t);
  const summary = await run({ case: CASE_DIR, out, adapter: 'fake', arms: ['claude-alone'], trials: 2 }, { runArm: makeFakeAdapter({ 'claude-alone': COMPLETED_EMPTY }) });
  assert.ok(Number.isFinite(summary.trials[0].arms[0].duration_ms));
  assert.equal(summary.aggregate['claude-alone'].runs, 2);
  assert.equal(summary.aggregate['claude-alone'].completed, 2);
});
