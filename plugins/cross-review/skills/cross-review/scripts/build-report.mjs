// Builds the review report from the run's own files, so IDs, counts and states are never retyped.
// The terminal report is the default output; --out writes a markdown copy, --html an optional standalone page.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseFenceLines } from './blind-relabel.mjs';
import { parseSeatFile } from './seat-file.mjs';
import { makeIo, refuseDirectRun, runStep as runStepWith } from './step-io.mjs';

// Which skill wrote a report or scorecard: its name and version from this copy's SKILL.md (the version that ran, from the
// manifest, wins) and the project's home page. Printed as one line at the end of each output.
export const PROJECT_URL = 'https://github.com/M-khalifa/SkillArray';
let ownSkill;
export function generatorInfo(version = null) {
  if (ownSkill === undefined) {
    try {
      const md = readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'SKILL.md'), 'utf8');
      ownSkill = { name: /^name:\s*(\S+)\s*$/m.exec(md)?.[1] ?? null, version: /^\s+version:\s*(\S+)\s*$/m.exec(md)?.[1] ?? null };
    } catch {
      ownSkill = { name: null, version: null };
    }
  }
  return { skill: ownSkill.name ?? 'SkillArray review', version: typeof version === 'string' && version !== '' ? version : ownSkill.version, url: PROJECT_URL };
}

export function generatorLine(g = generatorInfo()) {
  return `Reviewed with ${g.skill}${g.version ? ` ${g.version}` : ''} (SkillArray, MIT license): ${g.url}`;
}

class ReportError extends Error {}
const io = makeIo();

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const overlapText = (o) => `seat A only ${o.aOnly}, seat B only ${o.bOnly}, both ${o.both} (observed counts)`;
const SEV_KEY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

export function parseArgs(argv) {
  const args = { runDir: null, notes: null, color: 'auto', format: 'text', all: false, out: null, json: null, html: null, changeDiffs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ReportError(`${tok} requires a value`);
      return v;
    };
    if (tok === '--run-dir') args.runDir = value();
    else if (tok === '--notes') args.notes = value();
    else if (tok === '--color') {
      args.color = value();
      if (!['auto', 'always', 'never'].includes(args.color)) throw new ReportError('--color must be auto, always or never');
    } else if (tok === '--format') {
      args.format = value();
      if (!['text', 'chat'].includes(args.format)) throw new ReportError('--format must be text or chat');
    } else if (tok === '--all') args.all = true;
    else if (tok === '--out') args.out = value();
    else if (tok === '--json') args.json = value();
    else if (tok === '--html') args.html = value();
    else if (tok === '--change-diff') args.changeDiffs.push(value());
    else throw new ReportError(`unrecognized argument: ${tok}`);
  }
  if (!args.runDir) throw new ReportError('--run-dir <dir> is required');
  // The text, markdown and HTML outputs already hold every finding, criterion and the cost, so --all changes only chat.
  return args;
}

const noBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

async function readJson(file, what) {
  try {
    return JSON.parse(noBom(await readFile(file, 'utf8')));
  } catch (err) {
    throw new ReportError(`cannot read ${what} ${file}: ${err.message}`);
  }
}

async function readOptional(file) {
  return existsSync(file) ? noBom(await readFile(file, 'utf8')) : '';
}

export const finalSeverity = (f) => String(f.severity_audited ?? f.severity ?? '').toUpperCase();

export function isBlocker(f) {
  if (f.final_state === 'unresolved-high-stakes') return true;
  if (f.final_state === 'settled-refuted' || f.final_state === 'dropped-speculative') return false;
  return finalSeverity(f) === 'HIGH' || finalSeverity(f) === 'CRITICAL';
}

// First sentence of a finding's summary, capped; the full text stays in scorecard.md and findings.json.
const ABBREVIATION_RE = /(?:^|[^A-Za-z])(?:e\.g|i\.e|etc|vs|cf|approx|no)$/i;

// The text up to the first sentence end, skipping a full stop that closes an abbreviation such as "e.g." or "etc.".
// Said by the report and by recheck (before the round is paid for) from round 3 on.
export const stepBackNote = (round) => `Round ${round}: findings keep coming from fixes. Before another round, consider a test that tries every combination of the inputs the findings name, or a redesign of the function they keep landing in.`;

export function firstSentence(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  for (const m of clean.matchAll(/[.!?](?=\s|$)/g)) {
    if (!ABBREVIATION_RE.test(clean.slice(0, m.index))) return clean.slice(0, m.index + 1);
  }
  return clean;
}

export function shortTitle(f, cap = 110) {
  const text = String(f.title ?? f.summary ?? '').replace(/\s+/g, ' ').trim();
  const first = firstSentence(text);
  if (first.length <= cap) return first;
  // A clause ends at ": " or "; ", never at the colon inside "${env:X}" or "C:\".
  const clause = /^(.{40,}?)[:;](?=\s)/.exec(first.slice(0, cap + 1));
  if (clause && clause[1].length <= cap) return clause[1].trimEnd();
  const room = first.slice(0, cap - 3);
  const cut = room.lastIndexOf(' ');
  return `${(cut > 40 ? room.slice(0, cut) : room).trimEnd()}...`;
}

const idNumber = (id) => Number(/\d+/.exec(String(id))?.[0] ?? 0);

export function compactTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'unknown';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return Math.round(n / 1e3) >= 1000 ? '1M' : `${Math.round(n / 1e3)}k`;
  return String(n);
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One row for every seat, same columns whatever the provider reports: new input, cache read, output, calls.
// A Claude transcript reports new and cache-read tokens apart; Codex reports total input with the cached part inside it,
// so its new input is input minus cached and the cached part goes under cache read.
export function seatCostRow(name, u, { anthropic = false } = {}) {
  const base = { seat: name, newInput: null, cacheWrite: null, cacheRead: null, output: null, calls: null };
  if (!u || typeof u !== 'object') return base;
  const row = finite(u.calls_without_usage) > 0 ? { ...base, callsWithoutUsage: u.calls_without_usage } : base;
  if (u.new_input_tokens !== undefined || u.context_reread_tokens !== undefined) {
    // new_input_tokens holds fresh input plus the cache write (all input not read from the cache); the cache write is also shown on its own.
    const write = finite(u.cache_creation_input_tokens);
    const fresh = finite(u.input_tokens);
    const split = write !== null && fresh !== null;
    return { ...row, newInput: split ? fresh + write : finite(u.new_input_tokens), cacheWrite: split ? write : null, cacheRead: finite(u.context_reread_tokens), output: finite(u.output_tokens), calls: finite(u.calls) };
  }
  if (anthropic && u.input_tokens !== undefined) {
    const input = finite(u.input_tokens);
    const write = finite(u.cache_write_input_tokens);
    return { ...row, newInput: input !== null ? input + (write ?? 0) : null, cacheWrite: write, cacheRead: finite(u.cached_input_tokens), output: finite(u.output_tokens), calls: finite(u.calls) };
  }
  if (u.input_tokens !== undefined) {
    const input = finite(u.input_tokens);
    const cached = finite(u.cached_input_tokens);
    return { ...row, newInput: input !== null && cached !== null ? inclusiveNew(input, cached) : input, cacheRead: cached, output: finite(u.output_tokens), calls: finite(u.calls) };
  }
  return row;
}

// Input that includes the cache: more cached than input means the record is not that shape, so the figure is unknown.
const inclusiveNew = (input, cached) => (cached > input ? null : input - cached);

// New input of each call of a resumed Codex seat (a call's own tokens, as the manifest stores them).
export function perCallNewInput(calls, anthropic = false) {
  return calls.map((u) => {
    if (anthropic) return finite(u?.input_tokens) === null ? null : u.input_tokens + (finite(u?.cache_write_input_tokens) ?? 0);
    const input = finite(u?.input_tokens);
    const cached = finite(u?.cached_input_tokens);
    return input !== null && cached !== null ? inclusiveNew(input, cached) : null;
  });
}

// Claude and OpenCode report input and cache apart; Codex counts the cache inside input. The provider decides, else the raw fields.
export const separateCache = (u, provider, model) => provider === 'anthropic' || provider === 'opencode' || /^claude/i.test(model ?? '')
  || u?.raw?.cache_creation_input_tokens !== undefined || u?.raw?.cache_read_input_tokens !== undefined || u?.raw?.tokens?.cache !== undefined;

// A native agent's transcript does not record output tokens, so the table is a lower bound for those rows.
export const costNote = (rows) => {
  const notes = [];
  if (rows.some((r) => r.output === null && r.calls > 0)) notes.push('Output is unknown for native agents (their transcript does not record it); their real cost is higher than shown.');
  // A call that reported no usage (rate-limited, failed) is left out of the sum, so the row is a lower bound.
  for (const r of rows.filter((x) => x.callsWithoutUsage > 0)) notes.push(`${r.seat}: a lower bound; ${r.callsWithoutUsage} call(s) reported no usage and are not counted.`);
  return notes.length > 0 ? notes.join(' ') : null;
};
// The manifest records the calls passed to it; a preflight session probe and an attempt that was rerun are not among them.
export const COST_SCOPE = 'New input is the input not read from the cache, for every seat (a Claude seat: its input plus the cache write; a Codex seat: its input minus the cached part). Calls are model calls, not tool calls. The cost covers the completed review calls in tokens; session probes and earlier failed attempts are not counted. No dollar figure is shown: no price table ships with the skill.';

// The shell commands a seat tried and how many failed, as the manifest counted them; a row without a count is never guessed.
const validScripts = (c) => Number.isInteger(c.scripts) && Number.isInteger(c.scriptsFailed) && c.scriptsFailed >= 0 && c.scriptsFailed <= c.scripts && c.scripts > 0;
const validCommands = (c) => (c && Number.isInteger(c.tried) && Number.isInteger(c.failed) && c.failed >= 0 && c.failed <= c.tried
  ? { tried: c.tried, failed: c.failed, ...(validScripts(c) ? { scripts: c.scripts, scriptsFailed: c.scriptsFailed } : {}) } : null);
const withCommands = (row, c) => (validCommands(c) ? { ...row, commands: validCommands(c) } : row);
export const commandsCell = (r) => (r.commands
  ? `${r.commands.tried} tried, ${r.commands.failed} failed${r.commands.scripts ? `; ${r.commands.scripts} tool scripts, ${r.commands.scriptsFailed} failed` : ''}`
  : 'unknown');

export function costTableLines(rows) {
  const fmt = (n) => compactTokens(n);
  const write = rows.some((r) => r.cacheWrite !== null && r.cacheWrite !== undefined);
  const cmds = rows.some((r) => r.commands);
  const body = rows.map((r) => [r.seat, fmt(r.newInput), ...(write ? [r.cacheWrite == null ? '-' : fmt(r.cacheWrite)] : []), fmt(r.cacheRead), fmt(r.output), r.calls === null ? '-' : String(r.calls), ...(cmds ? [commandsCell(r)] : [])]);
  const table = [['Seat', 'New input', ...(write ? ['Cache write'] : []), 'Cache read', 'Output', 'Calls', ...(cmds ? ['Commands'] : [])], ...body];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return table.map((row) => row.map((cellText, i) => (i === 0 ? cellText.padEnd(widths[i]) : cellText.padStart(widths[i]))).join('  ').trimEnd());
}

const TAG_LINE_RE = /^\s*[-*]\s+\**\[([A-Za-z][A-Za-z0-9._-]*)\]\**\s*(.*)$/;
const HEADING_TAG_RE = /\[([A-Za-z][A-Za-z0-9._-]*)\]/g;

export function packetCriteria(packetText) {
  const seen = new Map();
  for (const line of packetText.split(/\r?\n/)) {
    const m = TAG_LINE_RE.exec(line);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2].trim());
  }
  return seen;
}

// "Tickets: 6041 = AC-OWN-C, AC-OWN-D; 6045 = AC-OWN-E" (or one "Ticket 6041: AC-OWN-C" line each) maps tags that do not carry a ticket number.
// "AC-6040-1..-5", "AC-6040-1..5" or "AC-6040-1..AC-6040-5" stands for AC-6040-1 to AC-6040-5.
export function expandTagRange(tag) {
  const m = /^(.+?-)(\d+)\.\.(?:-|\1)?(\d+)$/.exec(tag);
  if (!m || Number(m[3]) < Number(m[2]) || Number(m[3]) - Number(m[2]) > 200) return [tag];
  return Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, i) => `${m[1]}${Number(m[2]) + i}`);
}

