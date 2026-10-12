import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, splitSections, diffSummary, findingHypothesis, buildRecheckPacket, rewritePaths, dropTagFromPacket } from '../build-recheck-packet.mjs';

const SCRIPT = fileURLToPath(new URL('../build-recheck-packet.mjs', import.meta.url));
const NL = String.fromCharCode(10);
const lines = (...l) => l.join(NL) + NL;

const OLD_PACKET = lines(
  '# Task packet (run 5, re-review): Reporter changes for six tickets', '',
  'Profile: Code. Target: C:/repo.', '',
  '## Scope', '- In scope: the diffs.', '',
  '## What changed since run 4 (the fixes to judge)', '- old change list', '',
  '## Acceptance criteria (tagged)', '- [AC-1] Keeps Unknown.', '',
  '## Known deviations from the criteria', 'Deviation 1.', '',
  '## Evidence both seats may cite (run once)', 'HEAD abc, snapshotHash 123, 47 passed.', '',
  "## Hypotheses to test (author's, unverified)", '- [H1] Old hypothesis one.', '- [H2] Old hypothesis two.', '',
  '## Output', 'Findings in the schema.',
);

const FINDINGS = {
  findings: [
    { id: 'F1', severity: 'MEDIUM', final_state: 'settled-agree', summary: 'The disclosed reason is wrong. More text follows here.' },
    { id: 'F2', severity: 'LOW', severity_audited: 'HIGH', final_state: 'unresolved-high-stakes', summary: 'x'.repeat(300) },
  ],
};

const DIFF = lines(
  'diff --git a/A/Reporter.py b/A/Reporter.py', '--- a/A/Reporter.py', '+++ b/A/Reporter.py', '@@ -1 +1,2 @@', '-old', '+new', '+newer',
  'diff --git a/B/Parser.py b/B/Parser.py', '--- a/B/Parser.py', '+++ b/B/Parser.py', '@@ -0,0 +1 @@', '+one',
);

