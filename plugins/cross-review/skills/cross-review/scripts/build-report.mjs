#!/usr/bin/env node
// Builds the review report from the run's own files, so IDs, counts and states are never retyped.
// The terminal report is the default output; --out writes a markdown copy, --html an optional standalone page.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { isMainModule } from './path-utils.mjs';
import { parseFenceLines } from './blind-relabel.mjs';

class ReportError extends Error {}

const HELP = `build-report.mjs: the review report, built from the run's files.

Usage:
  node build-report.mjs --run-dir <dir> [--format text|chat [--all]] [--notes <file>] [--color auto|always|never]
                        [--out <report.md>] [--json <report.json>] [--html <report.html>]

--format chat prints the report as plain markdown for a chat window (a quote banner, severity bars, an action table and a red/green diff
block); paste it verbatim into the reply. --all adds every finding, criterion and the cost. No colour codes are used.
Default (--format text): print the terminal report (ASCII). Colour appears on a real terminal, or when FORCE_COLOR is set, or with
--color always (use it when the output is captured by a tool, for example an agent session); NO_COLOR or --color never turns it off.
--out    also write a plain markdown copy for a ticket or pull request.
--json   also write the facts the report is built from.
--html   also write a standalone page (no scripts, light and dark theme). Only when asked for.
--notes  a markdown file with "## Why" (one sentence) and "## Decisions needed" (a table). Default:
         <run-dir>/phase3/report-notes.md when it exists.

Reads <run-dir>/phase3/findings.json, <run-dir>/manifest.json, <run-dir>/task-packet.md and the Phase 1
seat files (phase1/original/ when present). Nothing is recomputed by hand:
  Status    COMPLETE when manifest.status is "completed", else INCOMPLETE. No merge/ship verdict is printed.
  Blockers  findings whose final_state is unresolved-high-stakes, plus every finding whose final severity
            (severity_audited, else severity) is HIGH or CRITICAL and is not settled-refuted or dropped-speculative.
  Criteria  every "- [TAG] text" line of the task packet. A tag a finding's claim heading carries is "issue
            found"; a tag named in a seat's "## Checks performed" section is "no issue found", unless the seat marked it
            NOT MET or PARTIAL or reported a failing check: then it is "not met or partial (no finding)"; any other tag
            is NOT VERIFIED (nobody stated a check for it). Absence of a finding is never shown as a pass.
  Cost      from manifest.seat_usage; a figure that is missing prints as unknown, never an estimate.
`;

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const SEV_KEY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

export function parseArgs(argv) {
  const args = { runDir: null, notes: null, color: 'auto', format: 'text', all: false, out: null, json: null, html: null, help: false };
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
    else if (tok === '-h' || tok === '--help') args.help = true;
    else throw new ReportError(`unrecognized argument: ${tok}`);
  }
  if (!args.help && !args.runDir) throw new ReportError('--run-dir <dir> is required');
  if (args.all && args.format !== 'chat') throw new ReportError('--all is only used with --format chat');
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
  const clause = /^(.{40,}?)[:;]/.exec(first.slice(0, cap + 1));
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
  const row = { seat: name, newInput: null, cacheWrite: null, cacheRead: null, output: null, calls: null };
  if (!u || typeof u !== 'object') return row;
  if (u.new_input_tokens !== undefined || u.context_reread_tokens !== undefined) {
    // new_input_tokens holds fresh input plus the cache write; a context rebuild is a big cache write, so show them apart when both are known.
    const write = finite(u.cache_creation_input_tokens);
    const fresh = finite(u.input_tokens);
    const split = write !== null && fresh !== null;
    return { ...row, newInput: split ? fresh : finite(u.new_input_tokens), cacheWrite: split ? write : null, cacheRead: finite(u.context_reread_tokens), output: finite(u.output_tokens), calls: finite(u.calls) };
  }
  if (anthropic && u.input_tokens !== undefined) {
    return { ...row, newInput: finite(u.input_tokens), cacheWrite: finite(u.cache_write_input_tokens), cacheRead: finite(u.cached_input_tokens), output: finite(u.output_tokens), calls: finite(u.calls) };
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
    if (anthropic) return finite(u?.input_tokens);
    const input = finite(u?.input_tokens);
    const cached = finite(u?.cached_input_tokens);
    return input !== null && cached !== null ? inclusiveNew(input, cached) : null;
  });
}

