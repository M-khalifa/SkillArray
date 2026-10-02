import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, RelayError } from '../exchange.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'exchange.mjs');
const TOKENS = 'model-alpha,model-beta';

function claim(id, extra = '') {
  return `## ${id} — claim ${id}\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n\`\`\`text\nran it${extra}\n\`\`\`\n\n`;
}

const A_TEXT = `# Seat A findings\n\n${claim('A1')}${claim('A2')}`;
const B_TEXT = `# Seat B findings\n\n${claim('B1')}`;
const RAW_FOR_TWO = '### P1\nClaim: P1\nAction: CONCEDE\n\n### P2\nClaim: P2\nAction: DISPUTE\nCounter-fact: not reproduced\n';
const RAW_FOR_ONE = '### P1\nClaim: P1\nAction: CONCEDE\n';

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

async function setup(t, { a = A_TEXT, b = B_TEXT } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exchange-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'run');
  const target = path.join(root, 'target');
  await fs.mkdir(path.join(runDir, 'phase1'), { recursive: true });
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'main.py'), 'print("hello")\n');
  await fs.writeFile(path.join(runDir, 'phase1', 'A-findings.md'), a);
  await fs.writeFile(path.join(runDir, 'phase1', 'B-findings.md'), b);
  const p = (...parts) => path.join(runDir, ...parts);
  return { runDir, target, p };
}

const prepareArgs = (s, ...extra) => ['prepare', '--run-dir', s.runDir, '--target-dir', s.target, '--tokens', TOKENS, ...extra];
const finishArgs = (s, ...extra) => ['finish', '--run-dir', s.runDir, '--target-dir', s.target, ...extra];

test('parseArgs: prepare needs --tokens, --incomplete-seats takes one seat and never both, and flags of the other command are refused', () => {
  assert.throws(() => parseArgs(['prepare', '--run-dir', 'r', '--target-dir', 't']), /requires --tokens/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'r', '--target-dir', 't', '--incomplete-seats', 'A', '--incomplete-seats', 'B']), /cannot name both seats/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'r', '--target-dir', 't', '--incomplete-seats', 'X']), /must be A or B/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'r', '--target-dir', 't', '--tokens', TOKENS]), (e) => e instanceof RelayError && /unrecognized argument for finish: --tokens/.test(e.message));
  assert.throws(() => parseArgs(['prepare', '--run-dir', 'r', '--target-dir', 't', '--tokens', TOKENS, '--incomplete-seats', 'A']), /unrecognized argument for prepare/);
  assert.throws(() => parseArgs(['swap']), /first argument must be prepare or finish/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'r', '--target-dir', 't', '--tokens', TOKENS]), /unrecognized argument for finish: --tokens \(only prepare takes it\)/);
  assert.throws(() => parseArgs(['prepare', '--run-dir', 'r', '--target-dir', 't', '--tokens', TOKENS, '--source-dir', 's1', 's2']), /unrecognized argument for prepare: s2 \(--source-dir takes one value; repeat the flag for each/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'C:\\tmp\\$RUN', '--target-dir', 't']), /--run-dir "C:\\tmp\\\$RUN" contains "\$RUN", a shell variable that was never expanded/);
  assert.throws(() => parseArgs(['finish', '--run-dir', 'r', '--target-dir', 't', '--source-dir', '%REPO%']), /--source-dir "%REPO%" contains "%REPO%"/);
  const a = parseArgs(['prepare', '--run-dir', 'r', '--target-dir', 't', '--tokens', TOKENS, '--source-dir', 's1', '--source-dir', 's2', '--checklist', 'CHK']);
  assert.deepEqual([a.sourceDirs, a.checklists, a.seatBHarness], [['s1', 's2'], ['CHK'], false]);
});

