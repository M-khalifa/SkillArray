import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  splitProseAndCode,
  relabelText,
  scanText,
  scanForKnownClaimIdLeaks,
  extractClaimBlocks,
  claimBlockProblems,
  flipMapping,
  invertSeatMapping,
  translateFindings,
  parseArgs,
  parseTokensArg,
  RelayError,
  realClaimIds,
  peerViewClaimIds,
  scanForPeerLabelLeaks,
  scanForTargetUrls,
  normalizeUrl,
  validateProblems,
  falsificationBreakdown,
  parseFenceLines,
} from '../blind-relabel.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/blind-relabel', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../blind-relabel.mjs', import.meta.url));

test('parseArgs: relabel requires in/out/from/to and single-letter labels', () => {
  assert.throws(() => parseArgs(['relabel']), (err) => err instanceof RelayError);
  assert.throws(
    () => parseArgs(['relabel', '--in', 'a', '--out', 'b', '--from', 'AA', '--to', 'P']),
    /single letter/
  );
  const ok = parseArgs(['relabel', '--in', 'a.md', '--out', 'b.md', '--from', 'A', '--to', 'P']);
  assert.deepEqual(ok, { sub: 'relabel', in: 'a.md', out: 'b.md', from: 'A', to: 'P' });
});

test('parseArgs: B9 -- --from and --to identical is rejected, never reported as a successful no-op relabel', () => {
  assert.throws(
    () => parseArgs(['relabel', '--in', 'a.md', '--out', 'b.md', '--from', 'A', '--to', 'A']),
    /must differ/
  );
});

test('parseArgs: --tokens is only accepted by scan, rejected on relabel and flip', () => {
  assert.deepEqual(
    parseArgs(['scan', '--in', 'x.md', '--tokens', 'gpt-5.6-sol,google/gemini-3-pro']),
    { sub: 'scan', in: 'x.md', tokens: 'gpt-5.6-sol,google/gemini-3-pro' }
  );
  assert.throws(
    () => parseArgs(['relabel', '--in', 'a.md', '--out', 'b.md', '--from', 'A', '--to', 'P', '--tokens', 'x']),
    /--tokens is only accepted by scan/
  );
  assert.throws(
    () => parseArgs(['flip', '--out', 'm.json', '--tokens', 'x']),
    /--tokens is only accepted by scan/
  );
});

test('parseTokensArg: comma-separated, trims whitespace, drops empty entries', () => {
  assert.deepEqual(parseTokensArg(undefined), []);
  assert.deepEqual(parseTokensArg(''), []);
  assert.deepEqual(parseTokensArg('gpt-5.6-sol, google/gemini-3-pro ,,'), ['gpt-5.6-sol', 'google/gemini-3-pro']);
});

test('scanText: B6 -- an actual configured model/provider string passed via extraTokens is scanned for, not just the hardcoded vendor list', async () => {
  // google/gemini-3-pro shares no substring with the hardcoded VENDOR_TOKENS list, so it is
  // only ever found via extraTokens -- a real check that --tokens is doing something.
  const clean = await scanText('I ran google/gemini-3-pro against the fixture.', undefined, []);
  assert.equal(clean.selfIdHits.length, 0);
  assert.equal(clean.identityHits.length, 0, 'without the token configured, an unrecognized model ID is not flagged at all');

  const { selfIdHits, identityHits } = await scanText(
    'I ran google/gemini-3-pro against the fixture.\n' +
    'The report mentions google/gemini-3-pro as the other seat\'s model.',
    undefined,
    ['google/gemini-3-pro']
  );
  assert.equal(selfIdHits.length, 1);
  assert.match(selfIdHits[0].text, /I ran google\/gemini-3-pro/);
  // a non-target-derived vendor/model token mention is now ALSO a hard stop -- third-person
  // identity prose is as real a leak as first-person self-ID.
  assert.equal(identityHits.length, 1);
  assert.match(identityHits[0].text, /The report mentions/);
});

test('parseArgs: scan requires --in, flip requires --out', () => {
  assert.throws(() => parseArgs(['scan']), /requires --in/);
  assert.throws(() => parseArgs(['flip']), /requires --out/);
  assert.deepEqual(parseArgs(['scan', '--in', 'x.md']), { sub: 'scan', in: 'x.md' });
  assert.deepEqual(parseArgs(['flip', '--out', 'm.json']), { sub: 'flip', out: 'm.json' });
});

test('splitProseAndCode: separates fenced and inline code from prose', () => {
  const text = 'before `A1` middle\n```\nA2 inside a fence\n```\nafter A3';
  const parts = splitProseAndCode(text);
  const code = parts.filter((p) => p.code).map((p) => p.text).join('\n');
  const prose = parts.filter((p) => !p.code).map((p) => p.text).join('');
  assert.match(code, /`A1`/);
  assert.match(code, /A2 inside a fence/);
  assert.match(prose, /before/);
  assert.match(prose, /middle/);
  assert.match(prose, /after A3/);
  assert.doesNotMatch(prose, /A2 inside a fence/);
});

test('splitProseAndCode: a backslash-escaped backtick pair is literal punctuation, not a code span opener -- CommonMark backslash escapes work in prose but not inside an already-open code span (spec 6.1, example 328: backslash escapes do not work in code spans)', () => {
  const text = 'prose \\`Codex\\` more prose';
  const parts = splitProseAndCode(text);
  const code = parts.filter((p) => p.code).map((p) => p.text).join('');
  const prose = parts.filter((p) => !p.code).map((p) => p.text).join('');
  assert.equal(code, '', 'no span should open on an escaped backtick');
  assert.match(prose, /Codex/, 'Codex must remain scannable prose, not hidden inside a fake code span');
});

test('splitProseAndCode: an unescaped backtick pair still opens a real code span (baseline, must not regress)', () => {
  const parts = splitProseAndCode('prose `Codex` more prose');
  const code = parts.filter((p) => p.code).map((p) => p.text).join('');
  assert.equal(code, '`Codex`');
});

test('splitProseAndCode: one, two, and three preceding backslashes alternate escaped/literal-backslash-then-real-delimiter, per CommonMark backslash-escape parity', () => {
  // 1 backslash: escaped backtick, no span.
  const one = splitProseAndCode('\\`Codex\\`');
  assert.equal(one.filter((p) => p.code).length, 0, 'odd (1) preceding backslash: escaped, no span');

  // 2 backslashes: first backslash is itself escaped (\\ -> literal backslash), the backtick
  // that follows is a real, unescaped delimiter.
  const two = splitProseAndCode('\\\\`Codex`');
  const twoCode = two.filter((p) => p.code).map((p) => p.text).join('');
  assert.equal(twoCode, '`Codex`', 'even (2) preceding backslashes: backtick is a real delimiter');

  // 3 backslashes: net-odd, so the backtick immediately before the run is still escaped.
  const three = splitProseAndCode('\\\\\\`Codex\\`');
  assert.equal(three.filter((p) => p.code).length, 0, 'odd (3) preceding backslashes: escaped, no span');
});

test('splitProseAndCode: an escaped run of 3 backticks leaves a real run of 2 as a fresh, matchable delimiter candidate', () => {
  // \``` -- first backtick of the 3-run is escaped by the preceding backslash, so what
  // remains is an unescaped 2-backtick run, which can still open/close a span on its own.
  const parts = splitProseAndCode('\\```Codex``end');
  const code = parts.filter((p) => p.code).map((p) => p.text).join('');
  assert.equal(code, '``Codex``', 'the un-escaped remaining 2-backtick run must still open and close a span');
});

test('splitProseAndCode: escape-awareness applies only to the opening delimiter search, never to a closer once a span is open -- CommonMark: backslash escapes do not work INSIDE an open code span', () => {
  // `x\` opens on the first backtick (no preceding backslash); inside the span, CommonMark
  // never honors backslash-escapes, so the very next backtick run -- \` here -- still closes
  // the span (the backslash before it is span CONTENT, not an escape). This intentionally
  // leaves "Codex" inside a matched code span: it is real inline code per CommonMark, not a
  // blinding bypass, so it correctly stays hidden from the scanner.
  const parts = splitProseAndCode('`x\\` Codex `y`');
  const code = parts.filter((p) => p.code).map((p) => p.text).join('|');
  assert.equal(code, '`x\\`|`y`', 'the closer must not skip past an escaped-looking backtick inside an open span');
});

test('scanText: an escaped backtick pair around a vendor token does not hide it from the identity scan', async () => {
  const { identityHits } = await scanText('\\`Codex\\` reviewer found this.', undefined);
  assert.equal(identityHits.length, 1, 'escaped backticks are literal punctuation; Codex must be scanned as prose');
});

test('relabelText: an escaped backtick pair around a claim ID does not hide it from relabeling', () => {
  const out = relabelText('\\`A1\\` is my claim', 'A', 'X', ['A1']);
  assert.equal(out, '\\`X1\\` is my claim');
});

test('relabelText: rewrites headings and prose claim IDs, skips fenced/inline code, strips the seat header', () => {
  const text = [
    '# Seat A findings — some target',
    '',
    '## A1 — a claim',
    '## A2 — second claim',
    'See A1 and A2 in prose.',
    '`A3` stays as-is inline.',
    '```',
    'A4 stays as-is in a fence',
    '```',
  ].join('\n');
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^# Peer findings/);
  assert.match(out, /## P1 — a claim/);
  assert.match(out, /See P1 and P2 in prose\./);
  assert.match(out, /`A3` stays as-is inline\./);
  assert.match(out, /A4 stays as-is in a fence/);
  assert.doesNotMatch(out, /\bA1\b/);
});

test('relabelText: an inline-code span preceding the seat header on the same line leaves the header untouched (structural test on the RAW line)', () => {
  // Stripping "`x`" would shift "# Seat A findings" to position 0, which a real Markdown
  // renderer never treats as a heading (the code span still occupies that position).
  const text = '`x`# Seat A findings\n\n## A1 — claim\nprose';
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^`x`# Seat A findings$/m);
  assert.match(out, /## P1 — claim/);
});

test('CLI relabel: a file whose only seat-header-shaped text is preceded by an inline-code span on the same line reports no targets, matching relabelText\'s own untouched behavior', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-prefixed-header-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inPath = path.join(dir, 'a-side.md');
  await fs.writeFile(inPath, '`x`# Seat A findings\n');
  const outPath = path.join(dir, 'out.md');

  const result = spawnSync(
    process.execPath,
    [SCRIPT, 'relabel', '--in', inPath, '--out', outPath, '--from', 'A', '--to', 'P'],
    { encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0, 'a code-span-prefixed header-shaped line must not count as a target');
  assert.match(result.stderr, /no "A" claim IDs, seat header, or rebuttal heading/);
  await assert.rejects(fs.access(outPath), 'no output file should be written on this failure');
});

test('relabelText: two directions produce independent numbering, never cross-contaminating', () => {
  const aText = '## A1 — claim\nSee A1.';
  const bText = '## B1 — claim\nSee B1.';
  const aAsP = relabelText(aText, 'A', 'P');
  const bAsP = relabelText(bText, 'B', 'P');
  assert.match(aAsP, /P1/);
  assert.match(bAsP, /P1/);
  assert.doesNotMatch(aAsP, /\bB1\b/);
  assert.doesNotMatch(bAsP, /\bA1\b/);
});

test('scanText: self-identification is flagged, not merely a token mention -- but the mention still hard-stops as a non-first-person identity leak', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'As Codex I ran the suite.\nA plain mention of Claude with no first person.',
    undefined
  );
  assert.equal(selfIdHits.length, 1);
  assert.match(selfIdHits[0].text, /As Codex I ran/);
  assert.equal(identityHits.length, 1);
  assert.match(identityHits[0].text, /A plain mention of Claude/);
});

test('scanText: third-person mention of a vendor token near "as" is not self-identification, and passes when the target itself uses this vocabulary', async () => {
  const text =
    'I read codex-dispatch.mjs:54 and ran the suite.\n' +
    'The docs hardcode seat A as Claude.\n' +
    '"mirror the dispatcher" as a general property, but codex-dispatch.mjs writes neither field.';

  // No --target-dir: third person is never self-identification, but every non-derived
  // vendor/seat mention here still hard-stops as an identity leak for an ordinary target.
  const noTarget = await scanText(text, undefined);
  assert.equal(noTarget.selfIdHits.length, 0);
  assert.equal(noTarget.identityHits.length, 3);

  // With --target-dir pointed at the checked-in fixture target (a review protocol whose own
  // docs say "seat A" and whose own files are named codex-dispatch.mjs), every line here is
  // target-derived. A fixture, not the live skill dir: deterministic wherever this test runs
  // (this file is byte-identical-synced into pair-review, which has no such filenames of its own).
  const withTarget = await scanText(text, path.join(FIXTURE_DIR, 'target'));
  assert.equal(withTarget.selfIdHits.length, 0);
  assert.equal(withTarget.identityHits.length, 0);
  assert.equal(withTarget.otherHits.length, 3);
});

test('scanText: an actual configured model/provider string passed via --tokens is exempted as target-derived when the target names it', async () => {
  const targetDir = path.join(FIXTURE_DIR, 'target-no-seat');
  const text = 'The provider catalog lists gpt-5.6-sol as a supported model.';

  // Without --target-dir, the token is not target-derived and hard-stops.
  const noTarget = await scanText(text, undefined, ['gpt-5.6-sol']);
  assert.equal(noTarget.identityHits.length, 1);

  // With --target-dir pointed at a fixture whose own SKILL.md names this exact model ID,
  // the extraTokens string is now target-derived and must not hard-stop -- proves --tokens
  // strings share the same target-derived exemption path as the hardcoded vendor list,
  // not only a name-based (never checked) or unconditional pass.
  const withTarget = await scanText(text, targetDir, ['gpt-5.6-sol']);
  assert.equal(withTarget.identityHits.length, 0);
  assert.equal(withTarget.otherHits.length, 1);
});

test('scanText: seat-vocabulary exemption stays false for a target that names vendor tokens but never uses seat vocabulary itself', async () => {
  const text = 'The docs hardcode seat A as Claude.';
  const targetDir = path.join(FIXTURE_DIR, 'target-no-seat');
  const { selfIdHits, identityHits, otherHits } = await scanText(text, targetDir);
  assert.equal(selfIdHits.length, 0);
  // The line is one hit either way (line-level bucketing): the seat mention alone is enough
  // to hard-stop this line even though "claude" is target-derived, since this fixture's own
  // docs never use seat vocabulary -- proves seatVocabulary is computed per-target, not
  // defaulted true (a true default would make this line pass as otherHits instead).
  assert.equal(identityHits.length, 1);
  assert.equal(otherHits.length, 0);
});

test('targetDerivedTokens: seatVocabulary detection uses a strict uppercase-only vocab regex, not the widened case-insensitive scan-hit regex -- a target whose own docs contain the "gives the reviewer a chance" false-positive shape does not unlock the seat-vocabulary exemption', async () => {
  const targetDir = path.join(FIXTURE_DIR, 'target-no-seat');
  const text = 'seat a found this bug.';
  const { identityHits } = await scanText(text, targetDir);
  // If seatVocabulary detection were widened along with SEAT_TOKEN_RE, the fixture's own
  // "gives the reviewer a chance" phrase would flip seatVocabulary true, exempting every seat
  // mention against this target -- including a genuine lowercase leak like this one.
  assert.equal(identityHits.length, 1, 'a real lowercase seat leak must still hard-stop against this target');
});

test('scanText: three real leak strings hard-stop as identity leaks, none of them first-person self-identification', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'The Codex reviewer found a race condition.\n' +
    'Reviewer A found the issue.\n' +
    'This came from OpenAI.',
    undefined
  );
  assert.equal(selfIdHits.length, 0, 'none of these are first-person');
  assert.equal(identityHits.length, 3, 'every one is a real third-person identity leak, not merely reported');
});

test('scanText: an actual configured model/provider string in third-person prose also hard-stops via --tokens', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'The reviewer using gpt-5.6-sol wrote this finding.',
    undefined,
    ['gpt-5.6-sol']
  );
  assert.equal(selfIdHits.length, 0);
  assert.equal(identityHits.length, 1);
});

test('scanText: genuine first-person self-identification is still caught', async () => {
  const { selfIdHits } = await scanText(
    'I am gpt-5.6-sol.\nRunning as Codex, I saw the failure.',
    undefined
  );
  assert.equal(selfIdHits.length, 2);
});

test('scanText: "As seat A, I found..." is caught as self-identification even though relabelText never rewrites a bare seat letter in prose', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'As seat A, I found a bug.\n' +
    '## A1 — thing\n' +
    'Seat A says X.',
    undefined
  );
  assert.equal(selfIdHits.length, 1);
  assert.match(selfIdHits[0].text, /As seat A, I found/);
  // "Seat A says X" has no first-person marker nearby, but a bare seat mention is still an
  // identity leak for an ordinary target (no target-derived seat-vocabulary exemption here).
  assert.equal(identityHits.length, 1);
  assert.match(identityHits[0].text, /Seat A says X/);
});

test('scanText: SEAT1 repro -- a genuine self-ID with >40 characters between the first-person marker and "seat A" is still caught, not just reported as a bare mention', async () => {
  const { selfIdHits, otherHits } = await scanText(
    'I want to note, after checking the fixture twice and re-running the suite, that seat A caught this.',
    undefined
  );
  assert.equal(selfIdHits.length, 1);
  assert.equal(otherHits.length, 0);
});