// Claude and OpenCode report input and cache apart; Codex counts the cache inside input. The provider decides, else the raw fields.
export const separateCache = (u, provider, model) => provider === 'anthropic' || provider === 'opencode' || /^claude/i.test(model ?? '')
  || u?.raw?.cache_creation_input_tokens !== undefined || u?.raw?.cache_read_input_tokens !== undefined || u?.raw?.tokens?.cache !== undefined;

// A native agent's transcript does not record output tokens, so the table is a lower bound for those rows.
export const costNote = (rows) => (rows.some((r) => r.output === null && r.calls > 0) ? 'Output is unknown for native agents (their transcript does not record it); their real cost is higher than shown.' : null);
// The manifest records the calls passed to it; a preflight session probe and an attempt that was rerun are not among them.
export const COST_SCOPE = 'The cost covers the completed review calls; session probes and earlier failed attempts are not counted.';

// The shell commands a seat tried and how many failed, as the manifest counted them; a row without a count is never guessed.
const validCommands = (c) => (c && Number.isInteger(c.tried) && Number.isInteger(c.failed) && c.failed >= 0 && c.failed <= c.tried ? { tried: c.tried, failed: c.failed } : null);
const withCommands = (row, c) => (validCommands(c) ? { ...row, commands: validCommands(c) } : row);
export const commandsCell = (r) => (r.commands ? `${r.commands.tried} tried, ${r.commands.failed} failed` : 'unknown');

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

