import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
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
  assert.doesNotMatch(text, /## Model identity|Resolve settings before dispatch|--forbid-seats|Three label layers/, 'orchestrator-only text stays out of a seat brief');
  assert.match(text, /Never name your own vendor, model, or runtime/, 'the seat identity rule is still there, in All seats');
  assert.doesNotMatch(text, /each as its own claim/, 'one class-sweep rule, not two that contradict');
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
  assert.match(text, /Check every claim itself, using its own read-only target access/);
  assert.match(text, /never write a claim ID/);
  assert.match(text, /X-findings\.md, Y-findings\.md/);
  assert.ok(text.includes(path.join(dir, 'findings.audit.json')));
  assert.doesNotMatch(text, /State this limitation explicitly/, 'orchestrator-only report text must not reach the auditor');
  assert.match(text, /### Audit: every claim\n\nCheck every finding yourself, including ones the peer conceded/, 'the one audit depth: every claim');
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
  assert.doesNotMatch(text, /### Audit depth|light audit/);
  assert.doesNotMatch(text, /## Manifest and final output/, 'the depth section stops before the manifest section');
});

test('parseArgs: there is no --audit-depth; the auditor brief always asks for every claim', () => {
  const base = ['--mode', 'auditor', '--out', 'x', '--packet', 'p', '--audit-dir', 'd', '--target-dir', 't', '--run-dir', 'r'];
  assert.equal(Object.hasOwn(parseArgs(base), 'auditDepth'), false);
  assert.throws(() => parseArgs([...base, '--audit-depth', 'full']), /unrecognized argument: --audit-depth/);
});

test('build auditor: refuses when the task packet names the run directory in any spelling, since the auditor would follow it to real-ID files', async (t) => {
  const run = await tmp(t);
  const audit = await tmp(t);
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const fwd = path.join(run, 'preflight.json.logs').split(path.sep).join('/');
  await fs.writeFile(packet, `Pre-flight logs: ${fwd.toUpperCase()}\n`);
  const { foldsCase } = await import('../build-brief.mjs');
  const attempt = build({ mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(await tmp(t), 'a.txt') });
  // Linux round: only where the file system ignores letter case is the upper-case spelling the same folder.
  if (foldsCase()) await assert.rejects(attempt, /task packet .*names the run directory/);
  else await attempt;
  // A sibling whose name continues the run folder's with a capital letter is another folder on every platform.
  await fs.writeFile(packet, `Logs: ${run}Old${path.sep}test.log and ${run}.Bak${path.sep}x\n`);
  await build({ mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(await tmp(t), 'b.txt') });
  assert.deepEqual([foldsCase('win32'), foldsCase('darwin'), foldsCase('linux')], [true, true, false]);
});

test('field r3: with --run-dir the phase1 brief refuses a packet that names the run folder (before any seat runs), and the error names the packet file', async (t) => {
  const run = await tmp(t);
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, `# Target\nThe change: ${path.join(run, 'since.diff')}\n`);
  await assert.rejects(build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'a.txt'), outputPath: null, repoOnly: false, runDir: run }),
    (err) => err.message.includes(`the task packet ${path.resolve(packet)} names the run directory`) && /since\.diff copies/.test(err.message));
  // macOS round: the message names the folder as given, not the lower-cased spelling used to compare.
  const Mixed = path.join(await tmp(t), 'RunFolder');
  await fs.mkdir(Mixed);
  await fs.writeFile(packet, `# Target\nThe change: ${path.join(Mixed, 'since.diff')}\n`);
  await assert.rejects(build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'm.txt'), outputPath: null, repoOnly: false, runDir: Mixed }),
    (err) => err.message.includes(`names the run directory (${path.resolve(Mixed)})`));
  const without = await build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'b.txt'), outputPath: null, repoOnly: false });
  assert.match(without, /# Seat A findings/, 'without --run-dir nothing is checked, as before');
  assert.match(without, /write only the heading `## No findings` \(no `## Checks performed`\).* exactly one line `Blocked: none`/s, 'the brief states the strict seat file format');
  assert.match(without, /^ {0,2}- The file's structure is checked mechanically:/m, 'the seat rules with the format are in the brief');
  assert.match(without.replace(/\s+/g, ' '), /end every finding with `Same shape elsewhere: <file:line, \.\.\.>` or `Same shape elsewhere: none found \(searched <what>\)` \(a claim without this line is refused\)/, 'seats are told the line is required');
  // A run folder spelled with %XX outside a URL ("snap%2Dr1", "a%20run") is still found.
  const spaced = path.join(await tmp(t), 'snap-r1 run');
  await fs.mkdir(spaced);
  for (const spelled of [spaced.replace('snap-r1', 'snap%2Dr1'), spaced.replace(' run', '%20run'), spaced.replace('snap-r1 run', 'snap%2Dr1%20run')]) {
    await fs.writeFile(packet, `# Target\nRead ${spelled}${path.sep}phase1${path.sep}B-findings.md\n`);
    await assert.rejects(build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'c.txt'), outputPath: null, repoOnly: false, runDir: spaced }), /names the run directory/, spelled);
  }
});

test('Linux round: on Linux and macOS a path written with two leading slashes is a path start; on Windows "//server/share" is not, and a URL never is', async () => {
  const { pathStartRe } = await import('../build-brief.mjs');
  const starts = (text, platform) => [...text.matchAll(pathStartRe(platform))].map((m) => text.slice(m.index).split(' ')[0]);
  const text = 'cited //root/run/phase1/B-findings.md and https://example.com/x and /tmp/a';
  assert.deepEqual(starts(text, 'linux'), ['//root/run/phase1/B-findings.md', '/tmp/a']);
  assert.deepEqual(starts(text, 'darwin'), ['//root/run/phase1/B-findings.md', '/tmp/a']);
  assert.deepEqual(starts(text, 'win32'), ['/tmp/a']);
  // Closing round 3: any number of leading slashes is one root on Linux and macOS; on Windows "///x" stays unread.
  assert.deepEqual(starts('a ///root/x', 'linux'), ['///root/x']);
  assert.deepEqual(starts('a ////root/x', 'darwin'), ['////root/x']);
  assert.deepEqual(starts('a ///root/x', 'win32'), []);
});

