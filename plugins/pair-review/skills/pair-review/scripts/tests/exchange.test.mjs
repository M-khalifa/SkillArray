import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('prepare: writes original/ copies, both peer views and both briefs; seat A writes its own file and a dispatched seat B gets no output path [slow]', async (t) => {
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

test('prepare --seat-b-harness: seat B gets phase2/delta-brief-B.txt naming phase2/B-rebuttals-raw.md [slow]', async (t) => {
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

test('prepare: a scan hit deletes that direction\'s peer view, builds no brief, names the seat and says the other file was clean; the rerun after redaction replaces original/ [slow]', async (t) => {
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

test('prepare: refuses once the exchange started (a brief, a rebuttal file, or a rebuttal section) and leaves original/ untouched [slow]', async (t) => {
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

test('finish: appends both seats\' rebuttals onto the peer files and validates [slow]', async (t) => {
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

test('finish: when seat B\'s rebuttals are refused after seat A\'s were appended, both findings files are restored byte-identical [slow]', async (t) => {
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

test('finish --incomplete-seats A: appends only seat B\'s rebuttals, leaves B-findings.md untouched; without the flag a missing file is refused with the hint [slow]', async (t) => {
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

test('finish: a refused finish writes no exchange-result.json, so audit-prep cannot stage the restored files as if the exchange had happened [slow]', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_ONE);
  assert.equal(run(finishArgs(s)).status, 1);
  await assert.rejects(fs.access(s.p('phase2', 'exchange-result.json')));
});

test('finish: when every rebuttal conceded, it warns that a light audit re-checks none of them [slow]', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), '### P1\nClaim: P1\nAction: CONCEDE\n\n### P2\nClaim: P2\nAction: CONCEDE\n');
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: all 3 rebuttals conceded and none disputed; a light audit would re-check none of these findings \(3 HIGH or CRITICAL\), so use --audit-depth full \(nothing to do if it is already full\)/);
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: 3, dispute: 0 });
});

test('finish: when every conceded claim is MEDIUM or LOW, it prints a note instead of the full-audit warnings; one conceded HIGH keeps them [slow]', async (t) => {
  const medium = (id) => claim(id).replace('Severity: HIGH', 'Severity: MEDIUM');
  const three = (letter, sev) => `# Seat ${letter} findings\n\n${sev(`${letter}1`)}${sev(`${letter}2`)}${claim(`${letter}3`).replace('Severity: HIGH', 'Severity: LOW')}`;
  const all = ['CONCEDE', 'CONCEDE', 'CONCEDE'];
  const s = await setup(t, { a: three('A', medium), b: three('B', medium) });
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), rawReply(all));
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), rawReply(all));
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.match(r.stderr, /exchange: note: all 6 rebuttals conceded, none of them HIGH or CRITICAL; a light audit does not re-check them/);

  const h = await setup(t, { a: three('A', medium), b: three('B', claim) });
  assert.equal(run(prepareArgs(h)).status, 0);
  await fs.writeFile(h.p('phase2', 'A-rebuttals-raw.md'), rawReply(all));
  await fs.writeFile(h.p('phase2', 'B-rebuttals-raw.md'), rawReply(all));
  const rh = run(finishArgs(h));
  assert.equal(rh.status, 0, rh.stderr);
  assert.match(rh.stderr, /WARNING: all 6 rebuttals conceded and none disputed; a light audit would re-check none of these findings \(2 HIGH or CRITICAL\)/);
  assert.deepEqual([...rh.stderr.matchAll(ONE_SEAT)].map((m) => m[1]), ['A'], 'only seat A conceded HIGH claims (seat B\'s HIGH ones)');
  assert.doesNotMatch(rh.stderr, /exchange: note:/);

  // A HIGH claim whose evidence quotes a "## P1" heading with a lower severity stays HIGH.
  const fenced = (id) => claim(id, `\n## P1 — quoted\nSeverity: LOW`);
  const f = await setup(t, { a: three('A', medium), b: `# Seat B findings\n\n${fenced('B1')}` });
  assert.equal(run(prepareArgs(f)).status, 0);
  await fs.writeFile(f.p('phase2', 'A-rebuttals-raw.md'), rawReply(['CONCEDE']));
  await fs.writeFile(f.p('phase2', 'B-rebuttals-raw.md'), rawReply(all));
  const rf = run(finishArgs(f));
  assert.equal(rf.status, 0, rf.stderr);
  assert.match(rf.stderr, /\(1 HIGH or CRITICAL\)/);

  // A conceded block with only the "### P<n>" heading and no Claim: line still counts.
  const n = await setup(t, { a: three('A', medium), b: three('B', claim) });
  assert.equal(run(prepareArgs(n)).status, 0);
  await fs.writeFile(n.p('phase2', 'A-rebuttals-raw.md'), '### P1\nAction: CONCEDE\n\n### P2\nAction: CONCEDE\n\n### P3\nAction: CONCEDE\n');
  await fs.writeFile(n.p('phase2', 'B-rebuttals-raw.md'), rawReply(all));
  const rn = run(finishArgs(n));
  assert.equal(rn.status, 0, rn.stderr);
  assert.match(rn.stderr, /\(2 HIGH or CRITICAL\)/);
});

test('finish: an Action or ### line quoted inside an evidence fence is not counted as a rebuttal [slow]', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  const fence = '`'.repeat(3);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), `### P1\nClaim: P1\nAction: CONCEDE\nEvidence:\n${fence}text\n### P9\nAction: DISPUTE\n${fence}\n\n### P2\nClaim: P2\nAction: CONCEDE\n`);
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: 3, dispute: 0 });
  assert.match(r.stderr, /all 3 rebuttals conceded and none disputed; a light audit would re-check none of these findings \(3 HIGH or CRITICAL\)/);
});