test('scanText: "Seat-A" and "reviewer A" phrasing are caught as seat mentions, not just the literal "seat A" two-token form (A5/B10)', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'As Seat-A, I found this.\n' +
    'Speaking as reviewer A, I confirm the bug.\n' +
    'The A-side reviewer disagreed with this.',
    undefined
  );
  assert.equal(selfIdHits.length, 2);
  // a bare, non-first-person seat mention is now ALSO a hard stop for an ordinary target.
  assert.equal(identityHits.length, 1);
  assert.match(identityHits[0].text, /A-side reviewer disagreed/);
});

test('scanText: ordinary prose using "a reviewer" (the indefinite article alone, no trailing seat letter) is never flagged', async () => {
  const { selfIdHits, otherHits } = await scanText(
    'I think a reviewer should check the resume path.\nIn my view a reviewer would catch this.',
    undefined
  );
  assert.equal(selfIdHits.length, 0);
  assert.equal(otherHits.length, 0);
});

test('scanText: a lowercase seat mention (seat a, reviewer a) now hard-stops case-insensitively, not just Seat A/Reviewer A', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'I am seat a and I found this.\n' +
    'As reviewer a, I confirm the finding.\n' +
    'reviewer a found the issue.',
    undefined
  );
  assert.equal(selfIdHits.length, 2, 'the two first-person lines are self-identification');
  assert.equal(identityHits.length, 1, 'the bare third-person mention is still an identity leak');
});

test('scanText: "gives the reviewer a chance" is a known, accepted false positive from the case-insensitive seat-letter match', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'This gives the reviewer a chance to respond.',
    undefined
  );
  assert.equal(selfIdHits.length, 0, 'no first-person marker nearby, so this is not self-identification');
  // Documented cost of closing the lowercase-miss gap: this ordinary sentence now hard-stops as
  // an identity leak. Accepted because a missed lowercase seat mention would silently defeat the
  // blind, while this false positive only costs one redaction round.
  assert.equal(identityHits.length, 1);
});

test('scanText: the same false-positive shape hard-stops as SELF-IDENTIFICATION instead, when a first-person marker is nearby', async () => {
  const { selfIdHits, identityHits } = await scanText(
    'I gave the reviewer a chance to respond.',
    undefined
  );
  // Same accepted false positive as above, but the nearby "I" pushes it into the stronger,
  // separately-labeled tier rather than silently landing in the weaker one.
  assert.equal(selfIdHits.length, 1);
  assert.equal(identityHits.length, 0);
});

test('scanText: an unterminated fenced code block throws rather than silently hiding the rest of the file', async () => {
  await assert.rejects(
    () => scanText('```\nfoo\nAs Codex I ran it.', undefined),
    (err) => err instanceof RelayError && /unterminated fence/.test(err.message)
  );
});

test('scanForKnownClaimIdLeaks: a real claim ID surviving INSIDE an Evidence fence is caught, closing relabelText\'s own documented limitation (the exact leak found in a real Phase 2 run)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-claim-leak-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — one\nEvidence: e1\n\n## A4 — four\nEvidence: e4\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  // Simulates a Phase 2 peer-view already relabeled A->P, but seat A's own rebuttal prose
  // still references its earlier claim by real letter INSIDE an Evidence fence -- relabelText
  // deliberately never touches fence content, so this is exactly the leak the vendor/seat scan
  // above (which also exempts fences) cannot see either.
  const relabeled = '# Peer findings\n\n## P1 — one\nEvidence: e1\n\n### P1\nAction: CONCEDE\nEvidence:\n```\nsame issue as my A4\n```\n';
  const hits = await scanForKnownClaimIdLeaks(relabeled, dir, ['A']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'A4');
  assert.match(hits[0].text, /my A4/);
});

test('scanForKnownClaimIdLeaks: only the forbidden seat\'s own real claim IDs are checked -- a Phase 2 peer-view forbidding seat A does not flag a literal "B2" appearing in prose', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-claim-leak-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nEvidence: e1\n');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## B2 — two\nEvidence: e2\n');
  const text = 'discusses a config key named B2 in the target code, unrelated to any claim ID';
  const hits = await scanForKnownClaimIdLeaks(text, dir, ['A']);
  assert.equal(hits.length, 0);
});

test('scanForKnownClaimIdLeaks: clean text with no forbidden claim ID anywhere returns zero hits', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-claim-leak-clean-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — one\nEvidence: e1\n');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const hits = await scanForKnownClaimIdLeaks('# Peer findings\n\n## P1 — one\nEvidence:\n```\nclean, no leak\n```\n', dir, ['A']);
  assert.equal(hits.length, 0);
});

test('parseArgs: scan --forbid-seats requires --phase1-dir alongside it, and rejects a malformed seat list', () => {
  assert.throws(
    () => parseArgs(['scan', '--in', 'x.md', '--forbid-seats', 'A']),
    (err) => err instanceof RelayError && /requires --phase1-dir and --forbid-seats together/.test(err.message)
  );
  assert.throws(
    () => parseArgs(['scan', '--in', 'x.md', '--phase1-dir', 'd']),
    (err) => err instanceof RelayError && /requires --phase1-dir and --forbid-seats together/.test(err.message)
  );
  assert.throws(
    () => parseArgs(['scan', '--in', 'x.md', '--phase1-dir', 'd', '--forbid-seats', 'a']),
    (err) => err instanceof RelayError && /single uppercase letters/.test(err.message)
  );
  const args = parseArgs(['scan', '--in', 'x.md', '--phase1-dir', 'd', '--forbid-seats', 'A,B']);
  assert.equal(args.forbidSeats, 'A,B');
});

test('parseArgs: --forbid-seats is only accepted by scan, rejected on relabel/flip/translate', () => {
  assert.throws(
    () => parseArgs(['relabel', '--in', 'x', '--out', 'y', '--from', 'A', '--to', 'P', '--forbid-seats', 'A']),
    RelayError
  );
  assert.throws(() => parseArgs(['flip', '--out', 'y', '--forbid-seats', 'A']), RelayError);
  assert.throws(
    () => parseArgs(['translate', '--in', 'x', '--out', 'y', '--mapping', 'm', '--forbid-seats', 'A']),
    RelayError
  );
});

test('relabelText: a mid-line ``` inside one Evidence fence no longer flips fence parity for a LATER, separate fence (the exact bug that broke a real Phase 2 run)', () => {
  const backtick3 = '`'.repeat(3);
  const text = [
    '## A1 — claim one',
    '```',
    `a literal ${backtick3} appears mid-line right here`,
    '```',
    '## A2 — must relabel',
    '```',
    'second fence, no IDs inside',
    '```',
    '## A3 — must relabel',
  ].join('\n');
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim one$/m);
  assert.match(out, /^## P2 — must relabel$/m);
  assert.match(out, /^## P3 — must relabel$/m);
  assert.doesNotMatch(out, /\bA1\b|\bA2\b|\bA3\b/);
});

test('relabelText: two mid-line ``` inside one fence pair off with each other, not the real fence delimiters, so a claim ID between them stays untouched (byte-identical fence guarantee)', () => {
  const text = [
    '## A1 — claim',
    '```',
    'before ``` middle mentioning A2 here ``` after',
    '```',
    '## A3 — next claim, must still relabel',
  ].join('\n');
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /^## P3 — next claim, must still relabel$/m);
  // A2 sat between the two mid-line ```s, which real fence lines still bracket as one code block.
  assert.match(out, /middle mentioning A2 here/);
});

test('relabelText: a ~~~ (tilde) fence protects its content exactly like a backtick fence', () => {
  const text = [
    '## A1 — claim',
    '~~~',
    'A2 stays literal inside a tilde fence',
    '~~~',
    '## A3 — must still relabel',
  ].join('\n');
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /^## P3 — must still relabel$/m);
  assert.match(out, /A2 stays literal inside a tilde fence/);
});

test('relabelText: a 4-backtick fence containing a bare 3-backtick line stays one code block, not two', () => {
  const text = [
    '## A1 — claim',
    '````',
    '```',
    'A2 stays literal, the inner ``` is content not a delimiter',
    '```',
    '````',
    '## A3 — must still relabel',
  ].join('\n');
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /^## P3 — must still relabel$/m);
  assert.match(out, /A2 stays literal, the inner/);
});

test('relabelText: a fence indented 0-3 spaces is still protected (CommonMark cap)', () => {
  for (const indent of ['', ' ', '  ', '   ']) {
    const text = `## A1 — claim\n${indent}\`\`\`\nA2 stays literal inside this fence\n${indent}\`\`\`\n## A3 — must still relabel`;
    const out = relabelText(text, 'A', 'P');
    assert.match(out, /^## P1 — claim$/m);
    assert.match(out, /^## P3 — must still relabel$/m);
    assert.match(out, /A2 stays literal inside this fence/, `indent ${JSON.stringify(indent)} must still protect`);
  }
});

test('relabelText: a 4-space (or deeper) indented ``` is CommonMark indented code, NOT a fence -- its content is exposed and relabels normally', () => {
  const text = '## A1 — claim\n    ```\nA2 must relabel, this is not really a fence\n    ```\n## A3 — must still relabel';
  const out = relabelText(text, 'A', 'P', ['A2']);
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /^## P3 — must still relabel$/m);
  assert.match(out, /P2 must relabel, this is not really a fence/, 'a 4-space "fence" must not hide a real claim ID from relabeling');
});

test('relabelText: a tab-indented ``` is also not a fence (CommonMark space-only cap), content relabels normally', () => {
  const text = '## A1 — claim\n\t```\nA2 must relabel here too\n\t```\n## A3 — must still relabel';
  const out = relabelText(text, 'A', 'P', ['A2']);
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /P2 must relabel here too/);
});

test('scanText: a 4-space indented pseudo-fence does not hide a third-person identity leak (the blinding bypass this closes)', async () => {
  const text = 'Some intro text.\n    ```\nThe Codex reviewer found this issue.\n    ```\n';
  const { identityHits } = await scanText(text, undefined);
  assert.equal(identityHits.length, 1, 'text inside a 4-space "fence" is not real fenced content and must still be scanned');
});

test('relabelText: a 4-space "closing" line after a genuine 0-3-space-opened fence does not close it -- unterminated throws instead of silently exposing the rest of the file', () => {
  assert.throws(
    () => relabelText('## A1 — claim\n```\nA2 should not be reachable\n    ```\nstill inside the fence, past a fake close', 'A', 'P'),
    (err) => err instanceof RelayError && /unterminated fence/.test(err.message)
  );
});

test('relabelText: a ~~~ opened fence is not closed by a ``` line of the other character; unterminated throws', () => {
  assert.throws(
    () => relabelText('## A1 — claim\n~~~\nA2 should not be reachable\n```\nstill inside the tilde fence', 'A', 'P'),
    (err) => err instanceof RelayError && /unterminated fence/.test(err.message)
  );
});

test('splitLineSpans: an inline span opened with a double-backtick run closes only at the next double-backtick run, so a single backtick and a claim ID inside stay code', () => {
  const text = '## A1 — claim\nSee ``literal ` backtick and A2`` here, but A3 in prose relabels.';
  const out = relabelText(text, 'A', 'P', ['A2', 'A3']);
  assert.match(out, /^## P1 — claim$/m);
  // A2 sits inside the double-backtick span, so it must survive byte-identical, unrewritten.
  assert.match(out, /``literal ` backtick and A2``/);
  assert.match(out, /\bP3\b/);
  assert.doesNotMatch(out, /\bA1\b/);
});

test('splitLineSpans: a single unmatched backtick run is literal text, so a claim ID after it still relabels', () => {
  const text = '## A1 — claim\nAn unterminated `A2 span with no closing backtick, then A3 in prose.';
  const out = relabelText(text, 'A', 'P', ['A2', 'A3']);
  assert.match(out, /^## P1 — claim$/m);
  // A2 sits after an unmatched open backtick: treated as literal text, not code, so it relabels too.
  assert.match(out, /\bP2\b/);
  assert.match(out, /\bP3\b/);
});

test('splitLineSpans: a single-backtick close match must not be the first backtick of a following longer run', () => {
  const text = '## A1 — claim\nSee `A1`` and A2 in prose.';
  const out = relabelText(text, 'A', 'P', ['A2']);
  assert.match(out, /^## P1 — claim$/m);
  // The single-backtick span closes at the FIRST lone backtick, not the first backtick of ``.
  assert.match(out, /`P1``/);
  assert.match(out, /\bP2\b/);
  assert.doesNotMatch(out, /\bA1\b/);
  assert.doesNotMatch(out, /\bA2\b/);
});

test('scanText: a ~~~ fence exempts self-identification prose exactly like a backtick fence', async () => {
  const { selfIdHits } = await scanText('~~~\nAs Codex I ran the suite.\n~~~', undefined);
  assert.equal(selfIdHits.length, 0);
});

test('relabelText: an unterminated fenced code block throws rather than silently relabeling (or silently skipping) the rest of the file', () => {
  assert.throws(
    () => relabelText('## A1 — claim\n```\nunterminated\nA2 should not be reachable', 'A', 'P'),
    (err) => err instanceof RelayError && /unterminated fence/.test(err.message)
  );
});

test('relabelText: two chained passes (own letter, then peer letter) fully strip both real IDs and relabel the rebuttal heading', () => {
  const text = [
    '# Seat A findings — some target',
    '## A1 — claim',
    'See A1.',
    '## Rebuttals (from B) of A claims',
    '### A1',
    'Action: concede, same root cause as B4.',
  ].join('\n');
  const pass1 = relabelText(text, 'A', 'X');
  const pass2 = relabelText(pass1, 'B', 'Y', ['B4']); // B4 comes from B's Phase 1 file (relabel --phase1-dir)
  assert.doesNotMatch(pass2, /\b[AB]\d+\b/);
  assert.match(pass2, /same root cause as Y4/);
  assert.match(pass2, /^## Rebuttals \(from Y\) of X claims$/m);
  assert.match(pass2, /^# Seat X findings/);
});

test('scanText: fenced/inline citations of vendor tokens are exempt entirely', async () => {
  const { selfIdHits, otherHits } = await scanText(
    'See `codex-dispatch.mjs` and:\n```\nmodel: gpt-5.6-sol\n```\nfor details.',
    undefined
  );
  assert.equal(selfIdHits.length, 0);
  assert.equal(otherHits.length, 0);
});

test('scanText: --target-dir marks tokens that are the target skill\'s own name as target-derived', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-target-'));
  try {
    await fs.writeFile(path.join(dir, 'codex-dispatch.mjs'), '');
    const { otherHits } = await scanText('The file codex-dispatch.mjs handles this.', dir);
    assert.equal(otherHits.length, 1);
    assert.equal(otherHits[0].targetDerived, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('flipMapping: always exactly one of the two valid A/B <-> X/Y assignments', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const m = flipMapping();
    const keys = Object.keys(m).sort();
    assert.deepEqual(keys, ['A', 'B']);
    assert.ok(
      (m.A === 'X' && m.B === 'Y') || (m.A === 'Y' && m.B === 'X'),
      `unexpected mapping: ${JSON.stringify(m)}`
    );
    seen.add(JSON.stringify(m));
  }
  assert.ok(seen.size <= 2);
});

test('invertSeatMapping: accepts both valid flipMapping shapes and inverts them', () => {
  assert.deepEqual(invertSeatMapping({ A: 'X', B: 'Y' }), { X: 'A', Y: 'B' });
  assert.deepEqual(invertSeatMapping({ A: 'Y', B: 'X' }), { Y: 'A', X: 'B' });
});

test('invertSeatMapping: rejects anything other than the two valid shapes', () => {
  for (const bad of [{ A: 'X', B: 'X' }, { A: 'Z', B: 'Y' }, { A: 'X' }, {}, null, 'X']) {
    assert.throws(() => invertSeatMapping(bad), RelayError);
  }
});

// One valid finding, all six enum fields populated with legal values -- the minimal
// shape translateFindings requires to accept a finding at all.
function validFinding(overrides = {}) {
  return {
    id: 'F1',
    origins: ['X3', 'Y7'],
    severity: 'HIGH',
    basis: 'EXECUTED',
    evidence_strength: 'REPRODUCED',
    peer_responses: [
      { claim: 'X3', response: 'conceded' },
      { claim: 'Y7', response: 'disputed-no-counter-fact' },
    ],
    auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
    final_state: 'settled-agree',
    evidence: ['X3 ran it', 'Y7 saw the same bug independently'],
    ...overrides,
  };
}

test('translateFindings: X/Y origins translate to real A/B claim IDs, evidence stays verbatim, independently_discovered derived mechanically', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding(),
      validFinding({
        id: 'F2',
        origins: ['X5'],
        peer_responses: [{ claim: 'X5', response: 'conceded' }],
        evidence: ['X5 only, mentions X11 forwarding literally'],
      }),
      validFinding({ id: 'F3', origins: ['X1', 'X2'], peer_responses: [{ claim: 'X1', response: 'conceded' }, { claim: 'X2', response: 'conceded' }] }),
    ],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, null);
  assert.equal(result.protocol, 'review-protocol-v1.3');
  assert.deepEqual(result.findings[0].origins, ['A3', 'B7']);
  assert.equal(result.findings[0].independently_discovered, true, 'spans both seats');
  assert.equal(result.findings[1].evidence[0], 'X5 only, mentions X11 forwarding literally', 'evidence is exempt from translation, byte-identical');
  assert.deepEqual(result.findings[1].origins, ['A5']);
  assert.equal(result.findings[1].independently_discovered, false, 'single origin');
  assert.deepEqual(result.findings[2].origins, ['A1', 'A2']);
  assert.equal(result.findings[2].independently_discovered, false, 'both origins same seat');
});

test('translateFindings: the reverse coin-flip mapping ({A:Y,B:X}) translates correctly', async () => {
  const audit = JSON.stringify({ findings: [validFinding({ origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }] })] });
  const result = await translateFindings(audit, { A: 'Y', B: 'X' }, null);
  assert.deepEqual(result.findings[0].origins, ['B3']);
});

test('translateFindings: refuses invalid --in JSON, a malformed mapping, and a missing findings array', async () => {
  await assert.rejects(translateFindings('not json', { A: 'X', B: 'Y' }, null), RelayError);
  await assert.rejects(
    translateFindings(JSON.stringify({ findings: [] }), { A: 'X', B: 'X' }, null),
    RelayError
  );
  await assert.rejects(translateFindings(JSON.stringify({}), { A: 'X', B: 'Y' }, null), RelayError);
});

test('translateFindings: refuses an origin that fails to translate to a real A<n>/B<n> claim ID', async () => {
  const audit = JSON.stringify({ findings: [validFinding({ origins: ['Z9'], peer_responses: [{ claim: 'Z9', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, null), /not a real/);
});

test('translateFindings: refuses a finding with an empty origins array', async () => {
  const audit = JSON.stringify({ findings: [validFinding({ origins: [] })] });
  await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, null), /no origins/);
});

test('translateFindings: refuses a finding whose evidence is missing, non-array, empty, or contains a non-string/empty entry', async () => {
  const cases = [
    validFinding({ evidence: undefined }),
    validFinding({ evidence: 'not an array' }),
    validFinding({ evidence: [] }),
    validFinding({ evidence: [42] }),
    validFinding({ evidence: [''] }),
  ];
  for (const finding of cases) {
    const audit = JSON.stringify({ findings: [finding] });
    await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, null), /has no evidence/);
  }
});

test('translateFindings: refuses a non-string peer_responses[].claim or verifications[].claim', async (t) => {
  const badPeerClaim = JSON.stringify({
    findings: [validFinding({ peer_responses: [{ claim: 42, response: 'conceded' }, { claim: 'Y7', response: 'conceded' }] })],
  });
  await assert.rejects(translateFindings(badPeerClaim, { A: 'X', B: 'Y' }, null), /peer_responses\[\]\.claim/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-bad-verif-claim-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const badVerificationClaim = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 42, verdict: 'CONFIRMED' }] })],
  });
  await assert.rejects(translateFindings(badVerificationClaim, { A: 'X', B: 'Y' }, null, dir), /verifications\[\]\.claim/);
});