// A "Tickets:" line (bold label too), and its entries: "6041 = AC-1, AC-2; 6045 = AC-3" or "6041=AC-1, 6042=AC-2".
export const TICKETS_LINE_RE = /^(\s*(?:[-*]\s*)?\**Tickets?\b[*:\s]*)(.*)$/i;
export const splitTicketEntries = (text) => text.split(/;|,(?=\s*#?\d+\s*[=:])/);

export function packetTicketMap(packetText) {
  const map = new Map();
  for (const line of packetText.split(/\r?\n/)) {
    const m = TICKETS_LINE_RE.exec(line);
    if (!m) continue;
    for (const part of splitTicketEntries(m[2])) {
      const t = /^\s*#?(\d+)\s*[=:]\s*(.+?)\s*$/.exec(part);
      if (!t) continue;
      for (const raw of t[2].split(/[,\s]+/).filter(Boolean)) {
        for (const tag of expandTagRange(raw.replace(/^\[|\]$/g, ''))) {
          if (!map.has(tag)) map.set(tag, []);
          if (!map.get(tag).includes(t[1])) map.get(tag).push(t[1]);
        }
      }
    }
  }
  return map;
}

// The tags a claim heading carries: bracketed ones, and packet tags written bare ("violates AC-1"). The scorecard reads them the same way.
export const headingTags = (heading, known = []) => [...new Set([...[...heading.matchAll(HEADING_TAG_RE)].map((t) => t[1]), ...known.filter((tag) => tagPattern(tag).test(heading))])];

// A seat file with its fenced lines blanked: a heading quoted inside an evidence block is not structure.
const unfenced = (seatText) => parseFenceLines(seatText).lines.map((l) => (l.inFence ? '' : l.text)).join('\n');

function claimHeadingTags(seatText, known = []) {
  const out = new Map();
  for (const line of unfenced(seatText).split('\n')) {
    const m = /^##\s+([AB]\d+)\b(.*)$/.exec(line);
    if (m) out.set(m[1], headingTags(m[2], known));
  }
  return out;
}

// The seat's checks: its "## Checks performed" section, or its "## No findings" section when it has no claim, as the one
// format reader finds it (unfenced lines; empty when it has neither).
export function checksPerformed(seatText, role) {
  return parseSeatFile(seatText, role ?? (/^##\s+([AB])\d+\b/m.exec(unfenced(seatText))?.[1] ?? 'A')).sectionLines.join('\n');
}

export function criteriaGroup(tag) {
  const m = /^[A-Za-z]+-(\d+)-[A-Za-z0-9._-]+$/.exec(tag) ?? /^[A-Za-z]+-(\d{4,})$/.exec(tag);
  return m ? m[1] : 'other';
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tagPattern = (tag) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(tag)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);

// Verdict words are read from one copy of a line: no bold or code marks, every dash as "-", one space between words.
const verdictLine = (line) => String(line ?? '').replace(/[*`]/g, '').replace(/\p{Pd}/gu, '-').replace(/\s+/g, ' ').trim();

// After the last verdict word only punctuation and one "(...)" may follow: "NOT MET (claims A3, A4)." ends with its verdict.
const AT_END = '[\\s.,;:!)]*(?:\\([^()]*\\)[\\s.,;:!]*)?$';
const WORD_START = '(?<![A-Za-z0-9_-])';

// The verdict a line states: a table row's last cell that is only a verdict, else the verdict at the end of the line
// (any case), else the last upper-case verdict word on it. Returns the word and where the text after it starts.
function lineVerdict(text, words) {
  if (text.startsWith('|')) {
    const cells = text.split('|').slice(1, -1).map((c) => c.trim());
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const m = words.cell.exec(cells[i]);
      if (m) return { word: m[1], rest: cells.slice(i + 1).join(' | ') };
    }
  }
  const end = words.end.exec(text);
  if (end) return { word: end[1], rest: text.slice(end.index + end[1].length) };
  const last = [...text.matchAll(words.any)].at(-1);
  return last ? { word: last[1], rest: text.slice(last.index + last[1].length) } : null;
}

const CRITERION_WORDS = {
  // "PARTIALLY MET" is partial and "not fully met" is not met: the longer phrase is read before the bare MET.
  cell: /^(not[ _-]?(?:(?:yet|fully|quite|entirely|completely)[ _-])?met|un-?met|partial(?:ly)?(?:[ _-]?met)?|met)\.?$/i,
  end: new RegExp(`${WORD_START}(not[ _-]?(?:(?:yet|fully|quite|entirely|completely)[ _-])?met|un-?met|partial(?:ly)?(?:[ _-]?met)?|met)${AT_END}`, 'i'),
  any: new RegExp(`${WORD_START}((?:[Nn][Oo][Tt][ _-]?(?:(?:[Yy][Ee][Tt]|[Ff][Uu][Ll][Ll][Yy])[ _-])?|UN-?)?MET|PARTIAL(?:LY)?(?:[ _-]?MET)?)(?![A-Za-z0-9_-])`, 'g'),
};
const criterionWord = (w) => (/^partial/i.test(w) ? 'PARTIAL' : /^met$/i.test(w) ? 'MET' : 'NOT MET');

const TICKET_WORDS = {
  cell: /^(not?[ _-]?go|go)\.?$/i,
  end: new RegExp(`${WORD_START}(not?[ _-]?go|go)${AT_END}`, 'i'),
  any: new RegExp(`${WORD_START}((?:[Nn][Oo][Tt]?[ _-]?)?GO)(?![A-Za-z0-9_-])`, 'g'),
};

const OUTCOME_END = new RegExp(`${WORD_START}((?:partly|partially) confirmed|confirmed|supported|refuted|disproved|disproven)${AT_END}`);

// The outcome a seat wrote on its Checks performed line for a hypothesis: REFUTED, PARTLY, MIXED, CONFIRMED, or null.
// The word that ends the line decides; without one, every outcome word on the line counts.
export function parseOutcome(line) {
  const text = verdictLine(line).toLowerCase().replace(/(?:\bnot|\bnever|\bcannot|\bcould not|\bunable to|n't)\s+(?:be\s+|been\s+|fully\s+|yet\s+)*(?:confirmed|supported|refuted|disproved|disproven)\b/g, ' ');
  const end = OUTCOME_END.exec(text);
  if (end) return /^part/.test(end[1]) ? 'PARTLY' : /^(?:confirmed|supported)$/.test(end[1]) ? 'CONFIRMED' : 'REFUTED';
  const refuted = /\b(refuted|disproved|disproven)\b/.test(text);
  const partly = /\b(partly|partially)\b/.test(text);
  const confirmed = /\b(confirmed|supported)\b/.test(text);
  if (refuted && (confirmed || partly)) return 'MIXED';
  if (refuted) return 'REFUTED';
  if (partly && confirmed) return 'PARTLY';
  if (confirmed) return 'CONFIRMED';
  return null;
}

// A check line that reports a failure: negated phrases ("does not fail") are dropped first.
const FAILED_CHECK_RE = /\b(?:fails?|failed|failing|violat\w+|broken|not met)\b/i;
const NOT_A_FAILURE = [/`[^`]*`/g, /(?<![A-Za-z0-9])'[^']*'/g, /"[^"]*"/g, /\b\w+(?:[-_.]\w+)+\b/g, /\bfail(?:s|ed)?\s+(?:as intended|as expected|before the fix|without the fix|at HEAD|on HEAD)\b/gi];
const failedCheck = (line) => FAILED_CHECK_RE.test(NOT_A_FAILURE.reduce((text, re) => text.replace(re, ' '), String(line ?? '')).replace(/\b(?:not|never|no|n't)\s+(?:\w+\s+)?(?:fail\w*|violat\w+|broken)\b/gi, ' '));

// A seat that names a tag but says it could not do the check has not verified it.
const INCOMPLETE_CHECK_RE = /\b(?:unverified|not verified|could not|couldn't|cannot|can't|not available|not run|unable to|skipped)\b/i;

// A seat's verdict on a criterion: MET, PARTIAL or NOT MET, read by lineVerdict; the tag itself is never a verdict.
const VERDICT_RANK = { 'NOT MET': 3, PARTIAL: 2, MET: 1 };
export function parseVerdict(line, tag = null) {
  const text = verdictLine(line);
  const hit = lineVerdict(tag ? verdictLine(text.split(tag).join(' ')) : text, CRITERION_WORDS);
  return hit ? criterionWord(hit.word) : null;
}
const worstVerdict = (list) => (list.length === 0 ? null : list.reduce((a, b) => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a)));

// A line that starts with the tag: a bullet, list number, quote, table bar, bracket, bold or code mark may come first.
const leadRe = (tag) => new RegExp(`^[\\s>|*\`[-]*(?:\\d+[.)]\\s+)?[\\s*\`[]*${escapeRe(tag)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);

// "- 6048: GO." or "6049 - NO GO, reason": a line that starts with the ticket id; the worst verdict over a seat's lines,
// and a NO GO from any seat, wins.
export function buildTickets(rows, checksBySeat) {
  const ids = [...new Set(rows.flatMap((r) => (r.kind === 'hypothesis' ? [] : r.groups)).filter((g) => /^\d+$/.test(g)))];
  return ids.map((id) => {
    const lineRe = new RegExp(`^[\\s>|-]*(?:\\d+[.)]\\s+)?(?:Ticket\\s+)?#?${id}(?![0-9]|-\\d)\\s*(?:\\([^)]*\\)\\s*)?[:|=-]`, 'i');
    const seats = {};
    for (const [seat, body] of Object.entries(checksBySeat)) {
      const said = body.split(/\r?\n/).map(verdictLine).filter((l) => lineRe.test(l)).map((l) => lineVerdict(l.replace(lineRe, l.startsWith('|') ? '| ' : '').trim(), TICKET_WORDS)).filter(Boolean)
        .map((hit) => ({ verdict: /^go$/i.test(hit.word) ? 'GO' : 'NO GO', text: hit.rest.replace(/^[\s.:,|-]+/, '').replace(/[\s|]+$/, '') }));
      const pick = said.find((v) => v.verdict === 'NO GO') ?? said[0];
      if (pick) seats[seat] = pick;
    }
    const entries = Object.entries(seats);
    const worst = entries.find(([, v]) => v.verdict === 'NO GO') ?? entries[0];
    const findings = [...new Set(rows.filter((r) => r.groups?.includes(id)).flatMap((r) => r.findings ?? []))];
    return { id, findings, verdict: worst ? worst[1].verdict : null, text: worst ? worst[1].text : '', seats: Object.fromEntries(entries.map(([k, v]) => [k, v.verdict])) };
  });
}

// One seat's outcome over several lines for the same hypothesis: agreeing lines keep their word, a REFUTED next to anything else is MIXED.
const mergeOutcomes = (list) => {
  const seen = new Set(list.filter(Boolean));
  if (seen.size <= 1) return [...seen][0] ?? null;
  return seen.has('REFUTED') || seen.has('MIXED') ? 'MIXED' : 'PARTLY';
};

// A reason cut at word boundaries into at most maxLines lines of width characters; the last line ends in "..." when text is left over.
const wrapText = (text, width, maxLines) => {
  const out = [];
  let cur = '';
  for (const word of String(text).split(' ').filter(Boolean)) {
    if (cur && `${cur} ${word}`.length > width) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, width - 3)).trimEnd()}...`;
  return kept;
};

// A long reason keeps its end, where a seat writes what is missing: whole sentences from the end that fit in max characters.
const keepEnd = (text, max) => {
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.;])\s+/);
  let out = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const next = out ? `${sentences[i]} ${out}` : sentences[i];
    if (next.length > max - 4) break;
    out = next;
  }
  if (!out) out = text.slice(-(max - 4)).replace(/^\S*\s/, '');
  return `... ${out}`;
};

// What a seat wrote after the tag on its check line for a criterion it marked NOT MET or PARTIAL: the reason, its end kept when it is long.
const reasonOf = (line, tag) => {
  const text = String(line).replace(/[*`|]/g, ' ');
  const at = text.indexOf(tag);
  const rest = (at < 0 ? text : text.slice(at + tag.length)).replace(/^[\s:\]\-\u2013\u2014]+/, '').replace(/^(?:not[ _-]?met|un-?met|partial(?:ly)?(?:[ _-]?met)?|met)\b[\s:,.\-\u2013\u2014]*/i, '').replace(/\s+/g, ' ').trim();
  return keepEnd(rest, 300);
};

// A checked criterion with no finding that a seat marked NOT MET or PARTIAL, or whose line reports a failure: never "no issue found".
export const isUnmet = (r) => r.kind === 'criterion' && r.status === 'clean' && (r.met === 'NOT MET' || r.met === 'PARTIAL' || r.failedSeats.length > 0);

// A tag the Tickets line does not list, such as AC-30-F6 beside "6030 = AC-30-1..AC-30-5", joins the one listed ticket whose number ends in its number (30).
const groupsOf = (tag, hypothesis, ticketMap) => {
  if (hypothesis) return ['hypotheses'];
  if (ticketMap.has(tag)) return ticketMap.get(tag);
  const group = criteriaGroup(tag);
  if (/^\d{1,3}$/.test(group)) {
    const ends = [...new Set([...ticketMap.values()].flat())].filter((id) => id.length > group.length && id.endsWith(group));
    if (ends.length === 1) return [ends[0]];
  }
  return [group];
};

export function buildCriteria(criteria, findings, headingTags, checksBySeat, ticketMap = new Map(), { fixWordedFlips = true } = {}) {
  if (criteria.size === 0) return null;
  const tagToFindings = new Map();
  const tagToRefuted = new Map();
  const tagToRaisedBy = new Map();
  for (const f of findings) {
    const settledAway = f.final_state === 'settled-refuted' || f.final_state === 'dropped-speculative';
    for (const origin of f.origins ?? []) {
      for (const tag of headingTags.get(origin) ?? []) {
        const map = settledAway ? tagToRefuted : tagToFindings;
        if (!map.has(tag)) map.set(tag, new Set());
        map.get(tag).add(f.id);
        if (settledAway) {
          if (!tagToRaisedBy.has(tag)) tagToRaisedBy.set(tag, new Set());
          tagToRaisedBy.get(tag).add(String(origin).charAt(0));
        }
      }
    }
  }
  // A seat's lines for a tag: those that start with it; when none does, those that mention it and start with no other packet tag.
  const known = [...criteria.keys()];
  const leads = new Map(known.map((tag) => [tag, leadRe(tag)]));
  const linesBySeat = Object.fromEntries(Object.entries(checksBySeat).map(([seat, body]) => {
    const all = body.split(/\r?\n/);
    return [seat, Object.fromEntries(known.map((tag) => {
      const own = all.filter((l) => leads.get(tag).test(l));
      return [tag, own.length > 0 ? own : all.filter((l) => tagPattern(tag).test(l) && !known.some((other) => leads.get(other).test(l)))];
    }))];
  }));
  const rows = [...criteria.entries()].map(([tag, text]) => {
    const found = [...(tagToFindings.get(tag) ?? [])];
    const refuted = [...(tagToRefuted.get(tag) ?? [])];
    const linesOf = (seat) => linesBySeat[seat][tag];
    const named = Object.keys(checksBySeat).filter((seat) => linesOf(seat).length > 0);
    // A seat that raised a claim on a criterion looked at it, even when the claim was later refuted.
    const seats = [...new Set([...named, ...(found.length === 0 ? [...(tagToRaisedBy.get(tag) ?? [])] : [])])].sort();
    const status = found.length > 0 ? 'issue' : seats.length > 0 ? 'clean' : 'not-verified';
    const hypothesis = /^H\d+$/i.test(tag);
    const seatVerdict = Object.fromEntries(named.map((seat) => [seat, hypothesis ? mergeOutcomes(linesOf(seat).map(parseOutcome)) : worstVerdict(linesOf(seat).map((l) => parseVerdict(l, tag)).filter(Boolean))]));
    // Failure and "could not" words only count on lines with no verdict word: an explicit verdict is what the seat decided.
    const failedSeats = status === 'clean' && !hypothesis ? named.filter((seat) => seatVerdict[seat] === 'NOT MET' || (seatVerdict[seat] === null && linesOf(seat).some(failedCheck))) : [];
    const doubt = named.filter((seat) => seatVerdict[seat] === null && linesOf(seat).some((l) => INCOMPLETE_CHECK_RE.test(l)));
    // A 1.1.0 re-review packet worded each hypothesis as a fix ("Confirm it is fixed") and never defined CONFIRMED, so there it
    // meant fixed: its outcomes are flipped and REFUTED keeps one meaning in every report, the suspected defect is gone.
    const fixWorded = fixWordedFlips && hypothesis && /\bconfirm it is fixed\b/i.test(text);
    const flip = (o) => (fixWorded ? ({ CONFIRMED: 'REFUTED', REFUTED: 'CONFIRMED' }[o] ?? o) : o);
    const outcomes = hypothesis ? Object.fromEntries(named.map((seat) => [seat, flip(seatVerdict[seat])]).filter(([, o]) => o)) : {};
    const seatMet = hypothesis ? null : worstVerdict(Object.values(seatVerdict).filter(Boolean));
    const met = !hypothesis && found.length > 0 && (seatMet === null || seatMet === 'MET') ? 'PARTIAL' : seatMet;
    const values = Object.values(outcomes);
    // A hypothesis names a suspected defect: a standing finding tagged to it confirms it, unless a seat found it only partly
    // there (the finding may prove just the part still broken).
    const verdict = !hypothesis || status === 'not-verified' ? null
      : found.length > 0 ? (values.some((o) => o === 'PARTLY' || o === 'MIXED') ? 'partly' : 'confirmed')
      : values.some((o) => o === 'REFUTED') ? (values.every((o) => o === 'REFUTED') ? 'refuted' : 'split')
        : values.some((o) => o === 'PARTLY' || o === 'MIXED') ? 'partly'
          : values.length > 0 && values.length === seats.length ? 'confirmed' : 'unparsed';
    const reasonLine = hypothesis || found.length > 0 ? null : named.flatMap((seat) => linesOf(seat)).find((l) => ['NOT MET', 'PARTIAL'].includes(parseVerdict(l, tag)));
    const reason = reasonLine ? reasonOf(reasonLine, tag) : '';
    return { fixWorded, refuted, doubt, failedSeats, outcomes, verdict, met, reason, tag, text, kind: hypothesis ? 'hypothesis' : 'criterion', group: groupsOf(tag, hypothesis, ticketMap)[0], groups: groupsOf(tag, hypothesis, ticketMap), status, findings: found, seats };
  });
  const stats = (list) => ({ total: list.length, issue: list.filter((r) => r.status === 'issue').length, clean: list.filter((r) => r.status === 'clean').length, unmet: list.filter(isUnmet).length, doubtful: list.filter((r) => r.status === 'clean' && r.doubt.length > 0).length, failedClean: list.filter((r) => r.failedSeats.length > 0).length, notVerified: list.filter((r) => r.status === 'not-verified').length });
  const critRows = rows.filter((r) => r.kind === 'criterion');
  const crit = { ...stats(critRows), ...Object.fromEntries([['met', 'MET'], ['partial', 'PARTIAL'], ['notMet', 'NOT MET']].map(([k, v]) => [k, critRows.filter((r) => r.met === v).length])) };
  // Checked, no verdict word and no failing check: the chat "no issue found" count (a failing check has its own line).
  crit.noVerdict = critRows.filter((r) => r.status === 'clean' && r.met === null && r.failedSeats.length === 0).length;
  const hypRows = rows.filter((r) => r.kind === 'hypothesis');
  const hyp = { ...stats(hypRows), ...Object.fromEntries(['refuted', 'split', 'partly', 'confirmed', 'unparsed'].map((v) => [v, hypRows.filter((r) => r.verdict === v).length])) };
  const all = stats(rows);
  const silentSeats = Object.entries(checksBySeat).filter(([seat, body]) => body.trim() !== '' && known.every((tag) => linesBySeat[seat][tag].length === 0)).map(([seat]) => seat);
  const tickets = buildTickets(rows, checksBySeat);
  return { tickets, silentSeats, total: all.total, criteriaCount: crit.total, hypothesisCount: hyp.total, issue: all.issue, clean: all.clean, notVerified: all.notVerified, criteriaStats: crit, hypothesisStats: hyp, rows };
}