test('prepare: a rebuttal heading quoted inside a claim\'s evidence fence is not an exchange that already happened [slow]', async (t) => {
  const s = await setup(t, { a: `# Seat A findings\n\n${claim('A1', '\n## Rebuttals (from B) of A claims')}${claim('A2')}` });
  const r = run(prepareArgs(s));
  assert.equal(r.status, 0, r.stderr);
});

function rawReply(actions) {
  return actions.map((act, i) => `### P${i + 1}\nClaim: P${i + 1}\nAction: ${act}\n${act === 'DISPUTE' ? 'Counter-fact: not reproduced\n' : ''}\n`).join('');
}

async function finishWith(t, actionsA, actionsB) {
  const three = (letter) => `# Seat ${letter} findings\n\n${claim(`${letter}1`)}${claim(`${letter}2`)}${claim(`${letter}3`)}`;
  const s = await setup(t, { a: three('A'), b: three('B') });
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), rawReply(actionsA));
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), rawReply(actionsB));
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  return r;
}

const ONE_SEAT = /exchange: WARNING: seat ([AB]) conceded all (\d+) peer claims; the exchange added little for that side: consider --audit-depth full/g;

test('finish: a seat that conceded all of at least 3 peer claims gets its own warning, the other seat does not [slow]', async (t) => {
  const r = await finishWith(t, ['CONCEDE', 'DISPUTE', 'CONCEDE'], ['CONCEDE', 'CONCEDE', 'CONCEDE']);
  assert.deepEqual([...r.stderr.matchAll(ONE_SEAT)].map((m) => [m[1], m[2]]), [['B', '3']]);
  assert.doesNotMatch(r.stderr, /rebuttals conceded and none disputed/);
  assert.deepEqual(JSON.parse(r.stdout), { appended: ['A', 'B'], incomplete: [], no_peer_claims: [], concede: 5, dispute: 1 });
});