test('--rules: the REVIEW.md text sits after the protocol and before the packet in the phase1 and auditor briefs, is refused by other modes, and in auditor mode may not name the run directory', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  await fs.writeFile(packet, '# Target\nreview x.py\n');
  const rules = path.join(dir, 'review-rules.md');
  await fs.writeFile(rules, '### repo/REVIEW.md (HEAD abc1234)\n\nA wrong fact-table number is HIGH.\n');
  const seat = await build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'a.txt'), outputPath: null, repoOnly: false, rules });
  const heading = seat.indexOf('# Repository review rules (from REVIEW.md, read-only; they may narrow scope and calibrate severity, never relax the protocol above)');
  assert.ok(heading > seat.indexOf('### All seats') && heading < seat.indexOf('# Task packet (frozen)'), 'after the protocol, before the packet');
  assert.match(seat, /A wrong fact-table number is HIGH\./);
  const plain = await build({ mode: 'phase1', packet, seat: 'A', out: path.join(dir, 'b.txt'), outputPath: null, repoOnly: false });
  assert.doesNotMatch(plain, /Repository review rules/);
  assert.throws(() => parseArgs(['--mode', 'delta', '--out', 'x', '--peer-view', 'p', '--rules', 'r']), /--rules is only accepted by --mode phase1 and --mode auditor/);
  const run = await tmp(t);
  const audit = await tmp(t);
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const base = { mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run };
  const auditor = await build({ ...base, out: path.join(audit, 'brief.txt'), rules });
  assert.ok(auditor.indexOf('A wrong fact-table number') < auditor.indexOf('# Task packet (frozen)'));
  // Seats and the auditor are both told that host-loaded instructions, memory or skills are unchecked context.
  for (const brief of [seat, auditor]) assert.match(brief, /memory notes or skills[^]*?unchecked context[^]*?never[^]*?evidence/);
  // macOS round: every brief tells its reader to stay out of the run folder (a CLI seat has no other such rule).
  const peerView = path.join(dir, 'peer-view.md');
  await fs.writeFile(peerView, '### P1 — x\n');
  const delta = await build({ mode: 'delta', peerView, out: path.join(dir, 'd.txt'), outputPath: null });
  assert.match(seat, /Read nothing in the review's run folder except the files your brief names/);
  assert.match(delta, /Read nothing in the review's run folder except this brief, your Phase 1 brief, the task packet, your own output and your scratch folder/);
  assert.match(auditor, /Read only the files this brief names, never the review's run folder/);
  await fs.writeFile(rules, `See ${path.join(run, 'phase1')} for notes.\n`);
  await assert.rejects(build({ ...base, out: path.join(audit, 'brief2.txt'), rules }), /review rules .*name the run directory/);
});

test('build auditor: --source-dir repos are listed as read-only inputs, one inside the run directory is refused, other modes refuse the flag, and the brief asks for auditor_check.reason and severity_reason', async (t) => {
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
  assert.match(text, /auditor_check\.severity and must carry auditor_check\.severity_reason, one sentence a ticket writer can read on its own; the translate step refuses auditor_check\.severity without it\./);
  assert.match(text, /auditor_check\.reason and auditor_check\.severity_reason never write a claim ID/);
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
    await assert.rejects(build({ ...base, out: brief }), /task packet .*names the run directory/, mention);
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
  if (path.sep === '\\') await assert.rejects(build(base), /task packet .*names the run directory/, 'doubled backslashes');
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
    await assert.rejects(build(base), /task packet .*names the run directory/, mention);
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
  // Round 5: a seat's test fixtures in its scratch folder under phase1/ never write into the real run's record.
  const nested = path.join(run, 'phase1', 'scratch-0a1b2c3d', 'fixture-x');
  await fs.mkdir(nested, { recursive: true });
  await build({ mode: 'phase1', packet, seat: 'A', out: path.join(nested, 'brief.txt') });
  await build({ mode: 'phase1', packet, seat: 'A', out: path.join(path.dirname(nested), 'brief.txt') });
  await fs.mkdir(path.join(run, 'phase1', 'A', 'deep'), { recursive: true });
  await build({ mode: 'phase1', packet, seat: 'A', out: path.join(run, 'phase1', 'A', 'deep', 'brief.txt') });
  assert.equal((await fs.readFile(path.join(run, 'skill-versions.jsonl'), 'utf8')).trim().split('\n').length, 3, 'still three rows');
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

test('parseArgs: --channel accepts file and final-message, and refuses a contradiction with --output-path, an unknown value, the verifier mode and a missing value', () => {
  const base = ['--mode', 'phase1', '--packet', 'p.md', '--seat', 'A', '--out', 'brief.txt'];
  assert.equal(parseArgs(base).channel, null);
  assert.equal(parseArgs([...base, '--channel', 'file', '--output-path', 'f.md']).channel, 'file');
  assert.equal(parseArgs([...base, '--channel', 'final-message']).channel, 'final-message');
  assert.throws(() => parseArgs([...base, '--channel', 'file']), /--channel file requires --output-path/);
  assert.throws(() => parseArgs([...base, '--channel', 'final-message', '--output-path', 'f.md']), /--channel final-message cannot be combined with --output-path/);
  assert.throws(() => parseArgs([...base, '--channel', 'stdout']), /--channel must be file or final-message/);
  assert.throws(() => parseArgs([...base, '--channel']), /--channel requires a value/);
  assert.throws(() => parseArgs(['--mode', 'verifier', '--claim', 'c', '--rebuttal', 'r', '--target-dir', 't', '--out', 'o', '--channel', 'final-message']), /--channel is not accepted by --mode verifier/);
  assert.equal(parseArgs(['--mode', 'delta', '--peer-view', 'v.md', '--out', 'o', '--channel', 'file', '--output-path', 'f.md']).channel, 'file');
});

test('build: naming the channel never changes a brief byte, for each role that accepts it', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  const peer = path.join(dir, 'peer-view-for-A.md');
  const audit = path.join(dir, 'audit-input');
  const run = path.join(dir, 'run');
  await fs.mkdir(audit);
  await fs.mkdir(run);
  await fs.writeFile(packet, '# Task\nReview x.js\n');
  await fs.writeFile(peer, '## P1 — claim\nSeverity: LOW\n');
  await fs.writeFile(path.join(audit, 'X-findings.md'), '# Seat X findings\n\n## No findings\n');
  const roles = {
    phase1: { mode: 'phase1', packet, seat: 'A' },
    delta: { mode: 'delta', peerView: peer },
    auditor: { mode: 'auditor', packet, auditDir: audit, targetDir: dir, runDir: run, sourceDirs: [] },
  };
  for (const [name, role] of Object.entries(roles)) {
    const file = path.join(dir, `${name}-out.md`);
    const unnamed = await build({ ...role, out: path.join(dir, `${name}-a.txt`), outputPath: null, channel: null });
    const named = await build({ ...role, out: path.join(dir, `${name}-b.txt`), outputPath: null, channel: 'final-message' });
    assert.equal(named, unnamed, `${name}: final-message`);
    const unnamedFile = await build({ ...role, out: path.join(dir, `${name}-c.txt`), outputPath: file, channel: null });
    const namedFile = await build({ ...role, out: path.join(dir, `${name}-d.txt`), outputPath: file, channel: 'file' });
    assert.equal(namedFile, unnamedFile, `${name}: file`);
    assert.ok(namedFile.includes(file) && !unnamed.includes(file), `${name}: only the file channel names a path`);
  }
});

test('build auditor: a task packet that names the run directory through a link is refused, whichever spelling --run-dir was given in', async (t) => {
  const run = await fs.realpath(await tmp(t));
  const audit = await tmp(t);
  const outDir = await tmp(t);
  const linked = path.join(await tmp(t), 'run-link');
  try {
    await fs.symlink(run, linked, 'junction');
  } catch (err) {
    t.skip(`cannot create symlinks here: ${err.code}`);
    return;
  }
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const base = { mode: 'auditor', packet, auditDir: audit, targetDir: audit, runDir: run, out: path.join(outDir, 'a.txt') };
  // --run-dir is the real path, the packet says it through the link (/tmp/x for /private/tmp/x on macOS)
  await fs.writeFile(packet, `Logs: ${path.join(linked, 'preflight.json.logs')}\n`);
  await assert.rejects(build(base), /task packet .*names the run directory .*resolves into it/);
  // --run-dir is the link, the packet says the real path
  await fs.writeFile(packet, `Logs: ${path.join(run, 'preflight.json.logs')}\n`);
  await assert.rejects(build({ ...base, runDir: linked }), /task packet .*names the run directory/);
  // a path elsewhere, and prose that merely contains a slash, are fine
  await fs.writeFile(packet, `Logs: ${path.join(audit, 'logs')}\nSee and/or the docs.\n`);
  await build(base);
});

test('Mac round 4 F8: a packet citing the run folder as ~/... or ../... (from the target) is refused, in phase1 and auditor mode', async (t) => {
  const home = await fs.realpath(await tmp(t));
  const run = path.join(home, 'reviews', 'run1');
  const target = path.join(home, 'target');
  const audit = path.join(home, 'audit-input');
  const outDir = path.join(home, 'out');
  for (const d of [path.join(run, 'phase1'), target, audit, outDir]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const packet = path.join(audit, 'task-packet.md');
  const auditor = { mode: 'auditor', packet, auditDir: audit, targetDir: target, runDir: run, out: path.join(outDir, 'a.txt') };
  const phase1 = { mode: 'phase1', packet, seat: 'A', targetDir: target, runDir: run, out: path.join(outDir, 'p.txt'), outputPath: null, channel: 'final-message' };
  for (const cite of ['~/reviews/run1/phase1/B-findings.md', '../reviews/run1/preflight.json.logs']) {
    await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
    await assert.rejects(build(auditor), /task packet .*names the run directory .*resolves into it/, `auditor ${cite}`);
    await assert.rejects(build(phase1), /task packet .*names the run directory .*resolves into it/, `phase1 ${cite}`);
  }
  await fs.writeFile(packet, 'Pre-flight log: ~/elsewhere/logs and ../target-notes/x.md\n');
  await build(auditor);
  // Closing round 4 F8: a relative path that starts with a folder name and walks up through "..". Linux round linux-r1
  // F2: the reader's working folder written as $PWD, ${PWD} or /proc/self/cwd, and a named user's home.
  const me = os.userInfo().username;
  for (const cite of ['docs/../../reviews/run1/preflight.json.logs', 'src\\a\\..\\..\\..\\reviews\\run1\\since.diff', '(docs/x/../../../reviews/run1/phase1)', '$PWD/../reviews/run1/phase1/B-findings.md', '${PWD}/../reviews/run1/since.diff', '/proc/self/cwd/../reviews/run1/phase1', '/proc/thread-self/cwd/../reviews/run1/x.md', `~${me}/reviews/run1/phase1/B-findings.md`]) {
    await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
    await assert.rejects(build(auditor), /task packet .*names the run directory .*resolves into it/, `auditor ${cite}`);
    await assert.rejects(build(phase1), /task packet .*names the run directory .*resolves into it/, `phase1 ${cite}`);
  }
  await fs.writeFile(packet, 'Pre-flight log: docs/../src/a.js and docs/../../target/b.js and a/b/c.md and runs..x/y\n');
  await build(auditor);
  // Closing round 5 F4: the same path in any markdown wrapping or right after punctuation.
  const up = 'docs/../../reviews/run1/phase1';
  for (const cite of [`**${up}**`, `*${up}*`, `_${up}_`, `__${up}__`, `~~${up}~~`, `|${up}|`, `>${up}`, `(${up})`, `[${up}]`, `{${up}}`, `+${up}`, `:${up}`, `${up}.`, `"${up}"`, `\`${up}\``, `-${up}`]) {
    await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
    await assert.rejects(build(auditor), /task packet .*names the run directory .*resolves into it/, `auditor ${cite}`);
  }
  await fs.writeFile(packet, 'Pre-flight log: a/docs/../../reviews/run1/x and **a/docs/../../reviews/run1/x**\n');
  await build(auditor);
  // Mac round 5 F3: $HOME / ${TMPDIR} / %TEMP% spellings, and a relative path in a brief built by hand (no --target-dir).
  const savedTemp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP };
  process.env.TMPDIR = home;
  process.env.TEMP = home;
  t.after(() => { for (const [k, v] of Object.entries(savedTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  for (const cite of ['$HOME/reviews/run1/phase1/B-findings.md', '${TMPDIR}/reviews/run1/preflight.json.logs', '%TEMP%\\reviews\\run1\\since.diff', '$env:TEMP\\reviews\\run1\\since.diff']) {
    await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
    await assert.rejects(build(auditor), /task packet .*names the run directory .*resolves into it/, `auditor ${cite}`);
  }
  // Fix review B2: without --target-dir a relative path is not resolved at all (the current folder may be the run folder,
  // where "./src/a.js" would be refused for nothing); the documented commands always pass --target-dir.
  await fs.writeFile(packet, 'Review ./src/a.js in the target.\n');
  const cwd = process.cwd();
  process.chdir(run);
  try {
    await build({ ...phase1, targetDir: null });
  } finally {
    process.chdir(cwd);
  }
});

test('Round 5 F1/F2: a run folder with a space, and the ${env:X} and %HOMEDRIVE%%HOMEPATH% spellings, are refused in phase1, auditor and rules', async (t) => {
  const home = await fs.realpath(await tmp(t));
  const run = path.join(home, 'run space');
  const target = path.join(home, 'target');
  const audit = path.join(home, 'audit-input');
  const outDir = path.join(home, 'out');
  for (const d of [path.join(run, 'phase1'), target, audit, outDir]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const keys = ['TEMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.TEMP = home;
  process.env.USERPROFILE = home;
  // Round 6 F5: "~" is the home folder on every platform (os.homedir reads HOME on Linux and macOS).
  process.env.HOME = home;
  const drive = /^[A-Za-z]:/.exec(home)?.[0] ?? '';
  process.env.HOMEDRIVE = drive;
  process.env.HOMEPATH = home.slice(drive.length);
  const packet = path.join(audit, 'task-packet.md');
  const rules = path.join(outDir, 'REVIEW.md');
  await fs.writeFile(rules, 'Rules.\n');
  const auditor = { mode: 'auditor', packet, auditDir: audit, targetDir: target, runDir: run, out: path.join(outDir, 'a.txt') };
  const phase1 = { mode: 'phase1', packet, seat: 'A', targetDir: target, runDir: run, out: path.join(outDir, 'p.txt'), outputPath: null, channel: 'final-message' };
  const cites = ['%TEMP%/run space/phase1/B-findings.md', '$env:TEMP/run space/phase1/B-findings.md', '../run space/phase1/B-findings.md', '~/run space/x.log'];
  if (process.platform === 'win32') cites.push('${env:USERPROFILE}\\run space\\x.log', '%HOMEDRIVE%%HOMEPATH%\\run space\\x.log', '${env:USERPROFILE}\\run space-x\\..\\run space\\x.log');
  for (const cite of cites) {
    await fs.writeFile(packet, `Pre-flight log: ${cite} for details.\n`);
    await assert.rejects(build(phase1), /names the run directory/, `phase1 ${cite}`);
    await assert.rejects(build(auditor), /names the run directory/, `auditor ${cite}`);
    await fs.writeFile(packet, 'Packet.\n');
    await fs.writeFile(rules, `Read ${cite} first.\n`);
    await assert.rejects(build({ ...auditor, rules }), /review rules .*name the run directory/, `rules ${cite}`);
    await fs.writeFile(rules, 'Rules.\n');
  }
  // A sibling folder that only starts with the same words is not the run folder.
  await fs.writeFile(packet, 'Notes: %TEMP%/run spaces/x.md and ../run-space/y.md\n');
  await build(phase1);
  // The same spellings through a link or junction to the run folder's parent resolve into it too (real paths compared).
  const linkedRun = path.join(home, 'reviews', 'run1');
  await fs.mkdir(path.join(linkedRun, 'phase1'), { recursive: true });
  try {
    await fs.symlink(path.join(home, 'reviews'), path.join(home, 'jl'), 'junction');
  } catch (err) {
    t.diagnostic(`no link here (${err.code}); link spellings not checked`);
    return;
  }
  for (const cite of ['~/jl/run1/phase1/B-findings.md', '../jl/run1/phase1/B-findings.md', '$HOME/jl/run1/phase1/B-findings.md']) {
    await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
    await assert.rejects(build({ ...phase1, runDir: linkedRun }), /names the run directory .*resolves into it/, `linked ${cite}`);
  }
  // Round 6 F8: a run folder with a space reached through the junction, written absolute, through %TEMP% or ../.
  const spacedRun = path.join(home, 'reviews', 'run space');
  await fs.mkdir(path.join(spacedRun, 'phase1'), { recursive: true });
  for (const cite of [path.join(home, 'jl', 'run space', 'phase1', 'B-findings.md'), '%TEMP%/jl/run space/phase1/B-findings.md', '../jl/run space/phase1/B-findings.md']) {
    await fs.writeFile(packet, `Pre-flight log: ${cite} for details.\n`);
    await assert.rejects(build({ ...phase1, runDir: spacedRun }), /names the run directory .*resolves into it/, `junction ${cite}`);
    await assert.rejects(build({ ...auditor, runDir: spacedRun }), /names the run directory/, `auditor junction ${cite}`);
  }
  // Round 6 F1: the Phase 1 brief checks the review rules too.
  await fs.writeFile(packet, 'Packet.\n');
  await fs.writeFile(rules, `Read ${path.join(home, 'jl', 'run space', 'run.json')} first.\n`);
  await assert.rejects(build({ ...phase1, runDir: spacedRun, rules }), /review rules .*name the run directory/);
  await fs.writeFile(rules, 'Rules.\n');
  // Round 6 F9: the braced PowerShell pair, %HOMEPATH% alone, a drive-less root and a file:/// URL with %20.
  if (process.platform === 'win32') {
    const fwd = home.replace(/\\/g, '/');
    // Round 7 F3: a rooted file URL ("file:///Users/...", the Linux and macOS form) keeps its root.
    const rooted = `file://${home.slice(2).replace(/\\/g, '/').replace(/ /g, '%20')}/run%20space/x.log`;
    for (const cite of ['${env:HOMEDRIVE}${env:HOMEPATH}\\run space\\x.log', '%HOMEPATH%\\run space\\x.log', `${home.slice(2)}\\run space\\x.log`, `file:///${fwd.replace(/ /g, '%20')}/run%20space/x.log`, rooted]) {
      await fs.writeFile(packet, `Pre-flight log: ${cite}\n`);
      await assert.rejects(build(phase1), /names the run directory/, `spelling ${cite}`);
    }
    // A Git Bash path outside the run folder is accepted, also with no --target-dir ("/c" is the drive root, not the
    // current folder on drive C).
    const outside = `/${home[0].toLowerCase()}/Windows/explorer.exe`;
    await fs.writeFile(packet, `Pre-flight log: ${outside} for details.\n`);
    const cwd = process.cwd();
    process.chdir(run);
    try {
      await build({ ...phase1, targetDir: null });
    } finally {
      process.chdir(cwd);
    }
  }
});

test('field northwind-1a and round 4: a seat that writes a findings file gets its own scratch folder beside it, never named with its seat letter; a seat that returns text writes no file', async (t) => {
  const dir = await tmp(t);
  const packet = path.join(dir, 'task-packet.md');
  const run = path.join(dir, 'run');
  for (const sub of ['A', 'B']) await fs.mkdir(path.join(run, 'phase1', sub), { recursive: true });
  await fs.writeFile(packet, '# Task\nReview x.js; scratch in rv-scratch\n');
  const folder = (text) => /^Your own scratch folder \(create it when you first need it\): (.+)$/m.exec(text)?.[1];
  const brief =(seat, outputPath, out = path.join(run, 'phase1', `brief-${seat}.txt`)) => build({ mode: 'phase1', packet, seat, runDir: run, out, outputPath, channel: outputPath ? 'file' : 'final-message' });
  const a = await brief('A', path.join(run, 'phase1', 'A-findings.md'));
  const b = await brief('B', path.join(run, 'phase1', 'B-findings.md'));
  const [fa, fb] = [folder(a), folder(b)];
  assert.ok(fa && fb, 'both native briefs name a scratch folder');
  assert.notEqual(fa, fb);
  for (const f of [fa, fb]) {
    assert.equal(path.dirname(f), path.join(run, 'phase1'));
    assert.match(path.basename(f), /^scratch-[0-9a-f]{8}$/, 'no seat letter in the name');
  }
  assert.match(a, /never delete or overwrite a file or folder you did not create/);
  assert.match(a, /cite a scratch file by its name only, never by its folder path/);
  assert.equal(folder(await brief('A', path.join(run, 'phase1', 'A-findings.md'), path.join(run, 'phase1', 'brief-A2.txt'))), fa, 'a rebuilt brief keeps its folder');
  assert.equal(existsSync(fa), false, 'the seat creates it, not the brief builder');
  // Round 4 F4: a CLI seat may write only its own output folder, so its scratch folder is inside it.
  const cli = path.join(run, 'phase1', 'seat-A', 'A-findings.md');
  assert.equal(path.dirname(folder(await brief('A', cli, path.join(run, 'phase1', 'A', 'brief.txt')))), path.dirname(cli));
  // Round 4 F4/F5: a seat that returns its findings as text (a read-only Codex seat, a hand-built brief with no --output-path) has no folder.
  const text = await brief('B', null, path.join(run, 'phase1', 'B', 'brief.txt'));
  assert.equal(folder(text), undefined);
  assert.match(text, /You have no scratch folder: create, change or delete no file anywhere/);
});

test('Run-folder guard matrix: every spelling of a file in the run folder, direct or through a junction, with and without a space, is refused in the phase1 and auditor packet and rules; siblings and the parent are not', async (t) => {
  const home = await fs.realpath(await tmp(t));
  const reviews = path.join(home, 'reviews');
  const target = path.join(home, 'target');
  const audit = path.join(home, 'audit-input');
  const outDir = path.join(home, 'out');
  const siblingsOf = { 'run1': ['run12', 'run1-evidence'], 'run space': ['run space2', 'run-space', 'run spaces'] };
  for (const [name, sibs] of Object.entries(siblingsOf)) {
    await fs.mkdir(path.join(reviews, name, 'phase1'), { recursive: true });
    await fs.writeFile(path.join(reviews, name, 'phase1', 'B-findings.md'), 'x');
    for (const s of sibs) await fs.mkdir(path.join(reviews, s), { recursive: true });
  }
  for (const d of [target, audit, outDir]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const keys = ['TEMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.TEMP = home;
  process.env.TMPDIR = home;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const drive = /^[A-Za-z]:/.exec(home)?.[0] ?? '';
  process.env.HOMEDRIVE = drive;
  process.env.HOMEPATH = home.slice(drive.length);
  const reaches = ['reviews'];
  try {
    await fs.symlink(reviews, path.join(home, 'jl'), 'junction');
    reaches.push('jl');
  } catch (err) {
    t.diagnostic(`no link here (${err.code}); junction rows not checked`);
  }
  const win = process.platform === 'win32';
  const BS = String.fromCharCode(92);
  // Every spelling of home/<segments>, as [label, text].
  const spellings = (rel) => {
    const abs = path.join(home, ...rel);
    const fwd = abs.split(BS).join('/');
    const back = rel.join(BS);
    const slash = rel.join('/');
    const rows = [['absolute', abs], ['forward slashes', fwd]];
    if (win) rows.push(['git bash', fwd.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)]);
    rows.push(['%TEMP%', `%TEMP%${BS}${back}`], ['$env:TEMP', `$env:TEMP${BS}${back}`], ['${env:TEMP}', '$' + `{env:TEMP}${BS}${back}`],
      ['$HOME', `$HOME/${slash}`], ['~', `~/${slash}`], ['../ from target', `../${slash}`],
      ['file url', `file://${win ? '/' : ''}${fwd.replace(/ /g, '%20')}`],
      ['walks back with ..', `${path.join(home, 'target')}${path.sep}..${path.sep}${rel.join(path.sep)}`]);
    if (win) rows.push(['%HOMEPATH%', `%HOMEPATH%${BS}${back}`], ['%HOMEDRIVE%%HOMEPATH%', `%HOMEDRIVE%%HOMEPATH%${BS}${back}`]);
    return rows;
  };
  const packet = path.join(audit, 'task-packet.md');
  const rules = path.join(outDir, 'REVIEW.md');
  const places = {
    'phase1 packet': (runDir) => ({ file: packet, args: { mode: 'phase1', packet, seat: 'A', targetDir: target, runDir, out: path.join(outDir, 'p.txt'), outputPath: null, channel: 'final-message' } }),
    'phase1 rules': (runDir) => ({ file: rules, args: { mode: 'phase1', packet, seat: 'A', targetDir: target, runDir, rules, out: path.join(outDir, 'p.txt'), outputPath: null, channel: 'final-message' } }),
    'auditor packet': (runDir) => ({ file: packet, args: { mode: 'auditor', packet, auditDir: audit, targetDir: target, runDir, out: path.join(outDir, 'a.txt') } }),
    'auditor rules': (runDir) => ({ file: rules, args: { mode: 'auditor', packet, auditDir: audit, targetDir: target, runDir, rules, out: path.join(outDir, 'a.txt') } }),
  };
  const refused = /names the run directory|name the run directory/;
  const failures = [];
  let rows = 0;
  const check = async (label, place, runDir, cite, mustRefuse) => {
    rows++;
    const { file, args } = places[place](runDir);
    await fs.writeFile(packet, 'Packet.\n');
    await fs.writeFile(rules, 'Rules.\n');
    await fs.writeFile(file, `Pre-flight log: ${cite} for details.\n`);
    try {
      if (mustRefuse) await assert.rejects(build(args), refused);
      else await build(args);
    } catch (err) {
      failures.push(`${mustRefuse ? 'NOT REFUSED' : 'WRONGLY REFUSED'} [${label}] ${place}: ${cite} (${err.message.split('\n')[0]})`);
    }
  };
  for (const [name, sibs] of Object.entries(siblingsOf)) {
    const runDir = path.join(reviews, name);
    for (const via of reaches) {
      for (const place of Object.keys(places)) {
        for (const [how, cite] of spellings([via, name, 'phase1', 'B-findings.md'])) await check(`${name} via ${via}, ${how}`, place, runDir, cite, true);
        for (const other of [...sibs.map((s) => [via, s, 'x.md']), [via]]) {
          for (const [how, cite] of spellings(other)) await check(`not ${name}: ${other.join('/')}, ${how}`, place, runDir, cite, false);
        }
      }
    }
  }
  t.diagnostic(`${rows} rows checked`);
  assert.deepEqual(failures, [], `${failures.length} of ${rows} rows failed:\n${failures.join('\n')}`);
});

test('Linux round linux-r2 F5: the guard reads the run folder\'s letter case when it runs, not when the module loaded', async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const { setFoldsCase } = await import('../path-utils.mjs');
  const run = path.join(await tmp(t), 'Run');
  await fs.mkdir(run);
  t.after(() => setFoldsCase(null));
  // Glued to a prefix the path-start rule does not take, so only the as-written comparison can see it.
  const text = `ssh://h${run.toLowerCase()}/phase1/x`;
  setFoldsCase(true);
  assert.notEqual(runDirNamedIn(text, run), null, 'a folding run folder: another case names it');
  setFoldsCase(false);
  assert.equal(runDirNamedIn(text, run) !== null, process.platform === 'win32', 'case-sensitive (Windows always folds)');
});

test('Linux round linux-r2 F6: a relative spelling read from a CLI seat\'s snapshot in the OS temp folder is refused too', async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'run-beside-worktrees-'));
  // Deeper than the run folder's parent, so "../<run>" from the target itself names another folder.
  const target = path.join(await tmp(t), 'deep', 'target');
  await fs.mkdir(target, { recursive: true });
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.writeFile(path.join(run, 'phase1', 'B-findings.md'), 'x');
  const name = path.basename(run);
  for (const cite of [`../${name}/phase1/B-findings.md`, `$PWD/../${name}/phase1/B-findings.md`, `docs/../../${name}/phase1`]) {
    assert.notEqual(runDirNamedIn(`Evidence: \`${cite}\``, run, target), null, cite);
  }
  assert.equal(runDirNamedIn('Evidence: `../elsewhere/notes.md`', run, target), null, 'another folder beside the snapshots is fine');
});

test('Linux round linux-r3 A1, A2, B1: a link followed by "..", a quoted part, a path glued to an option and the shell\'s own working-folder forms name the run folder too', async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const root = await tmp(t);
  const run = path.join(root, 'side', 'R');
  const target = path.join(root, 'tgt');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(path.join(root, 'side', 'sub'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  const sideRel = path.relative(target, path.join(root, 'side')).split(path.sep).join('/');
  const hits = [
    `"${path.join(root, 'side')}"/R/phase1`, `'${path.join(root, 'side')}'/R/phase1`, `${path.join(root, 'side')}/"R"/phase1`,
    `git -C${run} status`, `git -C${path.join(root, 'side')}/R/. status`, `--out=${run}/x`, `git -C../${sideRel.replace(/^\.\.\//, '')}/R status`,
    `~+/${sideRel}/R/phase1`, `$(pwd)/${sideRel}/R/phase1`, '`pwd`/' + `${sideRel}/R/phase1`,
    // Linux round linux-r4 A2, A4 and Windows round win-r4 A1, A2: quotes around the form, option clusters, other shells.
    '"`pwd`"/' + `${sideRel}/R/phase1`, '-C"`pwd`"/' + `${sideRel}/R/phase1`, `tar -czf${sideRel}/R/out.tgz`, `tar -xzf${sideRel}/R/x.tgz`, `git -Cdocs/../${sideRel}/R status`,
    // Linux round linux-r5 A1: an option cluster before a rooted, quoted or "./" path that walks up.
    `tar -cf${path.join(root, 'side', 'sub')}/../R/out.tgz`, `tar -xf"$PWD"/${sideRel}/sub/../R/x`, `tar -cf./docs/../${sideRel}/R/x`,
    `$pwd/${sideRel}/R/phase1`, `\${pwd}/${sideRel}/R/phase1`, `%CD%/${sideRel}/R/phase1`, `$(Get-Location)/${sideRel}/R/phase1`, `$(pwd -W)/${sideRel}/R/phase1`,
  ];
  for (const text of hits) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
  let linked = true;
  await fs.symlink(path.join(root, 'side', 'sub'), path.join(target, 'docs'), 'dir').catch(() => { linked = false; });
  if (linked) {
    assert.notEqual(runDirNamedIn('Evidence: docs/../R/phase1', run, target), null, 'a link followed by ".." lands where the link points');
    assert.equal(runDirNamedIn('Evidence: docs/../sub', run, target), null, 'a sibling through the same link is fine');
    // Linux round linux-r5 A4: a linked folder whose name has a space.
    // Its last word is no link of its own: only the whole spaced name leads to the run folder.
    await fs.symlink(path.join(root, 'side', 'sub'), path.join(target, 'my notes'), 'dir');
    for (const text of [`"${target}/my notes/../R/phase1"`, `${target}/my notes/../R/phase1`, './my notes/../R/phase1']) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
  } else t.diagnostic('no symlink here: the link case is not checked');
  if (process.platform === 'linux') {
    const { spawn } = await import('node:child_process');
    const sleeper = spawn('sleep', ['30'], { cwd: path.join(root, 'side', 'sub'), stdio: 'ignore' });
    t.after(() => sleeper.kill('SIGKILL'));
    assert.notEqual(runDirNamedIn(`Evidence: /proc/${sleeper.pid}/cwd/../R/phase1`, run, target), null, 'a numeric /proc cwd followed by ".."');
  }
  for (const text of ['git -Cfoo status', `--name=value`, `"quoted words" and 'more'`]) assert.equal(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
});

test('Windows round win-r3 A1, B1: Git Bash\'s /tmp spelling and a drive-relative path ("C:../x") name the run folder too', { skip: process.platform !== 'win32' }, async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const { scrubDir } = await import('../path-utils.mjs');
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'rv-guard-'));
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  const name = path.basename(run);
  const target = await tmp(t);
  for (const text of [`See /tmp/${name}/phase1 for logs.`, `See \`/tmp/${name}\` for logs.`]) assert.notEqual(runDirNamedIn(text, run, target), null, text);
  assert.equal(runDirNamedIn('See /tmp/rv-guard-other/x for logs.', run, target), null, 'another folder under /tmp');
  assert.equal(scrubDir(`cat /tmp/${name}/phase1/B-findings.md`, run).count, 1, 'the scrub knows the /tmp spelling too');
  // The run folder beside the target on the same drive, named from the target's drive-relative current folder.
  const side = path.join(path.dirname(target), 'side-run');
  await fs.mkdir(path.join(side, 'phase1'), { recursive: true });
  t.after(() => fs.rm(side, { recursive: true, force: true }));
  const drive = target[0];
  for (const text of [`${drive}:../side-run/phase1`, `${drive}:..\\side-run\\phase1`]) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, side, target), null, text);
  assert.equal(runDirNamedIn(`Evidence: ${drive}:../elsewhere/x`, side, target), null, 'another folder');
  // Windows round win-r4 A2: a Windows switch glued to a relative path.
  for (const text of ['robocopy a b /LOG:..\\side-run\\x.log', 'cl /Fo..\\side-run\\x.obj', 'cl /Fe:..\\side-run\\x.exe', 'robocopy a b /LOG+:..\\side-run\\x.log', 'robocopy a b /UNILOG+:..\\side-run\\x.log', 'csc -out:..\\side-run\\x.exe', 'Get-Item -Path:..\\side-run', 'cl /Fo.\\..\\side-run\\x.obj', 'cl /Fodocs\\..\\..\\side-run\\x']) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, side, target), null, text);
  assert.equal(runDirNamedIn('Evidence: robocopy a b /LOG:..\\elsewhere\\x.log', side, target), null, 'a switch to another folder');
  // Windows round win-r6 A1: a rooted forward-slash path that walks up is still read as a path, not split as a switch.
  const up = path.relative(path.parse(target).root, side).split(path.sep);
  for (const text of [`/${up.join('/')}/../side-run/phase1`, `/${up.slice(0, -1).join('/')}/x/../side-run/phase1`]) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, side, target), null, text);
  // Windows round win-r4 B3: a drive-relative path glued to an option.
  for (const text of [`tar -C${drive}:../side-run -tf x.tar`, `tar -C${drive}:..\\side-run -tf x.tar`]) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, side, target), null, text);
});

