import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  expandTagRange, parseArgs, isBlocker, shortTitle, compactTokens, seatCostRow, perCallNewInput, costTableLines, packetCriteria, criteriaGroup, buildCriteria, notesSections,
  parseOutcome, packetTicketMap, noteKinds, findingStatus, costNote, parseVerdict, buildTickets, groupFindings, renderChat, buildReport, renderText, renderMarkdown, renderHtml, loadRun, headingTags,
} from '../build-report.mjs';

const SCRIPT = fileURLToPath(new URL('../build-report.mjs', import.meta.url));
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
const SEAT_B = lines('# Seat B findings', '', '## No findings', '', '## Checks performed', '- H1: confirmed by static read.');

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
  assert.deepEqual(report.counts, { critical: 0, high: 1, medium: 0, low: 3, other: 0 });
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
  assert.equal(parseArgs(['--help']).help, true);
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
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
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
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir, '--out', out, '--html', html, '--json', json, '--color', 'always'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\x1b\[/);
  assert.match(await fs.readFile(out, 'utf8'), /^# Review report: COMPLETE/);
  assert.match(await fs.readFile(html, 'utf8'), /^<!doctype html>/);
  assert.equal(JSON.parse(await fs.readFile(json, 'utf8')).blockers[0], 'F1');
});

test('CLI: a run with no manifest says status and cost are unknown; a missing findings file is an error', async (t) => {
  const dir = await makeRun(t, { manifest: null });
  const report = await loadRun(dir);
  assert.equal(report.status, 'INCOMPLETE');
  assert.match(report.caveats[0], /manifest\.json was not found/);
  await fs.rm(path.join(dir, 'phase3', 'findings.json'));
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read findings/);
});

test('zero-claim run: with no findings.json and no claim in either seat file the report still prints the criteria; a claim without findings.json is still an error', async (t) => {
  const dir = await makeRun(t);
  await fs.rm(path.join(dir, 'phase3', 'findings.json'));
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), lines('# Seat A findings', '', '## No findings', '', '## Checks performed', '- [AC-6040-1]: ran it, no issue.', '- [AC-6040-2]: ran it, no issue.', '- [AC-6040-3]: ran it, no issue.'));
  const report = await loadRun(dir);
  assert.equal(report.total, 0);
  assert.equal(report.criteria.criteriaCount, 3);
  assert.equal(report.criteria.issue, 0);
  assert.equal(report.coverage.auditDepth, 'not run (no claims)');
  assert.equal(report.coverage.lightNote, null);
  assert.ok(report.caveats.some((c) => /Neither seat raised a claim, so no auditor ran/.test(c)));
  const text = renderText(report);
  assert.match(text, /No findings\./);
  assert.match(text, /AC-6040-2 +no issue found \(A\)/);
  assert.match(text, /Audit depth: not run \(no claims\)/);
  await fs.writeFile(path.join(dir, 'phase1', 'A-findings.md'), SEAT_A);
  await assert.rejects(loadRun(dir), /cannot read findings/);
  await fs.rm(path.join(dir, 'phase1', 'A-findings.md'));
  await assert.rejects(loadRun(dir), /cannot read findings/, 'a missing seat file is not a zero-claim run');
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
  const text = renderText(report);
  assert.match(text, /HYPOTHESES \(5\)  1 REFUTED \| 1 seats disagree \| 2 confirmed \| 1 outcome not parsed/);
  assert.match(text, /H2 +SPLIT: A refuted, B confirmed/);
  assert.match(text, /H3 +A outcome not parsed/);
  assert.match(renderMarkdown(report), /- Hypotheses: 1 REFUTED, 1 seats disagree, 2 confirmed, 1 outcome not parsed/);
  assert.match(renderHtml(report), /<span class="chip high">Refuted<\/span>/);
});

