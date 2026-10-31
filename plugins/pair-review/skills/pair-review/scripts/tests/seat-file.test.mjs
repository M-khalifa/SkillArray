// The strict Phase 1 seat-file format: every shape the closing reviews found the loose readers missing is now refused
// with a stated reason, so a block can never hide behind a later "Blocked: none".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeatFile, hasPassContent } from '../seat-file.mjs';

const nl = String.fromCharCode(10);
const file = (...lines) => ['# Seat B findings', '', ...lines, ''].join(nl);
const claim = ['## B1 — one claim', 'Severity: LOW', 'Same shape elsewhere: none found', 'Evidence:', '```', 'x.js:1', '```'];

test('restructure round 1 F3: Blocked text a claim quotes in an inline code span of any width is not read; unquoted or unclosed it is refused', () => {
  const bt = String.fromCharCode(96);
  const withLine = (line) => file('## B1 — one claim', 'Severity: LOW', line, 'Same shape elsewhere: none found', '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none');
  for (const quoted of [`It wrote ${bt}Blocked: none${bt} twice.`, `It wrote ${bt}${bt} Blocked: a ${bt}x${bt} file ${bt}${bt} there.`, `It wrote ${bt.repeat(4)}Blocked: none${bt.repeat(4)} there.`, `${bt}${bt}${bt}Blocked: x${bt}${bt}${bt} and ${bt}Blocked: y${bt}`]) {
    assert.deepEqual(parseSeatFile(withLine(quoted), 'B').problems, [], quoted);
  }
  for (const bare of ['The port was blocked: by the proxy.', `It wrote ${bt}${bt}Blocked: x${bt} only.`, `${bt}a${bt} then Blocked: x`]) {
    assert.match(parseSeatFile(withLine(bare), 'B').problems.join(' '), /says "blocked:" outside the Blocked: line/, bare);
  }
});

test('a strict file is read: its claims, its section and its one Blocked: line, none or the named block verbatim', () => {
  const ok = parseSeatFile(file(...claim, '', '## Checks performed', '- AC-1: ok. MET', 'Blocked: none'), 'B');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.claims.map((c) => c.id), ['B1']);
  assert.equal(ok.section, 'Checks performed');
  assert.equal(ok.blocked, '');
  assert.deepEqual(ok.sectionLines.filter(Boolean), ['- AC-1: ok. MET', 'Blocked: none']);
  assert.equal(parseSeatFile(file('## No findings', '', 'Nothing in scope looked wrong.', 'Blocked: None.'), 'B').blocked, '');
  for (const named of ['none.js: EACCES', 'nonetheless.txt: ENOENT', 'the evidence folder: Access is denied', 'nonexistent.log: ENOENT', 'no network: ECONNREFUSED', 'nothing.md: EACCES', 'nil.json: ENOENT', '-x flag: refused']) {
    const p = parseSeatFile(file('## No findings', `Blocked: ${named}`), 'B');
    assert.deepEqual([p.problems, p.blocked], [[], named], named);
  }
  // Restructure round 3 F8 and pair review F1: "none" with any note or mark after it, and every other word for nothing,
  // is refused (one rewrite), never read as a block or as none.
  for (const noted of ['none (web off by the packet)', 'none, all reads worked', 'None - nothing refused', 'none; tests ran in Tier 2', 'none. Every file was readable.', 'none: all reads worked', 'none—all good', 'none!', 'none:', 'None..']) {
    const p = parseSeatFile(file('## No findings', `Blocked: ${noted}`), 'B');
    assert.match(p.problems.join(' '), /adds text after "none"; write exactly "Blocked: none"/, noted);
  }
  for (const nothing of ['nothing', 'Nothing.', 'no', 'No', 'n/a', 'N/A', 'na', 'nil', '-', '--', '(none)', '`none`', 'no blocks', 'No block.']) {
    const p = parseSeatFile(file('## No findings', `Blocked: ${nothing}`), 'B');
    assert.match(p.problems.join(' '), /says nothing was blocked in another spelling; write exactly "Blocked: none"/, nothing);
  }
  // CRLF, trailing spaces and a rebuttal section appended later do not change the reading.
  assert.deepEqual(parseSeatFile(file(...claim, '## Checks performed', 'Blocked: none  ').split(nl).join('\r\n'), 'B').problems, []);
  assert.deepEqual(parseSeatFile(file(...claim, '## Checks performed', 'Blocked: none', '', '## Rebuttals (from A) of B claims', '### P1', 'Blocked: in a rebuttal'), 'B').problems, []);
  // Blocked text quoted in a fence anywhere, or in inline code inside a claim, is evidence, not the seat's own line.
  const quoted = parseSeatFile(file('## B1 — the `Blocked: none` reader', 'Trigger: a file with `Blocked: x`', 'Same shape elsewhere: none found', '```', 'Blocked: from a test', '```', '## Checks performed', '```', 'Blocked: copied', '```', 'Blocked: none'), 'B');
  assert.deepEqual(quoted.problems, []);
});

