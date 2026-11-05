import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  expandTagRange, parseArgs, isBlocker, shortTitle, compactTokens, seatCostRow, perCallNewInput, costTableLines, packetCriteria, criteriaGroup, buildCriteria, notesSections,
  parseOutcome, packetTicketMap, noteKinds, findingStatus, costNote, parseVerdict, buildTickets, groupFindings, renderChat, buildReport, renderText, renderMarkdown, renderHtml, loadRun, headingTags, outcomeOf, diffHunks, whereInChange,
  notCheckedLine, unopenedWebConcedes,
} from '../build-report.mjs';

// The step in-process, as the script was run: env holds the variables set (or, undefined, removed) for the call.
async function runCli(args, env = {}) {
  const { runStep } = await import('../build-report.mjs');
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

const finding = (over) => ({
  id: 'F1', origins: ['A1'], severity: 'LOW', basis: 'EXECUTED', evidence_strength: 'REPRODUCED', final_state: 'settled-agree',
  summary: 'A short summary. More text follows.', auditor_check: { result: 'CONFIRMED' }, ...over,
});

const PACKET = lines(
  '# Packet', '## Acceptance criteria',
  '- [AC-6040-1] Keeps Unknown.', '- [AC-6040-2] Ignores Unknown.', '- [AC-6040-3] No cross-tier media.', '- [H1] A hypothesis.',
);
const SEAT_A = lines(
  '# Seat A findings', '', '## A1 [AC-6040-1] Blank type becomes Unknown', 'Severity: LOW', '',
  '## Checks performed', '- [AC-6040-2]: ran the synthetic payload, no issue.', '', '## Rebuttals (from B) of A claims', 'x',
);
const SEAT_B = lines('# Seat B findings', '', '## No findings', '', '- H1: confirmed by static read.', 'Blocked: none');

const MANIFEST = {
  status: 'completed', mode: 'adversarial', topology: 'cross-vendor', run_id: 'abcdef123456',
  reviewers: [{ role: 'A', provider: 'anthropic', transport: 'native' }, { role: 'B', provider: 'openai', transport: 'cli' }],
  exchange: { blinded: true, auditor: 'fresh-context', audit_depth: 'light' }, falsification: { requested: false, verifiers_run: 0 },
  support: [{ role: 'A', runtime: 'claude', transport: 'native', status: 'supported' }],
  seat_usage: {
    A: { new_input_tokens: 226966, context_reread_tokens: 8283728, calls: 51, output_tokens: null },
    B: { input_tokens: 1757464, cached_input_tokens: 1627392, output_tokens: 19558 },
    auditor: {},
  },
};

test('isBlocker: unresolved-high-stakes, or HIGH/CRITICAL after the audit, unless refuted or dropped', () => {
  assert.equal(isBlocker(finding({ final_state: 'unresolved-high-stakes', severity: 'LOW' })), true);
  assert.equal(isBlocker(finding({ severity: 'HIGH' })), true);
  assert.equal(isBlocker(finding({ severity: 'CRITICAL', final_state: 'unresolved-low-stakes' })), true);
  assert.equal(isBlocker(finding({ severity: 'HIGH', severity_audited: 'LOW' })), false, 'the audited severity decides');
  assert.equal(isBlocker(finding({ severity: 'LOW', severity_audited: 'HIGH' })), true);
  assert.equal(isBlocker(finding({ severity: 'HIGH', final_state: 'settled-refuted' })), false);
  assert.equal(isBlocker(finding({ severity: 'HIGH', final_state: 'dropped-speculative' })), false);
  assert.equal(isBlocker(finding({ severity: 'MEDIUM' })), false);
});

test('shortTitle: first sentence, cut at a clause break or word boundary, never mid-word', () => {
  assert.equal(shortTitle({ summary: 'Short one. Second sentence.' }), 'Short one.');
  const long = 'The disclosed reason for the NetBackup pool() category change is wrong: with debug off release does not crash and more words follow here for a long time.';
  assert.equal(shortTitle({ summary: long }), 'The disclosed reason for the NetBackup pool() category change is wrong');
  const noClause = 'word '.repeat(60).trim() + '.';
  const t = shortTitle({ summary: noClause });
  assert.ok(t.length <= 110 && t.endsWith('...') && !/\bwor\.\.\.$/.test(t), t);
  assert.equal(shortTitle({ title: 'Given title', summary: 'x' }), 'Given title');
  // Round 5: a colon inside "${env:X}" or "C:\" is no clause break.
  const env = 'Two Windows spellings of a home-folder path, ${env:USERPROFILE} and %HOMEDRIVE%%HOMEPATH%, are not expanded by expandPathVars, so the guard misses them.';
  assert.ok(shortTitle({ summary: env }).startsWith('Two Windows spellings of a home-folder path, ${env:USERPROFILE} and'), shortTitle({ summary: env }));
});

test('compactTokens and seatCostRow: both usage shapes in the same columns, unknown when missing, no estimates', () => {
  assert.equal(compactTokens(226966), '227k');
  assert.equal(compactTokens(8283728), '8.3M');
  assert.equal(compactTokens(900), '900');
  assert.equal(compactTokens(null), 'unknown');
  assert.deepEqual(seatCostRow('seat A', MANIFEST.seat_usage.A), { seat: 'seat A', newInput: 226966, cacheWrite: null, cacheRead: 8283728, output: null, calls: 51 });
  assert.deepEqual(seatCostRow('seat B', MANIFEST.seat_usage.B), { seat: 'seat B', newInput: 130072, cacheWrite: null, cacheRead: 1627392, output: 19558, calls: null }, 'Codex input minus cached is the new input; the cached part is the cache read');
  assert.deepEqual(seatCostRow('seat B', { input_tokens: 851000, cached_input_tokens: 750000, output_tokens: 6000 }), { seat: 'seat B', newInput: 101000, cacheWrite: null, cacheRead: 750000, output: 6000, calls: null });
  assert.deepEqual(seatCostRow('auditor', {}), { seat: 'auditor', newInput: null, cacheWrite: null, cacheRead: null, output: null, calls: null });
  assert.deepEqual(seatCostRow('seat C', { input_tokens: 5 }), { seat: 'seat C', newInput: 5, cacheWrite: null, cacheRead: null, output: null, calls: null }, 'no cached figure: nothing is split or invented');
  assert.equal(seatCostRow('seat D', { input_tokens: 5, cached_input_tokens: 9 }).newInput, null, 'more cached than input: not this shape, so unknown, never 0 or negative');
  assert.deepEqual(costTableLines([seatCostRow('seat A', MANIFEST.seat_usage.A), seatCostRow('seat B', MANIFEST.seat_usage.B), seatCostRow('auditor', {})]), [
    'Seat     New input  Cache read   Output  Calls',
    'seat A        227k        8.3M  unknown     51',
    'seat B        130k        1.6M      20k      -',
    'auditor    unknown     unknown  unknown      -',
  ]);
});

test('packetCriteria and criteriaGroup: every tagged line, grouped by ticket number', () => {
  const c = packetCriteria(PACKET);
  assert.deepEqual([...c.keys()], ['AC-6040-1', 'AC-6040-2', 'AC-6040-3', 'H1']);
  assert.equal(criteriaGroup('AC-6040-1'), '6040');
  assert.equal(criteriaGroup('H1'), 'other');
  assert.equal(criteriaGroup('AC-OWN-C'), 'other');
  assert.equal(criteriaGroup('BUG-6030'), '6030', 'a tag that ends in a ticket number');
  assert.equal(criteriaGroup('PROD-6030'), '6030');
  assert.equal(criteriaGroup('AC-1'), 'other', 'a short number is not a ticket');
});

test('buildCriteria: issue found beats checked beats NOT VERIFIED; a tag nobody names is never a pass', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'] })] }, manifest: MANIFEST, packetText: PACKET,
    seatTexts: { A: SEAT_A, B: SEAT_B },
  });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r.status]));
  assert.deepEqual(by, { 'AC-6040-1': 'issue', 'AC-6040-2': 'clean', 'AC-6040-3': 'not-verified', H1: 'clean' });
  assert.equal(report.criteria.notVerified, 1);
  assert.deepEqual(report.criteria.rows[0].findings, ['F1']);
  assert.equal(buildCriteria(new Map(), [], new Map(), {}), null);
});

test('buildReport: a withdrawn HIGH is counted as withdrawn, not in the HIGH bar or header; an accepted drift is a caveat', () => {
  const report = buildReport({
    findingsDoc: { audit_depth: 'full', findings: [finding({ id: 'F1', severity: 'HIGH', final_state: 'settled-refuted' }), finding({ id: 'F2', severity: 'HIGH', origins: ['B1'] })] },
    manifest: { ...MANIFEST, drift_accepted: [{ at: '2026-10-16T14:25:00Z', files: ['vsiclient/collectors/ContosoV4Api.py'] }] }, packetText: '', seatTexts: {},
  });
  assert.equal(report.counts.high, 1);
  assert.equal(report.counts.withdrawn, 1);
  const chat = renderChat(report);
  assert.match(chat, /HIGH +█+ +1\n/);
  assert.match(renderMarkdown(report), /\*\*Findings:\*\* 2 \(0 critical, 1 high, 0 medium, 0 low, 1 withdrawn\)/);
  assert.ok(report.caveats.some((c) => /changed after Phase 1 .*--accept-drift \(vsiclient\/collectors\/ContosoV4Api\.py\)/.test(c)), report.caveats.join('\n'));
  // Every finding withdrawn: no severity bar, so no empty code block in chat.
  const allGone = buildReport({ findingsDoc: { audit_depth: 'full', findings: [finding({ id: 'F1', severity: 'HIGH', final_state: 'settled-refuted' })] }, manifest: MANIFEST, packetText: '', seatTexts: {} });
  assert.doesNotMatch(renderChat(allGone), /```\n```/);
  // Every output ends with one line naming the skill, the version that ran (the manifest's) and the project page.
  const stamped = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, skill_version: '9.8.7' }, packetText: '', seatTexts: {} });
  assert.deepEqual({ ...stamped.generator, skill: 'x' }, { skill: 'x', version: '9.8.7', url: 'https://github.com/M-khalifa/SkillArray' });
  const line = /Reviewed with (pair|cross)-review 9\.8\.7 \(SkillArray, MIT license\): https:\/\/github\.com\/M-khalifa\/SkillArray/;
  for (const text of [renderText(stamped), renderMarkdown(stamped), renderChat(stamped)]) assert.match(text.trimEnd().split('\n').at(-1), line);
  assert.equal(renderChat(stamped, { all: true }).match(new RegExp(line.source, 'g')).length, 1, 'chat --all prints it once, from the markdown part');
  assert.match(renderHtml(stamped), /<footer class="meta">Reviewed with (pair|cross)-review 9\.8\.7 \(SkillArray, MIT license\): <a href="https:\/\/github\.com\/M-khalifa\/SkillArray">/);
  assert.match(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: '', seatTexts: {} }).generator.version, /^\d+\.\d+\.\d+$/, 'without a manifest version, this copy\'s SKILL.md version');
  const blind = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, seat_blind_lines: { B: ['- H2: pytest failed: No usable temporary directory found. PARTIAL'] } }, packetText: '', seatTexts: {} });
  assert.ok(blind.caveats.some((c) => /^Seat B may have reviewed blind: .*No usable temporary directory.*"\)\. Check whether the task packet already gave seat B that evidence; if it did, the block matters less\.$/.test(c)), blind.caveats.join('\n'));
  assert.ok(!blind.caveats.some((c) => /weaker than it looks/.test(c)), 'the old alarm sentence is gone');
  const refused = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, status: 'incomplete', format_refused: { A: ['no "## Checks performed" heading after the claims'] } }, packetText: '', seatTexts: {} });
  const blockedSeat = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, status: 'incomplete', blocked_no_findings: ['B'] }, packetText: '', seatTexts: {} });
  assert.ok(blockedSeat.caveats.some((c) => /^Seat B wrote "No findings" but says it was blocked/.test(c)), blockedSeat.caveats.join('\n'));
  assert.ok(refused.caveats.some((c) => /^Seat A's findings file was refused by the format check again after its one rewrite \(no "## Checks performed" heading after the claims\), so this is not a two-seat review\.$/.test(c)), refused.caveats.join('\n'));
  const open =buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, stop_incomplete: ['seat B (phase1)', 'auditor (audit)'] }, packetText: '', seatTexts: {} });
  assert.ok(open.caveats.some((c) => /^Stopped after its answer, but its output stayed open: seat B \(phase1\), auditor \(audit\)\. .*check the process list/.test(c)), open.caveats.join('\n'));
});

test('chat: under a light audit the CHECKED line says how many agreed findings were not re-checked, so 0 confirmed is not read as a failure', () => {
  const nc = { result: 'NOT_CHECKED', basis: null, evidence: null };
  const report = buildReport({ findingsDoc: { audit_depth: 'light', findings: [finding({ id: 'F1', severity: 'LOW', auditor_check: nc }), finding({ id: 'F2', severity: 'LOW', origins: ['B1'], auditor_check: nc })] }, manifest: MANIFEST, packetText: '', seatTexts: {} });
  assert.match(renderChat(report), /CHECKED +0 of 2 findings confirmed by the auditor; 2 not re-checked \(light audit\)/);
  // With many findings the line is cut at 100 characters: the unresolved and withdrawn counts come first and stay.
  const many = [...Array.from({ length: 12 }, (_, i) => finding({ id: `F${i + 1}`, severity: 'LOW', origins: [`A${i + 1}`], auditor_check: nc })),
    ...Array.from({ length: 3 }, (_, i) => finding({ id: `F${13 + i}`, severity: 'LOW', origins: [`B${i + 1}`], final_state: 'unresolved-low-stakes', auditor_check: nc })),
    ...Array.from({ length: 2 }, (_, i) => finding({ id: `F${16 + i}`, severity: 'LOW', origins: [`B${i + 4}`], final_state: 'settled-refuted' }))];
  const big = renderChat(buildReport({ findingsDoc: { audit_depth: 'light', findings: many }, manifest: MANIFEST, packetText: '', seatTexts: {} }));
  assert.match(big, /CHECKED +\d+ of 15 findings confirmed by the auditor; 3 unresolved \(F13 F14 F15\); 2 withdrawn/);
});

test('buildReport: severity order, blockers, counts, status and caveats', () => {
  const report = buildReport({
    findingsDoc: {
      audit_depth: 'light',
      findings: [
        finding({ id: 'F2', severity: 'LOW' }), finding({ id: 'F10', severity: 'HIGH', origins: ['B1'] }),
        finding({ id: 'F1', severity: 'MEDIUM', severity_audited: 'LOW' }), finding({ id: 'F3', severity: 'LOW', final_state: 'unresolved-high-stakes' }),
      ],
    },
    manifest: { ...MANIFEST, status: 'incomplete', source_write: ['x.py'] }, packetText: '', seatTexts: {},
  });
  assert.equal(report.status, 'INCOMPLETE');
  assert.deepEqual(report.findings.map((f) => f.id), ['F10', 'F1', 'F2', 'F3'], 'HIGH first, then LOW by number');
  assert.deepEqual(report.blockers.sort(), ['F10', 'F3']);
  assert.deepEqual(report.counts, { critical: 0, high: 1, medium: 0, low: 3, other: 0, withdrawn: 0 });
  assert.equal(report.criteria, null);
  assert.equal(report.coverage.lightNote, 'agreed claims were not re-checked by the auditor');
  assert.ok(report.caveats.some((c) => /incomplete/.test(c)));
  assert.ok(report.caveats.some((c) => /write to the reviewed source/.test(c)));
});

test('buildReport: a Claude CLI seat adds the read-only statement, a native one does not', () => {
  const base = { findingsDoc: { findings: [] } };
  const cli = buildReport({ ...base, manifest: { ...MANIFEST, reviewers: [{ role: 'A', provider: 'anthropic', transport: 'cli' }] } });
  assert.ok(cli.caveats.some((c) => /fileTools: enforced.*shell: prompt-only/.test(c)));
  assert.equal(buildReport({ ...base, manifest: MANIFEST }).caveats.length, 0);
});

test('buildReport: refused tool calls of a seat or the auditor are named with their tools; none adds no line', () => {
  const base = { findingsDoc: { findings: [] } };
  const reviewers = [{ role: 'A', permission_denials: { count: 3, tools: { Bash: 1, Read: 2 } } }, { role: 'B' }];
  const actors = [{ role: 'auditor', permission_denials: { count: 1, tools: { Read: 1 } } }, { role: 'verifier-2', permission_denials: { count: 2, tools: { Grep: 2 } } }];
  const lines = buildReport({ ...base, manifest: { ...MANIFEST, reviewers, actors } }).caveats.filter((c) => /refused/.test(c));
  assert.deepEqual(lines, [
    'Seat A: Claude Code refused 3 tool calls (Read 2, Bash 1); it may have reviewed with less than it asked for. See permissionDenials in its result.json.',
    'The auditor: Claude Code refused 1 tool call (Read 1); it may have reviewed with less than it asked for. See permissionDenials in its result.json.',
    'Verifier 2: Claude Code refused 2 tool calls (Grep 2); it may have reviewed with less than it asked for. See permissionDenials in its result.json.',
  ]);
  const zero = [{ role: 'A', permission_denials: { count: 0, tools: {} } }];
  assert.equal(buildReport({ ...base, manifest: { ...MANIFEST, reviewers: zero } }).caveats.filter((c) => /refused/.test(c)).length, 0);
  assert.equal(buildReport({ ...base, manifest: MANIFEST }).caveats.length, 0, 'no field, no line');
});

test('buildReport: a native seat with no transcript says its model and usage are not recorded, and names the flag', () => {
  const base = { findingsDoc: { findings: [] } };
  const support = [{ role: 'A', runtime: 'codex', transport: 'native', status: 'supported' }, { role: 'auditor', runtime: 'codex', transport: 'native', status: 'supported' }];
  const caveats = buildReport({ ...base, manifest: { ...MANIFEST, support, seat_usage: { A: MANIFEST.seat_usage.A } } }).caveats;
  assert.deepEqual(caveats.filter((c) => /no transcript/.test(c)), ['Seat auditor ran as a native agent with no transcript, so its model and token use are not recorded: rerun review-run manifest with --seat-transcript auditor=<its transcript or rollout>.']);
  const fromResult = buildReport({ ...base, manifest: { ...MANIFEST, support, seat_usage: {}, reviewers: [{ role: 'A', usage: { input_tokens: 1 } }, { role: 'auditor', usage: { input_tokens: 1 } }] } }).caveats;
  assert.ok(!fromResult.some((c) => /no transcript/.test(c)), 'usage in a reviewer row counts as recorded');
  const empty = buildReport({ ...base, manifest: { ...MANIFEST, support, seat_usage: { A: {}, auditor: { source: 'unknown' } }, reviewers: [{ role: 'A', usage: {} }] } }).caveats;
  assert.equal(empty.filter((c) => /no transcript/.test(c)).length, 2, 'an empty or unknown entry records nothing');
});

test('notesSections: Why and Decisions needed come from the notes file', () => {
  const n = notesSections(lines('## Why', 'One sentence.', '', '## Decisions needed', '| a | b |', '|---|---|'));
  assert.equal(n.why, 'One sentence.');
  assert.equal(n['decisions needed'], '| a | b |' + NL + '|---|---|');
});

test('renderText: plain output is ASCII with no escape codes; colour output adds them', () => {
  const report = buildReport({ findingsDoc: { findings: [finding({ severity: 'HIGH' })] }, manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_A, B: SEAT_B }, notesText: lines('## Why', 'Because.') });
  const plain = renderText(report, { color: false });
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(plain, /^[\x00-\x7f]*$/, 'ASCII only');
  assert.match(plain, /STATUS COMPLETE {3}Blockers: 1/);
  assert.match(plain, /FIX OR DECIDE FIRST/);
  assert.match(plain, /NOT VERIFIED/);
  assert.match(plain, /Why: Because\./);
  assert.match(plain, /COST \(tokens\)\n {2}Seat +New input +Cache read +Output +Calls\n {2}seat A +227k +8\.3M/);
  assert.match(renderText(report, { color: true }), /\x1b\[31m/);
});

test('renderText: a missing Why is stated, and no findings reads No findings', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST });
  const text = renderText(report);
  assert.match(text, /Why: \(not written/);
  assert.match(text, /No findings\./);
});

test('renderMarkdown and renderHtml escape finding text and keep the same facts', () => {
  const report = buildReport({ findingsDoc: { findings: [finding({ summary: 'Tag <script>x</script> & more.', severity: 'HIGH' })] }, manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_A, B: SEAT_B } });
  const html = renderHtml(report);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; more\./);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /Not verified/);
  const md = renderMarkdown(report);
  assert.match(md, /\*\*Status:\*\* COMPLETE \| \*\*Blockers:\*\* 1/);
  assert.match(md, /\| AC-6040-3 \| \*\*NOT VERIFIED\*\*/);
});

test('parseArgs: --run-dir is required; --color is validated; unknown flags are refused', () => {
  assert.throws(() => parseArgs([]), /--run-dir/);
  assert.throws(() => parseArgs(['--run-dir', 'x', '--color', 'blue']), /--color/);
  assert.throws(() => parseArgs(['--run-dir', 'x', '--wat']), /unrecognized/);
  assert.equal(parseArgs(['--run-dir', 'x', '--html', 'r.html']).html, 'r.html');
});

async function makeRun(t, { manifest = MANIFEST, notes = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build report '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'phase3'), { recursive: true });
  await fs.mkdir(path.join(dir, 'phase1'), { recursive: true });
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify({ audit_depth: 'light', findings: [finding({ severity: 'HIGH' })] }));
  if (manifest) await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, 'task-packet.md'), PACKET);
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), SEAT_A);
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), SEAT_B);
  if (notes) await fs.writeFile(path.join(dir, 'phase3', 'report-notes.md'), lines('## Why', 'From the notes file.'));
  return dir;
}

test('CLI: prints the terminal report by default and writes no file unless asked', async (t) => {
  const dir = await makeRun(t);
  const r = await runCli(['--run-dir', dir], { NO_COLOR: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STATUS COMPLETE/);
  assert.match(r.stdout, /Why: From the notes file\./);
  assert.doesNotMatch(r.stdout, /\x1b/, 'piped output has no colour');
  for (const name of ['report.md', 'report.html', 'report.json']) assert.equal(existsSync(path.join(dir, name)), false, `${name} is not written by default`);
});

test('CLI: --out, --json and --html write the optional files; --color always forces colour', async (t) => {
  const dir = await makeRun(t);
  const out = path.join(dir, 'r.md');
  const html = path.join(dir, 'r.html');
  const json = path.join(dir, 'r.json');
  const r = await runCli(['--run-dir', dir, '--out', out, '--html', html, '--json', json, '--color', 'always']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\x1b\[/);
  assert.match(await fs.readFile(out, 'utf8'), /^# Review report: COMPLETE/);
  assert.match(await fs.readFile(html, 'utf8'), /^<!doctype html>/);
  assert.equal(JSON.parse(await fs.readFile(json, 'utf8')).blockers[0], 'F1');
});

test('CLI: a run with no manifest says status and cost are unknown; a missing findings file with a seat file missing too is an error', async (t) => {
  const dir = await makeRun(t, { manifest: null });
  const report = await loadRun(dir);
  // An audited run reported before its manifest is NOT FINAL in every format, never COMPLETE or INCOMPLETE.
  assert.equal(report.status, 'NOT FINAL');
  assert.match(report.caveats[0], /^manifest\.json is not built yet, so this report is not final .*: run review-run manifest, then the report again\.$/);
  assert.ok(!report.caveats.some((c) => /was not found|The review is incomplete/.test(c)), report.caveats.join(' | '));
  assert.match(renderChat(report), /^> \*\*REVIEW NOT FINAL /);
  assert.match(renderText(report), /STATUS NOT FINAL/);
  assert.match(renderMarkdown(report), /^# Review report: NOT FINAL/);
  assert.match(renderHtml(report), /<span class="status incomplete">NOT FINAL<\/span>/);
  const jsonOut = path.join(dir, 'report.json');
  assert.equal((await runCli(['--run-dir', dir, '--json', jsonOut])).status, 0);
  assert.equal(JSON.parse(await fs.readFile(jsonOut, 'utf8')).status, 'NOT FINAL');
  await fs.rm(jsonOut);
  await fs.rm(path.join(dir, 'phase3', 'findings.json'));
  // Two finished seat files (each closing section with its Blocked: line).
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] x', 'Severity: LOW', 'Same shape elsewhere: none found', '', '## Checks performed', '- [AC-6040-2]: ok.', 'Blocked: none'));
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), lines('# Seat B findings', '', '## No findings', '', 'Blocked: none'));
  const phase1 = await runCli(['--run-dir', dir]);
  assert.equal(phase1.status, 0, 'both seat files: the Phase 1 report');
  const phase1Report = await loadRun(dir);
  assert.equal(phase1Report.status, 'INCOMPLETE', 'no findings.json and no manifest stays INCOMPLETE');
  assert.match(phase1Report.caveats[0], /manifest\.json was not found/);
  // A refused auditor file waiting for its rewrite: the report says the audit is pending, not that the run stopped before it.
  await fs.writeFile(path.join(dir, 'phase3', 'prompt-auditor-fix.txt'), 'Your audit file was refused.\n');
  const pending = await loadRun(dir);
  assert.equal(pending.status, 'INCOMPLETE');
  assert.match(pending.caveats[0], /^The auditor's file was refused and review-run audit --finish has not passed since \(phase3\/prompt-auditor-fix\.txt\)/);
  assert.match(renderChat(pending), /> Caveat: The auditor's file was refused/);
  await fs.rm(path.join(dir, 'phase3', 'prompt-auditor-fix.txt'));
  await fs.rm(path.join(dir, 'phase1', 'B-findings.md'));
  const r = await runCli(['--run-dir', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read findings/);
});

test('zero-claim run: with no findings.json and no claim in either seat file the report still prints the criteria; a claim without findings.json gives the Phase 1 report', async (t) => {
  const dir = await makeRun(t);
  await fs.rm(path.join(dir, 'phase3', 'findings.json'));
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## No findings', '', '- [AC-6040-1]: ran it, no issue.', '- [AC-6040-2]: ran it, no issue.', '- [AC-6040-3]: ran it, no issue.'));
  const report = await loadRun(dir);
  assert.equal(report.total, 0);
  assert.equal(report.criteria.criteriaCount, 3);
  assert.equal(report.criteria.issue, 0);
  assert.equal(report.coverage.auditDepth, 'not run (no claims)');
  assert.equal(report.coverage.lightNote, null);
  assert.ok(report.caveats.some((c) => /Neither seat raised a claim, so no auditor ran/.test(c)));
  // Mac round 4 F1: without findings.json the zero-claim step that checks the target did not run, whatever the manifest says.
  assert.equal(report.status, 'INCOMPLETE');
  assert.ok(report.caveats.some((c) => /phase3\/findings\.json is missing, so the zero-claim step .* did not run/.test(c)));
  assert.ok(!report.caveats.some((c) => /the target was still checked/.test(c)));
  const text = renderText(report);
  assert.match(text, /No findings\./);
  assert.match(text, /AC-6040-2 +no issue found \(A\)/);
  assert.match(text, /Audit depth: not run \(no claims\)/);
  // Linux round linux-r5 A2: an older run (no brief stating the Blocked: and Same shape rules) is read without them.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] x', 'Severity: LOW', '', '## Checks performed', '- [AC-6040-2]: ok.'));
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), lines('# Seat B findings', '', '## No findings', '', '- [AC-6040-1]: ok.'));
  assert.equal((await loadRun(dir)).findings.length, 1, 'linux-r5 A2: an older run\'s finished files are reported');
  // Linux round linux-r6 B1: the protocol's wording quoted inside the frozen packet is no rule of that run.
  await fs.writeFile(path.join(dir, 'phase1', 'brief-A.txt'), 'Older brief text.\n\n# Task packet (frozen)\n\nThe new protocol says: `Blocked: none` (nothing after it). `Same shape elsewhere:` is required in every claim.\n\nLast rule, easy to miss: never write a claim ID inside a fence.\n');
  assert.equal((await loadRun(dir)).findings.length, 1, 'linux-r6 B1: a rule quoted in the packet');
  // Windows round win-r6 B1: the packet quotes the closing reminder too, before the rules it quotes.
  await fs.writeFile(path.join(dir, 'phase1', 'brief-A.txt'), 'Older brief text.\n\n# Task packet (frozen)\n\nQuote: "Last rule, easy to miss" ends the brief. The new protocol says: `Blocked: none` (nothing after it). `Same shape elsewhere:` is required in every claim.\n\nLast rule, easy to miss: never write a claim ID inside a fence.\n');
  assert.equal((await loadRun(dir)).findings.length, 1, 'win-r6 B1: the quoted reminder');
  // Windows round win-r6 A2: an older run that writes "blocked:" elsewhere or marks its Blocked line is not refused for it.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] x', 'Severity: LOW', 'The service log said blocked: retry later.', '', '## Checks performed', '- [AC-6040-2]: ok.', '- **Blocked:** none'));
  assert.equal((await loadRun(dir)).findings.length, 1, 'win-r6 A2: an older run\'s other Blocked wording');
  // Linux round linux-r6 B2: an older run is excused the Blocked: rule only, not a structural problem.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] x', 'Severity: LOW', '', '## Checks performed', '- [AC-6040-2]: ok.', '', '## Checks performed', '- again'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'linux-r6 B2: a second closing section');
  await fs.rm(path.join(dir, 'phase1', 'brief-A.txt'));
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] x', 'Severity: LOW', '', '## Checks performed', '- [AC-6040-2]: ok.'));
  // This run's brief states both rules.
  // Windows round win-r5 B3: only the protocol's wording of a rule counts, not the word in a quoted log.
  await fs.writeFile(path.join(dir, 'phase1', 'brief-A.txt'), 'Task packet: captured output:\nBlocked: service: connection refused\n');
  assert.equal((await loadRun(dir)).findings.length, 1, 'win-r5 B3: a quoted Blocked: line is no rule');
  await fs.writeFile(path.join(dir, 'phase1', 'brief-A.txt'), 'End with `Blocked: none` (nothing after it). `Same shape elsewhere:` is required in every claim.\n');
  // Field feedback S8: a run stopped after Phase 1 reports each seat's own claims, marked as neither cross-examined nor audited.
  const finishedA =lines('# Seat A findings', '', '## A1 [AC-6040-1] Blank type becomes Unknown', 'Severity: LOW', 'Same shape elsewhere: none found', '', '## Checks performed', '- [AC-6040-2]: ran the synthetic payload, no issue.', 'Blocked: none');
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), finishedA);
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), lines('# Seat B findings', '', '## No findings', '', '- [AC-6040-1]: ran it, no issue.', 'Blocked: none'));
  const stopped = await loadRun(dir);
  assert.equal(stopped.status, 'INCOMPLETE');
  assert.ok(stopped.total > 0, 'field feedback S8: seat A\'s claims are listed');
  assert.ok(stopped.findings.every((f) => /^A\d+$/.test(f.id) && f.state === 'phase1-only' && f.severity !== 'UNKNOWN' && f.title !== ''), JSON.stringify(stopped.findings));
  assert.ok(stopped.caveats.some((c) => /stopped before the audit: these are each seat's own Phase 1 claims/.test(c)));
  // Linux round linux-r3 B3 and Windows round win-r3 A2, B4: a seat file still being written (no closing section) is not
  // reported as that seat's claims.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## A1 [AC-6040-1] Blank type becomes Unknown', 'Severity: LOW', '', '## A2 [AC-6040-1] cut off here'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'win-r3 A2: an unfinished seat file');
  // Linux round linux-r4 B3: the closing heading alone (no Blocked: line yet) is still a file being written.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), finishedA.replace(/\nBlocked: none\n?$/, '\n'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'linux-r4 B3: the closing heading alone');
  // Windows round win-r5 B1: an unclosed fence after the closing lines is a file still being written.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), `${finishedA}\`\`\`\nstill writing\n`);
  await assert.rejects(loadRun(dir), /cannot read findings/, 'win-r5 B1: an unclosed fence');
  // Linux round linux-r5 B2: the zero-finding path too: "## No findings" without its Blocked: line is a file being written.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## No findings', ''));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'linux-r5 B2: an unfinished zero-finding file');
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), SEAT_A);
  await fs.rm(path.join(dir, 'phase1', 'A-findings.md'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'a missing seat file is not a zero-claim run');
  // Restructure round 1 F1: a run stopped by a seat file refused after its one rewrite has no findings.json; it renders INCOMPLETE.
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), SEAT_A);
  await fs.writeFile(path.join(dir, 'phase1', 'format-refused.json'), JSON.stringify({ B: ['no "## Checks performed" heading after the claims'] }));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, status: 'incomplete', format_refused: { B: ['no "## Checks performed" heading after the claims'] } }));
  const refused = await loadRun(dir);
  assert.equal(refused.status, 'INCOMPLETE');
  assert.equal(refused.total, 0);
  assert.ok(refused.caveats.some((c) => /Seat B's findings file was refused by the format check again after its one rewrite/.test(c)), refused.caveats.join(' | '));
  // Restructure round 2 F11: the FILES line names only files that exist.
  assert.equal(refused.files.findings, null);
  assert.doesNotMatch(renderText(refused), /phase3\/findings\.json/);
});