test('tag matching uses word boundaries: AC-6040-1 is not found inside AC-6040-10', () => {
  const packet = lines('- [AC-6040-1] One.', '- [AC-6040-10] Ten.');
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: lines('## Checks performed', '- [AC-6040-10]: ran it, no issue.'), B: '' } });
  const by = Object.fromEntries(report.criteria.rows.map((r) => [r.tag, r.status]));
  assert.deepEqual(by, { 'AC-6040-1': 'not-verified', 'AC-6040-10': 'clean' });
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
  const run = (args, env) => spawnSync(process.execPath, [SCRIPT, '--run-dir', dir, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '', ...env } });
  const esc = String.fromCharCode(27);
  assert.equal(run([], { FORCE_COLOR: '1' }).stdout.includes(esc), true, 'FORCE_COLOR=1 colours output that is not a terminal');
  assert.equal(run([], { FORCE_COLOR: '0' }).stdout.includes(esc), false, 'FORCE_COLOR=0 is off');
  assert.equal(run([], {}).stdout.includes(esc), false, 'captured output is plain by default');
  assert.equal(run([], { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout.includes(esc), false, 'NO_COLOR wins over FORCE_COLOR');
  assert.equal(run(['--color', 'never'], { FORCE_COLOR: '1' }).stdout.includes(esc), false, '--color never wins');
  assert.equal(run(['--color', 'always'], {}).stdout.includes(esc), true, '--color always colours captured output');
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
    '  HYPOTHESES   1 confirmed',
    '```',
  ];
  const out = renderChat(CHAT_FIXTURE());
  const lines = out.split(nl);
  assert.deepEqual(lines.slice(0, expected.length), expected);
  assert.match(out, /_Every finding, criterion and the cost: run with `--format chat --all`\._/);
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
  assert.match(renderChat(runs[2]), /- FIX NOW {6}\(\+7 more\)/, 'more than five blockers are counted, not listed');
  assert.match(renderChat(runs[3]), /^> Caveat: /m, 'the zero-claim caveat is kept');
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
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir, '--format', 'chat'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^> \*\*REVIEW COMPLETE/);
  assert.equal(r.stdout.includes(String.fromCharCode(27)), false);
  const all = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir, '--format', 'chat', '--all'], { encoding: 'utf8' });
  assert.match(all.stdout, /^## Cost/m);
  assert.throws(() => parseArgs(['--run-dir', 'x', '--all']), /--all is only used with --format chat/);
  assert.throws(() => parseArgs(['--run-dir', 'x', '--format', 'pdf']), /--format must be text or chat/);
});
test('chat: the banner blocker count is the report blocker count; decide items are named apart; odd ids stay within the line', () => {
  const decideOnly = renderChat(buildReport({ findingsDoc: { findings: [finding({ id: 'F2', severity: 'LOW', final_state: 'unresolved-high-stakes' })] }, manifest: MANIFEST }));
  assert.ok(decideOnly.includes('> **REVIEW COMPLETE '+String.fromCharCode(183)+' 1 blocker '+String.fromCharCode(183)+' 1 to decide (F2) '+String.fromCharCode(183)+' 1 finding**'), 'an unresolved-high-stakes finding is a blocker in every format');
  assert.match(decideOnly, /1 of 1 findings confirmed by the auditor; 1 unresolved \(not settled\)/);
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
  assert.ok(out.includes('> **REVIEW COMPLETE ' + String.fromCharCode(183) + ' 2 blockers (F2 marked in the report notes) ' + String.fromCharCode(183) + ' 1 to decide (F1)'));
  assert.match(out, /^ {2}CHECKED {6}5 of 5 findings confirmed by the auditor; 1 unresolved \(not settled\); 1 withdrawn/m);
  const bare = renderChat(buildReport({ findingsDoc: { findings: [finding({ id: 'F1', severity: 'LOW' })] }, manifest: MANIFEST, notesText: ['## Decisions needed', '', '- pick one', ''].join(String.fromCharCode(10)) }));
  assert.ok(bare.includes('| Decide | see Decisions needed below | 0 |'));
});

