// The one reader of a Phase 1 seat file, used by review-run, the manifest and the report. The format is fixed:
// claim headings "## <seat letter><n> ...", then "## Checks performed"; or "## No findings" alone. That section holds
// exactly one unfenced line "Blocked: none" or "Blocked: <what>: <the error>". Anything else is refused with its reason.
import { parseFenceLines, splitLineSpans } from './blind-relabel.mjs';

const CLAIM_RE = /^##[ \t]+([AB])(\d+)\b/;
const SECTION_RE = /^## (Checks performed|No findings)[ \t]*$/;
const REBUTTALS_RE = /^## Rebuttals \(from [A-Z]\) of [A-Z] claims\s*$/;
const STRICT_BLOCKED_RE = /^Blocked: (\S.*?)[ \t]*$/;
const NOTHING_RE = /^(?:\(none\)|`none`|nothing|no|n\/a|na|nil|-+|no blocks?)\.?$/i;
// Read with emphasis marks removed, so "**Blocked**: x" says it too.
const BLOCKED_TEXT_RE = /\bblocked\s*[:：]/i;
const saysBlocked = (text) => BLOCKED_TEXT_RE.test(text.replace(/[*_~]/g, ''));
// A heading that is a section name in another shape (another level, emphasis, a number, a note in brackets, a final
// period) is refused; a heading that only mentions the words is not.
const sectionLike = (text) => {
  const m = /^\s{0,3}#{1,6}\s+(.*)$/.exec(text);
  if (!m) return false;
  const name = m[1].replace(/[*_`~]/g, '').replace(/^[\d().\s]+/, '').replace(/\([^)]*\)\s*$/, '').replace(/[.:\s]+$/, '');
  return /^(?:checks performed|no findings)$/i.test(name);
};
const quote = (text) => `"${text.trim().slice(0, 70)}"`;
// A line's text outside its inline code spans, as CommonMark reads them (a run of N backticks closes at exactly N).
const prose = (text) => splitLineSpans(text, false).filter((s) => !s.code).map((s) => s.text).join(' ');
// As validate reads it: anywhere in an unfenced line of the claim, with text after it.
const SAME_SHAPE_RE = /(?:^|[^A-Za-z])Same shape elsewhere:\s*\S/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

// role: the seat letter whose claims the file holds. Only the Phase 1 part is read (above any rebuttal section).
// sameShape: false skips the "Same shape elsewhere:" rule (the manifest reads older runs written before it).
// Returns { claims: [{ id, line }], section, blocked ('' for none, the named block, or null), sectionLines, problems }.
export function parseSeatFile(text, role, { sameShape = true } = {}) {
  const all = parseFenceLines(String(text ?? '')).lines;
  const end = all.findIndex((l) => !l.inFence && REBUTTALS_RE.test(l.text));
  const own = (end < 0 ? all : all.slice(0, end)).map((l, i) => ({ ...l, n: i + 1 })).filter((l) => !l.inFence);
  const problems = [];
  const claims = [];
  let section = null;
  let sectionAt = -1;
  for (const l of own) {
    const claim = CLAIM_RE.exec(l.text);
    if (claim) {
      if (claim[1] !== role) problems.push(`line ${l.n}: ${quote(l.text)} is not a seat ${role} claim heading`);
      else claims.push({ id: `${claim[1]}${claim[2]}`, line: l.n });
      continue;
    }
    const heading = SECTION_RE.exec(l.text);
    if (heading) {
      if (section) problems.push(`line ${l.n}: a second section heading "## ${heading[1]}"; write exactly one`);
      else {
        section = heading[1];
        sectionAt = l.n;
      }
      continue;
    }
    if (sectionLike(l.text)) problems.push(`line ${l.n}: ${quote(l.text)} is not a section heading; write exactly "## Checks performed" or "## No findings"`);
  }
  if (section === null) problems.push(claims.length > 0 ? 'no "## Checks performed" heading after the claims' : 'no claim heading and no "## No findings" heading');
  if (section === 'No findings' && claims.length > 0) problems.push('the file has claims and "## No findings"; a file with claims ends with "## Checks performed"');
  if (section === 'Checks performed' && claims.length === 0) problems.push('"## Checks performed" with no claim heading; a file with no claims has "## No findings" instead');
  if (section && claims.some((c) => c.line > sectionAt)) problems.push(`a claim heading comes after "## ${section}"; that section ends the file`);
  // Each claim names where else its shape occurs. As validate reads it, a claim ends at the next level-2 heading or a "---" break.
  for (const c of sameShape ? claims : []) {
    const body = own.filter((l) => l.n > c.line);
    const stop = body.findIndex((l) => /^## /.test(l.text) || THEMATIC_BREAK_RE.test(l.text));
    if (!(stop < 0 ? body : body.slice(0, stop)).some((l) => SAME_SHAPE_RE.test(l.text))) {
      problems.push(`claim ${c.id} has no "Same shape elsewhere:" line (name the other places with the same shape, or write "none found" and what you searched)`);
    }
  }
  // The section runs to the next level-1 or level-2 heading or the end of the Phase 1 part.
  const after = own.filter((l) => l.n > sectionAt);
  const stop = after.findIndex((l) => /^#{1,2} /.test(l.text));
  const sectionLines = section ? (stop < 0 ? after : after.slice(0, stop)) : [];
  const strict = sectionLines.filter((l) => STRICT_BLOCKED_RE.test(l.text));
  let blocked = null;
  if (section && strict.length === 1) {
    const named = STRICT_BLOCKED_RE.exec(strict[0].text)[1];
    blocked = /^none\.?$/i.test(named) ? '' : named;
    // "none" with a note after it, or another word for nothing, is neither a clean none nor a named block: the seat
    // says which, in its one rewrite.
    if (blocked && /^none(?=$|[\s,;:!(\u2013\u2014]|\.(?:\s|\.|$))/i.test(named)) problems.push(`line ${strict[0].n}: ${quote(strict[0].text)} adds text after "none"; write exactly "Blocked: none", or name what was blocked and the error`);
    else if (blocked && NOTHING_RE.test(named)) problems.push(`line ${strict[0].n}: ${quote(strict[0].text)} says nothing was blocked in another spelling; write exactly "Blocked: none", or name what was blocked and the error`);
  } else if (section && strict.length === 0) {
    problems.push(`"## ${section}" has no line "Blocked: none" or "Blocked: <what>: <the error>"`);
  } else if (section) {
    problems.push(`"## ${section}" has ${strict.length} Blocked: lines (${strict.map((l) => `line ${l.n}`).join(', ')}); write exactly one`);
  }
  // A claim may quote Blocked text in inline code; in the section only the one line may say it.
  const inSection = new Set(sectionLines.map((l) => l.n));
  for (const l of own) {
    if (strict.some((s) => s.n === l.n)) continue;
    if (inSection.has(l.n) && saysBlocked(l.text)) {
      problems.push(strict.length === 0
        ? `line ${l.n}: ${quote(l.text)} is not in the exact shape "Blocked: none" or "Blocked: <what>: <the error>" (at the start of the line, one space after the colon, no emphasis or list mark)`
        : `line ${l.n}: ${quote(l.text)} says "blocked:" in "## ${section}" besides its one Blocked: line; quote other Blocked text there only inside a code fence`);
    } else if (!inSection.has(l.n) && saysBlocked(prose(l.text))) {
      problems.push(`line ${l.n}: ${quote(l.text)} says "blocked:" outside the Blocked: line; quote other Blocked text in inline code or a code fence`);
    }
  }
  return { claims, section, blocked, sectionLines: sectionLines.map((l) => l.text), problems };
}

// True when the file is far enough to be read as a finished pass: a claim of its own seat or the No findings heading.
export function hasPassContent(text, role) {
  const { claims, section } = parseSeatFile(text, role);
  return claims.length > 0 || section === 'No findings';
}