test('zero-claim run: a findings.json written by audit --prepare (zero_claims) gives the same caveat and depth', () => {
  const report = buildReport({ findingsDoc: { audit_depth: 'light', zero_claims: true, findings: [] }, manifest: MANIFEST });
  assert.equal(report.coverage.auditDepth, 'not run (no claims)');
  assert.ok(report.caveats[0].startsWith('Neither seat raised a claim'));
});

test('cost rows: seats first, then auditor, then anything else, orchestrator last', () => {
  const manifest = { ...MANIFEST, seat_usage: { orchestrator: {}, auditor: {}, A: {} }, reviewers: [{ role: 'B', usage: { input_tokens: 1 } }] };
  assert.deepEqual(buildReport({ findingsDoc: { findings: [] }, manifest }).cost.map((r) => r.seat), ['seat A', 'seat B', 'auditor', 'orchestrator']);
});

test('cost: a Codex seat whose usage is only under reviewers[] still gets a cost line', () => {
  const manifest = { ...MANIFEST, seat_usage: { A: MANIFEST.seat_usage.A }, reviewers: [{ role: 'A' }, { role: 'B', usage: MANIFEST.seat_usage.B }] };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest });
  assert.deepEqual(report.cost.map((r) => [r.seat, r.newInput, r.cacheRead, r.output]), [['seat A', 226966, 8283728, null], ['seat B', 130072, 1627392, 19558]]);
  const both = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, reviewers: [{ role: 'B', usage: { input_tokens: 1 } }] } });
  assert.equal(both.cost.filter((r) => r.seat === 'seat B').length, 1, 'seat_usage wins; no duplicate row');
});

test('cost: a resumed Codex seat shows the total once, plus each call\'s own new tokens', () => {
  const usage = { input_tokens: 2175741, cached_input_tokens: 2042240, output_tokens: 36557 };
  const manifest = { ...MANIFEST, seat_usage: {}, reviewers: [{ role: 'B', usage, usage_per_call: [{ input_tokens: 1323560, cached_input_tokens: 1202560 }, { input_tokens: 852181, cached_input_tokens: 839681 }] }] };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest });
  assert.equal(report.cost.length, 1);
  assert.deepEqual([report.cost[0].newInput, report.cost[0].cacheRead], [133501, 2042240], 'total new input and total cache read, once');
  assert.deepEqual(perCallNewInput([{ input_tokens: 1323560, cached_input_tokens: 1202560 }, { input_tokens: 852181 }]), [121000, null], 'no cached figure: unknown, never the raw input');
  assert.match(renderText(report), /seat B new input per call: 121k, 12\.5k|seat B new input per call: 121k, 13k/);
  assert.match(renderMarkdown(report), /\| seat B \| 134k \| 2M \| 37k \| - \|/);
  assert.match(renderHtml(report), /<td>seat B<\/td><td>134k<\/td><td>2M<\/td>/);
  const one = buildReport({ findingsDoc: { findings: [] }, manifest: { ...manifest, reviewers: [{ role: 'B', usage, usage_per_call: [{ input_tokens: 5 }] }] } });
  assert.equal(one.cost[0].perCall, undefined, 'a single call has no split');
});

test('criteria: hypotheses are counted apart from criteria, and every row prints, clean ones too', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'] })] }, manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_A, B: SEAT_B },
  });
  assert.equal(report.criteria.criteriaCount, 3);
  assert.equal(report.criteria.hypothesisCount, 1);
  assert.equal(report.criteria.rows.find((r) => r.tag === 'H1').group, 'hypotheses');
  const text = renderText(report);
  assert.match(text, /CRITERIA \(3\)  1 issue found \| 1 no issue found \| 1 NOT VERIFIED/);
  assert.match(text, /HYPOTHESES \(1\)  1 confirmed/);
  assert.match(text, /Ticket 6040: 1 issue found, 1 no issue found, 1 not verified/);
  assert.match(text, /AC-6040-2 +no issue found \(A\)/, 'a clean row is listed, not hidden');
  assert.match(text, /AC-6040-3 +NOT VERIFIED/);
  assert.match(text, /Hypotheses: 1 confirmed/);
  assert.match(text, /H1 +B confirmed/, 'the outcome the seat wrote is shown');
});

test('packetTicketMap: a Tickets line maps tags to ticket numbers, and the report groups by them, in ticket order', () => {
  const packet = lines(
    '## Acceptance criteria', '- [AC-6040-1] One.', '- [AC-OWN-C] Owner item C.', '- [AC-OWN-D] Owner item D.', '- [AC-OWN-E] Owner item E.',
    '- Tickets 6041, 6045 and 6049 are collector tickets.',
    'Tickets: 6049 = AC-OWN-E; 6041 = [AC-OWN-C], AC-OWN-D',
  );
  const map = packetTicketMap(packet);
  assert.deepEqual([...map.entries()], [['AC-OWN-E', ['6049']], ['AC-OWN-C', ['6041']], ['AC-OWN-D', ['6041']]]);
  assert.deepEqual(packetTicketMap('Ticket 6041: AC-OWN-C').get('AC-OWN-C'), ['6041']);
  assert.equal(packetTicketMap('- Tickets 6041, 6045 are collector tickets.').size, 0, 'prose is not a mapping');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: '', B: '' } });
  assert.deepEqual(report.criteria.rows.map((r) => [r.tag, r.group]), [['AC-6040-1', '6040'], ['AC-OWN-C', '6041'], ['AC-OWN-D', '6041'], ['AC-OWN-E', '6049']]);
  const text = renderText(report);
  assert.ok(text.indexOf('Ticket 6040') < text.indexOf('Ticket 6041') && text.indexOf('Ticket 6041') < text.indexOf('Ticket 6049'));
  assert.doesNotMatch(text, /Other criteria/);
});

test('parseOutcome: refuted, partly, mixed and confirmed words on a Checks performed line; nothing otherwise', () => {
  assert.equal(parseOutcome('- H6: disproved. See the claim above.'), 'REFUTED');
  assert.equal(parseOutcome('- H1: only partly confirmed. total_allocated changed.'), 'PARTLY');
  assert.equal(parseOutcome('- H2: confirmed by static read and by synthetic runs.'), 'CONFIRMED');
  assert.equal(parseOutcome('- H4: supported for normal payloads; refuted for malformed Veeam input.'), 'MIXED');
  assert.equal(parseOutcome('- H3: ran the fixture, 20 cases.'), null);
  assert.equal(parseOutcome(null), null);
});

test('hypotheses: a standing finding tagged to a hypothesis confirms it, even when both seats wrote REFUTED for it', () => {
  const packet = lines('- [H1] The new paging loop can stop early.');
  const seatA = lines('## B1 — [H1] paging stops after a short page', '## Checks performed', '- H1: REFUTED (no early stop found in the main path).');
  const seatB = lines('## Checks performed', '- H1: refuted.');
  const findingsDoc = { findings: [finding({ id: 'F6', severity: 'HIGH', origins: ['B1'], title: '[H1] paging stops after a short page' })] };
  const report = buildReport({ findingsDoc, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  const h1 = report.criteria.rows.find((r) => r.tag === 'H1');
  assert.deepEqual(h1.findings, ['F6']);
  assert.equal(h1.verdict, 'confirmed');
  assert.equal(report.criteria.hypothesisStats.refuted, 0);
  // Closing round 2: when a seat found it only partly there, the finding may prove just the broken part: it stays partly.
  for (const [a, b] of [['PARTLY CONFIRMED', 'PARTLY CONFIRMED'], ['PARTLY CONFIRMED', 'REFUTED'], ['CONFIRMED for one case, REFUTED for the other', 'CONFIRMED']]) {
    const partly = buildReport({ findingsDoc, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## B1 — [H1] paging stops after a short page', '## Checks performed', `- H1: ${a}.`), B: lines('## Checks performed', `- H1: ${b}.`) } });
    assert.equal(partly.criteria.rows.find((r) => r.tag === 'H1').verdict, 'partly', `${a} / ${b}`);
  }
});

test('hypotheses: the outcome each seat wrote is shown, a refuted one is called out, an unclear one says so', () => {
  const packet = lines('- [H1] One.', '- [H2] Two.', '- [H3] Three.', '- [H10] Ten.', '- [H5] Five.');
  const seatA = lines('## Checks performed', '- H1: confirmed by static read.', '- H2: disproved by the omitted-tier case.', '- H3: ran the fixture.', '- H10: confirmed.', '- H5: refuted.');
  const seatB = lines('## Checks performed', '- H1: confirmed.', '- H2: supported by one run.', '- H5: disproved.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.deepEqual(by.H1.outcomes, { A: 'CONFIRMED', B: 'CONFIRMED' });
  assert.equal(by.H1.verdict, 'confirmed');
  assert.equal(by.H2.verdict, 'split', 'opposite outcomes are a split, never one seat winning');
  assert.equal(by.H5.verdict, 'refuted', 'both seats refuting');
  assert.equal(by.H3.verdict, 'unparsed');
  assert.deepEqual(by.H10.seats, ['A'], 'H1 does not match inside H10, nor H10 inside H1');
  assert.equal(report.criteria.hypothesisStats.refuted, 1);
  // The auditor rules on findings only, so a split hypothesis has no third verdict: one caveat says so.
  assert.deepEqual(report.caveats.filter((c) => /seats disagree; the auditor rules on findings/.test(c)), ["H2: the seats disagree; the auditor rules on findings, not hypotheses, so no one decided between them: read both seats' lines for it."]);
  const text = renderText(report);
  assert.match(text, /HYPOTHESES \(5\)  1 REFUTED \| 1 seats disagree \| 2 confirmed \| 1 outcome not parsed/);
  assert.match(text, /H2 +SPLIT: A refuted, B confirmed/);
  assert.match(text, /H3 +A outcome not parsed/);
  assert.match(renderMarkdown(report), /- Hypotheses: 1 REFUTED, 1 seats disagree, 2 confirmed, 1 outcome not parsed/);
  // A refuted hypothesis (the suspected defect is gone) is good news; a confirmed one is the red chip.
  assert.match(renderHtml(report), /<span class="chip ok">Refuted<\/span>/);
  assert.match(renderHtml(report), /<span class="chip high">Confirmed<\/span>/);
});

test('tag matching uses word boundaries: AC-6040-1 is not found inside AC-6040-10', () => {
  const packet = lines('- [AC-6040-1] One.', '- [AC-6040-10] Ten.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## Checks performed', '- [AC-6040-10]: ran it, no issue.'), B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r.status]));
  assert.deepEqual(by, { 'AC-6040-1': 'not-verified', 'AC-6040-10': 'clean' });
});

test('a Checks performed heading quoted inside an evidence fence does not hide the real section', () => {
  const packet = lines('- [AC-6040-1] One.', '- [AC-6040-2] Two.');
  const fence = '`'.repeat(3);
  const seatA = lines('## A1 [AC-6040-1] claim', 'Evidence:', fence, '## Checks performed', '- [AC-6040-2]: quoted line', fence, '', '## Checks performed', '- [AC-6040-1]: ran it, no issue.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r.status]));
  assert.equal(by['AC-6040-2'], 'not-verified', 'a tag named only inside the fence is not checked');
});

test('notes: finding status, open items and criteria source are printed; a fixed-after-snapshot status adds a caveat', () => {
  const notes = lines(
    '## Why', 'One sentence.', '', '## Finding status', '- F1: fixed after the snapshot, not re-reviewed', '- F2: disclosure only', '',
    '## Open items', '- Device type routing not confirmed', '', '## Criteria source', 'Ticket text fetched 12:40 PM, revision 7',
  );
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1' }), finding({ id: 'F2', origins: ['A2'] })] }, manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_A, B: SEAT_B }, notesText: notes,
  });
  assert.equal(report.findings.find((f) => f.id === 'F1').status, 'fixed after the snapshot, not re-reviewed');
  assert.equal(report.findings.find((f) => f.id === 'F2').status, 'disclosure only');
  assert.ok(report.caveats.some((c) => /not re-reviewed \(F1\)/.test(c)));
  const text = renderText(report);
  assert.match(text, /F1 +A short summary\. \[fixed after the snapshot, not re-reviewed\]/);
  assert.match(text, /OPEN ITEMS \(not findings\)/);
  assert.match(text, /Device type routing not confirmed/);
  assert.match(text, /Source: Ticket text fetched 12:40 PM, revision 7/);
  assert.match(renderMarkdown(report), /\*\*\[disclosure only\]\*\*/);
  assert.match(renderHtml(report), /<span class="chip medium">fixed after the snapshot/);
});

test('a tag shared by several tickets prints under each ticket, counts once, and a range expands', () => {
  const packet = lines(
    '- [AC-6040-1] One.', '- [AC-6040-2] Two.', '- [AC-OWN-C] Shared owner item.',
    'Tickets: 6040 = AC-6040-1..-2; 6041 = AC-OWN-C; 6045 = AC-OWN-C; 6049 = AC-OWN-C',
  );
  assert.deepEqual(packetTicketMap(packet).get('AC-OWN-C'), ['6041', '6045', '6049']);
  assert.deepEqual(expandTagRange('AC-6040-1..-3'), ['AC-6040-1', 'AC-6040-2', 'AC-6040-3']);
  assert.deepEqual(expandTagRange('AC-6040-2..4'), ['AC-6040-2', 'AC-6040-3', 'AC-6040-4']);
  assert.deepEqual(expandTagRange('AC-OWN-C'), ['AC-OWN-C']);
  assert.deepEqual(expandTagRange('AC-1..9999'), ['AC-1..9999'], 'an absurd range is left alone');
  const withFinding = buildReport({ findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## A1 [AC-OWN-C] Claim'), B: '' } });
  const sharedText = renderText(withFinding);
  assert.equal((sharedText.match(/shared by 6041, 6045, 6049; the findings apply to the tag, not to each ticket/g) ?? []).length, 3);
  assert.match(renderMarkdown(withFinding), /Issue found: F1 \(shared by 6041, 6045, 6049;/);
  assert.match(renderHtml(withFinding), /shared by 6041, 6045, 6049;/);
  assert.doesNotMatch(renderText(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: '', B: '' } })), /shared by/, 'no findings, no note');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: '', B: '' } });
  assert.equal(report.criteria.criteriaCount, 3, 'a shared tag is one criterion');
  assert.equal(report.criteria.notVerified, 3);
  const text = renderText(report);
  for (const ticket of ['6040', '6041', '6045', '6049']) assert.match(text, new RegExp(`Ticket ${ticket}: `), `Ticket ${ticket} has a group`);
  assert.equal((text.match(/AC-OWN-C/g) ?? []).length, 3, 'AC-OWN-C listed under each of its three tickets');
  const md = renderMarkdown(report);
  assert.equal((md.match(/\| AC-OWN-C \|/g) ?? []).length, 3);
  assert.equal((renderHtml(report).match(/<td>AC-OWN-C<\/td>/g) ?? []).length, 3);
});

test('review fixes: whole-tag matching stops at dots, negations are not outcomes, "not fixed" is not a fix', () => {
  const dotted = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-X] a', '- [AC-X.1] b'), seatTexts: { A: lines('## Checks performed', '- AC-X.1 looked fine.'), B: '' } });
  assert.deepEqual(Object.fromEntries(dotted.criteria.rows.map((r) => [r.tag, r.status])), { 'AC-X': 'not-verified', 'AC-X.1': 'clean' });
  const endOfSentence = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-X] a'), seatTexts: { A: lines('## Checks performed', '- Checked AC-X. Fine.'), B: '' } });
  assert.equal(endOfSentence.criteria.rows[0].status, 'clean', 'a full stop after a tag still matches it');
  for (const text of ['H1: not confirmed', 'H1: could not be confirmed', 'H1: not supported by the code', "H1: isn't confirmed", 'H1: unable to confirm, not refuted']) {
    assert.equal(parseOutcome(text), null, text);
  }
  assert.equal(parseOutcome('H1: confirmed, not refuted'), 'CONFIRMED');
  const notes = (status) => buildReport({ findingsDoc: { findings: [finding({ id: 'F2' })] }, manifest: MANIFEST, notesText: lines('## Finding status', `- F2: ${status}`) });
  assert.equal(notes('not fixed, deferred').caveats.length, 0);
  assert.equal(notes("won't fix").caveats.length, 0);
  assert.equal(notes('fixed after the snapshot').caveats.length, 1);
  assert.equal(notes('disclosure only').caveats.length, 0);
});

test('review fixes: a changed severity shows on every finding line, other severities are counted, a non-settled state is shown', () => {
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'MEDIUM', severity_audited: 'LOW' }), finding({ id: 'F2', severity: 'INFO' }),
      finding({ id: 'F3', severity: 'CRITICAL', final_state: 'dropped-speculative' }),
    ] },
    manifest: MANIFEST,
  });
  assert.equal(report.counts.other, 1);
  const text = renderText(report);
  assert.match(text, /1 other/);
  assert.match(text, /LOW +F1 .*\(claimed MEDIUM\)/);
  assert.match(text, /CRITICAL +F3 .*\(dropped-speculative\)/);
  assert.match(renderMarkdown(report), /\*\*LOW\*\* F1: .*claimed MEDIUM/);
  assert.match(renderMarkdown(report), /1 other/);
  assert.match(renderHtml(report), /\(claimed MEDIUM\)/);
});

test('review fixes: a seat that named no tag is called out, and a check a seat called incomplete is flagged', () => {
  const packet = lines('- [AC-1] One.', '- [AC-2] Two.');
  const seatA = lines('## Checks performed', '- [AC-1]: ran it, no issue.', '- [AC-2]: ran the capture; the real capture is not available, so this is unverified.');
  const seatB = lines('## Checks performed', '- Read all the diffs and ran the tests.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  assert.deepEqual(report.criteria.silentSeats, ['B']);
  assert.equal(report.criteria.criteriaStats.doubtful, 1);
  assert.deepEqual(report.criteria.rows.map((r) => r.doubt), [[], ['A']]);
  assert.ok(report.caveats.some((c) => /Seat B wrote checks but named no criterion or hypothesis tag/.test(c)));
  const text = renderText(report);
  assert.match(text, /Seat B wrote checks but named no criterion or hypothesis tag, so its checks are not counted below\./);
  assert.match(text, /1 where a seat said the check was incomplete/);
  assert.match(text, /AC-2 +no issue found \(A\); A said the check was incomplete/);
  const none = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## Checks performed', '- [AC-1] and [AC-2] fine.'), B: '' } });
  assert.deepEqual(none.criteria.silentSeats, [], 'a seat with no checks section is not silent');
  assert.match(renderMarkdown(report), /> Seat B wrote checks but named no criterion/);
  assert.match(renderText(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: lines('## Checks performed', '- nothing tagged') } })), /NOT VERIFIED/, 'sanity');
});

test('review fixes: markdown escapes finding text, unknown coverage says unknown, the html bar counts criteria only, 999500 tokens is 1M', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ summary: 'Bad <script>alert(1)</script> | pipe *bold* ok.' })] },
    manifest: { status: 'completed', reviewers: [{ role: 'A' }] },
    packetText: lines('- [AC-1] One.', '- [H1] Hyp.'),
    seatTexts: { A: lines('## Checks performed', '- [AC-1]: fine.', '- H1: disproved.'), B: '' },
  });
  const md = renderMarkdown(report);
  assert.match(md, /Bad \\<script\\>alert\(1\)\\<\/script\\> \\\| pipe \\\*bold\\\* ok\./);
  assert.match(md, /blind exchange: unknown; fresh auditor: unknown/);
  const html = renderHtml(report);
  assert.match(html, /aria-label="Criteria: 0 issue found, 1 no issue found, 0 not verified"/);
  assert.match(html, /width:100\.0%;background:var\(--ok\)/, 'one clean criterion fills the bar; the refuted hypothesis is not in it');
  assert.equal(compactTokens(999500), '1M');
  assert.equal(compactTokens(999499), '999k');
  assert.equal(notesSections(lines('## Why', 'First.', '## Why', 'Second.')).why, 'First.' + NL + 'Second.');
});

test('review findings: a plain AC-1 tag is not a ticket, a refuted claim is not an issue found, malformed seat files are not a zero-claim run', async (t) => {
  assert.equal(criteriaGroup('AC-1'), 'other');
  assert.equal(criteriaGroup('AC-6040-1'), '6040');
  const plain = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] One.', '- [AC-2] Two.'), seatTexts: { A: '', B: '' } });
  const text = renderText(plain);
  assert.doesNotMatch(text, /Ticket \d/);
  assert.match(text, /Criteria: 0 issue found, 0 no issue found, 2 not verified/);

  const seatA = lines('## A1 [AC-1] Claim', 'Severity: LOW', '', '## Checks performed', '- [AC-1]: ran it.');
  const refuted = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'], final_state: 'settled-refuted' })] }, manifest: MANIFEST,
    packetText: lines('- [AC-1] One.'), seatTexts: { A: seatA, B: '' },
  });
  assert.equal(refuted.criteria.rows[0].status, 'clean', 'a refuted claim leaves the criterion with no issue');
  assert.deepEqual(refuted.criteria.rows[0].refuted, ['F1']);
  assert.match(renderText(refuted), /no issue found \(A\); claim refuted: F1/);
  const kept = buildReport({ findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'] })] }, manifest: MANIFEST, packetText: lines('- [AC-1] One.'), seatTexts: { A: seatA, B: '' } });
  assert.equal(kept.criteria.rows[0].status, 'issue');

  const dir = await makeRun(t);
  await fs.rm(path.join(dir, 'phase3', 'findings.json'));
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', 'garbled output with no claim headings and no marker'));
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), lines('# Seat B findings', '', 'also garbled'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'two malformed seat files are not a zero-claim review');
});

test('review fixes 2: a refuted claim on a tag nobody listed is still no issue found, shown in html too; dotted suffixes are tickets', () => {
  const seatA = lines('## A1 [AC-1] Claim', 'Severity: LOW', '', '## Checks performed', '- [AC-2]: ran it.');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1'], final_state: 'dropped-speculative' })] }, manifest: MANIFEST,
    packetText: lines('- [AC-1] One.', '- [AC-2] Two.'), seatTexts: { A: seatA, B: '' },
  });
  const row = report.criteria.rows.find((r) => r.tag === 'AC-1');
  assert.equal(row.status, 'clean', 'the seat that raised the claim looked at the criterion');
  assert.deepEqual(row.seats, ['A']);
  assert.match(renderText(report), /AC-1 +no issue found \(A\); claim refuted: F1/);
  assert.match(renderMarkdown(report), /No issue found|no issue found \(A\); claim refuted: F1/);
  assert.match(renderHtml(report), /\(claim refuted: F1\)/);
  assert.equal(criteriaGroup('AC-6040-1.2'), '6040');
  assert.equal(criteriaGroup('AC-6040-1-b'), '6040');
});