test('criteria verdicts: MET, PARTIAL and NOT MET are read from a bullet line or a bold table cell, the worst seat wins, and the chat line counts them', () => {
  assert.equal(parseVerdict('- AC-3 MET: ran the command'), 'MET');
  assert.equal(parseVerdict('| AC-8 | **NOT MET** | evidence says met |'), 'NOT MET');
  assert.equal(parseVerdict('| AC-9 | **PARTIAL** | x |'), 'PARTIAL');
  assert.equal(parseVerdict('- AC-9: ran it, not met by the old build'), null, 'lower case prose is not a verdict');
  const packet = lines('# Packet', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three', '- [AC-4] four');
  const seatA = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-1 MET: ran it', '- AC-2 PARTIAL: live run missing', '- AC-3 MET: read it');
  const seatB = lines('# B', '', '## No findings', '', '## Checks performed', '| Criterion | Verdict | Evidence |', '|---|---|---|', '| AC-1 | **MET** | x |', '| AC-3 | **NOT MET** | y |');
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
  const seatA = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-6048-1 MET: x', '- 6048: GO.', '- 6049: GO', '- 6041: GO for a staged rollout. Non-blocking: later.');
  const seatB = lines('# B', '', '## No findings', '', '## Checks performed', '6048: GO - fine', '6049: NO GO \u2014 live run missing', '6040: GO for the drive-type half. History half GO for staging');
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
  const seat = lines('# B', '', '## No findings', '', '## Checks performed', '- **Probe:** AC-8 and AC-9 were exercised with a stale page.', '', '| Criterion | Verdict | Evidence |', '|---|---|---|', '| AC-8 | **NOT MET** | later page lacks metadata |', '| AC-9 | **PARTIAL** | one stale page |', '', '6049: NO GO - AC-8 fails');
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

test('cost: every format with a cost table says once that session probes and earlier failed attempts are not counted', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST });
  const scope = /The cost covers the completed review calls; session probes and earlier failed attempts are not counted\./g;
  for (const out of [renderText(report, { color: false }), renderMarkdown(report), renderHtml(report), renderChat(report, { all: true })]) assert.equal(out.match(scope)?.length, 1);
  assert.doesNotMatch(renderChat(report), scope, 'the short chat report has no cost table');
});

test('cost: a Claude seat that reports input and cache write apart gets a Cache write column in text, markdown and html; other runs keep the old table', () => {
  const usage = { A: { input_tokens: 1000, cache_creation_input_tokens: 90000, new_input_tokens: 91000, context_reread_tokens: 500000, calls: 5, output_tokens: null }, B: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 10 } };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: { ...MANIFEST, seat_usage: usage } });
  const a = report.cost.find((r) => r.seat === 'seat A');
  assert.deepEqual([a.newInput, a.cacheWrite], [1000, 90000]);
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
  });
  const out = renderChat(report);
  assert.ok(out.includes('2 blockers (fix F1 first; F2 marked in the report notes)'));
  assert.match(renderText(report), /Blockers: 2/);
  assert.ok(out.includes('| Pre-existing | F2 | 1 |'));
  assert.match(out, /^ {2}PRE-EXISTING 1 not caused by this change: F2/m);
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
    { seat: 'seat A', newInput: 50, cacheWrite: 90000, cacheRead: 800000, output: 4000, calls: null },
  );
  assert.equal(seatCostRow('seat B', { input_tokens: 851000, cached_input_tokens: 750000, output_tokens: 6000 }).newInput, 101000, 'Codex input still includes the cached part');
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three');
  const seat = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-1 MET: x', '- AC-2: looked, no verdict word', '- AC-3: looked too');
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
  assert.deepEqual(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: SEAT_B, B: lines('# B', '', '## No findings', '', '## Checks performed', '- AC-1: does not fail, sumTo(4) is right.', '- AC-2: no failure seen.') } }).criteria.rows.map((r) => r.failedSeats), [[], []], 'negated phrases are not failures');
});

test('live-run fixes: the auditor and its cache write come from actors[]; a Claude per-call new input is its own input, not input minus cache', () => {
  const usage = { input_tokens: 6, cached_input_tokens: 44568, cache_write_input_tokens: 18341, output_tokens: 1343, source: 'provider', raw: { input_tokens: 6, cache_creation_input_tokens: 18341, cache_read_input_tokens: 44568 } };
  const manifest = { ...MANIFEST, seat_usage: {}, actors: [{ role: 'auditor', model_resolved: 'claude-sonnet-5-5', usage }], reviewers: [{ role: 'A', provider: 'anthropic', usage, usage_per_call: [usage, { ...usage, input_tokens: 4 }] }] };
  const report = buildReport({ findingsDoc: { findings: [] }, manifest });
  const aud = report.cost.find((r) => r.seat === 'auditor');
  assert.deepEqual([aud.newInput, aud.cacheWrite, aud.cacheRead, aud.output], [6, 18341, 44568, 1343]);
  const seatA = report.cost.find((r) => r.seat === 'seat A');
  assert.deepEqual(seatA.perCall, [6, 4]);
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

test('chat: a refuted hypothesis gets its own red line; confirmed ones are counted, the rest named by tag', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [H1] a', '- [H2] b', '- [H3] c', '- [H4] d');
  const seat = lines('# A', '', '## No findings', '', '## Checks performed', '- H1: REFUTED by the new test.', '- H2: CONFIRMED.', '- H3: PARTLY CONFIRMED, one path remains.', '- H4: looked at it, no outcome word.');
  const out = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: SEAT_B } }));
  assert.match(out, /^- SPLIT {8}H1 \(A refuted, B confirmed\)$/m);
  const both = renderChat(buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seat, B: lines('# B', '', '## No findings', '', '## Checks performed', '- H1: REFUTED too.') } }));
  assert.match(both, /^- REFUTED {6}H1$/m);
  assert.match(out, /^ {2}HYPOTHESES {3}H3 partly confirmed, H4 outcome not parsed, 1 confirmed$/m);
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
  const seat = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-1 NOT MET: the loop is off by one', '- AC-2 PARTIAL: live run missing', '- AC-3 MET: ok');
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