test('splitSections: preamble and ## sections in order', () => {
  const { preamble, sections } = splitSections(OLD_PACKET);
  assert.match(preamble, /^# Task packet/);
  assert.deepEqual(sections.map((s) => s.title), ['Scope', 'What changed since run 4 (the fixes to judge)', 'Acceptance criteria (tagged)', 'Known deviations from the criteria', 'Evidence both seats may cite (run once)', "Hypotheses to test (author's, unverified)", 'Output']);
});

test('diffSummary: files with added and removed line counts, headers not counted', () => {
  assert.deepEqual(diffSummary(DIFF), [{ path: 'A/Reporter.py', added: 2, removed: 1 }, { path: 'B/Parser.py', added: 1, removed: 0 }]);
  assert.deepEqual(diffSummary(''), []);
});

test('findingHypothesis: id, audited severity, state, short title', () => {
  assert.equal(findingHypothesis(FINDINGS.findings[0], 1), '- [H1] Previous finding F1 (medium, settled-agree): The disclosed reason is wrong. Confirm it is fixed, or refute it with evidence.');
  const second = findingHypothesis(FINDINGS.findings[1], 2);
  assert.match(second, /^- \[H2\] Previous finding F2 \(high, unresolved-high-stakes\): x+\.\.\. Confirm/);
  assert.ok(second.length < 260);
});

test('buildRecheckPacket: old findings become the only hypotheses, stale sections are replaced, the rest is kept', () => {
  const { text, fills } = buildRecheckPacket({ oldPacket: OLD_PACKET, findingsDoc: FINDINGS, diffText: DIFF, previousRun: 'the review in run-5' });
  assert.match(text, /^# Task packet: re-review of Reporter changes for six tickets/);
  assert.match(text, /This is a re-review of the review in run-5\./);
  assert.equal((text.match(/^## Hypotheses to test/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /Old hypothesis/);
  assert.match(text, /## Hypotheses to test\nIn `## Checks performed`, end each hypothesis line with CONFIRMED, REFUTED or PARTLY CONFIRMED/);
  assert.match(text, /- \[H1\] Previous finding F1 \(medium/);
  assert.match(text, /- \[H2\] Previous finding F2 \(high/);
  assert.equal((text.match(/^## What changed since/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /old change list|run 4/);
  assert.match(text, /- A\/Reporter\.py \(\+2 -1\)/);
  assert.match(text, /- B\/Parser\.py \(\+1 -0\)/);
  assert.doesNotMatch(text, /snapshotHash 123|47 passed/);
  assert.match(text, /## Evidence both seats may cite\nFILL:/);
  assert.match(text, /- \[AC-1\] Keeps Unknown\./, 'criteria are kept');
  assert.match(text, /Deviation 1\.\nFILL: which of these deviations still apply/);
  assert.match(text, /## Output\nFindings in the schema\./);
  assert.deepEqual(fills.map((f) => f.text.slice(0, 12)), ['FILL: why ea', 'FILL: which ', 'FILL: this r', 'FILL: result']);
  assert.ok(text.indexOf('## What changed since') < text.indexOf('## Acceptance criteria'), 'the change list sits right after Scope');
});

test('buildRecheckPacket: no diff gives a FILL line, no findings gives a FILL hypothesis, a missing Hypotheses section is appended', () => {
  const bare = lines('# Task packet: thing', '', '## Scope', '- x');
  const { text, fills } = buildRecheckPacket({ oldPacket: bare, findingsDoc: { findings: [] }, diffText: '' });
  assert.match(text, /- FILL: the files changed since the previous review/);
  assert.match(text, /## Hypotheses to test\n- FILL: the previous review had no findings/);
  assert.equal(fills.length, 3);
  assert.throws(() => buildRecheckPacket({ oldPacket: bare, findingsDoc: {} }), /no "findings" array/);
});

test('parseArgs: --from-run and --out are required', () => {
  assert.throws(() => parseArgs([]), /--from-run/);
  assert.throws(() => parseArgs(['--from-run', 'x']), /--out/);
  assert.throws(() => parseArgs(['--from-run', 'x', '--out', 'y', '--wat']), /unrecognized/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('CLI: writes the draft, lists the FILL markers, and never overwrites its output', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck packet '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  const diff = path.join(dir, 'since.diff');
  await fs.writeFile(diff, DIFF);
  const out = path.join(dir, 'new-packet.md');
  const r = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--since-diff', diff, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 FILL marker\(s\) to complete before the seats start/);
  assert.match(await fs.readFile(out, 'utf8'), /re-review of the review in old-run/);
  const again = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--out', out], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists; it is never overwritten/);
  const missing = spawnSync(process.execPath, [SCRIPT, '--from-run', path.join(dir, 'nope'), '--out', path.join(dir, 'x.md')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(existsSync(path.join(dir, 'x.md')), false);
});

const BS = String.fromCharCode(92);

test('diffSummary: hunk counts decide, so "--" and "++" content lines count; quoted paths decode; plain diff -u works', () => {
  const git = lines(
    'diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1,3 +1,3 @@', ' keep', '--- removed line that starts with dashes', '+++ added line that starts with plus', ' end',
    `diff --git "a/o/caf${BS}303${BS}251.md" "b/o/caf${BS}303${BS}251.md"`, `--- "a/o/caf${BS}303${BS}251.md"`, `+++ "b/o/caf${BS}303${BS}251.md"`, '@@ -1 +1 @@', '-a', '+b',
  );
  assert.deepEqual(diffSummary(git), [{ path: 'x.md', added: 1, removed: 1 }, { path: 'o/café.md', added: 1, removed: 1 }]);
  assert.deepEqual(diffSummary(lines('--- old/f.txt', '+++ new/f.txt', '@@ -1 +1,2 @@', '-a', '+b', '+c')), [{ path: 'new/f.txt', added: 2, removed: 1 }]);
  assert.deepEqual(diffSummary(lines('diff --git a/gone.txt b/gone.txt', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye')), [{ path: 'gone.txt', added: 0, removed: 1 }]);
  assert.deepEqual(diffSummary(lines('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '\ No newline at end of file')), [{ path: 'x', added: 1, removed: 1 }]);
});

test('findingHypothesis: the title does not stop at an abbreviation', () => {
  const f = { id: 'F1', severity: 'HIGH', final_state: 'confirmed', summary: 'Null deref in parse, e.g. on empty input, crashes the run. More text.' };
  assert.match(findingHypothesis(f, 1), /: Null deref in parse, e\.g\. on empty input, crashes the run\. Confirm/);
});

test('CLI: a findings.json with a BOM is read; broken JSON names the file; a diff with no files is an error', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck bom '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'old run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), `﻿${JSON.stringify(FINDINGS)}`);
  const ok = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--out', path.join(dir, 'a.md')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), '{ nope');
  const bad = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--out', path.join(dir, 'b.md')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /the previous findings .*findings\.json is not valid JSON/);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  const empty = path.join(dir, 'empty.diff');
  await fs.writeFile(empty, 'not a diff at all\n');
  const none = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--since-diff', empty, '--out', path.join(dir, 'c.md')], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no changed files found in --since-diff/);
});

test('buildRecheckPacket options: --skip leaves findings out and renumbers, --drop-tag removes a bullet and its Tickets entry, --title replaces the title line', () => {
  const oldPacket = ['# Task packet: pair review of X', '', '## Scope', 's', '', '## Evidence both seats may cite', 'old', '', '## Acceptance criteria', '- [AC-A] one', '- [AC-B] two', '- [AC-C] three', 'Tickets: 6041 = AC-A, AC-B; 6045 = AC-C', ''].join('\n');
  const findingsDoc = { findings: [{ id: 'F1', title: 'One.' }, { id: 'F2', title: 'Two.' }, { id: 'F3', title: 'Three.' }] };
  const { text } = buildRecheckPacket({ oldPacket, findingsDoc, title: 'Re-review of X, round 2', skip: ['F2'], dropTags: ['AC-C', 'AC-B'] });
  assert.match(text, /^# Re-review of X, round 2\n/);
  assert.match(text, /- \[H1\] Previous finding F1/);
  assert.match(text, /- \[H2\] Previous finding F3/);
  assert.doesNotMatch(text, /Previous finding F2/);
  assert.doesNotMatch(text, /\[AC-B\]|\[AC-C\]/);
  assert.match(text, /^Tickets: 6041 = AC-A$/m);
  assert.match(text, /## Author-reported evidence \(not reproducible; do not cite as EXECUTED\)/);
});

test('rewritePaths: both slash styles of the old folder become the new one; CLI --target rewrites the old target and run folder', async (t) => {
  const win = ['C:', 'old', 'run'].join(String.fromCharCode(92));
  assert.equal(rewritePaths(`see ${win} and C:/old/run`, [[win, 'D:/new']]), 'see D:/new and D:/new');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\n## Scope\nReview ${path.join(root, 'old-target')} and notes in ${run}\n`);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: path.join(root, 'old-target') }));
  const out = path.join(root, 'new-run', 'task-packet.md');
  await fs.mkdir(path.dirname(out));
  const r = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--out', out, '--target', path.join(root, 'new-target')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = await fs.readFile(out, 'utf8');
  assert.ok(text.includes(path.join(root, 'new-target')) && text.includes(path.dirname(out)));
  assert.equal(text.includes(path.join(root, 'old-target')) || text.includes(run), false);
});

test('review fixes: --drop-tag leaves other Ticket lines alone, a second re-review drops the old author evidence, rewritePaths respects whole path segments', () => {
  const packet = ['# T', '', '## Evidence both seats may cite', 'x', '', '## Author-reported evidence (not reproducible; do not cite as EXECUTED)', 'I ran it by hand, all fine.', '', '## Acceptance criteria', '- [AC-1] a', '- [AC-2] b', 'Ticket 6041: fixes the login flow', 'Tickets: 6041 = AC-1, AC-2; 6045 = AC-3', ''].join(String.fromCharCode(10));
  const { text } = buildRecheckPacket({ oldPacket: packet, findingsDoc: { findings: [] }, dropTags: ['AC-2'] });
  assert.match(text, /^Ticket 6041: fixes the login flow$/m);
  assert.match(text, /^Tickets: 6041 = AC-1; 6045 = AC-3$/m);
  assert.equal((text.match(/Author-reported evidence/g) ?? []).length, 1);
  assert.doesNotMatch(text, /I ran it by hand/);
  assert.equal(rewritePaths('C:/runs/r1/x and C:/runs/r10/x and C:/runs/r1.', [['C:/runs/r1', 'C:/runs/r2']]), 'C:/runs/r2/x and C:/runs/r10/x and C:/runs/r2.');
  assert.equal(rewritePaths('C:/repo/.runs/r1/a C:/repo/b', [['C:/repo/.runs/r1', 'D:/new/runs'], ['C:/repo', 'D:/repo2']]), 'D:/new/runs/a D:/repo2/b', 'a nested path is rewritten once, longest first');
});

test('self-review fixes: --drop-tag narrows a range, keeps a comma-separated Tickets line apart, removes a bold bullet and keeps CRLF', () => {
  assert.equal(dropTagFromPacket(lines('- [AC-6040-1] a', '- [AC-6040-2] b', 'Tickets: 6040 = AC-6040-1..-5'), ['AC-6040-1']), lines('- [AC-6040-2] b', 'Tickets: 6040 = AC-6040-2, AC-6040-3, AC-6040-4, AC-6040-5'));
  assert.equal(dropTagFromPacket(lines('- [AC-1] a', 'Tickets: 6041=AC-1, 6042=AC-2'), ['AC-1']), lines('Tickets: 6042=AC-2'));
  assert.equal(dropTagFromPacket(lines('- **[AC-B]** bold', '- [AC-C] plain'), ['AC-B']), lines('- [AC-C] plain'));
  const crlf = ['- [AC-1] a', '- [AC-2] b', 'Tickets: 1 = AC-1', ''].join(String.fromCharCode(13, 10));
  assert.equal(dropTagFromPacket(crlf, ['AC-1']), ['- [AC-2] b', ''].join(String.fromCharCode(13, 10)));
});

test('self-review fixes: rewritePaths matches a Windows drive letter or UNC server in any case and stops at a real path end', () => {
  const bs = String.fromCharCode(92);
  assert.equal(rewritePaths('c:/review/old/file.txt', [['C:/review/old', 'D:/new']]), 'D:/new/file.txt');
  assert.equal(rewritePaths('C:/review/old(backup)/file.txt', [['C:/review/old', 'D:/new']]), 'C:/review/old(backup)/file.txt', '"old(backup)" is another folder');
  const unc = (...p) => bs + bs + p.join(bs);
  assert.equal(rewritePaths(unc('SERVER', 'share', 'old', 'file.txt'), [[unc('server', 'share', 'old'), 'D:/new']]), `D:/new${bs}file.txt`);
  assert.equal(rewritePaths('see "C:/review/old" and C:/review/old-2', [['C:/review/old', 'D:/new']]), 'see "D:/new" and C:/review/old-2');
  assert.equal(rewritePaths('/home/u/Old/x /home/u/old/x', [['/home/u/old', '/n']]), '/home/u/Old/x /n/x', 'a POSIX path keeps its case');
});

test('self-review fixes: a task packet saved with a byte-order mark keeps its title line', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-bom-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), `${String.fromCharCode(0xfeff)}# Task packet: BOM target\n\n## Scope\nx\n`);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  const out = path.join(root, 'new-packet.md');
  const r = spawnSync(process.execPath, [SCRIPT, '--from-run', run, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /^# Task packet: re-review of BOM target$/m);
});