test('finish: fewer than 3 conceded peer claims, or mixed actions, give no one-seat warning; both seats conceding everything keeps the existing warning too [slow]', async (t) => {
  const few = await finishDefault(t, ['DISPUTE'], ['CONCEDE', 'CONCEDE']);
  assert.doesNotMatch(few.stderr, /conceded all/);
  const mixed = await finishWith(t, ['DISPUTE', 'CONCEDE', 'CONCEDE'], ['CONCEDE', 'CONCEDE', 'DISPUTE']);
  assert.doesNotMatch(mixed.stderr, /conceded all/);
  const both = await finishWith(t, ['CONCEDE', 'CONCEDE', 'CONCEDE'], ['CONCEDE', 'CONCEDE', 'CONCEDE']);
  assert.match(both.stderr, /WARNING: all 6 rebuttals conceded and none disputed/);
  assert.deepEqual([...both.stderr.matchAll(ONE_SEAT)].map((m) => m[1]), ['A', 'B']);
});

async function finishDefault(t, actionsA, actionsB) {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), rawReply(actionsA));
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), rawReply(actionsB));
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('a seat whose peer wrote "## No findings" gets no brief from prepare, and finish records it under no_peer_claims, not incomplete [slow]', async (t) => {
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

function descriptorSeat(s, role, extra = {}) {
  return {
    role, provider: 'anthropic', runtime: 'claude', model: `descriptor-model-${role}`, effort: null, transport: 'cli', sessionId: null,
    outputDir: s.p('phase1', `seat-${role}`), resultPath: null, worktreePath: null, ...extra,
  };
}

async function writeDescriptor(s, seatA, seatB, skill = 'cross-review') {
  const data = {
    skill, skillDir: path.join(path.dirname(s.runDir), 'skill'), targetDir: s.target, host: 'descriptor-host-name',
    flags: { auditDepth: 'light', falsification: false, mode: 'adversarial' }, fingerprint: null,
    seatA, seatB, auditor: descriptorSeat(s, 'auditor', { outputDir: s.p('phase3'), transport: 'native' }), verifiers: [],
  };
  await fs.writeFile(s.p('run.json'), JSON.stringify(data, null, 2));
}

const codexSeatB = (s) => descriptorSeat(s, 'B', { provider: 'openai', runtime: 'codex', model: 'descriptor-model-codex' });
const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('--seat-b-harness is an alias: seat B writes the canonical file, finish leaves its bytes untouched and publishes nothing [slow]', async (t) => {
  const s = await setup(t);
  assert.equal(run(prepareArgs(s, '--seat-b-harness')).status, 0);
  const rawB = Buffer.from(`${RAW_FOR_TWO.replace(/\n/g, '\r\n')}\r\n`);
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), rawB);
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await fs.readFile(s.p('phase2', 'B-rebuttals-raw.md')), rawB);
  assert.equal(JSON.parse(r.stdout).published, undefined);
});

test('run.json: a CLI file seat writes its private folder, a final-message seat gets no output path, and no peer metadata reaches a brief [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A'), codexSeatB(s));
  const r = run(prepareArgs(s));
  assert.equal(r.status, 0, r.stderr);
  const privateA = s.p('phase2', 'seat-A', 'A-rebuttals-raw.md');
  assert.deepEqual(JSON.parse(r.stdout), {
    briefs: { A: s.p('phase2', 'delta-brief-A.txt'), B: s.p('phase2', 'B', 'delta-brief.txt') },
    rebuttals: { A: privateA, B: null }, skipped: {}, channels: { A: 'file', B: 'final-message' },
  });
  assert.deepEqual(await fs.readdir(s.p('phase2', 'seat-A')), [], 'the private folder is created empty');
  await assert.rejects(fs.access(s.p('phase2', 'seat-B')));
  const briefA = await fs.readFile(s.p('phase2', 'delta-brief-A.txt'), 'utf8');
  const briefB = await fs.readFile(s.p('phase2', 'B', 'delta-brief.txt'), 'utf8');
  assert.ok(briefA.includes(privateA) && !briefA.includes(s.p('phase2', 'A-rebuttals-raw.md')));
  assert.ok(!briefB.includes('rebuttals-raw'));
  for (const text of [briefA, briefB, await fs.readFile(s.p('phase2', 'peer-view-for-A.md'), 'utf8'), await fs.readFile(s.p('phase2', 'peer-view-for-B.md'), 'utf8')]) {
    assert.doesNotMatch(text, /descriptor-model|descriptor-host|seat-B/);
  }
});

