import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, splitSections, diffSummary, findingHypothesis, buildRecheckPacket, rewritePaths, dropTagFromPacket } from '../build-recheck-packet.mjs';

// The step in-process, as the script was run: env holds the variables set (or, undefined, removed) for the call.
async function runCli(args, env = {}) {
  const { runStep } = await import('../build-recheck-packet.mjs');
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const put = (vars) => { for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  put(env);
  try {
    const r = await runStep(args);
    return { status: r.code, stdout: r.stdout, stderr: r.stderr };
  } finally {
    put(saved);
  }
}
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

test('findingHypothesis: a suspected defect (CONFIRMED = still there) with the whole summary and where it was', () => {
  assert.equal(findingHypothesis(FINDINGS.findings[0], 1), '- [H1] Previous finding F1 (medium, settled-agree) is still present: The disclosed reason is wrong. More text follows here.');
  const second = findingHypothesis(FINDINGS.findings[1], 2);
  assert.match(second, /^- \[H2\] Previous finding F2 \(high, unresolved-high-stakes\) is still present: x{300}\.$/, 'a 300-character summary is not cut');
  const located = findingHypothesis({ id: 'F3', severity: 'HIGH', final_state: 'settled-agree', summary: 'Paging stops early.', evidence: ['Contoso.py:358 sets retried_auth once', 'other'] }, 3);
  assert.match(located, /Paging stops early\. It was at Contoso\.py:358\.$/);
  // No outcome word in the line: a seat that quotes it must not be read as CONFIRMED or REFUTED.
  assert.doesNotMatch(located, /CONFIRMED|REFUTED/);
  // A URL, an IP:port and a version are not locations; a drive letter is kept; a question keeps its mark; an empty summary uses the title.
  const urlFirst = findingHypothesis({ id: 'F4', summary: 'Does it leak?', evidence: ['curl https://api.example.com:9443/x', 'host 10.0.0.5:9443 v24.14:1', 'C:\\repo\\src\\Contoso.py:358 loops'] }, 4);
  assert.match(urlFirst, /is still present: Does it leak\? It was at C:\\repo\\src\\Contoso\.py:358\.$/);
  assert.match(findingHypothesis({ id: 'F5', summary: '', title: 'Title only.' }, 5), /is still present: Title only\.$/);
  // Round 6: a location in a changed file wins over a test input quoted first in the evidence.
  const quoted = { id: 'F6', summary: 'Scan drops the folder.', evidence: ['Input: Evidence: /x/ev Reporter/Reporter.py:40\npreflight.mjs:1323 breaks only for a file'] };
  assert.match(findingHypothesis(quoted, 6, false, ['plugins/p/scripts/preflight.mjs']), /It was at preflight\.mjs:1323\.$/);
  assert.match(findingHypothesis(quoted, 6), /It was at Reporter\/Reporter\.py:40\.$/, 'with no diff the first location is kept');
  // Round 7 F6: the changed file cited by an absolute path wins too.
  const absolute = { id: 'F7', summary: 'x.', evidence: ['Input: Reporter/Reporter.py:40\nC:\\repo\\plugins\\p\\scripts\\preflight.mjs:1323 breaks'] };
  assert.match(findingHypothesis(absolute, 7, false, ['plugins/p/scripts/preflight.mjs']), /It was at C:\\repo\\plugins\\p\\scripts\\preflight\.mjs:1323\.$/);
  assert.doesNotMatch(located, /Confirm it is fixed/);
});

test('buildRecheckPacket: old findings become the only hypotheses, stale sections are replaced, the rest is kept', () => {
  const { text, fills } = buildRecheckPacket({ oldPacket: OLD_PACKET, findingsDoc: FINDINGS, diffText: DIFF, previousRun: 'the review in run-5' });
  assert.match(text, /^# Task packet: re-review after fixes \(previous: Reporter changes for six tickets\)/);
  // The preamble's Target line is the previous round's fact too.
  assert.match(text, /Profile: Code\. Target: C:\/repo\.\nFILL: the lines above are from the previous packet/);
  assert.match(text, /This is a re-review of the review in run-5\./);
  assert.equal((text.match(/^## Hypotheses to test/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /Old hypothesis/);
  assert.match(text, /## Hypotheses to test\nIn `## Checks performed`, end each hypothesis line with CONFIRMED \(the previous defect is still there\), REFUTED \(it is gone\) or PARTLY CONFIRMED/);
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
  // Scope is carried over and may hold the previous round's facts, so it gets a FILL line; criteria and Output do not.
  assert.match(text, /## Scope\n- In scope: the diffs\.\nFILL: carried over from the previous packet \(section "Scope"\); any counts above \(lines, tests, findings\) are from the previous packet: update/);
  assert.match(text, /- \[AC-1\] Keeps Unknown\.\n\n/);
  assert.deepEqual(fills.map((f) => f.text.slice(0, 12)), ['FILL: the li', 'FILL: carrie', 'FILL: why ea', 'FILL: which ', 'FILL: this r', 'FILL: result']);
  assert.ok(text.indexOf('## What changed since') < text.indexOf('## Acceptance criteria'), 'the change list sits right after Scope');
});

test('buildRecheckPacket: no diff gives a FILL line, no findings gives a FILL hypothesis, a missing Hypotheses section is appended', () => {
  const bare = lines('# Task packet: thing', '', '## Scope', '- x');
  const { text, fills } = buildRecheckPacket({ oldPacket: bare, findingsDoc: { findings: [] }, diffText: '' });
  assert.match(text, /- FILL: the files changed since the previous review \(no --since-commit, --since-dirs or --since-diff was given\)/);
  assert.match(text, /## Hypotheses to test\n- FILL: the previous review had no findings/);
  assert.doesNotMatch(text, /null, missing, empty, zero or negative/, 'no input-edge hypothesis without previous findings');
  assert.equal(fills.length, 4);
  assert.throws(() => buildRecheckPacket({ oldPacket: bare, findingsDoc: {} }), /no "findings" array/);
});

test('parseArgs: --from-run and --out are required', () => {
  assert.throws(() => parseArgs([]), /--from-run/);
  assert.throws(() => parseArgs(['--from-run', 'x']), /--out/);
  assert.throws(() => parseArgs(['--from-run', 'x', '--out', 'y', '--wat']), /unrecognized/);
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
  const r = await runCli(['--from-run', run, '--since-diff', diff, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 FILL marker\(s\) to complete before the seats start/);
  // Overnight r1 F1: the packet never names the previous run folder (its manifest names the seats' models); it is recorded beside it.
  const written = await fs.readFile(out, 'utf8');
  assert.ok(written.includes('This is a re-review of the previous review. '), written.split('\n').slice(0, 6).join('\n'));
  assert.equal(written.includes(run), false, 'no path of the previous run folder in the packet');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(out), 'previous-run.json'), 'utf8')), { previousRun: run, round: 2 });
  assert.match(r.stdout, /previous run .*not in the packet: seats must not read that folder/);
  const again = await runCli(['--from-run', run, '--out', out]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists; it is never overwritten/);
  // Mac round 4 F2: a record that names another run is refused before anything is written (it used to be kept with a warning).
  await fs.writeFile(path.join(dir, 'previous-run.json'), '{"previousRun":"elsewhere"}\n');
  const other = await runCli(['--from-run', run, '--since-diff', diff, '--out', path.join(dir, 'second.md')]);
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /previous-run\.json already exists with other contents .*nothing was written/);
  assert.equal(existsSync(path.join(dir, 'second.md')), false, 'no packet without its companions');
  const missing = await runCli(['--from-run', path.join(dir, 'nope'), '--out', path.join(dir, 'x.md')]);
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
  assert.match(findingHypothesis(f, 1), /: Null deref in parse, e\.g\. on empty input, crashes the run\. More text\.$/);
});

test('findingHypothesis: same-shape sites from the last round are named without their claim IDs; "none found" adds nothing; a long list is cut', () => {
  const f = { id: 'F2', severity: 'HIGH', final_state: 'settled-agree', summary: 'Last slot is never read.', same_shape: ['A3: pg.py:40, pg.py:88', 'B1: none found (searched _read)', 'B2: disk.py:12'] };
  assert.match(findingHypothesis(f, 1), /is still present: Last slot is never read\. Also check the same shape at: pg\.py:40, pg\.py:88; disk\.py:12$/);
  assert.match(findingHypothesis({ ...f, same_shape: ['A1: none found'] }, 1), /never read\.$/);
  const long = findingHypothesis({ ...f, same_shape: [`A1: ${'x.py:1, '.repeat(80)}`] }, 1);
  assert.equal(long.split('Also check the same shape at: ')[1].length, 300);
});

test('CLI: a findings.json with a BOM is read; broken JSON names the file; a diff with no files is an error', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck bom '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'old run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), `﻿${JSON.stringify(FINDINGS)}`);
  const ok = await runCli(['--from-run', run, '--out', path.join(dir, 'a.md')]);
  assert.equal(ok.status, 0, ok.stderr);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), '{ nope');
  const bad = await runCli(['--from-run', run, '--out', path.join(dir, 'b.md')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /the previous findings .*findings\.json is not valid JSON/);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  const empty = path.join(dir, 'empty.diff');
  await fs.writeFile(empty, 'not a diff at all\n');
  const none = await runCli(['--from-run', run, '--since-diff', empty, '--out', path.join(dir, 'c.md')]);
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
  assert.doesNotMatch(text, /\[H\d+\] Previous finding F2/, 'a skipped finding is not a hypothesis');
  assert.doesNotMatch(text, /\[AC-B\]|\[AC-C\]/);
  assert.match(text, /^Tickets: 6041 = AC-A$/m);
  assert.match(text, /## Author-reported evidence \(not reproducible; do not cite as EXECUTED\)/);
  // A skipped finding is recorded as decided, so the seats do not spend a claim on it.
  assert.match(text, /## Known deviations from the criteria\n- Previous finding F2 of round 1 \(decided, not re-checked; do not spend a claim on it unless the code around it changed\): Two\./);
  // With a Known deviations section already there, the decided line joins it before its FILL line.
  const withSection = buildRecheckPacket({ oldPacket: OLD_PACKET, findingsDoc: FINDINGS, skip: ['F2'] }).text;
  assert.match(withSection, /Deviation 1\.\n- Previous finding F2 of round 1 \(decided, not re-checked;[^\n]*\nFILL: which of these deviations still apply/);
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
  const r = await runCli(['--from-run', run, '--out', out, '--target', path.join(root, 'new-target')]);
  assert.equal(r.status, 0, r.stderr);
  const text = await fs.readFile(out, 'utf8');
  assert.ok(text.includes(path.join(root, 'new-target')) && text.includes(path.dirname(out)));
  // Only the intro names the previous run, on purpose; every other old path is rewritten.
  const body = text.split(String.fromCharCode(10)).filter((l) => !l.startsWith('This is a re-review of the previous review')).join(String.fromCharCode(10));
  assert.equal(body.includes(path.join(root, 'old-target')) || body.includes(run), false);
});

test('Mac round 4 F4: --target rewrites the old target in every spelling (run.json real path, packet through a link), and --repo-target matches through one', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-spell-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldTarget = path.join(root, 'old-target');
  const linked = path.join(root, 'old-link');
  const oldRepo = path.join(root, 'old-repo');
  const repoLink = path.join(root, 'repo-link');
  for (const d of [oldTarget, oldRepo]) await fs.mkdir(d);
  try {
    await fs.symlink(oldTarget, linked, 'junction');
    await fs.symlink(oldRepo, repoLink, 'junction');
  } catch (err) {
    t.skip(`cannot create links here: ${err.code}`);
    return;
  }
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  // run.json has the link spelling, the packet's author wrote the real path (macOS: /tmp vs /private/tmp; there the fixed
  // link rule gives the other direction too, here a link's target is found but not the links into a folder).
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\nTarget: ${oldTarget}, branch main\n- In scope: ${path.join(oldTarget, 'src', 'a.js')}\n`);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: linked, extraRepos: [{ dir: repoLink, snapshotHash: 'h' }] }));
  const out = path.join(root, 'new-run', 'task-packet.md');
  await fs.mkdir(path.dirname(out));
  const r = await runCli(['--from-run', run, '--out', out, '--target', path.join(root, 'new-target'), '--repo-target', `${oldRepo}=${path.join(root, 'new-repo')}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /is not a repository the previous run reviewed/, '--repo-target through the other spelling matches extraRepos');
  const text = await fs.readFile(out, 'utf8');
  assert.equal(text.includes(oldTarget), false, text);
  assert.ok(text.includes(path.join(root, 'new-target', 'src', 'a.js')), text);
  // Round 5 F10: run.json has the real path and the packet the junction spelling: the junction spelling is found too.
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\nTarget: ${linked}, branch main\n- In scope: ${path.join(linked, 'src', 'a.js')} and more\n`);
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: oldTarget }));
  const out2 = path.join(root, 'new-run-2', 'task-packet.md');
  await fs.mkdir(path.dirname(out2));
  const r2 = await runCli(['--from-run', run, '--out', out2, '--target', path.join(root, 'new-target')]);
  assert.equal(r2.status, 0, r2.stderr);
  const text2 = await fs.readFile(out2, 'utf8');
  assert.equal(text2.toLowerCase().includes(linked.toLowerCase()), false, text2);
  assert.ok(text2.includes(path.join(root, 'new-target', 'src', 'a.js')), text2);
  assert.doesNotMatch(r2.stderr, /WARNING: --target was given/);
  // A packet that names the old target nowhere is published with a warning.
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\nTarget: elsewhere\n');
  const out3 = path.join(root, 'new-run-3', 'task-packet.md');
  await fs.mkdir(path.dirname(out3));
  const r3 = await runCli(['--from-run', run, '--out', out3, '--target', path.join(root, 'new-target')]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(r3.stderr, /WARNING: --target was given, but the packet names the old target .* in no spelling found here/);
  // Round 8 (decided): a line that spells the old target through a variable or "~" is not rewritten and not guessed at;
  // with --target or --repo-target the same reminder is printed every time, and nothing else is warned about.
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\nTarget: ${oldTarget}, branch main\n- In scope: %TEMP%\\old-target\\src\\a.js\n`);
  const out4 = path.join(root, 'new-run-4', 'task-packet.md');
  await fs.mkdir(path.dirname(out4));
  const r4 = await runCli(['--from-run', run, '--out', out4, '--target', path.join(root, 'new-target')]);
  assert.equal(r4.status, 0, r4.stderr);
  assert.match(r4.stdout, /old paths written through a variable or "~" .* are not rewritten: check the packet for them by hand/);
  assert.match(await fs.readFile(out4, 'utf8'), /%TEMP%\\old-target\\src\\a\.js/);
  assert.match(r2.stdout, /are not rewritten: check the packet for them by hand/, 'the reminder does not depend on the packet');
  await fs.mkdir(path.join(root, 'new-run-4b'));
  const plain = await runCli(['--from-run', run, '--out', path.join(root, 'new-run-4b', 'task-packet.md')]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /are not rewritten/, 'no reminder without --target or --repo-target');
});