test('closing rounds 1-5: every block shape the loose readers missed is refused, also after a strict "Blocked: none"', () => {
  const shapes = [
    // Round 1 F1 (indented code block) and F2 (a second line clears nothing).
    '    Blocked: none',
    // Round 2 F1: emphasis, a list item, upper case, no space after the colon.
    '**Blocked**: rg missing', '- **Blocked**: rg missing', '*Blocked:* rg missing', '_Blocked:_ rg missing', '1. Blocked: rg missing', 'BLOCKED: rg missing', 'Blocked:rg missing', '- Blocked: rg missing',
    // Round 3 F2: a heading, a task box, a bullet dot, a parenthesised number, a table row.
    '### Blocked: rg missing', '- [ ] Blocked: rg missing', '• Blocked: rg missing', '(1) Blocked: rg missing', '| Blocked: rg missing |',
    // Round 4 F6: a letter or roman label, a dash marker, a definition colon, a full-width colon.
    'a. Blocked: rg missing', 'iv) Blocked: rg missing', '— Blocked: rg missing', ': Blocked: rg missing', 'Blocked： rg missing',
    // Round 5 F8: stacked list labels.
    '1. 2. Blocked: rg missing', '(1) (2) Blocked: rg missing', '1. a. Blocked: rg missing',
    // A sentence that says it.
    'Nothing was blocked: all reads worked.',
  ];
  const missed = [];
  for (const section of ['## No findings', '## Checks performed']) {
    for (const shape of shapes) {
      for (const before of [['Blocked: none'], []]) {
        const lines = section === '## No findings' ? [section, ...before, shape] : [...claim, section, ...before, shape];
        const p = parseSeatFile(file(...lines), 'B');
        if (p.problems.length === 0) missed.push(`${section} | ${JSON.stringify(shape)} | after none: ${before.length > 0}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  assert.match(parseSeatFile(file('## No findings', 'Blocked: rg missing', 'Blocked: none'), 'B').problems.join(), /has 2 Blocked: lines \(line 4, line 5\); write exactly one/);
  assert.match(parseSeatFile(file('## No findings', 'Blocked: none', '**Blocked:** rg missing'), 'B').problems.join(), /line 5: "\*\*Blocked:\*\* rg missing" says "blocked:" in "## No findings" besides its one Blocked: line/);
  assert.match(parseSeatFile(file('## No findings', 'Blocked: none', '- AC-4: `Blocked: x` quoted'), 'B').problems.join(), /besides its one Blocked: line/, 'in the section inline code does not quote');
  assert.match(parseSeatFile(file('## B1 — the Blocked: reader', '## Checks performed', 'Blocked: none'), 'B').problems.join(), /line 3: .* says "blocked:" outside the Blocked: line; quote other Blocked text in inline code or a code fence/);
});

test('closing rounds 4-5: a section heading in any other shape, a cut-off file and a fenced heading are refused, never read', () => {
  for (const heading of ['### Checks performed', '## **Checks performed**', '## (1) Checks performed', '## 4. Checks performed', '# Checks performed', '## Checks performed:', '## `Checks performed`', '#### No findings', '## No findings.']) {
    const lines = /No findings/.test(heading) ? [heading, 'Blocked: none'] : [...claim, heading, 'Blocked: none'];
    const p = parseSeatFile(file(...lines), 'B');
    assert.ok(p.problems.some((x) => /is not a section heading; write exactly "## Checks performed" or "## No findings"/.test(x)), heading);
    assert.equal(p.section, null, heading);
  }
  const refused = (lines, pattern, why) => assert.match(parseSeatFile(file(...lines), 'B').problems.join(' | '), pattern, why);
  refused(claim, /no "## Checks performed" heading after the claims/, 'cut off after a claim');
  refused(['## Checks performed', 'Blocked: none'], /"## Checks performed" with no claim heading/, 'only the section heading');
  refused(['```', '## No findings', 'Blocked: none', '```'], /no claim heading and no "## No findings" heading/, 'a heading only inside a fence');
  refused(['## B1 — x', '## No findings', 'Blocked: none'], /has claims and "## No findings"/, 'both');
  refused(['## No findings', 'Blocked: none', '## Checks performed', 'Blocked: none'], /a second section heading/, 'two sections');
  refused([...claim, '## Checks performed', 'Blocked: none', '## B2 — late'], /a claim heading comes after "## Checks performed"/, 'a claim after the section');
  refused(['## A1 — the peer letter', '## Checks performed', 'Blocked: none'], /"## A1 — the peer letter" is not a seat B claim heading/, 'another seat\'s letter');
  refused(['## No findings', 'Nothing found.'], /"## No findings" has no line "Blocked: none"/, 'no Blocked: line');
});

test('hasPassContent: a claim of the seat or the No findings heading, unfenced', () => {
  assert.equal(hasPassContent(file('## B1 — x'), 'B'), true);
  assert.equal(hasPassContent(file('## No findings'), 'B'), true);
  assert.equal(hasPassContent(file('```', '## B1 — fenced', '```'), 'B'), false);
  assert.equal(hasPassContent(file('## A1 — other seat'), 'B'), false);
  assert.equal(hasPassContent('# Seat B findings\n', 'B'), false);
});

test('step 3 review: a heading that only mentions the words is kept, a spaced claim heading counts, reasons name the real fault', () => {
  const ok = parseSeatFile(file('##  B1 — two spaces', 'Severity: LOW', 'Same shape elsewhere: none found', '### Evidence: the no findings path', '## H1 notes', '- unblocked: yes', '', '## Checks performed', 'Blocked: none'), 'B');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.claims.map((c) => c.id), ['B1']);
  const loose = parseSeatFile(file('## No findings', 'Blocked:none'), 'B');
  assert.ok(loose.problems.some((p) => /line 4: "Blocked:none" is not in the exact shape/.test(p)), loose.problems.join(' | '));
  assert.ok(!loose.problems.some((p) => /besides its one Blocked: line/.test(p)), 'no "besides" when there is no strict line');
});

test('step 5 (D3): every claim names where else its shape occurs; a claim without the line is refused with that reason', () => {
  const p = parseSeatFile(file('## B1 — one', 'Severity: LOW', '## B2 — two', 'Severity: LOW', 'Impact: x. Same shape elsewhere: y.js:3', '', '## Checks performed', 'Blocked: none'), 'B');
  assert.deepEqual(p.problems, ['claim B1 has no "Same shape elsewhere:" line (name the other places with the same shape, or write "none found" and what you searched)']);
  const fenced = parseSeatFile(file('## B1 — one', '```', 'Same shape elsewhere: quoted', '```', '## Checks performed', 'Blocked: none'), 'B');
  assert.equal(fenced.problems.length, 1, 'a fenced line does not count');
  const empty = parseSeatFile(file('## B1 — one', 'Same shape elsewhere:', '## Checks performed', 'Blocked: none'), 'B');
  assert.equal(empty.problems.length, 1, 'the line needs text after the colon');
});

test('step 4-5 review: a claim ends at a "---" break as validate reads it, so a Same shape line below it does not count; sameShape: false skips the rule', () => {
  const text = file('## B1 — one', 'Severity: LOW', '', '---', '', 'Same shape elsewhere: none found', '', '## Checks performed', 'Blocked: none');
  assert.deepEqual(parseSeatFile(text, 'B').problems, ['claim B1 has no "Same shape elsewhere:" line (name the other places with the same shape, or write "none found" and what you searched)']);
  assert.deepEqual(parseSeatFile(text, 'B', { sameShape: false }).problems, []);
});