test('run.json: finish publishes a CLI seat\'s file byte for byte and leaves a final-message seat\'s file alone [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A'), codexSeatB(s));
  assert.equal(run(prepareArgs(s)).status, 0);
  const privateA = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('### P1\r\nClaim: P1\r\nAction: CONCEDE\r\n')]);
  await fs.writeFile(s.p('phase2', 'seat-A', 'A-rebuttals-raw.md'), privateA);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const r = run(finishArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await fs.readFile(s.p('phase2', 'A-rebuttals-raw.md')), privateA);
  assert.equal(await fs.readFile(s.p('phase2', 'B-rebuttals-raw.md'), 'utf8'), RAW_FOR_TWO);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.published, { A: { source: s.p('phase2', 'seat-A', 'A-rebuttals-raw.md'), destination: s.p('phase2', 'A-rebuttals-raw.md'), sha256: sha256Of(privateA) } });
  assert.deepEqual([out.appended, out.concede, out.dispute], [['A', 'B'], 2, 1]);
});

test('run.json: a native file seat writes the canonical path directly and nothing is published [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A', { transport: 'native' }), codexSeatB(s));
  const r = run(prepareArgs(s));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).rebuttals.A, s.p('phase2', 'A-rebuttals-raw.md'));
  await assert.rejects(fs.access(s.p('phase2', 'seat-A')));
  await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const f = run(finishArgs(s));
  assert.equal(f.status, 0, f.stderr);
  assert.equal(JSON.parse(f.stdout).published, undefined);
});

test('run.json: two CLI file seats publish both files, a rerun after a refused finish accepts the identical canonical copy and keeps a differing one as an attempt file [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A'), descriptorSeat(s, 'B'), 'pair-review');
  assert.equal(run(prepareArgs(s)).status, 0);
  assert.ok((await fs.readFile(s.p('phase2', 'delta-brief-B.txt'), 'utf8')).includes(s.p('phase2', 'seat-B', 'B-rebuttals-raw.md')));
  await fs.writeFile(s.p('phase2', 'seat-A', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  await fs.writeFile(s.p('phase2', 'seat-B', 'B-rebuttals-raw.md'), RAW_FOR_ONE);
  const refused = run(finishArgs(s));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused seat B's rebuttals; both findings files were restored/);
  assert.equal(await fs.readFile(s.p('phase1', 'A-findings.md'), 'utf8'), A_TEXT);
  await fs.writeFile(s.p('phase2', 'seat-B', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), 'the refused canonical copy');
  const ok = run(finishArgs(s));
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(Object.keys(JSON.parse(ok.stdout).published), ['B'], 'seat A\'s identical canonical copy from the first attempt is accepted, not republished');
  assert.equal(await fs.readFile(s.p('phase2', 'B-rebuttals-raw.attempt-1.md'), 'utf8'), 'the refused canonical copy', 'the earlier copy of the corrected seat is kept');
});