test('prepare: writes original/ copies, both peer views and both briefs; seat A writes its own file and a dispatched seat B gets no output path', async (t) => {
  const s = await setup(t);
  const r = run(prepareArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await fs.readFile(s.p('phase1', 'original', 'A-findings.md'), 'utf8'), A_TEXT);
  assert.equal(await fs.readFile(s.p('phase1', 'original', 'B-findings.md'), 'utf8'), B_TEXT);
  assert.match(await fs.readFile(s.p('phase2', 'peer-view-for-B.md'), 'utf8'), /^## P2 — claim P2$/m);
  assert.doesNotMatch(await fs.readFile(s.p('phase2', 'peer-view-for-B.md'), 'utf8'), /\bA1\b/);
  assert.match(await fs.readFile(s.p('phase2', 'peer-view-for-A.md'), 'utf8'), /^## P1 — claim P1$/m);
  const briefA = await fs.readFile(s.p('phase2', 'delta-brief-A.txt'), 'utf8');
  assert.ok(briefA.includes(s.p('phase2', 'A-rebuttals-raw.md')), 'seat A is told where to write');
  const briefB = await fs.readFile(s.p('phase2', 'B', 'delta-brief.txt'), 'utf8');
  assert.ok(!briefB.includes('B-rebuttals-raw.md'), 'a dispatched seat B returns its text instead');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { briefs: { A: s.p('phase2', 'delta-brief-A.txt'), B: s.p('phase2', 'B', 'delta-brief.txt') }, rebuttals: { A: s.p('phase2', 'A-rebuttals-raw.md'), B: null }, skipped: {} });
});

test('prepare --seat-b-harness: seat B gets phase2/delta-brief-B.txt naming phase2/B-rebuttals-raw.md', async (t) => {
  const s = await setup(t);
  const r = run(prepareArgs(s, '--seat-b-harness'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await fs.readFile(s.p('phase2', 'delta-brief-B.txt'), 'utf8')).includes(s.p('phase2', 'B-rebuttals-raw.md')));
  await assert.rejects(fs.access(s.p('phase2', 'B')));
});

test('prepare: a validate failure writes nothing, neither original/ nor phase2/', async (t) => {
  const s = await setup(t, { b: '# Seat B findings\n\n## B1 — no fields\nprose only\n' });
  const r = run(prepareArgs(s));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /validate failed/);
  await assert.rejects(fs.access(s.p('phase1', 'original')));
  await assert.rejects(fs.access(s.p('phase2')));
});

test('prepare: a scan hit deletes that direction\'s peer view, builds no brief, names the seat and says the other file was clean; the rerun after redaction replaces original/', async (t) => {
  const leaky = `# Seat B findings\n\n${claim('B1')}The model-beta reviewer checked this.\n`;
  const s = await setup(t, { b: leaky });
  const r = run(prepareArgs(s));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Return to seat B \(scan hit; peer-view-for-A\.md deleted\)/);
  assert.match(r.stderr, /seat A's file was clean/);
  await assert.rejects(fs.access(s.p('phase2', 'peer-view-for-A.md')));
  await fs.access(s.p('phase2', 'peer-view-for-B.md'));
  await assert.rejects(fs.access(s.p('phase2', 'delta-brief-A.txt')));
  await assert.rejects(fs.access(s.p('phase2', 'B', 'delta-brief.txt')));
  assert.equal(await fs.readFile(s.p('phase1', 'original', 'B-findings.md'), 'utf8'), leaky);
  await fs.writeFile(s.p('phase1', 'B-findings.md'), B_TEXT);
  const again = run(prepareArgs(s));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await fs.readFile(s.p('phase1', 'original', 'B-findings.md'), 'utf8'), B_TEXT);
});

test('prepare: refuses once the exchange started (a brief, a rebuttal file, or a rebuttal section) and leaves original/ untouched', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  const again = run(prepareArgs(s));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /delta-brief-A\.txt exists, so the exchange was already prepared/);

  const s2 = await setup(t);
  await fs.mkdir(s2.p('phase2'));
  await fs.writeFile(s2.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  assert.match(run(prepareArgs(s2)).stderr, /B-rebuttals-raw\.md exists/);

  const s3 = await setup(t);
  await fs.mkdir(s3.p('phase1', 'original'));
  await fs.writeFile(s3.p('phase1', 'original', 'A-findings.md'), A_TEXT);
  await fs.writeFile(s3.p('phase1', 'A-findings.md'), `${A_TEXT}\n## Rebuttals (from B) of A claims\n\n### A1\nClaim: A1\nAction: CONCEDE\n`);
  const r3 = run(prepareArgs(s3));
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /already has a rebuttal section, so the exchange happened/);
  assert.equal(await fs.readFile(s3.p('phase1', 'original', 'A-findings.md'), 'utf8'), A_TEXT, 'original/ keeps the pre-exchange copy');
});