test('self-review fixes: failure words on a line with a verdict are not a failing check; without a verdict the row says so', () => {
  const run = (line) => buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: lines('- [AC-4] x'), seatTexts: { A: lines('## Checks performed', line), B: '' } });
  for (const line of ['- AC-4: verified that a failed step exits 1 and a broken pipe exits 0. MET', '- AC-4: --fail-on-command-error exits 4. MET', '- AC-4: a path that cannot be read is skipped. MET']) {
    const r = run(line).criteria.rows[0];
    assert.deepEqual([r.failedSeats, r.doubt], [[], []], line);
  }
  const noVerdict = run('- AC-4: fails in one case, see below');
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
  const r = spawnSync(process.execPath, [SCRIPT, '--run-dir', dir], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Why: Because of the BOM\./);
  assert.deepEqual([...findingStatus(lines('| F1 | fixed after snapshot |', '- F2: fixed', '| F3 | pre-existing | extra |'))], [['F1', 'fixed after snapshot'], ['F2', 'fixed'], ['F3', 'pre-existing']]);
  assert.match(renderText(buildReport({ findingsDoc: { findings: [finding({ id: null }), finding({ id: 4 })] }, manifest: MANIFEST })), /LOW +\? +S|LOW +\? /);
  const mixed = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, packetText: '- [H1] x', seatTexts: { A: lines('## Checks performed', '- H1: CONFIRMED for the no-header case, REFUTED for the header case.'), B: lines('## Checks performed', '- H1: CONFIRMED.') } });
  assert.equal(mixed.criteria.rows[0].verdict, 'partly', 'a mixed outcome is partly, not refuted');
  const cost = buildReport({ findingsDoc: { findings: [] }, manifest: { status: 'completed', actors: [{ role: 'auditor', provider: 'anthropic', model_requested: 'opus', usage: { input_tokens: 6, cached_input_tokens: 44568, cache_write_input_tokens: 18341, output_tokens: 1343, source: 'summed-per-call' } }], reviewers: [{ role: 'B', provider: 'opencode', usage: { input_tokens: 19907, cached_input_tokens: 1792, cache_write_input_tokens: 0, output_tokens: 4, calls: 1 } }, { role: 'A', provider: 'openai', usage: { input_tokens: 2269954, cached_input_tokens: 2009344, cache_write_input_tokens: 0, output_tokens: 35791 } }] } }).cost;
  const row = (seat) => cost.find((x) => x.seat === seat);
  assert.deepEqual([row('auditor').newInput, row('auditor').cacheWrite], [6, 18341], 'a Claude auditor with a short model alias');
  assert.deepEqual([row('seat B').newInput, row('seat B').cacheRead], [19907, 1792], 'OpenCode reports input without the cache');
  assert.equal(row('seat A').newInput, 260610, 'Codex input still includes the cache');
});

test('self-review fixes: a reader that closes stdout early keeps the exit code and the requested files', async (t) => {
  const dir = await makeRun(t);
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--run-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const seatB = lines('# B', '', '## No findings', '', '## Checks performed', '- AC-36-1, AC-36-2: traced failed-drive counting and the alert identity. No defect found statically.');
  const report = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB } });
  assert.deepEqual(report.criteria.rows.map((r) => r.failedSeats), [[], []]);
  assert.equal(report.caveats.some((c) => c.includes('failing check')), false);
  const real = lines('# A', '', '## No findings', '', '## Checks performed', '- [AC-36-1] device independence fails (reproduced); I filed no claim for it.');
  const flagged = buildReport({ findingsDoc: { zero_claims: true, findings: [] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: real, B: seatB } });
  assert.deepEqual(flagged.criteria.rows[0].failedSeats, ['A'], 'a real failing sentence is still flagged');
});