test('CLI colour: FORCE_COLOR colours captured output, NO_COLOR wins over it, --color never wins over both', async (t) => {
  const dir = await makeRun(t);
  const run = (args, env) => runCli(['--run-dir', dir, ...args], { NO_COLOR: '', FORCE_COLOR: '', ...env });
  const esc = String.fromCharCode(27);
  assert.equal((await run([], { FORCE_COLOR: '1' })).stdout.includes(esc), true, 'FORCE_COLOR=1 colours output that is not a terminal');
  assert.equal((await run([], { FORCE_COLOR: '0' })).stdout.includes(esc), false, 'FORCE_COLOR=0 is off');
  assert.equal((await run([], {})).stdout.includes(esc), false, 'captured output is plain by default');
  assert.equal((await run([], { FORCE_COLOR: '1', NO_COLOR: '1' })).stdout.includes(esc), false, 'NO_COLOR wins over FORCE_COLOR');
  assert.equal((await run(['--color', 'never'], { FORCE_COLOR: '1' })).stdout.includes(esc), false, '--color never wins');
  assert.equal((await run(['--color', 'always'], {})).stdout.includes(esc), true, '--color always colours captured output');
});
const CHAT_FIXTURE = () => buildReport({
  findingsDoc: { findings: [
    finding({ id: 'F1', severity: 'HIGH', origins: ['A1'], summary: 'A native seat can finish a failed review as a clean one. More.' }),
    finding({ id: 'F2', severity: 'MEDIUM', origins: ['A2'], summary: 'Zero-claim review skips worktree cleanup.' }),
    finding({ id: 'F4', severity: 'MEDIUM', origins: ['B1'], summary: 'A refuted claim is counted as issue found.' }),
    finding({ id: 'F6', severity: 'LOW', origins: ['B2'], summary: 'Wrong message for an unaccepted Severity value.' }),
  ] },
  manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_A, B: SEAT_B },
});

test('chat: findings are grouped by what the reader must do, from final state and audited severity only', () => {
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'CRITICAL' }), finding({ id: 'F2', severity: 'LOW', final_state: 'unresolved-high-stakes' }),
      finding({ id: 'F3', severity: 'MEDIUM' }), finding({ id: 'F4', severity: 'LOW' }), finding({ id: 'F5', severity: 'INFO' }),
      finding({ id: 'F6', severity: 'HIGH', final_state: 'settled-refuted' }), finding({ id: 'F7', severity: 'MEDIUM', final_state: 'dropped-speculative' }),
    ] },
    manifest: MANIFEST,
  });
  const ids = (list) => list.map((f) => f.id);
  const g = groupFindings(report);
  assert.deepEqual(ids(g.fixNow), ['F1']);
  assert.deepEqual(ids(g.decide), ['F2']);
  assert.deepEqual(ids(g.fixNext), ['F3', 'F5'], 'a severity outside the four levels is never hidden under "can wait"');
  assert.deepEqual(ids(g.canWait), ['F4']);
  assert.deepEqual(ids(g.withdrawn), ['F6', 'F7']);
});

test('chat: the exact layout for a small run (a drift check)', () => {
  const nl = String.fromCharCode(10);
  const bar = (n) => String.fromCharCode(0x2588).repeat(n);
  const expected = [
    '> **REVIEW COMPLETE \u00b7 1 blocker (fix F1 first) \u00b7 1 criterion with findings (AC-6040-1) \u00b7 4 findings**',
    '',
    '```',
    `HIGH     ${bar(12)}${' '.repeat(12)}   1`,
    `MEDIUM   ${bar(24)}   2`,
    `LOW      ${bar(12)}${' '.repeat(12)}   1`,
    '```',
    '',
    '| Do this | Items | Count |',
    '|---|---|---|',
    '| Fix now | F1 | 1 |',
    '| Fix next | F2 F4 | 2 |',
    '| Can wait | F6 | 1 |',
    '| Decide | none | 0 |',
    '',
    '```diff',
    '- FIX NOW      F1   A native seat can finish a failed review as a clean one.',
    '  FIX NEXT     F2   Zero-claim review skips worktree cleanup.  (+F4)',
    '  CAN WAIT     F6   Wrong message for an unaccepted Severity value.',
    '+ VERIFIED     all 4 findings are confirmed by the auditor',
    '- CRITERION    AC-6040-1  findings F1',
    '- NOT VERIFIED 1 of 3 criteria',
    '  VERDICTS     0 met, 1 partial, 0 not met, 1 no issue found; 1 with findings',
    '- CONFIRMED    H1',
    '```',
  ];
  const out = renderChat(CHAT_FIXTURE());
  const lines = out.split(nl);
  assert.deepEqual(lines.slice(0, expected.length), expected);
  assert.match(out, /_Short report\. Ask for the full one: every finding, every criterion and the cost\._/);
});

test('chat: no colour codes, no emoji, code lines within 100 characters, severities as words, whatever the run', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const long = 'word '.repeat(60).trim();
  const runs = [
    CHAT_FIXTURE(),
    buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, status: 'incomplete' } }),
    buildReport({ findingsDoc: { findings: Array.from({ length: 12 }, (_, i) => finding({ id: `F${i + 1}`, severity: 'HIGH', summary: `${long}.` })) }, manifest: MANIFEST }),
    buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: PACKET, seatTexts: { A: SEAT_B, B: SEAT_B } }),
  ];
  for (const report of runs) {
    const out = renderChat(report);
    assert.equal(out.includes(String.fromCharCode(27)), false, 'no escape codes');
    assert.equal(emoji.test(out), false, 'no emoji');
    let inCode = false;
    for (const line of out.split(String.fromCharCode(10))) {
      if (line.startsWith('```')) inCode = !inCode;
      else if (inCode) assert.ok(line.length <= 100, `code line within 100 characters: ${line.length}`);
    }
  }
  assert.match(renderChat(runs[0]), /^HIGH {5}/m, 'a severity is a word in the bars');
  assert.match(renderChat(runs[1]), /^> \*\*REVIEW INCOMPLETE \u00b7 no blockers \u00b7 no findings\*\*/);
  const blockers = renderChat(runs[2]).split(String.fromCharCode(10)).filter((l) => l.startsWith('- FIX NOW'));
  assert.equal(blockers.length, 12, 'every blocker has its own row');
  assert.ok(blockers.some((l) => /\bF12\b/.test(l)) && !blockers.some((l) => /more\)/.test(l)), 'none is hidden behind "(+N more)"');
  assert.match(renderChat(runs[3]), /^> Caveat: /m, 'the zero-claim caveat is kept');
});

test('chat: an unresolved HIGH finding (low stakes too) is a decision under DECIDE, not a FIX NOW row', () => {
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'HIGH', final_state: 'unresolved-low-stakes', summary: 'Seats still disagree.' }),
      finding({ id: 'F2', severity: 'HIGH', summary: 'Agreed blocker.' }),
    ] },
    manifest: MANIFEST,
  });
  const out = renderChat(report).split(String.fromCharCode(10));
  assert.ok(out.some((l) => l.startsWith('- DECIDE') && /\bF1\b/.test(l)), out.join(String.fromCharCode(10)));
  assert.ok(!out.some((l) => l.startsWith('- FIX NOW') && /\bF1\b/.test(l)));
  assert.ok(out.some((l) => l.startsWith('- FIX NOW') && /\bF2\b/.test(l)));
});

test('chat: withdrawn claims, a checked-but-not-fully-confirmed audit, and --all', () => {
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'LOW', auditor_check: { result: 'NOT_CHECKED' } }), finding({ id: 'F2', severity: 'HIGH', final_state: 'settled-refuted' }),
    ] },
    manifest: MANIFEST,
  });
  const out = renderChat(report);
  assert.match(out, /\| Withdrawn \| F2 \| 1 \|/);
  assert.match(out, /^ {2}WITHDRAWN {4}1 claim\(s\) refuted or dropped: F2/m);
  assert.match(out, /^ {2}CHECKED {6}0 of 1 findings confirmed by the auditor/m);
  assert.match(out, /^> \*\*REVIEW COMPLETE \u00b7 no blockers \u00b7 2 findings\*\*/m);
  const all = renderChat(CHAT_FIXTURE(), { all: true });
  assert.match(all, /^---$/m);
  assert.match(all, /^## Cost \(tokens\)/m);
  assert.doesNotMatch(all, /run with `--format chat --all`/);
});

test('CLI: --format chat prints the chat layout, --all needs it, a bad format is refused', async (t) => {
  const dir = await makeRun(t);
  const r = await runCli(['--run-dir', dir, '--format', 'chat']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^> \*\*REVIEW COMPLETE/);
  assert.equal(r.stdout.includes(String.fromCharCode(27)), false);
  const all = await runCli(['--run-dir', dir, '--format', 'chat', '--all']);
  assert.match(all.stdout, /^## Cost/m);
  assert.equal(parseArgs(['--run-dir', 'x', '--all']).all, true, 'accepted with every format; only chat changes');
  assert.throws(() => parseArgs(['--run-dir', 'x', '--format', 'pdf']), /--format must be text or chat/);
});
test('chat: the banner blocker count is the report blocker count; decide items are named apart; odd ids stay within the line', () => {
  const decideOnly = renderChat(buildReport({ findingsDoc: { findings: [finding({ id: 'F2', severity: 'LOW', final_state: 'unresolved-high-stakes' })] }, manifest: MANIFEST }));
  assert.ok(decideOnly.includes('> **REVIEW COMPLETE '+String.fromCharCode(183)+' 1 blocker '+String.fromCharCode(183)+' 1 to decide (F2) '+String.fromCharCode(183)+' 1 finding**'), 'an unresolved-high-stakes finding is a blocker in every format');
  assert.match(decideOnly, /1 of 1 findings confirmed by the auditor; 1 unresolved \(F2\)/);
  const mixed = renderChat(buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'LOW', final_state: 'unresolved-high-stakes' })] }, manifest: MANIFEST }));
  assert.ok(mixed.includes('2 blockers (fix F1 first) '+String.fromCharCode(183)+' 1 to decide (F2)'));
  const odd = renderChat(buildReport({
    findingsDoc: { findings: [
      finding({ id: 'X'.repeat(122), severity: 'HIGH' }), finding({ id: null, severity: null, final_state: null, summary: null }),
      ...Array.from({ length: 8 }, (_, i) => finding({ id: `FINDING-${String(i).padStart(4, '0')}`, final_state: 'settled-refuted' })),
    ] },
    manifest: null,
  }));
  let inCode = false;
  for (const line of odd.split(String.fromCharCode(10))) {
    if (line.startsWith('```')) inCode = !inCode;
    else if (inCode) assert.ok(line.length <= 100, `code line within 100 characters: ${line.length}`);
  }
  assert.doesNotMatch(odd, /null|undefined/);
});

test('chat: report-notes drive the groups (needs decision, fixed after the snapshot, disclosure only), the decisions text is shown, and the audit line states disputes', () => {
  const notesText = ['## Finding status', '- F1: needs decision', '- F2: fixed after the snapshot, not re-reviewed', '- F3: disclosure only', '- F5: not fixed yet', '', '## Decisions needed', '', '- F1: delete or keep', ''].join(String.fromCharCode(10));
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'HIGH' }), finding({ id: 'F3', severity: 'MEDIUM' }), finding({ id: 'F4', severity: 'MEDIUM', final_state: 'unresolved-low-stakes' }),
      finding({ id: 'F5', severity: 'MEDIUM' }), finding({ id: 'F6', severity: 'LOW', final_state: 'settled-refuted' }),
    ] },
    manifest: MANIFEST, notesText,
  });
  const g = groupFindings(report);
  const ids = (list) => list.map((f) => f.id);
  assert.deepEqual(ids(g.decide), ['F1']);
  assert.deepEqual(ids(g.fixed), ['F2']);
  assert.deepEqual(ids(g.canWait), ['F3']);
  assert.deepEqual(ids(g.fixNext), ['F4', 'F5']);
  const out = renderChat(report);
  assert.ok(out.includes('| Fixed, not re-reviewed | F2 | 1 |'));
  assert.ok(out.split(String.fromCharCode(10)).includes('**Decisions needed**'));
  assert.match(out, /- F1: delete or keep/);
  assert.ok(out.includes('> **REVIEW COMPLETE ' + String.fromCharCode(183) + ' 2 blockers (F2 marked fixed in the report notes, not fix now) ' + String.fromCharCode(183) + ' 1 to decide (F1)'));
  assert.match(out, /^ {2}CHECKED {6}5 of 5 findings confirmed by the auditor; 1 unresolved \(F4\); 1 withdrawn/m);
  const bare = renderChat(buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'LOW' })] }, manifest: MANIFEST, notesText: ['## Decisions needed', '', '- pick one', ''].join(String.fromCharCode(10)) }));
  assert.ok(bare.includes('| Decide | see Decisions needed below | - |'), 'a count of 0 next to a written decision read as no decision (field: website)');
});

test('criteria verdicts: MET, PARTIAL and NOT MET are read from a bullet line or a bold table cell, the worst seat wins, and the chat line counts them', () => {
  assert.equal(parseVerdict('- AC-3 MET: ran the command'), 'MET');
  assert.equal(parseVerdict('| AC-8 | **NOT MET** | evidence says met |'), 'NOT MET');
  assert.equal(parseVerdict('| AC-9 | **PARTIAL** | x |'), 'PARTIAL');
  assert.equal(parseVerdict('- AC-9: ran it, not met by the old build'), null, 'lower case prose is not a verdict');
  const packet = lines('# Packet', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three', '- [AC-4] four');
  const seatA = lines('# A', '', '## No findings', '', '- AC-1 MET: ran it', '- AC-2 PARTIAL: live run missing', '- AC-3 MET: read it');
  const seatB = lines('# B', '', '## No findings', '', '| Criterion | Verdict | Evidence |', '|---|---|---|', '| AC-1 | **MET** | x |', '| AC-3 | **NOT MET** | y |');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  const cs = report.criteria.criteriaStats;
  assert.deepEqual([cs.met, cs.partial, cs.notMet, cs.notVerified], [1, 1, 1, 1]);
  const out = renderChat(report);
  assert.match(out, /^- NOT VERIFIED 1 of 4 criteria\n- VERDICTS {5}1 met, 1 partial, 1 not met$/m, 'the NOT VERIFIED line keeps the partial count');
  assert.doesNotMatch(out, /FAILING/, 'a NOT MET verdict is counted once, as not met');
  const done = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-3] three'), seatTexts: { A: seatA, B: seatB } });
  assert.match(renderChat(done), /^- COVERED {6}2 of 2 criteria checked by a seat\n- VERDICTS {5}1 met, 0 partial, 1 not met$/m);
});

test('ticket verdicts: GO / NO GO after the ticket id, a NO GO from either seat wins, the verdict that ends a line is taken, no ticket lines means no ticket rows', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-6048-1] a', '- [AC-6049-1] b', '- [AC-6040-1] c', '- [AC-6041-1] d', '- Tickets: 6048=AC-6048-1; 6049=AC-6049-1; 6040=AC-6040-1; 6041=AC-6041-1');
  const seatA = lines('# A', '', '## No findings', '', '- AC-6048-1 MET: x', '- 6048: GO.', '- 6049: GO', '- 6041: GO for a staged rollout. Non-blocking: later.');
  const seatB = lines('# B', '', '## No findings', '', '6048: GO - fine', '6049: NO GO \u2014 live run missing', '6040: GO for the drive-type half. History half GO for staging');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  const byId = Object.fromEntries(report.criteria.tickets.map((t) => [t.id, t]));
  assert.equal(byId['6048'].verdict, 'GO');
  assert.equal(byId['6049'].verdict, 'NO GO');
  assert.deepEqual(byId['6049'].seats, { A: 'GO', B: 'NO GO' });
  assert.equal(byId['6049'].text, 'live run missing');
  assert.equal(byId['6041'].text, 'for a staged rollout. Non-blocking: later.');
  assert.equal(byId['6040'].verdict, 'GO');
  const out = renderChat(report);
  assert.match(out, /^- NO GO {8}6049 \(A GO, B NO GO\)  live run missing$/m);
  assert.match(out, /^\+ GO {11}6048/m);
  const quiet = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA.replace(/6\d{3}: .*/g, ''), B: SEAT_B } });
  assert.doesNotMatch(renderChat(quiet), /NO VERDICT/);
  assert.deepEqual(buildTickets([], {}), []);
});

test('criteria verdicts: a sentence that mentions the tag earlier in Checks performed does not hide the verdict row', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-8] eight', '- [AC-9] nine');
  const seat = lines('# B', '', '## No findings', '', '- **Probe:** AC-8 and AC-9 were exercised with a stale page.', '', '| Criterion | Verdict | Evidence |', '|---|---|---|', '| AC-8 | **NOT MET** | later page lacks metadata |', '| AC-9 | **PARTIAL** | one stale page |', '', '6049: NO GO - AC-8 fails');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: SEAT_B, B: seat } });
  const cs = report.criteria.criteriaStats;
  assert.deepEqual([cs.met, cs.partial, cs.notMet], [0, 1, 1]);
});

test('cost: a native agent row with no output tokens gets a lower-bound note in text, markdown and html; a Codex-only run gets none', () => {
  const withNative = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST });
  assert.match(costNote(withNative.cost), /Output is unknown for native agents/);
  assert.match(renderText(withNative, { color: false }), /Output is unknown for native agents/);
  assert.match(renderMarkdown(withNative), /Output is unknown for native agents/);
  assert.match(renderHtml(withNative), /Output is unknown for native agents/);
  assert.equal(costNote([{ seat: 'seat B', output: 5, calls: 2 }]), null);
});

test('cost: every format with a cost table says once that session probes and earlier failed attempts are not counted, and why there is no dollar figure', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST });
  const scope = /The cost covers the completed review calls in tokens; session probes and earlier failed attempts are not counted\. No dollar figure is shown: no price table ships with the skill\./g;
  for (const out of [renderText(report, { color: false }), renderMarkdown(report), renderHtml(report), renderChat(report, { all: true })]) assert.equal(out.match(scope)?.length, 1);
  assert.doesNotMatch(renderChat(report), scope, 'the short chat report has no cost table');
});

test('cost: a Claude seat that reports input and cache write apart gets a Cache write column in text, markdown and html; other runs keep the old table', () => {
  const usage = { A: { input_tokens: 1000, cache_creation_input_tokens: 90000, new_input_tokens: 91000, context_reread_tokens: 500000, calls: 5, output_tokens: null }, B: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 10 } };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, seat_usage: usage } });
  const a = report.cost.find((r) => r.seat === 'seat A');
  assert.deepEqual([a.newInput, a.cacheWrite], [91000, 90000], 'new input is everything not read from the cache, the cache write included');
  assert.match(renderText(report, { color: false }), /Cache write/);
  assert.match(renderMarkdown(report), /\| Seat \| New input \| Cache write \| Cache read/);
  assert.match(renderHtml(report), /<th>Cache write<\/th>/);
  const old = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST });
  assert.doesNotMatch(renderMarkdown(old), /Cache write/);
});

test('chat: a blocker the notes mark pre-existing stays in the blocker count, as in the text report, is named as moved, and gets its own row and line', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'HIGH' })] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F2: pre-existing, not from this diff', ''].join(String.fromCharCode(10)),
    changeDiffs: [{ name: 'since.diff', text: '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n' }],
  });
  const out = renderChat(report);
  assert.ok(out.includes('2 blockers (fix F1 first; F2 marked pre-existing in the report notes, not fix now)'));
  assert.match(renderText(report), /Blockers: 2/);
  assert.ok(out.includes('| Pre-existing | F2 | 1 |'));
  assert.match(out, /^ {2}PRE-EXISTING 1 not caused by this change: F2/m);
});

test('a finding marked pre-existing whose evidence is on lines the change added stays in Fix now, with a caveat', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', evidence: ['x.py:1'] }), finding({ id: 'F2', severity: 'HIGH', evidence: ['x.py:90'] })] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F1: pre-existing', '- F2: pre-existing', ''].join(String.fromCharCode(10)),
    changeDiffs: [{ name: 'since.diff', text: '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n' }],
  });
  const g = groupFindings(report);
  assert.deepEqual([g.fixNow.map((f) => f.id), g.preExisting.map((f) => f.id)], [['F1'], ['F2']]);
  assert.ok(report.caveats.includes('F1 is marked pre-existing in the report notes, but its evidence is on lines the change added, so it stays where its severity puts it.'));
  assert.ok(!report.caveats.some((c) => c.startsWith('F2 is marked pre-existing')));
  // Fix review R1: another package's Reporter.py matched only by file name does not overrule the notes.
  const other = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', evidence: ['HITACHI_DEVICE/Reporter.py:11'] })] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F1: pre-existing', ''].join(String.fromCharCode(10)),
    changeDiffs: [{ name: 'since.diff', text: '--- a/CONTOSO_V4_DEVICE/Reporter.py\n+++ b/CONTOSO_V4_DEVICE/Reporter.py\n@@ -10 +10,2 @@\n a\n+b\n' }],
  });
  assert.equal(other.findings[0].where.byName, true);
  assert.deepEqual(groupFindings(other).preExisting.map((f) => f.id), ['F1']);
  assert.ok(!other.caveats.some((c) => c.includes('so it stays where its severity puts it')));
  assert.ok(other.caveats.includes('F1 is marked pre-existing in the report notes; its evidence matches lines the change added only by file name (HITACHI_DEVICE/Reporter.py:11, matched by file name to CONTOSO_V4_DEVICE/Reporter.py), so check it is not the same file.'));
  // Round 2 F2: a bare name that one changed file in a folder has is a guess too.
  const bare = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', evidence: ['Reporter.py:11'] })] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F1: pre-existing', ''].join(String.fromCharCode(10)),
    changeDiffs: [{ name: 'since.diff', text: '--- a/CONTOSO_V4_DEVICE/Reporter.py\n+++ b/CONTOSO_V4_DEVICE/Reporter.py\n@@ -10 +10,2 @@\n a\n+b\n' }],
  });
  assert.equal(bare.findings[0].where.byName, true);
  assert.deepEqual(groupFindings(bare).preExisting.map((f) => f.id), ['F1']);
});

test('field run: the seats\' own "Pre-existing: yes" groups a non-blocker as pre-existing; a "no", an author note, added lines, a blocker or no change diff keep it', () => {
  const diff = [{ name: 'since.diff', text: '--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n' }];
  const f = (id, pre, extra = {}) => finding({ id, severity: 'MEDIUM', evidence: ['x.py:90'], pre_existing: pre, ...extra });
  const report = buildReport({
    findingsDoc: { findings: [
      f('F1', ['A1: yes']),
      f('F2', ['A2: yes', 'B2: no']),
      f('F3', ['A3: yes'], { evidence: ['x.py:1'] }),
      f('F4', ['A4: yes'], { severity: 'HIGH' }),
      f('F5', ['A5: yes']),
      f('F6', ['A6: unknown']),
    ] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F5: fixed in abc123', ''].join(String.fromCharCode(10)),
    changeDiffs: diff,
  });
  const g = groupFindings(report);
  assert.deepEqual(g.preExisting.map((x) => x.id), ['F1'], 'only F1: F2 has a "no", F3 is on added lines, F4 is a blocker, F5 has an author note, F6 is unknown');
  assert.deepEqual(g.fixNow.map((x) => x.id), ['F4']);
  assert.deepEqual(g.fixed.map((x) => x.id), ['F5']);
  const noDiff = buildReport({ findingsDoc: { findings: [f('F1', ['A1: yes'])] }, manifest: MANIFEST });
  assert.deepEqual(groupFindings(noDiff).preExisting, [], 'without a change diff the word means nothing');
});

test('field website: with no change diff, "pre-existing" in the notes does not move a finding out of Fix now, and a caveat says why', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'HIGH' })] },
    manifest: MANIFEST,
    notesText: ['## Finding status', '- F1: pre-existing: older than yesterday', '- F2: pre-existing, not from this diff', ''].join(String.fromCharCode(10)),
  });
  const g = groupFindings(report);
  assert.deepEqual(g.fixNow.map((f) => f.id), ['F1', 'F2']);
  assert.deepEqual(g.preExisting, []);
  assert.ok(report.caveats.includes('F1, F2 are marked pre-existing in the report notes, but this report has no change diff (since.diff in the run folder, or --change-diff), so nothing tells what the change was; they stay where their severity puts them.'));
  assert.ok(renderChat(report).includes('2 blockers (fix F1, F2 first)'));
});

test('review fixes: NO-GO is not GO, a negated or future status is not "fixed", a tag is never its own verdict, status lines with bold ids or several ids are read', () => {
  const tick = (line) => buildTickets([{ kind: 'criterion', groups: ['6048'] }], { A: line })[0].verdict;
  assert.equal(tick('- 6048: NO-GO, broken'), 'NO GO');
  assert.equal(tick('- Ticket 6048: NO GO'), 'NO GO');
  assert.equal(tick('- 6048: GO.'), 'GO');
  assert.equal(parseVerdict('AC-1: NOT-MET'), 'NOT MET');
  assert.equal(parseVerdict('AC-MET-1: checked, see notes', 'AC-MET-1'), null);
  assert.equal(parseVerdict('AC-MET-1: checked, see notes'), null, 'a hyphen neighbour is not a verdict even without the tag');
  for (const note of ['not yet fixed', 'will be fixed in a follow-up', 'no decision needed, fix now', 'not pre-existing; introduced here']) {
    assert.deepEqual(Object.values(noteKinds(note)), [false, false, false, false], note);
  }
  assert.equal(noteKinds('defer').wait, true);
  assert.equal(noteKinds('fixed after the snapshot').fixed, true);
  const status = findingStatus(['- **F1**: fixed', '- F2 — needs decision', '- F3, F4: pre-existing'].join(String.fromCharCode(10)));
  assert.deepEqual([...status], [['F1', 'fixed'], ['F2', 'needs decision'], ['F3', 'pre-existing'], ['F4', 'pre-existing']]);
});

test('review fixes: a Claude CLI seat keeps input, cache read and cache write apart; the COVERED line counts criteria without a verdict; the CHECKED line stays within 100 characters', () => {
  assert.deepEqual(
    seatCostRow('seat A', { input_tokens: 50, cached_input_tokens: 800000, cache_write_input_tokens: 90000, output_tokens: 4000 }, { anthropic: true }),
    { seat: 'seat A', newInput: 90050, cacheWrite: 90000, cacheRead: 800000, output: 4000, calls: null },
  );
  assert.equal(seatCostRow('seat B', { input_tokens: 851000, cached_input_tokens: 750000, output_tokens: 6000 }).newInput, 101000, 'Codex input still includes the cached part');
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three');
  const seat = lines('# A', '', '## No findings', '', '- AC-1 MET: x', '- AC-2: looked, no verdict word', '- AC-3: looked too');
  const out = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: SEAT_B } }));
  assert.match(out, /^ {2}COVERED {6}3 of 3 criteria checked by a seat\n {2}VERDICTS {5}1 met, 0 partial, 0 not met, 2 no issue found$/m);
  const many = [
    ...Array.from({ length: 12 }, (_, i) => finding({ id: 'F' + (i + 1), severity: 'MEDIUM' })),
    ...Array.from({ length: 3 }, (_, i) => finding({ id: 'F' + (i + 13), severity: 'LOW', final_state: 'unresolved-low-stakes' })),
    ...Array.from({ length: 10 }, (_, i) => finding({ id: 'F' + (i + 20), final_state: 'settled-refuted' })),
  ];
  const wide = renderChat(buildReport({ findingsDoc: { findings: many }, manifest: MANIFEST }));
  for (const line of wide.split(String.fromCharCode(10))) if (line.startsWith('  CHECKED') || line.startsWith('+ VERIFIED')) assert.ok(line.length <= 100, line.length);
});