test('Linux round linux-r6 A2: a backslash-escaped space in the run folder\'s path names it too', { skip: process.platform === 'win32' }, async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const root = await tmp(t);
  const run = path.join(root, 'my side', 'R');
  const target = path.join(root, 'tgt');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  const escaped = root.replace(/ /g, '\\ ');
  for (const text of [`${escaped}/my\\ side/R/phase1`, `cat ${escaped}/my\\ side/R/phase1/B-findings.md`, '../my\\ side/R/phase1']) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
  assert.equal(runDirNamedIn('Evidence: ../my\\ other/R/phase1', run, target), null, 'another folder');
});

test('Windows round win-r6 B3: a quoted relative path whose first folder name has a space and is a link, walking up, names the run folder', async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const root = await tmp(t);
  const run = path.join(root, 'side', 'R');
  const target = path.join(root, 'tgt');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(path.join(root, 'side', 'sub'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.symlink(path.join(root, 'side', 'sub'), path.join(target, 'All Users'), process.platform === 'win32' ? 'junction' : 'dir');
  // Linux round linux-r7 A2, Windows round win-r7 A1: also after an apostrophe on the line and inside inline code.
  for (const text of ['cat "All Users/../R/phase1/x"', "cat 'All Users/../R/phase1/x'", "it's in 'All Users/../R/phase1/x'", 'see `All Users/../R/phase1/x`']) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
  // Linux round linux-r7 B1, Windows round win-r7 B1: the shell's own spellings of that path.
  for (const text of ['cat All\\ Users/../R/phase1/x', 'cat "All Users"/../R/phase1/x', "cat 'All Users'/../R/phase1/x"]) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
  assert.equal(runDirNamedIn('Evidence: cat "All Users/../sub/x"', run, target), null, 'another folder through the same link');
});

test('Linux round linux-r7 A1: a backslash before any character in the run folder\'s path is read as bash reads it', { skip: process.platform === 'win32' }, async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const root = await tmp(t);
  const run = path.join(root, 'a@b:c=d,e^f', 'R');
  const target = path.join(root, 'tgt');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  for (const text of [`${root}/a\\@b\\:c\\=d\\,e\\^f/R/phase1`, '../a\\@b\\:c\\=d\\,e\\^f/R/phase1']) assert.notEqual(runDirNamedIn(`Evidence: ${text}`, run, target), null, text);
});