test('Mac round 5 F1/F2: a stale since.diff with no diff in this run, and --target with no readable run.json, are refused before anything is written', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-r5-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\n## Scope\nReview ${path.join(root, 'old-target')}\n`);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  const folder = path.join(root, 'new-run');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'since.diff'), 'from an earlier attempt\n');
  const stale = await runCli(['--from-run', run, '--out', path.join(folder, 'task-packet.md')]);
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /since\.diff already exists, but this run's diff is empty .*nothing was written/);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['since.diff']);
  const other = path.join(root, 'other-run');
  await fs.mkdir(other);
  const noRunJson = await runCli(['--from-run', run, '--out', path.join(other, 'task-packet.md'), '--target', path.join(root, 'new-target')]);
  assert.equal(noRunJson.status, 1, noRunJson.stderr);
  assert.match(noRunJson.stderr, /--target was given, but .*run\.json is missing or has no targetDir.*nothing was written/);
  assert.deepEqual(await fs.readdir(other), []);
});

test('CLI: the --since-diff text is saved as since.diff next to --out for the report, never over an existing one', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-since-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\ns\n');
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  const diff = path.join(root, 'change.diff');
  const diffText = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1,2 @@\n a\n+b\n';
  await fs.writeFile(diff, diffText);
  const newRun = path.join(root, 'new-run');
  await fs.mkdir(newRun);
  const r = await runCli(['--from-run', run, '--out', path.join(newRun, 'task-packet.md'), '--since-diff', diff]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await fs.readFile(path.join(newRun, 'since.diff'), 'utf8'), diffText);
  assert.match(r.stdout, /wrote .*since\.diff \(build-report reads it/);
  assert.match(r.stdout, /Review round: 2 counts this chain of re-reviews only; if the same code had other reviews, rerun with --round <N>/);
  await fs.writeFile(path.join(newRun, 'since.diff'), 'kept\n');
  // Mac round 4 F2: a since.diff from another attempt is refused, not kept behind a warning; nothing is written.
  const again = await runCli(['--from-run', run, '--out', path.join(newRun, 'other.md'), '--since-diff', diff]);
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /since\.diff already exists with other contents .*nothing was written/);
  assert.equal(await fs.readFile(path.join(newRun, 'since.diff'), 'utf8'), 'kept\n');
  assert.equal(existsSync(path.join(newRun, 'other.md')), false);
  await fs.mkdir(path.join(root, 'plain'));
  const noDiff = await runCli(['--from-run', run, '--out', path.join(root, 'plain', 'p.md')]);
  assert.equal(noDiff.status, 0, noDiff.stderr);
  assert.equal(await fs.access(path.join(root, 'plain', 'since.diff')).then(() => true, () => false), false);
});