test('live-run fixes: a claim heading that names its criterion bare counts as that criterion, and a failing check with no tagged finding is never a clean result', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] sum', '- [AC-2] merge');
  const seatB = lines(
    '# B', '', '## B1 - sumTo excludes its upper bound (violates AC-1)', 'Severity: HIGH', '',
    '## Checks performed', '- AC-1: ran sumTo(4), off by n.', '- AC-2: device independence fails (reproduced), but I wrote no claim for it.',
  );
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['B1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: SEAT_B, B: seatB },
  });
  const [ac1, ac2] = report.criteria.rows;
  assert.equal(ac1.status, 'issue', 'AC-1 named bare in the heading');
  assert.deepEqual(ac1.findings, ['F1']);
  assert.equal(ac2.status, 'clean');
  assert.deepEqual(ac2.failedSeats, ['B']);
  assert.ok(report.caveats.some((c) => c.includes('Criterion AC-2 (seat B): the seat wrote NOT MET or reported a failing check')));
  assert.match(renderChat(report), /^- FAILING {6}1 criterion reports a failing check with no verdict and no finding$/m);
  assert.match(renderText(report), /AC-2 +failing check reported, no finding tagged \(B\)/, 'the row does not say "no issue found"');
  assert.deepEqual(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: SEAT_B, B: lines('# B', '', '## No findings', '', '- AC-1: does not fail, sumTo(4) is right.', '- AC-2: no failure seen.') } }).criteria.rows.map((r) => r.failedSeats), [[], []], 'negated phrases are not failures');
});

test('live-run fixes: the auditor and its cache write come from actors[]; a Claude per-call new input is its own input, not input minus cache', () => {
  const usage = { input_tokens: 6, cached_input_tokens: 44568, cache_write_input_tokens: 18341, output_tokens: 1343, source: 'provider', raw: { input_tokens: 6, cache_creation_input_tokens: 18341, cache_read_input_tokens: 44568 } };
  const manifest = { ...MANIFEST, seat_usage: {}, actors: [{ role: 'auditor', model_resolved: 'claude-sonnet-5-5', usage }], reviewers: [{ role: 'A', provider: 'anthropic', usage, usage_per_call: [usage, { ...usage, input_tokens: 4 }] }] };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest });
  const aud = report.cost.find((r) => r.seat === 'auditor');
  assert.deepEqual([aud.newInput, aud.cacheWrite, aud.cacheRead, aud.output], [18347, 18341, 44568, 1343]);
  const seatA = report.cost.find((r) => r.seat === 'seat A');
  assert.deepEqual(seatA.perCall, [18347, 18345]);
  assert.deepEqual(perCallNewInput([{ input_tokens: 900, cached_input_tokens: 800 }]), [100], 'Codex input still includes the cached part');
});

test('chat: a criterion that carries a finding is never counted as met, and the banner and diff block name it', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three');
  const seatA = lines('# A', '', '## A1 [AC-3] The third criterion fails', 'Severity: HIGH', '', '## Checks performed', '- AC-1 MET: ok', '- AC-2 MET: ok', '- AC-3 MET: looked fine at first');
  const report = buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: SEAT_B } });
  const cs = report.criteria.criteriaStats;
  assert.deepEqual([cs.met, cs.partial, cs.notMet, cs.issue], [2, 1, 0, 1]);
  const out = renderChat(report);
  assert.ok(out.includes('1 criterion with findings (AC-3)'));
  assert.match(out, /^- CRITERION {4}AC-3 {2}findings F1$/m);
  assert.match(out, /3 of 3 criteria checked by a seat\n {2}VERDICTS {5}2 met, 1 partial, 0 not met; 1 with findings$/m);
  assert.doesNotMatch(out, /3 met/);
});

test('vsi feedback: the markdown report omits an unwritten Why instead of printing "(not written)", and a grouped line names the hidden ids', () => {
  const report = buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'MEDIUM' }), finding({ id: 'F2', severity: 'MEDIUM' }), finding({ id: 'F3', severity: 'MEDIUM' })] }, manifest: MANIFEST });
  assert.doesNotMatch(renderMarkdown(report), /Why:/);
  assert.match(renderChat(report), /FIX NEXT {5}F1 .*\(\+F2 F3\)/);
  assert.match(renderMarkdown({ ...report, why: 'One sentence.' }), /\*\*Why:\*\* One sentence\./);
});

test('chat: a confirmed hypothesis is the red line, a refuted one is good news (+ when all are refuted), the rest named by tag', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [H1] a', '- [H2] b', '- [H3] c', '- [H4] d');
  const seat = lines('# A', '', '## No findings', '', '- H1: REFUTED by the new test.', '- H2: CONFIRMED.', '- H3: PARTLY CONFIRMED, one path remains.', '- H4: looked at it, no outcome word.');
  const out = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: SEAT_B } }));
  assert.match(out, /^- SPLIT {8}H1 \(A refuted, B confirmed\)$/m);
  const both = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: lines('# B', '', '## No findings', '', '- H1: REFUTED too.') } }));
  assert.match(both, /^ {2}REFUTED {6}H1$/m, 'refuted is not a red line');
  const onlyH1 = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [H1] a');
  const allRefuted = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: onlyH1, seatTexts: { A: lines('# A', '', '## Checks performed', '- H1: REFUTED.'), B: lines('# B', '', '## Checks performed', '- H1: REFUTED too.') } }));
  assert.match(allRefuted, /^\+ REFUTED {6}H1$/m, 'every hypothesis refuted: the good outcome');
  // The terminal report paints all-refuted green and a confirmed hypothesis red.
  const green = renderText(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: onlyH1, seatTexts: { A: lines('# A', '', '## Checks performed', '- H1: REFUTED.') } }), { color: true });
  assert.match(green, /HYPOTHESES \(1\)[^\n]*\x1b\[32m1 REFUTED/);
  const red = renderText(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: onlyH1, seatTexts: { A: lines('# A', '', '## Checks performed', '- H1: CONFIRMED.') } }), { color: true });
  assert.match(red, /HYPOTHESES \(1\)[^\n]*\x1b\[31m/);
  // The HTML page uses the same colours: a confirmed hypothesis is a red chip, a refuted one green.
  const html = (verdict) => renderHtml(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: onlyH1, seatTexts: { A: lines('# A', '', '## Checks performed', `- H1: ${verdict}.`) } }));
  assert.match(html('CONFIRMED'), /<span class="chip high">Confirmed<\/span>/);
  assert.match(html('REFUTED'), /<span class="chip ok">Refuted<\/span>/);
  assert.match(out, /^- CONFIRMED {4}H2$/m);
  assert.match(out, /^ {2}HYPOTHESES {3}H3 partly confirmed, H4 outcome not parsed$/m);
  assert.doesNotMatch(out, /^- REFUTED/m);
});

test('chat: a severity the auditor changed is shown with the auditor reason, three at most', () => {
  const changed = (id, from, to, reason) => finding({ id, severity: from, severity_audited: to, auditor_check: { result: 'CONFIRMED', severity: to, severity_reason: reason } });
  const out = renderChat(buildReport({
    findingsDoc: { findings: [changed('F1', 'HIGH', 'MEDIUM', 'Needs a corrupt input the collector never gets. Second sentence.'), changed('F2', 'HIGH', 'LOW', 'Cosmetic.'), changed('F3', 'HIGH', 'MEDIUM', 'x'), changed('F4', 'HIGH', 'MEDIUM', 'y')] },
    manifest: MANIFEST,
  }));
  assert.match(out, /^ {2}SEVERITY {5}F1 HIGH to MEDIUM: Needs a corrupt input the collector never gets\.$/m);
  assert.match(out, /^ {2}SEVERITY {5}F3 HIGH to MEDIUM: x$/m);
  assert.match(out, /^ {2}SEVERITY {5}\(\+1 more changed by the auditor\)$/m);
});

test('vocabulary: a criterion a seat marked NOT MET or PARTIAL with no finding is never labelled "no issue found" in text, markdown or html', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three');
  const seat = lines('# A', '', '## No findings', '', '- AC-1 NOT MET: the loop is off by one', '- AC-2 PARTIAL: live run missing', '- AC-3 MET: ok');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: SEAT_B } });
  const md = renderMarkdown(report);
  assert.match(md, /AC-1 .*NOT MET, no finding tagged \(A\)/);
  assert.match(md, /AC-2 .*PARTIAL, no finding tagged \(A\)/);
  assert.match(md, /AC-3 .*no issue found \(A\)/);
  assert.doesNotMatch(md, /AC-1 [^\n]*no issue found/);
  assert.match(renderText(report, { color: false }), /NOT MET, no finding tagged/);
  assert.match(renderHtml(report), /NOT MET, no finding tagged/);
});

// The Checks performed sections of four real seat files (two self-review runs), and the verdict each seat wrote, read by hand.
const REAL_CHECKS = {
  'cross-A': { criteria: 'NOT MET,NOT MET,NOT MET,NOT MET,PARTIAL,NOT MET,NOT MET', hypotheses: 'CONFIRMED,PARTLY,REFUTED,PARTLY,PARTLY,PARTLY,PARTLY,REFUTED,PARTLY,CONFIRMED,PARTLY' },
  'cross-B': { criteria: 'NOT MET,NOT MET,NOT MET,NOT MET,PARTIAL,NOT MET,NOT MET', hypotheses: 'CONFIRMED,CONFIRMED,PARTLY,PARTLY,CONFIRMED,CONFIRMED,PARTLY,PARTLY,PARTLY,CONFIRMED,REFUTED' },
  'pair-A': { criteria: 'NOT MET,NOT MET,NOT MET,NOT MET,PARTIAL,PARTIAL,NOT MET', hypotheses: 'CONFIRMED,CONFIRMED,PARTLY,CONFIRMED,PARTLY,PARTLY,PARTLY,PARTLY,PARTLY,CONFIRMED,PARTLY' },
  'pair-B': { criteria: 'NOT MET,NOT MET,NOT MET,NOT MET,PARTIAL,PARTIAL,NOT MET', hypotheses: 'CONFIRMED,CONFIRMED,REFUTED,CONFIRMED,PARTLY,PARTLY,PARTLY,PARTLY,PARTLY,CONFIRMED,PARTLY' },
};
const REAL_PACKET = lines(...Array.from({ length: 7 }, (_, i) => `- [AC-${i + 1}] c`), ...Array.from({ length: 11 }, (_, i) => `- [H${i + 1}] h`));

test('real seat lines: every criterion and hypothesis verdict four real seats wrote is read as written, LF or CRLF', async () => {
  for (const [name, want] of Object.entries(REAL_CHECKS)) {
    const lf = await fs.readFile(fileURLToPath(new URL(`./fixtures/build-report-checks/${name}.md`, import.meta.url)), 'utf8');
    const crlf = lf.split(NL).map((l, i) => (i % 3 === 0 ? l : `${l}${String.fromCharCode(13)}`)).join(NL);
    for (const text of [lf, crlf]) {
      const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: REAL_PACKET, seatTexts: { A: text, B: '' } });
      const rows = report.criteria.rows;
      assert.equal(rows.filter((r) => r.kind === 'criterion').map((r) => r.met).join(','), want.criteria, `${name} criteria`);
      assert.equal(rows.filter((r) => r.kind === 'hypothesis').map((r) => r.outcomes.A).join(','), want.hypotheses, `${name} hypotheses`);
      assert.deepEqual(rows.filter((r) => r.met === 'MET' || r.met === 'PARTIAL').flatMap((r) => r.failedSeats), [], `${name}: a MET or PARTIAL line is not a failing check`);
      assert.deepEqual(rows.flatMap((r) => r.doubt), [], `${name}: a line with a verdict is not an incomplete check`);
    }
  }
});

const ch = (n) => String.fromCharCode(n);

test('self-review fixes: the verdict that ends the line wins over earlier verdict words, in any spacing, dash or case', () => {
  const cases = [
    ['- AC-1: response was MET; expected NOT MET. NOT MET.', 'NOT MET'],
    ['| AC-1 | MET was printed for failing output | NOT MET |', 'NOT MET'],
    ['- AC-1: MET_COUNT is diagnostic only. NOT MET.', 'NOT MET'],
    ['- AC-1: exit codes MET except preflight, which is NOT MET', 'NOT MET'],
    ['- AC-1: criteria MET only partially; PARTIAL', 'PARTIAL'],
    ['- AC-1: the report prints "NOT MET, no finding tagged" for it; checks agree. MET', 'MET'],
    ['- AC-1: NOT  MET', 'NOT MET'], ['- AC-1: NOT_MET', 'NOT MET'], [`- AC-1: NOT${ch(0xa0)}MET`, 'NOT MET'], [`- AC-1: NOT${ch(0x2013)}MET`, 'NOT MET'],
    ['- AC-1: not MET', 'NOT MET'], ['- AC-1: NOT YET MET', 'NOT MET'], ['- AC-1: checked. Not-Met.', 'NOT MET'], ['- AC-1: checked. not met.', 'NOT MET'],
    ['- AC-1: all conditions met', 'MET'], ['| **AC-1** | **not met** | evidence |', 'NOT MET'], ['| AC-8 | **NOT MET** | evidence says met |', 'NOT MET'],
    ['- AC-1: ran it, not met by the old build', null], ['- AC-1: PARTIALLY MET', 'PARTIAL'], ['- AC-1: partially met', 'PARTIAL'], ['- AC-1: PARTIAL MET', 'PARTIAL'], ['- AC-1: the thresholds are not fully met', 'NOT MET'], ['- AC-3 MET: ran the command', 'MET'],
    ['- AC-7: CRLF read correctly (MET and NOT MET rows came out right); CRLF packet rewritten to LF. NOT MET (claims B13, B14, B16).', 'NOT MET'],
  ];
  for (const [line, want] of cases) assert.equal(parseVerdict(line, /AC-\d/.exec(line)[0]), want, line);
});

test('self-review fixes: only lines that start with a tag count for it; a mention in another tag line is not a check', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b', '- [AC-5] c', '- [AC-6] d', '- [H1] x', '- [H2] y'), seatTexts: { A: lines('## Checks performed', '- AC-2: only this check executed; AC-1 needs a separate run. MET.', '- `AC-5`: old flags work. NOT MET', '1. AC-6: brief sizes fine. PARTIAL', '- H1: same cause as H2; REFUTED.', '- H2: ran the two-device case. CONFIRMED.'), B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.equal(by['AC-1'].status, 'not-verified', 'AC-1 is only mentioned on the AC-2 line');
  assert.deepEqual([by['AC-2'].met, by['AC-5'].met, by['AC-6'].met], ['MET', 'NOT MET', 'PARTIAL'], 'a code mark or a list number before the tag still leads the line');
  assert.deepEqual([by.H1.verdict, by.H2.verdict], ['refuted', 'confirmed']);
  const doubt = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b'), seatTexts: { A: lines('## Checks performed', '- AC-1: unlike AC-2 this could not be run (no fixture). PARTIAL', '- AC-2: ran it. MET'), B: '' } });
  assert.deepEqual(doubt.criteria.rows.map((r) => r.doubt), [[], []], 'AC-2 takes no doubt from the AC-1 line, and AC-1 has a verdict');
  const numbered = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b'), seatTexts: { A: lines('## Checks performed', '1. AC-1: unlike AC-2 this ran. MET'), B: '' } });
  assert.deepEqual(numbered.criteria.rows.map((r) => r.status), ['clean', 'not-verified'], 'a numbered line belongs to the tag after the number');
});

test('self-review fixes: failure words on a line with a verdict are not a failing check; without a verdict the row says so', async () => {
  const run = (line) => buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-4] x'), seatTexts: { A: lines('## Checks performed', line), B: '' } });
  for (const line of ['- AC-4: verified that a failed step exits 1 and a broken pipe exits 0. MET', '- AC-4: --fail-on-command-error exits 4. MET', '- AC-4: a path that cannot be read is skipped. MET']) {
    const r = (await run(line)).criteria.rows[0];
    assert.deepEqual([r.failedSeats, r.doubt], [[], []], line);
  }
  const noVerdict = await run('- AC-4: fails in one case, see below');
  assert.deepEqual(noVerdict.criteria.rows[0].failedSeats, ['A']);
  assert.match(renderText(noVerdict), /AC-4 +failing check reported, no finding tagged \(A\)/);
  assert.match(renderMarkdown(noVerdict), /failing check reported, no finding tagged \(A\)/);
  assert.match(renderHtml(noVerdict), /<span class="chip high">failing check reported, no finding tagged<\/span>/);
  const four = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c', '- [AC-4] d'), seatTexts: { A: lines('## Checks performed', '- AC-1: the parser fails on CRLF.', '- AC-2: verified. MET', '- AC-3: could not run the suite.', '- AC-4: MET'), B: '' } });
  assert.match(renderChat(four), /VERDICTS {5}2 met, 0 partial, 0 not met, 1 no issue found$/m, 'a failing-check row is not also counted as no issue found');
});

test('self-review fixes: every format counts a NOT MET or PARTIAL criterion with no finding apart from "no issue found"; one caveat; chat lines within 100', () => {
  const packet = lines(...Array.from({ length: 12 }, (_, i) => `- [AC-${i + 1}] c`));
  const seat = lines('## Checks performed', ...Array.from({ length: 12 }, (_, i) => `- AC-${i + 1}: checked; a failing input is rejected. ${['MET', 'PARTIAL', 'NOT MET'][i % 3]}`));
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: '' } });
  assert.match(renderText(report), /CRITERIA \(12\)  0 issue found \| 8 not met or partial \(no finding\) \| 4 no issue found \| 0 NOT VERIFIED/);
  assert.match(renderMarkdown(report), /- Criteria: 0 issue found, 8 not met or partial \(no finding\), 4 no issue found, 0 not verified/);
  assert.match(renderHtml(report), /aria-label="Criteria: 0 issue found, 8 not met or partial \(no finding\), 4 no issue found, 0 not verified"/);
  assert.equal(report.caveats.filter((c) => /NOT MET or reported a failing check/.test(c)).length, 1, 'one caveat names every criterion');
  const chat = renderChat(report);
  assert.match(chat, /- VERDICTS {5}4 met, 4 partial, 4 not met$/m);
  assert.match(chat.split(NL)[0], /4 not met, no finding \(AC-3, AC-6, AC-9, AC-12\)/);
  let inCode = false;
  for (const line of chat.split(NL)) {
    if (line.startsWith('```')) inCode = !inCode;
    else if (inCode) assert.ok(line.length <= 100, `${line.length}: ${line}`);
  }
});

test('self-review fixes: the chat banner blocker count equals report.blockers in every case', () => {
  const cases = [
    [[finding({ id: 'F1', severity: 'HIGH', final_state: 'unresolved-high-stakes' })], ''],
    [[finding({ id: 'F1', severity: 'HIGH' })], '- F1: pre-existing in 1.0.0, not caused by this change'],
    [[finding({ id: 'F1', severity: 'HIGH' })], '- F1: will not be fixed in this release'],
    [[finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'CRITICAL', final_state: 'unresolved-high-stakes' }), finding({ id: 'F3', severity: 'MEDIUM' })], ''],
  ];
  for (const [findings, status] of cases) {
    const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, notesText: status ? lines('## Finding status', status) : '' });
    const n = report.blockers.length;
    assert.match(renderChat(report).split(NL)[0], new RegExp(` ${n} blockers?[ ]`), status || findings.map((f) => f.id).join(','));
    assert.match(renderText(report), new RegExp(`Blockers: ${n}`));
  }
});

test('self-review fixes: negated, partial and future status notes are never "fixed"; "no longer pre-existing" is not pre-existing', () => {
  for (const note of ['will not be fixed', "won't be fixed", `won${ch(0x2019)}t be fixed`, "hasn't been fixed", 'cannot be fixed', 'could not be fixed', 'not actually fixed', 'not completely fixed', 'partially fixed', 'partly fixed', 'fixed? no', 'no longer fixed']) {
    assert.equal(noteKinds(note).fixed, false, note);
  }
  assert.equal(noteKinds('no longer pre-existing').pre, false);
  assert.equal(noteKinds('will not be fixed in this release').wait, true, 'like "won\'t fix"');
  assert.deepEqual(noteKinds('not fixed, needs decision'), { fixed: false, decide: true, wait: false, pre: false });
  assert.equal(noteKinds('fix deferred').wait, true);
  for (const note of ['fixed after the snapshot', 'fixed after the snapshot, not re-reviewed', 'not a blocker, fixed after the snapshot']) assert.equal(noteKinds(note).fixed, true, note);
  const report = buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH' })] }, manifest: MANIFEST, notesText: lines('## Finding status', '- F1: will not be fixed in this release') });
  assert.equal(report.caveats.some((c) => /not re-reviewed/.test(c)), false, 'no fixed-after-snapshot caveat');
});

test('self-review fixes: ticket lines take any separator, a list number or code mark, any case, and the worst line', () => {
  const tick = (line) => buildTickets([{ kind: 'criterion', groups: ['6048'] }], { A: line })[0].verdict;
  const cases = [
    ['| 6048 | deployment says GO but validation rejects it | NO GO |', 'NO GO'], ['- 6048: GO_LIVE=false. NO GO.', 'NO GO'], ['- 6048: GO? Not yet, NO GO', 'NO GO'],
    ['- #6048: NO  GO, blocked', 'NO GO'], ['- 6048: no go.', 'NO GO'], ['- ticket 6048: NO GO.', 'NO GO'], ['- 6048: go', 'GO'], ['- 6048: ready to go', 'GO'],
    ['- `6048`: NO GO', 'NO GO'], ['1. 6048: NO GO', 'NO GO'], [`- Ticket 6048 ${ch(0x2014)} NO GO`, 'NO GO'], ['- 6048 (login): NO GO', 'NO GO'],
    ['- 6048: NOT GO', 'NO GO'], ['- 6048: not GO', 'NO GO'], ['- #6048 - GO', 'GO'], ['- 6048 = GO', 'GO'], [`- 6048 ${ch(0x2013)} GO`, 'GO'],
    [lines('- 6048: GO', '- 6048: NO GO (retest)'), 'NO GO'], ['- 6048 of the 7000 lines: GO', null], ['- 60480: GO', null], ['- 6048-1: NO GO', null],
  ];
  for (const [line, want] of cases) assert.equal(tick(line), want, line);
});

test('self-review fixes: a comma-separated or bold Tickets line, a full range and a bold criterion tag are read', () => {
  assert.deepEqual([...packetTicketMap('Tickets: 6041=AC-1, 6042=AC-2')], [['AC-1', ['6041']], ['AC-2', ['6042']]]);
  assert.deepEqual([...packetTicketMap('**Tickets:** 6041 = AC-1')], [['AC-1', ['6041']]]);
  assert.deepEqual([...packetTicketMap('Tickets: 6041 = AC-1..AC-3')].map(([t]) => t), ['AC-1', 'AC-2', 'AC-3']);
  assert.deepEqual([...packetTicketMap('Tickets: 6041 = AC-1, AC-2; 6045 = AC-3')], [['AC-1', ['6041']], ['AC-2', ['6041']], ['AC-3', ['6045']]]);
  assert.deepEqual([...packetCriteria(lines('- **[AC-B]** bold', '- [AC-C] plain')).keys()], ['AC-B', 'AC-C']);
});

test('self-review fixes: byte-order marks, a table-row status, a null id, a mixed hypothesis and the cost usage shapes', async (t) => {
  const dir = await makeRun(t);
  const bom = ch(0xfeff);
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), `${bom}{"findings":[]}`);
  await fs.writeFile(path.join(dir, 'manifest.json'), `${bom}${JSON.stringify(MANIFEST)}`);
  await fs.writeFile(path.join(dir, 'phase3', 'report-notes.md'), `${bom}${lines('## Why', 'Because of the BOM.')}`);
  const r = await runCli(['--run-dir', dir], { NO_COLOR: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Why: Because of the BOM\./);
  assert.deepEqual([...findingStatus(lines('| F1 | fixed after snapshot |', '- F2: fixed', '| F3 | pre-existing | extra |'))], [['F1', 'fixed after snapshot'], ['F2', 'fixed'], ['F3', 'pre-existing']]);
  assert.match(renderText(buildReport({ findingsDoc: { findings: [finding({ id: null }), finding({ id: 4 })] }, manifest: MANIFEST })), /LOW +\? +S|LOW +\? /);
  const mixed = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: '- [H1] x', seatTexts: { A: lines('## Checks performed', '- H1: CONFIRMED for the no-header case, REFUTED for the header case.'), B: lines('## Checks performed', '- H1: CONFIRMED.') } });
  assert.equal(mixed.criteria.rows[0].verdict, 'partly', 'a mixed outcome is partly, not refuted');
  const cost = buildReport({ findingsDoc: { findings: [] }, manifest: { status: 'completed', actors: [{ role: 'auditor', provider: 'anthropic', model_requested: 'opus', usage: { input_tokens: 6, cached_input_tokens: 44568, cache_write_input_tokens: 18341, output_tokens: 1343, source: 'summed-per-call' } }], reviewers: [{ role: 'B', provider: 'opencode', usage: { input_tokens: 19907, cached_input_tokens: 1792, cache_write_input_tokens: 0, output_tokens: 4, calls: 1 } }, { role: 'A', provider: 'openai', usage: { input_tokens: 2269954, cached_input_tokens: 2009344, cache_write_input_tokens: 0, output_tokens: 35791 } }] } }).cost;
  const row = (seat) => cost.find((x) => x.seat === seat);
  assert.deepEqual([row('auditor').newInput, row('auditor').cacheWrite], [18347, 18341], 'a Claude auditor with a short model alias');
  assert.deepEqual([row('seat B').newInput, row('seat B').cacheRead], [19907, 1792], 'OpenCode reports input without the cache');
  assert.equal(row('seat A').newInput, 260610, 'Codex input still includes the cache');
});

test('a hypothesis worded "Confirm it is fixed" has its outcomes flipped, so REFUTED still means the defect is gone', () => {
  const packet = lines('- [H1] Previous finding F1: the cache is never cleared. Confirm it is fixed.', '- [H2] the cache is never cleared on reload.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## Checks performed', '- H1: CONFIRMED, the clear runs now.', '- H2: REFUTED.'), B: lines('## Checks performed', '- H1: CONFIRMED.', '- H2: REFUTED.') } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.equal(by.H1.verdict, 'refuted', 'fix-worded CONFIRMED means fixed');
  assert.deepEqual(by.H1.outcomes, { A: 'REFUTED', B: 'REFUTED' });
  assert.equal(by.H2.verdict, 'refuted', 'a defect-worded hypothesis is not flipped');
  assert.equal(report.criteria.hypothesisStats.confirmed, 0);
  const caveats = renderChat(report, { all: true });
  assert.match(caveats, /H1 was worded "Confirm it is fixed"/);
  assert.doesNotMatch(caveats, /H2 was worded/);
  const open = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## Checks performed', '- H1: REFUTED, the clear still never runs.'), B: lines('## Checks performed', '- H1: REFUTED.') } });
  assert.equal(open.criteria.rows[0].verdict, 'confirmed', 'fix-worded REFUTED means the defect is still there');
  // Fix review R5: a packet that defines CONFIRMED asked for the defect's side, so nothing is flipped.
  const defined = lines('In `## Checks performed`, end each hypothesis line with CONFIRMED (the previous defect is still there), REFUTED (it is gone) or PARTLY CONFIRMED; the report prints that outcome.', packet);
  const current = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: defined, seatTexts: { A: lines('## Checks performed', '- H1: CONFIRMED, still broken.'), B: lines('## Checks performed', '- H1: CONFIRMED.') } });
  assert.equal(current.criteria.rows.find((r) => r.tag === 'H1').verdict, 'confirmed');
  assert.ok(!current.caveats.some((c) => c.includes('Confirm it is fixed')));
});