// "- F4: fixed after the snapshot, not re-reviewed" lines (or "| F4 | ... |" table rows) of the notes file's "Finding status" section.
export function findingStatus(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*[-*|]?\s*\**(F\d+(?:\s*,\s*F\d+)*)\**\s*[:|\-–—]\s*(.+?)[\s|]*$/.exec(line);
    // A table row's status is its second cell only.
    if (m) for (const id of m[1].split(',')) out.set(id.trim(), line.trim().startsWith('|') ? m[2].split('|')[0].trim() : m[2]);
  }
  return out;
}

export function notesSections(text) {
  const sections = {};
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      name = h[1].toLowerCase();
      sections[name] ??= [];
    } else if (name) sections[name].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join('\n').trim()]));
}

// "A1: text" lines from translate joined into one; with skipNone, "A1: none found ..." entries are left out.
function seatLines(list, skipNone = false) {
  if (!Array.isArray(list)) return '';
  return list.map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '' && !(skipNone && /^(?:[AB]\d+:\s*)?none\b/i.test(s))).join(' | ');
}

// file:line in an evidence entry: an extension that starts with a letter (so not an IP, port or version), not inside a URL.
const LOCATION_RE = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}:\d+/g;
export function evidenceLocations(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const text = String(e);
    for (const m of text.matchAll(LOCATION_RE)) {
      // The word the match ends: a URL ("http://host:8080/x.js:5") is never a file:line.
      const word = text.slice(0, m.index).split(/\s/).pop();
      if (!word.includes('://') && !word.endsWith('//')) out.push(m[0]);
    }
  }
  return out;
}

// A path from a diff header: git quotes names with unusual characters as "a/dir/caf\303\251.md"; plain diff -u adds a tab
// and a time stamp.
export function diffPath(raw) {
  let text = raw.trim().replace(/\t.*$/, '');
  if (text.startsWith('"') && text.endsWith('"')) {
    const bytes = [];
    const body = text.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      const octal = /^\\([0-7]{3})/.exec(body.slice(i));
      if (octal) {
        bytes.push(parseInt(octal[1], 8));
        i += 3;
      } else if (body[i] === '\\' && 'tnr"\\'.includes(body[i + 1])) {
        bytes.push({ t: 9, n: 10, r: 13, '"': 34, '\\': 92 }[body[i + 1]]);
        i += 1;
      } else bytes.push(...Buffer.from(body[i], 'utf8'));
    }
    text = Buffer.from(bytes).toString('utf8');
  }
  return text.replace(/^[ab]\//, '');
}

// Per file of a unified diff: the new-side lines it added and the new-side span of each hunk. Hunk headers say how many lines
// a hunk holds, so an added line that starts with "++" is never a file header. A deleted file is kept under its old name.
export function diffHunks(text) {
  const files = new Map();
  let cur = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let oldPath = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) { cur?.added.add(line); line += 1; newLeft -= 1; continue; }
      if (raw.startsWith('-')) { oldLeft -= 1; continue; }
      if (raw.startsWith(' ') || raw === '') { line += 1; oldLeft -= 1; newLeft -= 1; continue; }
      if (raw.startsWith('\\')) continue;
    }
    if (raw.startsWith('--- ')) { oldPath = diffPath(raw.slice(4)); continue; }
    if (raw.startsWith('+++ ')) {
      const p = diffPath(raw.slice(4));
      const name = (p === '/dev/null' ? oldPath : p)?.replace(/\\/g, '/');
      cur = name && name !== '/dev/null' ? files.get(name) ?? { added: new Set(), spans: [] } : null;
      if (cur) files.set(name, cur);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk && cur) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
      if (newLeft > 0) cur.spans.push([line, line + newLeft - 1]);
    }
  }
  return files;
}

const NEAR_LINES = 20;
const WHERE_RANK = ['added lines', 'near the change', 'changed file', 'unknown', 'outside the change'];
const tagIn = (entry, n) => (entry.added.has(n) ? 'added lines'
  : entry.spans.some(([a, b]) => n >= a - NEAR_LINES && n <= b + NEAR_LINES) ? 'near the change' : 'changed file');