test('field r4: --since-dirs ignores line-ending-only changes, repeats for a second repository (paths under its folder name, .git left out), and --since-only keeps the named files', async (t) => {
  const { diffBetweenDirs, filterDiff } = await import('../build-recheck-packet.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck r4 '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (rel, text) => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text); };
  await put('old/x.py', 'one\r\ntwo\r\nthree\r\n');
  await put('new/x.py', 'one\nTWO\nthree\n');
  await put('old/eol_only.py', 'same\r\n');
  await put('new/eol_only.py', 'same\n');
  await put('old/REVIEW/collector.diff', 'a\n');
  await put('new/REVIEW/collector.diff', 'b\n');
  await put('oldgm/CONTOSO/Reporter.py', 'r = 1\n');
  await put('Northwind/CONTOSO/Reporter.py', 'r = 2\n');
  await put('oldgm/.git/HEAD', 'ref: a\n');
  await put('Northwind/.git/HEAD', 'ref: b\n');
  const target = diffBetweenDirs(path.join(root, 'old'), path.join(root, 'new'));
  assert.deepEqual(diffSummary(target).map((f) => [f.path, f.added, f.removed]), [['REVIEW/collector.diff', 1, 1], ['x.py', 1, 1]], 'CRLF vs LF is not a change');
  const second = diffBetweenDirs(path.join(root, 'oldgm'), path.join(root, 'Northwind'), 'Northwind/');
  assert.deepEqual(diffSummary(second).map((f) => f.path), ['Northwind/CONTOSO/Reporter.py'], '.git internals stay out under a prefix too');
  const only = filterDiff(`${target}\n${second}`, ['x.py', 'Northwind/CONTOSO']);
  assert.deepEqual(diffSummary(only).map((f) => f.path), ['x.py', 'Northwind/CONTOSO/Reporter.py']);
  const plain = '--- old/a.c\t2026-01-01\n+++ new/a.c\t2026-01-02\n@@ -1 +1 @@\n-x\n+y\n--- old/b.c\t2026-01-01\n+++ new/b.c\t2026-01-02\n@@ -1 +1 @@\n-p\n+q\n';
  assert.deepEqual(diffSummary(filterDiff(plain, ['new/b.c'])).map((f) => [f.path, f.added]), [['new/b.c', 1]], 'plain diff -u blocks are split too');
  // Review of that fix: the snapshot-relative path matches a plain diff's "new/..." path, and a removed "-- x" followed by an
  // added "++ y" inside a hunk is content, not a new file header.
  assert.deepEqual(diffSummary(filterDiff(plain, ['b.c'])).map((f) => f.path), ['new/b.c']);
  const sql = 'diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n select 1;\ndiff --git a/r.sql b/r.sql\n--- a/r.sql\n+++ b/r.sql\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(diffSummary(filterDiff(sql, ['q.sql'])).map((f) => [f.path, f.added, f.removed]), [['q.sql', 1, 1]]);
  // The CLI: two --since-dirs pairs and --since-only; no match is an error.
  const run = path.join(root, 'run');
  await put('run/task-packet.md', '# Task packet: X\n\n## Scope\ns\n');
  await put('run/phase3/findings.json', JSON.stringify({ findings: [] }));
  await fs.mkdir(path.join(root, 'newrun'));
  const r = await runCli(['--from-run', run, '--out', path.join(root, 'newrun', 'task-packet.md'), '--since-dirs', path.join(root, 'old'), path.join(root, 'new'), '--since-dirs', path.join(root, 'oldgm'), path.join(root, 'Northwind'), '--since-only', 'x.py,Northwind/CONTOSO']);
  assert.equal(r.status, 0, r.stderr);
  const packet = await fs.readFile(path.join(root, 'newrun', 'task-packet.md'), 'utf8');
  assert.match(packet, /^- x\.py \(\+1 -1\)$/m);
  assert.match(packet, /^- Northwind\/CONTOSO\/Reporter\.py \(\+1 -1\)$/m);
  assert.doesNotMatch(packet, /collector\.diff|eol_only/);
  const none = await runCli(['--from-run', run, '--out', path.join(root, 'newrun', 'p2.md'), '--since-dirs', path.join(root, 'old'), path.join(root, 'new'), '--since-only', 'nothing.py']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--since-only nothing\.py matched no changed file/);
});