test('round 2 F3: the seats\' brief decides the "Confirm it is fixed" flip, read from phase1/brief-A.txt by loadRun', async (t) => {
  const packet = lines('- [H1] Previous finding F1: the cache is never cleared. Confirm it is fixed.');
  const seats = { A: lines('## Checks performed', '- H1: CONFIRMED, still broken.'), B: lines('## Checks performed', '- H1: CONFIRMED.') };
  const today = 'end a hypothesis line with CONFIRMED (the defect it names exists), REFUTED\n  (it does not)';
  assert.equal(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: seats, briefText: today }).criteria.rows[0].verdict, 'confirmed', 'a current brief: no flip, even with a packet that does not define it');
  assert.equal(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: seats, briefText: 'an old brief' }).criteria.rows[0].verdict, 'refuted', 'a 1.1.0 brief: flipped');
  const dir = await makeRun(t);
  await fs.writeFile(path.join(dir, 'task-packet.md'), packet);
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), seats.A);
  await fs.writeFile(path.join(dir, 'phase1', 'B-findings.md'), seats.B);
  await fs.writeFile(path.join(dir, 'phase1', 'brief-A.txt'), today);
  assert.equal((await loadRun(dir)).criteria.rows[0].verdict, 'confirmed');
  // Round 3 F1: a CLI first seat keeps its brief at phase1/A/brief.txt.
  await fs.rm(path.join(dir, 'phase1', 'brief-A.txt'));
  assert.equal((await loadRun(dir)).criteria.rows[0].verdict, 'refuted', 'no brief: the packet decides');
  await fs.mkdir(path.join(dir, 'phase1', 'A'));
  await fs.writeFile(path.join(dir, 'phase1', 'A', 'brief.txt'), today);
  assert.equal((await loadRun(dir)).criteria.rows[0].verdict, 'confirmed', 'the CLI seat brief');
});

test('self-review fixes: a reader that closes stdout early keeps the exit code and the requested files (review-run report)', async (t) => {
  const dir = await makeRun(t);
  const reviewRun = fileURLToPath(new URL('../review-run.mjs', import.meta.url));
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [reviewRun, 'report', '--run-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    child.on('close', resolve);
  });
  assert.equal(await run(['--out', path.join(dir, 'missing-folder', 'r.md')]), 2, 'a write error is still exit 2');
  assert.equal(await run(['--out', path.join(dir, 'r.md'), '--json', path.join(dir, 'r.json')]), 0);
  assert.equal(existsSync(path.join(dir, 'r.json')), true, 'the --json file is written');
});

test('self-review fixes: claim heading tags are read the same way for the report and the scorecard', () => {
  const known = ['AC-OWN-C', 'AC-1.2', 'AC-4'];
  assert.deepEqual(headingTags(' [AC-OWN-C] x', known), ['AC-OWN-C']);
  assert.deepEqual(headingTags(' [AC-1.2] x', known), ['AC-1.2']);
  assert.deepEqual(headingTags(' x (AC-4)', known), ['AC-4']);
});

test('failing words that describe code, quotes, identifiers or an expected pre-fix failure are not a failing check (real lines from a field run)', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-36-1] failed drives are counted', '- [AC-36-2] two');
  const seatA = lines('# A', '', '## No findings', '', '## Checks performed',
    "- [AC-36-1] static trace: `use == 'failed'` sets is_failed=1 and a Red 'Failed Drive' log_error with failed_drive_count++, and the drive_failed column.",
    '- [AC-36-2] the pre-fix test failed as intended; the fixed code passes.');
  const seatB = lines('# B', '', '## No findings', '', '- AC-36-1, AC-36-2: traced failed-drive counting and the alert identity. No defect found statically.');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  assert.deepEqual(report.criteria.rows.map((r) => r.failedSeats), [[], []]);
  assert.equal(report.caveats.some((c) => c.includes('failing check')), false);
  const real = lines('# A', '', '## No findings', '', '- [AC-36-1] device independence fails (reproduced); I filed no claim for it.');
  const flagged = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: real, B: seatB } });
  assert.deepEqual(flagged.criteria.rows[0].failedSeats, ['A'], 'a real failing sentence is still flagged');
});

test('live run notes: unresolved is not "disputed", seats that split on a hypothesis are named, a split ticket gets a caveat, a PARTIAL shows its reason, markdown carries the recommended fix', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [H1] no path can double count', '- [H2] second', '- Tickets: 6036 = AC-1, AC-2');
  const seatA = lines('# A', '', '## No findings', '', '- AC-1 PARTIAL: the NVMe host path was not run.', '- AC-2 MET: ok', '- H1: no path double counts. REFUTED.', '- H2: CONFIRMED.', '- 6036: NO GO - AC-1 is partial');
  const seatB = lines('# B', '', '## No findings', '', '- AC-1 MET: ok', '- AC-2 MET: ok', '- H1: read the loop. CONFIRMED.', '- H2: CONFIRMED.', '- 6036: GO');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'MEDIUM', final_state: 'unresolved-low-stakes', recommended_fix: 'Key the dedup on node id and status. Then add a test.' })] },
    manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  const chat = renderChat(report);
  assert.doesNotMatch(chat, /disputed/);
  assert.match(chat, /1 unresolved \(F1\)/);
  assert.match(chat, /^- SPLIT {8}H1 \(A refuted, B confirmed\)/m);
  assert.doesNotMatch(chat, /^- REFUTED/m);
  assert.match(chat, /^ {2}PARTIAL {6}AC-1 {2}no finding tagged$/m);
  assert.match(chat, /^ {15}the NVMe host path was not run\.$/m);
  assert.ok(report.caveats.some((c) => c.includes('Ticket 6036: the seats disagree (A NO GO, B GO)')));
  assert.match(renderMarkdown(report), /Fix: Key the dedup on node id and status\. Then add a test\./);
});

test('field feedback S3: a split ticket whose NO GO rests on a finding the auditor confirmed says the finding settles it', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- Tickets: 6076 = AC-1');
  const seatA = lines('# A', '', '## A1 [AC-1] The lag check returns None', 'Severity: HIGH', '', '## Checks performed', '- AC-1 NOT MET: see A1', '- 6076: NO GO - see A1');
  const seatB = lines('# B', '', '## No findings', '', '- AC-1 MET: ok', '- 6076: GO');
  const build = (result) => buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'], auditor_check: { result } })] },
    manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  const settled = build('CONFIRMED').caveats.find((c) => c.startsWith('Ticket 6076'));
  assert.equal(settled, 'Ticket 6076: the seats disagree (A NO GO, B GO); the auditor confirmed F1, so the ticket stays NO GO until it is fixed.');
  const open = build('NOT_CHECKED').caveats.find((c) => c.startsWith('Ticket 6076'));
  assert.match(open, /the exchange did not reconcile it, so read both seat files before you act\.$/, 'no confirmed finding: both seat files');
});

test('live run notes 4: the full recommended fix, a wrapped PARTIAL reason, SPLIT in the table, every flagged tag in the banner, findings next to a ticket verdict', () => {
  const longFix = 'Route the volume status through the alert helper, keep the remote-copy exception, guard a None status, and add a regression test. ' + 'Risk: the offline path changes colour; check the Yellow rows. '.repeat(8);
  const reason = 'the NVMe host path was not run because the lab array has no NVMe shelf and the simulator cannot return the tier field the code reads, so only the SAS path is proved';
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three', '- [AC-4] four', '- [AC-5] five', '- [AC-6] six', '- [H1] no path double counts', '- Tickets: 6036 = AC-1, AC-2, AC-3, AC-4, AC-5, AC-6');
  const checks = (v) => ['## Checks performed', ...['AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'].map((t) => '- ' + t + ' MET: ok'), '- AC-1 PARTIAL: ' + reason + '.', '- H1: ' + v + '.', '- 6036: NO GO - see AC-1'];
  const seatA = lines('# A', '', '## A1 [AC-2] [AC-3] [AC-4] [AC-5] [AC-6] The first claim', 'Severity: MEDIUM', '', ...checks('REFUTED'));
  const seatB = lines('# B', '', '## No findings', '', ...checks('CONFIRMED').slice(1));
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'MEDIUM', origins: ['A1'], recommended_fix: longFix })] },
    manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  const md = renderMarkdown(report);
  assert.ok(md.includes('Fix: ' + longFix.trim().slice(0, 40)));
  assert.ok(md.includes(longFix.trim().slice(-30)), 'the recommended fix is not cut');
  assert.match(md, /H1 .*SPLIT: A refuted, B confirmed/);
  assert.match(md, /A hypothesis is a claim to test: REFUTED means the claim as written is false/);
  const chat = renderChat(report);
  assert.ok(chat.includes('5 criteria with findings (AC-2, AC-3, AC-4, AC-5, AC-6)'), 'the banner names every tag up to eight');
  const block = chat.slice(chat.indexOf(String.fromCharCode(96).repeat(3) + 'diff'));
  assert.match(block, /^ {2}PARTIAL {6}AC-1 {2}no finding tagged$/m);
  const wrapped = block.split(String.fromCharCode(10)).filter((l) => l.startsWith('  ' + ''.padEnd(13)) && l.trim().length > 0 && !l.includes('findings'));
  assert.ok(wrapped.length >= 2 && wrapped.every((l) => l.length <= 100), 'the reason is wrapped inside 100 characters');
  assert.match(block, /^- NO GO {8}6036 {2}findings F1/m);
});

test('live run notes 5: a finding tagged only BUG-<ticket> or PROD-<ticket> shows on its ticket line; a long PARTIAL reason keeps its last sentences', () => {
  const tail = 'Live capture with VG snapshots is the missing piece.';
  const longReason = 'The fixture proves the SAS path. '.repeat(12) + tail;
  const packet = lines('# P', '## Acceptance criteria', '- [AC-30-1] one', '- [BUG-6030] bug reproduced and fixed', '- [PROD-6030] ticket is prod-ready', '- Tickets: 6030 = AC-30-1');
  const seatA = lines('# A', '', '## A1 [BUG-6030] [PROD-6030] The excluded volume gets no row', 'Severity: HIGH', '', '## Checks performed',
    '- AC-30-1 PARTIAL: ' + longReason, '- 6030: NO GO - see the volume finding');
  const seatB = lines('# B', '', '## No findings', '', '- AC-30-1 MET: ok', '- 6030: NO GO');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  assert.deepEqual(report.criteria.tickets.find((x) => x.id === '6030').findings, ['F1']);
  // Fix review R4: a finding the author marked wrong leaves the ticket line too.
  const wrong = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
    notesText: lines('## Finding status', '- F1: wrong: the volume is excluded on purpose'),
  });
  assert.deepEqual(wrong.criteria.tickets.find((x) => x.id === '6030').findings, []);
  const chat = renderChat(report);
  assert.match(chat, /^- NO GO {8}6030 {2}findings F1/m);
  const row = report.criteria.rows.find((r) => r.tag === 'AC-30-1');
  assert.ok(row.reason.startsWith('... ') && row.reason.endsWith(tail) && row.reason.length <= 304, 'the end of a long reason is kept');
  assert.equal(report.criteria.rows.find((r) => r.tag === 'AC-30-1').reason.includes('PARTIAL'), false);
});

test('live run notes 6: a finding tagged only BUG-<ticket> in its heading reaches the ticket line even when the packet lists that tag in prose; a 270-character reason is not cut', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-30-1] one', '- [AC-30-2] two', 'Per ticket also check these tags: [BUG-6030] = bug fixed, [PROD-6030] = prod-ready.', 'Tickets: 6030 = AC-30-1..AC-30-2');
  const reason = 'VG snapshot tests pass on fixed, fail on HEAD; field names (protection_written_capacity, time/snapshot_time) unconfirmed, both real captures have empty volume_group_snapshots. PARTIAL: gap, live capture with VG snapshots not available, not a proven defect.';
  const seatA = lines('# A', '', '## A1 [PROD-6030] The excluded volume gets no row', 'Severity: HIGH', '', '## A2 [AC-30-1] Another claim', 'Severity: MEDIUM', '', '## Checks performed', '- AC-30-1: ran it, no issue', '- AC-30-2: ' + reason, '- 6030: NO GO');
  const seatB = lines('# B', '', '## B1 [BUG-6030] [PROD-6030] Same defect, other words', 'Severity: HIGH', '', '## Checks performed', '- AC-30-2 MET: ok', '- 6030: NO GO');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1', 'B1'] }), finding({ id: 'F2', severity: 'MEDIUM', origins: ['A2'] })] },
    manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  assert.deepEqual(report.criteria.tickets.find((x) => x.id === '6030').findings, ['F1', 'F2']);
  const chat = renderChat(report);
  assert.match(chat, /^- NO GO {8}6030 {2}findings F1 F2/m);
  assert.ok(chat.replace(/\s+/g, ' ').includes('not available, not a proven defect.'), 'the last clause of the reason is shown');
  assert.equal(chat.includes('...'), false);
});

test('live run notes 8: a tag the Tickets line does not list (AC-30-F6) joins the one ticket whose number ends in 30, not a ticket "30"', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-30-1] one', '- [AC-30-F1] two', '- [AC-30-F6] three', '- [AC-36-1] four', 'Tickets: 6036 = AC-36-1; 6030 = AC-30-1');
  const checks = lines('# A', '', '## No findings', '', '- AC-30-1 MET: ok', '- AC-30-F1 MET: ok', '- AC-30-F6 MET: ok', '- AC-36-1 MET: ok', '- 6030: GO', '- 6036: GO');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: checks, B: SEAT_B } });
  const groups = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r.group]));
  assert.deepEqual(groups, { 'AC-30-1': '6030', 'AC-30-F1': '6030', 'AC-30-F6': '6030', 'AC-36-1': '6036' });
  assert.deepEqual(report.criteria.tickets.map((t) => t.id).sort(), ['6030', '6036']);
  const ambiguous = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('# P', '- [AC-30-F6] x', 'Tickets: 6030 = AC-30-1; 3030 = AC-3030-1'), seatTexts: { A: checks, B: SEAT_B } });
  assert.equal(ambiguous.criteria.rows[0].group, '30', 'two tickets end in 30: nothing is guessed');
});

// The manifest shapes build-manifest writes: seat_usage.A from a native transcript (selfreview-1 seat A: 59 tried, 1 failed),
// reviewers[B] from a Codex rollout (vsiclient-5tickets-run4 seat B: both commands refused by the sandbox).
const COMMANDS_MANIFEST = {
  ...MANIFEST,
  seat_usage: { ...MANIFEST.seat_usage, A: { ...MANIFEST.seat_usage.A, commands: { tried: 59, failed: 1, source: 'transcript' } }, B: undefined },
  reviewers: [MANIFEST.reviewers[0], { ...MANIFEST.reviewers[1], usage: MANIFEST.seat_usage.B, commands: { tried: 2, failed: 2, source: 'codex-rollout' } }],
};
delete COMMANDS_MANIFEST.seat_usage.B;

test('commands: the cost table in every format gets a Commands column only when a seat was counted; an uncounted row says unknown', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: COMMANDS_MANIFEST, seatTexts: { A: SEAT_A, B: SEAT_B } });
  const row = (seat) => report.cost.find((r) => r.seat === seat);
  assert.deepEqual(row('seat A').commands, { tried: 59, failed: 1 });
  assert.deepEqual(row('seat B').commands, { tried: 2, failed: 2 });
  assert.ok(!('commands' in row('auditor')), 'nothing counted, nothing invented');
  assert.deepEqual(costTableLines(report.cost), [
    'Seat     New input  Cache read   Output  Calls            Commands',
    'seat A        227k        8.3M  unknown     51  59 tried, 1 failed',
    'seat B        130k        1.6M      20k      -   2 tried, 2 failed',
    'auditor    unknown     unknown  unknown      -             unknown',
  ]);
  assert.match(renderText(report), /seat B +130k +1\.6M +20k +- +2 tried, 2 failed/);
  assert.match(renderMarkdown(report), /\| Seat \| New input \| Cache read \| Output \| Calls \| Commands \|\n\|---\|---:\|---:\|---:\|---:\|---:\|/);
  assert.match(renderMarkdown(report), /\| seat A \| 227k \| 8\.3M \| unknown \| 51 \| 59 tried, 1 failed \|/);
  assert.match(renderMarkdown(report), /\| auditor \| unknown \| unknown \| unknown \| - \| unknown \|/);
  assert.match(renderHtml(report), /<th>Calls<\/th><th>Commands<\/th><\/tr>/);
  assert.match(renderHtml(report), /<td>2 tried, 2 failed<\/td><\/tr>/);
  assert.match(renderChat(report, { all: true }), /\| seat B \| 130k \| 1\.6M \| 20k \| - \| 2 tried, 2 failed \|/);
  const old = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: { A: SEAT_A, B: SEAT_B } });
  for (const text of [renderText(old), renderMarkdown(old), renderHtml(old), renderChat(old), renderChat(old, { all: true }), JSON.stringify(old)]) assert.doesNotMatch(text, /Commands|COMMANDS|tried|"commands"/, 'a manifest without counts reports as before');
  const bad = buildReport({ findingsDoc: { findings: [] }, manifest: { ...COMMANDS_MANIFEST, reviewers: [MANIFEST.reviewers[0], { ...COMMANDS_MANIFEST.reviewers[1], commands: { tried: 1, failed: 3 } }] } });
  assert.ok(!('commands' in bad.cost.find((r) => r.seat === 'seat B')), 'more failed than tried is not a count');
  const ref = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, reviewers: [MANIFEST.reviewers[0], { ...MANIFEST.reviewers[1], usage_ref: 'seat_usage.B', commands: { tried: 2, failed: 2, source: 'codex-rollout' } }] } });
  assert.deepEqual(ref.cost.find((r) => r.seat === 'seat B').commands, { tried: 2, failed: 2 }, 'a CLI seat whose usage is in seat_usage keeps its count');
});

test('commands: the chat report names a seat only when none of its commands succeeded, in one line of at most 100 characters', () => {
  const chat = (manifest) => renderChat(buildReport({ findingsDoc: { findings: [] }, manifest, seatTexts: { A: SEAT_A, B: SEAT_B } }));
  const text = chat(COMMANDS_MANIFEST);
  assert.match(text, /^- COMMANDS     seat B tried 2 commands, all failed; its result rests on reading alone$/m);
  assert.doesNotMatch(text, /COMMANDS +seat A/, 'seat A had 1 failure of 59: the --all table shows it, the short report does not');
  const none = chat({ ...COMMANDS_MANIFEST, seat_usage: { ...COMMANDS_MANIFEST.seat_usage, A: { ...COMMANDS_MANIFEST.seat_usage.A, commands: { tried: 0, failed: 0, source: 'transcript' } } } });
  assert.match(none, /^- COMMANDS     seat A ran no commands; its result rests on reading alone$/m);
  const one = chat({ ...COMMANDS_MANIFEST, reviewers: [MANIFEST.reviewers[0], { ...COMMANDS_MANIFEST.reviewers[1], commands: { tried: 1, failed: 1, source: 'codex-rollout' } }] });
  assert.match(one, /^- COMMANDS     seat B tried 1 command, it failed; its result rests on reading alone$/m);
  const scripts = chat({ ...COMMANDS_MANIFEST, reviewers: [MANIFEST.reviewers[0], { ...COMMANDS_MANIFEST.reviewers[1], commands: { tried: 1, failed: 1, scripts: 29, scriptsFailed: 2, source: 'codex-rollout' } }] });
  assert.match(scripts, /^- COMMANDS     seat B tried 1 command, it failed; it ran 27 tool scripts instead$/m, 'a seat that ran node_repl scripts did more than read');
  const auditor = chat({ ...COMMANDS_MANIFEST, seat_usage: { ...COMMANDS_MANIFEST.seat_usage, auditor: { commands: { tried: 0, failed: 0, source: 'transcript' } } } });
  assert.doesNotMatch(auditor, /COMMANDS +auditor/, 'the line is about the reviewer seats');
  for (const out of [text, none, one, scripts]) for (const line of out.split(NL)) assert.ok(line.length <= 100 || !/COMMANDS/.test(line), line);
});

test('field r4: a status line that looks like an outcome word but is not one gets a caveat; a real one or free text does not', () => {
  const caveats = (line) => buildReport({ findingsDoc: { findings: [finding({ id: 'F1' })] }, manifest: MANIFEST, notesText: `## Finding status\n- F1: ${line}\n` }).caveats.filter((c) => c.includes('not an outcome word'));
  assert.equal(caveats('wontfix: too costly').length, 1);
  assert.match(caveats('wontfix: too costly')[0], /F1's line in the report notes starts with "wontfix:"/);
  assert.equal(caveats('not-worth-it: one log line').length, 0);
  assert.equal(caveats('fixed after the snapshot, not re-reviewed').length, 0);
  assert.equal(caveats('https://dev.azure.com/org/project/_workitems/edit/6075').length, 0, 'a link is not a mistyped outcome word');
});

test('outcome words in the notes: only the first word counts; wrong withdraws (a blocker only with a reason) from the groups, blockers and severity counts; intentional/not-worth-it/decided can wait', () => {
  assert.deepEqual(outcomeOf('wrong: the cap is never reached'), { word: 'wrong', reason: 'the cap is never reached' });
  assert.deepEqual(outcomeOf('Not-worth-it - one log line'), { word: 'not-worth-it', reason: 'one log line' });
  assert.deepEqual(outcomeOf('decided'), { word: 'decided', reason: '' });
  assert.equal(outcomeOf('wrong value returned for empty input'), null, 'a plain sentence that starts with the word is not an outcome');
  assert.equal(outcomeOf('returns the wrong value'), null);
  assert.equal(outcomeOf('not fixed yet'), null);
  const notes = lines('## Finding status', '- F1: wrong: needs 100,000 vdisks and the cap is 1000 pages of 1000', '- F2: wrong', '- F3: intentional: matches the vendor tool', '- F4: wrong: duplicate of F5', '- F5: returns the wrong value, not fixed yet');
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'HIGH' }), finding({ id: 'F2', severity: 'HIGH' }), finding({ id: 'F3', severity: 'MEDIUM' }),
      finding({ id: 'F4', severity: 'MEDIUM' }), finding({ id: 'F5', severity: 'MEDIUM' }),
    ] },
    manifest: MANIFEST, notesText: notes,
  });
  const g = groupFindings(report);
  assert.deepEqual(g.withdrawn.map((f) => f.id), ['F1', 'F4']);
  assert.deepEqual(g.fixNow.map((f) => f.id), ['F2'], 'a blocker marked wrong with no reason stays');
  assert.deepEqual(g.canWait.map((f) => f.id), ['F3']);
  assert.deepEqual(g.fixNext.map((f) => f.id), ['F5'], 'free text keeps its old meaning');
  assert.deepEqual(report.blockers, ['F2'], 'a blocker withdrawn with a reason is no longer a blocker');
  assert.deepEqual([report.counts.high, report.counts.medium, report.counts.withdrawn], [1, 2, 2], 'withdrawn findings leave the severity counts');
  assert.ok(report.caveats.some((c) => c.startsWith('F2 is marked wrong in the report notes with no reason')));
  assert.ok(report.caveats.some((c) => c.startsWith('F1, F4 are marked wrong in the report notes, so they are counted as withdrawn')));
  const chat = renderChat(report);
  assert.match(chat, /^ {2}WITHDRAWN {4}2 claim\(s\) refuted or dropped, or marked wrong by the author: F1 F4$/m);
  assert.match(chat, /1 blocker \(fix F2 first\)/);
  assert.match(chat, /CHECKED +0 of 3 findings|VERIFIED/, 'the auditor line counts only findings still standing');
});

test('fix review R4: a finding marked wrong leaves its criterion, hypothesis and ticket lines too', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'] }), finding({ id: 'F2', severity: 'MEDIUM', origins: ['A2'] })] },
    manifest: MANIFEST,
    packetText: lines('- [AC-1] One.', '- [H1] the cap is never reached.'),
    seatTexts: { A: lines('## A1 — [AC-1] cap missing', '## A2 — [H1] cap never reached', '## Checks performed', '- AC-1: MET.', '- H1: REFUTED.') },
    notesText: lines('## Finding status', '- F1: wrong: the cap is never reached', '- F2: wrong: duplicate of F1'),
  });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.deepEqual([by['AC-1'].status, by['AC-1'].findings, by['AC-1'].refuted], ['clean', [], ['F1']]);
  assert.equal(by.H1.verdict, 'refuted');
  assert.equal(report.criteria.hypothesisStats.confirmed, 0);
  assert.doesNotMatch(renderChat(report, { all: true }), /issue found: F1/i);
});

const CHANGE_DIFF = lines(
  'diff --git a/vsiclient/x.py b/vsiclient/x.py', '--- a/vsiclient/x.py', '+++ b/vsiclient/x.py', '@@ -10,3 +10,5 @@ def f():',
  ' a = 1', '+b = 2', '+++ counter;', ' c = 4', ' d = 5',
  'diff --git a/new.py b/new.py', 'new file mode 100644', '--- /dev/null', '+++ b/new.py', '@@ -0,0 +1,2 @@', '+one', '+two',
);

test('where in the change: the best tag over every evidence file:line (added lines, near the change, changed file, outside), unknown without one; an added "++" line is not a file header', () => {
  const hunks = diffHunks(CHANGE_DIFF);
  assert.deepEqual([...hunks.keys()], ['vsiclient/x.py', 'new.py']);
  assert.deepEqual([...hunks.get('vsiclient/x.py').added], [11, 12]);
  const tag = (...evidence) => whereInChange(evidence, hunks);
  assert.deepEqual(tag('targets/app_client/vsiclient/x.py:11 sets b'), { tag: 'added lines', at: 'targets/app_client/vsiclient/x.py:11' });
  assert.equal(tag('vsiclient/x.py:30').tag, 'near the change');
  assert.equal(tag('vsiclient/x.py:200').tag, 'changed file');
  assert.equal(tag('tests/test_x.py:5').tag, 'outside the change');
  assert.equal(tag('tests/test_x.py:5 fails', 'then vsiclient/x.py:12').tag, 'added lines', 'the best location wins, not the first');
  assert.equal(tag('C:\\repo\\vsiclient\\x.py:12').tag, 'added lines');
  assert.equal(tag('new.py:2').tag, 'added lines');
  assert.deepEqual(tag('no location here; see https://host.example:9443/x'), { tag: 'unknown', at: null });
  assert.deepEqual(tag('curl http://10.0.0.5:8443/api/disks.json:200'), { tag: 'unknown', at: null }, 'a URL with a port is not a file:line');
});

test('where in the change: plain diff -u headers (tab and time), git-quoted names and deleted files are read; a root file does not claim a same-named file in a folder; two diffs keep their own files', () => {
  const plain = lines('--- old/src/x.c\t2026-10-02 10:00:00.000000000 +0000', '+++ new/src/x.c\t2026-10-02 11:00:00.000000000 +0000', '@@ -1,2 +1,3 @@', ' a', '+b', ' c');
  assert.equal(whereInChange(['src/x.c:2'], diffHunks(plain)).tag, 'added lines');
  const quoted = lines('diff --git "a/src/caf\\303\\251.js" "b/src/caf\\303\\251.js"', '--- "a/src/caf\\303\\251.js"', '+++ "b/src/caf\\303\\251.js"', '@@ -1 +1,2 @@', ' x', '+y');
  assert.deepEqual([...diffHunks(quoted).keys()], ['src/café.js']);
  const deleted = lines('diff --git a/src/del.js b/src/del.js', 'deleted file mode 100644', '--- a/src/del.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two');
  assert.equal(whereInChange(['src/del.js:1'], diffHunks(deleted)).tag, 'changed file');
  const root = lines('--- a/index.js', '+++ b/index.js', '@@ -1 +1,2 @@', ' a', '+b');
  assert.equal(whereInChange(['lib/index.js:2'], diffHunks(root)).tag, 'outside the change');
  assert.equal(whereInChange(['index.js:2'], diffHunks(root)).tag, 'added lines');
  const repoA = lines('--- a/src/app.py', '+++ b/src/app.py', '@@ -10 +10,2 @@', ' a', '+b');
  const repoB = lines('--- a/src/app.py', '+++ b/src/app.py', '@@ -200 +200,2 @@', ' a', '+b');
  assert.equal(whereInChange(['src/app.py:11'], [diffHunks(repoA), diffHunks(repoB)]).tag, 'added lines', 'one diff does not overwrite the other');
});