test('translateFindings: refuses a verifications entry when --verification-dir is not supplied -- not an opt-out mechanism', async () => {
  const withVerifications = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  await assert.rejects(translateFindings(withVerifications, { A: 'X', B: 'Y' }, null, null), /--verification-dir was not supplied/);
});

test('translateFindings: with --phase1-dir, a real translated claim ID passes and a hallucinated one is refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-phase1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real claim\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: something\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const real = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  const result = await translateFindings(real, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].origins, ['A1']);

  const hallucinated = JSON.stringify({ findings: [validFinding({ origins: ['X9'], peer_responses: [{ claim: 'X9', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(hallucinated, { A: 'X', B: 'Y' }, dir), /no "## A9" heading/);
});

test('translateFindings: a claim heading appearing only inside a fenced Evidence block does not count as a real Phase 1 claim', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-fenced-heading-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real finding\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```text\n## A99 — literal text inside evidence\n```\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');

  // Fabrication direction: an origin citing the fenced "A99" must be refused, not accepted as real.
  const fabricated = JSON.stringify({ findings: [validFinding({ origins: ['X99'], peer_responses: [{ claim: 'X99', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(fabricated, { A: 'X', B: 'Y' }, dir), /no "## A99" heading/);

  // Coverage direction: the real "A1" claim, with no fenced-heading false coverage credit for "A99".
  const real = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  const result = await translateFindings(real, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].origins, ['A1']);
});

test('translateFindings: with --phase1-dir, basis/evidence_strength/evidence are derived mechanically from the origin claim block, overwriting whatever the auditor supplied', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-single-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real claim\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nran it live\n```\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const audit = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      severity: 'LOW',
      basis: 'INFERENCE',
      evidence_strength: 'SPECULATIVE',
      peer_responses: [{ claim: 'X1', response: 'conceded' }],
      evidence: ['auditor typed this condensed summary'],
    })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  const f = result.findings[0];
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.basis, 'EXECUTED');
  assert.equal(f.evidence_strength, 'REPRODUCED');
  assert.deepEqual(f.evidence, ['ran it live']);
});

test('translateFindings: with --phase1-dir, a multi-origin finding takes the single STRONGEST value per field across origins, and one evidence entry per origin in origins[] order', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-multi-origin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — weaker origin\nSeverity: MEDIUM\nBasis: SOURCE_CITATION\nEvidence strength: SUPPORTED\nEvidence:\n```\nA1 evidence text\n```\n'
  );
  await fs.writeFile(
    path.join(dir, 'B-findings.md'),
    '# Seat B findings\n\n## B1 — stronger origin\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nB1 evidence text\n```\n'
  );
  const audit = JSON.stringify({
    findings: [validFinding({
      origins: ['X1', 'Y1'],
      severity: 'LOW',
      basis: 'INFERENCE',
      evidence_strength: 'SPECULATIVE',
      peer_responses: [
        { claim: 'X1', response: 'conceded' },
        { claim: 'Y1', response: 'conceded' },
      ],
      evidence: ['auditor summary only'],
    })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  const f = result.findings[0];
  assert.deepEqual(f.origins, ['A1', 'B1']);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.basis, 'EXECUTED');
  assert.equal(f.evidence_strength, 'REPRODUCED');
  assert.equal(f.basis_from, 'B1');
  assert.deepEqual(f.evidence, ['A1 evidence text', 'B1 evidence text']);
});

test('translateFindings: with --phase1-dir, basis/evidence_strength are copied as a PAIR from the single strongest-evidenced origin (basis-primary tiebreak), never independently maximized per field into a combination no origin actually had', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-crossed-strength-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A1: EXECUTED + SUPPORTED. B1: STATIC_TRACE + REPRODUCED. Neither origin ever asserted
  // EXECUTED + REPRODUCED -- independent-per-field-max would synthesize exactly that pair.
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — executed but weakly evidenced\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: SUPPORTED\nEvidence:\n```\nA1 evidence text\n```\n'
  );
  await fs.writeFile(
    path.join(dir, 'B-findings.md'),
    '# Seat B findings\n\n## B1 — traced but strongly evidenced\nSeverity: HIGH\nBasis: STATIC_TRACE\nEvidence strength: REPRODUCED\nEvidence:\n```\nB1 evidence text\n```\n'
  );
  const audit = JSON.stringify({
    findings: [validFinding({
      origins: ['X1', 'Y1'],
      peer_responses: [
        { claim: 'X1', response: 'conceded' },
        { claim: 'Y1', response: 'conceded' },
      ],
    })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  const f = result.findings[0];
  // basis is primary: EXECUTED (A1) outranks STATIC_TRACE (B1), so A1 is the strongest-evidenced
  // origin and BOTH fields come from it -- not EXECUTED (from A1) + REPRODUCED (from B1).
  assert.equal(f.basis, 'EXECUTED');
  assert.equal(f.evidence_strength, 'SUPPORTED');
  assert.equal(f.basis_from, 'A1');
});

test('translateFindings: with --phase1-dir, when two origins tie on basis, evidence_strength is the secondary tiebreak (still a pair from one origin)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-basis-tie-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — tied basis, weaker strength\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: SUPPORTED\nEvidence:\n```\nA1 evidence text\n```\n'
  );
  await fs.writeFile(
    path.join(dir, 'B-findings.md'),
    '# Seat B findings\n\n## B1 — tied basis, stronger strength\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nB1 evidence text\n```\n'
  );
  const audit = JSON.stringify({
    findings: [validFinding({
      origins: ['X1', 'Y1'],
      peer_responses: [
        { claim: 'X1', response: 'conceded' },
        { claim: 'Y1', response: 'conceded' },
      ],
    })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  const f = result.findings[0];
  assert.equal(f.basis, 'EXECUTED');
  assert.equal(f.evidence_strength, 'REPRODUCED');
  assert.equal(f.basis_from, 'B1');
});

test('translateFindings: with --phase1-dir, an Evidence fence WITH an info string (```text, as Codex/real fixtures write it) still derives the evidence body correctly, stripping only the fence markers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-info-string-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real claim\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```text\nbody line\n```\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const audit = JSON.stringify({
    findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].evidence, ['body line']);
});

test('translateFindings: with --phase1-dir, a bare ``` mid-fence inside a ~~~-opened Evidence block stays evidence CONTENT, not a false closer', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-tilde-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real claim\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n~~~\nliteral ```\n~~~\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const audit = JSON.stringify({
    findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].evidence, ['literal ```']);
});

test('translateFindings: with --phase1-dir, refuses (does not silently trust the auditor) when an origin claim block is missing a recognized Severity/Basis/Evidence strength/Evidence line', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-missing-field-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');

  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — no severity line\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n');
  const missingSeverity = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(missingSeverity, { A: 'X', B: 'Y' }, dir), /origin "A1" has no recognized "Severity:" line/);

  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — bad basis\nSeverity: HIGH\nBasis: MADE_UP_VALUE\nEvidence strength: REPRODUCED\nEvidence: e\n');
  const badBasis = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(badBasis, { A: 'X', B: 'Y' }, dir), /origin "A1" has no recognized "Basis:" line/);

  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — no evidence body\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\n');
  const missingEvidence = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(missingEvidence, { A: 'X', B: 'Y' }, dir), /origin "A1" has no non-empty "Evidence:" body/);
});

test('translateFindings: with --phase1-dir, a "---" thematic break between claims (a real Phase 1 output shape) terminates the evidence body and does not leak into it, and does not get mistaken for a new claim', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-derive-thematic-break-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real claim\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\nprose before\n\n```\nfenced body\n```\nprose after\n\n---\n\n## A2 — second\nSeverity: LOW\nBasis: INFERENCE\nEvidence strength: SPECULATIVE\nEvidence: e2\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const audit = JSON.stringify({
    findings: [
      validFinding({ id: 'F1', origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] }),
      validFinding({ id: 'F2', origins: ['X2'], peer_responses: [{ claim: 'X2', response: 'conceded' }] }),
    ],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  // Evidence ends at the fence group's close, so "prose after" (commentary) is not evidence either.
  assert.deepEqual(result.findings[0].evidence, ['prose before\n\nfenced body']);
  assert.deepEqual(result.findings[1].evidence, ['e2']);
});

test('translateFindings: without --phase1-dir, the auditor-supplied severity/basis/evidence_strength/evidence are still trusted as before (opt-in, not automatic)', async () => {
  const audit = JSON.stringify({
    findings: [validFinding({
      severity: 'LOW',
      basis: 'INFERENCE',
      evidence_strength: 'SPECULATIVE',
      evidence: ['whatever the auditor wrote'],
    })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, null);
  const f = result.findings[0];
  assert.equal(f.severity, 'LOW');
  assert.equal(f.basis, 'INFERENCE');
  assert.equal(f.evidence_strength, 'SPECULATIVE');
  assert.deepEqual(f.evidence, ['whatever the auditor wrote']);
});

test('translateFindings: an inline-code span prefixing a heading-shaped string does not fabricate a Phase 1 claim (heading detection uses the RAW line, not the code-stripped one)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-inline-prefix-heading-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    // Stripping "`prefix`" would shift "## A99..." to position 0 -- a real Markdown renderer
    // never treats this as a heading, since the backtick span still occupies that position.
    '# Seat A findings\n\n## A1 — real finding\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n`prefix`## A99 — this is not a heading\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');

  const fabricated = JSON.stringify({ findings: [validFinding({ origins: ['X99'], peer_responses: [{ claim: 'X99', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(fabricated, { A: 'X', B: 'Y' }, dir), /no "## A99" heading/);

  // Coverage direction too: A99 must not silently satisfy coverage for itself if it somehow
  // appeared as an origin elsewhere -- there is no real A99 claim to be covered or dropped.
  const real = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  const result = await translateFindings(real, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].origins, ['A1']);
});

test('translateFindings: an unterminated fenced code block in a Phase 1 findings file is refused, not silently scanned past', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-phase1-unterminated-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — real\nEvidence:\n```text\nunterminated fence, A2 never reachable\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');

  const audit = JSON.stringify({ findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, dir), /unterminated fenced code block/);
});

test('translateFindings: with --phase1-dir, refuses when a real Phase 1 claim is omitted from every finding (coverage)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-coverage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — first\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n## A2 — second\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n'
  );
  await fs.writeFile(
    path.join(dir, 'B-findings.md'),
    '# Seat B findings\n\n## B1 — first\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n'
  );

  const missingA2 = JSON.stringify({
    findings: [
      validFinding({ id: 'F1', origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] }),
      validFinding({ id: 'F2', origins: ['Y1'], peer_responses: [{ claim: 'Y1', response: 'conceded' }] }),
    ],
  });
  await assert.rejects(translateFindings(missingA2, { A: 'X', B: 'Y' }, dir), /A2.*do not appear as an origin/s);

  const complete = JSON.stringify({
    findings: [
      validFinding({ id: 'F1', origins: ['X1', 'X2'], peer_responses: [{ claim: 'X1', response: 'conceded' }, { claim: 'X2', response: 'conceded' }] }),
      validFinding({ id: 'F2', origins: ['Y1'], peer_responses: [{ claim: 'Y1', response: 'conceded' }] }),
    ],
  });
  const result = await translateFindings(complete, { A: 'X', B: 'Y' }, dir);
  assert.equal(result.findings.length, 2);
});

test('translateFindings: with --phase1-dir, a seat with zero Phase 1 claims does not force a spurious coverage failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-coverage-zero-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — only\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings this pass)\n');

  const audit = JSON.stringify({
    findings: [validFinding({ origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] })],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  assert.equal(result.findings.length, 1);
});

test('translateFindings: verifications translate, evidence/basis are populated from the verifier file, and a claim outside origins or a bad verdict is refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-shape-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-Y7.md'),
    'Claim: Y7\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: ran it, mentions X11 forwarding literally\n'
  );

  const ok = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        verifications: [{ claim: 'Y7', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  const result = await translateFindings(ok, { A: 'X', B: 'Y' }, null, dir);
  assert.deepEqual(result.findings[0].verifications, [
    { claim: 'B7', verdict: 'CONFIRMED', basis: 'EXECUTED', evidence: 'ran it, mentions X11 forwarding literally' },
  ]);

  const wrongClaim = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 'X9', verdict: 'CONFIRMED' }] })],
  });
  await assert.rejects(translateFindings(wrongClaim, { A: 'X', B: 'Y' }, null, dir), /which is not one of/);

  const dupClaim = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        verifications: [
          { claim: 'X3', verdict: 'CONFIRMED' },
          { claim: 'X3', verdict: 'REFUTED' },
        ],
      }),
    ],
  });
  await assert.rejects(translateFindings(dupClaim, { A: 'X', B: 'Y' }, null, dir), /more than one verification/);

  const badVerdict = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 'X3', verdict: 'MAYBE' }] })],
  });
  await assert.rejects(translateFindings(badVerdict, { A: 'X', B: 'Y' }, null, dir), /verdict "MAYBE"/);
});

// Class sweep across all 5 final_states x verifications[] verdict combos:
// settled-agree    x REFUTED   -> refused (this test, and the pre-existing auditor_check.REFUTED case)
// settled-refuted  x CONFIRMED -> refused (this test, and the pre-existing auditor_check.CONFIRMED case)
// dropped-speculative x any verdict -> refused (separate test below: any non-empty verifications[])
// unresolved-low-stakes / unresolved-high-stakes x any verdict -> no contradiction is definable for an
//   unresolved state (it asserts nothing settled either way), so no check applies here by design.
test('translateFindings: refuses any verification whose verdict contradicts final_state, regardless of origin count -- a canonical finding groups claims asserting the SAME defect (review-protocol.md "Canonical findings"), so a CONFIRMED/REFUTED verdict on any one origin speaks for the finding as a whole', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-contradiction-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');

  const confirmedButRefuted = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [{ claim: 'X3', response: 'conceded' }],
        final_state: 'settled-refuted',
        verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  await assert.rejects(translateFindings(confirmedButRefuted, { A: 'X', B: 'Y' }, null, dir), /contradicts it/);

  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-contradiction2-'));
  t.after(() => fs.rm(dir2, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir2, 'verification-X3.md'), 'Claim: X3\nVerdict: REFUTED\nBasis: EXECUTED\nEvidence: e\n');

  const refutedButAgree = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [{ claim: 'X3', response: 'conceded' }],
        final_state: 'settled-agree',
        verifications: [{ claim: 'X3', verdict: 'REFUTED' }],
      }),
    ],
  });
  await assert.rejects(translateFindings(refutedButAgree, { A: 'X', B: 'Y' }, null, dir2), /contradicts it/);

  // Multi-origin: settled-refuted's general refutation-provenance requirement still applies --
  // a peer counter-fact, an auditor_check REFUTED, or some verifications[] REFUTED must exist.
  // (No verifications at all here, so this exercises the provenance check, not the new
  // any-CONFIRMED/any-REFUTED contradiction check above.)
  const multiOriginNoProvenance = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        final_state: 'settled-refuted',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(multiOriginNoProvenance, { A: 'X', B: 'Y' }, null, null),
    /no refutation provenance exists/
  );

  // A multi-origin finding with a CONFIRMED verdict on one origin and settled-refuted must be
  // refused even though a DIFFERENT origin was independently REFUTED: origins of one canonical
  // finding assert the SAME defect (review-protocol.md), so a verifier confirming X3 directly
  // contradicts the finding being settled as refuted, no matter what Y7's own verdict says.
  const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-contradiction3-'));
  t.after(() => fs.rm(dir3, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir3, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');
  await fs.writeFile(path.join(dir3, 'verification-Y7.md'), 'Claim: Y7\nVerdict: REFUTED\nBasis: EXECUTED\nEvidence: e2\n');

  const multiOriginMixedVerdicts = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        final_state: 'settled-refuted',
        verifications: [
          { claim: 'X3', verdict: 'CONFIRMED' },
          { claim: 'Y7', verdict: 'REFUTED' },
        ],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(multiOriginMixedVerdicts, { A: 'X', B: 'Y' }, null, dir3),
    /contradicts it/
  );

  // Symmetric case: any REFUTED verdict on any origin forbids settled-agree, even in a
  // multi-origin finding with no CONFIRMED verdict anywhere.
  const dir4 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-contradiction4-'));
  t.after(() => fs.rm(dir4, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir4, 'verification-Y7.md'), 'Claim: Y7\nVerdict: REFUTED\nBasis: EXECUTED\nEvidence: e\n');

  const multiOriginRefutedAgree = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        final_state: 'settled-agree',
        verifications: [{ claim: 'Y7', verdict: 'REFUTED' }],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(multiOriginRefutedAgree, { A: 'X', B: 'Y' }, null, dir4),
    /contradicts it/
  );

  // Non-contradicting multi-origin case must still pass: a lone CONFIRMED verdict with
  // final_state settled-agree (no REFUTED anywhere) is consistent, not a contradiction.
  const dir5 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-contradiction5-'));
  t.after(() => fs.rm(dir5, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir5, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');

  const multiOriginConsistent = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        final_state: 'settled-agree',
        verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  const result = await translateFindings(multiOriginConsistent, { A: 'X', B: 'Y' }, null, dir5);
  assert.equal(result.findings[0].final_state, 'settled-agree');
});

test('translateFindings: auditor_check is required, its enum is enforced, and basis/evidence must be null iff NOT_CHECKED', async () => {
  const missing = JSON.stringify({ findings: [validFinding({ auditor_check: undefined })] });
  await assert.rejects(translateFindings(missing, { A: 'X', B: 'Y' }, null, null), /missing a required auditor_check/);

  const badEnum = JSON.stringify({
    findings: [validFinding({ auditor_check: { result: 'MAYBE', basis: null, evidence: null } })],
  });
  await assert.rejects(translateFindings(badEnum, { A: 'X', B: 'Y' }, null, null), /auditor_check\.result/);

  const notCheckedWithBasis = JSON.stringify({
    findings: [validFinding({ auditor_check: { result: 'NOT_CHECKED', basis: 'STATIC_TRACE', evidence: null } })],
  });
  await assert.rejects(translateFindings(notCheckedWithBasis, { A: 'X', B: 'Y' }, null, null), /both must be null/);

  const checkedWithoutEvidence = JSON.stringify({
    findings: [validFinding({ auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE', evidence: '' } })],
  });
  await assert.rejects(translateFindings(checkedWithoutEvidence, { A: 'X', B: 'Y' }, null, null), /missing or empty evidence/);

  const valid = JSON.stringify({
    findings: [validFinding({ auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE', evidence: 'traced it' } })],
  });
  const result = await translateFindings(valid, { A: 'X', B: 'Y' }, null, null);
  assert.deepEqual(result.findings[0].auditor_check, { result: 'CONFIRMED', basis: 'STATIC_TRACE', evidence: 'traced it' });
});

test('translateFindings: settled-refuted requires refutation provenance (peer counter-fact, auditor_check REFUTED, or a REFUTED verification)', async () => {
  const noProvenance = JSON.stringify({
    findings: [validFinding({
      peer_responses: [
        { claim: 'X3', response: 'conceded' },
        { claim: 'Y7', response: 'unaddressed' },
      ],
      final_state: 'settled-refuted',
    })],
  });
  await assert.rejects(translateFindings(noProvenance, { A: 'X', B: 'Y' }, null, null), /no refutation provenance exists/);

  const withPeerCounterFact = JSON.stringify({
    findings: [validFinding({
      peer_responses: [
        { claim: 'X3', response: 'conceded' },
        { claim: 'Y7', response: 'disputed-with-counter-fact' },
      ],
      final_state: 'settled-refuted',
    })],
  });
  const r1 = await translateFindings(withPeerCounterFact, { A: 'X', B: 'Y' }, null, null);
  assert.equal(r1.findings[0].final_state, 'settled-refuted');

  const withAuditorCheck = JSON.stringify({
    findings: [validFinding({
      peer_responses: [
        { claim: 'X3', response: 'conceded' },
        { claim: 'Y7', response: 'unaddressed' },
      ],
      auditor_check: { result: 'REFUTED', basis: 'STATIC_TRACE', evidence: 'traced it' },
      final_state: 'settled-refuted',
    })],
  });
  const r2 = await translateFindings(withAuditorCheck, { A: 'X', B: 'Y' }, null, null);
  assert.equal(r2.findings[0].final_state, 'settled-refuted');
});

test('translateFindings: settled-agree requires positive agreement provenance (independently_discovered, a conceded peer response, or a CONFIRMED verification) -- absence of refutation is not proof of agreement', async (t) => {
  const noProvenance = JSON.stringify({
    findings: [
      {
        id: 'F1',
        origins: ['X1'],
        severity: 'MEDIUM',
        basis: 'INFERENCE',
        evidence_strength: 'PLAUSIBLE',
        evidence: ['some evidence'],
        peer_responses: [{ claim: 'X1', response: 'unaddressed' }],
        auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
        final_state: 'settled-agree',
      },
    ],
  });
  await assert.rejects(
    translateFindings(noProvenance, { A: 'X', B: 'Y' }, null, null),
    /no agreement provenance exists/
  );

  // Route 1: independently_discovered (derived from origins spanning both seats) is sufficient
  // on its own, even with an unaddressed peer response and no auditor/verifier check.
  const viaIndependentDiscovery = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        peer_responses: [
          { claim: 'X3', response: 'unaddressed' },
          { claim: 'Y7', response: 'unaddressed' },
        ],
        final_state: 'settled-agree',
      }),
    ],
  });
  const r1 = await translateFindings(viaIndependentDiscovery, { A: 'X', B: 'Y' }, null, null);
  assert.equal(r1.findings[0].final_state, 'settled-agree');

  // Route 2: a single conceded peer response is sufficient, single-origin, no auditor/verifier.
  const viaConceded = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [{ claim: 'X3', response: 'conceded' }],
        final_state: 'settled-agree',
      }),
    ],
  });
  const r2 = await translateFindings(viaConceded, { A: 'X', B: 'Y' }, null, null);
  assert.equal(r2.findings[0].final_state, 'settled-agree');

  // Route 3: a CONFIRMED falsification verifier is sufficient, single-origin, auditor
  // NOT_CHECKED -- matches review-protocol.md's "or a falsification-pass verifier returned
  // CONFIRMED" clause of the settled-agree table row. Peer response is disputed-no-counter-fact,
  // not unaddressed: review-protocol.md's Falsification pass only ever runs on a claim with a
  // DISPUTE rebuttal (an unaddressed claim has no rebuttal entry at all, so no verifier for it
  // could exist in a protocol-valid run).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-settled-agree-verifier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');
  const viaVerifier = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [{ claim: 'X3', response: 'disputed-no-counter-fact' }],
        final_state: 'settled-agree',
        verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  const r3 = await translateFindings(viaVerifier, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(r3.findings[0].final_state, 'settled-agree');
});
test('translateFindings: refuses settled-agree with auditor_check.result CONFIRMED alone as provenance -- review-protocol.md has no route for this, unlike settled-refuted which explicitly lists auditor_check REFUTED', async () => {
  const auditorConfirmedAlone = JSON.stringify({
    findings: [
      {
        id: 'F1',
        origins: ['X1'],
        severity: 'MEDIUM',
        basis: 'INFERENCE',
        evidence_strength: 'PLAUSIBLE',
        evidence: ['some evidence'],
        peer_responses: [{ claim: 'X1', response: 'unaddressed' }],
        auditor_check: { result: 'CONFIRMED', basis: 'EXECUTED', evidence: 'the auditor ran it' },
        final_state: 'settled-agree',
      },
    ],
  });
  await assert.rejects(
    translateFindings(auditorConfirmedAlone, { A: 'X', B: 'Y' }, null, null),
    /no agreement provenance exists/
  );
});

test('translateFindings: refuses settled-agree when a peer_responses entry is disputed-with-counter-fact, even when another origin in the same finding independently satisfies agreement provenance', async () => {
  const counterFactAgainst = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        peer_responses: [
          { claim: 'X3', response: 'conceded' },
          { claim: 'Y7', response: 'disputed-with-counter-fact' },
        ],
        final_state: 'settled-agree',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(counterFactAgainst, { A: 'X', B: 'Y' }, null, null),
    /disputed-with-counter-fact.*no verifications\[\] entry of "CONFIRMED"/
  );
});

test('translateFindings: a falsification verifier\'s CONFIRMED verdict overrides a disputed-with-counter-fact peer response for settled-agree, matching review-protocol.md\'s "falsification-pass verifier returned CONFIRMED" route for a disputed claim', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-settled-agree-verifier-override-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X3.md'),
    'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: verified the counter-fact does not hold, original claim stands\n'
  );
  const disputedButVerifierConfirmed = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [{ claim: 'X3', response: 'disputed-with-counter-fact' }],
        final_state: 'settled-agree',
        verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  const result = await translateFindings(disputedButVerifierConfirmed, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].final_state, 'settled-agree');

  // Without a verifier, the same dispute must still refuse -- proves the override requires an
  // actual CONFIRMED verification, not merely the absence of the old unconditional check. Needs
  // a second, conceding origin so the finding clears the earlier positive-provenance check and
  // actually reaches the counter-fact check (a lone disputed-with-counter-fact origin with no
  // other provenance is refused by the EARLIER check first, same as the existing multi-origin
  // counter-fact test above).
  const disputedNoVerifier = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        peer_responses: [
          { claim: 'X3', response: 'conceded' },
          { claim: 'Y7', response: 'disputed-with-counter-fact' },
        ],
        final_state: 'settled-agree',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(disputedNoVerifier, { A: 'X', B: 'Y' }, null, null),
    /no verifications\[\] entry of "CONFIRMED"/
  );
});

test('translateFindings: refuses settled-agree when auditor_check.result is REFUTED', async () => {
  const contradiction = JSON.stringify({
    findings: [validFinding({
      auditor_check: { result: 'REFUTED', basis: 'STATIC_TRACE', evidence: 'traced it' },
      final_state: 'settled-agree',
    })],
  });
  await assert.rejects(
    translateFindings(contradiction, { A: 'X', B: 'Y' }, null, null),
    /auditor_check\.result "REFUTED" -- the auditor cannot both/
  );
});

test('translateFindings: refuses settled-refuted when auditor_check.result is CONFIRMED, even when a peer counter-fact also exists', async () => {
  const contradiction = JSON.stringify({
    findings: [validFinding({
      peer_responses: [
        { claim: 'X3', response: 'conceded' },
        { claim: 'Y7', response: 'disputed-with-counter-fact' },
      ],
      auditor_check: { result: 'CONFIRMED', basis: 'STATIC_TRACE', evidence: 'auditor independently confirmed the bug' },
      final_state: 'settled-refuted',
    })],
  });
  await assert.rejects(
    translateFindings(contradiction, { A: 'X', B: 'Y' }, null, null),
    /auditor_check\.result "CONFIRMED" -- the auditor cannot both independently confirm/
  );
});

test('translateFindings: auditor_check.basis is enum-enforced the same way a verification file\'s Basis: line is, not merely a non-empty string', async () => {
  const badBasis = JSON.stringify({
    findings: [validFinding({ auditor_check: { result: 'CONFIRMED', basis: 'MAGIC', evidence: 'auditor said so' } })],
  });
  await assert.rejects(
    translateFindings(badBasis, { A: 'X', B: 'Y' }, null, null),
    /auditor_check\.basis "MAGIC"/
  );
});

test('translateFindings: with --verification-dir, checks both directions (cited file missing, and an uncited file on disk)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verification-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const cited = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  await assert.rejects(translateFindings(cited, { A: 'X', B: 'Y' }, null, dir), /does not exist/);

  await fs.writeFile(path.join(dir, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');
  const result = await translateFindings(cited, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].claim, 'A3');

  await fs.writeFile(path.join(dir, 'verification-Y7.md'), 'an uncited leftover verdict\n');
  await assert.rejects(translateFindings(cited, { A: 'X', B: 'Y' }, null, dir), /no finding cites a verification/);
});

test('translateFindings: an inline-code span prefixing a "Claim:"/"Verdict:" line does not satisfy the verifier schema (RAW line, not code-stripped)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-inline-prefix-verifier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X1.md'),
    '`prefix`Claim: X1\n`prefix`Verdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n'
  );

  const cited = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      peer_responses: [{ claim: 'X1', response: 'conceded' }],
      verifications: [{ claim: 'X1', verdict: 'CONFIRMED' }],
    })],
  });
  await assert.rejects(translateFindings(cited, { A: 'X', B: 'Y' }, null, dir), /missing a "Claim:/);
});

test('translateFindings: refuses when the auditor contradicts the verifier file\'s own recorded verdict', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verification-contradict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'verification-X1.md'), 'Claim: X1\nVerdict: REFUTED\nBasis: EXECUTED\nEvidence: independent verifier disproved it\n');

  const contradicting = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      peer_responses: [{ claim: 'X1', response: 'disputed-no-counter-fact' }],
      verifications: [{ claim: 'X1', verdict: 'CONFIRMED' }],
    })],
  });
  await assert.rejects(translateFindings(contradicting, { A: 'X', B: 'Y' }, null, dir), /is authoritative, not the auditor/);

  const agreeing = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      peer_responses: [{ claim: 'X1', response: 'disputed-no-counter-fact' }],
      final_state: 'settled-refuted',
      verifications: [{ claim: 'X1', verdict: 'REFUTED' }],
    })],
  });
  const result = await translateFindings(agreeing, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].verdict, 'REFUTED');
  assert.equal(result.findings[0].verifications[0].evidence, 'independent verifier disproved it');
});

test('translateFindings: a verification file\'s "Claim:"/"Verdict:" lines parse correctly with trailing punctuation or parenthetical prose', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verification-trailing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X1.md'),
    'Claim: X1.\nVerdict: REFUTED (see evidence below)\nBasis: EXECUTED.\nEvidence: ran it, confirmed broken\n'
  );

  const cited = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      peer_responses: [{ claim: 'X1', response: 'disputed-no-counter-fact' }],
      final_state: 'settled-refuted',
      verifications: [{ claim: 'X1', verdict: 'REFUTED' }],
    })],
  });
  const result = await translateFindings(cited, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].verdict, 'REFUTED');
  assert.equal(result.findings[0].verifications[0].basis, 'EXECUTED');
});

test('translateFindings: the verifier file is authoritative for basis/evidence too, not only verdict -- an auditor-supplied evidence/basis is discarded and replaced', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-evidence-authority-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X3.md'),
    'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: verifier says ORIGINAL\n'
  );

  const withAuditorEvidence = JSON.stringify({
    findings: [validFinding({
      origins: ['X3', 'Y7'],
      verifications: [{ claim: 'X3', verdict: 'CONFIRMED', basis: 'INFERENCE', evidence: 'AUDITOR CHANGED EVIDENCE' }],
    })],
  });
  const result = await translateFindings(withAuditorEvidence, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].evidence, 'verifier says ORIGINAL');
  assert.equal(result.findings[0].verifications[0].basis, 'EXECUTED');
});

test('translateFindings: verifier evidence on a line after "Evidence:" preserves real leading indentation and internal blank lines, matching the documented "verbatim" guarantee', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-evidence-verbatim-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X3.md'),
    'Claim: X3\nVerdict: CONFIRMED\nBasis: STATIC_TRACE\nEvidence:\n    four-space-indented evidence\n'
  );
  const withIndentedEvidence = JSON.stringify({
    findings: [validFinding({ origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  const result = await translateFindings(withIndentedEvidence, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].evidence, '    four-space-indented evidence');

  // Interior blank lines between real content must survive; only the leading blank line right
  // after "Evidence:" and trailing blank line(s) from the file's own terminator are structural.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-evidence-verbatim2-'));
  t.after(() => fs.rm(dir2, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir2, 'verification-X3.md'),
    'Claim: X3\nVerdict: CONFIRMED\nBasis: STATIC_TRACE\nEvidence:\nfirst line\n\nsecond line after a blank\n'
  );
  const withInteriorBlank = JSON.stringify({
    findings: [validFinding({ origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  const result2 = await translateFindings(withInteriorBlank, { A: 'X', B: 'Y' }, null, dir2);
  assert.equal(result2.findings[0].verifications[0].evidence, 'first line\n\nsecond line after a blank');
});

test('translateFindings: a CRLF verifier file trims the structural leading/trailing blank lines ("\\r" only, not "") the same way an LF file does, so CRLF and LF get identical evidence-body treatment', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-evidence-crlf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X3.md'),
    'Claim: X3\r\nVerdict: CONFIRMED\r\nBasis: STATIC_TRACE\r\nEvidence:\r\nfirst line\r\nsecond line\r\n'
  );
  const withCrlf = JSON.stringify({
    findings: [validFinding({ origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  const result = await translateFindings(withCrlf, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].evidence, 'first line\r\nsecond line');
});

test('relabelText: a genuine interior \\r\\n inside a fenced Evidence block on an otherwise-LF file is preserved byte-exact, not stripped -- parseFenceLines tracks each line\'s OWN terminator instead of guessing one file-level eol from the first line, since a mixed-EOL fence (e.g. pasted Windows tool output) is real content, not a signal to normalize', () => {
  const text = '# Seat A findings\n\n## A1 — bug\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nline-one\r\nline-two\n```\n';
  const out = relabelText(text, 'A', 'P');
  assert.ok(out.includes('line-one\r\nline-two'), 'interior \\r\\n inside the fence must survive relabel unchanged');
  assert.match(out, /^# Peer findings\n/, 'the file-level LF structure outside the fence must stay LF, not get upgraded by the fence\'s own CRLF');
});

test('extractClaimBlocks: a genuine interior \\r\\n inside a fenced Evidence block on an otherwise-LF file is preserved byte-exact in the extracted evidence string', () => {
  const text = '# Seat A findings\n\n## A1 — bug\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nline-one\r\nline-two\n```\n';
  const { blocks } = extractClaimBlocks(text);
  assert.equal(blocks.get('A1').evidence, 'line-one\r\nline-two');
});

test('translateFindings: a genuine interior \\r\\n inside a verifier file\'s multi-line Evidence body, on an otherwise-LF verification file, is preserved byte-exact -- this is the mixed-EOL case an all-CRLF or all-LF fixture cannot distinguish from "normalized away"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-evidence-mixed-eol-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'verification-X3.md'),
    'Claim: X3\nVerdict: CONFIRMED\nBasis: STATIC_TRACE\nEvidence:\nfirst line\r\nsecond line\n'
  );
  const withMixedEol = JSON.stringify({
    findings: [validFinding({ origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  const result = await translateFindings(withMixedEol, { A: 'X', B: 'Y' }, null, dir);
  assert.equal(result.findings[0].verifications[0].evidence, 'first line\r\nsecond line');
});

test('relabelText: a bare \\n inside a fenced Evidence block on an otherwise-CRLF file stays a bare \\n, never silently upgraded to \\r\\n by the surrounding file\'s own line ending', () => {
  const text = '# Seat A findings\r\n\r\n## A1 — bug\r\nSeverity: HIGH\r\nBasis: EXECUTED\r\nEvidence strength: REPRODUCED\r\nEvidence:\r\n```\r\nline-one\nline-two\r\n```\r\n';
  const out = relabelText(text, 'A', 'P');
  assert.ok(out.includes('line-one\nline-two'), 'bare interior \\n inside the fence must survive unchanged');
  assert.ok(!out.includes('line-one\r\nline-two'), 'the bare \\n must not be upgraded to \\r\\n just because the rest of the file is CRLF');
  assert.match(out, /^# Peer findings\r\n/, 'the file-level CRLF structure outside the fence must stay CRLF');
});

test('relabelText: a fence closer with trailing whitespace (CommonMark-legal, e.g. an editor\'s trailing-whitespace-on-save) still closes the fence, not flagged as unterminated -- the close-fence regex\'s "\\\\s*$" must stay a real backslash-escaped whitespace class, never a literal "s*$" from an unescaped template-literal backslash', () => {
  const text = '# Seat A findings\n\n## A1 — bug\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n```\nsome content\n```  \n';
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^# Peer findings\n/, 'relabel must succeed, not throw "unterminated fenced code block"');
  assert.ok(out.includes('some content'), 'the fenced body must survive untouched');
});

test('translateFindings: refuses a verification file missing "Basis:" or "Evidence:", or with an unrecognized Basis value', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verif-missing-basis-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const cited = (claim) => JSON.stringify({
    findings: [validFinding({ origins: [claim], peer_responses: [{ claim, response: 'conceded' }], verifications: [{ claim, verdict: 'CONFIRMED' }] })],
  });

  await fs.writeFile(path.join(dir, 'verification-X1.md'), 'Claim: X1\nVerdict: CONFIRMED\nEvidence: e\n');
  await assert.rejects(translateFindings(cited('X1'), { A: 'X', B: 'Y' }, null, dir), /missing a "Basis:/);

  await fs.writeFile(path.join(dir, 'verification-X1.md'), 'Claim: X1\nVerdict: CONFIRMED\nBasis: EXECUTED\n');
  await assert.rejects(translateFindings(cited('X1'), { A: 'X', B: 'Y' }, null, dir), /missing an "Evidence:/);

  await fs.writeFile(path.join(dir, 'verification-X1.md'), 'Claim: X1\nVerdict: CONFIRMED\nBasis: MADE_UP\nEvidence: e\n');
  await assert.rejects(translateFindings(cited('X1'), { A: 'X', B: 'Y' }, null, dir), /has Basis "MADE_UP"/);
});

test('translateFindings: refuses a verification file whose own "Claim:" line names a different claim than its filename', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verification-claim-mismatch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'verification-X1.md'), 'Claim: X2\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');

  const cited = JSON.stringify({
    findings: [validFinding({
      origins: ['X1'],
      peer_responses: [{ claim: 'X1', response: 'conceded' }],
      verifications: [{ claim: 'X1', verdict: 'CONFIRMED', evidence: 'e' }],
    })],
  });
  await assert.rejects(translateFindings(cited, { A: 'X', B: 'Y' }, null, dir), /is a leak, not a discovery/);
});

test('translateFindings: with --verification-dir, refuses a verification file named with a real A/B claim ID (identity leak)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-verification-leak-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(path.join(dir, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: e\n');
  await fs.writeFile(path.join(dir, 'verification-A3.md'), 'a real-ID leak that should never exist\n');

  const cited = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }] })],
  });
  await assert.rejects(translateFindings(cited, { A: 'X', B: 'Y' }, null, dir), /would leak seat identity/);
});