test('live run notes: unresolved is not "disputed", seats that split on a hypothesis are named, a split ticket gets a caveat, a PARTIAL shows its reason, markdown carries the recommended fix', () => {
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [H1] no path can double count', '- [H2] second', '- Tickets: 6036 = AC-1, AC-2');
  const seatA = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-1 PARTIAL: the NVMe host path was not run.', '- AC-2 MET: ok', '- H1: no path double counts. REFUTED.', '- H2: CONFIRMED.', '- 6036: NO GO - AC-1 is partial');
  const seatB = lines('# B', '', '## No findings', '', '## Checks performed', '- AC-1 MET: ok', '- AC-2 MET: ok', '- H1: read the loop. CONFIRMED.', '- H2: CONFIRMED.', '- 6036: GO');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'MEDIUM', final_state: 'unresolved-low-stakes', recommended_fix: 'Key the dedup on node id and status. Then add a test.' })] },
    manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  const chat = renderChat(report);
  assert.doesNotMatch(chat, /disputed/);
  assert.match(chat, /1 unresolved \(not settled\)/);
  assert.match(chat, /^- SPLIT {8}H1 \(A refuted, B confirmed\)/m);
  assert.doesNotMatch(chat, /^- REFUTED/m);
  assert.match(chat, /^ {2}PARTIAL {6}AC-1 {2}no finding tagged$/m);
  assert.match(chat, /^ {15}the NVMe host path was not run\.$/m);
  assert.ok(report.caveats.some((c) => c.includes('Ticket 6036: the seats disagree (A NO GO, B GO)')));
  assert.match(renderMarkdown(report), /Fix: Key the dedup on node id and status\. Then add a test\./);
});

test('live run notes 4: the full recommended fix, a wrapped PARTIAL reason, SPLIT in the table, every flagged tag in the banner, findings next to a ticket verdict', () => {
  const longFix = 'Route the volume status through the alert helper, keep the remote-copy exception, guard a None status, and add a regression test. ' + 'Risk: the offline path changes colour; check the Yellow rows. '.repeat(8);
  const reason = 'the NVMe host path was not run because the lab array has no NVMe shelf and the simulator cannot return the tier field the code reads, so only the SAS path is proved';
  const packet = lines('# P', '## Acceptance criteria', '- [AC-1] one', '- [AC-2] two', '- [AC-3] three', '- [AC-4] four', '- [AC-5] five', '- [AC-6] six', '- [H1] no path double counts', '- Tickets: 6036 = AC-1, AC-2, AC-3, AC-4, AC-5, AC-6');
  const checks = (v) => ['## Checks performed', ...['AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'].map((t) => '- ' + t + ' MET: ok'), '- AC-1 PARTIAL: ' + reason + '.', '- H1: ' + v + '.', '- 6036: NO GO - see AC-1'];
  const seatA = lines('# A', '', '## A1 [AC-2] [AC-3] [AC-4] [AC-5] [AC-6] The first claim', 'Severity: MEDIUM', '', ...checks('REFUTED'));
  const seatB = lines('# B', '', '## No findings', '', ...checks('CONFIRMED'));
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
  const seatB = lines('# B', '', '## No findings', '', '## Checks performed', '- AC-30-1 MET: ok', '- 6030: NO GO');
  const report = buildReport({
    findingsDoc: { findings: [finding({ id: 'F1', severity: 'HIGH', origins: ['A1'] })] }, manifest: MANIFEST, packetText: packet, seatTexts: { A: seatA, B: seatB },
  });
  assert.deepEqual(report.criteria.tickets.find((x) => x.id === '6030').findings, ['F1']);
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
  const checks = lines('# A', '', '## No findings', '', '## Checks performed', '- AC-30-1 MET: ok', '- AC-30-F1 MET: ok', '- AC-30-F6 MET: ok', '- AC-36-1 MET: ok', '- 6030: GO', '- 6036: GO');
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
  const auditor = chat({ ...COMMANDS_MANIFEST, seat_usage: { ...COMMANDS_MANIFEST.seat_usage, auditor: { commands: { tried: 0, failed: 0, source: 'transcript' } } } });
  assert.doesNotMatch(auditor, /COMMANDS +auditor/, 'the line is about the reviewer seats');
  for (const out of [text, none, one]) for (const line of out.split(NL)) assert.ok(line.length <= 100 || !/COMMANDS/.test(line), line);
});