test('where in the change: a path under a snapshot folder matches by file name when one diff file in a folder has that name', () => {
  const pkg = lines('--- a/CONTOSO_V4_DEVICE/Reporter.py', '+++ b/CONTOSO_V4_DEVICE/Reporter.py', '@@ -10 +10,2 @@', ' a', '+b');
  assert.deepEqual(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(pkg)), { tag: 'added lines', at: 'REVIEW/head/Reporter.py:11, matched by file name to CONTOSO_V4_DEVICE/Reporter.py', byName: true });
  assert.deepEqual(whereInChange(['REVIEW/head/Reporter.py:11', 'CONTOSO_V4_DEVICE/Reporter.py:11'], diffHunks(pkg)), { tag: 'added lines', at: 'CONTOSO_V4_DEVICE/Reporter.py:11' }, 'a path match wins over a name guess');
  // Round 2 F1: same-named files (the two skills' identical copies) give the tag they agree on, else "unknown", never "outside".
  const two = lines(pkg, '--- a/OTHER_DEVICE/Reporter.py', '+++ b/OTHER_DEVICE/Reporter.py', '@@ -10 +10,2 @@', ' a', '+b');
  assert.deepEqual(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(two)), { tag: 'added lines', at: 'REVIEW/head/Reporter.py:11, matched by file name to CONTOSO_V4_DEVICE/Reporter.py, OTHER_DEVICE/Reporter.py', byName: true });
  assert.equal(whereInChange(['Reporter.py:11'], diffHunks(two)).tag, 'added lines', 'a bare name the same way');
  const apart = lines(pkg, '--- a/OTHER_DEVICE/Reporter.py', '+++ b/OTHER_DEVICE/Reporter.py', '@@ -300 +300,2 @@', ' a', '+b');
  assert.deepEqual(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(apart)), { tag: 'unknown', at: 'REVIEW/head/Reporter.py:11, file name shared by 2 changed files', byName: true, addedInOne: true });
  const withRoot = lines(pkg, '--- a/Reporter.py', '+++ b/Reporter.py', '@@ -300 +300,2 @@', ' a', '+b');
  assert.equal(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(withRoot)).tag, 'unknown', 'a root file with the name makes it ambiguous');
  assert.equal(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(lines('--- a/x.py', '+++ b/x.py', '@@ -1 +1,2 @@', ' a', '+b'))).tag, 'outside the change', 'no diff file has the name');
  // Round 3 F2: a partial path that two diff files end with is a guess, in either diff order; the whole path stays a real match.
  const a = lines('--- a/pkgA/src/x.py', '+++ b/pkgA/src/x.py', '@@ -10 +10,2 @@', ' a', '+b');
  const b = lines('--- a/pkgB/src/x.py', '+++ b/pkgB/src/x.py', '@@ -300 +300,2 @@', ' a', '+b');
  for (const diff of [lines(a, b), lines(b, a)]) {
    const w = whereInChange(['src/x.py:11'], diffHunks(diff));
    assert.deepEqual([w.tag, w.byName, w.addedInOne], ['unknown', true, true]);
  }
  assert.deepEqual(whereInChange(['pkgA/src/x.py:11'], diffHunks(lines(a, b))), { tag: 'added lines', at: 'pkgA/src/x.py:11' });
  assert.deepEqual(whereInChange(['src/x.py:11'], diffHunks(lines(a, lines('--- a/pkgB/src/x.py', '+++ b/pkgB/src/x.py', '@@ -10 +10,2 @@', ' a', '+b')))).tag, 'added lines', 'two that agree');
  assert.deepEqual(whereInChange(['src/x.py:11'], diffHunks(a)), { tag: 'added lines', at: 'src/x.py:11' }, 'one diff file ends with it: a real match');
  const root = lines('--- a/Reporter.py', '+++ b/Reporter.py', '@@ -10 +10,2 @@', ' a', '+b');
  assert.equal(whereInChange(['REVIEW/head/Reporter.py:11'], diffHunks(root)).tag, 'outside the change', 'a root diff file never claims a file in a folder');
});

test('where in the change: shown in md and text with the diff it came from; without a diff nothing changes; the run folder since.diff is read by default', async (t) => {
  const findingsDoc = { findings: [finding({ id: 'F1', severity: 'HIGH', evidence: ['vsiclient/x.py:11'] }), finding({ id: 'F2', evidence: ['notes only'] })] };
  const report = buildReport({ findingsDoc, manifest: MANIFEST, changeDiffs: [{ name: 'since.diff', text: CHANGE_DIFF }] });
  const md = renderMarkdown(report);
  assert.match(md, /^ {2}Where: added lines \(vsiclient\/x\.py:11\)$/m);
  assert.match(md, /^ {2}Where: unknown$/m);
  assert.match(md, /^- Where tags \(a hint from evidence file:line, never a grouping\): since\.diff sha256 [0-9a-f]{12}$/m);
  assert.match(renderText(report, { color: false }), /^ {11}Where: added lines \(vsiclient\/x\.py:11\)$/m);
  assert.deepEqual(groupFindings(report).fixNow.map((f) => f.id), ['F1'], 'the tag never moves a finding');
  const none = renderMarkdown(buildReport({ findingsDoc, manifest: MANIFEST }));
  assert.doesNotMatch(none, /Where/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-where-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'phase3'));
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify(findingsDoc));
  assert.deepEqual((await loadRun(dir)).changeDiffs, []);
  await fs.writeFile(path.join(dir, 'since.diff'), CHANGE_DIFF);
  assert.equal((await loadRun(dir)).findings.find((f) => f.id === 'F1').where.tag, 'added lines');
  const missing = await runCli(['--run-dir', dir, '--change-diff', path.join(dir, 'nope.diff')]);
  assert.match(missing.stderr, /--change-diff .*nope\.diff does not exist/);
});

test('field northwind-1a: a seat whose usage is a lower bound (a call reported none) shows its numbers and a note naming the missing calls', () => {
  const manifest = { ...MANIFEST, reviewers: [MANIFEST.reviewers[0], { role: 'B', provider: 'openai', transport: 'cli', usage: { source: 'provider', input_tokens: 3799667, cached_input_tokens: 3610496, output_tokens: 46603, calls_without_usage: 1 } }],
    seat_usage: { A: MANIFEST.seat_usage.A } };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest });
  const b = report.cost.find((r) => r.seat === 'seat B');
  assert.equal(b.newInput, 3799667 - 3610496);
  assert.equal(b.output, 46603);
  assert.match(costNote(report.cost), /seat B: a lower bound; 1 call\(s\) reported no usage and are not counted\./);
  assert.equal(costNote([seatCostRow('seat B', { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1, calls: 1 })]), null);
});

test('drift accepted while the seats worked (step phase1/phase2) says a seat may have read the change; an audit-only record keeps the auditor wording', () => {
  const cav = (step) => buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, drift_accepted: [{ at: 'x', ...(step ? { step } : {}), files: ['CONTOSO_V4_DEVICE/Reporter.py'] }] } }).caveats.find((c) => c.includes('--accept-drift'));
  assert.match(cav('phase1'), /^The target changed while the seats were reviewing it .*CONTOSO_V4_DEVICE\/Reporter\.py.*a seat or the auditor may have read/);
  assert.match(cav('phase2'), /while the seats were reviewing it/);
  assert.match(cav('audit'), /^The target changed after Phase 1 and the audit went on/);
  assert.match(cav(null), /^The target changed after Phase 1 and the audit went on/, 'an older record without a step');
});

test('review rules changed by the reviewed change: one caveat naming the copy the seats used; none otherwise', () => {
  const caveats = (rules) => buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, ...(rules ? { review_rules: rules } : {}) } }).caveats;
  assert.ok(caveats({ mode: 'head', changed_by_target: true, files: [] }).includes('The review rules (REVIEW.md) differ from the committed copy (the working tree or the branch changed them, possibly another session); the seats used the merge-base copy.'));
  assert.ok(caveats({ mode: 'head', changed_by_target: false, base_unknown: true, files: [] }).some((c) => c.includes('read at the branch tip')));
  assert.ok(caveats({ mode: 'worktree', changed_by_target: true, files: [] }).some((c) => c.includes('the working-tree copy')));
  assert.ok(!caveats({ mode: 'head', changed_by_target: false, files: [] }).some((c) => c.includes('REVIEW.md')));
  assert.ok(!caveats(null).some((c) => c.includes('REVIEW.md')));
});

test('review round: shown in every header when the packet names it; from round 3 a step-back caveat; no line, no round', () => {
  const at = (n) => buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: n === null ? PACKET : `# Task packet: re-review\nReview round: ${n}\n\n${PACKET}` });
  const two = at(2);
  assert.equal(two.round, 2);
  assert.ok(!two.caveats.some((c) => c.startsWith('Round ')));
  assert.match(renderText(two, { color: false }), /round 2/);
  assert.match(renderMarkdown(two), /^# Review report: \w+ \(round 2\)$/m);
  assert.match(renderChat(two), /^> \*\*REVIEW \w+ · round 2 · /m);
  const three = at(3);
  assert.ok(three.caveats.some((c) => c.startsWith('Round 3: findings keep coming from fixes.')));
  const none = at(null);
  assert.equal(none.round, null);
  assert.doesNotMatch(renderChat(none), /round/);
});

test('time: wall time from the first brief to findings.json and the orchestrator working time, in text and md; a missing or reversed span is unknown', async (t) => {
  const manifest = { ...MANIFEST, seat_usage: { ...MANIFEST.seat_usage, orchestrator: { duration_ms: 656812 } } };
  const both = buildReport({ findingsDoc: { findings: [] }, manifest, timing: { start: '2026-10-16T07:47:52.017Z', end: '2026-10-16T08:15:40.000Z' } });
  assert.match(renderText(both, { color: false }), /^ {2}Time: 28 min wall \(first brief to findings\.json; packet writing not counted\); orchestrator working time 11 min$/m);
  assert.match(renderMarkdown(both), /^- Time: 28 min wall .*orchestrator working time 11 min$/m);
  const reversed = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, timing: { start: '2026-10-16T08:15:40.000Z', end: '2026-10-16T07:47:52.017Z' } });
  assert.match(renderMarkdown(reversed), /^- Time: unknown wall .*orchestrator working time unknown$/m);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-time-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'phase3'));
  const findingsFile = path.join(dir, 'phase3', 'findings.json');
  await fs.writeFile(findingsFile, '{"findings":[]}\n');
  assert.equal((await loadRun(dir)).time.wallMs, null, 'no skill-versions.jsonl: unknown');
  await fs.writeFile(path.join(dir, 'skill-versions.jsonl'), lines('{"phase":"phase2","at":"2026-10-16T08:00:00.000Z"}', 'not json', '{"phase":"phase1","at":"2026-10-16T07:50:00.000Z"}'));
  await fs.utimes(findingsFile, new Date('2026-10-16T08:20:00.000Z'), new Date('2026-10-16T08:20:00.000Z'));
  assert.equal((await loadRun(dir)).time.wallMs, 30 * 60000, 'the earliest brief starts the span');
});

test('trigger and same_shape: shown under the finding in md (and so chat --all) and under a blocker in text; "none found" sites and findings without the keys show nothing', () => {
  const report = buildReport({
    findingsDoc: { findings: [
      finding({ id: 'F1', severity: 'HIGH', trigger: ['A1: more than 100,000 vdisks; rare'], same_shape: ['A1: pg.py:40', 'B2: none found (searched _pg_list)'] }),
      finding({ id: 'F2', severity: 'MEDIUM', same_shape: ['B1: none found'] }),
      finding({ id: 'F3', severity: 'LOW' }),
    ] },
    manifest: MANIFEST,
  });
  const md = renderMarkdown(report);
  assert.match(md, /^ {2}Trigger: A1: more than 100,000 vdisks; rare$/m);
  assert.match(md, /^ {2}Same shape: A1: pg\.py:40$/m);
  assert.equal(md.match(/Same shape:/g).length, 1, 'a "none found" sweep is not a site');
  assert.equal(md.match(/Trigger:/g).length, 1);
  assert.match(renderChat(report, { all: true }), /Trigger: A1: more than 100,000 vdisks/);
  const text = renderText(report, { color: false });
  assert.match(text, /^ {11}Trigger: A1: more than 100,000 vdisks; rare$/m);
  assert.match(text, /^ {11}Same shape: A1: pg\.py:40$/m);
  assert.doesNotMatch(renderChat(report), /Trigger:/, 'the short chat report is unchanged');
});

test('closing round 5 F2: the tag lines are read under the one section heading, through its subheadings, up to the next level-1 or level-2 heading; other heading shapes are not read', async () => {
  const { checksPerformed } = await import('../build-report.mjs');
  for (const next of ['## Appendix', '# Appendix']) {
    const text = `## A1 — x\n\n## Checks performed\n- AC-1: ran it. MET\n### Detail\n- H1: gone. REFUTED\nBlocked: none\n${next}\n- AC-2: copied. NOT MET\n`;
    const got = checksPerformed(text, 'A');
    assert.match(got, /AC-1: ran it\. MET/, next);
    assert.match(got, /H1: gone\. REFUTED/, next);
    assert.doesNotMatch(got, /AC-2/, next);
  }
  for (const heading of ['### Checks performed', '## 4. Checks performed', '## (1) Checks performed', '## **Checks performed**', '# Checks performed', '## `Checks performed`', '    ## Checks performed']) {
    assert.equal(checksPerformed(`## A1 — x\n\n${heading}\n- AC-1: ok. MET\nBlocked: none\n`, 'A'), '', heading);
  }
});

test('step 5: the report prints the observed overlap of the seats: raised by seat A only, seat B only, or both', () => {
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', origins: ['A1', 'B2'] }), finding({ id: 'F2', origins: ['A2'] }), finding({ id: 'F3', origins: ['A3'] }), finding({ id: 'F4', origins: ['B1'] })] },
    manifest: MANIFEST, packetText: '', seatTexts: {},
  });
  assert.deepEqual(report.coverage.overlap, { aOnly: 2, bOnly: 1, both: 1 });
  const line = 'Raised by: seat A only 2, seat B only 1, both 1 (observed counts)';
  assert.ok(renderText(report).includes(line));
  assert.ok(renderMarkdown(report).includes(`- ${line}`));
  assert.ok(renderHtml(report).includes(`<p>${line}</p>`));
  const none = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: '', seatTexts: {} });
  assert.equal(none.coverage.overlap, null);
  assert.doesNotMatch(renderText(none), /Raised by/);
});

test('field run: chat names the flagged criteria past the first eight instead of a bare count', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `AC-${i + 1}`);
  const packet = lines('# P', '## Acceptance criteria', ...ids.map((id) => `- [${id}] item`));
  const seat = lines('# A', '', '## No findings', '', ...ids.map((id) => `- ${id} NOT MET: the check failed`));
  const out = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: seat } }));
  assert.match(out, /^- MORE {9}2 more flagged: AC-9 AC-10 \(--all lists them\)$/m, out);
  assert.doesNotMatch(out, /\(\+\d+ more\)$/m);
});

// How far a result was checked: web citations, skipped checks, bare pass lines, read-only confirmations, unopened concedes.
const seatWith = (checks, web = null) => lines('# A', '', '## A1 [AC-1] t', 'Severity: LOW', '', '## Checks performed', ...checks, ...(web ? ['', web] : []));

test('certainty R1: a web-cited SOURCE_CITATION finding gets a caveat; a seat that opened no page is named, in chat and json', () => {
  const findings = [
    finding({ id: 'F3', origins: ['A1'], basis: 'SOURCE_CITATION', evidence: ['https://example.com/doc says x'] }),
    finding({ id: 'F5', origins: ['B1'], basis: 'SOURCE_CITATION', evidence: ['see http://vendor.test/api'] }),
    finding({ id: 'F6', origins: ['A2'], basis: 'SOURCE_CITATION', evidence: ['README.md:3 says x'] }),
    finding({ id: 'F7', origins: ['B2'], basis: 'SOURCE_CITATION', evidence: ['https://gone.test'], final_state: 'settled-refuted' }),
  ];
  const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: { A: seatWith([], 'web: 2 queries, 1 page fetches'), B: seatWith([], 'web: 3 queries, 0 page fetches') } });
  assert.ok(report.caveats.includes('F3, F5: web citation, not re-checked by the auditor (it has no web access)'), report.caveats.join('\n'));
  assert.ok(report.caveats.includes('F5: its seat reported opening no page (search results only)'));
  assert.match(renderChat(report), /> Caveat: F3, F5: web citation, not re-checked by the auditor/);
  assert.match(JSON.stringify(report), /F5: its seat reported opening no page/);
  const noLine = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: { A: seatWith([]), B: seatWith([]) } });
  assert.equal(noLine.caveats.filter((c) => /opening no page/.test(c)).length, 0, 'no web line, no claim about page fetches');
});

test('certainty R2: a NOT CHECKED line does not check its tag; verdict-less gap words and a pass line\'s own gap are doubt; a skipped-checks caveat', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c', '- [AC-4] d');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- NOT CHECKED: AC-1 on Linux (no box)', '1. NOT CHECKED: the AC-2 timing (web budget spent)', '- AC-3: could not run it here', '- AC-4: ran `node x.mjs`; NOT CHECKED: the full suite. MET',
  ]), B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.deepEqual([by['AC-1'].status, by['AC-2'].status], ['not-verified', 'not-verified']);
  assert.deepEqual([by['AC-3'].doubt, by['AC-4'].doubt], [['A'], ['A']]);
  assert.deepEqual(report.criteria.silentSeats, []);
  const caveat = 'Checks not done — seat A: AC-1 on Linux (no box); the AC-2 timing (web budget spent)';
  assert.ok(report.caveats.includes(caveat), report.caveats.join('\n'));
  assert.ok(renderChat(report).includes(`> Caveat: ${caveat}`));
  assert.ok(JSON.stringify(report).includes(JSON.stringify(caveat)));
});

test('certainty R2: a MET line about the reviewed code\'s token budget, untested inputs or "cannot" is not a doubtful check', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- AC-1: the brief stays within its token budget (build-brief.mjs:40). MET', '- AC-2: untested inputs are rejected with exit 1 (x.mjs:9). MET', '- AC-3: a seat cannot write outside its folder (y.mjs:3). MET',
  ]), B: '' } });
  assert.deepEqual(report.criteria.rows.map((r) => r.doubt), [[], [], []]);
});

test('certainty R2: the skipped-checks caveat lists at most 8 lines, then how many more', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: { A: seatWith(Array.from({ length: 6 }, (_, i) => `- NOT CHECKED: a${i}`)), B: seatWith(Array.from({ length: 4 }, (_, i) => `- NOT CHECKED: b${i}`)) } });
  assert.ok(report.caveats.includes('Checks not done — seat A: a0; a1; a2; a3; a4; a5; seat B: b0; b1; +2 more'), report.caveats.join('\n'));
});

test('certainty R3: pass lines that name a tag but cite no file:line, backtick, link, own claim ID or finding ID are counted per seat', () => {
  const packet = lines(...Array.from({ length: 8 }, (_, i) => `- [AC-${i + 1}] c`), '- [H1] h', '- [H2] h');
  const seatB = lines('# B', '', '## B1 t', 'Severity: LOW', '', '## Checks performed',
    '- AC-1: looked fine. MET', '- `AC-2`: checked it. MET', '- AC-3: x.mjs:12 handles it. MET', '- AC-4: ran `node t.mjs`. MET', '- AC-5: https://example.com/spec agrees. MET',
    '- AC-6: same as B1. MET', '- AC-7: covered by F2. MET', '- AC-8: not fully covered. PARTIAL', '- H1: read the code, no such path. REFUTED', '- H2: A1 shows it. REFUTED');
  const report = buildReport({ findingsDoc: { findings: [finding({ id: 'F2', origins: ['B1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: '', B: seatB } });
  assert.deepEqual(report.criteria.passes.B, { passes: 9, bare: 4 });
  const caveat = 'Seat B: 4 of 9 MET or REFUTED check lines cite no file:line, backticked command, link, claim ID or finding ID the report could find';
  assert.ok(report.caveats.includes(caveat), report.caveats.join('\n'));
  assert.ok(renderChat(report).includes(`> Caveat: ${caveat}`));
  assert.equal(report.caveats.filter((c) => /^Seat A: .* the report could find$/.test(c)).length, 0, 'no pass, no caveat');
});

test('certainty review fixes: anchors in other forms, a backticked tag with a colon, code words on MET lines, bold NOT CHECKED; lowercase is prose', () => {
  const packet = lines(...Array.from({ length: 9 }, (_, i) => `- [AC-${i + 1}] c`), '- [H1] h');
  const seatA = lines('# A', '', '## A1 t', 'Severity: LOW', '', '## Checks performed',
    '- AC-1: Makefile:12 sets it. MET', '- AC-2: x.mjs#L12 sets it. MET', '- AC-3: x.mjs line 12 sets it. MET', '- `AC-4:` read it. MET',
    '- AC-5: items NOT CHECKED by the tool are rejected (x.mjs:4). MET', '- AC-6: cache hits are not rerun (x.mjs:3). MET', '- AC-7: the hook did not run twice (x.mjs:3). MET',
    '- AC-8: Not checked on Linux; Windows ok (x.mjs:3). MET', '**1.** NOT CHECKED: AC-9 (no box)', '| not checked | AC-9 later |',
    '- H1: no such path in x.mjs:4; suite not rerun (web budget spent). REFUTED');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.deepEqual(report.criteria.passes.A, { passes: 9, bare: 1 }, 'eight MET lines and the refuted hypothesis; only the backticked tag is bare');
  assert.deepEqual(['AC-5', 'AC-6', 'AC-7'].map((t) => by[t].doubt), [[], [], []], 'words about the code are not a gap');
  assert.deepEqual(by['AC-8'].doubt, [], 'a sentence-case "Not checked" gap is not one of the two markers');
  assert.deepEqual([by['AC-9'].status, by['AC-9'].seats], ['clean', ['A']], 'a lowercase "not checked" table cell is prose, so it names AC-9');
  assert.ok(report.caveats.includes('Checks not done — seat A: AC-9 (no box)'), report.caveats.join('\n'));
  assert.ok(report.caveats.includes('H1: seat A said its check was incomplete'), report.caveats.join('\n'));
});

test('certainty review fixes: a seat that ran no search is not said to have used search results', () => {
  const findings = [finding({ id: 'F5', origins: ['B1'], basis: 'SOURCE_CITATION', evidence: ['see http://vendor.test/api'] })];
  const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: { A: seatWith([]), B: seatWith([], 'web: 0 queries, 0 page fetches') } });
  assert.ok(report.caveats.includes('F5: its seat reported no search and no page opened'), report.caveats.join('\n'));
  assert.equal(report.caveats.filter((c) => /search results only/.test(c)).length, 0);
});

test('certainty R4: an EXECUTED finding the auditor confirmed by reading gets a caveat; a null auditor basis or an EXECUTED one does not', () => {
  const findings = [
    finding({ id: 'F2', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
    finding({ id: 'F3', auditor_check: { result: 'CONFIRMED', basis: 'EXECUTED' } }),
    finding({ id: 'F4', auditor_check: { result: 'CONFIRMED', basis: null } }),
    finding({ id: 'F7', auditor_check: { result: 'CONFIRMED', basis: 'SOURCE_CITATION' } }),
    finding({ id: 'F8', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
  ];
  const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: {} });
  assert.deepEqual(report.caveats.filter((c) => /confirmed by reading only/.test(c)), ['F2, F7: the seat ran it; the auditor confirmed by reading only']);
  assert.match(renderChat(report), /> Caveat: F2, F7: the seat ran it; the auditor confirmed by reading only/);
  assert.match(JSON.stringify(report), /F2, F7: the seat ran it/);
});

const webClaim = (id, basis, evidence) => lines(`## ${id} [AC-1] t`, 'Severity: LOW', `Basis: ${basis}`, 'Evidence strength: SUPPORTED', 'Evidence:', '```', evidence, '```', '');
const rebuttal = (id, action, evidence) => lines(`### ${id}`, `Claim: ${id}`, `Action: ${action}`, 'Basis: STATIC_TRACE', 'Evidence:', '```', evidence, '```', '');

test('certainty R6: CONCEDEs of a peer SOURCE_CITATION claim that cites a link, with no link of their own or saying the web fact was not re-checked, are counted per rebutting seat', () => {
  const aFile = lines('# A', '', webClaim('A1', 'SOURCE_CITATION', 'https://a.test/x'), webClaim('A2', 'SOURCE_CITATION', 'https://a.test/y'), webClaim('A3', 'STATIC_TRACE', 'x.mjs:1'),
    webClaim('A4', 'SOURCE_CITATION', 'https://a.test/z'), webClaim('A5', 'SOURCE_CITATION', 'https://a.test/w'), webClaim('A6', 'SOURCE_CITATION', 'docs/x.md:3 says so'), '## Rebuttals (from B) of A claims', '',
    rebuttal('A1', 'CONCEDE', 'agreed'), rebuttal('A2', 'CONCEDE', 'opened https://a.test/y: "quote"'), rebuttal('A3', 'CONCEDE', 'agreed'),
    rebuttal('A4', 'CONCEDE', 'Web fact not re-checked; https://a.test/z'), rebuttal('A5', 'DISPUTE', 'no'), rebuttal('A6', 'CONCEDE', 'agreed'));
  const bFile = lines('# B', '', webClaim('B1', 'SOURCE_CITATION', 'https://b.test'), '## Rebuttals (from A) of B claims', '', rebuttal('B1', 'CONCEDE', 'opened https://b.test, it says so'));
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: { A: '', B: '' }, rebuttalTexts: { A: aFile, B: bFile } });
  assert.deepEqual(report.caveats.filter((c) => /without opening the source/.test(c)), ['Seat B accepted 2 web-backed findings without opening the source']);
  assert.match(renderChat(report), /> Caveat: Seat B accepted 2 web-backed findings without opening the source/);
  assert.match(JSON.stringify(report), /Seat B accepted 2 web-backed findings/);
});

test('certainty R6: loadRun reads the rebuttals from phase1/<seat>-findings.md while the seat checks come from phase1/original/', async (t) => {
  const dir = await makeRun(t);
  await fs.mkdir(path.join(dir, 'phase1', 'original'), { recursive: true });
  const aOwn = lines('# A', '', webClaim('A1', 'SOURCE_CITATION', 'https://a.test/x'), '## Checks performed', '- NOT CHECKED: the Mac path (no Mac)');
  await fs.writeFile(path.join(dir, 'phase1', 'original', 'A-findings.md'), aOwn);
  await fs.writeFile(path.join(dir, 'phase1', 'original', 'B-findings.md'), SEAT_B);
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), `${aOwn}\n## Rebuttals (from B) of A claims\n\n${rebuttal('A1', 'CONCEDE', 'agreed')}`);
  const report = await loadRun(dir);
  assert.ok(report.caveats.includes('Seat B accepted 1 web-backed finding without opening the source'), report.caveats.join('\n'));
  assert.ok(report.caveats.includes('Checks not done — seat A: the Mac path (no Mac)'));
});

test('certainty verify fixes F1: words describing the reviewed code are not a gap on a MET line or a verdict-less line; the hypothesis caveat needs a refuted or split row', () => {
  const packet = lines(...Array.from({ length: 6 }, (_, i) => `- [AC-${i + 1}] c`), '- [H1] h', '- [H2] h');
  const seatA = lines('# A', '', '## A1 t', 'Severity: LOW', '', '## Checks performed',
    '- AC-1: web budget enforcement stops the seat at 10 fetches (x.mjs:4). MET', '- AC-2: we did not run into a timeout (x.mjs:5). MET',
    '- AC-3: tests were not rerun by the cache layer (x.mjs:6). MET', '- AC-4: the guard rejects items: not checked ones are dropped (x.mjs:7). MET',
    '- AC-5: the "not done" state is shown for `skipped` tasks (x.mjs:8)', '- AC-6: the parser marks rows untested.flag (x.mjs:9)',
    '- H1: the retry cannot loop forever (x.mjs:10). CONFIRMED', '- H2: a path that cannot be read logs an error (x.mjs:11)');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r]));
  assert.deepEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'].map((t) => by[t].doubt), [[], [], [], [], [], []], report.criteria.rows.map((r) => `${r.tag} ${r.doubt}`).join('\n'));
  assert.equal(report.caveats.filter((c) => /said its check was incomplete/.test(c)).length, 0, report.caveats.join('\n'));
  const own = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith(['- AC-1: x.mjs:4; NOT CHECKED: the suite. MET', '- AC-2: x.mjs:5 (web budget spent). MET']), B: '' } });
  assert.deepEqual(own.criteria.rows.filter((r) => ['AC-1', 'AC-2'].includes(r.tag)).map((r) => r.doubt), [['A'], ['A']]);
  const prose = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith(['- AC-1: x.mjs:4; I did not run the suite. MET', '- AC-2: x.mjs:5 (web budget reached). MET']), B: '' } });
  assert.deepEqual(prose.criteria.rows.filter((r) => ['AC-1', 'AC-2'].includes(r.tag)).map((r) => r.doubt), [[], []], 'a gap in other words is not marked, by design');
  const quoted = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith(['- AC-1: the log says `web budget spent` and stops (x.mjs:4). MET', '- AC-2: prints "I did not run the suite" (x.mjs:5). MET']), B: '' } });
  assert.deepEqual(quoted.criteria.rows.filter((r) => ['AC-1', 'AC-2'].includes(r.tag)).map((r) => r.doubt), [[], []]);
});