test('finish: appends both seats\' rebuttals onto the peer files and validates', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  const a = await fs.readFile(s.p('phase1', 'A-findings.md'), 'utf8');
  const b = await fs.readFile(s.p('phase1', 'B-findings.md'), 'utf8');
  assert.ok(a.startsWith(A_TEXT) && /## Rebuttals \(from B\) of A claims\n\n### A1\n[\s\S]*### A2\n/.test(a));
  assert.ok(b.startsWith(B_TEXT) && /## Rebuttals \(from A\) of B claims\n\n### B1\n/.test(b));
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: 2, dispute: 1 });
  assert.doesNotMatch(r.stderr, /WARNING: all/);
  const again = run(finishArgs(s));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has a rebuttal section; restore both phase1\/\*-findings\.md from phase1\/original\//);
});

test('finish: when seat B\'s rebuttals are refused after seat A\'s were appended, both findings files are restored byte-identical', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_ONE);
  const r = run(finishArgs(s));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no rebuttal entry for peer-view claim\(s\) \[P2\]/);
  assert.match(r.stderr, /refused seat B's rebuttals; both findings files were restored/);
  assert.equal(await fs.readFile(s.p('phase1', 'A-findings.md'), 'utf8'), A_TEXT);
  assert.equal(await fs.readFile(s.p('phase1', 'B-findings.md'), 'utf8'), B_TEXT);
});

test('finish --incomplete-seats A: appends only seat B\'s rebuttals, leaves B-findings.md untouched; without the flag a missing file is refused with the hint', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const refused = run(finishArgs(s));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /A-rebuttals-raw\.md does not exist; wait for seat A, or pass --incomplete-seats A/);
  const r = run(finishArgs(s, '--incomplete-seats', 'A'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await fs.readFile(s.p('phase1', 'B-findings.md'), 'utf8'), B_TEXT);
  assert.match(await fs.readFile(s.p('phase1', 'A-findings.md'), 'utf8'), /## Rebuttals \(from B\) of A claims/);
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['B'], incomplete: ['A'], no_peer_claims: [], concede: 1, dispute: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(s.p('phase2', 'exchange-result.json'), 'utf8')), JSON.parse(r.stdout),
    'finish records its result for audit-prep, which accepts the missing rebuttals of a seat recorded as incomplete');
});

test('finish: a refused finish writes no exchange-result.json, so audit-prep cannot stage the restored files as if the exchange had happened', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_ONE);
  assert.equal(run(finishArgs(s)).status, 1);
  await assert.rejects(fs.access(s.p('phase2', 'exchange-result.json')));
});

test('finish: when every rebuttal conceded, it warns that a light audit re-checks none of them', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), '### P1\nClaim: P1\nAction: CONCEDE\n\n### P2\nClaim: P2\nAction: CONCEDE\n');
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: all 3 rebuttals conceded and none disputed; a light audit would re-check none of these findings, so use --audit-depth full \(nothing to do if it is already full\)/);
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: 3, dispute: 0 });
});

test('a seat whose peer wrote "## No findings" gets no brief from prepare, and finish records it under no_peer_claims, not incomplete', async (t) => {
  const s = await setup(t, { b: '# Seat B findings\n\n## No findings\n\n## Checks performed\n\n- read everything\n' });
  const r = run(prepareArgs(s));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, { A: 'seat B has no findings' });
  assert.deepEqual(out.briefs, { A: null, B: s.p('phase2', 'B', 'delta-brief.txt') });
  assert.deepEqual(out.rebuttals, { A: null, B: null });
  await assert.rejects(fs.access(s.p('phase2', 'delta-brief-A.txt')), 'seat A is not sent an empty brief');
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const f = run(finishArgs(s));
  assert.equal(f.status, 0, f.stderr);
  assert.deepEqual(JSON.parse(f.stdout), { appended: ['B'], incomplete: [], no_peer_claims: ['A'], concede: 1, dispute: 1 });
  assert.match(await fs.readFile(s.p('phase1', 'A-findings.md'), 'utf8'), /## Rebuttals \(from B\) of A claims/);
});