test('translateFindings: refuses a finding id not of the form F<n>, and a duplicate finding id', async () => {
  const badId = JSON.stringify({ findings: [validFinding({ id: 'G1' })] });
  await assert.rejects(translateFindings(badId, { A: 'X', B: 'Y' }, null), /not of the form "F<n>"/);

  const dup = JSON.stringify({ findings: [validFinding({ id: 'F1' }), validFinding({ id: 'F1', origins: ['X9'], peer_responses: [{ claim: 'X9', response: 'conceded' }] })] });
  await assert.rejects(translateFindings(dup, { A: 'X', B: 'Y' }, null), /duplicate finding id/);
});

test('translateFindings: refuses the same claim appearing as an origin of two different findings', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({ id: 'F1', origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }] }),
      validFinding({ id: 'F2', origins: ['X3'], peer_responses: [{ claim: 'X3', response: 'conceded' }] }),
    ],
  });
  await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, null), /appears as an origin of more than one finding/);
});

test('translateFindings: refuses peer_responses claims that do not exactly match origins', async () => {
  const missing = JSON.stringify({
    findings: [validFinding({ origins: ['X3', 'Y7'], peer_responses: [{ claim: 'X3', response: 'conceded' }] })],
  });
  await assert.rejects(translateFindings(missing, { A: 'X', B: 'Y' }, null), /do not exactly match its origins/);

  const extra = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        peer_responses: [
          { claim: 'X3', response: 'conceded' },
          { claim: 'Y7', response: 'conceded' },
        ],
      }),
    ],
  });
  await assert.rejects(translateFindings(extra, { A: 'X', B: 'Y' }, null), /do not exactly match its origins/);

  const duplicate = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        peer_responses: [
          { claim: 'X3', response: 'conceded' },
          { claim: 'X3', response: 'conceded' },
        ],
      }),
    ],
  });
  await assert.rejects(translateFindings(duplicate, { A: 'X', B: 'Y' }, null), /do not exactly match its origins/);

  const duplicateSameSizeAsOrigins = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3', 'Y7'],
        peer_responses: [
          { claim: 'X3', response: 'conceded' },
          { claim: 'X3', response: 'conceded' },
          { claim: 'Y7', response: 'conceded' },
        ],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(duplicateSameSizeAsOrigins, { A: 'X', B: 'Y' }, null),
    /do not exactly match its origins/
  );
});