test('certainty verify fixes F2: an uppercase NOT CHECKED in a second sentence or after a comma on a MET line is the seat\'s own gap; other words are not', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- AC-1: MET on Windows (x.mjs:3). NOT CHECKED (no Linux box)', '- AC-2: x.mjs:4 holds, NOT CHECKED: Python 3.9. MET', '- AC-3: x.mjs:5 holds; NOT CHECKED (no Mac). MET',
  ]), B: '' } });
  assert.deepEqual(report.criteria.rows.map((r) => r.doubt), [['A'], ['A'], ['A']]);
  const prose = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- AC-1: MET on Windows (x.mjs:3). Not checked on Linux.', '- AC-2: x.mjs:4 holds, not checked for Python 3.9. MET', '- AC-3: x.mjs:5 holds; Mac skipped (no box). MET',
  ]), B: '' } });
  assert.deepEqual(prose.criteria.rows.map((r) => r.doubt), [[], [], []], 'a gap in other words is not marked, by design');
});

test('certainty verify fixes F3, F7: a plural line range, an extensionless file and a dotfile with a line number are anchors', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c', '- [AC-4] d');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- AC-1: about lines 336-352 do it. MET', '- AC-2: README:12 says so. MET', '- AC-3: .gitignore:12 excludes it. MET', '- AC-4: looked fine. MET',
  ]), B: '' } });
  assert.deepEqual(report.criteria.passes.A, { passes: 4, bare: 1 });
});

test('certainty verify fixes F4, F5: tag-first NOT CHECKED, plus bullets and task boxes are skips, listed with their tag', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c', '- [AC-4] d');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith([
    '- AC-2: NOT CHECKED (no box)', '+ NOT CHECKED: AC-3 on Mac', '- [ ] NOT CHECKED: AC-4 timing', '- **AC-1**: **NOT CHECKED** (no key)',
  ]), B: '' } });
  assert.deepEqual(report.criteria.rows.map((r) => r.status), ['not-verified', 'not-verified', 'not-verified', 'not-verified']);
  assert.ok(report.caveats.includes('Checks not done — seat A: AC-2 (no box); AC-3 on Mac; AC-4 timing; AC-1 (no key)'), report.caveats.join('\n'));
});

test('certainty verify fixes F6: a link in a Tried or Suggested fix field is not the claim\'s or the concede\'s evidence', () => {
  const claim = lines('## A1 [AC-1] t', 'Severity: LOW', 'Basis: SOURCE_CITATION', 'Evidence:', '```', 'docs/x.md:3 says so', '```', 'Suggested fix: see https://a.test/fix', '');
  const webOnly = lines('## A2 [AC-1] t', 'Severity: LOW', 'Basis: SOURCE_CITATION', 'Evidence:', '```', 'https://a.test/x', '```', '');
  const reb = lines('### A2', 'Claim: A2', 'Action: CONCEDE', 'Basis: STATIC_TRACE', 'Evidence:', '```', 'agreed', '```', 'Tried: https://a.test/x', '');
  const aFile = lines('# A', '', claim, webOnly, '## Rebuttals (from B) of A claims', '', rebuttal('A1', 'CONCEDE', 'agreed'), reb);
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: { A: '', B: '' }, rebuttalTexts: { A: aFile, B: '' } });
  assert.deepEqual(report.caveats.filter((c) => /without opening the source/.test(c)), ['Seat B accepted 1 web-backed finding without opening the source']);
});

test('live run 2b: an UNMET criterion line names the worst final severity of its findings; a CRITERION line names none', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-3] three', '- [AC-4] four', '- [AC-5] five');
  const seatA = lines('# A', '', '## A1 [AC-4] Fourth fails', 'Severity: MEDIUM', '', '## A2 [AC-5] Fifth fails', 'Severity: LOW', '', '## A3 [AC-5] Fifth fails too', 'Severity: MEDIUM', '', '## A4 [AC-3] Third', 'Severity: LOW', '',
    '## Checks performed', '- AC-4 NOT MET: one case fails (x.mjs:3)', '- AC-5 NOT MET: two cases fail (x.mjs:4)', '- AC-3 MET: ok (x.mjs:5)');
  const findings = [
    finding({ id: 'F3', origins: ['A1'], severity: 'MEDIUM', severity_audited: 'LOW' }),
    finding({ id: 'F4', origins: ['A2'], severity: 'LOW' }),
    finding({ id: 'F5', origins: ['A3'], severity: 'MEDIUM' }),
    finding({ id: 'F6', origins: ['A4'], severity: 'LOW' }),
  ];
  const out = renderChat(buildReport({ findingsDoc: { findings }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: SEAT_B } }));
  assert.match(out, /^- UNMET {8}AC-4 {2}findings F3 \(LOW\)$/m, out);
  assert.match(out, /^- UNMET {8}AC-5 {2}findings F4 F5 \(MEDIUM\)$/m, out);
  assert.match(out, /^- CRITERION {4}AC-3 {2}findings F6$/m, out);
});

test('live run 2c: under the split-hypothesis caveat the full report prints each seat\'s own line, cut to 200 characters; the short chat does not', () => {
  const packet = lines('- [H1] One.', '- [H2] Two.');
  const long = `- H2: confirmed at x.mjs:9 ${'because the path is reachable '.repeat(10)}`;
  const seatA = lines('## Checks performed', '- H1: disproved at x.mjs:4, the guard returns early. REFUTED', long);
  const seatB = lines('## Checks performed', '- H1: confirmed by running node t.mjs, it throws.', '- H2: confirmed.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  const caveat = "H1: the seats disagree; the auditor rules on findings, not hypotheses, so no one decided between them: read both seats' lines for it.";
  assert.ok(report.caveats.includes(caveat), report.caveats.join('\n'));
  assert.deepEqual(Object.keys(report.criteria.rows.find((r) => r.tag === 'H1').seatLines), ['A', 'B']);
  assert.equal('seatLines' in report.criteria.rows.find((r) => r.tag === 'H2'), false, 'only a split row carries its lines');
  const text = renderText(report);
  assert.ok(text.includes(`  - ${caveat}\n      H1, seat A: H1: disproved at x.mjs:4, the guard returns early. REFUTED\n      H1, seat B: H1: confirmed by running node t.mjs, it throws.\n`), text);
  const md = renderMarkdown(report);
  assert.ok(md.includes(`- ${caveat}\n  - H1, seat A: H1: disproved at x.mjs:4, the guard returns early. REFUTED\n  - H1, seat B: `), md);
  assert.match(renderChat(report, { all: true }), /\n {2}- H1, seat B: H1: confirmed by running node t\.mjs, it throws\.\n/);
  assert.doesNotMatch(renderChat(report), /H1, seat [AB]:/, 'the short chat keeps only the caveat');
  assert.match(renderChat(report), /> Caveat: H1: the seats disagree/);
  const cut = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: lines('## Checks performed', '- H2: disproved. REFUTED') } });
  const cutLine = renderText(cut).split('\n').find((l) => l.startsWith('      H2, seat A: '));
  assert.ok(cutLine.endsWith('...') && cutLine.length <= '      H2, seat A: '.length + 200 && cutLine.length > '      H2, seat A: '.length + 190, cutLine);
});

test('certainty 3: a standing HIGH or CRITICAL finding that neither the seat nor the auditor ran gets a caveat', () => {
  const findings = [
    finding({ id: 'F2', severity: 'HIGH', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
    finding({ id: 'F5', severity: 'MEDIUM', severity_audited: 'CRITICAL', basis: 'SOURCE_CITATION', auditor_check: { result: 'CONFIRMED' } }),
    finding({ id: 'F6', severity: 'HIGH', basis: 'EXECUTED', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
    finding({ id: 'F7', severity: 'HIGH', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'EXECUTED' } }),
    finding({ id: 'F8', severity: 'LOW', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
    finding({ id: 'F9', severity: 'HIGH', severity_audited: 'MEDIUM', basis: 'STATIC_TRACE' }),
    finding({ id: 'F10', severity: 'CRITICAL', basis: 'STATIC_TRACE', final_state: 'settled-refuted', auditor_check: { result: 'REFUTED', basis: 'STATIC_TRACE' } }),
    finding({ id: 'F11', severity: 'HIGH', basis: 'STATIC_TRACE', final_state: 'dropped-speculative' }),
  ];
  const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: {} });
  assert.deepEqual(report.caveats.filter((c) => /no one ran it/.test(c)), ['F2, F5: HIGH or CRITICAL, but no one ran it (read only)']);
  assert.match(renderChat(report), /> Caveat: F2, F5: HIGH or CRITICAL, but no one ran it \(read only\)/);
  const none = buildReport({ findingsDoc: { findings: findings.slice(2) }, manifest: MANIFEST, seatTexts: {} });
  assert.equal(none.caveats.filter((c) => /no one ran it/.test(c)).length, 0);
});

test('certainty gap 7: an agreed finding the auditor could not check, in a full audit only', () => {
  const findings = [
    finding({ id: 'F1', auditor_check: { result: 'NOT_CHECKED' } }), finding({ id: 'F2', auditor_check: { result: 'CONFIRMED' } }),
    finding({ id: 'F3', final_state: 'unresolved-disputed', auditor_check: { result: 'NOT_CHECKED' } }), finding({ id: 'F4', auditor_check: undefined }),
    finding({ id: 'F5', final_state: 'settled-refuted', auditor_check: { result: 'NOT_CHECKED' } }),
  ];
  const full = buildReport({ findingsDoc: { audit_depth: 'full', findings }, manifest: MANIFEST, seatTexts: {} });
  assert.deepEqual(full.caveats.filter((c) => /could not check/.test(c)), ['F1: both seats agreed, but the auditor could not check it']);
  const light = buildReport({ findingsDoc: { audit_depth: 'light', findings }, manifest: MANIFEST, seatTexts: {} });
  assert.equal(light.caveats.filter((c) => /could not check/.test(c)).length, 0, 'a light audit skips agreed claims by design');
});

test('r1 F2, F10: fingerprint-files.json lists only changed files, so no caveat names an unchanged, absolute, UNC or host:port citation', async (t) => {
  const dir = await makeRun(t);
  const findings = [
    finding({ id: 'F1', evidence: ['src/caller.py:40 calls parse() without a guard'] }), finding({ id: 'F2', evidence: ['the service connects to db.internal.net:5432 and times out'] }),
    finding({ id: 'F3', evidence: ['src/parser.py:12 drops the check'] }), finding({ id: 'F4', evidence: ['/outside/repo/missing.py:12'] }), finding({ id: 'F5', evidence: ['\\\\server\\share\\missing.py:12'] }),
  ];
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify({ audit_depth: 'full', findings }));
  await fs.writeFile(path.join(dir, 'fingerprint-files.json'), JSON.stringify({ head: 'a'.repeat(40), files: { 'src/parser.py': 'x' } }));
  const report = await loadRun(dir);
  assert.equal(report.caveats.filter((c) => /reviewed files/.test(c)).length, 0, report.caveats.join('\n'));
});

// One seat line per report: the row of its tag and the report's caveats.
const r1Row = (line, tag = 'AC-1') => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b', '- [H1] h'), seatTexts: { A: seatWith([line]), B: '' } });
  return { row: report.criteria.rows.find((r) => r.tag === tag), report };
};

test('r1 F1: words describing the reviewed code are not a gap: skipped (why), tests not rerun, not checked for ... by, web budget, untested, not done, NOT CHECKED by', () => {
  const code = [
    '- AC-1: x.mjs:5 marks the task skipped (reason logged). MET', '- AC-1: tests not rerun because of a cache hit is the expected path (x.mjs:5). MET',
    '- AC-1: the test was not rerun after a cache hit, by design (x.mjs:5). MET', '- AC-1: x.mjs:5, not checked for nulls by the caller but guarded inside. MET',
    '- AC-1: the web budget ran out at x.mjs:4 when the counter overflows. MET', "- AC-1: the seat's web budget exhausted check works (x.mjs:4). MET",
    '- AC-1: untested branches fall back to the default (x.mjs:8)', '- AC-1: steps not done are listed in the summary (x.mjs:8)',
    '- AC-1: cache.js:8 handles (web budget 10) without errors. MET', '- AC-1: cache.js:8 tests were not rerun by the worker',
  ];
  for (const l of code) assert.deepEqual(r1Row(l).row.doubt, [], l);
  assert.deepEqual(r1Row('- AC-1: jobs that are not run get retried by the scheduler (x.mjs:8)').row.doubt, ['A'], 'a verdict-less line keeps the 1.2.0 word list');
  const hyp = r1Row('- H1: a step skipped (by flag) is logged at x.mjs:8. REFUTED', 'H1');
  assert.deepEqual([hyp.row.verdict, hyp.row.doubt], ['refuted', []]);
  assert.equal(hyp.report.caveats.filter((c) => /said its check was incomplete/.test(c)).length, 0);
  const byTool = r1Row('- AC-1: NOT CHECKED by the cache layer (cache.js:8). MET');
  assert.deepEqual([byTool.row.status, byTool.row.met, byTool.report.criteria.criteriaStats.met], ['clean', 'MET', 1]);
  assert.equal(byTool.report.caveats.filter((c) => /Checks not done/.test(c)).length, 0);
  const own = ['- AC-1: x.mjs:5 holds; NOT CHECKED (no Mac). MET', '- AC-1: ran `node x.mjs`; NOT CHECKED: the suite. MET', '- AC-1: x.mjs:4 holds, NOT CHECKED: Python 3.9. MET',
    '- AC-1: x.mjs:5 (web budget spent). MET', '- AC-1: could not run it here'];
  for (const l of own) assert.deepEqual(r1Row(l).row.doubt, ['A'], l);
  const prose = ['- AC-1: x.mjs:5 holds; Mac skipped (no box). MET', '- AC-1: ran `node x.mjs`; suite not rerun. MET', '- AC-1: x.mjs:4 holds, not checked for Python 3.9. MET',
    '- AC-1: x.mjs:5 (web budget reached). MET', '- AC-1: x.mjs:5; web budget spent. MET', '- AC-1: untested here', '- AC-1: tests not rerun (no node)', '- AC-1: Not checked on Linux; Windows ok (x.mjs:3). MET'];
  for (const l of prose) assert.deepEqual(r1Row(l).row.doubt, [], `not one of the markers, by design: ${l}`);
  assert.deepEqual(r1Row('- AC-1: NOT CHECKED (no box)').row.status, 'not-verified');
});

test('r1 F3, F9: a bracketed tag, a tag with no separator, a table row and a hypothesis tag before NOT CHECKED are skips', () => {
  const skips = [['- [AC-1] NOT CHECKED: no box', 'AC-1', 'AC-1 no box'], ['- AC-1 NOT CHECKED (no box)', 'AC-1', 'AC-1 (no box)'], ['| AC-1 | NOT CHECKED | no box |', 'AC-1', 'AC-1 no box'],
    ['- H1: NOT CHECKED (no box)', 'H1', 'H1 (no box)'], ['- [H1] NOT CHECKED (no box)', 'H1', 'H1 (no box)'], ['+ H1: NOT CHECKED (no box)', 'H1', 'H1 (no box)'], ['- [ ] H1: NOT CHECKED (no box)', 'H1', 'H1 (no box)']];
  for (const [l, tag, what] of skips) {
    const { row, report } = r1Row(l, tag);
    assert.equal(notCheckedLine(l), true, l);
    assert.equal(row.status, 'not-verified', l);
    assert.ok(report.caveats.includes(`Checks not done — seat A: ${what}`), `${l}\n${report.caveats.join('\n')}`);
    assert.deepEqual(report.criteria.silentSeats, [], l);
  }
  for (const l of ['- AC-1: items NOT CHECKED by the tool are rejected (x.mjs:4). MET', '- H1: x.mjs:4 has no NOT CHECKED state. REFUTED', '| AC-1 | MET | x.mjs:3 |']) assert.equal(notCheckedLine(l), false, l);
});

test('r1 F4: a seat\'s own gap in other words on a pass line is not marked (closed list); the NOT CHECKED clause is, also on a refuted hypothesis', () => {
  const prose = ['- AC-1: x.mjs:3 holds. Could not run the suite (no node). MET', '- AC-1: x.mjs:3 holds; tests not run (no node). MET', '- AC-1: x.mjs:3 holds; Linux path untested. MET',
    '- AC-1: x.mjs:3 read only, not executed. MET', "- AC-1: MET by reading x.mjs:3; I couldn't run it."];
  for (const l of prose) assert.deepEqual(r1Row(l).row.doubt, [], l);
  assert.deepEqual(r1Row('- H1: x.mjs:3 guards it; could not reproduce on Linux (no box). REFUTED', 'H1').row.doubt, []);
  const hyp = r1Row('- H1: x.mjs:3 guards it; NOT CHECKED: Linux (no box). REFUTED', 'H1');
  assert.deepEqual(hyp.row.doubt, ['A']);
  assert.ok(hyp.report.caveats.includes('H1: seat A said its check was incomplete'), hyp.report.caveats.join('\n'));
  const code = ['- AC-1: a seat cannot write outside its folder (y.mjs:3). MET', '- AC-1: untested inputs are rejected with exit 1 (x.mjs:9). MET', '- AC-1: the retry cannot loop forever (x.mjs:10). MET',
    '- AC-1: we did not run into a timeout (x.mjs:5). MET', '- AC-1: the hook could not run twice (x.mjs:3). MET', '- AC-1: x.mjs:3 marks jobs not run as failed. MET'];
  for (const l of code) assert.deepEqual(r1Row(l).row.doubt, [], l);
});

test('r1 F5: a Windows drive path, a quoted path, a path right after the tag colon and "file L12" are citations', () => {
  for (const l of ['- AC-1: C:\\repo\\src\\x.mjs:12 sets it. MET', '- AC-1: "x.mjs:12" sets it. MET', '- AC-1:x.mjs:12. MET', '- AC-1: x.mjs L12 sets it. MET']) {
    assert.deepEqual(r1Row(l).report.criteria.passes.A, { passes: 1, bare: 0 }, l);
  }
  for (const l of ['- AC-1: looked fine. MET', '- AC-1: checked at 10:30, fine. MET', '- AC-1: see L12. MET', '- `AC-1:` read it. MET']) {
    assert.deepEqual(r1Row(l).report.criteria.passes.A, { passes: 1, bare: 1 }, l);
  }
});

test('r1 F6: rows that change against 1.2.0 on purpose: a skip-only seat, a quoted "could not"; a verdict-less "untested here" stays as in 1.2.0', () => {
  const packet = lines('- [AC-1] a', '- [AC-2] b', '- [AC-3] c');
  const skip = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith(['- NOT CHECKED: AC-1 on Linux (no box)', '- AC-2: x.mjs:3. MET', '- AC-3: x.mjs:4. MET']), B: '' } });
  assert.deepEqual([skip.criteria.rows[0].status, skip.criteria.rows[0].seats], ['not-verified', []], 'was clean (A) in 1.2.0');
  const words = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatWith(['- AC-1: the `could not` branch logs (x.mjs:3)', '- AC-2: x.mjs:3. MET', '- AC-3: untested here']), B: '' } });
  assert.deepEqual(words.criteria.rows.map((r) => r.doubt), [[], [], []], 'AC-1 lost its 1.2.0 doubt mark; AC-3 has none, as in 1.2.0');
});

test('r1 F7: the Evidence field ends at its closing fence: a prose link after it is neither the claim\'s nor the concede\'s evidence', () => {
  const claimThen = (next) => lines('# A', '', webClaim('A1', 'SOURCE_CITATION', 'docs/x.md:3 says so').trimEnd(), next, '', '## Rebuttals (from B) of A claims', '', rebuttal('A1', 'CONCEDE', 'agreed'));
  assert.deepEqual(unopenedWebConcedes({ A: claimThen('see also https://a.test/blog for context') }), {});
  assert.deepEqual(unopenedWebConcedes({ A: claimThen('Background reading: https://a.test/blog') }), {});
  const concedeThen = lines('# A', '', webClaim('A1', 'SOURCE_CITATION', 'https://a.test/x'), '## Rebuttals (from B) of A claims', '', rebuttal('A1', 'CONCEDE', 'agreed').trimEnd(), 'see also https://a.test/x for context', '');
  assert.deepEqual(unopenedWebConcedes({ A: concedeThen }), { B: 1 });
  const twoFences = lines('# A', '', '## A1 [AC-1] t', 'Severity: LOW', 'Basis: SOURCE_CITATION', 'Evidence:', '```', 'docs/x.md:3', '```', '', '```', 'https://a.test/x', '```', '',
    '## Rebuttals (from B) of A claims', '', rebuttal('A1', 'CONCEDE', 'agreed'));
  assert.deepEqual(unopenedWebConcedes({ A: twoFences }), { B: 1 }, 'a second fence after a blank line is still Evidence');
});

// Round 2: the detectors that change a verdict or a doubt mark read only the closed list of exact formats.
const skipCaveat = (report) => report.caveats.find((c) => c.startsWith('Checks not done')) ?? null;

test('r2 closed list, skip form (a): uppercase NOT CHECKED after the list prefix, then ":", "(" or the line end', () => {
  for (const l of ['- NOT CHECKED: AC-1 on Linux (no box)', '* NOT CHECKED (no box): AC-1', '1. NOT CHECKED', '1) NOT CHECKED: AC-1 (no box)', '> NOT CHECKED: AC-1',
    '- [ ] NOT CHECKED: AC-1 timing', '**1.** NOT CHECKED: AC-1', '- **NOT CHECKED**: AC-1', '+ NOT CHECKED: AC-1', '| NOT CHECKED: AC-1 |', 'NOT CHECKED (no box)']) {
    assert.equal(notCheckedLine(l), true, l);
  }
  const { row, report } = r1Row('- NOT CHECKED: AC-1 on Linux (no box)');
  assert.deepEqual([row.status, skipCaveat(report)], ['not-verified', 'Checks not done — seat A: AC-1 on Linux (no box)']);
  for (const l of ['- NOT CHECKED-in files are listed', '- NOT CHECKED. AC-1', '- NOT CHECKED, AC-1', '- NOT CHECKED AC-1', '- Not checked: AC-1', '- not checked: AC-1',
    '- `NOT CHECKED`: AC-1', '`- NOT CHECKED: AC-1`', '- NOT CHECKED: AC-1 holds. MET', '- NOT CHECKED: AC-1 PARTIAL', '- NOT CHECKED: H1, REFUTED']) {
    assert.equal(notCheckedLine(l), false, l);
  }
});

test('r2 closed list, skip form (b): a tag, an optional ":", "-", en dash, em dash or "|", then uppercase NOT CHECKED and the end, ":", "(", ".", ";" or "|"', () => {
  const skips = ['- AC-1: NOT CHECKED', '- AC-1 - NOT CHECKED (no box)', '- AC-1 – NOT CHECKED: no box', '- AC-1 — NOT CHECKED. no box', '| AC-1 | NOT CHECKED | no box |',
    '- AC-1 NOT CHECKED; no box', '- [AC-1] NOT CHECKED: no box', '- **AC-1**: **NOT CHECKED** (no key)', '- `AC-1`: NOT CHECKED (no box)', '1. AC-1: NOT CHECKED (no box)',
    '- [ ] AC-1: NOT CHECKED (no box)', '> AC-1: NOT CHECKED (no box)'];
  for (const l of skips) {
    const { row, report } = r1Row(l);
    assert.equal(notCheckedLine(l), true, l);
    assert.equal(row.status, 'not-verified', l);
    assert.ok(skipCaveat(report)?.startsWith('Checks not done — seat A: AC-1'), `${l}\n${report.caveats.join('\n')}`);
  }
  const hyp = r1Row('- H1: NOT CHECKED (no box)', 'H1');
  assert.deepEqual([hyp.row.status, skipCaveat(hyp.report)], ['not-verified', 'Checks not done — seat A: H1 (no box)']);
  for (const l of ['- AC-1: NOT CHECKED, see below', '- AC-1: NOT CHECKED-in files are skipped', '- AC-1: NOT CHECKED by the tool', '- AC-1: NOT CHECKED (no box). MET',
    '- AC-1 | done | NOT CHECKED |', '- h1: NOT CHECKED (no box)', '- AC1: NOT CHECKED (no box)']) {
    assert.equal(notCheckedLine(l), false, l);
  }
});

test('r2 F1, F2: a backticked NOT CHECKED after the tag, a line with its own verdict and a lowercase or sentence-case line start are not skips', () => {
  for (const [l, tag, verdict] of [['- AC-1: `NOT CHECKED` (x.mjs:4) is displayed for skipped jobs. MET', 'AC-1', 'MET'], ['- H1: `NOT CHECKED` (x.mjs:4) is displayed for skipped jobs. REFUTED', 'H1', 'refuted'],
    ['- Not checked-in files are ignored, so AC-1 holds (x.mjs:3). MET', 'AC-1', 'MET']]) {
    const { row, report } = r1Row(l, tag);
    assert.equal(notCheckedLine(l), false, l);
    assert.equal(row.status, 'clean', l);
    assert.equal(tag === 'H1' ? row.verdict : row.met, verdict, l);
    assert.equal(skipCaveat(report), null, l);
  }
  const counts = r1Row('- AC-1: `NOT CHECKED` (x.mjs:4) is displayed for skipped jobs. MET').report.criteria.criteriaStats;
  assert.deepEqual([counts.met, counts.notVerified], [1, 1], 'AC-1 MET; only the untouched AC-2 is not verified');
  for (const l of ['- AC-1: `NOT CHECKED` (x.mjs:4) is displayed', '- not checked: AC-1 on Linux', '- Not checked: AC-1 on Linux']) {
    assert.equal(notCheckedLine(l), false, l);
    assert.equal(r1Row(l).row.status, 'clean', l);
  }
});

test('r2 F10, by design: a sentence-case tag-first "Not checked" and a parenthesised tag are not skips; the line counts as a check with no verdict', () => {
  for (const l of ['- AC-1: Not checked (no box)', '- AC-1 — Not checked.', '- (AC-1) NOT CHECKED: no box']) {
    const { row, report } = r1Row(l);
    assert.equal(notCheckedLine(l), false, l);
    assert.deepEqual([row.status, row.met, row.doubt, row.seats], ['clean', null, [], ['A']], l);
    assert.equal(skipCaveat(report), null, l);
  }
});

test('r2 F3: code-describing "untested" and "skipped (...)" on pass lines are silent', () => {
  for (const l of ['- AC-1: x.mjs:4 renders skipped (no input) for empty jobs. MET', '- AC-1: x.mjs:4 labels branches untested (coverage absent). MET',
    '- AC-1: rows are untested, flagged and logged (x.mjs:3). MET', '- AC-1: an empty list is skipped (no rows) by design (x.mjs:3). MET']) {
    assert.deepEqual(r1Row(l).row.doubt, [], l);
  }
  const hyp = r1Row('- H1: rows are untested, flagged and logged (x.mjs:3). REFUTED', 'H1');
  assert.deepEqual([hyp.row.verdict, hyp.row.doubt], ['refuted', []]);
  assert.equal(hyp.report.caveats.filter((c) => /said its check was incomplete/.test(c)).length, 0);
});