// Where a finding's evidence locations sit in the change: the best over all its file:line locations and all diffs (one Map
// per diff), "unknown" without a location. A path matches at a "/" boundary. A file name alone (bare, or under a snapshot
// folder such as REVIEW/head/) is a guess marked byName: the tag its diff files agree on, else "unknown".
export function whereInChange(evidence, hunkMaps) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const maps = hunkMaps instanceof Map ? [hunkMaps] : hunkMaps;
  let best = null;
  for (const loc of evidenceLocations(evidence)) {
    const m = /^(.*):(\d+)$/.exec(loc.replace(/\\/g, '/'));
    const [file, n] = [fold(m[1].replace(/^\.\//, '')), Number(m[2])];
    const base = file.split('/').pop();
    for (const hunks of maps) {
      const paths = [...hunks.keys()];
      const byPath = paths.filter((p) => { const fp = fold(p); return fp === file || (file.includes('/') && ((fp.includes('/') && file.endsWith(`/${fp}`)) || fp.endsWith(`/${file}`))); });
      const sameName = byPath.length > 0 ? [] : paths.filter((p) => fold(p).split('/').pop() === base);
      // A root diff file alone never claims a cited file in a folder.
      const named = file.includes('/') && sameName.every((p) => !p.includes('/')) ? [] : sameName;
      // The cited path itself, or the longest diff path it ends with, is a real match; a partial path (src/x.py) that two
      // diff files end with (a/src/x.py, b/src/x.py) is a guess like a shared file name.
      const whole = byPath.filter((p) => { const fp = fold(p); return fp === file || file.endsWith(`/${fp}`); });
      const guesses = whole.length > 0 ? [] : byPath.length > 1 ? byPath : named;
      let found;
      if (whole.length > 0 || byPath.length === 1) found = { tag: tagIn(hunks.get((whole.length > 0 ? whole : byPath).reduce((a, b) => (b.length > a.length ? b : a))), n), at: loc };
      else if (guesses.length === 0) found = { tag: 'outside the change', at: loc };
      else {
        const tags = guesses.map((p) => tagIn(hunks.get(p), n));
        found = new Set(tags).size === 1
          ? { tag: tags[0], at: `${loc}, matched by file name to ${guesses.join(', ')}`, byName: true }
          : { tag: 'unknown', at: `${loc}, file name shared by ${guesses.length} changed files`, byName: true, addedInOne: tags.includes('added lines') };
      }
      // A path match outranks a file-name guess of the same tag.
      if (best === null || WHERE_RANK.indexOf(found.tag) < WHERE_RANK.indexOf(best.tag) || (found.tag === best.tag && best.byName && !found.byName)) best = found;
    }
  }
  return best ?? { tag: 'unknown', at: null };
}

// Wall time from the first brief to findings.json, next to the orchestrator's own working time from its transcript.
function runTime(timing, m) {
  const span = timing?.start && timing?.end ? Date.parse(timing.end) - Date.parse(timing.start) : NaN;
  const orchestrator = Number(m.seat_usage?.orchestrator?.duration_ms);
  return { wallMs: Number.isFinite(span) && span >= 0 ? span : null, orchestratorMs: Number.isFinite(orchestrator) && orchestrator > 0 ? orchestrator : null };
}

const minutes = (ms) => (ms === null ? 'unknown' : ms < 60000 ? 'under 1 min' : `${Math.round(ms / 60000)} min`);
export const timeText = (t) => `${minutes(t.wallMs)} wall (first brief to findings.json; packet writing not counted); orchestrator working time ${minutes(t.orchestratorMs)}`;

export function buildReport({ findingsDoc, manifest, packetText = '', seatTexts = {}, notesText = '', files = {}, timing = null, changeDiffs = [], briefText = null, staleManifest = false }) {
  if (!findingsDoc || !Array.isArray(findingsDoc.findings)) throw new ReportError('findings.json has no "findings" array');
  const hunks = changeDiffs.map((d) => diffHunks(d.text));
  const findings = findingsDoc.findings.map((f) => ({
    where: changeDiffs.length > 0 ? whereInChange(f.evidence, hunks) : null,
    id: f.id,
    severity: finalSeverity(f) || 'UNKNOWN',
    claimedSeverity: f.severity_audited && f.severity && f.severity_audited !== f.severity ? f.severity : null,
    fix: String(f.recommended_fix ?? f.suggested_fix ?? '').replace(/\s+/g, ' ').trim(),
    severityReason: String(f.auditor_check?.severity_reason ?? '').replace(/\s+/g, ' ').trim(),
    trigger: seatLines(f.trigger),
    sameShape: seatLines(f.same_shape, true),
    // The seats' own "Pre-existing:" words ("A1: yes"); any "no" outweighs a "yes".
    seatPreExisting: Array.isArray(f.pre_existing) && f.pre_existing.some((l) => /:\s*yes$/i.test(String(l))) && !f.pre_existing.some((l) => /:\s*no$/i.test(String(l))),
    state: f.final_state ?? 'unknown',
    title: shortTitle(f),
    origins: f.origins ?? [],
    basis: f.basis ?? '',
    evidenceStrength: f.evidence_strength ?? '',
    auditorCheck: f.auditor_check?.result ?? 'NOT_CHECKED',
    blocker: isBlocker(f),
  }));
  findings.sort((a, b) => (SEV_ORDER.indexOf(a.severity) + 1 || 9) - (SEV_ORDER.indexOf(b.severity) + 1 || 9) || idNumber(a.id) - idNumber(b.id));
  const states = {};
  for (const f of findings) states[f.state] = (states[f.state] ?? 0) + 1;

  const notes = notesSections(notesText);
  const statusById = findingStatus(notes['finding status'] ?? '');
  for (const f of findings) f.status = statusById.get(f.id) ?? null;
  // A finding the author marked wrong (with a reason, when it is a blocker) is withdrawn: it leaves the blockers, the severity
  // counts and the criteria, where it reads like a refuted claim.
  const markedWrong = findings.filter(authorWithdrawn);
  for (const f of markedWrong) Object.assign(f, { authorWithdrawn: true, blocker: false });
  const withdrawnIds = new Set(markedWrong.map((f) => f.id));
  const criteriaInput = findingsDoc.findings.map((f) => (withdrawnIds.has(f.id) ? { ...f, final_state: 'settled-refuted' } : f));
  const headingTags = new Map();
  for (const text of Object.values(seatTexts)) for (const [id, tags] of claimHeadingTags(text, [...packetCriteria(packetText).keys()])) headingTags.set(id, tags);
  const checksBySeat = Object.fromEntries(Object.entries(seatTexts).map(([seat, text]) => [seat, checksPerformed(text, seat)]));
  // Seats whose brief or packet defines CONFIRMED (the defect exists) answered for the defect, whatever a line's wording; the
  // run's seat brief decides when it is there, since a hand-written packet need not repeat the definition.
  const defines = (text) => /CONFIRMED\s+\(the\s+(?:previous\s+)?defect\s+(?:is\s+still\s+there|it\s+names\s+exists)\)/.test(text);
  const fixWordedFlips = briefText != null ? !defines(briefText) : !defines(packetText);
  const criteria = buildCriteria(packetCriteria(packetText), criteriaInput, headingTags, checksBySeat, packetTicketMap(packetText), { fixWordedFlips });
  if (criteria) {
    const byId = new Map(findings.map((f) => [f.id, f]));
    for (const r of criteria.rows) r.findings = r.findings.filter((id) => byId.has(id));
    // A finding whose claim heading carries a tag of the ticket (BUG-6030, PROD-6030, or a tag of its Tickets range) belongs on the ticket line, listed in the packet or not.
    const ticketMap = packetTicketMap(packetText);
    for (const t of criteria.tickets) {
      const ids = new Set((t.findings ?? []).filter((id) => byId.has(id)));
      for (const f of findingsDoc.findings) {
        if (!byId.has(f.id) || withdrawnIds.has(f.id) || f.final_state === 'settled-refuted' || f.final_state === 'dropped-speculative') continue;
        const tags = (f.origins ?? []).flatMap((origin) => headingTags.get(origin) ?? []);
        if (tags.some((tag) => groupsOf(tag, false, ticketMap).includes(t.id))) ids.add(f.id);
      }
      t.findings = [...ids].sort((a, b) => idNumber(a) - idNumber(b));
    }
  }

  const m = manifest ?? {};
  // An audited run whose manifest is not built yet, or was built before today's findings, is not final, not incomplete: the manifest step decides.
  const notFinal = (manifest == null || staleManifest) && findingsDoc.synthesized !== true;
  const status = notFinal ? 'NOT FINAL' : m.status === 'completed' && findingsDoc.synthesized !== true ? 'COMPLETE' : 'INCOMPLETE';
  const zeroClaims = findingsDoc.zero_claims === true;
  const depth = zeroClaims ? 'not run (no claims)' : (findingsDoc.audit_depth ?? m.exchange?.audit_depth ?? null);
  const verifiers = m.falsification?.verifiers_run;
  // Observed counts only, from each finding's origins; nothing is estimated from them.
  const overlap = { aOnly: 0, bOnly: 0, both: 0 };
  for (const f of Array.isArray(findingsDoc.findings) ? findingsDoc.findings : []) {
    const seats = new Set((Array.isArray(f.origins) ? f.origins : []).map((id) => String(id)[0]).filter((s) => s === 'A' || s === 'B'));
    if (seats.size === 2) overlap.both++;
    else if (seats.has('A')) overlap.aOnly++;
    else if (seats.has('B')) overlap.bOnly++;
  }
  const coverage = {
    overlap: overlap.aOnly + overlap.bOnly + overlap.both > 0 ? overlap : null,
    auditDepth: depth,
    lightNote: !zeroClaims && depth === 'light' ? 'agreed claims were not re-checked by the auditor' : null,
    reviewerPasses: Array.isArray(m.reviewers) ? m.reviewers.length : null,
    blindExchange: m.exchange?.blinded ?? null,
    freshAuditor: m.exchange?.auditor ? String(m.exchange.auditor) : null,
    falsificationRequested: m.falsification?.requested ?? null,
    verifiersRun: verifiers ?? null,
  };

  const caveats = [];
  if (findingsDoc.phase1_only === true) caveats.push("phase3/findings.json is missing, so the run stopped before the audit: these are each seat's own Phase 1 claims under the seat's claim IDs, neither cross-examined nor checked by the auditor, and one defect may appear once per seat. Read this report as incomplete.");
  if (zeroClaims && findingsDoc.synthesized === true) caveats.push("Neither seat raised a claim, so no auditor ran; but phase3/findings.json is missing, so the zero-claim step that checks the target against the Phase 1 snapshot did not run (run review-run audit --prepare): read this report as incomplete. The criteria below come from the seats' own checks.");
  else if (zeroClaims) caveats.push("Neither seat raised a claim, so no auditor ran and there is no scorecard (the target was still checked against the Phase 1 snapshot); the criteria below come from the seats' own checks.");
  if (notFinal && !staleManifest) caveats.push('manifest.json is not built yet, so this report is not final (status, pass counts and cost are unknown): run review-run manifest, then the report again.');
  if (status === 'INCOMPLETE') caveats.push(`The review is incomplete (manifest status "${m.status ?? 'missing'}"). Do not read it as a completed review.`);
  if (m.seat_blind_lines && typeof m.seat_blind_lines === 'object') {
    for (const [seat, lines] of Object.entries(m.seat_blind_lines)) {
      if (Array.isArray(lines) && lines.length > 0) caveats.push(`Seat ${seat} may have reviewed blind: it reported a blocked read or command ("${String(lines[0]).slice(0, 140)}"). A short or clean result from it is weaker than it looks.`);
    }
  }
  for (const seat of Array.isArray(m.blocked_no_findings) ? m.blocked_no_findings : []) {
    caveats.push(`Seat ${seat} wrote "No findings" but says it was blocked, so its pass is not a clean result and this is not a two-seat review.`);
  }
  for (const [seat, reasons] of Object.entries(m.format_refused && typeof m.format_refused === 'object' ? m.format_refused : {})) {
    caveats.push(`Seat ${seat}'s findings file was refused by the format check again after its one rewrite (${String(Array.isArray(reasons) ? reasons[0] : reasons).slice(0, 140)}), so this is not a two-seat review.`);
  }
  for (const [seat, reason] of Object.entries(m.seat_format_notes && typeof m.seat_format_notes === 'object' ? m.seat_format_notes : {})) {
    caveats.push(`Seat ${seat}'s findings file does not follow the current seat file format (${String(reason).slice(0, 140)}); it was written before that rule, so its Blocked: line may not have been read.`);
  }
  if (Array.isArray(m.stop_incomplete) && m.stop_incomplete.length > 0) caveats.push(`Stopped after its answer, but its output stayed open: ${m.stop_incomplete.join(', ')}. A process it started may still be running; check the process list.`);
  if (Array.isArray(m.drift_accepted) && m.drift_accepted.length > 0) {
    const files = [...new Set(m.drift_accepted.flatMap((d) => (Array.isArray(d?.files) ? d.files : [])))];
    const named = files.length > 0 ? files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '') : 'files not listed';
    // phase1 and phase2 can accept drift too: then a seat may have read the changed files, not only the auditor.
    const seatsSaw = m.drift_accepted.some((d) => d?.step === 'phase1' || d?.step === 'phase2');
    caveats.push(seatsSaw
      ? `The target changed while the seats were reviewing it and the review went on with --accept-drift (${named}); a seat or the auditor may have read the changed version of those files.`
      : `The target changed after Phase 1 and the audit went on with --accept-drift (${named}); the auditor reads the current target, so its checks of those files may describe the changed version.`);
  }
  const rulesCopy = m.review_rules?.mode === 'worktree' ? 'working-tree' : m.review_rules?.base_unknown ? 'branch-tip (HEAD)' : 'merge-base';
  if (m.review_rules?.changed_by_target === true) caveats.push(`The review rules (REVIEW.md) differ from the committed copy (the working tree or the branch changed them, possibly another session); the seats used the ${rulesCopy} copy.`);
  else if (m.review_rules?.base_unknown === true) caveats.push('The review rules (REVIEW.md) were read at the branch tip: with no default branch to compare with, a branch edit to them could not be detected.');
  if (m.source_write && (Array.isArray(m.source_write) ? m.source_write.length > 0 : Object.keys(m.source_write).length > 0)) caveats.push('A write to the reviewed source was recorded; see manifest source_write.');
  for (const row of Array.isArray(m.support) ? m.support : []) {
    if (row.status && row.status !== 'supported') caveats.push(`Seat ${row.role} runs on a ${row.status} route (${row.runtime}, ${row.transport}).`);
  }
  const unrecorded = (Array.isArray(m.support) ? m.support : []).filter((row) => row.transport === 'native' && row.role
    && !(m.seat_usage && row.role in m.seat_usage) && !(m.reviewers ?? []).some((r) => r.role === row.role && r.usage));
  for (const row of unrecorded) {
    caveats.push(`Seat ${row.role} ran as a native agent with no transcript, so its model and token use are not recorded: rerun review-run manifest with --seat-transcript ${row.role}=<its transcript or rollout>.`);
  }
  if ((m.reviewers ?? []).some((r) => r.provider === 'anthropic' && r.transport === 'cli')) {
    caveats.push('Claude CLI seats: file tools are enforced (fileTools: enforced) and the shell is prompt-only (shell: prompt-only), so a shell can still read peer files and write by absolute path; touchedFiles in each result.json is the check.');
  }

  const failing = (criteria?.rows ?? []).filter((x) => x.failedSeats.length > 0);
  if (failing.length > 0) {
    const one = failing.length === 1;
    caveats.push(`${one ? 'Criterion' : 'Criteria'} ${failing.map((r) => `${r.tag} (seat ${r.failedSeats.join(', ')})`).join(', ')}: the seat wrote NOT MET or reported a failing check, but no finding is tagged to ${one ? 'it, so it is not a clean result' : 'them, so they are not clean results'}. Put the criterion tag in the claim heading.`);
  }
  for (const t of criteria?.tickets ?? []) {
    if (new Set(Object.values(t.seats)).size <= 1) continue;
    const split = `Ticket ${t.id}: the seats disagree (${Object.entries(t.seats).map(([seat, v]) => `${seat} ${v}`).join(', ')})`;
    // A NO GO that rests on a finding the auditor confirmed is settled by that finding, not by either seat's word.
    const confirmed = (t.findings ?? []).filter((id) => findings.some((f) => f.id === id && f.auditorCheck === 'CONFIRMED' && !WITHDRAWN_STATES.includes(f.state)));
    caveats.push(t.verdict === 'NO GO' && confirmed.length > 0
      ? `${split}; the auditor confirmed ${confirmed.join(' ')}, so the ticket stays NO GO until ${confirmed.length === 1 ? 'it is' : 'they are'} fixed.`
      : `${split}; the exchange did not reconcile it, so read both seat files before you act.`);
  }
  const splitHyp = (criteria?.rows ?? []).filter((r) => r.kind === 'hypothesis' && r.verdict === 'split').map((r) => r.tag);
  if (splitHyp.length > 0) caveats.push(`${splitHyp.join(', ')}: the seats disagree; the auditor rules on findings, not hypotheses, so no one decided between them: read both seats' lines for ${splitHyp.length === 1 ? 'it' : 'them'}.`);
  const fixWorded = (criteria?.rows ?? []).filter((r) => r.fixWorded && r.status !== 'not-verified').map((r) => r.tag);
  if (fixWorded.length > 0) caveats.push(`${fixWorded.join(', ')} ${fixWorded.length > 1 ? 'were' : 'was'} worded "Confirm it is fixed" in a run whose seats were not told what CONFIRMED means (a 1.1.0 run), so a seat's CONFIRMED there meant fixed: the report shows ${fixWorded.length > 1 ? 'their' : 'its'} outcomes flipped, and REFUTED means the defect is gone.`);
  if (criteria?.silentSeats.length > 0) caveats.push(`${criteria.silentSeats.map((x) => `Seat ${x}`).join(', ')} wrote checks but named no criterion or hypothesis tag, so the criteria and hypotheses counts reflect only the seat(s) that did.`);
  // A CLI seat whose usage sits in seat_usage keeps its count on its reviewers[] or actors[] entry.
  const entryCommands = (role) => [...(m.reviewers ?? []), ...(m.actors ?? [])].find((x) => x?.role === role)?.commands;
  const cost = Object.entries(m.seat_usage ?? {}).map(([name, u]) => withCommands(seatCostRow(name === 'auditor' || name === 'orchestrator' ? name : `seat ${name}`, u), u?.commands ?? entryCommands(name)));
  for (const a of m.actors ?? []) {
    if (a?.usage && a.role && !(m.seat_usage && a.role in m.seat_usage)) cost.push(withCommands(seatCostRow(a.role, a.usage, { anthropic: separateCache(a.usage, a.provider, a.model_resolved ?? a.model_requested) }), a.commands));
  }
  for (const r of m.reviewers ?? []) {
    if (r.usage && !(m.seat_usage && r.role in m.seat_usage)) {
      const separate = separateCache(r.usage, r.provider, r.model_resolved ?? r.model_requested);
      const row = withCommands(seatCostRow(`seat ${r.role}`, r.usage, { anthropic: separate }), r.commands);
      if (Array.isArray(r.usage_per_call) && r.usage_per_call.length > 1) row.perCall = perCallNewInput(r.usage_per_call, separate);
      cost.push(row);
    }
  }
  const costRank = (seat) => (seat.startsWith('seat ') ? 0 : seat === 'auditor' ? 1 : seat === 'orchestrator' ? 3 : 2);
  cost.sort((a, b) => costRank(a.seat) - costRank(b.seat) || a.seat.localeCompare(b.seat));
  // "F3: wontfix: ..." looks like an outcome word but is not one; say so instead of reading it as free text silently.
  for (const [id, status] of statusById) {
    // A line that starts with a link ("https://dev.azure.com/...") is not a mistyped outcome word.
    const word = /^\s*([a-z]+(?:-[a-z]+)*)\s*:(?!\/\/)/i.exec(status)?.[1];
    if (word && !outcomeOf(status)) caveats.push(`${id}'s line in the report notes starts with "${word}:", which is not an outcome word (${OUTCOMES.join(', ')}); it is read as free text.`);
  }
  // A finding the author marked wrong (with a reason, when it is a blocker) is withdrawn: it leaves the blockers and the severity counts.
  if (markedWrong.length > 0) caveats.push(`${markedWrong.map((f) => f.id).join(', ')} ${markedWrong.length === 1 ? 'is' : 'are'} marked wrong in the report notes, so ${markedWrong.length === 1 ? 'it is' : 'they are'} counted as withdrawn, not under ${markedWrong.length === 1 ? 'its' : 'their'} severity or as a blocker; the auditor's result is unchanged.`);
  // A refuted or dropped finding is not counted under its severity; it is counted as withdrawn.
  const standing = findings.filter((f) => f.state !== 'settled-refuted' && f.state !== 'dropped-speculative' && !f.authorWithdrawn);
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [SEV_KEY[s], standing.filter((f) => f.severity === s).length]));
  counts.other = standing.filter((f) => !SEV_ORDER.includes(f.severity)).length;
  counts.withdrawn = findings.length - standing.length;
  const preMarked = changeDiffs.length > 0 ? [] : findings.filter((f) => noteKinds(f.status).pre);
  const preOnAdded = changeDiffs.length > 0 ? findings.filter((f) => noteKinds(f.status).pre && f.where?.tag === 'added lines' && !f.where.byName) : [];
  // A file-name guess never moves a finding, but a pre-existing note against one that points at added lines is worth a look.
  const preOnGuess = changeDiffs.length > 0 ? findings.filter((f) => noteKinds(f.status).pre && f.where?.byName && (f.where.tag === 'added lines' || f.where.addedInOne)) : [];
  for (const f of preOnGuess) caveats.push(`${f.id} is marked pre-existing in the report notes; its evidence matches lines the change added only by file name (${f.where.at}), so check it is not the same file.`);
  if (preOnAdded.length > 0) caveats.push(`${preOnAdded.map((f) => f.id).join(', ')} ${preOnAdded.length === 1 ? 'is' : 'are'} marked pre-existing in the report notes, but ${preOnAdded.length === 1 ? 'its' : 'their'} evidence is on lines the change added, so ${preOnAdded.length === 1 ? 'it stays' : 'they stay'} where ${preOnAdded.length === 1 ? 'its' : 'their'} severity puts ${preOnAdded.length === 1 ? 'it' : 'them'}.`);
  if (preMarked.length > 0) caveats.push(`${preMarked.map((f) => f.id).join(', ')} ${preMarked.length === 1 ? 'is' : 'are'} marked pre-existing in the report notes, but this report has no change diff (since.diff in the run folder, or --change-diff), so nothing tells what the change was; ${preMarked.length === 1 ? 'it stays' : 'they stay'} where ${preMarked.length === 1 ? 'its' : 'their'} severity puts ${preMarked.length === 1 ? 'it' : 'them'}.`);
  for (const f of findings.filter((x) => x.blocker && outcomeOf(x.status)?.word === 'wrong' && outcomeOf(x.status).reason === '')) {
    caveats.push(`${f.id} is marked wrong in the report notes with no reason, so it stays a blocker; write the reason after "wrong:" to withdraw it.`);
  }
  const isFixed = (text) => noteKinds(text).fixed;
  if ([...statusById.values()].some(isFixed)) caveats.push(`Changes made after the reviewed snapshot were not re-reviewed (${[...statusById.entries()].filter(([, s]) => isFixed(s)).map(([id]) => id).join(', ')}); the findings describe the code the reviewers read.`);
  const blockers = findings.filter((f) => f.blocker);
  // build-recheck-packet writes "Review round: N" under the packet title.
  const round = Number(/^Review round:\s*(\d+)\s*$/m.exec(packetText)?.[1]) || null;
  if (round >= 3) caveats.push(stepBackNote(round));

  return {
    generator: generatorInfo(m.skill_version),
    round,
    status,
    manifestStatus: m.status ?? null,
    mode: m.mode ?? null,
    topology: m.topology ?? null,
    runId: m.run_id ?? null,
    total: findings.length,
    counts,
    states,
    blockers: blockers.map((f) => f.id),
    findings,
    criteria,
    coverage,
    caveats,
    cost,
    time: runTime(timing, m),
    changeDiffs: changeDiffs.map((d) => ({ name: d.name, sha256: createHash('sha256').update(d.text).digest('hex') })),
    why: notes.why || null,
    decisions: notes['decisions needed'] || null,
    openItems: notes['open items'] || null,
    criteriaSource: notes['criteria source'] || null,
    files,
  };
}