test('translateFindings: ignores an auditor-supplied independently_discovered, derives it mechanically instead', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X5'],
        peer_responses: [{ claim: 'X5', response: 'conceded' }],
        independently_discovered: true,
      }),
    ],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, null);
  assert.equal(result.findings[0].independently_discovered, false, 'single-origin finding overridden to false despite auditor claiming true');
});

test('translateFindings: refuses any of severity/basis/evidence_strength/final_state/peer response outside their documented enum', async () => {
  const cases = [
    [validFinding({ severity: 'URGENT' }), /severity "URGENT"/],
    [validFinding({ basis: 'GUESS' }), /basis "GUESS"/],
    [validFinding({ evidence_strength: 'CERTAIN' }), /evidence_strength "CERTAIN"/],
    [validFinding({ final_state: 'looks-fine' }), /final_state "looks-fine"/],
    [validFinding({ peer_responses: [{ claim: 'X3', response: 'ignored' }] }), /response "ignored"/],
  ];
  for (const [finding, pattern] of cases) {
    const audit = JSON.stringify({ findings: [finding] });
    await assert.rejects(translateFindings(audit, { A: 'X', B: 'Y' }, null), pattern);
  }
});

test('translateFindings: accepts dropped-speculative for a genuinely SPECULATIVE, single-origin, unattacked, auditor-untouched claim', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'unaddressed' }],
        auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
        final_state: 'dropped-speculative',
        evidence: ['X3 raised a plausible but unverified concern'],
      }),
    ],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, null);
  assert.equal(result.findings[0].final_state, 'dropped-speculative');
});

test('translateFindings: dropped-speculative requires evidence_strength SPECULATIVE, not e.g. the default EXECUTED+REPRODUCED', async () => {
  const audit = JSON.stringify({ findings: [validFinding({ final_state: 'dropped-speculative' })] });
  await assert.rejects(
    translateFindings(audit, { A: 'X', B: 'Y' }, null),
    /"dropped-speculative" but evidence_strength "REPRODUCED"/
  );
});

test('translateFindings: dropped-speculative refuses a finding independently discovered by both seats -- that is corroboration', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        evidence_strength: 'SPECULATIVE',
        final_state: 'dropped-speculative',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(audit, { A: 'X', B: 'Y' }, null),
    /"dropped-speculative" but was independently discovered/
  );
});

test('translateFindings: dropped-speculative refuses a finding a peer disputed -- disputed is attacked, not merely unaddressed', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'disputed-no-counter-fact' }],
        final_state: 'dropped-speculative',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(audit, { A: 'X', B: 'Y' }, null),
    /"dropped-speculative" but a peer_responses entry disputed it/
  );
});

test('translateFindings: dropped-speculative refuses when auditor_check.result is CONFIRMED or REFUTED -- the auditor already settled it', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'unaddressed' }],
        auditor_check: { result: 'CONFIRMED', basis: 'EXECUTED', evidence: 'the auditor ran it' },
        final_state: 'dropped-speculative',
      }),
    ],
  });
  await assert.rejects(
    translateFindings(audit, { A: 'X', B: 'Y' }, null),
    /"dropped-speculative" but auditor_check.result "CONFIRMED"/
  );
});

test('translateFindings: dropped-speculative refuses when a verifications[] entry exists at all, even a CONFIRMED verdict the auditor_check itself never saw -- dropped-speculative must mean SPECULATIVE AND untouched, not merely auditor_check-untouched', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-dropped-spec-verified-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'verification-X3.md'), 'Claim: X3\nVerdict: CONFIRMED\nBasis: EXECUTED\nEvidence: ran it, confirmed\n');

  const confirmedButDropped = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'unaddressed' }],
        auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
        final_state: 'dropped-speculative',
        verifications: [{ claim: 'X3', verdict: 'CONFIRMED' }],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(confirmedButDropped, { A: 'X', B: 'Y' }, null, dir),
    /"dropped-speculative".*verification/i
  );

  // Symmetric: a REFUTED verdict is also "settled", not merely speculative-and-unaddressed.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-dropped-spec-verified2-'));
  t.after(() => fs.rm(dir2, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir2, 'verification-X3.md'), 'Claim: X3\nVerdict: REFUTED\nBasis: EXECUTED\nEvidence: ran it, refuted\n');

  const refutedButDropped = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'unaddressed' }],
        auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
        final_state: 'dropped-speculative',
        verifications: [{ claim: 'X3', verdict: 'REFUTED' }],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(refutedButDropped, { A: 'X', B: 'Y' }, null, dir2),
    /"dropped-speculative".*verification/i
  );

  // An INCONCLUSIVE verdict is still a verification that ran and reached no answer -- also not
  // an untouched claim, so it must still be refused (zero verifications is the only pass case).
  const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-dropped-spec-verified3-'));
  t.after(() => fs.rm(dir3, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir3, 'verification-X3.md'), 'Claim: X3\nVerdict: INCONCLUSIVE\nBasis: EXECUTED\nEvidence: could not reproduce\n');

  const inconclusiveButDropped = JSON.stringify({
    findings: [
      validFinding({
        origins: ['X3'],
        evidence_strength: 'SPECULATIVE',
        peer_responses: [{ claim: 'X3', response: 'unaddressed' }],
        auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
        final_state: 'dropped-speculative',
        verifications: [{ claim: 'X3', verdict: 'INCONCLUSIVE' }],
      }),
    ],
  });
  await assert.rejects(
    translateFindings(inconclusiveButDropped, { A: 'X', B: 'Y' }, null, dir3),
    /"dropped-speculative".*verification/i
  );
});

test('parseArgs: translate requires --in/--out/--mapping, rejects --from/--to/--tokens', () => {
  assert.throws(() => parseArgs(['translate']), /requires --in/);
  const ok = parseArgs(['translate', '--in', 'a.json', '--out', 'b.json', '--mapping', 'm.json']);
  assert.deepEqual(ok, { sub: 'translate', in: 'a.json', out: 'b.json', mapping: 'm.json' });
  assert.throws(
    () => parseArgs(['translate', '--in', 'a.json', '--out', 'b.json', '--mapping', 'm.json', '--from', 'A']),
    /only accepted by relabel/
  );
  assert.throws(
    () => parseArgs(['relabel', '--in', 'a', '--out', 'b', '--from', 'A', '--to', 'P', '--mapping', 'm.json']),
    /only accepted by translate/
  );
});

test('CLI translate: writes real-ID findings.json from an X/Y audit file and a flip mapping', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-translate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const auditPath = path.join(dir, 'audit.json');
  const mappingPath = path.join(dir, 'mapping.json');
  const outPath = path.join(dir, 'findings.json');
  await fs.writeFile(auditPath, JSON.stringify({ findings: [validFinding({ origins: ['X4'], peer_responses: [{ claim: 'X4', response: 'conceded' }] })] }));
  await fs.writeFile(mappingPath, JSON.stringify({ A: 'X', B: 'Y' }));

  const result = spawnSync(process.execPath, [SCRIPT, 'translate', '--in', auditPath, '--out', outPath, '--mapping', mappingPath]);
  assert.equal(result.status, 0, result.stderr.toString());
  const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
  assert.deepEqual(written.findings[0].origins, ['A4']);
});

test('CLI flip: writes a JSON file with exactly one of the two mappings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-flip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'mapping.json');
  const result = spawnSync(process.execPath, [SCRIPT, 'flip', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const mapping = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.ok((mapping.A === 'X' && mapping.B === 'Y') || (mapping.A === 'Y' && mapping.B === 'X'));
});

test('claimBlockProblems: a fully complete claim block has no problems', () => {
  const { blocks } = extractClaimBlocks('# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n');
  assert.deepEqual(claimBlockProblems(blocks.get('A1')), []);
});

test('claimBlockProblems: reports every missing/unrecognized field, not just the first (the real Phase 2 run\'s shape: no "Evidence:" label at all)', () => {
  const { blocks } = extractClaimBlocks('# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\n\nprose with no Evidence: label\n');
  const problems = claimBlockProblems(blocks.get('A1'));
  assert.deepEqual(problems, ['no non-empty "Evidence:" body']);
});

test('extractClaimBlocks: reports a bare-number malformed heading ("## 1", the exact live-run shape) rather than silently treating it as zero claims', () => {
  const { blocks, malformedHeadings, noFindingsMarker } = extractClaimBlocks(
    '# Seat A findings\n\n## 1 — bad heading\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n'
  );
  assert.equal(blocks.size, 0);
  assert.equal(malformedHeadings.length, 1);
  assert.equal(malformedHeadings[0].attempted, '1');
  assert.equal(noFindingsMarker, false);
});

test('extractClaimBlocks: reports a duplicate real claim ID heading instead of silently letting the second block overwrite the first', () => {
  const { blocks, duplicateIds } = extractClaimBlocks(
    '# Seat A findings\n\n## A1 — first version\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: first\n\n' +
      '## A1 — duplicate\nSeverity: LOW\nBasis: INFERENCE\nEvidence strength: SPECULATIVE\nEvidence: second\n'
  );
  assert.equal(blocks.size, 1);
  assert.equal(blocks.get('A1').evidence, 'first'); // first occurrence wins, never silently overwritten
  assert.equal(duplicateIds.length, 1);
  assert.equal(duplicateIds[0].id, 'A1');
});

test('extractClaimBlocks: recognizes the fixed "## No findings" marker, distinct from prose like "(no findings)"', () => {
  const marked = extractClaimBlocks('# Seat A findings\n\n## No findings\n');
  assert.equal(marked.noFindingsMarker, true);
  assert.equal(marked.blocks.size, 0);

  const prose = extractClaimBlocks('# Seat A findings\n\n(no findings)\n');
  assert.equal(prose.noFindingsMarker, false);
});

test('extractClaimBlocks: an ordinary non-claim-shaped prose heading ("## Checks performed") is never flagged as a malformed claim attempt', () => {
  const { malformedHeadings } = extractClaimBlocks('# Seat A findings\n\n## Checks performed\n- did a thing\n');
  assert.equal(malformedHeadings.length, 0);
});

test('extractClaimBlocks: a CRLF claim block preserves interior \\r\\n line breaks in its Evidence body verbatim, same as parseVerificationFile does for verifier files', () => {
  const crlf =
    '# Seat A findings\r\nSeverity: HIGH\r\n\r\n## A1 — bug\r\nSeverity: HIGH\r\nBasis: EXECUTED\r\n' +
    'Evidence strength: REPRODUCED\r\nEvidence: first line\r\nsecond line\r\n\r\n## No findings\r\n';
  const { blocks } = extractClaimBlocks(crlf);
  assert.equal(blocks.get('A1').evidence, 'first line\r\nsecond line');
});

test('parseArgs: validate requires --phase1-dir and rejects every other flag', () => {
  assert.throws(() => parseArgs(['validate']), /validate requires --phase1-dir/);
  assert.throws(
    () => parseArgs(['validate', '--phase1-dir', 'd', '--in', 'x']),
    /validate accepts only --phase1-dir/
  );
  const args = parseArgs(['validate', '--phase1-dir', 'd']);
  assert.equal(args.phase1Dir, 'd');
});

test('CLI validate: exits 0 on two fully complete seat files, and nonzero listing every problem when a real-shaped claim block (no "Evidence:" label) is missing one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## B1 — y\nSeverity: LOW\nBasis: INFERENCE\nEvidence strength: SPECULATIVE\nEvidence: e2\n');

  const clean = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /validate clean/);

  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — no evidence label\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\n\njust prose, the real Phase 2 run\'s exact shape\n'
  );
  const dirty = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /A-findings\.md: claim "A1" has no non-empty "Evidence:" body/);
});