test('r2 F4, by design: an own gap in other words on a pass line is not marked; a verdict-less line keeps the 1.2.0 word list', () => {
  for (const l of ['- AC-1: x.mjs:4 holds. Not run on Linux because no box was available. MET', '- AC-1: x.mjs:4 holds; web budget ran out at ten fetches. MET',
    '- AC-1: x.mjs:4 holds. I did not re-run the suite. MET', '- AC-1: x.mjs:4 holds. Tests were not rerun by me. MET', '- AC-1: x.mjs:3 holds. Not tested on macOS. MET',
    '- AC-1: MET on Windows (x.mjs:3). Linux NOT CHECKED (no box).', '- AC-1: MET (x.mjs:3); the Linux path was skipped: no box.', '- AC-1: MET (x.mjs:3). Skipped Linux, no box.']) {
    assert.deepEqual(r1Row(l).row.doubt, [], l);
  }
  assert.deepEqual(r1Row('- AC-1: the Linux branch was not run because no box').row.doubt, ['A'], '"not run" is a 1.2.0 word');
  assert.deepEqual(r1Row('- AC-1: the Linux branch is untested here').row.doubt, [], '"untested" is not');
});

test('r2 closed list, own gap (a): uppercase NOT CHECKED after ";", ".", ",", or a dash, then ":", "(" or the end, outside backticks', () => {
  for (const l of ['- AC-1: x.mjs:3 holds; NOT CHECKED: Linux. MET', '- AC-1: MET (x.mjs:3). NOT CHECKED (no Linux box)', '- AC-1: MET at x.mjs:3, NOT CHECKED',
    '- AC-1: MET at x.mjs:3 - NOT CHECKED (Linux)', '- AC-1: MET at x.mjs:3 – NOT CHECKED: Linux', '- AC-1: MET at x.mjs:3 — NOT CHECKED']) {
    assert.deepEqual(r1Row(l).row.doubt, ['A'], l);
  }
  for (const l of ['- AC-1: MET at x.mjs:3; Linux NOT CHECKED (no box)', '- AC-1: x.mjs:3 prints `; NOT CHECKED:` for skips. MET', '- AC-1: x.mjs:3 holds; not checked: Linux. MET',
    '- AC-1: x.mjs:3 holds; NOT CHECKED by the tool. MET', '- AC-1: x.mjs:3 holds; NOT CHECKED. MET', '- AC-1: NOT CHECKED: Linux; x.mjs:3 holds. MET']) {
    assert.deepEqual(r1Row(l).row.doubt, [], l);
  }
  const hyp = r1Row('- H1: no such path in x.mjs:4. NOT CHECKED: Linux. REFUTED', 'H1');
  assert.ok(hyp.report.caveats.includes('H1: seat A said its check was incomplete'), hyp.report.caveats.join('\n'));
});

test('r2 closed list, own gap (b): a bracket naming the web budget as spent, in any case', () => {
  for (const b of ['(web budget spent)', '(Web budget used up)', '(WEB BUDGET EXHAUSTED)', '(web budget ran out)', '(out of web budget)']) {
    assert.deepEqual(r1Row(`- AC-1: x.mjs:3 holds ${b}. MET`).row.doubt, ['A'], b);
  }
  for (const b of ['(web budget reached)', '(web budget 10)', '(no web budget)', 'web budget spent', '`(web budget spent)`', '(the web budget spent check)']) {
    assert.deepEqual(r1Row(`- AC-1: x.mjs:3 holds ${b}. MET`).row.doubt, [], b);
  }
});

test('r2 F5: a HIGH finding a falsification verifier ran (verifications[].basis EXECUTED) is not "no one ran it"', () => {
  const findings = [
    finding({ id: 'F1', severity: 'HIGH', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' }, verifications: [{ claim: 'B7', verdict: 'CONFIRMED', basis: 'EXECUTED', evidence: 'ran it' }] }),
    finding({ id: 'F2', severity: 'HIGH', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' }, verifications: [{ claim: 'B8', verdict: 'CONFIRMED', basis: 'STATIC_TRACE', evidence: 'read it' }] }),
    finding({ id: 'F3', severity: 'CRITICAL', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' }, verifications: [{ claim: 'B9', verdict: 'CONFIRMED', basis: 'STATIC_TRACE' }, { claim: 'B9', verdict: 'CONFIRMED', basis: 'EXECUTED' }] }),
    finding({ id: 'F4', severity: 'HIGH', basis: 'STATIC_TRACE', auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE' } }),
  ];
  const report = buildReport({ findingsDoc: { findings }, manifest: MANIFEST, seatTexts: {} });
  assert.deepEqual(report.caveats.filter((c) => /no one ran it/.test(c)), ['F2, F4: HIGH or CRITICAL, but no one ran it (read only)']);
});

const bare = (l, findings = []) => buildReport({ findingsDoc: { findings }, manifest: MANIFEST, packetText: lines('- [AC-1] a', '- [AC-2] b'), seatTexts: { A: seatWith([l]), B: '' } }).criteria.passes.A;

test('r2 F7: :L12, file(12), l. 12, ll. 3-9, a quote closed before :12 and a runner word before a file name are citations', () => {
  for (const l of ['- AC-1: ran node --test scripts/tests/x.test.mjs, 3 pass. MET', '- AC-1: x.mjs:L12 checks it. MET', '- AC-1: src/x.mjs(12) checks it. MET', '- AC-1: x.mjs, l. 12 checks it. MET',
    '- AC-1: x.mjs ll. 3-9 check it. MET', '- AC-1: "C:\\repo\\x.mjs":12 says so. MET', '- AC-1: pytest tests/test_x.py passes. MET', '- AC-1: Ran python tools/check.py, clean. MET',
    '- AC-1: cargo test --test x.rs passes. MET', '- AC-1: go test ./pkg/x_test.go passes. MET', '- AC-1: npm run lint -- src/a.ts is clean. MET']) {
    assert.deepEqual(bare(l), { passes: 1, bare: 0 }, l);
  }
  for (const l of ['- AC-1: ran it, fine. MET', '- AC-1: npm test passes. MET', '- AC-1: node is fine. MET', '- AC-1: see L12. MET', '- AC-1: all. 12 cases pass. MET']) {
    assert.deepEqual(bare(l), { passes: 1, bare: 1 }, l);
  }
});

test('r2 F8: name:N needs a dot or slash in the name or a known extensionless file; F<n> counts only as a finding ID of this report', () => {
  for (const l of ['- AC-1: the bench reports F1 per arm. MET', '- AC-1: the server listens on localhost:8080. MET', '- AC-1: AC-2:3 ok. MET', '- AC-1: from step:2 on it works. MET',
    '- AC-1: phase:1 ok. MET', '- AC-1: Note:1 nothing to say. MET', '- AC-1: covered by F3. MET']) {
    assert.deepEqual(bare(l), { passes: 1, bare: 1 }, l);
  }
  for (const name of ['README', 'makefile', 'Dockerfile', 'LICENSE', 'CHANGELOG', 'Justfile', 'Procfile', 'Gemfile', 'Rakefile', 'src/x', 'x.mjs', '.gitignore']) {
    assert.deepEqual(bare(`- AC-1: ${name}:12 says so. MET`), { passes: 1, bare: 0 }, name);
  }
  assert.deepEqual(bare('- AC-1: covered by F3. MET', [finding({ id: 'F3', origins: ['A9'] })]), { passes: 1, bare: 0 }, 'F3 is a finding of this report');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a'), seatTexts: { A: seatWith(['- AC-1: the bench reports F1 per arm. MET']), B: '' } });
  assert.ok(report.caveats.includes('Seat A: 1 of 1 MET or REFUTED check lines cite no file:line, backticked command, link, claim ID or finding ID the report could find'), report.caveats.join('\n'));
});

test('r3 F1: a gap marker inside double or single quotes on a pass line is quoted text, not the seat\'s own gap', () => {
  for (const l of ['- AC-1: the tool prints "done; NOT CHECKED: rest" on exit (x.mjs:4). MET', "- AC-1: the tool prints '(web budget spent)' on exit (x.mjs:4). MET",
    '- AC-1: prints "(web budget spent)" (x.mjs:4). MET', '- AC-1: the tool prints `done; NOT CHECKED: rest` on exit (x.mjs:4). MET']) {
    assert.deepEqual(r1Row(l).row.doubt, [], l);
  }
  const hyp = r1Row('- H1: the seat file prints "done; NOT CHECKED: rest" and x.mjs:4 parses it, no crash. REFUTED', 'H1');
  assert.equal(hyp.report.caveats.includes('H1: seat A said its check was incomplete'), false, hyp.report.caveats.join('\n'));
});

test('r3 F1 neighbours: an unquoted marker next to quoted text, or after an apostrophe, is still the seat\'s own gap', () => {
  for (const l of ['- AC-1: prints "ok" (x.mjs:4). NOT CHECKED: Linux. MET', "- AC-1: the seat's run passes (x.mjs:4); NOT CHECKED: Windows. MET",
    '- AC-1: x.mjs:3 holds "fine" (web budget spent). MET', "- AC-1: x.mjs:3 prints 'ok'; NOT CHECKED (no box). MET"]) {
    assert.deepEqual(r1Row(l).row.doubt, ['A'], l);
  }
  const hyp = r1Row('- H1: no such path in x.mjs:4 for "x". NOT CHECKED: Linux. REFUTED', 'H1');
  assert.ok(hyp.report.caveats.includes('H1: seat A said its check was incomplete'), hyp.report.caveats.join('\n'));
});

test('r3 F4: a dotted host and port and an F<n> score are not citations, also with a finding F1', () => {
  const f1 = [finding({ id: 'F1', origins: ['A9'] })];
  for (const l of ['- AC-1: the F1 score of the bench rises to 0.92. MET', '- AC-1: the F1-score of the bench rises. MET', '- AC-1: the F1 Score rises. MET','- AC-1: db.internal.net:5432 refuses. MET',
    '- AC-1: example.com:443 serves it. MET', '- AC-1: api.internal:8080 answers. MET', '- AC-1: v1.2:3 holds. MET']) {
    assert.deepEqual(bare(l, f1), { passes: 1, bare: 1 }, l);
  }
});

test('r3 F4 neighbours: file:line, a path, :L12 on a host-like name and a finding ID next to an F<n> score are still citations', () => {
  const f1 = [finding({ id: 'F1', origins: ['A9'] })];
  for (const l of ['- AC-1: x.mjs:12 checks it. MET', '- AC-1: .gitignore:12 lists it. MET', '- AC-1: src/x:12 says so. MET', '- AC-1: build-report.mjs:374 strips it. MET',
    '- AC-1: config.json:5 sets it. MET', '- AC-1: src/app.com:12 says so. MET', '- AC-1: example.com:L12 says so. MET', '- AC-1: covered by F1. MET',
    '- AC-1: F1 is fixed; the F1 score rose. MET']) {
    assert.deepEqual(bare(l, f1), { passes: 1, bare: 0 }, l);
  }
});

const r3Skip = (line) => buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-1] a'), seatTexts: { A: seatWith([line]), B: '' } }).caveats.find((c) => c.startsWith('Checks not done'));

test('r3 F5: a period or semicolon right after a tag-first NOT CHECKED is not part of what was not checked', () => {
  assert.equal(r3Skip('* AC-1 - NOT CHECKED.'), 'Checks not done — seat A: AC-1');
  assert.equal(r3Skip('- AC-1 — NOT CHECKED; no box'), 'Checks not done — seat A: AC-1 no box');
  assert.equal(r3Skip('- AC-1 — NOT CHECKED. no box'), 'Checks not done — seat A: AC-1 no box');
});

test('r3 F5 neighbours: a colon or bracket form and a dotfile name after NOT CHECKED keep their text', () => {
  assert.equal(r3Skip('- AC-1: NOT CHECKED (no box)'), 'Checks not done — seat A: AC-1 (no box)');
  assert.equal(r3Skip('- NOT CHECKED: .gitignore rules (no time)'), 'Checks not done — seat A: .gitignore rules (no time)');
  assert.equal(r3Skip('- AC-1: NOT CHECKED: .env loading (no box)'), 'Checks not done — seat A: AC-1 .env loading (no box)');
});

// Round 4.
const r4Concede = (...ev) => lines('# A', '', '## A1 [AC-1] t', 'Severity: LOW', 'Basis: SOURCE_CITATION', 'Evidence strength: SUPPORTED', 'Evidence:', '```', 'https://docs.example.org/x', '```', '',
  '## Rebuttals (from B) of A claims', '', '### A1', 'Claim: A1', 'Action: CONCEDE', 'Basis: STATIC_TRACE', 'Evidence:', ...ev, '');

test('r4 F3: an unfenced concede Evidence line that starts with a capitalised word and holds the link is still Evidence', () => {
  for (const l of ['Opened https://docs.example.org/x, it says Y', 'I opened https://docs.example.org/x and it says Y', 'Fetched the page https://docs.example.org/x; it says Y', 'See https://docs.example.org/x (section 2): it says Y']) {
    assert.deepEqual(unopenedWebConcedes({ A: r4Concede(l) }), {}, l);
  }
  const claimSide = lines('# A', '', '## A1 [AC-1] t', 'Severity: LOW', 'Basis: SOURCE_CITATION', 'Evidence strength: SUPPORTED', 'Evidence:', 'See https://docs.example.org/x: it says Y', '',
    '## Rebuttals (from B) of A claims', '', rebuttal('A1', 'CONCEDE', 'agreed'));
  assert.deepEqual(unopenedWebConcedes({ A: claimSide }), { B: 1 }, 'the claim side reads the same unfenced link, so the bare concede is counted');
});

test('r4 F3 neighbours: a known field line still ends the Evidence field, and a fenced or lowercase link keeps its result', () => {
  assert.deepEqual(unopenedWebConcedes({ A: r4Concede('agreed, same reading', 'Suggested fix: see https://docs.example.org/x') }), { B: 1 }, 'a link after "Suggested fix:" is not the concede\'s evidence');
  assert.deepEqual(unopenedWebConcedes({ A: r4Concede('agreed', 'Action: CONCEDE https://docs.example.org/x') }), { B: 1 });
  assert.deepEqual(unopenedWebConcedes({ A: r4Concede('```', 'Opened https://docs.example.org/x, it says Y', '```') }), {});
  assert.deepEqual(unopenedWebConcedes({ A: r4Concede('opened https://docs.example.org/x, it says Y') }), {});
  assert.deepEqual(unopenedWebConcedes({ A: r4Concede('agreed') }), { B: 1 });
});

test('r4 F4: a number or task box then a bracketed tag, and a bold tag with the colon inside, are skip lines', () => {
  const cases = [['1. [AC-1] NOT CHECKED: no box', 'AC-1 no box'], ['1) [AC-1]: NOT CHECKED (no box)', 'AC-1 (no box)'], ['**1.** [AC-1] NOT CHECKED (no box)', 'AC-1 (no box)'],
    ['1. [ ] NOT CHECKED: AC-1', 'AC-1'], ['- [ ] [AC-1] NOT CHECKED (no box)', 'AC-1 (no box)'], ['- **AC-1:** NOT CHECKED (no box)', 'AC-1 (no box)'],
    ['- **[AC-1]:** NOT CHECKED (no box)', 'AC-1 (no box)'], ['1. **AC-1:** NOT CHECKED (no box)', 'AC-1 (no box)']];
  for (const [l, what] of cases) {
    assert.equal(notCheckedLine(l), true, l);
    const { row, report } = r1Row(l);
    assert.equal(row.status, 'not-verified', l);
    assert.equal(skipCaveat(report), `Checks not done — seat A: ${what}`, l);
  }
});

test('r4 F4 neighbours: the same leads with a verdict, lowercase or in backticks stay as they were', () => {
  for (const l of ['- [AC-1] NOT CHECKED: no box', '- **AC-1**: NOT CHECKED (no box)', '> [AC-1] NOT CHECKED: no box']) assert.equal(notCheckedLine(l), true, l);
  for (const l of ['1. [AC-1] x.mjs:3 holds. MET', '1. [ ] not checked: AC-1', '- **AC-1:** Not checked (no box)', '1. [AC-1] `NOT CHECKED`: no box', '- **AC-1:** NOT CHECKED: x.mjs:3 holds. MET']) {
    assert.equal(notCheckedLine(l), false, l);
  }
  const { row } = r1Row('1. [AC-1] x.mjs:3 holds. MET');
  assert.deepEqual([row.status, row.seats, row.met], ['clean', ['A'], 'MET']);
});

test('r4 F5: a gap marker or skip in a double-backtick code span is quoted code, not the seat\'s own gap or skip', () => {
  assert.deepEqual(r1Row('- AC-1: prints ``done; NOT CHECKED: rest`` (x.mjs:4). MET').row.doubt, []);
  assert.deepEqual(r1Row('- AC-1: prints ```done; (web budget spent)``` (x.mjs:4). MET').row.doubt, []);
  assert.equal(notCheckedLine('- ``NOT CHECKED: AC-1 (no box)``'), false);
  assert.equal(notCheckedLine('- AC-1: ``NOT CHECKED`` (no box)'), false);
  const { row } = r1Row('- ``NOT CHECKED: AC-1 (no box)``');
  assert.deepEqual(row.seats, ['A'], 'the quoted line still names AC-1, so it is not dropped as a skip');
});

test('r4 F5 neighbours: a marker outside the span, a single-backtick span and an unmatched backtick run keep their results', () => {
  assert.deepEqual(r1Row('- AC-1: prints ``x`` (x.mjs:4); NOT CHECKED: Linux. MET').row.doubt, ['A']);
  assert.deepEqual(r1Row('- AC-1: prints `done; NOT CHECKED: rest` (x.mjs:4). MET').row.doubt, []);
  assert.deepEqual(r1Row('- AC-1: x.mjs:3 holds; NOT CHECKED: Linux. MET').row.doubt, ['A']);
  assert.equal(notCheckedLine('- `NOT CHECKED: AC-1 (no box)`'), false);
  assert.equal(notCheckedLine('- ``a`` NOT CHECKED: AC-1 (no box)'), false, 'not one of the two forms: text before NOT CHECKED');
  assert.equal(notCheckedLine('- AC-1: NOT CHECKED (no box, see ``x``)'), true, 'a code span after the marker does not hide it');
});

test('r4 F6: a backtick span and a quote before :N count as citations, as the CHANGELOG now says; plain prose does not', () => {
  assert.deepEqual(bare('- AC-1: rejects `null` inputs. MET'), { passes: 1, bare: 0 });
  assert.deepEqual(bare('- AC-1: response contains {"count":2}. MET'), { passes: 1, bare: 0 });
  assert.deepEqual(bare('- AC-1: rejects null inputs. MET'), { passes: 1, bare: 1 });
  assert.deepEqual(bare('- AC-1: ran `npm test`, 3 pass. MET'), { passes: 1, bare: 0 }, 'a backticked command with no file name');
});

// Round 5.
const r5Criteria = (checks, packet = ['- [AC-1] a', '- [AC-2] b', '- Tickets: 6041 = AC-1, AC-2']) => buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines(...packet), seatTexts: { A: seatWith(checks), B: '' } }).criteria;
const r5Row = (c, tag = 'AC-1') => { const r = c.rows.find((x) => x.tag === tag); return { status: r.status, met: r.met, failedSeats: r.failedSeats, doubt: r.doubt, seats: r.seats }; };

test('r5 F3: a criterion skipped tag-first stays not verified next to a ticket line that names it; no verdict, fail word or pass comes from that line', () => {
  for (const skip of ['- AC-1: NOT CHECKED (no Linux box)', '- [AC-1] NOT CHECKED: no box', '- **AC-1:** NOT CHECKED (no box)',
    '+ AC-1: NOT CHECKED (no box)', '- [ ] [AC-1] NOT CHECKED (no box)', '- [x] AC-1: NOT CHECKED (no box)', '**1.** AC-1: NOT CHECKED (no box)']) {
    for (const ticket of ['- 6041: AC-2 MET; AC-1 open. NO GO', '- 6041: AC-1 fails on Linux per CI log, AC-2 met. NO GO', '- 6041: AC-1 and AC-2 met, live run done. GO']) {
      const c = r5Criteria([skip, '- AC-2: x.mjs:3 holds. MET', ticket]);
      assert.deepEqual(r5Row(c), { status: 'not-verified', met: null, failedSeats: [], doubt: [], seats: [] }, `${skip} + ${ticket}`);
      assert.deepEqual([c.criteriaStats.met, c.criteriaStats.notVerified, c.criteriaStats.failedClean], [1, 1, 0], ticket);
      assert.deepEqual(c.passes.A, { passes: 1, bare: 0 }, ticket);
      assert.equal(c.tickets[0].verdict, ticket.endsWith('NO GO') ? 'NO GO' : 'GO', 'the ticket line still gives the ticket verdict');
    }
  }
});

test('r6 F1: a hypothesis skipped tag-first with a plus bullet, task box or bold number takes no outcome from a line that mentions it', () => {
  for (const skip of ['- H1: NOT CHECKED (no box)', '+ H1: NOT CHECKED (no box)', '- [ ] [H1] NOT CHECKED (no box)', '- [x] H1: NOT CHECKED (no box)', '**1.** H1: NOT CHECKED (no box)']) {
    const c = r5Criteria([skip, '- H2: x.mjs:3 guards. REFUTED', '- Summary: H2 REFUTED; H1 open. REFUTED'], ['- [H1] x is broken', '- [H2] y is broken']);
    const r = c.rows.find((x) => x.tag === 'H1');
    assert.deepEqual([r.status, r.verdict, r.seats], ['not-verified', null, []], skip);
  }
  for (const own of ['+ H1: x.mjs:4 guards. REFUTED', '- [x] H1: x.mjs:4 guards. REFUTED', '**1.** H1: x.mjs:4 guards. REFUTED']) {
    const r = r5Criteria([own, '- Summary: H1 CONFIRMED'], ['- [H1] x is broken']).rows.find((x) => x.tag === 'H1');
    assert.deepEqual([r.status, r.verdict], ['clean', 'refuted'], `${own}: the tag's own line wins over a line that mentions it`);
  }
});

test('r6 F2: a slash-less dotfile or numbered file with :N is a citation; a host and port, an IPv4 address and port or a version stay bare', () => {
  for (const l of ['- AC-1 MET: .env.local:12 sets it', '- AC-1 MET: ls.1:12', '- AC-1 MET: app.log.1:40 shows it', '- AC-1 MET: .config.dev:3 sets it', '- AC-1 MET: config/.env.local:12']) {
    assert.deepEqual(bare(l), { passes: 1, bare: 0 }, l);
  }
  for (const l of ['- AC-1 MET: example.com:443 serves it', '- AC-1 MET: 10.0.0.1:8080 answers', '- AC-1 MET: localhost:3000 answers', '- AC-1 MET: v1.2:3 holds', '- AC-1 MET: api.internal:8080 answers']) {
    assert.deepEqual(bare(l), { passes: 1, bare: 1 }, l);
  }
});

test('r5 F3 neighbours: a ticket line alone still checks a tag, an own verdict line beside a skip still counts, and a skip for another tag does not block it', () => {
  assert.deepEqual(r5Row(r5Criteria(['- AC-2: x.mjs:3 holds. MET', '- 6041: AC-2 MET; AC-1 met per x.mjs:9. GO'])), { status: 'clean', met: 'MET', failedSeats: [], doubt: [], seats: ['A'] });
  assert.deepEqual(r5Row(r5Criteria(['- AC-1: NOT CHECKED (no Linux box)', '- AC-1: x.mjs:4 holds on Windows. MET', '- 6041: AC-1 open. NO GO'])), { status: 'clean', met: 'MET', failedSeats: [], doubt: [], seats: ['A'] });
  assert.deepEqual(r5Row(r5Criteria(['- AC-2: NOT CHECKED (no box)', '- 6041: AC-1 fails on Linux per CI log. NO GO'])), { status: 'clean', met: null, failedSeats: ['A'], doubt: [], seats: ['A'] });
  assert.equal(r5Row(r5Criteria(['- AC-2: NOT CHECKED (no box)', '- 6041: AC-1 fails on Linux per CI log. NO GO']), 'AC-2').status, 'not-verified');
});

test('r5 F1: a gap or failure word between two multi-backtick spans that hold a backtick is the seat\'s own; inside such a span it is code', () => {
  assert.deepEqual(r1Row('- AC-1: read ``left`name``; could not run Linux tests; checked ``right`name`` (x.mjs:4)').row.doubt, ['A']);
  assert.deepEqual(r1Row('- AC-1: read ``could not`` (x.mjs:4)').row.doubt, []);
  assert.deepEqual(r1Row('- AC-1: read ``a`b``; the build failed; checked ``c`d`` (x.mjs:4)').row.failedSeats, ['A']);
  assert.deepEqual(r1Row('- AC-1: read ``the build failed`` (x.mjs:4)').row.failedSeats, []);
});

test('r5 F1 neighbours: single-backtick spans, gap words outside code and an unmatched backtick keep their results', () => {
  assert.deepEqual(r1Row('- AC-1: read `could not` (x.mjs:4)').row.doubt, []);
  assert.deepEqual(r1Row('- AC-1: could not run `x` (x.mjs:4)').row.doubt, ['A']);
  assert.deepEqual(r1Row('- AC-1: could not run x` tests (x.mjs:4)').row.doubt, ['A']);
  assert.deepEqual(r1Row('- AC-1: read "could not" in x.mjs:4').row.doubt, []);
  assert.deepEqual(r1Row('- AC-1: the build failed (x.mjs:4)').row.failedSeats, ['A']);
  assert.deepEqual(r1Row('- AC-1: prints `build failed` (x.mjs:4)').row.failedSeats, []);
  assert.deepEqual(r1Row('- AC-1: the build failed` here (x.mjs:4)').row.failedSeats, ['A']);
});

test('r5 F4: the exact NOT CHECKED marker in * or _ emphasis is a skip and a pass line\'s own gap', () => {
  for (const l of ['- __NOT CHECKED__: AC-1 (no box)', '- _NOT CHECKED_: AC-1 (no box)', '- AC-1: _NOT CHECKED_ (no box)', '- AC-1: __NOT CHECKED__ (no box)', '- **NOT CHECKED**: AC-1 (no box)', '- AC-1: **NOT CHECKED** (no box)']) {
    assert.equal(notCheckedLine(l), true, l);
    const { row, report } = r1Row(l);
    assert.equal(row.status, 'not-verified', l);
    assert.equal(skipCaveat(report), 'Checks not done — seat A: AC-1 (no box)', l);
  }
  for (const l of ['- AC-1: x.mjs:3 holds; **NOT CHECKED**: Linux. MET', '- AC-1: x.mjs:3 holds; **NOT CHECKED:** Linux. MET', '- AC-1: x.mjs:3 holds. **NOT CHECKED** (no Mac). MET', '- AC-1: x.mjs:3 holds; _NOT CHECKED_: Linux. MET']) {
    assert.deepEqual(r1Row(l).row.doubt, ['A'], l);
  }
  assert.deepEqual(r1Row('- H1: x.mjs:3 guards; **NOT CHECKED**: Linux. REFUTED', 'H1').row.doubt, ['A']);
});

test('r5 F4 neighbours: emphasis does not widen the closed list: lowercase, "by", a hyphen, code spans and text between stay as they were', () => {
  for (const l of ['- _not checked_: AC-1', '- AC-1: _NOT CHECKED_ by the tool', '- AC-1: __NOT CHECKED__-in files', '- `_NOT CHECKED_`: AC-1', '- AC-1: _NOT CHECKED_ (no box). MET', '- _x_ NOT CHECKED: AC-1']) {
    assert.equal(notCheckedLine(l), false, l);
  }
  for (const l of ['- AC-1: x.mjs:3 holds; _NOT CHECKED_ by the tool. MET', '- AC-1: x.mjs:3 prints `; **NOT CHECKED**:` for skips. MET', '- AC-1: x.mjs:3 holds; Linux **NOT CHECKED** (no box). MET', '- AC-1: x.mjs:3 holds; _not checked_: Linux. MET']) {
    assert.deepEqual(r1Row(l).row.doubt, [], l);
  }
});