test('field: --since-commit lists committed work with line counts, and --preflight fills the evidence section from the evidence preflight', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck since commit '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'repo');
  await fs.mkdir(target);
  const git = (...a) => { const r = spawnSync('git', a, { cwd: target, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  await fs.writeFile(path.join(target, 'x.py'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(target, 'x.py'), 'one\ntwo\n');
  await fs.writeFile(path.join(target, 'y.py'), 'new\n');
  git('add', '.');
  git('commit', '-q', '-m', 'fix');
  const run = path.join(root, 'run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\ns\n\n## Evidence both seats may cite\nold\n');
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: target }));
  const pf = path.join(root, 'preflight.json');
  await fs.writeFile(pf, JSON.stringify({ snapshotHash: 'abc123', tier1: { changedFiles: ['x.py', 'y.py'], base },
    repos: [{ path: target, branch: 'main', head: 'f00d', dirty: false }],
    tier2: { results: [{ command: 'npm test', exitCode: 0, timedOut: false, stdout: { summary: ['# pass 12'], tail: ['done'], log: '/ev/command-1.stdout.log' } }] } }));
  await fs.mkdir(path.join(root, 'newrun'));
  const r = await runCli(['--from-run', run, '--out', path.join(root, 'newrun', 'task-packet.md'), '--since-commit', base.slice(0, 7), '--preflight', pf]);
  assert.equal(r.status, 0, r.stderr);
  const packet = await fs.readFile(path.join(root, 'newrun', 'task-packet.md'), 'utf8');
  assert.match(packet, /^- x\.py \(\+1 -0\)$/m);
  assert.match(packet, /^- y\.py \(\+1 -0\)$/m);
  assert.match(packet, /^- snapshotHash abc123; 2 changed file\(s\) since /m);
  assert.match(packet, /^- .*repo: main at f00d$/m);
  assert.match(packet, /^- `npm test`: exit 0 \(# pass 12\); log \/ev\/command-1\.stdout\.log$/m);
  assert.doesNotMatch(packet, /pre-flight summary \(HEAD, snapshotHash/);
  const both = await runCli(['--from-run', run, '--out', path.join(root, 'newrun', 'p2.md'), '--since-commit', base, '--since-diff', pf]);
  assert.match(both.stderr, /give one/);
  const bad = await runCli(['--from-run', run, '--out', path.join(root, 'newrun', 'p3.md'), '--since-commit', 'no-such-rev']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--since-commit no-such-rev: git diff exited/);
});

test('field r4: an old packet with no round line gets its round from the chain of earlier re-reviews; a missing run in the chain warns', async (t) => {
  const { chainRound } = await import('../build-recheck-packet.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck chain '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packet = (prev) => `# Task packet: X\n\n${prev ? `This is a re-review of the previous review (${prev}). Those findings are listed below as hypotheses only.\n\n` : ''}## Scope\ns\n`;
  for (const [name, prev] of [['r1', null], ['r2', path.join(root, 'r2run-prev')], ['r3', path.join(root, 'r2')]]) {
    await fs.mkdir(path.join(root, name, 'phase3'), { recursive: true });
    await fs.writeFile(path.join(root, name, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
    await fs.writeFile(path.join(root, name, 'task-packet.md'), packet(prev));
  }
  await fs.writeFile(path.join(root, 'r2', 'task-packet.md'), packet(path.join(root, 'r1')));
  const read = (f) => fs.readFile(f, 'utf8');
  assert.equal(await chainRound(path.join(root, 'r1'), read), 1);
  assert.equal(await chainRound(path.join(root, 'r3'), read), 3);
  // A packet built by 1.1.0 names only the previous run folder's name (review of that fix).
  await fs.mkdir(path.join(root, 'old11'), { recursive: true });
  await fs.writeFile(path.join(root, 'old11', 'task-packet.md'), '# Task packet: X\n\nThis is a re-review of the review in r2. Those findings are listed below.\n\n## Scope\ns\n');
  assert.equal(await chainRound(path.join(root, 'old11'), read), 3);
  await fs.writeFile(path.join(root, 'old11', 'task-packet.md'), '# Task packet: X\n\nThis is a re-review of the review in nowhere. Those findings are listed below.\n');
  assert.equal(await chainRound(path.join(root, 'old11'), read), null);
  await fs.writeFile(path.join(root, 'r1', 'task-packet.md'), packet(path.join(root, 'gone')));
  assert.equal(await chainRound(path.join(root, 'r3'), read), null);
  const out = path.join(root, 'r4.md');
  const r = await runCli(['--from-run', path.join(root, 'r3'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the round could not be counted .*pass --round N/);
  await fs.writeFile(path.join(root, 'r1', 'task-packet.md'), packet(null));
  // A new folder: the first packet's previous-run.json (round unknown) is not this one's.
  await fs.mkdir(path.join(root, 'r4b'));
  const out2 = path.join(root, 'r4b', 'r4b.md');
  assert.equal((await runCli(['--from-run', path.join(root, 'r3'), '--out', out2])).status, 0);
  assert.match(await fs.readFile(out2, 'utf8'), /^Review round: 4$/m);
});

test('overnight r1 F7: when every previous finding was settled, the hypotheses section says so instead of "no findings"; decided lines name their round', () => {
  const oldPacket = '# Task packet: X\nReview round: 3\n\n## Scope\ns\n';
  const findingsDoc = { findings: [{ id: 'F1', title: 'One.' }, { id: 'F2', title: 'Two.' }] };
  const { text } = buildRecheckPacket({ oldPacket, findingsDoc, skip: ['F1', 'F2'] });
  assert.match(text, /- FILL: all 2 previous finding\(s\) were settled \(see Known deviations\)/);
  assert.doesNotMatch(text, /had no findings/);
  assert.match(text, /- Previous finding F1 of round 3 \(decided/);
  assert.match(buildRecheckPacket({ oldPacket, findingsDoc: { findings: [] } }).text, /the previous review had no findings/);
});

test('review round: the line under the title counts up across rechecks (2 when the old packet has none), --round sets it, and the old line is not kept', () => {
  const findingsDoc = { findings: [{ id: 'F1', title: 'One.' }] };
  const first = buildRecheckPacket({ oldPacket: '# Task packet: X\n\n## Scope\ns\n', findingsDoc });
  assert.equal(first.round, 2);
  assert.match(first.text, /^# Task packet: re-review after fixes \(previous: X\)\nReview round: 2\n/);
  assert.doesNotMatch(first.text, /FILL: the lines above are from the previous packet/, 'the round line is not a stale fact');
  const second = buildRecheckPacket({ oldPacket: first.text, findingsDoc });
  assert.equal(second.round, 3);
  assert.equal(second.text.match(/^Review round:/gm).length, 1);
  assert.equal(buildRecheckPacket({ oldPacket: first.text, findingsDoc, round: 7 }).round, 7);
  assert.throws(() => parseArgs(['--from-run', 'r', '--out', 'o', '--round', '0']), /--round must be a whole number/);
  assert.equal(parseArgs(['--from-run', 'r', '--out', 'o', '--round', '4']).round, 4);
});

test('report-notes outcomes: wrong/intentional/not-worth-it/decided become known deviations with the reason, pre-existing is marked, fixed and free text stay hypotheses, --skip wins; read from the old run by default or --notes', async (t) => {
  const oldPacket = ['# Task packet: X', '', '## Scope', 's', ''].join('\n');
  const findingsDoc = { findings: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map((id) => ({ id, severity: 'MEDIUM', title: `Defect ${id}.` })) };
  const notes = ['## Finding status', '- F1: fixed', '- F2: wrong: the cap is never reached', '- F3: intentional', '- F4: pre-existing: older than the branch', '- F5: wrong value in the log, to fix', '- F6: decided: keep', ''].join('\n');
  const { notesOutcomes } = await import('../build-recheck-packet.mjs');
  const built = buildRecheckPacket({ oldPacket, findingsDoc, skip: ['F6'], outcomes: notesOutcomes(notes) });
  const hyps = built.text.match(/\[H\d+\] Previous finding F\d[^\n]*/g);
  assert.deepEqual(hyps.map((h) => /F\d/.exec(h)[0]), ['F1', 'F4', 'F5']);
  assert.match(built.text, /\[H2\] Previous finding F4 \(medium, unknown, pre-existing\) is still present/);
  assert.match(built.text, /- Previous finding F2 of round 1 \(decided, not re-checked;[^\n]*\): Defect F2\. The author marked it wrong: the cap is never reached\.$/m);
  assert.match(built.text, /- Previous finding F3 of round 1 \(decided, not re-checked;[^\n]*\): Defect F3\. The author marked it intentional\.$/m);
  assert.match(built.text, /- Previous finding F6 of round 1 \(decided, not re-checked;[^\n]*\): Defect F6\.$/m, '--skip wins and adds no outcome');
  assert.deepEqual(built.fromNotes, ['F1 fixed (hypothesis)', 'F2 wrong (known deviation)', 'F3 intentional (known deviation)', 'F4 pre-existing (hypothesis)']);
  assert.equal(buildRecheckPacket({ oldPacket, findingsDoc }).text, buildRecheckPacket({ oldPacket, findingsDoc, outcomes: notesOutcomes('') }).text, 'no notes: the packet is unchanged');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), oldPacket);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(findingsDoc));
  await fs.writeFile(path.join(run, 'phase3', 'report-notes.md'), notes);
  const cli = (out, ...extra) => runCli(['--from-run', run, '--out', path.join(root, out), ...extra]);
  const byDefault = await cli('a.md');
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.match(byDefault.stdout, /outcomes from .*report-notes\.md: F1 fixed \(hypothesis\), F2 wrong \(known deviation\)/);
  await fs.writeFile(path.join(root, 'other-notes.md'), '## Finding status\n- F1: wrong: not a defect\n');
  const named = await cli('b.md', '--notes', path.join(root, 'other-notes.md'));
  assert.equal(named.status, 0, named.stderr);
  assert.match(await fs.readFile(path.join(root, 'b.md'), 'utf8'), /Previous finding F1 of round 1 \(decided, not re-checked;[^\n]*The author marked it wrong: not a defect\./);
  assert.match((await cli('c.md', '--notes', path.join(root, 'missing.md'))).stderr, /cannot read the report notes/);
});

test('--since-dirs: the diff of two snapshot folders, paths relative to them (spaces kept), with changed, added and removed files', async (t) => {
  const { diffBetweenDirs } = await import('../build-recheck-packet.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck since dirs '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldDir = path.join(root, 'old snap');
  const newDir = path.join(root, 'new snap');
  for (const d of [path.join(oldDir, 'pkg'), path.join(newDir, 'pkg')]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(oldDir, 'pkg', 'x.py'), 'a\n');
  await fs.writeFile(path.join(newDir, 'pkg', 'x.py'), 'b\nc\n');
  await fs.writeFile(path.join(newDir, 'added file.py'), 'n\n');
  await fs.writeFile(path.join(oldDir, 'gone.py'), 'g\n');
  const summary = diffSummary(diffBetweenDirs(oldDir, newDir)).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(summary, [{ path: 'added file.py', added: 1, removed: 0 }, { path: 'gone.py', added: 0, removed: 1 }, { path: 'pkg/x.py', added: 2, removed: 1 }]);
  const twin = path.join(root, 'twin');
  await fs.cp(newDir, twin, { recursive: true });
  assert.equal(diffBetweenDirs(twin, newDir), '', 'two equal folders give no diff');
  // A moved file, a binary change and a new empty file are listed too; .git internals are not.
  await fs.writeFile(path.join(oldDir, 'moved.txt'), 'same\n');
  await fs.writeFile(path.join(newDir, 'moved-now.txt'), 'same\n');
  await fs.writeFile(path.join(oldDir, 'img.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(newDir, 'img.bin'), Buffer.from([0, 9, 9, 3]));
  await fs.writeFile(path.join(newDir, '__init__.py'), '');
  await fs.mkdir(path.join(newDir, '.git'));
  await fs.writeFile(path.join(newDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const listed = diffSummary(diffBetweenDirs(oldDir, newDir)).map((f) => f.path);
  for (const p of ['moved.txt', 'moved-now.txt', 'img.bin', '__init__.py']) assert.ok(listed.includes(p), `${p} in ${listed.join(', ')}`);
  assert.ok(!listed.some((p) => p.startsWith('.git')), listed.join(', '));
  // The diff text itself (written to since.diff) has no .git block either, beside a nested repository's or a second repository's.
  await fs.mkdir(path.join(newDir, 'pkg', '.git'));
  await fs.writeFile(path.join(newDir, 'pkg', '.git', 'index'), 'x\n');
  assert.doesNotMatch(diffBetweenDirs(oldDir, newDir), /\.git\//);
  assert.doesNotMatch(diffBetweenDirs(oldDir, newDir, 'Other/'), /\.git\//);
  assert.match(diffBetweenDirs(oldDir, newDir), /^diff --git a\/moved-now\.txt b\/moved-now\.txt$/m);
  // A missing folder or one folder inside the other is refused, never read as "no change".
  assert.throws(() => diffBetweenDirs(path.join(root, 'nope'), newDir), /the old snapshot .*nope is not a folder/);
  assert.throws(() => diffBetweenDirs(oldDir, path.join(oldDir, 'pkg')), /one snapshot folder is inside the other/);
  assert.throws(() => parseArgs(['--from-run', 'r', '--out', 'o', '--since-diff', 'd', '--since-dirs', 'a', 'b']), /give one/);
});

test('a recheck of a recheck: one intro (the new one) and one level of "previous:" in the title', () => {
  const first = buildRecheckPacket({ oldPacket: OLD_PACKET, findingsDoc: FINDINGS, previousRun: 'round one' }).text;
  const second = buildRecheckPacket({ oldPacket: first, findingsDoc: FINDINGS, previousRun: 'round two' }).text;
  assert.equal((second.match(/^This is a re-review of/gm) ?? []).length, 1);
  assert.match(second, /This is a re-review of round two\./);
  assert.match(second, /^# Task packet: re-review after fixes \(previous: Reporter changes for six tickets\)$/m);
});

test('--repo-target: a path holding "=" splits where a path starts; a mapping that matches no old repository warns', async (t) => {
  const parsed = parseArgs(['--from-run', 'r', '--out', 'o', '--repo-target', 'C:/a=b/parser=D:/new']);
  assert.deepEqual(parsed.repoTargets, [['C:/a=b/parser', 'D:/new']]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-typo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\nx\n');
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  const r = await runCli(['--from-run', run, '--out', path.join(root, 'p.md'), '--repo-target', `${path.join(root, 'typo')}=${path.join(root, 'new')}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: --repo-target .*typo is not a repository the previous run reviewed/);
});

test('CLI: every second repository of the old run needs --repo-target; with it, its path is rewritten too', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-repos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'old-run');
  const oldRepo = path.join(root, 'old-parser');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), `# Task packet: X\n\n## Scope\nReview ${path.join(root, 'old-target')} and the parser in ${oldRepo}\n`);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: path.join(root, 'old-target'), extraRepos: [{ dir: oldRepo, snapshotHash: 'h' }] }));
  const out = path.join(root, 'new', 'task-packet.md');
  await fs.mkdir(path.dirname(out));
  const refused = await runCli(['--from-run', run, '--out', out, '--target', path.join(root, 'new-target')]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /also reviewed .*old-parser \(--repo\); give --repo-target <old>=<new> for each/);
  assert.equal(existsSync(out), false);
  const r = await runCli(['--from-run', run, '--out', out, '--target', path.join(root, 'new-target'), '--repo-target', `${oldRepo}=${path.join(root, 'new-parser')}`]);
  assert.equal(r.status, 0, r.stderr);
  const text = await fs.readFile(out, 'utf8');
  assert.ok(text.includes(path.join(root, 'new-parser')) && !text.includes(oldRepo), text);
  assert.throws(() => parseArgs(['--from-run', 'x', '--out', 'y', '--repo-target', 'no-equals']), /must look like <old repo path>=<new repo path>/);
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
  const r = await runCli(['--from-run', run, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /^# Task packet: re-review after fixes \(previous: BOM target\)$/m);
});

test('closing round 5 F5: rewritePaths rewrites a folder only where its path starts, not inside a longer path that ends with it', () => {
  const pairs = [['/home/u/proj', '/n']];
  for (const [input, want] of [
    ['/mnt/backup/home/u/proj/a.js', '/mnt/backup/home/u/proj/a.js'],
    ['/data/home/u/proj', '/data/home/u/proj'],
    ['x/home/u/proj/a', 'x/home/u/proj/a'],
    ['~/home/u/proj/a', '~/home/u/proj/a'],
    ['/home/u/proj/b.js', '/n/b.js'],
    ['file:///home/u/proj/c.js', 'file:///n/c.js'],
    ['(/home/u/proj)', '(/n)'],
    ['"/home/u/proj"', '"/n"'],
    ['`/home/u/proj/x`', '`/n/x`'],
    ['see /home/u/proj.', 'see /n.'],
  ]) assert.equal(rewritePaths(input, pairs), want, input);
  assert.equal(rewritePaths('file:///C:/review/old/y and C:/review/old/x', [['C:/review/old', 'D:/new']]), 'file:///D:/new/y and D:/new/x');
});

test('field run: with no --since-diff, the previous run snapshot names the files changed since (an uncommitted worktree)', async (t) => {
  const { fingerprintFiles } = await import('../preflight.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-drift-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  const run = path.join(dir, 'old-run');
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(target, 'kept.py'), 'same\n');
  await fs.writeFile(path.join(target, 'fixed.py'), 'old\n');
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: target }));
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  await fs.writeFile(path.join(run, 'fingerprint-files.json'), JSON.stringify(await fingerprintFiles(target)));
  await fs.writeFile(path.join(target, 'fixed.py'), 'new\n');
  await fs.writeFile(path.join(target, 'added.py'), 'x\n');
  const out = path.join(dir, 'new', 'task-packet.md');
  await fs.mkdir(path.dirname(out));
  const r = await runCli(['--from-run', run, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const written = await fs.readFile(out, 'utf8');
  assert.match(written, /^- added\.py$/m);
  assert.match(written, /^- fixed\.py$/m);
  assert.doesNotMatch(written, /^- kept\.py$/m);
  assert.doesNotMatch(written, /no --since-diff was given/);
});

test('field run: recheck prints the step-back note from round 3 on, also with --round', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-stepback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  await fs.mkdir(path.join(dir, 'a'), { recursive: true });
  const ok3 = await runCli(['--from-run', run, '--round', '3', '--out', path.join(dir, 'a', 'task-packet.md')]);
  assert.equal(ok3.status, 0, ok3.stderr);
  assert.match(ok3.stdout, /Round 3: findings keep coming from fixes/);
  await fs.mkdir(path.join(dir, 'b'), { recursive: true });
  const ok2 = await runCli(['--from-run', run, '--round', '2', '--out', path.join(dir, 'b', 'task-packet.md')]);
  assert.doesNotMatch(ok2.stdout, /findings keep coming from fixes/);
});

test('--drop-tag with a hypothesis tag is refused (H1..Hn are the previous findings); the packet counts carried and decided findings', () => {
  const oldPacket = ['# Task packet: X', '', '## Scope', 's', '', '## Acceptance criteria', '- [AC-1] one', '', '## Hypotheses to test', '- [H1] old hypothesis', ''].join('\n');
  const findingsDoc = { findings: [{ id: 'F1', title: 'One.' }, { id: 'F2', title: 'Two.' }, { id: 'F3', title: 'Three.' }] };
  for (const tags of [['H2'], ['AC-1', 'h1']]) {
    assert.throws(() => buildRecheckPacket({ oldPacket, findingsDoc, dropTags: tags }), /names a hypothesis; .*--skip F<n>.*nothing was written/);
  }
  const built = buildRecheckPacket({ oldPacket, findingsDoc, skip: ['F2'], dropTags: ['AC-1'] });
  assert.deepEqual(built.counts, { total: 3, carried: 2, decided: 1 });
  assert.match(built.text, /^The previous review had 3 finding\(s\): 2 are the hypotheses below, 1 were decided and are listed under Known deviations\. The last hypothesis is a check on input edge values, not a previous finding\.$/m);
  assert.match(built.text, /- \[H1\] Previous finding F1/);
  assert.match(built.text, /- \[H2\] Previous finding F3/);
  // From round 2, one falsifiable hypothesis on the edge values of every field the change reads, after the previous findings.
  assert.match(built.text, /- \[H2\] Previous finding F3.*\n- \[H3\] Not a previous finding: some field the changed code reads is handled wrongly when it is null, missing, empty, zero or negative, or an invariant .*CONFIRMED names the field and value that break it, REFUTED means all of them hold\.$/m);
  const roundOne = buildRecheckPacket({ oldPacket, findingsDoc, round: 1 });
  assert.doesNotMatch(roundOne.text, /\[H4\]|Not a previous finding|input edge values/);
  assert.doesNotMatch(built.text, /\[AC-1\]/);
});

test('preflightEvidence: the last summary line, the stderr log, and a warning when a command changed the target', async () => {
  const { preflightEvidence } = await import('../build-recheck-packet.mjs');
  const command = (name, n, stderrBytes) => ({ command: name, exitCode: 1, timedOut: false,
    stdout: { summary: ['# tests 3', '# pass 2', '# fail 1'], tail: ['done'], log: `/ev/command-${n}.stdout.log` },
    stderr: { bytes: stderrBytes, tail: stderrBytes ? ['boom'] : [], summary: [], log: `/ev/command-${n}.stderr.log` } });
  const text = preflightEvidence({ snapshotHash: 'before', execInChangedTarget: true,
    tier2: { snapshotHash: 'before', snapshotHashAfter: 'after', targetChanged: true, results: [command('npm test', 1, 4)] },
    tier2Repos: [{ path: '/other', snapshotHash: 'o1', snapshotHashAfter: 'o2', targetChanged: true, results: [command('make', 2, 0)] }] }, '/ev/pf.json');
  assert.match(text, /^- `npm test`: exit 1 \(# fail 1\); log \/ev\/command-1\.stdout\.log; stderr log \/ev\/command-1\.stderr\.log$/m);
  assert.match(text, /^- `make`: exit 1 \(# fail 1\); log \/ev\/command-2\.stdout\.log$/m, 'an empty stderr log is not named');
  assert.match(text, /^- WARNING: a command changed the target during the run \(snapshotHash before -> after\); these results are not of the reviewed snapshot$/m);
  assert.match(text, /^- WARNING: a command changed the target \/other during the run \(snapshotHash o1 -> o2\)/m);
  assert.match(text, /^- WARNING: an --exec-in command changed files of the target; its snapshotHash above is stale/m);
  const clean = preflightEvidence({ snapshotHash: 'h', tier2: { snapshotHash: 'h', snapshotHashAfter: 'h', targetChanged: false, results: [] } }, '/ev/pf.json');
  assert.doesNotMatch(clean, /WARNING/);
});

test('preflightEvidence: a command that left processes running, or one holding its output open, gets a WARNING line each', async () => {
  const { preflightEvidence } = await import('../build-recheck-packet.mjs');
  const command = (name, flags) => ({ command: name, exitCode: 0, timedOut: false, stdout: { summary: [], tail: [] }, stderr: { bytes: 0, tail: [], summary: [] }, ...flags });
  const text = preflightEvidence({ snapshotHash: 'h', tier2: { snapshotHash: 'h', snapshotHashAfter: 'h', targetChanged: false, results: [
    command('group', { leftoverGroupStopped: true }), command('pids', { leftoversStopped: [424242] }), command('held', { outputHeldOpen: true, leftoverGroupStopped: true }), command('none', { leftoversStopped: [] }),
  ] } }, '/ev/pf.json');
  for (const name of ['group', 'pids', 'held']) assert.match(text, new RegExp(`^- WARNING: \`${name}\` left process\\(es\\) running; preflight stopped them$`, 'm'), name);
  assert.match(text, /^- WARNING: `held` left a process holding its output open; it may still be running$/m);
  assert.equal(text.match(/WARNING/g).length, 4, text);
});

test('buildRecheckPacket: evidence given for a short packet with no evidence section is added before Checks, with the author-reported slot', () => {
  const oldPacket = lines('# Task packet: fix diff', '', '## Scope', 's', '', '## Acceptance criteria', '- [AC-1] one', '', '## Checks', 'c', '', '## Output', 'o');
  const { text } = buildRecheckPacket({ oldPacket, findingsDoc: FINDINGS, evidenceText: 'From /ev/pf.json:\n- snapshotHash hash-current' });
  assert.match(text, /## Evidence both seats may cite\nFrom \/ev\/pf\.json:\n- snapshotHash hash-current\n\n## Author-reported evidence \(not reproducible; do not cite as EXECUTED\)\nFILL: /);
  assert.ok(text.indexOf('## Evidence both seats may cite') < text.indexOf('## Checks'), 'before Checks, as in the template');
  assert.ok(text.indexOf('## Acceptance criteria') < text.indexOf('## Evidence both seats may cite'));
  assert.equal((text.match(/^## Evidence both seats may cite$/gm) ?? []).length, 1);
  const none = buildRecheckPacket({ oldPacket, findingsDoc: FINDINGS }).text;
  assert.doesNotMatch(none, /## Evidence both seats may cite/, 'without evidence nothing is added');
});

test('buildRecheckPacket: each carried-over section names itself in its FILL line', () => {
  const oldPacket = lines('# Task packet: X', '', '## Scope', 's', '', '## Start here (large targets)', 'read a.py', '', '## Checks', 'c');
  const { fills } = buildRecheckPacket({ oldPacket, findingsDoc: FINDINGS });
  const carried = fills.map((f) => f.text).filter((t) => t.startsWith('FILL: carried over'));
  assert.deepEqual(carried.map((t) => /section "([^"]*)"/.exec(t)?.[1]), ['Scope', 'Start here (large targets)', 'Checks']);
});

test('field: recheck --out into a folder that does not exist yet creates it and writes the packet', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck-newdir-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, 'old-run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), OLD_PACKET);
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify(FINDINGS));
  const out = path.join(dir, 'new', 'deeper', 'task-packet.md');
  const r = await runCli(['--from-run', run, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out) && existsSync(path.join(path.dirname(out), 'previous-run.json')));
  const again = await runCli(['--from-run', run, '--out', out]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists; it is never overwritten/);
});

test('--since-dirs and --since-commit read the diff when the user Git config forces color on or drops the a/ b/ prefixes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck color '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'repo');
  await fs.mkdir(target);
  const git = (...a) => { const r = spawnSync('git', a, { cwd: target, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  await fs.writeFile(path.join(target, 'x.py'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(target, 'x.py'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'fix');
  for (const d of ['old', 'new']) await fs.mkdir(path.join(root, d));
  await fs.writeFile(path.join(root, 'old', 'y.py'), 'a\n');
  await fs.writeFile(path.join(root, 'new', 'y.py'), 'b\nc\n');
  const run = path.join(root, 'run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\ns\n');
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: target }));
  for (const [section, key, value] of [['color', 'ui', 'always'], ['color', 'diff', 'always'], ['diff', 'noprefix', 'true'], ['diff', 'mnemonicPrefix', 'true']]) {
    const cfg = path.join(root, `${section}-${key}.gitconfig`);
    await fs.writeFile(cfg, `[${section}]${NL}\t${key} = ${value}${NL}`);
    const env = { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };
    // The config does change a plain git diff, so the step below meets that output unless it overrides the setting.
    const plain = spawnSync('git', ['diff', base], { cwd: target, encoding: 'utf8', env: { ...process.env, ...env } });
    if (section === 'color') assert.ok(plain.stdout.includes(String.fromCharCode(27)), `color.${key}=always colors git diff`);
    else assert.doesNotMatch(plain.stdout, /^diff --git a\/x\.py b\/x\.py$/m, `diff.${key} changes the a/ b/ prefixes`);
    // Each packet goes to its own folder: the step writes since.diff beside it.
    for (const d of [`dirs-${key}`, `commit-${key}`]) await fs.mkdir(path.join(root, d));
    const dirsOut = path.join(root, `dirs-${key}`, 'task-packet.md');
    const dirs = await runCli(['--from-run', run, '--out', dirsOut, '--since-dirs', path.join(root, 'old'), path.join(root, 'new')], env);
    assert.equal(dirs.status, 0, dirs.stderr);
    assert.match(await fs.readFile(dirsOut, 'utf8'), /^- y\.py \(\+2 -1\)$/m);
    const commitOut = path.join(root, `commit-${key}`, 'task-packet.md');
    const commit = await runCli(['--from-run', run, '--out', commitOut, '--since-commit', base], env);
    assert.doesNotMatch(commit.stderr, /TypeError|Cannot read/);
    assert.equal(commit.status, 0, commit.stderr);
    assert.match(await fs.readFile(commitOut, 'utf8'), /^- x\.py \(\+1 -0\)$/m);
  }
});

test('--since-commit lists a submodule pointer change when the user Git config sets diff.submodule=log', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recheck submodule '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // The author on every call: the submodule's own clone has no config, and a host may have no global identity.
  const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const sub = path.join(root, 'sub');
  const target = path.join(root, 'repo');
  for (const [dir, file] of [[sub, 'lib.py'], [target, 'x.py']]) {
    await fs.mkdir(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'a@b.c');
    git(dir, 'config', 'user.name', 't');
    await fs.writeFile(path.join(dir, file), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  git(target, 'submodule', 'add', '-q', sub, 'sub');
  git(target, 'commit', '-q', '-m', 'add sub');
  const base = git(target, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(target, 'sub', 'lib.py'), 'one\ntwo\n');
  git(path.join(target, 'sub'), 'commit', '-q', '-am', 'sub fix');
  git(target, 'commit', '-q', '-am', 'bump sub');
  const run = path.join(root, 'run');
  await fs.mkdir(path.join(run, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(run, 'task-packet.md'), '# Task packet: X\n\n## Scope\ns\n');
  await fs.writeFile(path.join(run, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({ targetDir: target }));
  const cfg = path.join(root, 'submodule.gitconfig');
  await fs.writeFile(cfg, `[diff]${NL}\tsubmodule = log${NL}`);
  const plain = spawnSync('git', ['diff', base], { cwd: target, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.match(plain.stdout, /^Submodule sub /m, 'diff.submodule=log changes a plain git diff');
  await fs.mkdir(path.join(root, 'out'));
  const out = path.join(root, 'out', 'task-packet.md');
  const r = await runCli(['--from-run', run, '--out', out, '--since-commit', base], { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /^- sub \(\+1 -1\)$/m);
});