function checksPerformed(seatText) {
  const lines = unfenced(seatText).split('\n');
  const start = lines.findIndex((l) => /^##\s+Checks performed\s*$/i.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
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

export function buildCriteria(criteria, findings, headingTags, checksBySeat, ticketMap = new Map()) {
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
    const outcomes = hypothesis ? Object.fromEntries(named.map((seat) => [seat, seatVerdict[seat]]).filter(([, o]) => o)) : {};
    const seatMet = hypothesis ? null : worstVerdict(Object.values(seatVerdict).filter(Boolean));
    const met = !hypothesis && found.length > 0 && (seatMet === null || seatMet === 'MET') ? 'PARTIAL' : seatMet;
    const values = Object.values(outcomes);
    const verdict = !hypothesis || status === 'not-verified' ? null
      : values.some((o) => o === 'REFUTED') ? (values.every((o) => o === 'REFUTED') ? 'refuted' : 'split')
        : values.some((o) => o === 'PARTLY' || o === 'MIXED') ? 'partly'
          : values.length > 0 && values.length === seats.length ? 'confirmed' : 'unparsed';
    const reasonLine = hypothesis || found.length > 0 ? null : named.flatMap((seat) => linesOf(seat)).find((l) => ['NOT MET', 'PARTIAL'].includes(parseVerdict(l, tag)));
    const reason = reasonLine ? reasonOf(reasonLine, tag) : '';
    return { refuted, doubt, failedSeats, outcomes, verdict, met, reason, tag, text, kind: hypothesis ? 'hypothesis' : 'criterion', group: groupsOf(tag, hypothesis, ticketMap)[0], groups: groupsOf(tag, hypothesis, ticketMap), status, findings: found, seats };
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

export function buildReport({ findingsDoc, manifest, packetText = '', seatTexts = {}, notesText = '', files = {} }) {
  if (!findingsDoc || !Array.isArray(findingsDoc.findings)) throw new ReportError('findings.json has no "findings" array');
  const findings = findingsDoc.findings.map((f) => ({
    id: f.id,
    severity: finalSeverity(f) || 'UNKNOWN',
    claimedSeverity: f.severity_audited && f.severity && f.severity_audited !== f.severity ? f.severity : null,
    fix: String(f.recommended_fix ?? f.suggested_fix ?? '').replace(/\s+/g, ' ').trim(),
    severityReason: String(f.auditor_check?.severity_reason ?? '').replace(/\s+/g, ' ').trim(),
    state: f.final_state ?? 'unknown',
    title: shortTitle(f),
    origins: f.origins ?? [],
    basis: f.basis ?? '',
    evidenceStrength: f.evidence_strength ?? '',
    auditorCheck: f.auditor_check?.result ?? 'NOT_CHECKED',
    blocker: isBlocker(f),
  }));
  findings.sort((a, b) => (SEV_ORDER.indexOf(a.severity) + 1 || 9) - (SEV_ORDER.indexOf(b.severity) + 1 || 9) || idNumber(a.id) - idNumber(b.id));
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [SEV_KEY[s], findings.filter((f) => f.severity === s).length]));
  counts.other = findings.filter((f) => !SEV_ORDER.includes(f.severity)).length;
  const states = {};
  for (const f of findings) states[f.state] = (states[f.state] ?? 0) + 1;

  const headingTags = new Map();
  for (const text of Object.values(seatTexts)) for (const [id, tags] of claimHeadingTags(text, [...packetCriteria(packetText).keys()])) headingTags.set(id, tags);
  const checksBySeat = Object.fromEntries(Object.entries(seatTexts).map(([seat, text]) => [seat, checksPerformed(text)]));
  const criteria = buildCriteria(packetCriteria(packetText), findingsDoc.findings, headingTags, checksBySeat, packetTicketMap(packetText));
  if (criteria) {
    const byId = new Map(findings.map((f) => [f.id, f]));
    for (const r of criteria.rows) r.findings = r.findings.filter((id) => byId.has(id));
    // A finding whose claim heading carries a tag of the ticket (BUG-6030, PROD-6030, or a tag of its Tickets range) belongs on the ticket line, listed in the packet or not.
    const ticketMap = packetTicketMap(packetText);
    for (const t of criteria.tickets) {
      const ids = new Set((t.findings ?? []).filter((id) => byId.has(id)));
      for (const f of findingsDoc.findings) {
        if (!byId.has(f.id) || f.final_state === 'settled-refuted' || f.final_state === 'dropped-speculative') continue;
        const tags = (f.origins ?? []).flatMap((origin) => headingTags.get(origin) ?? []);
        if (tags.some((tag) => groupsOf(tag, false, ticketMap).includes(t.id))) ids.add(f.id);
      }
      t.findings = [...ids].sort((a, b) => idNumber(a) - idNumber(b));
    }
  }

  const m = manifest ?? {};
  const status = m.status === 'completed' ? 'COMPLETE' : 'INCOMPLETE';
  const zeroClaims = findingsDoc.zero_claims === true;
  const depth = zeroClaims ? 'not run (no claims)' : (findingsDoc.audit_depth ?? m.exchange?.audit_depth ?? null);
  const verifiers = m.falsification?.verifiers_run;
  const coverage = {
    auditDepth: depth,
    lightNote: !zeroClaims && depth === 'light' ? 'agreed claims were not re-checked by the auditor' : null,
    reviewerPasses: Array.isArray(m.reviewers) ? m.reviewers.length : null,
    blindExchange: m.exchange?.blinded ?? null,
    freshAuditor: m.exchange?.auditor ? String(m.exchange.auditor) : null,
    falsificationRequested: m.falsification?.requested ?? null,
    verifiersRun: verifiers ?? null,
  };

  const caveats = [];
  if (zeroClaims) caveats.push("Neither seat raised a claim, so no auditor ran and there is no scorecard; the criteria below come from the seats' own checks.");
  if (status === 'INCOMPLETE') caveats.push(`The review is incomplete (manifest status "${m.status ?? 'missing'}"). Do not read it as a completed review.`);
  if (m.source_write && (Array.isArray(m.source_write) ? m.source_write.length > 0 : Object.keys(m.source_write).length > 0)) caveats.push('A write to the reviewed source was recorded; see manifest source_write.');
  for (const row of Array.isArray(m.support) ? m.support : []) {
    if (row.status && row.status !== 'supported') caveats.push(`Seat ${row.role} runs on a ${row.status} route (${row.runtime}, ${row.transport}).`);
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
    if (new Set(Object.values(t.seats)).size > 1) caveats.push(`Ticket ${t.id}: the seats disagree (${Object.entries(t.seats).map(([seat, v]) => `${seat} ${v}`).join(', ')}); the exchange did not reconcile it, so read both seat files before you act.`);
  }
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
  const notes = notesSections(notesText);
  const statusById = findingStatus(notes['finding status'] ?? '');
  for (const f of findings) f.status = statusById.get(f.id) ?? null;
  const isFixed = (text) => noteKinds(text).fixed;
  if ([...statusById.values()].some(isFixed)) caveats.push(`Changes made after the reviewed snapshot were not re-reviewed (${[...statusById.entries()].filter(([, s]) => isFixed(s)).map(([id]) => id).join(', ')}); the findings describe the code the reviewers read.`);
  const blockers = findings.filter((f) => f.blocker);

  return {
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
  }).join('  ') + (report.counts.other > 0 ? `  ${paint(['yellow', 'bold'], `${report.counts.other} other`)}` : '');
  out.push(`${paint(statusStyle, `STATUS ${report.status}`)}   ${paint(report.blockers.length > 0 ? ['red', 'bold'] : ['green'], `Blockers: ${report.blockers.length}`)}   ${plural(report.total, 'finding')}: ${sevSummary}`);
  const meta = [report.topology, report.mode && `${report.mode} mode`, report.runId && `run ${String(report.runId).slice(0, 8)}`].filter(Boolean).join(' | ');
  if (meta) out.push(paint(['dim'], meta));
  out.push(`Why: ${report.why ?? paint(['dim'], '(not written; add "## Why" to report-notes.md)')}`);
  out.push('');

  if (report.blockers.length > 0) {
    out.push(paint(['bold'], 'FIX OR DECIDE FIRST'));
    for (const f of report.findings.filter((x) => x.blocker)) {
      out.push(`  ${paint([SEV_COLOR[f.severity] ?? 'dim', 'bold'], f.severity.padEnd(8))} ${String(f.id ?? '?').padEnd(4)} ${f.title}${f.status ? ` ${paint(['yellow'], `[${f.status}]`)}` : ''}`);
      out.push(paint(['dim'], `           ${f.state} | ${f.basis} ${f.evidenceStrength} | auditor ${f.auditorCheck}${f.claimedSeverity ? ` | claimed ${f.claimedSeverity}` : ''}`));
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
    if (c.hypothesisCount > 0) out.push(paint(['bold'], `HYPOTHESES (${c.hypothesisCount})`) + `  ${paint(c.hypothesisStats.refuted > 0 ? ['red', 'bold'] : ['green'], hypothesisParts(c.hypothesisStats).join(' | '))}`);
    if (c.silentSeats.length > 0) out.push(paint(['yellow'], `  ${c.silentSeats.map((x) => `Seat ${x}`).join(', ')} wrote checks but named no criterion or hypothesis tag, so ${c.silentSeats.length > 1 ? 'their' : 'its'} checks are not counted below.`));
    if (report.criteriaSource) out.push(paint(['dim'], `  Source: ${report.criteriaSource.replace(/\s+/g, ' ')}`));
    for (const [group, rows] of criteriaGroups(c)) {
      out.push(group === 'hypotheses'
        ? `  ${paint(['bold'], groupTitle(group))}: ${hypothesisParts(c.hypothesisStats).join(', ')}`
        : `  ${paint(['bold'], groupTitle(group))}: ${splitText(criteriaSplit(rows), ', ')}`);
      for (const r of rows) {
        const result = r.status === 'issue' ? paint(['red'], `issue found: ${r.findings.join(', ')}`)
          : r.status === 'clean' ? paint(r.verdict === 'refuted' || r.verdict === 'split' || r.met === 'NOT MET' || r.failedSeats?.length > 0 ? ['red', 'bold'] : r.met === 'PARTIAL' ? ['yellow'] : ['green'], cleanLabel(r))
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
  if (passes.length > 0) out.push(`  Passes: ${passes.join('; ')}`);
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
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

const mdEsc = (text) => String(text ?? '').replace(/[\\`*_{}[\]<>|#]/g, '\\$&');
const cell = (text) => mdEsc(text).replace(/\r?\n/g, ' ');

export function renderMarkdown(report) {
  const out = [`# Review report: ${report.status}`, '', `**Status:** ${report.status} | **Blockers:** ${report.blockers.length} | **Findings:** ${report.total} (${[...SEV_ORDER.map((s) => `${report.counts[SEV_KEY[s]]} ${SEV_KEY[s]}`), ...(report.counts.other > 0 ? [`${report.counts.other} other`] : [])].join(', ')})`, ''];
  if (report.why) out.push(`**Why:** ${report.why}`, '');
  const listing = (title, items) => {
    if (items.length === 0) return;
    out.push(`## ${title}`, '');
    for (const f of items) {
      out.push(`- **${f.severity}** ${f.id}: ${mdEsc(f.title)} (${f.state}; ${f.basis} ${f.evidenceStrength}; auditor ${f.auditorCheck}${f.claimedSeverity ? `; claimed ${f.claimedSeverity}` : ''})${f.status ? ` **[${mdEsc(f.status)}]**` : ''}`);
      if (f.fix) out.push(`  Fix: ${mdEsc(f.fix)}`);
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
  if (cv.reviewerPasses !== null) out.push(`- Reviewer passes: ${cv.reviewerPasses}; blind exchange: ${cv.blindExchange === null ? 'unknown' : cv.blindExchange ? 'yes' : 'no'}; fresh auditor: ${cv.freshAuditor ?? 'unknown'}; falsification verifiers run: ${cv.verifiersRun ?? 'unknown'}`);
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
  const chip = (sev) => `<span class="chip ${SEV_KEY[sev] ?? 'zero'}">${esc(sev)}</span>`;
  const row = (f) => `<div class="row">${chip(f.severity)}<span class="id">${esc(f.id)}</span><span>${esc(f.title)}${f.claimedSeverity ? ` <span class="meta">(claimed ${esc(f.claimedSeverity)})</span>` : ''}${f.status ? ` <span class="chip medium">${esc(f.status)}</span>` : ''}<br><span class="meta">${esc(f.state)} | ${esc(f.basis)} ${esc(f.evidenceStrength)} | auditor ${esc(f.auditorCheck)}</span></span></div>`;
  const counts = SEV_ORDER.map((s) => { const n = report.counts[SEV_KEY[s]]; return `<div class="count ${n ? SEV_KEY[s] : 'zero'}"><b>${n}</b><span>${SEV_KEY[s]}</span></div>`; }).join('') + (report.counts.other > 0 ? `<div class="count medium"><b>${report.counts.other}</b><span>other</span></div>` : '');
  const blockers = report.findings.filter((f) => f.blocker);
  const others = report.findings.filter((f) => !f.blocker);
  const parts = [
    `<section><span class="status ${report.status.toLowerCase()}">${esc(report.status)}</span> <span class="meta">Blockers: ${report.blockers.length}</span><h1>${esc(report.why ?? 'Review report')}</h1><div class="counts">${counts}</div></section>`,
  ];
  if (blockers.length) parts.push(`<section><h2>Fix or decide first</h2>${blockers.map(row).join('')}</section>`);
  if (others.length) parts.push(`<section><h2>Other findings</h2>${others.map(row).join('')}</section>`);
  if (report.criteria) {
    const c = report.criteria;
    const cs = criteriaSplit(c.rows.filter((r) => r.kind === 'criterion'));
    const pct = (n) => `${c.criteriaCount > 0 ? ((100 * n) / c.criteriaCount).toFixed(1) : '0.0'}%`;
    parts.push(`<section><h2>Criteria (${c.criteriaCount}${c.hypothesisCount > 0 ? ` + ${c.hypothesisCount} hypotheses` : ''})</h2><div class="bar" role="img" aria-label="Criteria: ${splitText(cs, ', ')}"><i style="width:${pct(cs.issue)};background:var(--high)"></i>${cs.unmet > 0 ? `<i style="width:${pct(cs.unmet)};background:var(--med)"></i>` : ''}<i style="width:${pct(cs.clean)};background:var(--ok)"></i><i style="width:${pct(cs.notVerified)};background:repeating-linear-gradient(45deg,var(--nv) 0 5px,var(--nv-bg) 5px 10px)"></i></div>${c.silentSeats.length > 0 ? `<p class="meta">${esc(c.silentSeats.map((x) => `Seat ${x}`).join(', '))} wrote checks but named no criterion or hypothesis tag; their checks are not counted here.</p>` : ''}<p class="meta">Criteria: ${splitText(cs, ' | ')}${c.hypothesisCount > 0 ? ` &nbsp;|&nbsp; Hypotheses: ${esc(hypothesisParts(c.hypothesisStats).join(' | '))}` : ''}</p><table><thead><tr><th>Group</th><th>Criterion</th><th>Result</th><th>Text</th></tr></thead><tbody>${criteriaGroups(c).flatMap(([group, rows]) => rows.map((r) => [group, r])).map(([group, r]) => `<tr><td>${esc(groupTitle(group))}</td><td>${esc(r.tag)}</td><td>${r.status === 'issue' ? `<span class="chip high">Issue found</span> ${esc(r.findings.join(', '))}${sharedNote(r) ? ` <span class="meta">(${esc(sharedNote(r))})</span>` : ''}` : r.status === 'clean' ? `<span class="chip ${r.verdict === 'refuted' || r.met === 'NOT MET' || r.failedSeats?.length > 0 ? 'high' : r.met === 'PARTIAL' ? 'medium' : 'ok'}">${r.kind === 'hypothesis' ? (r.verdict === 'refuted' ? 'Refuted' : 'Checked') : (unmetWord(r) ?? 'No issue found')}</span> ${esc(r.kind === 'hypothesis' ? cleanLabel(r) : r.seats.join(', '))}${r.kind !== 'hypothesis' && r.refuted?.length ? ` <span class="meta">(claim refuted: ${esc(r.refuted.join(', '))})</span>` : ''}` : '<span class="chip nv">Not verified</span>'}${r.kind !== 'hypothesis' && r.status === 'clean' && r.doubt.length > 0 ? ` <span class="meta">(${esc(r.doubt.join(', '))} said the check was incomplete)</span>` : ''}</td><td>${esc(clip(r.text, 70))}</td></tr>`).join('')}</tbody></table></section>`);
  }
  const cv = report.coverage;
  parts.push(`<section><h2>Coverage</h2><p>Audit depth: ${esc(cv.auditDepth ?? 'unknown')}${cv.lightNote ? ` (${esc(cv.lightNote)})` : ''}</p></section>`);
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
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review report</title><style>${HTML_CSS}</style></head><body><main>${parts.join('')}</main></body></html>\n`;
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

// What the reader must do with each finding, from the final state and the audited severity alone.
export function groupFindings(report) {
  const groups = { fixNow: [], decide: [], fixNext: [], canWait: [], withdrawn: [], fixed: [], preExisting: [] };
  for (const f of report.findings) {
    const kinds = noteKinds(f.status);
    if (WITHDRAWN_STATES.includes(f.state)) groups.withdrawn.push(f);
    else if (kinds.fixed) groups.fixed.push(f);
    else if (f.state === 'unresolved-high-stakes' || kinds.decide) groups.decide.push(f);
    else if (kinds.pre) groups.preExisting.push(f);
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
  for (const [label, list] of [['FIX NOW', groups.fixNow], ['DECIDE', groups.decide]]) {
    for (const f of list.slice(0, 5)) lines.push(row('-', label, f));
    if (list.length > 5) lines.push(`- ${label.padEnd(LABEL_WIDTH)}(+${list.length - 5} more)`);
  }
  for (const [label, list] of [['FIX NEXT', groups.fixNext], ['CAN WAIT', groups.canWait]]) {
    const rest = list.slice(1);
    if (list.length > 0) lines.push(row(' ', label, list[0], rest.length > 0 ? `  (+${rest.slice(0, 6).map(chatId).join(' ')}${rest.length > 6 ? ` and ${rest.length - 6} more` : ''})` : ''));
  }
  if (groups.preExisting.length > 0) lines.push(clipTo(`  ${'PRE-EXISTING'.padEnd(LABEL_WIDTH)}${groups.preExisting.length} not caused by this change: ${idList(groups.preExisting, 8)}`, CHAT_LINE));
  if (groups.withdrawn.length > 0) lines.push(clipTo(`  ${'WITHDRAWN'.padEnd(LABEL_WIDTH)}${groups.withdrawn.length} claim(s) refuted or dropped: ${idList(groups.withdrawn, 8)}`, CHAT_LINE));
  const changed = report.findings.filter((f) => f.claimedSeverity && !WITHDRAWN_STATES.includes(f.state));
  for (const f of changed.slice(0, 3)) {
    lines.push(clipTo(`  ${'SEVERITY'.padEnd(LABEL_WIDTH)}${chatId(f)} ${f.claimedSeverity} to ${f.severity}${f.severityReason ? `: ${firstSentence(f.severityReason)}` : ''}`, CHAT_LINE));
  }
  if (changed.length > 3) lines.push(`  ${'SEVERITY'.padEnd(LABEL_WIDTH)}(+${changed.length - 3} more changed by the auditor)`);
  const active = report.findings.filter((f) => !WITHDRAWN_STATES.includes(f.state));
  const audited = report.coverage.freshAuditor && active.length > 0;
  if (audited) {
    const confirmed = active.filter((f) => f.auditorCheck === 'CONFIRMED').length;
    const open = active.filter((f) => String(f.state).startsWith('unresolved')).length;
    const tail = `${open > 0 ? `; ${open} unresolved (not settled)` : ''}${groups.withdrawn.length > 0 ? `; ${groups.withdrawn.length} withdrawn` : ''}`;
    lines.push(clipTo(confirmed === active.length && open === 0 ? `+ ${'VERIFIED'.padEnd(LABEL_WIDTH)}${active.length === 1 ? 'the finding is' : `all ${active.length} findings are`} confirmed by the auditor${tail}` : `  ${'CHECKED'.padEnd(LABEL_WIDTH)}${confirmed} of ${active.length} findings confirmed by the auditor${tail}`, CHAT_LINE));
  }
  // A seat with no command that succeeded only read the code, whatever it concluded; partial failures stay in the --all table.
  for (const r of report.cost.filter((x) => /^seat [AB]$/.test(x.seat) && x.commands && x.commands.failed === x.commands.tried)) {
    const what = r.commands.tried === 0 ? 'ran no commands' : `tried ${plural(r.commands.tried, 'command')}, ${r.commands.tried === 1 ? 'it' : 'all'} failed`;
    lines.push(clipTo(`- ${'COMMANDS'.padEnd(LABEL_WIDTH)}${r.seat} ${what}; its result rests on reading alone`, CHAT_LINE));
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
  if (flagged.length > 8) lines.push(`- ${'CRITERION'.padEnd(LABEL_WIDTH)}(+${flagged.length - 8} more)`);
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
    if (refuted.length > 0) lines.push(clipTo(`- ${'REFUTED'.padEnd(LABEL_WIDTH)}${refuted.map((r) => r.tag).join(' ')}`, CHAT_LINE));
    const others = hyp.filter((r) => word(r) !== 'REFUTED' && word(r) !== 'seats disagree');
    const confirmed = others.filter((r) => word(r) === 'confirmed').length;
    const parts = [...others.filter((r) => word(r) !== 'confirmed').map((r) => `${r.tag} ${word(r)}`), ...(confirmed > 0 ? [`${confirmed} confirmed`] : [])];
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
  const blockParts = [...(groups.fixNow.length > 0 ? [`fix ${ids(groups.fixNow)} first`] : []), ...(moved.length > 0 ? [`${ids(moved)} marked in the report notes`] : [])];
  const head = report.status === 'COMPLETE' ? 'REVIEW COMPLETE' : 'REVIEW INCOMPLETE';
  const blockText = blockers === 0 ? 'no blockers' : `${blockers} blocker${blockers === 1 ? '' : 's'}${blockParts.length > 0 ? ` (${blockParts.join('; ')})` : ''}`;
  const decideText = groups.decide.length > 0 ? ` · ${groups.decide.length} to decide (${groups.decide.slice(0, 3).map(chatId).join(', ')})` : '';
  const findingsText = report.total === 0 ? 'no findings' : `${report.total} finding${report.total === 1 ? '' : 's'}`;
  const critRows = (report.criteria?.rows ?? []).filter((r) => r.kind === 'criterion');
  const withFindings = critRows.filter((r) => r.status === 'issue').map((r) => r.tag);
  const notMet = critRows.filter((r) => r.status === 'clean' && (r.met === 'NOT MET' || r.failedSeats.length > 0)).map((r) => r.tag);
  const tagList = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''}`;
  const criteriaText = `${withFindings.length > 0 ? ` · ${withFindings.length} criteri${withFindings.length === 1 ? 'on' : 'a'} with findings (${tagList(withFindings)})` : ''}${notMet.length > 0 ? ` · ${notMet.length} not met, no finding (${tagList(notMet)})` : ''}`;
  const out = [`> **${head} · ${blockText}${decideText}${criteriaText} · ${findingsText}**`, ''];
  if (report.why) out.push(`Why: ${report.why}`, '');
  if (report.total > 0) {
    out.push('```', ...severityBars(report.counts), '```', '');
    out.push('| Do this | Items | Count |', '|---|---|---|');
    for (const [label, list] of [['Fix now', groups.fixNow], ['Fix next', groups.fixNext], ['Can wait', groups.canWait], ['Decide', groups.decide]]) {
      out.push(`| ${label} | ${label === 'Decide' && list.length === 0 && report.decisions ? 'see Decisions needed below' : idList(list)} | ${list.length} |`);
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
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---- command ----

const NO_FINDINGS_MARKER_RE = /^##\s+No findings\s*$/m;
const CLAIM_HEADING_RE = /^##\s+[AB]\d+\b/m;

export async function loadRun(runDir, notesPath = null) {
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
  } else if (Object.values(seatTexts).map(unfenced).every((text) => NO_FINDINGS_MARKER_RE.test(text) && !CLAIM_HEADING_RE.test(text))) {
    findingsDoc = { zero_claims: true, findings: [] };
  } else {
    findingsDoc = await readJson(findingsFile, 'findings');
  }
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = existsSync(manifestFile) ? await readJson(manifestFile, 'manifest') : null;
  const notesFile = notesPath ? path.resolve(notesPath) : path.join(dir, 'phase3', 'report-notes.md');
  if (notesPath && !existsSync(notesFile)) throw new ReportError(`--notes ${notesFile} does not exist`);
  const report = buildReport({
    findingsDoc,
    manifest,
    packetText: await readOptional(path.join(dir, 'task-packet.md')),
    seatTexts,
    notesText: await readOptional(notesFile),
    files: { scorecard: existsSync(path.join(dir, 'phase3', 'scorecard.md')) ? 'phase3/scorecard.md' : null, findings: 'phase3/findings.json', manifest: manifest ? 'manifest.json' : null },
  });
  if (!manifest) report.caveats.unshift('manifest.json was not found; status, pass counts and cost are unknown.');
  return report;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const report = await loadRun(args.runDir, args.notes);
  const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '' && process.env.FORCE_COLOR !== '0';
  const color = args.color === 'always' || (args.color === 'auto' && !process.env.NO_COLOR && (forced || process.stdout.isTTY === true));
  // The files first: a reader that closes stdout early must not cost a requested file.
  if (args.out) await writeFile(path.resolve(args.out), renderMarkdown(report), 'utf8');
  if (args.json) await writeFile(path.resolve(args.json), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (args.html) await writeFile(path.resolve(args.html), renderHtml(report), 'utf8');
  process.stdout.write(args.format === 'chat' ? renderChat(report, { all: args.all }) : renderText(report, { color }));
}

if (isMainModule(import.meta.url)) {
  // A reader that stops early (head, Select-Object -First) closes the pipe: the rest of the output is dropped, the exit code stays.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-report: ${err.message}\n`);
    process.exitCode = err instanceof ReportError ? 1 : 2;
  });
}