test('Windows round win-r7 B1: an escaped space in an absolute run-folder path names it on every platform', async (t) => {
  const { runDirNamedIn } = await import('../build-brief.mjs');
  const root = await tmp(t);
  const run = path.join(root, 'my side', 'R');
  const target = path.join(root, 'tgt');
  await fs.mkdir(path.join(run, 'phase1'), { recursive: true });
  await fs.mkdir(target, { recursive: true });
  const fwd = root.replace(/\\/g, '/').replace(/ /g, '\\ ');
  assert.notEqual(runDirNamedIn(`Evidence: cat ${fwd}/my\\ side/R/phase1/x`, run, target), null);
});

test('build auditor: the brief names the fields translate refuses a claim ID in, and says auditor_check.evidence is neither checked nor rewritten', async (t) => {
  const audit = await tmp(t);
  const run = await tmp(t);
  const packet = path.join(audit, 'task-packet.md');
  await fs.writeFile(packet, 'packet');
  await fs.writeFile(path.join(audit, 'X-findings.md'), 'x');
  const text = await build(parseArgs(['--mode', 'auditor', '--packet', packet, '--audit-dir', audit, '--target-dir', audit, '--run-dir', run, '--out', path.join(await tmp(t), 'auditor.txt')]));
  assert.match(text, /In summary, recommended_fix, auditor_check\.evidence, auditor_check\.reason and auditor_check\.severity_reason never write a claim ID/);
  assert.match(text, /The translate step refuses one in summary, recommended_fix, title, auditor_check\.reason and auditor_check\.severity_reason; auditor_check\.evidence is neither checked nor rewritten/);
  assert.doesNotMatch(text, /The translate step refuses otherwise/);
});
