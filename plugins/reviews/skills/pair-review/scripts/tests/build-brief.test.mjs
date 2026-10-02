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
  assert.throws(() => parseArgs(['--mode', 'auditor', '--out', 'x', '--packet', 'p', '--audit-dir', 'd', '--target-dir', 't']), /requires --run-dir/);
  assert.throws(() => parseArgs(['--mode', 'nope', '--out', 'x']), /--mode must be one of/);
  assert.throws(() => parseArgs(['--mode', 'phase1', '--out', 'x', '--packet', 'p', '--seat', 'C']), /--seat must be A or B/);
});

test('extractSection: a heading-shaped line inside a code fence is not a section boundary', () => {
  const text = '## One\nintro\n````markdown\n## A1 — <claim>\n````\nstill one\n## Two\nother\n';
  const one = extractSection(text, '## One');
  assert.match(one, /still one/);
  assert.doesNotMatch(one, /other/);
});

test('review-protocol.md: the section index at the top lists every top-level section at its real line number', async () => {
  const lines = (await fs.readFile(new URL('../../references/review-protocol.md', import.meta.url), 'utf8')).split('\n');
  const actual = [];
  let fence = null;
  lines.forEach((l, i) => {
    const m = /^(`{3,}|~{3,})/.exec(l);
    if (m && fence === null) fence = m[1];
    else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && l.trim() === m[1]) fence = null;
    else if (fence === null && l.startsWith('## ')) actual.push(`- line ${i + 1}: ${l.slice(3)}`);
  });
  const start = lines.indexOf('<!-- section-index -->');
  const end = lines.indexOf('<!-- /section-index -->');
  assert.ok(start > 0 && end > start, 'index markers present');
  const listed = lines.slice(start, end).filter((l) => l.startsWith('- line '));
  assert.deepEqual(listed, actual, 'regenerate the index after moving or adding a section');
  assert.ok(actual.some((l) => l.endsWith(': Manifest and final output')));
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
  assert.match(text, /Leave nothing running when you reply\. Stop every background command/, 'a seat is told to stop what it started');
  assert.doesNotMatch(text, /### Rebuttal instruction/, 'a Phase 1 seat has no peer claims to rebut yet');
  assert.match(text, /## Evidence and findings: reviewer-authored fields/);
  assert.match(text, /### Web verification: reviewer rules/);
  assert.doesNotMatch(text, /orchestrator notes|codex-dispatch|--search/, 'dispatch mechanics and runtime names stay out of seat briefs');
  assert.match(text, /review article\.md/);
  assert.match(text, /Return your findings as your final response/);
  assert.equal(await fs.readFile(out, 'utf8'), text);
  assert.match(text, /Last rule, easy to miss: never write a claim ID \(yours such as B3, or anyone else's\) inside an Evidence fence or inline code\.[^\n]*\n$/,
    'the own-ID rule closes the brief, after the packet');
  assert.match(text, /including one of your own\s+claims/, 'the protocol rule itself names the seat\'s own IDs');
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
  assert.match(text, /add each finding as soon as you confirm it, so the orchestrator can report progress/);
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
  const rule = text.indexOf('Last rule, easy to miss: inside an Evidence fence or inline code, never write a peer label such as P2');
  assert.ok(rule > text.indexOf('### Rebuttal instruction') && rule < text.indexOf('Return every rebuttal entry'),
    'the fence rule is repeated right before the output instructions');
});

test('build auditor: refuses a staged folder that holds real-letter, mapping or temp files, since the auditor would read them', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.writeFile(path.join(dir, 'X-findings.md'), 'x');
  await fs.writeFile(path.join(dir, 'A-findings.md'), 'real');
  await assert.rejects(
    build({ mode: 'auditor', packet, auditDir: dir, targetDir: dir, runDir: path.join(os.tmpdir(), 'no-such-run-dir'), out: path.join(os.tmpdir(), `ab-${process.pid}.txt`) }),
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
  const text = await build({ mode: 'auditor', packet, auditDir: dir, targetDir: dir, runDir: path.join(os.tmpdir(), 'no-such-run-dir'), out,
    outputPath: path.join(dir, 'findings.audit.json') });
  assert.match(text, /Check claims itself, using its own read-only target access/);
  assert.match(text, /never write a claim ID/);
  assert.match(text, /X-findings\.md, Y-findings\.md/);
  assert.ok(text.includes(path.join(dir, 'findings.audit.json')));
  assert.doesNotMatch(text, /State this limitation explicitly/, 'orchestrator-only report text must not reach the auditor');
  assert.match(text, /### Audit depth: light/, 'light audit is the default');
  assert.match(text, /4\. Leave nothing running when you reply: stop every background command you\s+started/, 'the auditor is told to stop what it started');
  assert.match(text, /5\. When your own check CONFIRMS a claim but supports a different severity[\s\S]*?`auditor_check\.severity`/, 'the auditor is told where a corrected severity goes');
  assert.match(text, /6\. Read efficiently: [\s\S]*?in one turn, not one per\s+turn/, 'the auditor batches independent reads like a seat');
  assert.match(text, /7\. You are the only auditor\. Do not start sub-agents/, 'the auditor starts no sub-agents');
  const vDir = await tmp(t);
  await fs.writeFile(path.join(vDir, 'claim.md'), '## X1 — c\nSeverity: HIGH\n');
  await fs.writeFile(path.join(vDir, 'rebuttal.md'), '### X1\nAction: DISPUTE\n');
  const verifier = await build({ mode: 'verifier', claim: path.join(vDir, 'claim.md'), rebuttal: path.join(vDir, 'rebuttal.md'), targetDir: dir, out: path.join(vDir, 'v.txt') });
  assert.match(verifier, /The verifier works alone: no sub-agents[\s\S]*?in one\s+turn[\s\S]*?stops every\s+background command it started/, 'the verifier gets the same working rules');
  const { scanText } = await import('../blind-relabel.mjs');
  const scanned = await scanText(verifier, undefined, []);
  assert.deepEqual([scanned.selfIdHits, scanned.identityHits], [[], []], 'the protocol text a verifier brief copies passes the identity scan');
  const withSources = await build({ mode: 'verifier', claim: path.join(vDir, 'claim.md'), rebuttal: path.join(vDir, 'rebuttal.md'), targetDir: dir, sourceDirs: [vDir], out: path.join(vDir, 'v2.txt') });
  assert.ok(withSources.includes(`Target snapshot, read-only: ${path.resolve(dir)}\nOther reviewed repository, read-only: ${path.resolve(vDir)}`), 'a verifier is told about every reviewed repository');
  assert.equal(parseArgs(['--mode', 'verifier', '--claim', 'c', '--rebuttal', 'r', '--target-dir', 't', '--out', 'o', '--source-dir', 's']).sourceDirs[0], 's');
  assert.doesNotMatch(text, /### Audit depth: full/);
  const full = await build({ mode: 'auditor', packet, auditDir: dir, targetDir: dir, runDir: path.join(os.tmpdir(), 'no-such-run-dir'), out,
    outputPath: path.join(dir, 'findings.audit.json'), auditDepth: 'full' });
  assert.match(full, /### Audit depth: full\n\nChosen when the task asks to double check all claims/);
  assert.doesNotMatch(full, /### Audit depth: light/);
  assert.doesNotMatch(full, /## Manifest and final output/, 'the depth section stops before the manifest section');
});

test('parseArgs: --audit-depth is auditor-only, defaults to light there, and takes only light or full', () => {
  const base = ['--mode', 'auditor', '--out', 'x', '--packet', 'p', '--audit-dir', 'd', '--target-dir', 't', '--run-dir', 'r'];
  assert.equal(parseArgs(base).auditDepth, 'light');
  assert.equal(parseArgs([...base, '--audit-depth', 'full']).auditDepth, 'full');
  assert.throws(() => parseArgs([...base, '--audit-depth', 'deep']), /--audit-depth must be light or full/);
  assert.throws(() => parseArgs(['--mode', 'phase1', '--out', 'x', '--packet', 'p', '--seat', 'A', '--audit-depth', 'full']), /only accepted by --mode auditor/);
});

test('build auditor: refuses when the task packet names the run directory in any spelling, since the auditor would follow it to real-ID files', async (t) => {
  const run = await tmp(t);
  const audit = await tmp(t);
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const fwd = path.join(run, 'preflight.json.logs').split(path.sep).join('/');
  await fs.writeFile(packet, `Pre-flight logs: ${fwd.toUpperCase()}\n`);
  await assert.rejects(
    build({ mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(await tmp(t), 'a.txt') }),
    /task packet names the run directory/
  );
});

test('build auditor: --source-dir repos are listed as read-only inputs, one inside the run directory is refused, other modes refuse the flag, and the brief asks for auditor_check.reason', async (t) => {
  const audit = await tmp(t);
  const other = await tmp(t);
  const run = await tmp(t);
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const out = path.join(await tmp(t), 'auditor.txt');
  const args = parseArgs(['--mode', 'auditor', '--packet', packet, '--audit-dir', audit, '--target-dir', audit, '--run-dir', run,
    '--out', out, '--source-dir', other, '--source-dir', audit]);
  assert.deepEqual(args.sourceDirs, [other, audit]);
  const text = await build(args);
  assert.ok(text.includes(`- other reviewed repository: ${path.resolve(other)} (read-only, same rule)`));
  assert.match(text, /must carry auditor_check\.reason/);
  await assert.rejects(build({ ...args, sourceDirs: [path.join(run, 'phase1')] }), /--source-dir .* is inside --run-dir/);
  assert.throws(() => parseArgs(['--mode', 'delta', '--peer-view', 'p', '--out', 'o', '--source-dir', 'r']), /only accepted by --mode auditor/);
});

test('build auditor: a sibling folder named "<run-dir>-evidence2" is not the run directory (live false refusal), but "<run-dir>" itself or a path inside it still is, and --out inside the run directory is refused', async (t) => {
  const root = await tmp(t);
  const run = path.join(root, 'run');
  const audit = path.join(root, 'audit');
  await fs.mkdir(run);
  await fs.mkdir(audit);
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const packet = path.join(audit, 'task-packet.md');
  const base = { mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run };
  await fs.writeFile(packet, `Logs: ${run}-evidence2${path.sep}preflight.json\n`);
  const brief = path.join(audit, 'auditor-brief.txt');
  const text = await build({ ...base, out: brief });
  assert.doesNotMatch(text, /auditor-brief\.txt/, 'the brief does not list itself as an input file');
  for (const mention of [`${run}${path.sep}phase1`, `the run dir is ${run}.`, `(${run})`, run]) {
    await fs.writeFile(packet, `${mention}\n`);
    await assert.rejects(build({ ...base, out: brief }), /task packet names the run directory/, mention);
  }
  await fs.writeFile(packet, 'clean\n');
  await assert.rejects(build({ ...base, out: path.join(run, 'phase3-private', 'auditor-brief.txt') }), /--out is inside --run-dir/);
  await assert.rejects(build({ ...base, out: brief, outputPath: path.join(run, 'findings.audit.json') }), /--output-path is inside --run-dir/);
});

test('build auditor: a JSON-escaped run-dir path (doubled backslashes) is refused, any "<run-dir> ..." continued by a space is refused (even an existing "<run-dir> 2", which could be a link or walk back with ".."), a missing staged folder is a clear error, and the staged packet/protocol are marked as already reproduced', async (t) => {
  const root = await tmp(t);
  const run = path.join(root, 'run');
  const audit = path.join(root, 'audit');
  await fs.mkdir(run);
  await fs.mkdir(audit);
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  await fs.writeFile(path.join(audit, 'review-protocol.md'), 'p');
  const packet = path.join(audit, 'task-packet.md');
  const base = { mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(audit, 'auditor-brief.txt') };
  const escaped = JSON.stringify(path.join(run, 'phase1', 'A-findings.md'));
  await fs.writeFile(packet, `"log": ${escaped}\n`);
  if (path.sep === '\\') await assert.rejects(build(base), /task packet names the run directory/, 'doubled backslashes');
  await fs.writeFile(packet, `Evidence: ${run}-evidence${path.sep}preflight.json\n`);
  const text = await build(base);
  assert.match(text, /already reproduced below; open those two files only if a section you need is missing/);
  await fs.mkdir(`${run} 2`);
  for (const mention of [
    `Evidence: ${run} 2${path.sep}preflight.json`,
    `Sibling folder: ${run} 2`,
    `The run dir ${run} is private${path.sep}x`,
    `Walks back: ${run} 2${path.sep}..${path.sep}run${path.sep}phase1${path.sep}A-findings.md`,
    `Walks back: ${run} 2${path.sep}sub dir${path.sep}..${path.sep}..${path.sep}run`,
  ]) {
    await fs.writeFile(packet, `${mention}\n`);
    await assert.rejects(build(base), /task packet names the run directory/, mention);
  }
  await fs.writeFile(packet, 'clean\n');
  await assert.rejects(build({ ...base, auditDir: path.join(root, 'no-such-audit') }), /--audit-dir .* cannot be read .*run audit-prep first/);
});

test('build auditor: refuses a staged folder inside the run directory', async (t) => {
  const run = await tmp(t);
  const audit = path.join(run, 'audit-input');
  await fs.mkdir(audit);
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(packet, 'clean packet');
  await assert.rejects(
    build({ mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(await tmp(t), 'a.txt') }),
    /--audit-dir is inside --run-dir/
  );
});

test('build: every brief records its skill version in <run-dir>/skill-versions.jsonl, found from the phase folder or --run-dir, and never in a folder a reviewer or the auditor reads', async (t) => {
  const run = await tmp(t);
  const packet = path.join(run, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.mkdir(path.join(run, 'phase1', 'B'), { recursive: true });
  await build({ mode: 'phase1', packet, seat: 'B', out: path.join(run, 'phase1', 'B', 'brief.txt') });
  await fs.mkdir(path.join(run, 'phase2'), { recursive: true });
  await fs.writeFile(path.join(run, 'phase2', 'peer-view-for-A.md'), '# Seat B findings\n\n## P1 — c\nSeverity: LOW\n');
  await build({ mode: 'delta', peerView: path.join(run, 'phase2', 'peer-view-for-A.md'), out: path.join(run, 'phase2', 'delta-brief-A.txt') });
  const audit = await tmp(t);
  await fs.copyFile(packet, path.join(audit, 'task-packet.md'));
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  await fs.writeFile(path.join(audit, 'Y-findings.md'), 'y');
  await build({ mode: 'auditor', packet: path.join(audit, 'task-packet.md'), auditDir: audit, targetDir: audit, runDir: run, out: path.join(audit, 'auditor-brief.txt') });
  const version = /^\s+version:\s*(\S+)\s*$/m.exec(await fs.readFile(new URL('../../SKILL.md', import.meta.url), 'utf8'))[1];
  const rows = (await fs.readFile(path.join(run, 'skill-versions.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.phase, r.mode, r.seat, r.version]), [['phase1', 'phase1', 'B', version], ['phase2', 'delta', null, version], ['phase3', 'auditor', null, version]]);
  assert.ok(rows.every((r) => typeof r.skill === 'string' && Number.isFinite(Date.parse(r.at))));
  assert.deepEqual((await fs.readdir(audit)).sort(), ['X-findings.md', 'Y-findings.md', 'auditor-brief.txt', 'task-packet.md'], 'nothing is added to the folder the auditor reads');
  const loose = await tmp(t);
  await build({ mode: 'phase1', packet, seat: 'A', out: path.join(loose, 'brief.txt') });
  assert.deepEqual(await fs.readdir(loose), ['brief.txt'], 'a brief outside any phase folder records nothing');
});

test('parseArgs: a path holding a shell variable a loop never expanded is refused, while a Windows admin share and a plain dollar or percent sign pass', () => {
  const base = ['--mode', 'phase1', '--packet', 'p.md', '--seat', 'B', '--out', 'brief.txt'];
  for (const [value, token] of [
    ['C:\\run\\phase1$S-findings.md', '$S'],
    ['/run/phase1/${SEAT}-findings.md', '${SEAT}'],
    ['C:\\run\\$env:SEAT-findings.md', '$env:SEAT'],
    ['C:\\run\\%SEAT%-findings.md', '%SEAT%'],
  ]) {
    assert.throws(
      () => parseArgs([...base, '--output-path', value]),
      (e) => e instanceof RelayError && e.message === `--output-path "${value}" contains "${token}", a shell variable that was never expanded; pass the real path`
    );
  }
  assert.throws(() => parseArgs(['--mode', 'delta', '--peer-view', 'C:\\run\\$VIEW.md', '--out', 'b.txt']), /--peer-view .* never expanded/);
  for (const ok of ['\\\\host\\C$\\run\\B-findings.md', 'C:\\run\\cost-$5\\B.md', 'C:\\run\\100%\\B.md', 'C:\\run\\B-findings.md']) {
    assert.equal(parseArgs([...base, '--output-path', ok]).outputPath, ok);
  }
});