test('CLI validate: a bare-number heading ("## 1", the exact live-run shape ChatGPT reproduced) is rejected, not silently treated as zero findings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-bare-number-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## 1 — bad heading\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: something\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /looks like an attempted claim ID \("1"\) but does not match/);
});

test('CLI validate: two "## A1" headings in the same file are rejected as a duplicate claim ID, not silently collapsed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-duplicate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — first\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e1\n\n' +
      '## A1 — duplicate\nSeverity: LOW\nBasis: INFERENCE\nEvidence strength: SPECULATIVE\nEvidence: e2\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim "A1" heading appears more than once/);
});

test('CLI validate: a "## B1" heading inside A-findings.md is rejected as the wrong seat\'s letter', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-wrong-seat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## B1 — wrong seat letter\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim "B1" uses seat "B"'s letter, not this file's own seat "A"/);
});

test('CLI validate: an empty seat file with no "## No findings" marker is rejected, distinguishing "ignored the schema" from a genuine zero-findings pass', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-empty-no-marker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n(no findings)\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /B-findings\.md: has zero recognized claim headings and no "## No findings" marker/);

  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const clean = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
});

test('CLI validate: a malformed rebuttal-section heading is rejected, instead of being silently indistinguishable from relabel\'s expected "no rebuttal heading" exit for a zero-rebuttal seat', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-bad-rebuttal-heading-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals from B of A claims\n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the required "## Rebuttals \(from <letter>\) of <letter> claims" form/);

  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals (from B) of A claims\n\n### A1\nRebuttal text.\n'
  );
  const clean = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
});

test('CLI validate: a rebuttal heading naming a claim ID instead of a bare seat letter ("from B1") is rejected -- must match relabel\'s own regex exactly, not a looser pattern', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-rebuttal-claimid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals (from B1) of A claims\n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the required "## Rebuttals \(from <letter>\) of <letter> claims" form/);
});

test('CLI validate: "(from A) of B" inside A-findings.md itself is ACCEPTED -- validate deliberately does not enforce WHICH file a rebuttal heading is appended to (relabel itself is placement-agnostic), even though this shape is not the standardized placement docs now describe', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-rebuttal-selfplaced-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals (from A) of B claims\n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('CLI validate: a rebuttal heading naming a seat rebutting its own claims ("from A) of A") is rejected -- a rebuttal always addresses the peer, never the same seat', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-rebuttal-selfsame-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals (from A) of A claims\n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /names a seat rebutting its own claims/);
});

test('CLI validate: a rebuttal heading with trailing whitespace is rejected -- must match relabel\'s own raw, untrimmed regex, or a heading relabel silently ignores would pass validate clean', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-rebuttal-trailing-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence: e\n\n' +
      '## Rebuttals (from B) of A claims \n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the required "## Rebuttals \(from <letter>\) of <letter> claims" form/);
});