// ---- renderers ----

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', green: '\x1b[32m', magenta: '\x1b[35m' };
const SEV_COLOR = { CRITICAL: 'red', HIGH: 'red', MEDIUM: 'yellow', LOW: 'blue' };

function painter(enabled) {
  return (style, text) => (enabled ? `${style.map((s) => ANSI[s]).join('')}${text}${ANSI.reset}` : text);
}

const clip = (text, n) => (String(text ?? '').length > n ? `${String(text).slice(0, n - 3).trimEnd()}...` : String(text ?? ''));
const groupTitle = (g) => (g === 'hypotheses' ? 'Hypotheses' : g === 'other' ? 'Criteria' : `Ticket ${g}`);

// A hypothesis a seat named under Checks performed may have been confirmed or disproved; the script does not read which.
const outcomeWord = { REFUTED: 'refuted', PARTLY: 'partly confirmed', MIXED: 'mixed', CONFIRMED: 'confirmed' };
// A seat that wrote NOT MET or PARTIAL, or reported a failing check, on a criterion with no finding tagged to it is not "no issue found".
export const unmetWord = (r) => (r.met === 'NOT MET' ? 'NOT MET, no finding tagged' : r.met === 'PARTIAL' ? 'PARTIAL, no finding tagged' : r.failedSeats?.length > 0 ? 'failing check reported, no finding tagged' : null);

// "1 issue found, 2 not met or partial (no finding), 3 no issue found, 0 not verified": the same split in every format; the middle part only when nonzero.
export function criteriaSplit(rows) {
  const unmet = rows.filter(isUnmet).length;
  return { issue: rows.filter((r) => r.status === 'issue').length, unmet, clean: rows.filter((r) => r.status === 'clean').length - unmet, notVerified: rows.filter((r) => r.status === 'not-verified').length };
}
const splitText = (s, sep, nv = 'not verified') => [`${s.issue} issue found`, ...(s.unmet > 0 ? [`${s.unmet} not met or partial (no finding)`] : []), `${s.clean} no issue found`, `${s.notVerified} ${nv}`].join(sep);
const cleanLabel = (r) => {
  if (r.kind !== 'hypothesis') return `${unmetWord(r) ?? 'no issue found'} (${r.seats.join(', ')})${r.doubt?.length ? `; ${r.doubt.join(', ')} said the check was incomplete` : ''}${r.refuted?.length ? `; claim refuted: ${r.refuted.join(', ')}` : ''}`;
  const parts = r.seats.map((seat) => (r.outcomes?.[seat] ? `${seat} ${outcomeWord[r.outcomes[seat]]}` : `${seat} outcome not parsed`));
  return `${r.verdict === 'split' ? 'SPLIT: ' : ''}${parts.join(', ')}`;
};

// "1 REFUTED | 4 confirmed | 1 outcome not parsed" for the hypotheses, nonzero parts only.
export function hypothesisParts(st) {
  return [[st.refuted, 'REFUTED'], [st.split, 'seats disagree'], [st.partly, 'partly confirmed'], [st.confirmed, 'confirmed'], [st.unparsed, 'outcome not parsed'], [st.notVerified, 'NOT VERIFIED']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
}

// A tag shared by several tickets carries its findings to each of them; say so beside the findings.
const sharedNote = (r) => (r.status === 'issue' && (r.groups?.length ?? 1) > 1 ? `shared by ${r.groups.join(', ')}; the findings apply to the tag, not to each ticket` : '');

export function criteriaGroups(c) {
  const groups = new Map();
  for (const r of c.rows) {
    for (const g of r.groups ?? [r.group]) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
  }
  const rank = (g) => (/^\d+$/.test(g) ? 0 : g === 'other' ? 1 : 2);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || (rank(a) === 0 ? Number(a) - Number(b) : 0));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function renderText(report, { color = false } = {}) {
  const paint = painter(color);
  const out = [];
  const statusStyle = report.status === 'COMPLETE' ? ['green', 'bold'] : ['red', 'bold'];
  const sevSummary = SEV_ORDER.map((s) => {
    const n = report.counts[SEV_KEY[s]];
    return n > 0 ? paint([SEV_COLOR[s], 'bold'], `${n} ${SEV_KEY[s]}`) : paint(['dim'], `${n} ${SEV_KEY[s]}`);
  }).join('  ') + (report.counts.other > 0 ? `  ${paint(['yellow', 'bold'], `${report.counts.other} other`)}` : '') + (report.counts.withdrawn > 0 ? `  ${paint(['dim'], `${report.counts.withdrawn} withdrawn`)}` : '');
  out.push(`${paint(statusStyle, `STATUS ${report.status}`)}   ${paint(report.blockers.length > 0 ? ['red', 'bold'] : ['green'], `Blockers: ${report.blockers.length}`)}   ${plural(report.total, 'finding')}: ${sevSummary}`);
  const meta = [report.topology, report.mode && `${report.mode} mode`, report.round && `round ${report.round}`, report.runId && `run ${String(report.runId).slice(0, 8)}`].filter(Boolean).join(' | ');
  if (meta) out.push(paint(['dim'], meta));
  out.push(`Why: ${report.why ?? paint(['dim'], '(not written; add "## Why" to report-notes.md)')}`);
  out.push('');

  if (report.blockers.length > 0) {
    out.push(paint(['bold'], 'FIX OR DECIDE FIRST'));
    for (const f of report.findings.filter((x) => x.blocker)) {
      out.push(`  ${paint([SEV_COLOR[f.severity] ?? 'dim', 'bold'], f.severity.padEnd(8))} ${String(f.id ?? '?').padEnd(4)} ${f.title}${f.status ? ` ${paint(['yellow'], `[${f.status}]`)}` : ''}`);
      out.push(paint(['dim'], `           ${f.state} | ${f.basis} ${f.evidenceStrength} | auditor ${f.auditorCheck}${f.claimedSeverity ? ` | claimed ${f.claimedSeverity}` : ''}`));
      if (f.where) out.push(`           Where: ${f.where.tag}${f.where.at ? ` (${f.where.at})` : ''}`);
      if (f.trigger) out.push(`           Trigger: ${f.trigger}`);
      if (f.sameShape) out.push(`           Same shape: ${f.sameShape}`);
    }
    out.push('');
  }
  const rest = report.findings.filter((f) => !f.blocker);
  if (rest.length > 0) {
    out.push(paint(['bold'], 'OTHER FINDINGS'));
    for (const f of rest) {
      const note = [f.claimedSeverity && `claimed ${f.claimedSeverity}`, f.state !== 'settled-agree' && f.state].filter(Boolean).join('; ');
      out.push(`  ${paint([SEV_COLOR[f.severity] ?? 'dim'], f.severity.padEnd(8))} ${String(f.id ?? '?').padEnd(4)} ${f.title}${note ? ` ${paint(['dim'], `(${note})`)}` : ''}${f.status ? ` ${paint(['yellow'], `[${f.status}]`)}` : ''}`);
    }
    out.push('');
  }
  if (report.findings.length === 0) out.push('No findings.', '');

  if (report.criteria) {
    const c = report.criteria;
    const split = criteriaSplit(c.rows.filter((r) => r.kind === 'criterion'));
    const stat = (st) => `${paint(['red'], `${st.issue} issue found`)} | ${st.unmet > 0 ? `${paint(['red', 'bold'], `${st.unmet} not met or partial (no finding)`)} | ` : ''}${paint(['green'], `${st.clean} no issue found${c.criteriaStats.doubtful > 0 ? ` (${c.criteriaStats.doubtful} where a seat said the check was incomplete)` : ''}`)} | ${paint(st.notVerified > 0 ? ['magenta', 'bold'] : ['dim'], `${st.notVerified} NOT VERIFIED`)}`;
    if (c.criteriaCount > 0) out.push(paint(['bold'], `CRITERIA (${c.criteriaCount})`) + `  ${stat(split)}`);
    // A confirmed, partly confirmed or split hypothesis is a defect that may exist; all refuted is the good outcome.
    const hypBad = c.hypothesisStats.confirmed + c.hypothesisStats.partly + c.hypothesisStats.split > 0;
    if (c.hypothesisCount > 0) out.push(paint(['bold'], `HYPOTHESES (${c.hypothesisCount})`) + `  ${paint(hypBad ? ['red', 'bold'] : ['green'], hypothesisParts(c.hypothesisStats).join(' | '))}`);
    if (c.silentSeats.length > 0) out.push(paint(['yellow'], `  ${c.silentSeats.map((x) => `Seat ${x}`).join(', ')} wrote checks but named no criterion or hypothesis tag, so ${c.silentSeats.length > 1 ? 'their' : 'its'} checks are not counted below.`));
    if (report.criteriaSource) out.push(paint(['dim'], `  Source: ${report.criteriaSource.replace(/\s+/g, ' ')}`));
    for (const [group, rows] of criteriaGroups(c)) {
      out.push(group === 'hypotheses'
        ? `  ${paint(['bold'], groupTitle(group))}: ${hypothesisParts(c.hypothesisStats).join(', ')}`
        : `  ${paint(['bold'], groupTitle(group))}: ${splitText(criteriaSplit(rows), ', ')}`);
      for (const r of rows) {
        const result = r.status === 'issue' ? paint(['red'], `issue found: ${r.findings.join(', ')}`)
          : r.status === 'clean' ? paint(['confirmed', 'partly', 'split'].includes(r.verdict) || r.met === 'NOT MET' || r.failedSeats?.length > 0 ? ['red', 'bold'] : r.met === 'PARTIAL' ? ['yellow'] : ['green'], cleanLabel(r))
            : paint(['magenta', 'bold'], `NOT VERIFIED (no seat named this tag${c.silentSeats.length > 0 ? `; ${c.silentSeats.map((x) => `seat ${x}`).join(', ')} named no tags` : ''})`);
        out.push(`    ${r.tag.padEnd(12)} ${result}  ${paint(['dim'], clip(r.text, 56))}`);
        if (sharedNote(r)) out.push(paint(['dim'], `                 (${sharedNote(r)})`));
      }
    }
    out.push('');
  }

  const cv = report.coverage;
  out.push(paint(['bold'], 'COVERAGE'));
  const passes = [
    cv.reviewerPasses !== null && `${cv.reviewerPasses} reviewer pass${cv.reviewerPasses === 1 ? '' : 'es'}`,
    cv.blindExchange !== null && `blind rebuttal exchange: ${cv.blindExchange ? 'yes' : 'no'}`,
    cv.freshAuditor && `fresh auditor: ${cv.freshAuditor}`,
    cv.verifiersRun !== null && `falsification verifiers run: ${cv.verifiersRun}${cv.falsificationRequested === false ? ' (not requested)' : ''}`,
  ].filter(Boolean);
  out.push(`  Audit depth: ${cv.auditDepth ?? 'unknown'}${cv.lightNote ? ` (${cv.lightNote})` : ''}`);
  if (cv.overlap) out.push(`  Raised by: ${overlapText(cv.overlap)}`);
  if (passes.length > 0) out.push(`  Passes: ${passes.join('; ')}`);
  if (report.time) out.push(`  Time: ${timeText(report.time)}`);
  if (report.changeDiffs?.length > 0) out.push(`  Where tags from: ${report.changeDiffs.map((d) => `${d.name} sha256 ${d.sha256.slice(0, 12)}`).join(', ')}`);
  out.push('');

  if (report.openItems) out.push(paint(['bold'], 'OPEN ITEMS (not findings)'), ...report.openItems.split('\n').map((l) => `  ${l}`), '');
  if (report.decisions) out.push(paint(['bold'], 'DECISIONS NEEDED'), ...report.decisions.split('\n').map((l) => `  ${l}`), '');
  if (report.caveats.length > 0) out.push(paint(['bold'], 'CAVEATS'), ...report.caveats.map((c) => `  - ${c}`), '');
  if (report.cost.length > 0) {
    out.push(paint(['bold'], 'COST (tokens)'), ...costTableLines(report.cost).map((l) => `  ${l}`));
    if (costNote(report.cost)) out.push(paint(['dim'], `  ${costNote(report.cost)}`));
    out.push(paint(['dim'], `  ${COST_SCOPE}`));
    for (const r of report.cost.filter((x) => x.perCall)) out.push(paint(['dim'], `  ${r.seat} new input per call: ${r.perCall.map(compactTokens).join(', ')}`));
    out.push('');
  }
  const fileList = Object.values(report.files).filter(Boolean);
  if (fileList.length > 0) out.push(paint(['dim'], `FILES  ${fileList.join(' | ')}`));
  out.push(paint(['dim'], generatorLine(report.generator ?? undefined)));
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

const mdEsc = (text) => String(text ?? '').replace(/[\\`*_{}[\]<>|#]/g, '\\$&');
const cell = (text) => mdEsc(text).replace(/\r?\n/g, ' ');

export function renderMarkdown(report) {
  const out = [`# Review report: ${report.status}${report.round ? ` (round ${report.round})` : ''}`, '', `**Status:** ${report.status} | **Blockers:** ${report.blockers.length} | **Findings:** ${report.total} (${[...SEV_ORDER.map((s) => `${report.counts[SEV_KEY[s]]} ${SEV_KEY[s]}`), ...(report.counts.other > 0 ? [`${report.counts.other} other`] : []), ...(report.counts.withdrawn > 0 ? [`${report.counts.withdrawn} withdrawn`] : [])].join(', ')})`, ''];
  if (report.why) out.push(`**Why:** ${report.why}`, '');
  const listing = (title, items) => {
    if (items.length === 0) return;
    out.push(`## ${title}`, '');
    for (const f of items) {
      out.push(`- **${f.severity}** ${f.id}: ${mdEsc(f.title)} (${f.state}; ${f.basis} ${f.evidenceStrength}; auditor ${f.auditorCheck}${f.claimedSeverity ? `; claimed ${f.claimedSeverity}` : ''})${f.status ? ` **[${mdEsc(f.status)}]**` : ''}`);
      if (f.where) out.push(`  Where: ${f.where.tag}${f.where.at ? ` (${mdEsc(f.where.at)})` : ''}`);
      if (f.trigger) out.push(`  Trigger: ${mdEsc(f.trigger)}`);
      if (f.fix) out.push(`  Fix: ${mdEsc(f.fix)}`);
      if (f.sameShape) out.push(`  Same shape: ${mdEsc(f.sameShape)}`);
    }
    out.push('');
  };
  listing('Fix or decide first', report.findings.filter((f) => f.blocker));
  listing('Other findings', report.findings.filter((f) => !f.blocker));
  if (report.criteria) {
    const c = report.criteria;
    out.push(`## Criteria (${c.criteriaCount}${c.hypothesisCount > 0 ? ` + ${c.hypothesisCount} hypotheses` : ''})`, '');
    if (c.silentSeats.length > 0) out.push(`> ${c.silentSeats.map((x) => `Seat ${x}`).join(', ')} wrote checks but named no criterion or hypothesis tag, so ${c.silentSeats.length > 1 ? 'their' : 'its'} checks are not counted below.`, '');
    if (c.criteriaCount > 0) out.push(`- Criteria: ${splitText(criteriaSplit(c.rows.filter((r) => r.kind === 'criterion')), ', ')}`);
    if (c.hypothesisCount > 0) out.push(`- Hypotheses: ${hypothesisParts(c.hypothesisStats).join(', ')}`, '- A hypothesis is a claim to test: REFUTED means the claim as written is false, CONFIRMED that it is true; seats disagree means one refuted it and another confirmed it.');
    if (report.criteriaSource) out.push(`- Source: ${report.criteriaSource.replace(/\s+/g, ' ')}`);
    out.push('');
    out.push('| Group | Criterion | Result | Text |', '|---|---|---|---|');
    for (const [group, rows] of criteriaGroups(c)) {
      for (const r of rows) {
        const result = r.status === 'issue' ? `Issue found: ${r.findings.join(', ')}${sharedNote(r) ? ` (${sharedNote(r)})` : ''}` : r.status === 'clean' ? cleanLabel(r) : `**NOT VERIFIED** (no seat named this tag${c.silentSeats.length > 0 ? `; ${c.silentSeats.map((x) => `seat ${x}`).join(', ')} named no tags` : ''})`;
        out.push(`| ${cell(groupTitle(group))} | ${cell(r.tag)} | ${result} | ${cell(clip(r.text, 70))} |`);
      }
    }
    out.push('');
  }
  const cv = report.coverage;
  out.push('## Coverage', '', `- Audit depth: ${cv.auditDepth ?? 'unknown'}${cv.lightNote ? ` (${cv.lightNote})` : ''}`);
  if (cv.overlap) out.push(`- Raised by: ${overlapText(cv.overlap)}`);
  if (cv.reviewerPasses !== null) out.push(`- Reviewer passes: ${cv.reviewerPasses}; blind exchange: ${cv.blindExchange === null ? 'unknown' : cv.blindExchange ? 'yes' : 'no'}; fresh auditor: ${cv.freshAuditor ?? 'unknown'}; falsification verifiers run: ${cv.verifiersRun ?? 'unknown'}`);
  if (report.time) out.push(`- Time: ${timeText(report.time)}`);
  if (report.changeDiffs?.length > 0) out.push(`- Where tags (a hint from evidence file:line, never a grouping): ${report.changeDiffs.map((d) => `${mdEsc(d.name)} sha256 ${d.sha256.slice(0, 12)}`).join(', ')}`);
  out.push('');
  if (report.openItems) out.push('## Open items (not findings)', '', report.openItems, '');
  if (report.decisions) out.push('## Decisions needed', '', report.decisions, '');
  if (report.caveats.length > 0) out.push('## Caveats', '', ...report.caveats.map((c) => `- ${c}`), '');
  if (report.cost.length > 0) {
    const hasWrite = report.cost.some((r) => r.cacheWrite != null);
    const hasCmds = report.cost.some((r) => r.commands);
    out.push('## Cost (tokens)', '', `| Seat | New input |${hasWrite ? ' Cache write |' : ''} Cache read | Output | Calls |${hasCmds ? ' Commands |' : ''}`, `|---|---:|${hasWrite ? '---:|' : ''}---:|---:|---:|${hasCmds ? '---:|' : ''}`);
    for (const r of report.cost) out.push(`| ${cell(r.seat)} | ${compactTokens(r.newInput)} |${hasWrite ? ` ${r.cacheWrite == null ? '-' : compactTokens(r.cacheWrite)} |` : ''} ${compactTokens(r.cacheRead)} | ${compactTokens(r.output)} | ${r.calls ?? '-'} |${hasCmds ? ` ${commandsCell(r)} |` : ''}`);
    if (costNote(report.cost)) out.push('', costNote(report.cost));
    out.push('', COST_SCOPE);
    for (const r of report.cost.filter((x) => x.perCall)) out.push('', `${r.seat} new input per call: ${r.perCall.map(compactTokens).join(', ')}`);
    out.push('');
  }
  out.push('', `_${mdEsc(generatorLine(report.generator))}_`);
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const HTML_CSS = `:root{--bg:#f5f6f4;--surface:#fff;--fg:#17201d;--muted:#5b6762;--line:#d9dedb;--crit:#a3122a;--crit-bg:#fbe4e8;--high:#b8400a;--high-bg:#fde9dc;--med:#8a6100;--med-bg:#fbf0cc;--low:#2f5d8a;--low-bg:#e3edf7;--ok:#1d7a46;--ok-bg:#dff1e6;--nv:#6b3fa0;--nv-bg:#ece4f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1513;--surface:#171f1c;--fg:#e6ece9;--muted:#9aa8a2;--line:#2b3733;--crit:#ff8a9b;--crit-bg:#3a1520;--high:#ffa66b;--high-bg:#3a2214;--med:#f1c24f;--med-bg:#352a0c;--low:#8fbbea;--low-bg:#14263a;--ok:#6fd09a;--ok-bg:#12301f;--nv:#c3a1ee;--nv-bg:#2a1d3d;color-scheme:dark}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px 48px}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
section{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0}
h1{font-size:20px;margin:0}h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.status{display:inline-block;font-weight:700;letter-spacing:.04em;padding:4px 12px;border-radius:4px}
.status.complete{background:var(--ok-bg);color:var(--ok)}.status.incomplete{background:var(--crit-bg);color:var(--crit)}
.counts{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.count{padding:8px 12px;border-radius:6px;min-width:70px}
.count b{display:block;font:500 22px ui-monospace,Consolas,monospace}.count span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.critical{background:var(--crit-bg);color:var(--crit)}.high{background:var(--high-bg);color:var(--high)}.medium{background:var(--med-bg);color:var(--med)}.low{background:var(--low-bg);color:var(--low)}.zero{border:1px dashed var(--line);color:var(--muted)}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:3px}
.row{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.id{font-family:ui-monospace,Consolas,monospace;color:var(--muted);min-width:2.4em}.meta{color:var(--muted);font-size:13px}
.nv{background:var(--nv-bg);color:var(--nv)}.ok{background:var(--ok-bg);color:var(--ok)}
.bar{display:flex;height:14px;border-radius:3px;overflow:hidden;border:1px solid var(--line);margin:8px 0}.bar i{display:block}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
pre{white-space:pre-wrap;margin:0;font:13px ui-monospace,Consolas,monospace}`;

export function renderHtml(report) {
  const gen = report.generator ?? generatorInfo();
  const chip = (sev) => `<span class="chip ${SEV_KEY[sev] ?? 'zero'}">${esc(sev)}</span>`;
  const row = (f) => `<div class="row">${chip(f.severity)}<span class="id">${esc(f.id)}</span><span>${esc(f.title)}${f.claimedSeverity ? ` <span class="meta">(claimed ${esc(f.claimedSeverity)})</span>` : ''}${f.status ? ` <span class="chip medium">${esc(f.status)}</span>` : ''}<br><span class="meta">${esc(f.state)} | ${esc(f.basis)} ${esc(f.evidenceStrength)} | auditor ${esc(f.auditorCheck)}</span></span></div>`;
  const counts = SEV_ORDER.map((s) => { const n = report.counts[SEV_KEY[s]]; return `<div class="count ${n ? SEV_KEY[s] : 'zero'}"><b>${n}</b><span>${SEV_KEY[s]}</span></div>`; }).join('') + (report.counts.other > 0 ? `<div class="count medium"><b>${report.counts.other}</b><span>other</span></div>` : '') + (report.counts.withdrawn > 0 ? `<div class="count zero"><b>${report.counts.withdrawn}</b><span>withdrawn</span></div>` : '');
  const blockers = report.findings.filter((f) => f.blocker);
  const others = report.findings.filter((f) => !f.blocker);
  const parts = [
    `<section><span class="status ${report.status === 'COMPLETE' ? 'complete' : 'incomplete'}">${esc(report.status)}</span> <span class="meta">Blockers: ${report.blockers.length}</span><h1>${esc(report.why ?? 'Review report')}</h1><div class="counts">${counts}</div></section>`,
  ];
  if (blockers.length) parts.push(`<section><h2>Fix or decide first</h2>${blockers.map(row).join('')}</section>`);
  if (others.length) parts.push(`<section><h2>Other findings</h2>${others.map(row).join('')}</section>`);
  if (report.criteria) {
    const c = report.criteria;
    const cs = criteriaSplit(c.rows.filter((r) => r.kind === 'criterion'));
    const pct = (n) => `${c.criteriaCount > 0 ? ((100 * n) / c.criteriaCount).toFixed(1) : '0.0'}%`;
    parts.push(`<section><h2>Criteria (${c.criteriaCount}${c.hypothesisCount > 0 ? ` + ${c.hypothesisCount} hypotheses` : ''})</h2><div class="bar" role="img" aria-label="Criteria: ${splitText(cs, ', ')}"><i style="width:${pct(cs.issue)};background:var(--high)"></i>${cs.unmet > 0 ? `<i style="width:${pct(cs.unmet)};background:var(--med)"></i>` : ''}<i style="width:${pct(cs.clean)};background:var(--ok)"></i><i style="width:${pct(cs.notVerified)};background:repeating-linear-gradient(45deg,var(--nv) 0 5px,var(--nv-bg) 5px 10px)"></i></div>${c.silentSeats.length > 0 ? `<p class="meta">${esc(c.silentSeats.map((x) => `Seat ${x}`).join(', '))} wrote checks but named no criterion or hypothesis tag; their checks are not counted here.</p>` : ''}<p class="meta">Criteria: ${splitText(cs, ' | ')}${c.hypothesisCount > 0 ? ` &nbsp;|&nbsp; Hypotheses: ${esc(hypothesisParts(c.hypothesisStats).join(' | '))}` : ''}</p><table><thead><tr><th>Group</th><th>Criterion</th><th>Result</th><th>Text</th></tr></thead><tbody>${criteriaGroups(c).flatMap(([group, rows]) => rows.map((r) => [group, r])).map(([group, r]) => `<tr><td>${esc(groupTitle(group))}</td><td>${esc(r.tag)}</td><td>${r.status === 'issue' ? `<span class="chip high">Issue found</span> ${esc(r.findings.join(', '))}${sharedNote(r) ? ` <span class="meta">(${esc(sharedNote(r))})</span>` : ''}` : r.status === 'clean' ? `<span class="chip ${['confirmed', 'partly', 'split'].includes(r.verdict) || r.met === 'NOT MET' || r.failedSeats?.length > 0 ? 'high' : r.met === 'PARTIAL' ? 'medium' : 'ok'}">${r.kind === 'hypothesis' ? ({ refuted: 'Refuted', confirmed: 'Confirmed', partly: 'Partly confirmed', split: 'Seats disagree' }[r.verdict] ?? 'Checked') : (unmetWord(r) ?? 'No issue found')}</span> ${esc(r.kind === 'hypothesis' ? cleanLabel(r) : r.seats.join(', '))}${r.kind !== 'hypothesis' && r.refuted?.length ? ` <span class="meta">(claim refuted: ${esc(r.refuted.join(', '))})</span>` : ''}` : '<span class="chip nv">Not verified</span>'}${r.kind !== 'hypothesis' && r.status === 'clean' && r.doubt.length > 0 ? ` <span class="meta">(${esc(r.doubt.join(', '))} said the check was incomplete)</span>` : ''}</td><td>${esc(clip(r.text, 70))}</td></tr>`).join('')}</tbody></table></section>`);
  }
  const cv = report.coverage;
  parts.push(`<section><h2>Coverage</h2><p>Audit depth: ${esc(cv.auditDepth ?? 'unknown')}${cv.lightNote ? ` (${esc(cv.lightNote)})` : ''}</p>${cv.overlap ? `<p>Raised by: ${esc(overlapText(cv.overlap))}</p>` : ''}</section>`);
  if (report.openItems) parts.push(`<section><h2>Open items (not findings)</h2><pre>${esc(report.openItems)}</pre></section>`);
  if (report.decisions) parts.push(`<section><h2>Decisions needed</h2><pre>${esc(report.decisions)}</pre></section>`);
  if (report.caveats.length) parts.push(`<section><h2>Caveats</h2><ul>${report.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>`);
  if (report.cost.length) {
    const hasWrite = report.cost.some((r) => r.cacheWrite != null);
    const hasCmds = report.cost.some((r) => r.commands);
    const rows = report.cost.map((r) => `<tr><td>${esc(r.seat)}</td><td>${compactTokens(r.newInput)}</td>${hasWrite ? `<td>${r.cacheWrite == null ? '-' : compactTokens(r.cacheWrite)}</td>` : ''}<td>${compactTokens(r.cacheRead)}</td><td>${compactTokens(r.output)}</td><td>${r.calls ?? '-'}</td>${hasCmds ? `<td>${commandsCell(r)}</td>` : ''}</tr>`).join('');
    const note = `${costNote(report.cost) ? `<p class="meta">${esc(costNote(report.cost))}</p>` : ''}<p class="meta">${esc(COST_SCOPE)}</p>`;
    const calls = report.cost.filter((x) => x.perCall).map((r) => `<p class="meta">${esc(r.seat)} new input per call: ${esc(r.perCall.map(compactTokens).join(', '))}</p>`).join('');
    parts.push(`<section><h2>Cost (tokens)</h2><table><thead><tr><th>Seat</th><th>New input</th>${hasWrite ? '<th>Cache write</th>' : ''}<th>Cache read</th><th>Output</th><th>Calls</th>${hasCmds ? '<th>Commands</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>${note}${calls}</section>`);
  }
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review report</title><style>${HTML_CSS}</style></head><body><main>${parts.join('')}<footer class="meta">${esc(generatorLine({ ...gen, url: '' }).replace(/: $/, ':'))} <a href="${esc(gen.url)}">${esc(gen.url)}</a></footer></main></body></html>\n`;
}

// ---- chat format: plain markdown that a chat window draws (quote, table, bars, a red/green diff block) ----

const CHAT_LINE = 100;
const BAR_WIDTH = 24;
const LABEL_WIDTH = 13;
const WITHDRAWN_STATES = ['settled-refuted', 'dropped-speculative'];
// A report-notes status line is free text: drop negated, partial and future phrases first, so "not yet fixed", "won't be fixed",
// "partly fixed" or "will be fixed" is never "fixed". A negation reaches up to two words ahead ("will not be fixed", "no longer pre-existing").
export function noteKinds(note) {
  const raw = String(note ?? '').replace(/[\p{Pi}\p{Pf}]/gu, "'");
  const text = raw
    .replace(/\bfixed\s*\?\s*(?:no|not yet)\b/gi, ' ')
    .replace(/\b(?:partly|partially|half)\s+fixed\b/gi, ' ')
    .replace(/(?:\b(?:not|never|no|cannot)|n't)(?:\s+[a-z]+){0,2}?\s+(?:fixed|decision(?:\s+needed)?|decide|pre-?existing)\b/gi, ' ')
    .replace(/\b(?:will|would|should|must|to)\s+(?:be\s+)?fix(?:ed)?\b/gi, ' ')
    .replace(/\bun-?fixed\b/gi, ' ');
  return {
    fixed: /\bfixed\b/i.test(text),
    decide: /\b(?:needs?\s+(?:a\s+)?decision|decide|decision needed)\b/i.test(text),
    wait: /\b(?:disclosure only|left as is|leave as is|won't fix|wontfix|defer(?:red|s)?|accepted risk)\b/i.test(text) || /\b(?:won't|will not) be fixed\b/i.test(raw),
    pre: /(?:^|[^a-z])pre-?existing(?:[^a-z]|$)/i.test(text),
  };
}

const clipTo = (text, n) => (text.length > n ? `${text.slice(0, Math.max(0, n - 3)).trimEnd()}...` : text);

// The author's outcome is the status line's first word, alone or followed by ":", ";", ",", ".", " - " or "(" ("F2: wrong: the
// cap is never reached"); "wrong value returned" or a word later in free text is not an outcome.
export const OUTCOMES = ['fixed', 'wrong', 'intentional', 'not-worth-it', 'pre-existing', 'decided'];
export function outcomeOf(note) {
  const m = /^\s*([a-z]+(?:-[a-z]+)*)(?:\s*$|\s*[:;,.]\s*|\s+[-—–]\s+|\s*(?=\())(.*)$/i.exec(String(note ?? ''));
  if (!m || !OUTCOMES.includes(m[1].toLowerCase())) return null;
  return { word: m[1].toLowerCase(), reason: m[2].trim() };
}

// A "wrong" outcome withdraws a finding only with a reason when the finding is a blocker.
const authorWithdrawn = (f) => {
  const o = outcomeOf(f.status);
  return f.authorWithdrawn === true || (o?.word === 'wrong' && (!f.blocker || o.reason !== ''));
};

// What the reader must do with each finding, from the final state and the audited severity alone.
export function groupFindings(report) {
  const groups = { fixNow: [], decide: [], fixNext: [], canWait: [], withdrawn: [], fixed: [], preExisting: [] };
  for (const f of report.findings) {
    const kinds = noteKinds(f.status);
    const outcome = outcomeOf(f.status)?.word;
    if (WITHDRAWN_STATES.includes(f.state) || authorWithdrawn(f)) groups.withdrawn.push(f);
    else if (kinds.fixed) groups.fixed.push(f);
    else if (['intentional', 'not-worth-it', 'decided'].includes(outcome)) groups.canWait.push(f);
    // An unresolved blocker is a decision, not a fix: the seats still disagree, and the report gives both positions.
    else if (f.state === 'unresolved-high-stakes' || (String(f.state).startsWith('unresolved') && f.blocker) || kinds.decide) groups.decide.push(f);
    // "Pre-existing" means "not from this change": a report with no change diff cannot tell, so the label groups nothing.
    // Evidence on lines the change added is not pre-existing, whatever the notes say; a file-name guess does not overrule the notes.
    else if (kinds.pre && report.changeDiffs?.length > 0 && !(f.where?.tag === 'added lines' && !f.where.byName)) groups.preExisting.push(f);
    // The seats' own word counts only with no author note, never for a blocker (only the author moves those), and under the same
    // added-lines rule as the notes.
    else if (f.seatPreExisting && !String(f.status ?? '').trim() && !f.blocker && report.changeDiffs?.length > 0 && !(f.where?.tag === 'added lines' && !f.where.byName)) groups.preExisting.push(f);
    else if (kinds.wait) groups.canWait.push(f);
    else if (f.blocker) groups.fixNow.push(f);
    else if (f.severity === 'LOW') groups.canWait.push(f);
    else groups.fixNext.push(f);
  }
  return groups;
}

function severityBars(counts) {
  const rows = [['CRITICAL', counts.critical], ['HIGH', counts.high], ['MEDIUM', counts.medium], ['LOW', counts.low], ['OTHER', counts.other]].filter(([, n]) => n > 0);
  const max = Math.max(...rows.map(([, n]) => n), 1);
  return rows.map(([label, n]) => `${label.padEnd(9)}${'█'.repeat(Math.max(1, Math.round((BAR_WIDTH * n) / max))).padEnd(BAR_WIDTH)} ${String(n).padStart(3)}`);
}

const chatId = (f) => clipTo(String(f?.id ?? '?'), 12);
const idList = (list, cap = 30) => (list.length === 0 ? 'none' : list.length > cap ? `${list.slice(0, cap).map(chatId).join(' ')} (+${list.length - cap} more)` : list.map(chatId).join(' '));

function trafficLight(report, groups) {
  const lines = [];
  const row = (mark, label, f, suffix = '') => {
    const head = `${mark} ${label.padEnd(LABEL_WIDTH)}${(f ? chatId(f) : '').padEnd(5)}${f && chatId(f).length >= 5 ? ' ' : ''}`;
    return `${head}${f ? clipTo(String(f.title ?? ''), CHAT_LINE - head.length - suffix.length) : ''}${suffix}`.trimEnd();
  };
  // Every blocker and every open decision gets its own row: an unresolved HIGH finding sits under DECIDE.
  for (const [label, list] of [['FIX NOW', groups.fixNow], ['DECIDE', groups.decide]]) {
    for (const f of list) lines.push(row('-', label, f));
  }
  for (const [label, list] of [['FIX NEXT', groups.fixNext], ['CAN WAIT', groups.canWait]]) {
    const rest = list.slice(1);
    if (list.length > 0) lines.push(row(' ', label, list[0], rest.length > 0 ? `  (+${rest.slice(0, 6).map(chatId).join(' ')}${rest.length > 6 ? ` and ${rest.length - 6} more` : ''})` : ''));
  }
  if (groups.preExisting.length > 0) lines.push(clipTo(`  ${'PRE-EXISTING'.padEnd(LABEL_WIDTH)}${groups.preExisting.length} not caused by this change: ${idList(groups.preExisting, 8)}`, CHAT_LINE));
  if (groups.withdrawn.length > 0) lines.push(clipTo(`  ${'WITHDRAWN'.padEnd(LABEL_WIDTH)}${groups.withdrawn.length} claim(s) refuted or dropped${groups.withdrawn.some(authorWithdrawn) ? ', or marked wrong by the author' : ''}: ${idList(groups.withdrawn, 8)}`, CHAT_LINE));
  const changed = report.findings.filter((f) => f.claimedSeverity && !WITHDRAWN_STATES.includes(f.state) && !f.authorWithdrawn);
  for (const f of changed.slice(0, 3)) {
    lines.push(clipTo(`  ${'SEVERITY'.padEnd(LABEL_WIDTH)}${chatId(f)} ${f.claimedSeverity} to ${f.severity}${f.severityReason ? `: ${firstSentence(f.severityReason)}` : ''}`, CHAT_LINE));
  }
  if (changed.length > 3) lines.push(`  ${'SEVERITY'.padEnd(LABEL_WIDTH)}(+${changed.length - 3} more changed by the auditor)`);
  const active = report.findings.filter((f) => !WITHDRAWN_STATES.includes(f.state) && !f.authorWithdrawn);
  const audited = report.coverage.freshAuditor && active.length > 0;
  if (audited) {
    const confirmed = active.filter((f) => f.auditorCheck === 'CONFIRMED').length;
    const openIds = active.filter((f) => String(f.state).startsWith('unresolved')).map(chatId);
    const open = openIds.length;
    // A light audit leaves agreed findings unchecked by design; saying so keeps "0 of N confirmed" from reading as a failure.
    const unchecked = report.coverage.lightNote ? active.filter((f) => f.auditorCheck === 'NOT_CHECKED').length : 0;
    // Unresolved and withdrawn first: the line is cut at 100 characters, and the light-audit note is the least needed.
    const tail = `${open > 0 ? `; ${open} unresolved (${openIds.slice(0, 3).join(' ')}${open > 3 ? ' ...' : ''})` : ''}${groups.withdrawn.length > 0 ? `; ${groups.withdrawn.length} withdrawn` : ''}${unchecked > 0 ? `; ${unchecked} not re-checked (light audit)` : ''}`;
    lines.push(clipTo(confirmed === active.length && open === 0 ? `+ ${'VERIFIED'.padEnd(LABEL_WIDTH)}${active.length === 1 ? 'the finding is' : `all ${active.length} findings are`} confirmed by the auditor${tail}` : `  ${'CHECKED'.padEnd(LABEL_WIDTH)}${confirmed} of ${active.length} findings confirmed by the auditor${tail}`, CHAT_LINE));
  }
  // A seat with no command that succeeded only read the code, whatever it concluded; partial failures stay in the --all table.
  for (const r of report.cost.filter((x) => /^seat [AB]$/.test(x.seat) && x.commands && x.commands.failed === x.commands.tried)) {
    const what = r.commands.tried === 0 ? 'ran no commands' : `tried ${plural(r.commands.tried, 'command')}, ${r.commands.tried === 1 ? 'it' : 'all'} failed`;
    // Scripts a tool server ran (node_repl) executed code, so the seat did more than read.
    const ran = (r.commands.scripts ?? 0) - (r.commands.scriptsFailed ?? 0);
    const rest = ran > 0 ? `; it ran ${plural(ran, 'tool script')} instead` : '; its result rests on reading alone';
    lines.push(clipTo(`- ${'COMMANDS'.padEnd(LABEL_WIDTH)}${r.seat} ${what}${rest}`, CHAT_LINE));
  }
  const ticketRows = report.criteria?.tickets ?? [];
  for (const t of ticketRows.some((x) => x.verdict) ? ticketRows : []) {
    const differ = new Set(Object.values(t.seats)).size > 1 ? ` (${Object.entries(t.seats).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
    const head = `${t.verdict === 'GO' ? '+' : t.verdict ? '-' : ' '} ${(t.verdict ?? 'NO VERDICT').padEnd(LABEL_WIDTH)}${t.id}`;
    lines.push(clipTo(`${head}${differ}${t.findings?.length > 0 ? `  findings ${t.findings.join(' ')}` : ''}${t.text ? `  ${t.text}` : ''}`, CHAT_LINE));
  }
  const flagged = (report.criteria?.rows ?? []).filter((r) => r.kind === 'criterion' && (r.status === 'issue' || r.met === 'NOT MET' || r.failedSeats.length > 0 || (r.status === 'clean' && r.met === 'PARTIAL')));
  const flagLabel = (r) => (r.status === 'issue' && r.met !== 'NOT MET' ? 'CRITERION' : r.met === 'PARTIAL' && r.status === 'clean' ? 'PARTIAL' : 'UNMET');
  for (const r of flagged.slice(0, 8)) {
    lines.push(clipTo(`${flagLabel(r) === 'PARTIAL' ? ' ' : '-'} ${flagLabel(r).padEnd(LABEL_WIDTH)}${r.tag}${r.findings.length > 0 ? `  findings ${r.findings.join(' ')}` : '  no finding tagged'}`, CHAT_LINE));
    if (r.findings.length === 0 && r.reason) for (const part of wrapText(r.reason, CHAT_LINE - LABEL_WIDTH - 4, 5)) lines.push(`  ${''.padEnd(LABEL_WIDTH)}${part}`);
  }
  if (flagged.length > 8) lines.push(clipTo(`- ${'MORE'.padEnd(LABEL_WIDTH)}${flagged.length - 8} more flagged: ${flagged.slice(8).map((r) => r.tag).join(' ')} (--all lists them)`, CHAT_LINE));
  const cs = report.criteria?.criteriaStats;
  if (report.criteria && report.criteria.criteriaCount > 0) {
    // Coverage, the verdict counts and the failing-check count on separate lines, so none is cut at 100 characters.
    const verdicts = cs.met + cs.partial + cs.notMet;
    const bad = cs.notVerified > 0 || cs.notMet > 0 || cs.failedClean > 0;
    lines.push(clipTo(cs.notVerified > 0 ? `- ${'NOT VERIFIED'.padEnd(LABEL_WIDTH)}${cs.notVerified} of ${cs.total} criteria` : `${bad ? '-' : cs.issue + cs.partial + cs.noVerdict > 0 ? ' ' : '+'} ${'COVERED'.padEnd(LABEL_WIDTH)}${cs.total} of ${cs.total} criteria checked by a seat${verdicts === 0 ? `, ${cs.issue} with findings (checked is not met)` : ''}`, CHAT_LINE));
    if (verdicts > 0) lines.push(clipTo(`${cs.notMet > 0 ? '-' : ' '} ${'VERDICTS'.padEnd(LABEL_WIDTH)}${cs.met} met, ${cs.partial} partial, ${cs.notMet} not met${cs.noVerdict > 0 ? `, ${cs.noVerdict} no issue found` : ''}${cs.issue > 0 ? `; ${cs.issue} with findings` : ''}`, CHAT_LINE));
    const failing = report.criteria.rows.filter((r) => r.failedSeats.length > 0 && r.met !== 'NOT MET').length;
    if (failing > 0) lines.push(clipTo(`- ${'FAILING'.padEnd(LABEL_WIDTH)}${failing} criteri${failing === 1 ? 'on reports' : 'a report'} a failing check with no verdict and no finding`, CHAT_LINE));
  }
  if (report.criteria && report.criteria.hypothesisCount > 0) {
    const hyp = report.criteria.rows.filter((r) => r.kind === 'hypothesis');
    const word = (r) => (r.status === 'not-verified' ? 'NOT VERIFIED' : ({ refuted: 'REFUTED', split: 'seats disagree', partly: 'partly confirmed', confirmed: 'confirmed' }[r.verdict] ?? 'outcome not parsed'));
    const refuted = hyp.filter((r) => word(r) === 'REFUTED');
    const split = hyp.filter((r) => r.verdict === 'split');
    if (split.length > 0) lines.push(clipTo(`- ${'SPLIT'.padEnd(LABEL_WIDTH)}${split.map((r) => `${r.tag} (${Object.entries(r.outcomes).map(([seat, o]) => `${seat} ${outcomeWord[o] ?? o}`).join(', ')})`).join('; ')}`, CHAT_LINE));
    // A hypothesis names a suspected defect: CONFIRMED (it exists) is the red line, REFUTED (it does not) is good news.
    const confirmedRows = hyp.filter((r) => word(r) === 'confirmed');
    if (confirmedRows.length > 0) lines.push(clipTo(`- ${'CONFIRMED'.padEnd(LABEL_WIDTH)}${confirmedRows.map((r) => r.tag).join(' ')}`, CHAT_LINE));
    if (refuted.length > 0) lines.push(clipTo(`${refuted.length === hyp.length ? '+' : ' '} ${'REFUTED'.padEnd(LABEL_WIDTH)}${refuted.map((r) => r.tag).join(' ')}`, CHAT_LINE));
    const others = hyp.filter((r) => word(r) !== 'REFUTED' && word(r) !== 'seats disagree' && word(r) !== 'confirmed');
    const parts = others.map((r) => `${r.tag} ${word(r)}`);
    if (parts.length > 0) lines.push(clipTo(`  ${'HYPOTHESES'.padEnd(LABEL_WIDTH)}${parts.join(', ')}`, CHAT_LINE));
    if (hyp.some((r) => word(r) === 'outcome not parsed')) lines.push(`  ${''.padEnd(LABEL_WIDTH)}fix: end its Checks performed line with CONFIRMED, REFUTED or PARTLY CONFIRMED`);
  }
  return lines;
}

export function renderChat(report, { all = false } = {}) {
  const groups = groupFindings(report);
  // The blocker count is report.blockers, as in every other format; blockers the report notes moved out of "Fix now" are named.
  const blockers = report.blockers.length;
  const moved = report.findings.filter((f) => f.blocker && !groups.fixNow.includes(f) && !groups.decide.includes(f));
  const ids = (list) => `${list.slice(0, 3).map(chatId).join(', ')}${list.length > 3 ? ', ...' : ''}`;
  // A blocker the notes moved is named with the group it went to, so the banner agrees with the table (it is not "fix now").
  const movedTo = (f) => [['pre-existing', groups.preExisting], ['fixed', groups.fixed], ['can wait', groups.canWait], ['withdrawn', groups.withdrawn]].find(([, list]) => list.includes(f))?.[0] ?? 'moved';
  const movedText = [...new Set(moved.map(movedTo))].map((to) => `${ids(moved.filter((f) => movedTo(f) === to))} marked ${to} in the report notes, not fix now`);
  const blockParts = [...(groups.fixNow.length > 0 ? [`fix ${ids(groups.fixNow)} first`] : []), ...movedText];
  const head = `REVIEW ${report.status}`;
  const blockText = blockers === 0 ? 'no blockers' : `${blockers} blocker${blockers === 1 ? '' : 's'}${blockParts.length > 0 ? ` (${blockParts.join('; ')})` : ''}`;
  const decideText = groups.decide.length > 0 ? ` · ${groups.decide.length} to decide (${groups.decide.slice(0, 3).map(chatId).join(', ')})` : '';
  const findingsText = report.total === 0 ? 'no findings' : `${report.total} finding${report.total === 1 ? '' : 's'}`;
  const critRows = (report.criteria?.rows ?? []).filter((r) => r.kind === 'criterion');
  const withFindings = critRows.filter((r) => r.status === 'issue').map((r) => r.tag);
  const notMet = critRows.filter((r) => r.status === 'clean' && (r.met === 'NOT MET' || r.failedSeats.length > 0)).map((r) => r.tag);
  const tagList = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''}`;
  const criteriaText = `${withFindings.length > 0 ? ` · ${withFindings.length} criteri${withFindings.length === 1 ? 'on' : 'a'} with findings (${tagList(withFindings)})` : ''}${notMet.length > 0 ? ` · ${notMet.length} not met, no finding (${tagList(notMet)})` : ''}`;
  const out = [`> **${head}${report.round ? ` · round ${report.round}` : ''} · ${blockText}${decideText}${criteriaText} · ${findingsText}**`, ''];
  if (report.why) out.push(`Why: ${report.why}`, '');
  if (report.total > 0) {
    // Every finding withdrawn leaves no bar; no empty code block then.
    const bars = severityBars(report.counts);
    if (bars.length > 0) out.push('```', ...bars, '```', '');
    out.push('| Do this | Items | Count |', '|---|---|---|');
    for (const [label, list] of [['Fix now', groups.fixNow], ['Fix next', groups.fixNext], ['Can wait', groups.canWait], ['Decide', groups.decide]]) {
      // Decisions written in the notes are not findings: their row says so instead of a count of 0 next to them.
      const notesOnly = label === 'Decide' && list.length === 0 && report.decisions;
      out.push(`| ${label} | ${notesOnly ? 'see Decisions needed below' : idList(list)} | ${notesOnly ? '-' : list.length} |`);
    }
    if (groups.preExisting.length > 0) out.push(`| Pre-existing | ${idList(groups.preExisting)} | ${groups.preExisting.length} |`);
    if (groups.fixed.length > 0) out.push(`| Fixed, not re-reviewed | ${idList(groups.fixed)} | ${groups.fixed.length} |`);
    if (groups.withdrawn.length > 0) out.push(`| Withdrawn | ${idList(groups.withdrawn)} | ${groups.withdrawn.length} |`);
    out.push('');
  }
  const light = trafficLight(report, groups);
  if (light.length > 0) out.push('```diff', ...light, '```', '');
  if (report.decisions) out.push('**Decisions needed**', '', report.decisions, '');
  for (const caveat of report.caveats) out.push(`> Caveat: ${caveat}`, '');
  if (!all) out.push('_Every finding, criterion and the cost: run with `--format chat --all`._');
  else out.push('---', '', renderMarkdown(report).trimEnd());
  if (!all) out.push('', generatorLine(report.generator));
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---- command ----


// --change-diff files, or <run-dir>/since.diff when none is given and it exists.
async function readChangeDiffs(dir, paths) {
  const files = paths.length > 0 ? paths.map((p) => path.resolve(p)) : existsSync(path.join(dir, 'since.diff')) ? [path.join(dir, 'since.diff')] : [];
  const out = [];
  for (const file of files) {
    if (!existsSync(file)) throw new ReportError(`--change-diff ${file} does not exist`);
    out.push({ name: path.basename(file), text: noBom(await readFile(file, 'utf8')) });
  }
  return out;
}

// Start: the earliest "at" in skill-versions.jsonl (build-brief writes one line per brief). End: findings.json's file time.
async function runTiming(dir, findingsFile) {
  const times = (await readOptional(path.join(dir, 'skill-versions.jsonl'))).split(/\r?\n/).map((line) => {
    try {
      return Date.parse(JSON.parse(line).at);
    } catch {
      return NaN;
    }
  }).filter(Number.isFinite);
  const end = await stat(findingsFile).then((s) => s.mtime.toISOString(), () => null);
  return { start: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null, end };
}

// A native seat's brief is phase1/brief-<seat>.txt, a CLI seat's phase1/<seat>/brief.txt; null when the run kept none.
async function firstBrief(dir) {
  for (const rel of [['brief-A.txt'], ['A', 'brief.txt'], ['brief-B.txt'], ['B', 'brief.txt']]) {
    const file = path.join(dir, 'phase1', ...rel);
    if (existsSync(file)) return readOptional(file);
  }
  return null;
}

// Each seat's claims as findings for a run stopped after Phase 1: the claim ID, its heading and its Severity: line.
export function phase1Claims(seatTexts) {
  const out = [];
  for (const [seat, text] of Object.entries(seatTexts)) {
    const fileLines = String(text ?? '').split(/\r?\n/);
    const claims = parseSeatFile(text, seat).claims;
    claims.forEach((c, i) => {
      const block = fileLines.slice(c.line - 1, i + 1 < claims.length ? claims[i + 1].line - 1 : undefined);
      const end = block.findIndex((l, j) => j > 0 && /^##\s/.test(l));
      const own = end < 0 ? block : block.slice(0, end);
      const severity = /^\s*Severity:\s*\**\s*(CRITICAL|HIGH|MEDIUM|LOW)\b/im.exec(own.join('\n'))?.[1]?.toUpperCase() ?? 'UNKNOWN';
      const title = own[0].replace(/^#+\s*[AB]\d+\b/, '').replace(/^(?:\s*\[[^\]]*\])+/, '').replace(/^[\s\p{Pd}:.-]+/u, '').trim();
      out.push({ id: c.id, severity, title, origins: [c.id], final_state: 'phase1-only' });
    });
  }
  return out;
}

// Both seat files finished: each reached its closing section and, where its brief stated the rule, holds the Blocked: line
// and every claim's "Same shape elsewhere:" line. A run older than a rule is read without it.
async function phase1Finished(dir, seatTexts) {
  const whole = (await firstBrief(dir)) ?? '';
  // The protocol's own wording of each rule, read outside the frozen packet (which may quote that wording).
  const start = whole.indexOf('# Task packet (frozen)');
  // The closing reminder's last occurrence: the packet may quote it too.
  const end = start < 0 ? -1 : whole.lastIndexOf('Last rule, easy to miss');
  const brief = start < 0 ? whole : whole.slice(0, start) + (end < 0 ? '' : whole.slice(end));
  const strict = brief.includes('`Blocked: none` (nothing after it)');
  const sameShape = brief.includes('`Same shape elsewhere:` is required in every claim');
  return Object.entries(seatTexts).every(([seat, text]) => {
    const p = parseSeatFile(text, seat, { sameShape });
    // An unclosed fence is a file cut off mid-write, whatever its closing lines say.
    // A run older than the Blocked: rule is excused only that rule; every other format problem still counts.
    // The Blocked-line rules by their own wording (a structural problem may quote a seat line that holds the word).
    const blockedRule = /has no line "Blocked: none"|write exactly "Blocked: none"|Blocked: lines \(|is not in the exact shape "Blocked: none"|says "blocked:" (?:in|outside)/;
    const problems = strict ? p.problems : p.problems.filter((x) => !blockedRule.test(x));
    return !parseFenceLines(String(text ?? '')).unterminated && p.section !== null && problems.length === 0 && (p.claims.length > 0 || p.section === 'No findings');
  });
}

export async function loadRun(runDir, notesPath = null, changeDiffPaths = []) {
  const dir = path.resolve(runDir);
  const findingsFile = path.join(dir, 'phase3', 'findings.json');
  const seatTexts = {};
  for (const seat of ['A', 'B']) {
    const original = path.join(dir, 'phase1', 'original', `${seat}-findings.md`);
    seatTexts[seat] = await readOptional(existsSync(original) ? original : path.join(dir, 'phase1', `${seat}-findings.md`));
  }
  let findingsDoc;
  if (existsSync(findingsFile)) {
    findingsDoc = await readJson(findingsFile, 'findings');
  } else if (existsSync(path.join(dir, 'phase1', 'format-refused.json'))) {
    // A seat file refused again after its one rewrite stopped the run before the exchange: nothing was audited.
    findingsDoc = { findings: [], synthesized: true };
  } else if (Object.entries(seatTexts).every(([seat, text]) => { const p = parseSeatFile(text, seat); return p.section === 'No findings' && p.claims.length === 0; }) && await phase1Finished(dir, seatTexts)) {
    // No findings.json: the zero-claim finish step, which checks the target, never ran, so the report is incomplete.
    findingsDoc = { zero_claims: true, findings: [], synthesized: true };
  } else if (await phase1Finished(dir, seatTexts)) {
    // A run stopped before the audit with both seat files written: each seat's own claims, neither cross-examined nor audited.
    findingsDoc = { findings: phase1Claims(seatTexts), synthesized: true, phase1_only: true };
  } else {
    findingsDoc = await readJson(findingsFile, 'findings');
  }
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = existsSync(manifestFile) ? await readJson(manifestFile, 'manifest') : null;
  const notesFile = notesPath ? path.resolve(notesPath) : path.join(dir, 'phase3', 'report-notes.md');
  if (notesPath && !existsSync(notesFile)) throw new ReportError(`--notes ${notesFile} does not exist`);
  // A manifest built before the audit finished (a failed chain) records another hash of today's findings, or none and no
  // completed status (a completed manifest built without --findings is trusted).
  const staleManifest = manifest != null && existsSync(findingsFile) && (manifest.hashes?.findings_json ? manifest.hashes.findings_json !== createHash('sha256').update(await readFile(findingsFile)).digest('hex') : manifest.status !== 'completed');
  const report = buildReport({
    findingsDoc,
    manifest,
    packetText: await readOptional(path.join(dir, 'task-packet.md')),
    seatTexts,
    notesText: await readOptional(notesFile),
    files: { scorecard: existsSync(path.join(dir, 'phase3', 'scorecard.md')) ? 'phase3/scorecard.md' : null, findings: existsSync(findingsFile) ? 'phase3/findings.json' : null, manifest: manifest ? 'manifest.json' : null },
    timing: await runTiming(dir, findingsFile),
    changeDiffs: await readChangeDiffs(dir, changeDiffPaths),
    briefText: await firstBrief(dir),
    staleManifest,
  });
  if (!manifest) {
    if (report.status !== 'NOT FINAL') report.caveats.unshift('manifest.json was not found; status, pass counts and cost are unknown.');
  } else if (staleManifest) {
    report.caveats.unshift('manifest.json was built before the current phase3/findings.json, so its status and cost are stale: run review-run manifest, then the report again.');
  }
  // audit --finish refused the auditor's file and has not passed since: the audit ran, its result is pending.
  if (!existsSync(findingsFile) && existsSync(path.join(dir, 'phase3', 'prompt-auditor-fix.txt'))) {
    report.caveats.unshift("The auditor's file was refused and review-run audit --finish has not passed since (phase3/prompt-auditor-fix.txt): finish the audit as that step's last output says, then run review-run manifest and the report again. Until then this report holds the seats' unaudited claims.");
  }
  return report;
}

// tty: whether the output goes to a terminal (colour in auto mode).
async function main(argv, tty = false) {
  try {
    const args = parseArgs(argv);
    const report = await loadRun(args.runDir, args.notes, args.changeDiffs);
    const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '' && process.env.FORCE_COLOR !== '0';
    const color = args.color === 'always' || (args.color === 'auto' && !process.env.NO_COLOR && (forced || tty));
    // The files first: a reader that closes stdout early must not cost a requested file.
    if (args.out) await writeFile(path.resolve(args.out), renderMarkdown(report), 'utf8');
    if (args.json) await writeFile(path.resolve(args.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (args.html) await writeFile(path.resolve(args.html), renderHtml(report), 'utf8');
    io.out(args.format === 'chat' ? renderChat(report, { all: args.all }) : renderText(report, { color }));
    return 0;
  } catch (err) {
    io.err(`build-report: ${err.message}\n`);
    return err instanceof ReportError ? 1 : 2;
  }
}

// The report in-process: { code, stdout, stderr }.
export const runStep = (argv, { tty = false } = {}) => runStepWith('build-report', io, (a) => main(a, tty), argv);

refuseDirectRun(import.meta.url, 'build-report.mjs');