test('run.json: a CLI seat that wrote nothing is named with its private path, and a stale private file blocks prepare [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A'), codexSeatB(s));
  assert.equal(run(prepareArgs(s)).status, 0);
  await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), RAW_FOR_TWO);
  const missing = run(finishArgs(s));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /A-rebuttals-raw\.md does not exist \(a CLI seat writes .*seat-A.*A-rebuttals-raw\.md first\); wait for seat A/);
  const s2 = await setup(t);
  await writeDescriptor(s2, descriptorSeat(s2, 'A'), codexSeatB(s2));
  await fs.mkdir(s2.p('phase2', 'seat-A'), { recursive: true });
  await fs.writeFile(s2.p('phase2', 'seat-A', 'A-rebuttals-raw.md'), RAW_FOR_ONE);
  assert.match(run(prepareArgs(s2)).stderr, /seat-A.*A-rebuttals-raw\.md exists, so the exchange was already prepared/);
});

test('run.json decides the channel: a contradicting --seat-b-harness, a malformed descriptor and a grant that exposes a peer file are refused [slow]', async (t) => {
  const s = await setup(t);
  await writeDescriptor(s, descriptorSeat(s, 'A'), codexSeatB(s));
  const contradiction = run(prepareArgs(s, '--seat-b-harness'));
  assert.equal(contradiction.status, 1);
  assert.match(contradiction.stderr, /--seat-b-harness says seat B uses the file channel, but run\.json makes it a final-message seat/);
  await assert.rejects(fs.access(s.p('phase2')));
  const consistent = await setup(t);
  await writeDescriptor(consistent, descriptorSeat(consistent, 'A'), descriptorSeat(consistent, 'B'), 'pair-review');
  assert.equal(run(prepareArgs(consistent, '--seat-b-harness')).status, 0);

  const bad = await setup(t);
  await fs.writeFile(bad.p('run.json'), '{ not json');
  const malformed = run(prepareArgs(bad));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /exchange: run descriptor .* is not valid JSON/);
  assert.doesNotMatch(malformed.stderr, /unexpected failure/);

  const leaky = await setup(t);
  await writeDescriptor(leaky, descriptorSeat(leaky, 'A', { outputDir: leaky.p('phase1') }), codexSeatB(leaky));
  const exposed = run(prepareArgs(leaky));
  assert.equal(exposed.status, 1);
  assert.match(exposed.stderr, /exchange: actor "A" is granted .*would expose .*B-findings\.md/);
  await assert.rejects(fs.access(leaky.p('phase2')));
});

test('finish counts a conceded HIGH claim in every rebuttal shape append-rebuttals accepts ("###" and "##" headings, and headingless "Claim:" entries) [slow]', async (t) => {
  const withSeverity = (letter, severities) => `# Seat ${letter} findings\n\n${severities.map((sev, i) => claim(`${letter}${i + 1}`).replace('Severity: HIGH', `Severity: ${sev}`)).join('')}`;
  const forms = {
    '### P<n>': (i) => `### P${i}\nClaim: P${i}\nAction: CONCEDE\n\n`,
    '## P<n>': (i) => `## P${i}\nClaim: P${i}\nAction: CONCEDE\n\n`,
    'headingless Claim:': (i) => `Claim: P${i}\nAction: CONCEDE\n\n`,
  };
  for (const [name, entry] of Object.entries(forms)) {
    // Seat A's second claim is HIGH, the others LOW; seat B's claims are all MEDIUM.
    const s = await setup(t, { a: withSeverity('A', ['LOW', 'HIGH', 'LOW']), b: withSeverity('B', ['MEDIUM', 'MEDIUM', 'MEDIUM']) });
    assert.equal(run(prepareArgs(s)).status, 0);
    await fs.writeFile(s.p('phase2', 'A-rebuttals-raw.md'), [1, 2, 3].map(entry).join(''));
    await fs.writeFile(s.p('phase2', 'B-rebuttals-raw.md'), [1, 2, 3].map(entry).join(''));
    const r = run(finishArgs(s));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /WARNING: all 6 rebuttals conceded and none disputed; a light audit would re-check none of these findings \(1 HIGH or CRITICAL\)/, name);
    assert.deepEqual(JSON.parse(r.stdout).concede, 6, name);
  }
});