test('CLI validate: a rebuttal-shaped heading QUOTED INSIDE an Evidence fence is never flagged as malformed -- fenced text is evidence, not a real heading relabel would ever act on', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-validate-rebuttal-fenced-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    '# Seat A findings\n\n## A1 — x\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\n' +
      'Evidence:\n```text\n## Rebuttals junk\n```\n\n' +
      '## Rebuttals (from B) of A claims\n\n### A1\nRebuttal text.\n'
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('CLI relabel: a wrong --from that matches nothing fails loudly and writes no output, instead of silently succeeding on an unchanged file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-wrongfrom-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inPath = path.join(dir, 'b-side.md');
  await fs.writeFile(inPath, '## B1 — peer claim\nB2 also.\n');
  const outPath = path.join(dir, 'wrong.md');

  const result = spawnSync(
    process.execPath,
    [SCRIPT, 'relabel', '--in', inPath, '--out', outPath, '--from', 'A', '--to', 'P'],
    { encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0, 'a --from that matches nothing must fail, not report success');
  assert.match(result.stderr, /no "A" claim IDs, seat header, or rebuttal heading/);
  await assert.rejects(fs.access(outPath), 'no output file should be written on this failure');
});

test('CLI relabel: a CRLF-terminated file relabels the seat header and rebuttal heading correctly, and stays CRLF -- \\r left on every line by splitting on bare \\n alone previously made every $-anchored regex here unreachable, silently leaving the real seat letter in peer-facing text', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-crlf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inPath = path.join(dir, 'A-findings.md');
  const crlf =
    '# Seat A findings\r\n\r\n## A1 — bug\r\nSeverity: HIGH\r\nBasis: EXECUTED\r\n' +
    'Evidence strength: REPRODUCED\r\nEvidence: e\r\n\r\n## Rebuttals (from A) of B claims\r\n\r\n### B1\r\ntext\r\n';
  await fs.writeFile(inPath, crlf);
  const outPath = path.join(dir, 'peer-view.md');

  const result = spawnSync(
    process.execPath,
    [SCRIPT, 'relabel', '--in', inPath, '--out', outPath, '--from', 'A', '--to', 'P'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const out = await fs.readFile(outPath, 'utf8');
  assert.match(out, /^# Peer findings\r\n/, 'seat header must relabel even with a trailing \\r on the line');
  assert.match(out, /## Rebuttals \(from P\) of B claims\r\n/, 'rebuttal heading must relabel even with a trailing \\r');
  assert.ok(out.includes('\r\n'), 'CRLF input must stay CRLF, never silently downgraded to LF');
  assert.ok(!/(?<!\r)\n/.test(out), 'no bare LF anywhere -- every newline must still be preceded by \\r');
});

test('CLI validate: a CRLF-terminated Phase 1 file is accepted exactly like its LF equivalent -- no false malformed-heading or missing-field problems from the trailing \\r alone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-crlf-validate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const crlfBody =
    '# Seat A findings\r\n\r\n## A1 — bug\r\nSeverity: HIGH\r\nBasis: EXECUTED\r\n' +
    'Evidence strength: REPRODUCED\r\nEvidence: e\r\n\r\n## Rebuttals (from A) of B claims\r\n\r\n### B1\r\ntext\r\n';
  await fs.writeFile(path.join(dir, 'A-findings.md'), crlfBody);
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\r\n\r\n## No findings\r\n');
  const result = spawnSync(process.execPath, [SCRIPT, 'validate', '--phase1-dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('CLI scan: relabeling a CRLF file to P and scanning the result finds zero real-seat-letter leaks -- this is the end-to-end symptom the CRLF regex bug actually produced on a real Windows run', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-crlf-scan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const crlfBody =
    '# Seat A findings\r\n\r\n## A1 — bug\r\nSeverity: HIGH\r\nBasis: EXECUTED\r\n' +
    'Evidence strength: REPRODUCED\r\nEvidence: e\r\n\r\n## Rebuttals (from A) of B claims\r\n\r\n### B1\r\ntext\r\n';
  const inPath = path.join(dir, 'A-findings.md');
  await fs.writeFile(inPath, crlfBody);
  const peerViewPath = path.join(dir, 'peer-view.md');
  const relabelResult = spawnSync(
    process.execPath,
    [SCRIPT, 'relabel', '--in', inPath, '--out', peerViewPath, '--from', 'A', '--to', 'P'],
    { encoding: 'utf8' }
  );
  assert.equal(relabelResult.status, 0, relabelResult.stderr);
  const scanResult = spawnSync(
    process.execPath,
    [SCRIPT, 'scan', '--in', peerViewPath, '--phase1-dir', dir, '--forbid-seats', 'A'],
    { encoding: 'utf8' }
  );
  assert.equal(scanResult.status, 0, `expected zero real-seat-letter leaks, got: ${scanResult.stdout}${scanResult.stderr}`);
});

test('dogfood: relabeling the shipped A-findings.md fixture produces P-labeled prose with no A-claim IDs left, and the fenced Evidence blocks are byte-identical', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-dogfood-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inPath = path.join(FIXTURE_DIR, 'A-findings.md');
  const outPath = path.join(dir, 'peer-view-for-B.md');

  const result = spawnSync(
    process.execPath,
    [SCRIPT, 'relabel', '--in', inPath, '--out', outPath, '--from', 'A', '--to', 'P'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);

  const original = await fs.readFile(inPath, 'utf8');
  const relabeled = await fs.readFile(outPath, 'utf8');

  assert.match(relabeled, /^# Peer findings/);
  assert.doesNotMatch(relabeled, /\bA\d+\b/);
  assert.match(relabeled, /## P1 —/);
  assert.match(relabeled, /## P12 —/);

  const originalFences = splitProseAndCode(original).filter((p) => p.code).map((p) => p.text);
  const relabeledFences = splitProseAndCode(relabeled).filter((p) => p.code).map((p) => p.text);
  assert.deepEqual(relabeledFences, originalFences, 'fenced Evidence blocks must be byte-identical, never relabeled');
});

test('dogfood: double-relabeling the real findings files to X/Y (Phase 3 flow) leaves no real A/B letter anywhere, headers included', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-dogfood-xy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (const [srcName, ownLetter, peerLetter, ownTo, peerTo] of [
    ['A-findings.md', 'A', 'B', 'X', 'Y'],
    ['B-findings.md', 'B', 'A', 'Y', 'X'],
  ]) {
    const inPath = path.join(FIXTURE_DIR, srcName);
    const tmpPath = path.join(dir, `tmp-${srcName}`);
    const outPath = path.join(dir, `${ownTo}-findings.md`);
    let r = spawnSync(process.execPath,
      [SCRIPT, 'relabel', '--in', inPath, '--out', tmpPath, '--from', ownLetter, '--to', ownTo],
      { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath,
      [SCRIPT, 'relabel', '--in', tmpPath, '--out', outPath, '--from', peerLetter, '--to', peerTo],
      { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);

    const out = await fs.readFile(outPath, 'utf8');
    assert.doesNotMatch(out, /\b[AB]\d+\b/);
    assert.doesNotMatch(out, /Rebuttals \(from [AB]\) of [AB] claims/);
  }
});

test('dogfood: scanning the real relabeled peer-views finds zero self-identification, only expected target-file mentions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blind-relabel-dogfood-scan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // The fixtures are a real self-review of a skill like this one, so their content legitimately
  // discusses seat vocabulary and vendor filenames -- pass --target-dir pointed at the
  // checked-in fixture target (deterministic wherever this shared test file runs, unlike the
  // live skill dir it's copied into), exactly as phase-2-cross-examination.md's documented
  // invocation always passes --target-dir.
  const targetDir = path.join(FIXTURE_DIR, 'target');

  for (const [from, to, srcName, outName] of [
    ['A', 'P', 'A-findings.md', 'peer-view-for-B.md'],
    ['B', 'P', 'B-findings.md', 'peer-view-for-A.md'],
  ]) {
    const inPath = path.join(FIXTURE_DIR, srcName);
    const outPath = path.join(dir, outName);
    const relabelResult = spawnSync(
      process.execPath,
      [SCRIPT, 'relabel', '--in', inPath, '--out', outPath, '--from', from, '--to', to],
      { encoding: 'utf8' }
    );
    assert.equal(relabelResult.status, 0, relabelResult.stderr);

    // Also exercise the exact wired command phase-2-cross-examination.md now requires: the
    // known-real-claim-ID leak check, not just the vendor/model-token scan above.
    const scanResult = spawnSync(
      process.execPath,
      [
        SCRIPT,
        'scan',
        '--in',
        outPath,
        '--target-dir',
        targetDir,
        '--phase1-dir',
        FIXTURE_DIR,
        '--forbid-seats',
        from,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(
      scanResult.status,
      0,
      `expected a clean scan (no identity leak, no forbidden-seat claim ID) for ${outName}, got:\n${scanResult.stderr}`
    );
    assert.doesNotMatch(scanResult.stderr, /SELF-IDENTIFICATION/);
    assert.doesNotMatch(scanResult.stderr, /IDENTITY line/);
  }
});

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function claimBlock(id, severity = 'HIGH', tail = '') {
  return `## ${id} — t\nSeverity: ${severity}\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n\`\`\`\nran it\n\`\`\`\n${tail}`;
}

test('scanText: F1 -- a git target checked out on a vendor-token branch ("codex/topic") does not exempt a third-person identity mention, since exempt names come from git ls-files, never .git/refs; a tracked codex-dispatch.mjs still exempts', async (t) => {
  const dir = await tempDir(t, 'f1-git-branch-');
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('checkout', '-q', '-b', 'codex/topic');
  await fs.writeFile(path.join(dir, 'README.md'), 'plain target\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'x');
  const leak = await scanText('The Codex reviewer found this first.', dir);
  assert.equal(leak.identityHits.length, 1, 'a branch ref under .git/ must not make "codex" target-derived');

  await fs.writeFile(path.join(dir, 'codex-dispatch.mjs'), '');
  git('add', 'codex-dispatch.mjs');
  const exempt = await scanText('The Codex reviewer found this first.', dir);
  assert.equal(exempt.identityHits.length, 0, 'a tracked target file name is still target-derived');
  assert.equal(exempt.otherHits.length, 1);
});

test('scanText: F1 -- a non-git target walk skips .git/ and node_modules/, so an installed "openai" package or a stray .git/refs/heads/claude never exempts a third-person identity mention', async (t) => {
  const dir = await tempDir(t, 'f1-walk-');
  await fs.mkdir(path.join(dir, 'node_modules', 'openai'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'openai', 'index.js'), '');
  await fs.mkdir(path.join(dir, '.git', 'refs', 'heads', 'claude'), { recursive: true });
  await fs.writeFile(path.join(dir, 'app.js'), '');
  const { identityHits } = await scanText('The OpenAI reviewer flagged it.\nThe Claude reviewer agreed.', dir);
  assert.equal(identityHits.length, 2);
});

test('scanText: F2 -- vendor tokens match on word boundaries, so "affable", "octopus", and "fables" are not identity hits, while "Codex", "Claude\'s", "codex-dispatch.mjs", and "gpt-5" mentions still are', async () => {
  const neg = await scanText('The author is affable.\nAn octopus appeared.\nOld fables apply.', undefined);
  assert.equal(neg.identityHits.length + neg.selfIdHits.length + neg.otherHits.length, 0);
  const pos = await scanText(
    'The Codex reviewer ran.\nClaude\'s pass agreed.\nSee codex-dispatch.mjs here.\nThe gpt-5 output said so.',
    undefined
  );
  assert.equal(pos.identityHits.length, 4);
});

test('scanText: F2 -- a --tokens entry matches on word boundaries too, and a target whose own SKILL.md only says "affable" does not exempt a real "Fable" mention', async (t) => {
  const dir = await tempDir(t, 'f2-target-');
  await fs.writeFile(path.join(dir, 'SKILL.md'), 'This skill is affable.\n');
  const { identityHits } = await scanText('The Fable reviewer found it.\nThe mysolar panel.', dir, ['sol']);
  assert.equal(identityHits.length, 1);
  assert.match(identityHits[0].text, /Fable reviewer/);
});

const F3_BLOCK = [
  '# Seat A findings',
  '',
  '## A1 — t',
  'Severity: HIGH',
  'Basis: EXECUTED',
  'Evidence strength: REPRODUCED',
  'Evidence:',
  '```',
  '$ node x.js',
  'boom',
  '```',
  'Commentary prose after the fence.',
  'Suggested fix: add a null check in x.js parse().',
  '',
].join('\n');

test('extractClaimBlocks: F3 -- evidence stops at the Evidence fence\'s closing line, so commentary and a trailing "Suggested fix:" line never enter evidence; the fix line is captured as suggestedFix', () => {
  const { blocks } = extractClaimBlocks(F3_BLOCK);
  assert.equal(blocks.get('A1').evidence, '$ node x.js\nboom');
  assert.equal(blocks.get('A1').suggestedFix, 'add a null check in x.js parse().');
});

test('extractClaimBlocks: F3 -- unfenced evidence also stops at a "Suggested fix:" line instead of swallowing it', () => {
  const { blocks } = extractClaimBlocks(
    '## A1 — t\nSeverity: LOW\nBasis: INFERENCE\nEvidence strength: PLAUSIBLE\nEvidence: x.js:4 returns null\nSuggested fix: guard it\n'
  );
  assert.equal(blocks.get('A1').evidence, 'x.js:4 returns null');
  assert.equal(blocks.get('A1').suggestedFix, 'guard it');
});

test('extractClaimBlocks: F4 -- two back-to-back Evidence fences contribute only their contents, never the first fence\'s closer or the second\'s opener; parseFenceLines marks delimiter lines with isOpen/isClose', () => {
  const text = '## A2 — t\nSeverity: LOW\nBasis: EXECUTED\nEvidence strength: SUPPORTED\nEvidence:\n```\na.js:1 one\n```\n```\nb.js:2 two\n```\n';
  assert.equal(extractClaimBlocks(text).blocks.get('A2').evidence, 'a.js:1 one\nb.js:2 two');
  const flags = parseFenceLines(text).lines.map((l) => [l.isOpen, l.isClose]);
  assert.deepEqual(flags.slice(5, 11), [[true, false], [false, false], [false, true], [true, false], [false, false], [false, true]]);
  const spaced = '## A3 — t\nEvidence:\n```\na\n```\n\n~~~\nb\n```\n~~~\nprose after\n';
  assert.equal(extractClaimBlocks(spaced).blocks.get('A3').evidence, 'a\n\nb\n```', 'a blank-separated fence stays in the group; a ``` inside ~~~ is content');
});

test('translateFindings: F3/F14 -- with --phase1-dir, a post-fence "Suggested fix:" line is derived into suggested_fix ("<origin>: <text>", one per origin that has one) and never into evidence', async (t) => {
  const dir = await tempDir(t, 'f3-translate-');
  await fs.writeFile(path.join(dir, 'A-findings.md'), `${F3_BLOCK}\n${claimBlock('A2')}`);
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  const audit = JSON.stringify({
    findings: [
      validFinding({ id: 'F1', origins: ['X1'], peer_responses: [{ claim: 'X1', response: 'conceded' }] }),
      validFinding({ id: 'F2', origins: ['X2'], peer_responses: [{ claim: 'X2', response: 'conceded' }] }),
    ],
  });
  const result = await translateFindings(audit, { A: 'X', B: 'Y' }, dir);
  assert.deepEqual(result.findings[0].evidence, ['$ node x.js\nboom']);
  assert.deepEqual(result.findings[0].suggested_fix, ['A1: add a null check in x.js parse().']);
  assert.deepEqual(result.findings[1].suggested_fix, []);
});

test('relabelText: F5 -- only real claim IDs (## / ### headings and Claim: lines) are rewritten; product names A100/B200 and an A10 with no claim heading stay untouched', () => {
  const text = '# Seat A findings\n\n## A1 — t\nRan on A100 and B200 GPUs; A10 is a cell ref; see A1.\n### A2\nClaim: A3\n';
  const out = relabelText(text, 'A', 'X');
  assert.match(out, /^## X1 — t$/m);
  assert.match(out, /Ran on A100 and B200 GPUs; A10 is a cell ref; see X1\./);
  assert.match(out, /^### X2$/m);
  assert.match(out, /^Claim: X3$/m);
  assert.deepEqual([...realClaimIds(text, 'A')].sort(), ['A1', 'A2', 'A3']);
});

test('CLI relabel: F5 -- a Phase 3 second pass with --phase1-dir rewrites a prose cross-reference to a real peer claim (B5) but leaves B200 alone; without --phase1-dir nothing real matches and the zero-target exit fires', async (t) => {
  const dir = await tempDir(t, 'f5-cli-');
  await fs.writeFile(path.join(dir, 'A-findings.md'), `# Seat A findings\n\n${claimBlock('A1', 'HIGH', 'Same root cause as B5, seen on B200 hardware.\n')}`);
  await fs.writeFile(path.join(dir, 'B-findings.md'), `# Seat B findings\n\n${claimBlock('B5')}`);
  const pass1 = path.join(dir, 'tmp-A.md');
  let r = runCli(['relabel', '--in', path.join(dir, 'A-findings.md'), '--out', pass1, '--from', 'A', '--to', 'X']);
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(dir, 'out', 'X-findings.md');
  r = runCli(['relabel', '--in', pass1, '--out', out, '--from', 'B', '--to', 'Y']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no "B" claim IDs/);
  r = runCli(['relabel', '--in', pass1, '--out', out, '--from', 'B', '--to', 'Y', '--phase1-dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /Same root cause as Y5, seen on B200 hardware\./);
});

test('dogfood: F5 -- a full double relabel of a real run\'s Phase 1 files (rebuttal sections included) leaves zero real A/B claim IDs anywhere and leaves A100/B200-shaped non-claim tokens alone', async (t) => {
  // Stored as *-findings.fixture.md (the skill's .gitignore drops *-findings.md); copied to real names.
  const src = path.join(FIXTURE_DIR, 'real-run-rebuttals');
  const dir = await tempDir(t, 'f5-real-run-');
  const real = path.join(dir, 'phase1');
  await fs.mkdir(real);
  const texts = {};
  for (const seat of ['A', 'B']) {
    texts[seat] = await fs.readFile(path.join(src, `${seat}-findings.fixture.md`), 'utf8');
    await fs.writeFile(path.join(real, `${seat}-findings.md`), texts[seat]);
  }
  const realIds = new Set([...realClaimIds(texts.A, 'A'), ...realClaimIds(texts.B, 'B')]);
  assert.ok(realIds.size >= 50, `expected the real run's ~50 claim IDs, got ${realIds.size}`);
  for (const [own, peer, ownTo, peerTo] of [['A', 'B', 'X', 'Y'], ['B', 'A', 'Y', 'X']]) {
    const inPath = path.join(dir, `${own}-in.md`);
    await fs.writeFile(inPath, `${texts[own]}\nBenchmarked on A100 and B200; also A99 (not a claim).\n`);
    const tmp = path.join(dir, `tmp-${own}.md`);
    const outPath = path.join(dir, `${ownTo}-findings.md`);
    let r = runCli(['relabel', '--in', inPath, '--out', tmp, '--from', own, '--to', ownTo]);
    assert.equal(r.status, 0, r.stderr);
    r = runCli(['relabel', '--in', tmp, '--out', outPath, '--from', peer, '--to', peerTo, '--phase1-dir', real]);
    assert.equal(r.status, 0, r.stderr);
    const out = await fs.readFile(outPath, 'utf8');
    const survivors = [...realIds].filter((id) => new RegExp(`\\b${id}\\b`).test(out));
    assert.deepEqual(survivors, [], `real claim IDs survived in ${ownTo}-findings.md`);
    assert.match(out, /Benchmarked on A100 and B200; also A99 \(not a claim\)\./);
    assert.match(out, /^## Rebuttals \(from [XY]\) of [XY] claims$/m);
    assert.deepEqual(await scanForKnownClaimIdLeaks(out, real, ['A', 'B']), []);
  }
});

test('translateFindings: F5 -- prose fields (summary, recommended_fix, title, priority, suggested_fix) are copied verbatim, so a literal X75/X11 that is not an origin of this run stays byte-identical instead of becoming a fake A75; basis_from is still ID-translated', async () => {
  const audit = JSON.stringify({
    findings: [
      validFinding({
        title: 'X75 forwarding crash',
        summary: 'X11 forwarding breaks',
        recommended_fix: 'guard X11 in x.js',
        priority: 'high',
        suggested_fix: ['Y99-style guard'],
        basis_from: 'Y7',
      }),
    ],
  });
  const [f] = (await translateFindings(audit, { A: 'X', B: 'Y' }, null)).findings;
  assert.equal(f.title, 'X75 forwarding crash');
  assert.equal(f.summary, 'X11 forwarding breaks');
  assert.equal(f.recommended_fix, 'guard X11 in x.js');
  assert.deepEqual(f.suggested_fix, ['Y99-style guard']);
  assert.deepEqual(f.origins, ['A3', 'B7']);
  assert.equal(f.basis_from, 'B7');
});

test('translateFindings: F5 -- refuses when a prose field names one of this run\'s anonymous origin IDs (X3) or a Phase 2 P<n> label, since prose is never ID-rewritten; evidence and auditor_check.evidence stay exempt', async () => {
  const map = { A: 'X', B: 'Y' };
  const one = (overrides) => JSON.stringify({ findings: [validFinding(overrides)] });
  await assert.rejects(translateFindings(one({ summary: 'X3 and Y7 agree' }), map, null), /prose field "findings\.0\.summary" contains "X3"/);
  await assert.rejects(translateFindings(one({ title: 'see P12' }), map, null), /contains "P12", a Phase 2 peer label/);
  await assert.rejects(translateFindings(one({ notes: 'Y7 is right' }), map, null), /findings\.0\.notes/);
  const ok = await translateFindings(
    one({ auditor_check: { result: 'CONFIRMED', basis: 'EXECUTED', evidence: 'ran the X3 repro' } }),
    map,
    null
  );
  assert.equal(ok.findings[0].auditor_check.evidence, 'ran the X3 repro');
});

test('CLI scan: F6 -- --phase2-dir hard-stops on a surviving Phase 2 label ("identified in P12" inside an Evidence fence) when P12 is a peer-view claim, and ignores a P number no peer-view ever carried', async (t) => {
  const dir = await tempDir(t, 'f6-scan-');
  const p2 = path.join(dir, 'phase2');
  await fs.mkdir(p2);
  await fs.writeFile(path.join(p2, 'peer-view-for-A.md'), '# Peer findings\n\n## P12 — x\n');
  await fs.writeFile(path.join(p2, 'peer-view-for-B.md'), '# Peer findings\n\n## P3 — y\n');
  const leak = path.join(dir, 'X-findings.md');
  await fs.writeFile(leak, '# Seat X findings\n\n## X1 — t\nEvidence:\n```\nas identified in P12, x.js:4 guards it\n```\n');
  let r = runCli(['scan', '--in', leak, '--phase2-dir', p2]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /PEER-LABEL LEAK line 6 \(Phase 2 "P12"/);
  const clean = path.join(dir, 'Y-findings.md');
  await fs.writeFile(clean, '# Seat Y findings\n\n## Y1 — t\nEvidence:\n```\nP99 is a part number\n```\n');
  r = runCli(['scan', '--in', clean, '--phase2-dir', p2]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scanForPeerLabelLeaks('P12 and P3 and P4', new Set(['P12', 'P3'])).map((h) => h.id), ['P12', 'P3']);
  assert.deepEqual([...peerViewClaimIds('## P1 — a\n```\n## P9\n```\n')], ['P1']);
});

test('CLI validate: F7 -- a "## P71" or duplicate "## A1" entry heading inside "## Rebuttals (from B) of A claims" is reported against seat B (the rebutting seat that wrote it), not the file owner, and "### A1" entries validate clean', async (t) => {
  const dir = await tempDir(t, 'f7-validate-');
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  for (const entryHeading of ['## P71', '## A1']) {
    await fs.writeFile(
      path.join(dir, 'A-findings.md'),
      `# Seat A findings\n\n${claimBlock('A1')}\n## Rebuttals (from B) of A claims\n\n${entryHeading}\nClaim: A1\nAction: CONCEDE\n`
    );
    const r = runCli(['validate', '--phase1-dir', dir]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`heading "${entryHeading}" sits inside "## Rebuttals \\(from B\\) of A claims"`));
    assert.match(r.stderr, /return this section to seat B \(the rebutting seat that wrote it\), not to seat A/);
    assert.match(r.stderr, /return to: seat B/);
    assert.doesNotMatch(r.stderr, /return to: seat A/);
  }
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    `# Seat A findings\n\n${claimBlock('A1')}\n## Rebuttals (from B) of A claims\n\n### A1\nClaim: A1\nAction: CONCEDE\n`
  );
  const ok = runCli(['validate', '--phase1-dir', dir]);
  assert.equal(ok.status, 0, ok.stderr);
});

async function f8Setup(t) {
  const dir = await tempDir(t, 'f8-append-');
  const aText = `# Seat A findings\n\n${claimBlock('A1')}\n${claimBlock('A2')}`;
  await fs.writeFile(path.join(dir, 'A-findings.md'), aText);
  await fs.writeFile(path.join(dir, 'B-findings.md'), `# Seat B findings\n\n${claimBlock('B1')}`);
  const peerView = path.join(dir, 'peer-view-for-B.md');
  await fs.writeFile(peerView, relabelText(aText, 'A', 'P'));
  return { dir, aText, peerView, onto: path.join(dir, 'A-findings.md') };
}

const F8_GOOD_RAW =
  '## P1 — t\nClaim: P1\nAction: CONCEDE\nEvidence:\n```\nok\n```\n\n## P2\nClaim: P2\nAction: DISPUTE\nCounter-fact: see P1 above\n';

test('CLI append-rebuttals: F8 -- normalizes "## P<n>" entry headings to "###", relabels P to the peer letter, appends a blank line + the exact rebuttal heading + the entries, and the result validates clean', async (t) => {
  const { dir, aText, peerView, onto } = await f8Setup(t);
  const raw = path.join(dir, 'raw.md');
  await fs.writeFile(raw, F8_GOOD_RAW);
  const r = runCli(['append-rebuttals', '--in', raw, '--onto', onto, '--rebutter', 'B', '--peer-view', peerView]);
  assert.equal(r.status, 0, r.stderr);
  const out = await fs.readFile(onto, 'utf8');
  assert.ok(out.startsWith(aText), 'the original findings are kept byte-identical');
  assert.equal(
    out.slice(aText.length),
    '\n## Rebuttals (from B) of A claims\n\n### A1 — t\nClaim: A1\nAction: CONCEDE\nEvidence:\n```\nok\n```\n\n### A2\nClaim: A2\nAction: DISPUTE\nCounter-fact: see A1 above\n'
  );
  assert.equal(runCli(['validate', '--phase1-dir', dir]).status, 0);
  const again = runCli(['append-rebuttals', '--in', raw, '--onto', onto, '--rebutter', 'B', '--peer-view', peerView]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already contains "## Rebuttals \(from B\) of A claims"/);
});

test('CLI append-rebuttals: F8 -- refuses, leaving --onto byte-identical, on a coverage gap, a duplicate entry, a missing Action line, a fenced P token naming a peer-view claim, or an --onto that is not the peer\'s file', async (t) => {
  const { dir, aText, peerView, onto } = await f8Setup(t);
  const cases = [
    ['## P1\nClaim: P1\nAction: CONCEDE\n', /no rebuttal entry for peer-view claim\(s\) \[P2\]/],
    ['### P1\nClaim: P1\nAction: CONCEDE\n### P1\nClaim: P1\nAction: DISPUTE\n### P2\nClaim: P2\nAction: CONCEDE\n', /claim "P1" has 2 entries/],
    ['### P1\nClaim: P1\nAction: CONCEDE\n### P2\nClaim: P2\n', /entry "P2" has no "Action: CONCEDE" or "Action: DISPUTE" line/],
    ['### P1\nClaim: P1\nAction: CONCEDE\nEvidence:\n```\nsee P2\n```\n### P2\nClaim: P2\nAction: CONCEDE\n', /"P2" inside a fence names a peer-view claim/],
    ['### P1\nClaim: P1\nAction: CONCEDE, matches `P2`\n### P2\nClaim: P2\nAction: CONCEDE\n', /"P2" inside inline code names a peer-view claim/],
  ];
  const raw = path.join(dir, 'raw.md');
  for (const [text, expected] of cases) {
    await fs.writeFile(raw, text);
    const r = runCli(['append-rebuttals', '--in', raw, '--onto', onto, '--rebutter', 'B', '--peer-view', peerView]);
    assert.equal(r.status, 1, `expected refusal for:\n${text}`);
    assert.match(r.stderr, expected);
    assert.equal(await fs.readFile(onto, 'utf8'), aText, '--onto must be unchanged on refusal');
  }
  await fs.writeFile(raw, F8_GOOD_RAW);
  const wrong = runCli(['append-rebuttals', '--in', raw, '--onto', path.join(dir, 'B-findings.md'), '--rebutter', 'B', '--peer-view', peerView]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /--onto must be the peer's Phase 1 file "A-findings\.md"/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['A-findings.md', 'B-findings.md', 'peer-view-for-B.md', 'raw.md'], 'no temp file is left behind');
});

test('CLI append-rebuttals: F8 -- on a real run\'s raw rebuttal files, seat A\'s 17 rebuttals are refused while B1\'s Evidence fence quotes real claim ID A1, then append onto B-findings.md and validate clean once B redacts it, and seat B\'s are refused for the real fenced "identified in P12" leak that run had to hand-redact', async (t) => {
  const real = path.join(FIXTURE_DIR, 'real-run-append');
  const dir = await tempDir(t, 'f8-real-run-');
  for (const seat of ['A', 'B']) {
    await fs.copyFile(path.join(real, `${seat}-findings.fixture.md`), path.join(dir, `${seat}-findings.md`));
  }
  const aBefore = await fs.readFile(path.join(dir, 'A-findings.md'), 'utf8');
  const appendA = () => runCli(['append-rebuttals', '--in', path.join(real, 'A-rebuttals-raw.md'), '--onto', path.join(dir, 'B-findings.md'),
    '--rebutter', 'A', '--peer-view', path.join(real, 'peer-view-for-A.md')]);
  // That run's B1 Evidence fence quotes the real claim ID A1, which validate refuses until B redacts it.
  let r = appendA();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /B-findings\.md:11: claim ID "A1" inside a fence .*return to seat B/);
  const bFile = path.join(dir, 'B-findings.md');
  const bRedacted = (await fs.readFile(bFile, 'utf8')).replace('"A1 follows P12" after translating X1 to A1', '"<id> follows P12" after translating X1 to <id>');
  await fs.writeFile(bFile, bRedacted);
  r = appendA();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /appended 17 rebuttal\(s\) from A/);
  const bOut = await fs.readFile(path.join(dir, 'B-findings.md'), 'utf8');
  assert.match(bOut, /^## Rebuttals \(from A\) of B claims$/m);
  assert.match(bOut, /^### B17\b/m);
  r = runCli(['append-rebuttals', '--in', path.join(real, 'B-rebuttals-raw.md'), '--onto', path.join(dir, 'A-findings.md'),
    '--rebutter', 'B', '--peer-view', path.join(real, 'peer-view-for-B.md')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--in:58: "P12" inside a fence names a peer-view claim/);
  assert.equal(await fs.readFile(path.join(dir, 'A-findings.md'), 'utf8'), aBefore);
});

async function f31Setup(t) {
  const root = await tempDir(t, 'f31-audit-prep-');
  const p1 = path.join(root, 'phase1');
  const mapDir = path.join(root, 'phase3');
  const target = path.join(root, 'target');
  for (const d of [p1, mapDir, target]) await fs.mkdir(d);
  await fs.writeFile(
    path.join(p1, 'A-findings.md'),
    `# Seat A findings\n\n${claimBlock('A1', 'HIGH')}\n${claimBlock('A2', 'CRITICAL')}\n${claimBlock('A3', 'LOW', 'Related to B1.\n')}\n` +
      '## Rebuttals (from B) of A claims\n\n### A1\nClaim: A1\nAction: CONCEDE\n\n### A2\nClaim: A2\nAction: DISPUTE\nCounter-fact: x.js:9 guards it\n'
  );
  await fs.writeFile(path.join(p1, 'B-findings.md'), `# Seat B findings\n\n${claimBlock('B1', 'HIGH')}`);
  const mapping = path.join(mapDir, 'mapping.json');
  await fs.writeFile(mapping, '{"A":"Y","B":"X"}\n');
  return { root, p1, mapDir, target, mapping };
}

test('CLI audit-prep: F31/F30 -- writes exactly <label>-findings.md for both seats from the flip mapping (zero-rebuttal second pass included) with no real A/B claim ID left, and prints a one-line falsificationBreakdown', async (t) => {
  const { root, p1, mapDir, target, mapping } = await f31Setup(t);
  const outDir = path.join(root, 'audit-input');
  const r = runCli(['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', outDir, '--target-dir', target]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await fs.readdir(outDir)).sort(), ['X-findings.md', 'Y-findings.md']);
  const y = await fs.readFile(path.join(outDir, 'Y-findings.md'), 'utf8');
  const x = await fs.readFile(path.join(outDir, 'X-findings.md'), 'utf8');
  assert.match(y, /^# Seat Y findings$/m);
  assert.match(y, /^## Rebuttals \(from X\) of Y claims$/m);
  assert.match(y, /Related to X1\./);
  assert.match(x, /^## X1 — t$/m);
  for (const text of [x, y]) assert.doesNotMatch(text, /\b[AB]\d+\b/);
  const line = r.stdout.split('\n').find((l) => l.includes('falsificationBreakdown'));
  assert.deepEqual(JSON.parse(line), { falsificationBreakdown: { high_or_critical: 3, disputed: 1, conceded: 1, unaddressed: 1 } });
  assert.deepEqual((await fs.readdir(p1)).sort(), ['A-findings.md', 'B-findings.md'], 'no temp file in --phase1-dir');
  assert.deepEqual(await fs.readdir(mapDir), ['mapping.json'], 'no temp file next to the mapping');
});

test('CLI audit-prep: F31 -- refuses a non-empty --out-dir or one equal to --phase1-dir or the mapping file\'s folder, and writes nothing to --out-dir when a scan hits (a surviving Phase 2 label via --phase2-dir)', async (t) => {
  const { root, p1, mapDir, target, mapping } = await f31Setup(t);
  for (const bad of [p1, mapDir]) {
    const r = runCli(['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', bad, '--target-dir', target]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--out-dir must differ from --phase1-dir and from the mapping file's folder/);
  }
  const busy = path.join(root, 'busy');
  await fs.mkdir(busy);
  await fs.writeFile(path.join(busy, 'stray.txt'), '');
  let r = runCli(['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', busy, '--target-dir', target]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not empty \(stray\.txt\)/);

  const p2 = path.join(root, 'phase2');
  await fs.mkdir(p2);
  await fs.writeFile(path.join(p2, 'peer-view-for-A.md'), '# Peer findings\n\n## P1 — t\n');
  await fs.writeFile(path.join(p2, 'peer-view-for-B.md'), '# Peer findings\n\n## P1 — t\n## P2 — t\n');
  const aPath = path.join(p1, 'A-findings.md');
  await fs.writeFile(aPath, (await fs.readFile(aPath, 'utf8')).replace('x.js:9 guards it', 'x.js:9 guards it, as P2 said'));
  const outDir = path.join(root, 'audit-input');
  r = runCli(['audit-prep', '--phase1-dir', p1, '--mapping', mapping, '--out-dir', outDir, '--target-dir', target, '--phase2-dir', p2]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Y-findings\.md: PEER-LABEL LEAK .*"P2"/);
  assert.match(r.stderr, /nothing written to --out-dir/);
  await assert.rejects(fs.access(outDir), 'no --out-dir is created on a scan hit');
});

test('falsificationBreakdown: F30 -- counts HIGH/CRITICAL claims by the peer\'s rebuttal Action, reading each seat\'s rebuttals from the "## Rebuttals (from <peer>) of <seat> claims" section, with a missing entry counted as unaddressed', () => {
  const texts = {
    A: `# Seat A findings\n\n${claimBlock('A1', 'CRITICAL')}\n${claimBlock('A2', 'MEDIUM')}\n## Rebuttals (from B) of A claims\n\n### A1\nClaim: A1\nAction: DISPUTE\n### A2\nClaim: A2\nAction: CONCEDE\n`,
    B: `# Seat B findings\n\n${claimBlock('B1', 'HIGH')}\n${claimBlock('B2', 'HIGH')}\n## Rebuttals (from A) of B claims\n\n### B2\nClaim: B2\nAction: CONCEDE\n`,
  };
  assert.deepEqual(falsificationBreakdown(texts), { high_or_critical: 3, disputed: 1, conceded: 1, unaddressed: 1 });
  assert.deepEqual(validateProblems(texts), []);
});

test('CLI scan: F21 -- --target-urls reports every target-embedded URL (prose or fenced, matched after lowercasing scheme/host and dropping fragment and trailing slash) as a non-blocking TRUST-BOUNDARY line without changing the exit code', async (t) => {
  const dir = await tempDir(t, 'f21-urls-');
  const urls = path.join(dir, 'urls.txt');
  await fs.writeFile(urls, 'https://Example.com/docs/page/\nnot a url\n');
  const findings = path.join(dir, 'f.md');
  await fs.writeFile(
    findings,
    'See HTTPS://EXAMPLE.COM/docs/page#intro for context.\n```\ncurl https://example.com/docs/page/\n```\nAlso https://example.com/docs/Other and https://example.com/docs/page2.\n'
  );
  const r = runCli(['scan', '--in', findings, '--target-urls', urls]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /TRUST-BOUNDARY line 1: HTTPS:\/\/EXAMPLE\.COM\/docs\/page#intro/);
  assert.match(r.stderr, /TRUST-BOUNDARY line 3: https:\/\/example\.com\/docs\/page\//);
  assert.doesNotMatch(r.stderr, /Other|page2/);
  assert.match(r.stderr, /skipped unparseable entry "not a url"/);
  assert.match(r.stdout, /2 trust-boundary URL\(s\) reported/);
  assert.equal(normalizeUrl('HTTPS://Example.COM/a/#x'), 'https://example.com/a');
  assert.equal(scanForTargetUrls('no urls here', new Set()).length, 0);
});

test('parseArgs: new flags are accepted only by their own subcommands (--phase2-dir: scan/audit-prep, --target-urls: scan, --onto/--rebutter/--peer-view: append-rebuttals, --out-dir: audit-prep), and relabel now accepts --phase1-dir', () => {
  assert.throws(() => parseArgs(['validate', '--phase1-dir', 'p', '--phase2-dir', 'q']), /--phase2-dir is only accepted by scan and audit-prep/);
  assert.throws(() => parseArgs(['relabel', '--in', 'a', '--out', 'b', '--from', 'A', '--to', 'P', '--target-urls', 'u']), /--target-urls is only accepted by scan/);
  assert.throws(() => parseArgs(['scan', '--in', 'a', '--onto', 'b']), /--onto is only accepted by append-rebuttals/);
  assert.throws(() => parseArgs(['append-rebuttals', '--in', 'a', '--onto', 'b', '--rebutter', 'B']), /requires --peer-view/);
  assert.throws(() => parseArgs(['append-rebuttals', '--in', 'a', '--onto', 'b', '--rebutter', 'C', '--peer-view', 'v']), /--rebutter must be A or B/);
  assert.throws(() => parseArgs(['audit-prep', '--phase1-dir', 'p', '--mapping', 'm', '--out-dir', 'o']), /requires --target-dir/);
  assert.throws(() => parseArgs(['audit-prep', '--phase1-dir', 'p', '--mapping', 'm', '--out-dir', 'o', '--target-dir', 't', '--in', 'x']), /audit-prep accepts only/);
  assert.deepEqual(
    parseArgs(['relabel', '--in', 'a', '--out', 'b', '--from', 'B', '--to', 'Y', '--phase1-dir', 'p1']),
    { sub: 'relabel', in: 'a', out: 'b', from: 'B', to: 'Y', phase1Dir: 'p1' }
  );
  assert.deepEqual(
    parseArgs(['scan', '--in', 'a', '--phase2-dir', 'p2', '--target-urls', 'u']),
    { sub: 'scan', in: 'a', phase2Dir: 'p2', targetUrls: 'u' }
  );
});

const PHASE_TARGET = path.join(FIXTURE_DIR, 'target-phase-names');

// Phase 1 (A1-A3, B1-B5) and Phase 2 (P1-P4) dirs plus the scan input file.
async function targetExemptSetup(t, fence) {
  const root = await tempDir(t, 'target-exempt-');
  const p1 = path.join(root, 'phase1');
  const p2 = path.join(root, 'phase2');
  await fs.mkdir(p1);
  await fs.mkdir(p2);
  await fs.writeFile(path.join(p1, 'A-findings.md'), `# Seat A findings\n\n${['A1', 'A2', 'A3'].map((id) => claimBlock(id)).join('\n')}`);
  await fs.writeFile(path.join(p1, 'B-findings.md'), `# Seat B findings\n\n${['B1', 'B2', 'B3', 'B4', 'B5'].map((id) => claimBlock(id)).join('\n')}`);
  await fs.writeFile(path.join(p2, 'peer-view-for-A.md'), '# Peer findings\n\n## P1 — a\n\n## P2 — b\n\n## P3 — c\n\n## P4 — d\n');
  await fs.writeFile(path.join(p2, 'peer-view-for-B.md'), '# Peer findings\n\n## P1 — a\n');
  const input = path.join(root, 'X-findings.md');
  await fs.writeFile(input, `# Seat X findings\n\n## X1 — t\nEvidence:\n\`\`\`\n${fence}\n\`\`\`\n`);
  return { p1, p2, input };
}

function scanIds(s, withTarget = true) {
  const args = ['scan', '--in', s.input, '--phase1-dir', s.p1, '--forbid-seats', 'A,B', '--phase2-dir', s.p2];
  return runCli(withTarget ? [...args, '--target-dir', PHASE_TARGET] : args);
}

test('CLI scan target-derived: WWN chunk "20:00:00:25:B5:00:00:0A" found in the target does not hard-stop on B5', async (t) => {
  const r = scanIds(await targetExemptSetup(t, 'port wwn 20:00:00:25:B5:00:00:0A online'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /target-derived "B5"/);
  assert.match(r.stdout, /scan clean/);
});

test('CLI scan target-derived: `df -B1` chunk found in the target does not hard-stop on B1', async (t) => {
  const r = scanIds(await targetExemptSetup(t, '$ df -B1 /data'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /target-derived "B1"/);
});

test('CLI scan target-derived: quoted docstring line "P1 scope ... is P2" that occurs verbatim in the target does not hard-stop on P1/P2', async (t) => {
  const r = scanIds(await targetExemptSetup(t, '> P1 scope covers LUN creation only; host mapping is P2.'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /target-derived "P1"/);
  assert.match(r.stderr, /target-derived "P2"/);
});

test('CLI scan target-derived: "P0-P4 complete" (P4 embedded in a target chunk) does not hard-stop', async (t) => {
  const r = scanIds(await targetExemptSetup(t, 'status: P0-P4 complete'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /target-derived "P4"/);
});

test('CLI scan target-derived: bare "see A2" in a fence still hard-stops even though the target has a standalone "A2"', async (t) => {
  const r = scanIds(await targetExemptSetup(t, 'see A2 for the root cause'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CLAIM-ID LEAK line \d+ \(real "A2" survives relabel\)/);
});

test('CLI scan target-derived: "A2/A3" cross-reference absent from the target still hard-stops', async (t) => {
  const r = scanIds(await targetExemptSetup(t, 'same defect as A2/A3'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /real "A2" survives/);
  assert.match(r.stderr, /real "A3" survives/);
});

test('CLI scan target-derived: an exempt WWN plus a bare B5 on the same line still hard-stops', async (t) => {
  const r = scanIds(await targetExemptSetup(t, 'wwn 20:00:00:25:B5:00:00:0A, see B5'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /real "B5" survives/);
});

test('CLI scan target-derived: without --target-dir the WWN and phase-name hits still hard-stop', async (t) => {
  for (const fence of ['port wwn 20:00:00:25:B5:00:00:0A online', 'status: P0-P4 complete']) {
    const r = scanIds(await targetExemptSetup(t, fence), false);
    assert.equal(r.status, 1, `expected a hard stop for: ${fence}`);
  }
});

test('CLI append-rebuttals target-derived: a fenced "P0-P4" chunk from --target-dir is reported, not refused; without --target-dir it is refused', async (t) => {
  const { dir, peerView, onto } = await f8Setup(t);
  const raw = path.join(dir, 'raw.md');
  await fs.writeFile(peerView, '# Peer findings\n\n## P1 — t\n\n## P2 — t\n\n## P4 — t\n');
  await fs.writeFile(raw, '### P1\nClaim: P1\nAction: CONCEDE\nEvidence:\n```\nstatus: P0-P4 complete\n```\n### P2\nClaim: P2\nAction: CONCEDE\n### P4\nClaim: P4\nAction: CONCEDE\n');
  const base = ['append-rebuttals', '--in', raw, '--onto', onto, '--rebutter', 'B', '--peer-view', peerView];
  const refused = runCli(base);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"P4" inside a fence names a peer-view claim/);
  const ok = runCli([...base, '--target-dir', PHASE_TARGET]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /report \(target-derived "P4" inside a fence/);
});

async function validateCrossRefSetup(t, fence) {
  const dir = await tempDir(t, 'validate-crossref-');
  const a1 = `## A1 — t\nSeverity: HIGH\nBasis: EXECUTED\nEvidence strength: REPRODUCED\nEvidence:\n\`\`\`\n${fence}\n\`\`\`\n`;
  await fs.writeFile(path.join(dir, 'A-findings.md'), `# Seat A findings\n\n${a1}\n${claimBlock('A2')}`);
  await fs.writeFile(path.join(dir, 'B-findings.md'), '# Seat B findings\n\n## No findings\n');
  return dir;
}

test('CLI validate cross-ref: an Evidence fence "see A2" in A-findings fails validate before the freeze, returned to seat A', async (t) => {
  const dir = await validateCrossRefSetup(t, 'see A2 for the same root cause');
  const r = runCli(['validate', '--phase1-dir', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /A-findings\.md:\d+: claim ID "A2" inside a fence .*return to seat A/);
  const withTarget = runCli(['validate', '--phase1-dir', dir, '--target-dir', PHASE_TARGET]);
  assert.equal(withTarget.status, 1, 'a bare "A2" stays a problem even when the target has a standalone "A2"');
});

test('CLI validate cross-ref: a WWN embedding "A2" whose chunk exists in --target-dir passes validate', async (t) => {
  const dir = await validateCrossRefSetup(t, 'port wwn 20:00:00:25:A2:00:00:0B online');
  const r = runCli(['validate', '--phase1-dir', dir, '--target-dir', PHASE_TARGET]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runCli(['validate', '--phase1-dir', dir]).status, 1, 'without --target-dir the same WWN is still flagged');
});

test('CLI validate cross-ref: a fenced claim ID inside "## Rebuttals (from B) of A claims" is returned to rebutting seat B', async (t) => {
  const dir = await tempDir(t, 'validate-crossref-rebuttal-');
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    `# Seat A findings\n\n${claimBlock('A1')}\n## Rebuttals (from B) of A claims\n\n### A1\nClaim: A1\nAction: DISPUTE\nEvidence:\n\`\`\`\ncontradicted by B1\n\`\`\`\n`
  );
  await fs.writeFile(path.join(dir, 'B-findings.md'), `# Seat B findings\n\n${claimBlock('B1')}`);
  const r = runCli(['validate', '--phase1-dir', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claim ID "B1" inside a fence .*return to seat B/);
  assert.match(r.stderr, /return to: seat B/);
  assert.doesNotMatch(r.stderr, /return to: seat A/);
});
