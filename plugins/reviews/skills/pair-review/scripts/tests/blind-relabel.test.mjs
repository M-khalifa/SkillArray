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
  flipMapping,
  invertSeatMapping,
  translateFindings,
  parseArgs,
  parseTokensArg,
  RelayError,
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
  const out = relabelText('\\`A1\\` is my claim', 'A', 'X');
  assert.equal(out, '\\`X1\\` is my claim');
});

test('relabelText: rewrites headings and prose claim IDs, skips fenced/inline code, strips the seat header', () => {
  const text = [
    '# Seat A findings — some target',
    '',
    '## A1 — a claim',
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
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  assert.match(out, /^## P3 — must still relabel$/m);
  assert.match(out, /P2 must relabel, this is not really a fence/, 'a 4-space "fence" must not hide a real claim ID from relabeling');
});

test('relabelText: a tab-indented ``` is also not a fence (CommonMark space-only cap), content relabels normally', () => {
  const text = '## A1 — claim\n\t```\nA2 must relabel here too\n\t```\n## A3 — must still relabel';
  const out = relabelText(text, 'A', 'P');
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
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  // A2 sits inside the double-backtick span, so it must survive byte-identical, unrewritten.
  assert.match(out, /``literal ` backtick and A2``/);
  assert.match(out, /\bP3\b/);
  assert.doesNotMatch(out, /\bA1\b/);
});

test('splitLineSpans: a single unmatched backtick run is literal text, so a claim ID after it still relabels', () => {
  const text = '## A1 — claim\nAn unterminated `A2 span with no closing backtick, then A3 in prose.';
  const out = relabelText(text, 'A', 'P');
  assert.match(out, /^## P1 — claim$/m);
  // A2 sits after an unmatched open backtick: treated as literal text, not code, so it relabels too.
  assert.match(out, /\bP2\b/);
  assert.match(out, /\bP3\b/);
});

test('splitLineSpans: a single-backtick close match must not be the first backtick of a following longer run', () => {
  const text = '## A1 — claim\nSee `A1`` and A2 in prose.';
  const out = relabelText(text, 'A', 'P');
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
  const pass2 = relabelText(pass1, 'B', 'Y');
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
    '# Seat A findings\n\n## A1 — real claim\nEvidence: something\n'
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
    '# Seat A findings\n\n## A1 — real finding\nEvidence:\n```text\n## A99 — literal text inside evidence\n```\n'
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

test('translateFindings: an inline-code span prefixing a heading-shaped string does not fabricate a Phase 1 claim (heading detection uses the RAW line, not the code-stripped one)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translate-inline-prefix-heading-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'A-findings.md'),
    // Stripping "`prefix`" would shift "## A99..." to position 0 -- a real Markdown renderer
    // never treats this as a heading, since the backtick span still occupies that position.
    '# Seat A findings\n\n## A1 — real finding\nEvidence: e\n\n`prefix`## A99 — this is not a heading\n'
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
    '# Seat A findings\n\n## A1 — first\nEvidence: e\n\n## A2 — second\nEvidence: e\n'
  );
  await fs.writeFile(
    path.join(dir, 'B-findings.md'),
    '# Seat B findings\n\n## B1 — first\nEvidence: e\n'
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
  await fs.writeFile(path.join(dir, 'A-findings.md'), '# Seat A findings\n\n## A1 — only\nEvidence: e\n');
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

    const scanResult = spawnSync(
      process.execPath,
      [SCRIPT, 'scan', '--in', outPath, '--target-dir', targetDir],
      { encoding: 'utf8' }
    );
    assert.equal(
      scanResult.status,
      0,
      `expected a clean scan (no identity leak) for ${outName}, got:\n${scanResult.stderr}`
    );
    assert.doesNotMatch(scanResult.stderr, /SELF-IDENTIFICATION/);
    assert.doesNotMatch(scanResult.stderr, /IDENTITY line/);
  }
});
