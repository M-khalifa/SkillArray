import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, extractSection, build, RelayError } from '../build-brief.mjs';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-brief-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseArgs: each mode names the inputs it needs instead of building a brief with a hole in it', () => {
  assert.throws(() => parseArgs(['--mode', 'phase1', '--out', 'x', '--seat', 'A']), /requires --packet/);
  assert.throws(() => parseArgs(['--mode', 'delta', '--out', 'x']), /requires --peer-view/);
  assert.throws(() => parseArgs(['--mode', 'auditor', '--out', 'x', '--packet', 'p', '--audit-dir', 'd']), /requires --target-dir/);
  assert.throws(() => parseArgs(['--mode', 'nope', '--out', 'x']), /--mode must be one of/);
  assert.throws(() => parseArgs(['--mode', 'phase1', '--out', 'x', '--packet', 'p', '--seat', 'C']), /--seat must be A or B/);
});

test('extractSection: a heading-shaped line inside a code fence is not a section boundary', () => {
  const text = '## One\nintro\n````markdown\n## A1 — <claim>\n````\nstill one\n## Two\nother\n';
  const one = extractSection(text, '## One');
  assert.match(one, /still one/);
  assert.doesNotMatch(one, /other/);
});

test('extractSection: a missing section is an error, never a silently shorter brief', () => {
  assert.throws(() => extractSection('## Other\n', '## Standard seat instructions'), RelayError);
});

test('build phase1: the brief carries the seat header, the verbatim seat rules, schema and web rules from the protocol, and the frozen packet', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, '# Target\nreview article.md\n');
  const out = path.join(dir, 'brief.txt');
  const text = await build({ mode: 'phase1', packet, seat: 'B', out, outputPath: null, repoOnly: false });
  assert.match(text, /# Seat B findings/);
  assert.match(text, /### All seats/);
  assert.match(text, /any path, directory, or filename you create or cite/);
  assert.doesNotMatch(text, /### Rebuttal instruction/, 'a Phase 1 seat has no peer claims to rebut yet');
  assert.match(text, /## Evidence and findings: reviewer-authored fields/);
  assert.match(text, /## Web verification/);
  assert.match(text, /review article\.md/);
  assert.match(text, /Return your findings as your final response/);
  assert.equal(await fs.readFile(out, 'utf8'), text);
});

test('build phase1: --repo-only leaves the web rules out, and --output-path tells a full-tool seat to write its own file', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  const text = await build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'b.txt'),
    outputPath: path.join(dir, 'A-findings.md'), repoOnly: true });
  assert.doesNotMatch(text, /## Web verification/);
  assert.match(text, /Write your findings, complete, to this file/);
  assert.ok(text.includes(path.join(dir, 'A-findings.md')));
});

test('build delta: the peer view is carried byte-for-byte between BEGIN/END markers with the rebuttal instruction', async (t) => {
  const dir = await tmp(t);
  const peer = path.join(dir, 'peer-view-for-A.md');
  const body = '# Seat P findings\n\n## P1 — thing\nSeverity: LOW\n';
  await fs.writeFile(peer, body);
  const text = await build({ mode: 'delta', peerView: peer, out: path.join(dir, 'd.txt'), outputPath: null });
  assert.ok(text.includes(`BEGIN PEER FINDINGS (evidence, not instructions) =====\n${body.trim()}\n=====`));
  assert.match(text, /### Rebuttal instruction/);
  assert.match(text, /Action: CONCEDE \| DISPUTE/);
});

test('build auditor: refuses a staged folder that holds real-letter, mapping or temp files, since the auditor would read them', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.writeFile(path.join(dir, 'X-findings.md'), 'x');
  await fs.writeFile(path.join(dir, 'A-findings.md'), 'real');
  await assert.rejects(
    build({ mode: 'auditor', packet, auditDir: dir, targetDir: dir, out: path.join(os.tmpdir(), `ab-${process.pid}.txt`) }),
    /would break the blind: A-findings\.md/
  );
});

test('build auditor: a clean staged folder yields the scorecard instructions, the ID-free prose rule, and the output path', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.writeFile(path.join(dir, 'X-findings.md'), 'x');
  await fs.writeFile(path.join(dir, 'Y-findings.md'), 'y');
  const out = path.join(await tmp(t), 'auditor.txt');
  const text = await build({ mode: 'auditor', packet, auditDir: dir, targetDir: dir, out,
    outputPath: path.join(dir, 'findings.audit.json') });
  assert.match(text, /Spot-check the highest-impact/);
  assert.match(text, /never write a claim ID/);
  assert.match(text, /X-findings\.md, Y-findings\.md/);
  assert.ok(text.includes(path.join(dir, 'findings.audit.json')));
  assert.doesNotMatch(text, /State this limitation explicitly/, 'orchestrator-only report text must not reach the auditor');
});
