// Mechanical backing for review-protocol.md's blind exchange: relabels claim IDs,
// scans for vendor/model self-identification, and coin-flips the Phase 3 audit
// mapping. Without this, "blind review" was orchestrator-followed prose only.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { generatorLine, headingTags as readHeadingTags, packetCriteria } from './build-report.mjs';
import { extractSection, runDirNamedIn } from './build-brief.mjs';
import { comparablePath, foldsCase, GIT_C_LOCALE, gitRepoFromProbe, isInsidePath, pathSpellingsOf, scrubDir } from './path-utils.mjs';
import { makeIo, refuseDirectRun, runStep as runStepWith, StepExit } from './step-io.mjs';

class RelayError extends Error {}
const io = makeIo();

function log(msg) {
  io.err(`blind-relabel: ${msg}\n`);
}

// A UTF-8 BOM (PowerShell Set-Content -Encoding utf8 writes one) breaks JSON.parse and every
// line-1 anchored regex such as "# Seat A findings".
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readUtf8(filePath) {
  return stripBom(await fs.readFile(filePath, 'utf8'));
}

// The protocol copy staged for the auditor holds only the sections it works from: the full file's scope, model-identity and
// manifest examples name the vendors and models, which the auditor must not learn.
const AUDITOR_PROTOCOL_SECTIONS = ['## Three label layers', '## Evidence and findings: reviewer-authored fields', '### Web verification: reviewer rules', '## Interaction modes',
  '## Synthesis: adjudication-added fields', '## Falsification pass', '## Canonical findings', '## findings.json', '## Fresh-context auditor'];
export function auditorProtocol(text) {
  return `# Review protocol: the auditor's sections\n\n${AUDITOR_PROTOCOL_SECTIONS.map((h) => extractSection(text, h)).join('\n\n')}\n`;
}
const PROTOCOL_PATH = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'references', 'review-protocol.md');

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new RelayError(`${flag} requires a value`);
  }
  return v;
}

function parseArgs(argv) {
  if (argv.length === 0) throw new RelayError('missing subcommand');
  const [sub, ...rest] = argv;
  if (!['relabel', 'scan', 'flip', 'translate', 'validate', 'append-rebuttals', 'audit-prep', 'splice', 'scorecard', 'clear-cache'].includes(sub)) {
    throw new RelayError(`unknown subcommand "${sub}"`);
  }
  if (sub === 'clear-cache') {
    if (rest.length > 0) throw new RelayError('clear-cache takes no arguments');
    return { sub };
  }
  const args = { sub };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--in') { args.in = takeValue(rest, i, '--in'); i++; }
    else if (a === '--out') { args.out = takeValue(rest, i, '--out'); i++; }
    else if (a === '--from') { args.from = takeValue(rest, i, '--from'); i++; }
    else if (a === '--to') { args.to = takeValue(rest, i, '--to'); i++; }
    else if (a === '--target-dir') { args.targetDir = takeValue(rest, i, '--target-dir'); i++; }
    else if (a === '--tokens') { args.tokens = takeValue(rest, i, '--tokens'); i++; }
    else if (a === '--mapping') { args.mapping = takeValue(rest, i, '--mapping'); i++; }
    else if (a === '--phase1-dir') { args.phase1Dir = takeValue(rest, i, '--phase1-dir'); i++; }
    else if (a === '--verification-dir') { args.verificationDir = takeValue(rest, i, '--verification-dir'); i++; }
    else if (a === '--forbid-seats') { args.forbidSeats = takeValue(rest, i, '--forbid-seats'); i++; }
    else if (a === '--phase2-dir') { args.phase2Dir = takeValue(rest, i, '--phase2-dir'); i++; }
    else if (a === '--target-urls') { args.targetUrls = takeValue(rest, i, '--target-urls'); i++; }
    else if (a === '--onto') { args.onto = takeValue(rest, i, '--onto'); i++; }
    else if (a === '--rebutter') { args.rebutter = takeValue(rest, i, '--rebutter'); i++; }
    else if (a === '--peer-view') { args.peerView = takeValue(rest, i, '--peer-view'); i++; }
    else if (a === '--out-dir') { args.outDir = takeValue(rest, i, '--out-dir'); i++; }
    else if (a === '--source-dir') { (args.sourceDirs ??= []).push(takeValue(rest, i, '--source-dir')); i++; }
    else if (a === '--packet') { args.packet = takeValue(rest, i, '--packet'); i++; }
    else if (a === '--seat') { args.seat = takeValue(rest, i, '--seat'); i++; }
    else if (a === '--checklist') {
      const name = takeValue(rest, i, '--checklist');
      if (!CHECKLIST_NAME_RE.test(name)) throw new RelayError(`--checklist "${name}" must be 2-16 upper-case letters or digits starting with a letter (e.g. CHK)`);
      (args.checklist ??= []).push(name);
      i++;
    }
    else if (a === '--file') { args.file = takeValue(rest, i, '--file'); i++; }
    else if (a === '--match-heading') { args.matchHeading = takeValue(rest, i, '--match-heading'); i++; }
    else if (a === '--match-line') { (args.matchLines ??= []).push(takeValue(rest, i, '--match-line')); i++; }
    else if (a === '--match-line-file') { (args.matchLines ??= []).push({ file: takeValue(rest, i, '--match-line-file') }); i++; }
    else if (a === '--with') { (args.withs ??= []).push(takeValue(rest, i, '--with')); i++; }
    else if (a === '--with-result') { args.withResult = takeValue(rest, i, '--with-result'); i++; }
    else if (a === '--breakdown-out') { args.breakdownOut = takeValue(rest, i, '--breakdown-out'); i++; }
    else if (a === '--audit-depth') {
      args.auditDepth = takeValue(rest, i, '--audit-depth');
      if (args.auditDepth !== 'light' && args.auditDepth !== 'full') throw new RelayError('--audit-depth must be light or full');
      i++;
    }
    else throw new RelayError(`unknown argument "${a}"`);
  }
  if (sub === 'splice') {
    // Several --match-line/--with pairs, matched by order, fix several leaked lines in one atomic write.
    if ((args.matchLines?.length ?? 0) > 1 || (args.withs?.length ?? 0) > 1) {
      if (args.matchHeading !== undefined || args.withResult !== undefined || args.matchLines?.length !== args.withs?.length) {
        throw new RelayError('splice with several --match-line values needs exactly one --with per --match-line, in the same order, and no --match-heading or --with-result');
      }
      args.pairs = args.matchLines.map((line, k) => ({ line, with: args.withs[k] }));
    }
    if (args.matchLines !== undefined) { if (!args.pairs) args.matchLine = args.matchLines[0]; delete args.matchLines; }
    if (args.withs !== undefined) { if (!args.pairs) args.with = args.withs[0]; delete args.withs; }
    const allowed = new Set(['sub', 'file', 'matchHeading', 'matchLine', 'with', 'withResult', 'pairs']);
    const extra = Object.keys(args).filter((k) => !allowed.has(k));
    if (extra.length > 0) throw new RelayError('splice accepts only --file, --match-heading or --match-line or --match-line-file, and --with or --with-result');
    if (!args.file) throw new RelayError('splice requires --file');
    if (args.pairs) return args;
    if ((args.matchHeading === undefined) === (args.matchLine === undefined)) throw new RelayError('splice requires exactly one of --match-heading and --match-line (or --match-line-file)');
    if ((args.with === undefined) === (args.withResult === undefined)) throw new RelayError('splice requires exactly one of --with and --with-result');
    if (args.matchHeading !== undefined && !/^#{1,6} \S/.test(args.matchHeading)) throw new RelayError('--match-heading must be a Markdown heading start such as "## A3"');
    return args;
  }
  for (const [key, flag] of [['file', '--file'], ['matchHeading', '--match-heading'], ['matchLines', '--match-line'], ['withs', '--with'], ['withResult', '--with-result']]) {
    if (args[key] !== undefined) throw new RelayError(`${flag} is only accepted by splice`);
  }
  if (sub === 'scorecard') {
    const extra = Object.keys(args).filter((k) => !['sub', 'in', 'out', 'phase1Dir'].includes(k));
    if (extra.length > 0) throw new RelayError('scorecard accepts only --in, --out and --phase1-dir');
    if (!args.in) throw new RelayError('scorecard requires --in <findings.json>');
    return args;
  }
  if (args.seat !== undefined && sub !== 'validate') throw new RelayError('--seat is only accepted by validate');
  if (args.seat !== undefined && args.seat !== 'A' && args.seat !== 'B') throw new RelayError('--seat must be A or B');
  const newFlagOwners = {
    // validate accepts it too so one argument list works everywhere; it never checks P labels, so it has no effect there.
    checklist: ['--checklist', ['scan', 'append-rebuttals', 'audit-prep', 'translate', 'validate']],
    sourceDirs: ['--source-dir', ['scan', 'validate', 'append-rebuttals', 'audit-prep']],
    packet: ['--packet', ['audit-prep', 'validate']],
    phase2Dir: ['--phase2-dir', ['scan', 'audit-prep']],
    targetUrls: ['--target-urls', ['scan']],
    onto: ['--onto', ['append-rebuttals']],
    rebutter: ['--rebutter', ['append-rebuttals']],
    peerView: ['--peer-view', ['append-rebuttals']],
    outDir: ['--out-dir', ['audit-prep']],
    auditDepth: ['--audit-depth', ['translate']],
    breakdownOut: ['--breakdown-out', ['audit-prep']],
  };
  for (const [key, [flag, owners]] of Object.entries(newFlagOwners)) {
    if (args[key] !== undefined && !owners.includes(sub)) {
      throw new RelayError(`${flag} is only accepted by ${owners.join(' and ')}`);
    }
  }
  if (sub === 'append-rebuttals') {
    for (const [key, flag] of [['in', '--in'], ['onto', '--onto'], ['rebutter', '--rebutter'], ['peerView', '--peer-view']]) {
      if (!args[key]) throw new RelayError(`append-rebuttals requires ${flag}`);
    }
    if (args.rebutter !== 'A' && args.rebutter !== 'B') throw new RelayError('--rebutter must be A or B');
    for (const key of ['out', 'from', 'to', 'tokens', 'mapping', 'phase1Dir', 'verificationDir', 'forbidSeats']) {
      if (args[key] !== undefined) throw new RelayError('append-rebuttals accepts only --in, --onto, --rebutter, --peer-view, --target-dir, --source-dir');
    }
    return args;
  }
  if (sub === 'audit-prep') {
    for (const [key, flag] of [['phase1Dir', '--phase1-dir'], ['mapping', '--mapping'], ['outDir', '--out-dir'], ['targetDir', '--target-dir']]) {
      if (!args[key]) throw new RelayError(`audit-prep requires ${flag}`);
    }
    for (const key of ['in', 'out', 'from', 'to', 'verificationDir', 'forbidSeats']) {
      if (args[key] !== undefined) {
        throw new RelayError('audit-prep accepts only --phase1-dir, --mapping, --out-dir, --target-dir, --source-dir, --tokens, --phase2-dir, --packet, --breakdown-out');
      }
    }
    return args;
  }
  if (sub === 'relabel') {
    for (const req of ['in', 'out', 'from', 'to']) {
      if (!args[req]) throw new RelayError(`relabel requires --${req}`);
    }
    if (!/^[A-Z]$/.test(args.from) || !/^[A-Z]$/.test(args.to)) {
      throw new RelayError('--from and --to must each be a single letter (A, B, P, X, Y, ...)');
    }
    if (args.from === args.to) {
      throw new RelayError('--from and --to must differ; an identity relabel is never a real request and reports false success');
    }
    if (args.tokens !== undefined) throw new RelayError('--tokens is only accepted by scan');
    if (args.mapping !== undefined || args.verificationDir !== undefined || args.forbidSeats !== undefined) {
      throw new RelayError('--mapping and --verification-dir are only accepted by translate; --forbid-seats is only accepted by scan (with --phase1-dir)');
    }
  } else if (sub === 'scan') {
    if (!args.in) throw new RelayError('scan requires --in');
    if (args.mapping !== undefined || args.verificationDir !== undefined) {
      throw new RelayError('--mapping and --verification-dir are only accepted by translate');
    }
    if ((args.phase1Dir === undefined) !== (args.forbidSeats === undefined)) {
      throw new RelayError('scan requires --phase1-dir and --forbid-seats together, or neither');
    }
    if (args.forbidSeats !== undefined) {
      const seats = args.forbidSeats.split(',');
      if (seats.length === 0 || !seats.every((s) => /^[A-Z]$/.test(s))) {
        throw new RelayError('--forbid-seats must be a comma-separated list of single uppercase letters (e.g. "A" or "A,B")');
      }
    }
  } else if (sub === 'flip') {
    if (!args.out) throw new RelayError('flip requires --out');
    if (args.tokens !== undefined) throw new RelayError('--tokens is only accepted by scan');
    if (args.mapping !== undefined || args.phase1Dir !== undefined || args.verificationDir !== undefined || args.forbidSeats !== undefined) {
      throw new RelayError('--mapping and --verification-dir are only accepted by translate; --phase1-dir and --forbid-seats are only accepted by scan');
    }
  } else if (sub === 'translate') {
    for (const req of ['in', 'out', 'mapping']) {
      if (!args[req]) throw new RelayError(`translate requires --${req}`);
    }
    if (args.tokens !== undefined) throw new RelayError('--tokens is only accepted by scan');
    if (args.forbidSeats !== undefined) throw new RelayError('--forbid-seats is only accepted by scan');
    if (args.from !== undefined || args.to !== undefined) {
      throw new RelayError('--from and --to are only accepted by relabel');
    }
  } else if (sub === 'validate') {
    if (!args.phase1Dir) throw new RelayError('validate requires --phase1-dir');
    if (
      args.in !== undefined || args.out !== undefined || args.from !== undefined ||
      args.to !== undefined || args.tokens !== undefined ||
      args.mapping !== undefined || args.verificationDir !== undefined || args.forbidSeats !== undefined
    ) {
      throw new RelayError('validate accepts only --phase1-dir, --seat, --target-dir and --source-dir');
    }
  }
  return args;
}

// Shared by relabel and scan so they can't disagree: a ``` is a fence delimiter only at line start.
// CommonMark fence rules: an opening fence is a run of >=3 of the SAME character (backtick or
// tilde); a closing fence must use the SAME character and be at least as long as the opening
// run. A ``` line inside a ~~~-opened block (or vice versa) is ordinary fenced CONTENT, not a
// delimiter -- this is the exact class of bug a boolean "any ``` toggles" tracker cannot express.
// A fence is an EXEMPTION from the blind, so over-accepting indentation is the unsafe
// direction -- it hides real prose, not just code. CommonMark caps leading whitespace at
// <=3 spaces; a tab or 4+ spaces is indented code, not a fence.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;


function parseFenceLines(text) {
  // Every line-anchored regex in this file (seat headers, rebuttal headings, claim headings,
  // field lines) ends in a bare `$`, which cannot match past a trailing `\r` left by splitting
  // CRLF text on '\n' alone -- `.` does not consume `\r`, so `$` (true end-of-string, no `m`
  // flag) is unreachable. Stripping `\r` here, once, fixes every caller at once instead of
  // patching each regex. A single file-level eol guess is wrong for a mixed-terminator file
  // (e.g. a CRLF tool's output pasted into an otherwise-LF fenced Evidence block) -- each line
  // records its OWN terminator instead, so a caller reassembling text reproduces exactly what
  // was there, never upgrading or downgrading a line's real ending.
  const pieces = stripBom(text).split('\n');
  let open = null; // { char, len } while inside a fence, else null
  const lines = pieces.map((raw, i) => {
    // The last piece has no following '\n', so a trailing \r there (if any) is real content,
    // not half of a \r\n pair -- only a non-last piece's trailing \r is provably a line ending.
    const isLast = i === pieces.length - 1;
    const hasCR = !isLast && raw.endsWith('\r');
    const line = hasCR ? raw.slice(0, -1) : raw;
    const eol = isLast ? '' : hasCR ? '\r\n' : '\n';
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(line);
      // A backtick-fenced opening line must not itself contain a backtick after the fence run
      // (CommonMark: an info string on a backtick fence can't contain a backtick).
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        open = { char: m[1][0], len: m[1].length };
        return { text: line, inFence: true, eol, isOpen: true, isClose: false };
      }
      return { text: line, inFence: false, eol, isOpen: false, isClose: false };
    }
    const closeRe = new RegExp(`^ {0,3}(?:${open.char === '`' ? '`' : '~'}{${open.len},})\\s*$`);
    const isClose = closeRe.test(line);
    if (isClose) open = null;
    return { text: line, inFence: true, eol, isOpen: false, isClose };
  });
  return { lines, unterminated: open !== null };
}

// Counts backslashes immediately preceding index i in line; odd means the character at i is
// backslash-escaped (an escape itself can be escaped: \\\` -> the backslash is escaped, leaving
// the backtick unescaped, hence parity, not a bare "is the previous char a backslash" check).
function precedingBackslashParity(line, i) {
  let n = 0;
  let j = i - 1;
  while (j >= 0 && line[j] === '\\') { n++; j--; }
  return n % 2;
}

// Splits one line into {code, text} spans on inline code spans. CommonMark: a run of N
// backticks opens a span that closes at the next run of EXACTLY N backticks; a run with no
// matching close is literal text, not code. A fenced line (whole line is code) is returned as a
// single code span. Per CommonMark 6.1, backslash escapes work on ordinary prose punctuation
// (an escaped backtick is literal, not a delimiter) but NOT inside an already-open code span --
// so escape-awareness applies only to the OPENING delimiter search below, never to the closing
// search (closeRe), which must keep matching a literal backtick run as span content regardless
// of a preceding backslash.
function splitLineSpans(line, inFence) {
  if (inFence) return [{ code: true, text: line }];
  const spans = [];
  const runRe = /`+/g;
  let last = 0;
  let m;
  while ((m = runRe.exec(line)) !== null) {
    if (m.index < last) continue; // consumed by an earlier matched span
    if (precedingBackslashParity(line, m.index) === 1) {
      // The first backtick of this run is escaped literal punctuation, not a delimiter. Only
      // that one backtick is consumed by the escape; the remainder of the run (if any) is a
      // fresh, unconsumed run of backticks that can still open/close a span on its own, so
      // resume the search right after the escaped backtick rather than skipping the whole run.
      runRe.lastIndex = m.index + 1;
      continue;
    }
    const openLen = m[0].length;
    const closeRe = new RegExp('(?<!`)`{' + openLen + '}(?!`)', 'g');
    closeRe.lastIndex = runRe.lastIndex;
    const closeMatch = closeRe.exec(line);
    if (!closeMatch) continue; // unmatched run: literal text, scan continues past it
    if (m.index > last) spans.push({ code: false, text: line.slice(last, m.index) });
    const spanEnd = closeMatch.index + openLen;
    spans.push({ code: true, text: line.slice(m.index, spanEnd) });
    last = spanEnd;
    runRe.lastIndex = spanEnd;
  }
  if (last < line.length || spans.length === 0) spans.push({ code: false, text: line.slice(last) });
  return spans;
}

// Flat {code, text} parts in reading order; a '\n' entry sits between lines.
function splitProseAndCode(text) {
  const { lines } = parseFenceLines(text);
  const parts = [];
  lines.forEach(({ text: line, inFence }, i) => {
    parts.push(...splitLineSpans(line, inFence));
    if (i < lines.length - 1) parts.push({ code: false, text: '\n' });
  });
  return parts;
}

// The real claim IDs for one letter: "## L<n>" / "### L<n>" headings and "Claim: L<n>" lines,
// raw line, fence-skipped. Only these are rewritten, so a product name like A100 survives.
function realClaimIds(text, letter) {
  const { lines } = parseFenceLines(text);
  const re = new RegExp(`^(?:#{2,3}\\s+|Claim:\\s*)(${letter}\\d+)\\b`);
  const ids = new Set();
  for (const { text: line, inFence } of lines) {
    if (inFence) continue;
    const m = re.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Matches exactly the ids in the set as whole words; null when the set is empty.
function buildClaimIdRe(ids) {
  if (ids.size === 0) return null;
  const alt = [...ids].map(escapeRegExp).join('|');
  return new RegExp(`\\b(${alt})\\b`, 'g');
}

function relabelText(text, from, to, extraIds = [], checklist = []) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely relabel past it, fix the file and re-run');
  }
  const claimId = buildClaimIdRe(new Set([...realClaimIds(text, from), ...extraIds]));
  const seatHeader = new RegExp(`^# Seat ${from} findings.*$`);
  const newSeatHeader = to === 'P' ? '# Peer findings' : `# Seat ${to} findings`;
  const rebuttalHeading = /^## Rebuttals \(from ([A-Z])\) of ([A-Z]) claims$/;

  // seatHeader/rebuttalHeading are structural, line-start properties, same as a Markdown "##"
  // heading -- test them against the RAW line first (fence-skip only, no span-stripping), same
  // principle as extractClaimHeadings/parseVerificationFile. A per-span test would make
  // "`x`# Seat A findings" match, since the non-code span's own text is just "# Seat A findings"
  // -- a real Markdown renderer never treats that as a heading, since the preceding code span
  // still occupies the start of the line.
  const relabeledLines = lines.map(({ text: line, inFence, eol }) => {
    if (!inFence) {
      if (seatHeader.test(line)) return newSeatHeader + eol;
      const rebuttalMatch = rebuttalHeading.exec(line);
      if (rebuttalMatch) {
        const [, fromLetter, ofLetter] = rebuttalMatch;
        const newFrom = fromLetter === from ? to : fromLetter;
        const newOf = ofLetter === from ? to : ofLetter;
        return `## Rebuttals (from ${newFrom}) of ${newOf} claims` + eol;
      }
    }
    const rewrite = (t) => t.replace(claimId, (id) => `${to}${id.slice(1)}`);
    return (
      splitLineSpans(line, inFence)
        .map((span) => {
          if (span.code || claimId === null) return span.text;
          // "CHK-P1" names an outside checklist item, so P -> peer letter must leave it alone.
          return from === 'P' ? outsideChecklistLabels(span.text, rewrite, checklist) : rewrite(span.text);
        })
        .join('') + eol
    );
  });
  return relabeledLines.join('');
}

function outsideChecklistLabels(text, fn, checklist = []) {
  const re = checklistLabelRe(checklist);
  if (re === null) return fn(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

const VENDOR_TOKENS = ['claude', 'anthropic', 'codex', 'openai', 'gpt-', 'opencode', 'fable', 'opus', 'sonnet', 'haiku', 'sendmessage', 'spawn_agent'];
// A token glued to -._/ (codex-dispatch.mjs, gpt-5.6-sol) is a filename/model ID, not self-reference.
const FIRST_PERSON = String.raw`\b(?:I|I'm|I've|I am|me|my|myself|we|our)\b`;
const VENDOR_TOKEN_ALT = String.raw`(?:\b(?:claude|anthropic|codex|openai|opencode|fable|opus|sonnet|haiku)\b(?![-._/])|\bgpt-[\w.]+)`;
// Not in VENDOR_TOKENS: that list also drives the filename scan, where "seat" false-positives.
// [ABab]: lowercase "seat a"/"reviewer a" hard-stops too; "gives the reviewer a chance" is a
// known, accepted false positive (one redaction round) -- see blind-relabel.test.mjs.
// The run's own seat-lettered file and folder names (A-findings.md, brief-A.txt, phase1/A/) name a seat as well; a
// folder counts only with its trailing separator, so prose such as "phase2/B drops the index" is not a hit.
const SEAT_FILE_RE =
  String.raw`\b[AB]-(?:findings|rebuttals-raw)\.md\b|\b(?:delta-)?brief-[AB]\.txt\b|\bprompt-[AB]\.txt\b|\bpeer-view-for-[AB]\.md\b|\bredact-[AB][\\/]|\bphase[12][\\/][AB][\\/]`;
const SEAT_TOKEN_RE =
  String.raw`\b[Ss]eat[\s-]*[ABab]\b|\b[Rr]eviewer[\s-]*[ABab]\b|\b[ABab]-(?:side[\s-]+)?(?:[Ss]eat|[Rr]eviewer)\b|${SEAT_FILE_RE}`;
const SEAT_FIRST_PERSON = String.raw`\b(?:I|I'm|I've|I am|[Mm]e|[Mm]y|[Mm]yself|[Ww]e|[Oo]ur)\b`;
// Sentence-scoped, not char-capped: a seat letter has no legitimate third-person use.
const SEAT_SELF_ID_RE = new RegExp(
  `${SEAT_FIRST_PERSON}[^.\\n]*(?:${SEAT_TOKEN_RE})|(?:${SEAT_TOKEN_RE})[^.\\n]*${SEAT_FIRST_PERSON}`
);
const SEAT_MENTION_RE = new RegExp(SEAT_TOKEN_RE);
// Uppercase only on purpose: a target's own false-positive prose (e.g. "gives the reviewer
// a chance") must not unlock the seatVocabulary exemption for every seat mention against it.
const SEAT_VOCAB_RE =
  String.raw`\b[Ss]eat[\s-]*[AB]\b|\b[Rr]eviewer[\s-]*[AB]\b|\b[AB]-(?:side[\s-]+)?(?:[Ss]eat|[Rr]eviewer)\b`;
const SEAT_VOCAB_MENTION_RE = new RegExp(SEAT_VOCAB_RE);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// \b only on a side that starts/ends with a word char, or "gpt-5.6-sol" also matches
// inside "gpt-5.6-solaris".
function buildExtraTokenAlt(tokens) {
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => {
      const esc = escapeRegExp(t);
      const lead = /^\w/.test(t) ? '\\b' : '';
      const trail = /\w$/.test(t) ? '\\b' : '';
      return `${lead}${esc}${trail}`;
    })
    .join('|');
}

function buildSelfIdRe(extraTokens = []) {
  const extraAlt = buildExtraTokenAlt(extraTokens);
  const vendorAlt = extraAlt ? `(?:${VENDOR_TOKEN_ALT}|${extraAlt})` : VENDOR_TOKEN_ALT;
  // The gap stops at a sentence end, but a dot inside a version number ("5.4/5.5 I") does not end it.
  const gap = String.raw`(?:[^.\n]|\.(?=\d)){0,40}`;
  return new RegExp(`${FIRST_PERSON}${gap}${vendorAlt}|${vendorAlt}${gap}${FIRST_PERSON}`, 'i');
}

function parseTokensArg(raw) {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

// Word-boundary matchers (buildExtraTokenAlt's shape) keyed by lowercased token, so "affable"
// never hits "fable". No self-ID lookahead: "codex-dispatch.mjs" still counts as a mention.
function buildTokenMatchers(extraTokens = []) {
  const all = [...new Set([...VENDOR_TOKENS, ...extraTokens.map((t) => t.toLowerCase())])];
  return all.map((t) => ({ token: t, re: new RegExp(buildExtraTokenAlt([t]), 'i') }));
}

function matchedTokens(text, matchers) {
  return matchers.filter((m) => m.re.test(text)).map((m) => m.token);
}

const WALK_SKIP_DIRS = new Set(['.git', 'node_modules']);

// Git targets: tracked + untracked-not-ignored names only, so a branch ref under .git/ or an
// ignored install tree never exempts a token. Returns null when targetDir is not in a work tree; a repository git refuses to
// open is an error, not a plain folder whose every file would be target text.
function gitListedNames(targetDir) {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { windowsHide: true, cwd: targetDir, encoding: 'utf8', env: { ...process.env, ...GIT_C_LOCALE } });
  if (probe.error) throw new RelayError(`--target-dir: git could not run in ${targetDir}: ${probe.error.message}`);
  let inside;
  try {
    inside = gitRepoFromProbe({ code: probe.status, stdout: probe.stdout, stderr: probe.stderr }, targetDir);
  } catch (err) {
    throw new RelayError(`--target-dir: ${err.message}`);
  }
  if (!inside) return null;
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { windowsHide: true,
    cwd: targetDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new RelayError(`--target-dir: git ls-files failed in ${targetDir}: ${r.error ? r.error.message : r.stderr.trim()}`);
  }
  return r.stdout.split('\0').filter((e) => e.length > 0);
}

async function walkNames(root, rel = '') {
  const out = [];
  const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const d of dirents) {
    const relPath = rel ? path.join(rel, d.name) : d.name;
    if (d.isDirectory()) {
      if (WALK_SKIP_DIRS.has(d.name)) continue;
      out.push(relPath, ...(await walkNames(root, relPath)));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

// seatVocabulary is a SEPARATE exemption from the vendor-token Set: it is content-based (does
// the target's own docs use "seat A"/"reviewer A" prose?), never name-based, since seat letters
// are single characters and would false-positive constantly if checked against filenames the
// way vendor tokens are. Only true when the target IS a review protocol like this one -- for
// any other target, a seat mention has no legitimate reason to appear and always hard-stops.
async function targetDerivedTokens(targetDir, extraTokens = []) {
  if (!targetDir) return { tokens: new Set(), seatVocabulary: false };
  const found = new Set();
  const matchers = buildTokenMatchers(extraTokens);
  const check = (name) => {
    for (const t of matchedTokens(name, matchers)) found.add(t);
  };
  let entries = [];
  try {
    entries = gitListedNames(targetDir) ?? (await walkNames(targetDir));
  } catch (err) {
    if (err instanceof RelayError) throw err;
    log(`--target-dir: could not list ${targetDir} (${err.message}); no token is target-derived`);
    return { tokens: found, seatVocabulary: false };
  }
  for (const e of entries) check(e);
  let seatVocabulary = false;
  const docPaths = entries.filter((e) => /(^|[\\/])(SKILL\.md|references[\\/].*\.md)$/i.test(e));
  for (const docPath of docPaths) {
    try {
      const content = await fs.readFile(path.join(targetDir, docPath), 'utf8');
      check(content);
      if (SEAT_VOCAB_MENTION_RE.test(content)) {
        seatVocabulary = true;
      }
    } catch (err) {
      log(`--target-dir: skipped unreadable ${docPath}: ${err.message}`);
    }
  }
  return { tokens: found, seatVocabulary };
}

const TARGET_TEXT_MAX_BYTES = 2 * 1024 * 1024;

// Per-user folder: a shared /tmp must not let another user read the target text or plant a cache
// entry that widens the target-derived exemption. SKILLARRAY_EXEMPT_CACHE_DIR overrides it (tests).
function exemptCacheDir() {
  if (process.env.SKILLARRAY_EXEMPT_CACHE_DIR) return process.env.SKILLARRAY_EXEMPT_CACHE_DIR;
  let who = 'user';
  try {
    who = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
  } catch {
    // No user info: the ownership check below still guards the folder.
  }
  return path.join(os.tmpdir(), `skillarray-exempt-cache-${who.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

// The cache is used only from a real directory (not a link) that this user owns and that no one else
// can read or write (POSIX); on Windows the per-user temp folder already gives that.
async function usableCacheDir(create) {
  const dir = exemptCacheDir();
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = await fs.lstat(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) return null;
  return dir;
}

function sha256File(file) {
  return fs.readFile(file).then((buf) => crypto.createHash('sha256').update(buf).digest('hex'));
}

// Identifies the target's content without reading every file: size, mtime and ctime of every listed
// file (ctime changes on any write and, unlike mtime, cannot be set back by cp -p, tar or utimes;
// git's own status can miss such an edit), plus, for git, HEAD, the status list and the bytes of every
// file git reports as changed or untracked. null means no caching.
async function contentKey(targetDir, entries) {
  const parts = [path.resolve(targetDir)];
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: targetDir, encoding: 'utf8' });
  if (!head.error && head.status === 0) {
    const st = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { windowsHide: true,
      cwd: targetDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    if (st.error || st.status !== 0) return null;
    const prefix = spawnSync('git', ['rev-parse', '--show-prefix'], { windowsHide: true, cwd: targetDir, encoding: 'utf8' }).stdout?.replace(/\r?\n$/, '') ?? '';
    parts.push(head.stdout.trim(), st.stdout);
    // Status paths are repo-root relative; entries (ls-files in targetDir) are targetDir relative.
    // A rename or copy record ("R  new", "C  new") is followed by a bare record holding the old path.
    const changed = [];
    const records = st.stdout.split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.length <= 3) continue;
      if (/[RC]/.test(rec.slice(0, 2))) i++;
      const p = rec.slice(3);
      if (p.startsWith(prefix)) changed.push(p.slice(prefix.length));
    }
    for (const rel of [...new Set(changed)].sort()) {
      const full = path.join(targetDir, rel);
      // Files the target text skips (over the size cap) are keyed by size/mtime/ctime below, not hashed.
      const size = await fs.stat(full).then((s) => s.size).catch(() => -1);
      parts.push(`${rel}:${size < 0 ? 'missing' : size > TARGET_TEXT_MAX_BYTES ? 'large' : await sha256File(full).catch(() => 'unreadable')}`);
    }
  }
  for (const rel of [...entries].sort()) {
    try {
      const s = await fs.stat(path.join(targetDir, rel));
      parts.push(`${rel}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
    } catch {
      parts.push(`${rel}:missing`);
    }
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Keeps one entry per target (the current one) and drops anything older than a week, so a review
// does not leave a growing pile of full target copies behind.
async function pruneCache(dir, targetTag, keep) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    if (n === keep || !n.endsWith('.txt')) continue;
    const full = path.join(dir, n);
    try {
      const old = now - (await fs.stat(full)).mtimeMs > CACHE_MAX_AGE_MS;
      if (n.startsWith(`${targetTag}-`) || old) await fs.rm(full, { force: true });
    } catch {
      // Removed by a concurrent command: nothing to do.
    }
  }
}

// Deletes this user's whole exemption cache (the run's cleanup step). Returns the number of entries removed.
async function clearExemptCache() {
  const dir = await usableCacheDir(false);
  if (!dir) return 0;
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.txt') || n.endsWith('.tmp'));
  for (const n of names) await fs.rm(path.join(dir, n), { force: true });
  return names.length;
}

// Every text file in the target (same file set as targetDerivedTokens), joined; null without --target-dir.
// Cached across commands, keyed by contentKey, since a run calls scan/validate/append-rebuttals/
// audit-prep several times and a large repository takes seconds to read.
async function readTargetText(targetDir, flag = '--target-dir') {
  if (!targetDir) return null;
  let entries;
  try {
    entries = gitListedNames(targetDir) ?? (await walkNames(targetDir));
  } catch (err) {
    if (err instanceof RelayError) throw err;
    log(`${flag}: could not list ${targetDir} (${err.message}); no claim-ID hit is target-derived`);
    return '';
  }
  const key = await contentKey(targetDir, entries).catch(() => null);
  const targetTag = crypto.createHash('sha256').update(path.resolve(targetDir).toLowerCase()).digest('hex').slice(0, 16);
  const name = key ? `${targetTag}-${key}.txt` : null;
  const readDir = name ? await usableCacheDir(false) : null;
  if (readDir) {
    try {
      return await fs.readFile(path.join(readDir, name), 'utf8');
    } catch {
      // Cache miss: read the target below.
    }
  }
  const text = await readTargetTextUncached(targetDir, entries, flag);
  if (name) {
    try {
      const dir = await usableCacheDir(true);
      if (!dir) {
        log(`${flag}: cache folder ${exemptCacheDir()} is not a private directory owned by this user; not caching`);
      } else {
        await writeFileAtomic(path.join(dir, name), text, 0o600);
        await pruneCache(dir, targetTag, name);
      }
    } catch (err) {
      log(`${flag}: could not cache target text (${err.message}); continuing without the cache`);
    }
  }
  return text;
}

async function readTargetTextUncached(targetDir, entries, flag) {
  const parts = [];
  for (const rel of entries) {
    const full = path.join(targetDir, rel);
    try {
      const st = await fs.stat(full);
      if (!st.isFile() || st.size > TARGET_TEXT_MAX_BYTES) continue;
      const content = await fs.readFile(full, 'utf8');
      if (!content.includes('\0')) parts.push(content);
    } catch (err) {
      log(`${flag}: skipped unreadable ${rel}: ${err.message}`);
    }
  }
  return parts.join('\n');
}

// Text for the claim-ID/peer-label exemption: --target-dir plus every --source-dir (other repos the
// packet quotes). --source-dir never widens the vendor-token or seat-vocabulary exemptions.
async function readExemptText(targetDir, sourceDirs = []) {
  if (!targetDir && sourceDirs.length === 0) return null;
  const parts = [];
  if (targetDir) parts.push(await readTargetText(targetDir));
  for (const dir of sourceDirs) {
    let st = null;
    try {
      st = await fs.stat(dir);
    } catch (err) {
      throw new RelayError(`--source-dir: ${dir} is not readable: ${err.message}`);
    }
    if (!st.isDirectory()) throw new RelayError(`--source-dir: ${dir} is not a directory`);
    parts.push(await readTargetText(dir, '--source-dir'));
  }
  return parts.join('\n');
}

const CHUNK_TRIM_RE = /^[>`*_[\](){}"',.;:!?]+|[>`*_[\](){}"',.;:!?]+$/g;

// True when the token at [index, index+len) is embedded in a larger chunk the target contains
// verbatim, or its whole line (20+ chars, quote markers/backticks stripped) is target text.
function targetDerivedOccurrence(line, index, len, targetText) {
  if (!targetText) return false;
  let start = index;
  let end = index + len;
  while (start > 0 && !/\s/.test(line[start - 1])) start--;
  while (end < line.length && !/\s/.test(line[end])) end++;
  const chunk = line.slice(start, end).replace(CHUNK_TRIM_RE, '');
  if (chunk.length > len && targetText.includes(chunk)) return true;
  const stripped = line.replace(/^[\s>]+/, '').replace(/^`+|`+$/g, '').trim();
  return stripped.length >= 20 && targetText.includes(stripped);
}

// A hit on `id` in `line` is target-derived only when EVERY occurrence of it on that line is.
function targetDerivedHit(line, id, targetText) {
  if (!targetText) return false;
  const re = new RegExp(`\\b${escapeRegExp(id)}\\b`, 'g');
  let m;
  let any = false;
  while ((m = re.exec(line)) !== null) {
    any = true;
    if (!targetDerivedOccurrence(line, m.index, id.length, targetText)) return false;
  }
  return any;
}

// Unlike the vendor/seat scan below (which blanks fenced lines -- a fence is real Evidence
// content, exempt from THAT check by design), a real claim-ID leak is exactly as dangerous inside
// a fence as outside it: "my A4" inside an Evidence block tells the auditor which anonymous label
// maps to which real seat just as directly as it would in prose. relabelText/scan's fence-skip
// exists to protect genuine captured evidence content from being REWRITTEN or treated as
// identity-token prose, not to make a real claim-ID mention invisible -- see relabelText's own
// documented "never put a claim ID inside an Evidence fence" limitation this check closes. Scans
// the RAW, unmodified lines (fence content included) for each forbidden seat's own claim IDs,
// built from the actual enumerable set in that seat's real Phase 1 file via extractClaimHeadings
// -- never a generic \b[A-Z]\d+\b, which would false-positive on a legitimate target-code
// identifier, a hex digest, or a cell reference that happens to look like a claim ID.
async function scanForKnownClaimIdLeaks(text, phase1Dir, forbidSeats, targetText = null) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely scan past it, fix the file and re-run');
  }
  const forbiddenIds = new Set();
  for (const seat of forbidSeats) {
    for (const id of extractClaimHeadings(await readPhase1Seat(seat, phase1Dir))) forbiddenIds.add(id);
  }
  const hits = [];
  lines.forEach(({ text: line }, i) => {
    for (const id of forbiddenIds) {
      if (new RegExp(`\\b${id}\\b`).test(line)) {
        hits.push({ line: i + 1, text: line.trim(), id, targetDerived: targetDerivedHit(line, id, targetText) });
      }
    }
  });
  return hits;
}

const PEER_VIEW_FILES = ['peer-view-for-A.md', 'peer-view-for-B.md'];

// The "## P<n>" claim IDs a Phase 2 peer-view carries, raw line, fence-skipped.
function peerViewClaimIds(text) {
  const { lines } = parseFenceLines(text);
  const ids = new Set();
  for (const { text: line, inFence } of lines) {
    if (inFence) continue;
    const m = /^##\s+(P\d+)\b/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

async function readPhase2PeerIds(phase2Dir) {
  const ids = new Set();
  for (const name of PEER_VIEW_FILES) {
    const filePath = path.join(phase2Dir, name);
    let text;
    try {
      text = await readUtf8(filePath);
    } catch (err) {
      throw new RelayError(`--phase2-dir: could not read ${filePath}: ${err.message}`);
    }
    for (const id of peerViewClaimIds(text)) ids.add(id);
  }
  return ids;
}

// An outside checklist item written with a DECLARED checklist name in front ("CHK-P1", "CHK-P1–P3",
// the names given by --checklist) is not a Phase 2 label; a bare "P1", or one after any other word
// ("OK-P3"), still is. The range tail must follow directly ("CHK-P1-P3", no spaces).
const CHECKLIST_NAME_RE = /^[A-Z][A-Z0-9]{1,15}$/;

function checklistLabelRe(checklist) {
  if (!checklist || checklist.length === 0) return null;
  return new RegExp(`\\b(?:${checklist.map(escapeRegExp).join('|')})-P\\d+(?:[–-]P\\d+)?\\b`, 'g');
}

function maskChecklistLabels(line, checklist = []) {
  const re = checklistLabelRe(checklist);
  return re === null ? line : line.replace(re, (m) => ' '.repeat(m.length));
}

// A surviving Phase 2 label (e.g. "identified in P12") points at the other letter's claim 12,
// so it is a leak even inside a fence. Only P numbers that were real peer-view claims count.
function scanForPeerLabelLeaks(text, peerIds, targetText = null, checklist = []) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely scan past it, fix the file and re-run');
  }
  const hits = [];
  lines.forEach(({ text: line }, i) => {
    const scanLine = maskChecklistLabels(line, checklist);
    for (const tok of scanLine.match(/\bP\d+\b/g) || []) {
      if (peerIds.has(tok)) {
        // Masked line only finds tokens; the target-derived check needs the line as the target has it.
        hits.push({ line: i + 1, text: line.trim(), id: tok, targetDerived: targetDerivedHit(line, tok, targetText) });
      }
    }
  });
  return hits;
}

// Lowercase scheme/host (URL does this), drop the fragment and any trailing slash.
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null; // not a URL; each caller decides whether that is worth reporting
  }
  u.hash = '';
  return u.href.replace(/\/+$/, '');
}

const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;

async function readTargetUrls(filePath) {
  let text;
  try {
    text = await readUtf8(filePath);
  } catch (err) {
    throw new RelayError(`--target-urls: could not read ${filePath}: ${err.message}`);
  }
  const urls = new Set();
  for (const raw of text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)) {
    const n = normalizeUrl(raw);
    if (n === null) log(`--target-urls: skipped unparseable entry "${raw}"`);
    else urls.add(n);
  }
  return urls;
}

// Non-blocking: a cited URL that the target itself embeds is reported for the orchestrator
// to resolve (was it fetched?), fence content included.
function scanForTargetUrls(text, targetUrls) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.match(URL_IN_TEXT_RE) || []) {
      const n = normalizeUrl(m.replace(/[.,;:!?)\]]+$/, ''));
      if (n !== null && targetUrls.has(n)) hits.push({ line: i + 1, url: m });
    }
  });
  return hits;
}

// Hides the absolute spellings of the folders a review runs in: a vendor word in one of them (a
// sandbox temp folder named after the host tool) is not an identity claim. The rest of a path is still scanned.
function runPathMasker(dirs) {
  const spellings = new Set();
  for (const dir of dirs) {
    for (const abs of pathSpellingsOf(dir)) {
      const bare = abs.replace(/[\\/]+$/, '');
      if (bare.length > 1) for (const s of [bare, bare.replace(/\\/g, '/'), bare.replace(/\\/g, '\\\\')]) spellings.add(s);
    }
  }
  if (spellings.size === 0) return (line) => line;
  const escaped = [...spellings].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // A whole path part only: "C:/review/Open" must not hide the "AI" of "C:/review/OpenAI".
  const re = new RegExp(`(?:${escaped.join('|')})(?![A-Za-z0-9._-])`, process.platform === 'win32' ? 'gi' : 'g');
  return (line) => line.replace(re, '<path>');
}

// A target or source folder whose name holds a vendor word ("claude-code-plugins") is cited by that name in prose and
// in relative paths: the whole name is hidden like its absolute path (in another case only where the OS folds case). A
// name that is only the vendor word is not.
function folderNameMasker(dirs, matchers) {
  const names = [...new Set(dirs.map((d) => path.basename(path.resolve(d))))]
    .filter((name) => matchedTokens(name, matchers).length > 0 && !matchers.some((m) => m.token.toLowerCase() === name.toLowerCase()));
  if (names.length === 0) return (line) => line;
  const escaped = names.sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![A-Za-z0-9._-])(?:${escaped.join('|')})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, foldsCase() ? 'gi' : 'g');
  return (line) => line.replace(re, '<path>');
}

// targetText (the --target-dir text only, never --source-dir) lets a third-person vendor/model token
// pass when every occurrence sits inside a longer chunk quoted verbatim from the target ("GPT-5.4/5.5"
// in a quoted sentence), or its 20+ character line is target text. Self-identification never passes.
async function scanText(text, targetDir, extraTokens = [], targetText = null, maskDirs = [], sourceDirs = []) {
  const derived = await targetDerivedTokens(targetDir, extraTokens);
  const { lines: fenceLines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely scan past it, fix the file and re-run');
  }
  // Inline code is scanned like prose: "the `OpenAI` reviewer" is a leak. A span quoted from the
  // target stays exempt through the same target-derived checks as a prose quote.
  const mask = runPathMasker([targetDir, ...maskDirs, os.tmpdir()].filter(Boolean));
  const matchers = buildTokenMatchers(extraTokens);
  const maskNames = folderNameMasker([targetDir, ...sourceDirs].filter(Boolean), matchers);
  const lines = fenceLines.map(({ text: line, inFence }) => (inFence ? '' : maskNames(mask(line))));
  const selfIdRe = buildSelfIdRe(extraTokens);
  const selfIdHits = [];
  const identityHits = [];
  const otherHits = [];
  lines.forEach((line, i) => {
    const lineTokens = matchedTokens(line, matchers);
    const hasVendorToken = lineTokens.length > 0;
    const hasSeatMention = SEAT_MENTION_RE.test(line);
    if (!hasVendorToken && !hasSeatMention) return;
    if (selfIdRe.test(line) || SEAT_SELF_ID_RE.test(line)) {
      selfIdHits.push({ line: i + 1, text: line.trim() });
      return;
    }
    const undeclared = lineTokens.filter((t) => !derived.tokens.has(t));
    const seatLeak = hasSeatMention && !derived.seatVocabulary;
    if (undeclared.length > 0 && !seatLeak && targetText && undeclared.every((t) => vendorTokenQuoted(line, t, matchers, targetText))) {
      otherHits.push({ line: i + 1, text: line.trim(), targetDerived: true, quotedFromTarget: true });
      return;
    }
    if (undeclared.length > 0 || seatLeak) {
      identityHits.push({ line: i + 1, text: line.trim(), tokens: undeclared, seatMention: seatLeak });
      return;
    }
    otherHits.push({ line: i + 1, text: line.trim(), targetDerived: true });
  });
  return { selfIdHits, identityHits, otherHits };
}

function vendorTokenQuoted(line, token, matchers, targetText) {
  const m = matchers.find((x) => x.token === token);
  if (!m) return false;
  const re = new RegExp(m.re.source, 'gi');
  let any = false;
  for (const hit of line.matchAll(re)) {
    any = true;
    // Widen to the whole model word ("GPT-5.4", not just "GPT-"), so the bare name never counts as a
    // longer quoted chunk merely because the target contains it; only "GPT-5.4/5.5 calls" style quotes do.
    let start = hit.index;
    let end = hit.index + hit[0].length;
    while (start > 0 && /[\w.-]/.test(line[start - 1])) start--;
    while (end < line.length && /^(?:[\w-]|\.\w)/.test(line.slice(end, end + 2))) end++;
    if (!targetDerivedOccurrence(line, start, end - start, targetText)) return false;
  }
  return any;
}

function flipMapping() {
  const aToX = crypto.randomInt(2) === 0;
  return aToX ? { A: 'X', B: 'Y' } : { A: 'Y', B: 'X' };
}

// Both valid flipMapping() shapes, and only those -- a hand-edited or corrupted
// mapping file must fail closed, not be guessed at.
function invertSeatMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw new RelayError('mapping must be a JSON object with "A" and "B" keys');
  }
  const isValid =
    (mapping.A === 'X' && mapping.B === 'Y') || (mapping.A === 'Y' && mapping.B === 'X');
  if (!isValid) {
    throw new RelayError(
      `mapping must be exactly {"A":"X","B":"Y"} or {"A":"Y","B":"X"}, got ${JSON.stringify(mapping)}`
    );
  }
  return { [mapping.A]: 'A', [mapping.B]: 'B' };
}

const AUDIT_ID_RE = /\b([XY])(\d+)\b/g;

function translateId(value, auditToSeat) {
  if (typeof value !== 'string') return value;
  return value.replace(AUDIT_ID_RE, (m, letter, digits) => `${auditToSeat[letter]}${digits}`);
}

// Only structured ID fields are rewritten; every other string (summary, recommended_fix, title,
// priority, suggested_fix, evidence, ...) is copied verbatim, so a literal X11 is never corrupted.
function translateStructuredIds(parsed, auditToSeat) {
  const out = structuredClone(parsed);
  for (const f of out.findings) {
    if (!f || typeof f !== 'object') continue;
    f.id = translateId(f.id, auditToSeat);
    if (Array.isArray(f.origins)) f.origins = f.origins.map((o) => translateId(o, auditToSeat));
    if (f.basis_from !== undefined) f.basis_from = translateId(f.basis_from, auditToSeat);
    for (const key of ['peer_responses', 'verifications']) {
      if (!Array.isArray(f[key])) continue;
      for (const entry of f[key]) {
        if (entry && typeof entry === 'object') entry.claim = translateId(entry.claim, auditToSeat);
      }
    }
  }
  return out;
}

const STRUCTURED_ID_PATHS = [
  /^findings\.\d+\.(?:id|basis_from)$/,
  /^findings\.\d+\.origins\.\d+$/,
  /^findings\.\d+\.(?:peer_responses|verifications)\.\d+\.claim$/,
];
const EVIDENCE_PATH_RE = /^findings\.\d+\.(?:evidence(?:\.\d+)?|auditor_check\.evidence|verifications\.\d+\.evidence)$/;
const P_TOKEN_RE = /\bP\d+\b/;

// Since prose is never rewritten, an anonymous claim ID of this run (or a stale Phase 2 P<n>)
// left in prose would ship unresolved in findings.json -- refuse instead. Evidence is exempt.
function assertNoAnonymousIdsInProse(parsed, anonIds, checklist = []) {
  const walk = (value, keyPath) => {
    if (typeof value === 'string') {
      const joined = keyPath.join('.');
      if (STRUCTURED_ID_PATHS.some((re) => re.test(joined)) || EVIDENCE_PATH_RE.test(joined)) return;
      const anon = (value.match(AUDIT_ID_RE) || []).find((t) => anonIds.has(t));
      const pTok = P_TOKEN_RE.exec(maskChecklistLabels(value, checklist));
      const hit = anon ?? (pTok ? pTok[0] : null);
      if (hit !== null) {
        throw new RelayError(
          `prose field "${joined}" contains "${hit}", ${anon ? "an anonymous claim ID of this run" : 'a Phase 2 peer label'} -- ` +
            'prose fields are copied verbatim (never ID-rewritten), so this would publish an unresolved ' +
            'label; cite claims only in origins/peer_responses/verifications and re-run the auditor output'
        );
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...keyPath, String(i)]));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, [...keyPath, k]);
    }
  };
  walk(parsed, []);
}

async function anonymousOriginIds(parsed, mapping, phase1Dir) {
  const ids = new Set();
  for (const f of parsed.findings) {
    for (const o of (f && Array.isArray(f.origins) ? f.origins : [])) {
      if (typeof o === 'string' && /^[XY]\d+$/.test(o)) ids.add(o);
    }
  }
  if (phase1Dir) {
    for (const seat of ['A', 'B']) {
      for (const id of extractClaimHeadings(await readPhase1Seat(seat, phase1Dir))) {
        ids.add(`${mapping[seat]}${id.slice(1)}`);
      }
    }
  }
  return ids;
}

const REAL_CLAIM_ID_RE = /^[AB]\d+$/;
const FINDING_ID_RE = /^F\d+$/;

// The exact enums review-protocol.md defines, so an auditor emitting a value outside
// them (a hallucinated state, a typo) is refused rather than published -- same class
// of gap --phase1-dir closes for a hallucinated claim ID.
const SEVERITY_VALUES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const BASIS_VALUES = new Set(['EXECUTED', 'STATIC_TRACE', 'SOURCE_CITATION', 'INFERENCE']);
const EVIDENCE_STRENGTH_VALUES = new Set(['REPRODUCED', 'DETERMINISTIC', 'SUPPORTED', 'PLAUSIBLE', 'SPECULATIVE']);
const COUNTER_FACT_MAX = 240;
const PEER_RESPONSE_VALUES = new Set(['unaddressed', 'conceded', 'disputed-no-counter-fact', 'disputed-with-counter-fact']);
const FINAL_STATE_VALUES = new Set([
  'settled-agree', 'settled-refuted', 'unresolved-low-stakes', 'unresolved-high-stakes',
  'dropped-speculative',
]);
const VERIFICATION_VERDICT_VALUES = new Set(['CONFIRMED', 'REFUTED', 'INCONCLUSIVE']);
const AUDITOR_CHECK_RESULT_VALUES = new Set(['CONFIRMED', 'REFUTED', 'INCONCLUSIVE', 'NOT_CHECKED']);

function assertEnum(value, allowed, field, findingId) {
  if (!allowed.has(value)) {
    throw new RelayError(
      `finding "${findingId}" has ${field} "${value}", not one of: ${[...allowed].join(', ')}`
    );
  }
}

// Column-0 strict on purpose, unlike the fence regex above: CommonMark also permits <=3 leading
// spaces on an ATX heading, but an indented "## A1" failing to register as a claim heading is
// fail-closed (missing claim -> refused, not a leak), so schema strictness here is safe.
const CLAIM_HEADING_RE = /^##\s+([AB]\d+)\b/;

// Fence/inline-code-aware, unlike a raw regex over the whole file: a "## A99" sitting inside a
// fenced Evidence block (real content, e.g. a captured log excerpt) or an inline code span must
// never count as a real claim heading, or fenced prose could fabricate or hide Phase 1 provenance.
// Reuses the exact same parseFenceLines/splitLineSpans logic relabel and scan already share.
// A heading is a STRUCTURAL property of the line's own start, not something to detect after
// removing inline code spans: stripping "`x`" from "`x`## A99" shifts "## A99" to position 0,
// which a real Markdown renderer would never treat as a heading (the backtick span still occupies
// that position). Test the RAW line (fence-skip only, no span-stripping) so a claim ID cannot be
// smuggled into existence by prefixing a heading-shaped string with an inline code span.
function extractClaimHeadings(text) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely scan past it, fix the file and re-run');
  }
  const found = new Set();
  for (const { text: line, inFence } of lines) {
    if (inFence) continue;
    const m = CLAIM_HEADING_RE.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

const CLAIM_SEVERITY_LINE_RE = /^Severity:\s*(.+?)\s*$/;
const CLAIM_BASIS_LINE_RE = /^Basis:\s*(.+?)\s*$/;
const CLAIM_EVIDENCE_STRENGTH_LINE_RE = /^Evidence strength:\s*(.+?)\s*$/;
// A level word followed only by a parenthetical or a dash/colon/comma note ("MEDIUM (docs risk)") counts as that level;
// "HIGH or MEDIUM" does not, because the second level makes the value ambiguous.
function levelWord(raw, allowed) {
  const m = /^([A-Z_]+)(?:\s*[(—–:,;-].*)?$/.exec(raw);
  if (!m || !allowed.has(m[1])) return raw;
  const rest = raw.slice(m[1].length).toUpperCase();
  return [...allowed].some((level) => level !== m[1] && new RegExp(`(^|[^A-Z_])${level}($|[^A-Z_])`).test(rest)) ? raw : m[1];
}

const CLAIM_EVIDENCE_LINE_RE = /^Evidence:\s*(.*)$/;
const SUGGESTED_FIX_LINE_RE = /^Suggested fix:\s*(.*?)\s*$/;
const CLAIM_TRIGGER_LINE_RE = /^Trigger:\s*(.*?)\s*$/;
// Optional: whether the defect was already in the code before the change under review. Any other word is not kept.
const CLAIM_PRE_EXISTING_LINE_RE = /^Pre-existing:\s*(yes|no|unknown)\b/i;
// Seats often write the class-sweep line after other text ("Impact: ... Same shape elsewhere: ..."), so it matches anywhere in an unfenced line.
const SAME_SHAPE_RE = /(?:^|[^A-Za-z])Same shape elsewhere:\s*(.*?)\s*$/;
// A CommonMark thematic break (bare ---/***/___, 3+ chars, optional spaces between them) used as
// a claim separator, same as real Phase 1 output observed in practice: it terminates the current
// block/evidence body the same way a "## " heading does, but starts no new block (there is no
// claim ID on a thematic break) -- so a "---" between "## A1" and "## A2" must not leak into A1's
// evidence, and must not be misread as itself beginning a claim.
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

// Matches a "## "-heading whose text is CLAIM-ID-SHAPED (one or two letters immediately followed
// by digits, e.g. "A1", "B12", "a1", "A01") but did NOT match CLAIM_HEADING_RE's stricter
// exactly-[AB]-then-digits pattern -- catches the exact live-run shape ("## 1 -- bad heading",
// a bare number with NO seat letter at all) plus adjacent malformed variants (wrong seat letter,
// lowercase, leading zero) a model could plausibly emit while still clearly attempting the claim
// schema. Deliberately narrower than "any heading": an ordinary prose heading like
// "## Checks performed" must never be flagged as a malformed claim attempt.
const CLAIM_LIKE_HEADING_RE = /^##\s+([A-Za-z]{0,2}\d+)\b/;

// The fixed, literal marker a seat with GENUINELY zero findings must emit under its own seat
// header, distinct from merely having no recognized "## A<n>" headings (which is indistinguishable
// from "the model ignored the schema" without a marker -- exactly the false-clean validate gap a
// live run exposed: a bare-number-heading file and a real empty-findings file both parsed to zero
// claim blocks). Matched on the RAW line (heading-shaped structural test, same principle as
// CLAIM_HEADING_RE), case-sensitive and exact, so it can't be satisfied by incidental prose.
const NO_FINDINGS_MARKER_RE = /^##\s+No findings\s*$/;

// Same fence-skip-then-raw-line discipline as extractClaimHeadings, extended to pull each
// claim's own Severity/Basis/Evidence strength/Evidence body -- the fields translate needs to
// derive a canonical finding's basis/evidence_strength/evidence mechanically instead of trusting
// the auditor's transcription of them (review-protocol.md's own stated known limitation). A block
// runs from one "## A<n>"/"## B<n>" heading to the next heading of any kind (or EOF); only the
// FIRST occurrence of each field line before the first "Evidence:" line is used, matching the
// fixture's own shape (Severity/Basis/Evidence strength always precede Evidence). The evidence
// body ends at the close of its fence group (fences separated only by blank lines; delimiter lines
// excluded) or, when unfenced, at a "Suggested fix:" line, heading, or thematic break; it then gets
// parseVerificationFile's structural-blank-trim. The first "Suggested fix:" line becomes suggestedFix.
// Also collects malformedHeadings (claim-like but not a real "## A<n>"/"## B<n>" heading -- the
// exact live-run "## 1" shape) and duplicateIds (a real claim ID heading appearing more than
// once -- silently overwriting the first block would let one claim erase another for mechanical
// derivation) and noFindingsMarker (whether the fixed marker line was seen anywhere, unfenced),
// so a caller can distinguish "zero claims because genuinely none" from "zero claims because the
// model ignored the schema" -- the exact ambiguity a live run's false-clean validate result
// exposed.
function extractClaimBlocks(text) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely parse claim blocks past it, fix the file and re-run');
  }
  const blocks = new Map();
  const malformedHeadings = [];
  const duplicateIds = [];
  let noFindingsMarker = false;
  let current = null;
  let evidenceLines = null;
  // Non-null once an Evidence fence has closed: blank lines seen since, kept only if another fence follows.
  let afterFence = null;
  const finishEvidence = () => {
    afterFence = null;
    if (current === null || evidenceLines === null) return;
    const isStructuralBlank = (l) => l.text === '';
    const trimmed = [...evidenceLines];
    while (trimmed.length > 0 && isStructuralBlank(trimmed[0])) trimmed.shift();
    while (trimmed.length > 0 && isStructuralBlank(trimmed[trimmed.length - 1])) trimmed.pop();
    // Each line's own eol is the separator to the NEXT line, not a terminator on itself -- the
    // last surviving line contributes no trailing eol, so the body has no trailing newline.
    current.evidence = trimmed.map((l, i) => (i < trimmed.length - 1 ? l.text + l.eol : l.text)).join('');
    evidenceLines = null;
  };
  lines.forEach(({ text: line, inFence, eol, isOpen, isClose }, idx) => {
    const headingMatch = !inFence ? CLAIM_HEADING_RE.exec(line) : null;
    const isHeading = !inFence && /^##\s+/.test(line);
    if (isHeading) {
      finishEvidence();
      if (!headingMatch && NO_FINDINGS_MARKER_RE.test(line)) {
        noFindingsMarker = true;
        current = null;
        return;
      }
      if (!headingMatch) {
        const claimLike = CLAIM_LIKE_HEADING_RE.exec(line);
        if (claimLike) malformedHeadings.push({ line: idx + 1, text: line.trim(), attempted: claimLike[1] });
        current = null;
        return;
      }
      if (blocks.has(headingMatch[1])) {
        duplicateIds.push({ id: headingMatch[1], line: idx + 1, text: line.trim() });
        current = null; // the duplicate's own body is not merged into or replacing the original
        return;
      }
      current = {
        id: headingMatch[1], line: idx + 1, heading: line.trim(), severity: null, basis: null, evidenceStrength: null,
        evidence: null, suggestedFix: null, trigger: null, sameShape: null, preExisting: null,
      };
      blocks.set(current.id, current);
      return;
    }
    // A thematic break terminates evidence accumulation (trailing prose after a fence, before the
    // next claim) the same way it terminates a claim with no evidence at all -- but only OUTSIDE a
    // fence: a "---" inside a fence is real content (e.g. a captured CLI table separator), never a
    // structural break, same principle as the fence-delimiter check below.
    if (!inFence && THEMATIC_BREAK_RE.test(line)) {
      finishEvidence();
      current = null;
      return;
    }
    if (current === null) return;
    // Read only: the line stays wherever the evidence rules put it.
    if (!inFence && current.sameShape === null) {
      const ss = SAME_SHAPE_RE.exec(line);
      if (ss && ss[1].length > 0) current.sameShape = ss[1];
    }
    // Evidence boundary rules: see the function doc above.
    let evidenceEnded = false;
    if (evidenceLines !== null && afterFence !== null) {
      if (!inFence && line.trim() === '') { afterFence.push({ text: line, eol }); return; }
      if (isOpen) { evidenceLines.push(...afterFence); afterFence = null; return; }
      finishEvidence();
      evidenceEnded = true;
    }
    if (evidenceLines !== null && !evidenceEnded) {
      if (isOpen) return;
      if (isClose) { afterFence = []; return; }
      if (inFence || !SUGGESTED_FIX_LINE_RE.test(line)) {
        evidenceLines.push({ text: line, eol });
        return;
      }
      finishEvidence();
    }
    if (inFence) return;
    const sfMatch = SUGGESTED_FIX_LINE_RE.exec(line);
    if (sfMatch) {
      if (current.suggestedFix === null && sfMatch[1].length > 0) current.suggestedFix = sfMatch[1];
      return;
    }
    const preMatch = CLAIM_PRE_EXISTING_LINE_RE.exec(line);
    if (preMatch) {
      if (current.preExisting === null) current.preExisting = preMatch[1].toLowerCase();
      return;
    }
    const trMatch = CLAIM_TRIGGER_LINE_RE.exec(line);
    if (trMatch) {
      if (current.trigger === null && trMatch[1].length > 0) current.trigger = trMatch[1];
      return;
    }
    const sevMatch = CLAIM_SEVERITY_LINE_RE.exec(line);
    if (sevMatch && current.severity === null) { current.severity = levelWord(sevMatch[1], SEVERITY_VALUES); return; }
    const basisMatch = CLAIM_BASIS_LINE_RE.exec(line);
    if (basisMatch && current.basis === null) { current.basis = levelWord(basisMatch[1], BASIS_VALUES); return; }
    const esMatch = CLAIM_EVIDENCE_STRENGTH_LINE_RE.exec(line);
    if (esMatch && current.evidenceStrength === null) { current.evidenceStrength = levelWord(esMatch[1], EVIDENCE_STRENGTH_VALUES); return; }
    const evMatch = CLAIM_EVIDENCE_LINE_RE.exec(line);
    if (evMatch && current.evidence === null) { evidenceLines = [{ text: evMatch[1], eol }]; return; }
  });
  finishEvidence();
  return { blocks, malformedHeadings, duplicateIds, noFindingsMarker };
}

async function readPhase1Seat(seat, phase1Dir) {
  const filePath = path.join(phase1Dir, `${seat}-findings.md`);
  try {
    return await readUtf8(filePath);
  } catch (err) {
    throw new RelayError(`--phase1-dir: could not read ${filePath}: ${err.message}`);
  }
}

// Independent max across origins, strongest wins, so a canonical finding never underreports
// what its own origins already established -- review-protocol.md's "highest severity among
// origins" / "the strongest-evidenced origin's values, cited" rule, applied mechanically instead
// of trusted from the auditor's transcription. Order is most-authoritative first.
const SEVERITY_RANK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const BASIS_RANK = ['EXECUTED', 'STATIC_TRACE', 'SOURCE_CITATION', 'INFERENCE'];
const EVIDENCE_STRENGTH_RANK = ['REPRODUCED', 'DETERMINISTIC', 'SUPPORTED', 'PLAUSIBLE', 'SPECULATIVE'];

function strongest(rank, values) {
  let best = null;
  let bestIdx = Infinity;
  for (const v of values) {
    const idx = rank.indexOf(v);
    if (idx === -1) continue; // an unrecognized value is never treated as strongest; caller's own enum check catches it
    if (idx < bestIdx) { bestIdx = idx; best = v; }
  }
  return best;
}

// Picks the single "strongest-evidenced origin" review-protocol.md's Canonical findings section
// names ("basis / evidence_strength: the strongest-evidenced origin's values, cited") -- NOT two
// independent per-field maxima. Independently maximizing basis and evidence_strength across
// different origins can synthesize a (basis, evidence_strength) PAIR no origin ever actually
// asserted (e.g. one origin EXECUTED+SUPPORTED, another STATIC_TRACE+REPRODUCED, independent-max
// wrongly reports EXECUTED+REPRODUCED -- a combination that never existed and overclaims the
// finding's real evidentiary strength). Tiebreak order: basis first (the protocol always lists
// "basis / evidence_strength" in that order, and basis -- how the claim was discovered -- is the
// more fundamental axis), evidence_strength second, then origins[] array order as a final,
// deterministic tiebreak so two origins tied on both axes still resolve the same way every run.
function strongestOriginIndex(blocks) {
  let bestI = 0;
  for (let i = 1; i < blocks.length; i++) {
    const basisCmp = BASIS_RANK.indexOf(blocks[i].basis) - BASIS_RANK.indexOf(blocks[bestI].basis);
    if (basisCmp < 0) { bestI = i; continue; }
    if (basisCmp > 0) continue;
    const esCmp =
      EVIDENCE_STRENGTH_RANK.indexOf(blocks[i].evidenceStrength) -
      EVIDENCE_STRENGTH_RANK.indexOf(blocks[bestI].evidenceStrength);
    if (esCmp < 0) bestI = i;
  }
  return bestI;
}

async function getClaimBlock(id, phase1Dir, blocksBySeat) {
  const seat = id[0];
  if (!blocksBySeat.has(seat)) {
    blocksBySeat.set(seat, extractClaimBlocks(await readPhase1Seat(seat, phase1Dir)).blocks);
  }
  const block = blocksBySeat.get(seat).get(id);
  if (!block) {
    throw new RelayError(`--phase1-dir: origin "${id}" has no matching claim block in ${seat}-findings.md`);
  }
  return block;
}

// Overwrites a finding's severity/basis/evidence_strength/evidence with values derived
// mechanically from its own real Phase 1 origins, discarding whatever the auditor's JSON
// supplied for these -- same precedent as checkVerificationsAgainstDir's verifier-file
// authority. Only runs when --phase1-dir is supplied; without it, the auditor's own values are
// still trusted.
// blocksBySeat is caller-scoped (one per translateFindings call, reused across findings in that
// call), never module-level -- a pure function shouldn't carry state across unrelated calls.
// A missing or unrecognized field in an origin's own claim block (a typo'd "Evidence Strength:",
// a value outside the enum, no "Evidence:" line at all) must REFUSE, never silently fall back to
// trusting the auditor's transcription for that field -- the whole point of this derivation is
// that the auditor's copy is never trusted once --phase1-dir is supplied. A silent fallback here
// would reintroduce exactly the un-cross-checked trust the "Known limitation" this closes.
// Single source of truth for "is this claim block usable" -- shared by deriveFromOrigins (which
// throws on the first problem, mid-translate) and the validate subcommand (which collects every
// problem across every claim in a file, so a reformatting round can fix them all at once instead
// of one RelayError per re-run). Returns a list of human-readable problem strings, empty if none.
function claimBlockProblems(block) {
  const problems = [];
  if (block.severity === null) {
    problems.push('no recognized "Severity:" line');
  } else if (!SEVERITY_VALUES.has(block.severity)) {
    problems.push(`Severity value "${block.severity.slice(0, 60)}" is not exactly one of ${[...SEVERITY_VALUES].join('|')}`);
  }
  if (block.basis === null || !BASIS_VALUES.has(block.basis)) {
    problems.push('no recognized "Basis:" line');
  }
  if (block.evidenceStrength === null || !EVIDENCE_STRENGTH_VALUES.has(block.evidenceStrength)) {
    problems.push('no recognized "Evidence strength:" line');
  }
  if (typeof block.evidence !== 'string' || block.evidence.length === 0) {
    problems.push('no non-empty "Evidence:" body');
  }
  return problems;
}

async function deriveFromOrigins(finding, phase1Dir, blocksBySeat) {
  const blocks = await Promise.all(finding.origins.map((id) => getClaimBlock(id, phase1Dir, blocksBySeat)));
  for (const [id, block] of finding.origins.map((id, i) => [id, blocks[i]])) {
    const problems = claimBlockProblems(block);
    if (problems.length > 0) {
      throw new RelayError(`--phase1-dir: origin "${id}" has ${problems.join(', ')} in its Phase 1 claim block`);
    }
  }
  finding.severity = strongest(SEVERITY_RANK, blocks.map((b) => b.severity));
  const strongestIdx = strongestOriginIndex(blocks);
  finding.basis = blocks[strongestIdx].basis;
  finding.evidence_strength = blocks[strongestIdx].evidenceStrength;
  finding.basis_from = finding.origins[strongestIdx];
  finding.evidence = blocks.map((b) => b.evidence);
  finding.suggested_fix = finding.origins
    .map((id, i) => (blocks[i].suggestedFix === null ? null : `${id}: ${blocks[i].suggestedFix}`))
    .filter((s) => s !== null);
  // Seat-written lines, present only when an origin has one; an auditor's own copy is never kept.
  for (const [key, field] of [['trigger', 'trigger'], ['sameShape', 'same_shape'], ['preExisting', 'pre_existing']]) {
    const lines = finding.origins.map((id, i) => (blocks[i][key] === null ? null : `${id}: ${blocks[i][key]}`)).filter((s) => s !== null);
    if (lines.length > 0) finding[field] = lines;
    else delete finding[field];
  }
  // summary is optional for the auditor; without it and a title every report row would be blank, so the first origin's
  // Phase 1 heading text ("## A1 — <title>") names the finding.
  const blank = (v) => typeof v !== 'string' || v.trim() === '';
  if (blank(finding.title) && blank(finding.summary)) {
    const heading = blocks[0].heading.replace(/^#+\s*\S+\s*(?:[—–:-]\s*)?/, '').trim();
    if (heading) finding.title = heading;
  }
}

async function checkOriginsAgainstPhase1(origins, phase1Dir) {
  const bySeat = { A: null, B: null };
  for (const id of origins) {
    const seat = id[0];
    if (bySeat[seat] === null) {
      bySeat[seat] = extractClaimHeadings(await readPhase1Seat(seat, phase1Dir));
    }
    if (!bySeat[seat].has(id)) {
      throw new RelayError(
        // No seat file name: review-run sends this text back to a blind auditor.
        `translated origin "${id}" has no Phase 1 claim heading "## ${id}"; ` +
          'refusing to publish a finding citing a claim ID that does not exist in Phase 1'
      );
    }
  }
}

// Coverage is the reverse direction of checkOriginsAgainstPhase1: that function catches an
// origin citing a claim ID Phase 1 never raised (a hallucination); this catches a REAL Phase 1
// claim the auditor silently dropped from every finding -- "nothing is silently absent" cuts
// both ways. Reads both seat files unconditionally (a finding set can cite only one seat, but
// coverage must still be checked against both).
async function checkPhase1Coverage(findings, phase1Dir) {
  const allPhase1Claims = new Set();
  for (const seat of ['A', 'B']) {
    const text = await readPhase1Seat(seat, phase1Dir);
    for (const id of extractClaimHeadings(text)) allPhase1Claims.add(id);
  }
  const coveredClaims = new Set(findings.flatMap((f) => f.origins));
  const missing = [...allPhase1Claims].filter((id) => !coveredClaims.has(id));
  if (missing.length > 0) {
    throw new RelayError(
      `Phase 1 claim(s) [${missing.join(', ')}] do not appear as an origin of any canonical ` +
        'finding; every surviving claim (including a dropped-SPECULATIVE one) must belong to ' +
        'exactly one finding -- refusing to publish findings.json that silently drops a claim'
    );
  }
}

// Both directions matter: a claim listing a verification file that doesn't exist is a
// hallucinated verdict; a verification file on disk that no finding cites is a verdict
// the auditor silently dropped -- the hallucinated-claim-ID class, in reverse.
// The verifier (like the auditor) sees only anonymous X/Y IDs, so the orchestrator saves
// each verdict as verification-<X|Y><n>.md, never verification-<A|B><n>.md -- a file named
// by the real ID would mean the artifact the auditor reads carries real seat identity. This
// checks the ANONYMOUS filenames on disk against findings AFTER they've already been
// translated to real IDs, so it re-derives the anonymous claim id via the mapping.
// The verifier's own output file, not the auditor's transcription of it, is authoritative for
// its ENTIRE record -- claim, verdict, basis, AND evidence, not just verdict (an auditor that
// keeps the verdict but rewrites the evidence text would otherwise silently discard the
// verifier's actual reasoning). "Claim:", "Verdict:", and "Basis:" may appear in any order
// before "Evidence:" -- once an "Evidence:" line is seen, everything from there to end of file
// is the evidence body verbatim (fences included), so a "Verdict:"-shaped line inside the
// evidence text is body content, not a second header line. Header lines are matched against the
// RAW line, fence-skip only, no inline-code-span stripping: stripping "`x`" from "`x`Claim: X1"
// would shift "Claim: X1" to position 0, which a real Markdown renderer never treats as the
// start of the line -- the same class of bug the fence-aware fix for Phase 1 claim headings
// closed for "## A<n>" headings.
const VERIFICATION_CLAIM_RE = /^Claim:\s*([XY]\d+)\b/;
const VERIFICATION_VERDICT_LINE_RE = /^Verdict:\s*(CONFIRMED|REFUTED|INCONCLUSIVE)\b/;
const VERIFICATION_BASIS_LINE_RE = /^Basis:\s*([A-Z_]+)\b/;
const VERIFICATION_EVIDENCE_LINE_RE = /^Evidence:\s*(.*)$/;

// True when a verifier file, read the way parseVerificationFile reads it, says REFUTED with Basis INFERENCE: review-run
// checks this before the auditor runs, so the file goes back to its verifier instead of failing translate after a paid audit.
export function refutesByInference(text) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) return false;
  let verdict = null;
  let basis = null;
  for (const { text: line, inFence } of lines) {
    if (inFence) continue;
    if (VERIFICATION_EVIDENCE_LINE_RE.test(line)) break;
    verdict ??= VERIFICATION_VERDICT_LINE_RE.exec(line)?.[1] ?? null;
    basis ??= VERIFICATION_BASIS_LINE_RE.exec(line)?.[1] ?? null;
  }
  return verdict === 'REFUTED' && basis === 'INFERENCE';
}

function parseVerificationFile(text, fileLabel) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError(`${fileLabel}: unterminated fenced code block, cannot safely parse past it`);
  }
  let claim = null;
  let verdict = null;
  let basis = null;
  let evidenceLines = null;
  for (const { text: line, inFence, eol } of lines) {
    if (evidenceLines !== null) {
      evidenceLines.push({ text: line, eol });
      continue;
    }
    if (inFence) continue;
    const claimMatch = VERIFICATION_CLAIM_RE.exec(line);
    if (claimMatch) {
      if (claim !== null) throw new RelayError(`${fileLabel}: has more than one "Claim:" line`);
      claim = claimMatch[1];
      continue;
    }
    const verdictMatch = VERIFICATION_VERDICT_LINE_RE.exec(line);
    if (verdictMatch) {
      if (verdict !== null) throw new RelayError(`${fileLabel}: has more than one "Verdict:" line`);
      verdict = verdictMatch[1];
      continue;
    }
    const basisMatch = VERIFICATION_BASIS_LINE_RE.exec(line);
    if (basisMatch) {
      if (basis !== null) throw new RelayError(`${fileLabel}: has more than one "Basis:" line`);
      basis = basisMatch[1];
      continue;
    }
    const evidenceMatch = VERIFICATION_EVIDENCE_LINE_RE.exec(line);
    if (evidenceMatch) {
      evidenceLines = [{ text: evidenceMatch[1], eol }];
    }
  }
  if (claim === null) throw new RelayError(`${fileLabel}: missing a "Claim: <X|Y-id>" line`);
  if (verdict === null) throw new RelayError(`${fileLabel}: missing a "Verdict: <...>" line`);
  if (basis === null) throw new RelayError(`${fileLabel}: missing a "Basis: <...>" line`);
  if (!BASIS_VALUES.has(basis)) {
    throw new RelayError(`${fileLabel}: has Basis "${basis}", not one of: ${[...BASIS_VALUES].join(', ')}`);
  }
  if (evidenceLines === null) throw new RelayError(`${fileLabel}: missing an "Evidence:" line`);
  if (verdict === 'REFUTED' && basis === 'INFERENCE') {
    throw new RelayError(`${fileLabel}: has Verdict REFUTED with Basis INFERENCE; a refutation needs a command and its output (EXECUTED) or the cited lines (STATIC_TRACE, SOURCE_CITATION), otherwise the verdict is INCONCLUSIVE`);
  }
  // "Verbatim" means byte-identical content, not merely non-empty -- .trim() on the full joined
  // block would strip real leading indentation from the first content line (code, logs, YAML) and
  // any trailing whitespace a real evidence line legitimately ends with. Only the STRUCTURAL
  // wrapper -- a blank first line from "Evidence:" alone on its own line, and blank trailing lines
  // from the file's own trailing newline(s) -- is trimmed; interior blank lines and indentation are
  // untouched. Each line carries its OWN original terminator (parseFenceLines tracks per line, not
  // per file, since a mixed-EOL fence -- e.g. pasted CRLF tool output inside an LF file -- is real
  // and must round-trip byte-exact); rejoining per-line reproduces the original interior breaks
  // verbatim instead of guessing one file-level line ending.
  const isStructuralBlank = (line) => line.text === '';
  const trimmedLines = [...evidenceLines];
  while (trimmedLines.length > 0 && isStructuralBlank(trimmedLines[0])) trimmedLines.shift();
  while (trimmedLines.length > 0 && isStructuralBlank(trimmedLines[trimmedLines.length - 1])) trimmedLines.pop();
  const evidence = trimmedLines.map((l, i) => (i < trimmedLines.length - 1 ? l.text + l.eol : l.text)).join('');
  if (evidence.trim().length === 0) throw new RelayError(`${fileLabel}: has an "Evidence:" line but no non-empty evidence body`);
  return { claim, verdict, basis, evidence };
}

async function checkVerificationsAgainstDir(findings, verificationDir, mapping) {
  const cited = new Set();
  for (const finding of findings) {
    for (const v of finding.verifications ?? []) {
      const anonId = mapping[v.claim[0]] + v.claim.slice(1);
      cited.add(anonId);
      const filePath = path.join(verificationDir, `verification-${anonId}.md`);
      let content;
      try {
        content = await readUtf8(filePath);
      } catch {
        throw new RelayError(
          `--verification-dir: finding "${finding.id}" cites a verification for "${v.claim}" ` +
            `(anonymous "${anonId}") but ${filePath} does not exist`
        );
      }
      // A malformed verifier file is the orchestrator's to fix, not the auditor's: the "--verification-dir" label makes
      // review-run fail the step instead of sending the message (and the run folder path in it) to the auditor.
      const parsed = parseVerificationFile(content, `--verification-dir: ${filePath}`);
      if (parsed.claim !== anonId) {
        throw new RelayError(
          `--verification-dir: ${filePath} is named for "${anonId}" but its own "Claim:" line ` +
            `says "${parsed.claim}" -- a claim ID other than the one the verifier was given is ` +
            'a leak, not a discovery, and must be rejected'
        );
      }
      if (parsed.verdict !== v.verdict) {
        throw new RelayError(
          `--verification-dir: finding "${finding.id}" asserts verdict "${v.verdict}" for ` +
            `"${v.claim}" but ${filePath} itself says "${parsed.verdict}" -- the verifier's own ` +
            'file is authoritative, not the auditor\'s transcription of it'
        );
      }
      // The verifier's file is authoritative for its ENTIRE record, not only the verdict: basis
      // and evidence are populated here from the file, overwriting whatever the auditor's own
      // JSON supplied (or leaving it absent), so an auditor cannot substitute its own reasoning
      // for the independent verifier's actual evidence.
      v.basis = parsed.basis;
      v.evidence = parsed.evidence;
    }
  }
  let entries;
  try {
    entries = await fs.readdir(verificationDir);
  } catch (err) {
    throw new RelayError(`--verification-dir: could not read ${verificationDir}: ${err.message}`);
  }
  for (const entry of entries) {
    const m = /^verification-(.+)\.md$/.exec(entry);
    if (!m) continue;
    if (!/^[XY]\d+$/.test(m[1])) {
      throw new RelayError(
        `--verification-dir: ${entry} is named with a real "A<n>"/"B<n>" claim ID, not an ` +
          'anonymous "X<n>"/"Y<n>" one -- a real-ID filename would leak seat identity to the ' +
          'auditor and verifier, which must never see it; save verifier output under its ' +
          'anonymous claim ID instead'
      );
    }
    if (!cited.has(m[1])) {
      throw new RelayError(
        `--verification-dir: ${entry} exists but no finding cites a verification for it; ` +
          'refusing to publish findings.json that silently drops a verifier verdict'
      );
    }
  }
}

async function translateFindings(auditJson, mapping, phase1Dir, verificationDir, checklist = [], auditDepth = 'full') {
  if (auditDepth !== 'light' && auditDepth !== 'full') throw new RelayError('--audit-depth must be light or full');
  const auditToSeat = invertSeatMapping(mapping);
  let parsed;
  try {
    parsed = JSON.parse(stripBom(auditJson));
  } catch (err) {
    throw new RelayError(`--in is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new RelayError('--in must be a JSON object with a "findings" array');
  }
  assertNoAnonymousIdsInProse(parsed, await anonymousOriginIds(parsed, mapping, phase1Dir), checklist);
  const translated = translateStructuredIds(parsed, auditToSeat);
  const seenFindingIds = new Set();
  const seenOrigins = new Set();
  const blocksBySeat = new Map();
  for (const [index, finding] of translated.findings.entries()) {
    if (!FINDING_ID_RE.test(finding.id)) {
      throw new RelayError(`findings[${index}] ${finding.id === undefined ? 'has no "id"' : `has id "${finding.id}", which is not of the form "F<n>"`} (expected "F${index + 1}"); every finding needs one`);
    }
    if (seenFindingIds.has(finding.id)) {
      throw new RelayError(`duplicate finding id "${finding.id}"`);
    }
    seenFindingIds.add(finding.id);
    if (!Array.isArray(finding.origins) || finding.origins.length === 0) {
      throw new RelayError(`finding "${finding.id}" has no origins after translation`);
    }
    for (const origin of finding.origins) {
      if (!REAL_CLAIM_ID_RE.test(origin)) {
        throw new RelayError(
          `finding "${finding.id}" has an origin "${origin}" that is not a real "A<n>"/"B<n>" ` +
            'claim ID after translation -- an untranslated X/Y ID would leak the blind, refusing'
        );
      }
      if (seenOrigins.has(origin)) {
        throw new RelayError(
          `claim "${origin}" appears as an origin of more than one finding; every surviving ` +
            'claim belongs to exactly one canonical finding'
        );
      }
      seenOrigins.add(origin);
    }
    if (phase1Dir) {
      await checkOriginsAgainstPhase1(finding.origins, phase1Dir);
      await deriveFromOrigins(finding, phase1Dir, blocksBySeat);
    }
    if (
      !Array.isArray(finding.evidence) ||
      finding.evidence.length === 0 ||
      finding.evidence.some((e) => typeof e !== 'string' || e.length === 0)
    ) {
      throw new RelayError(
        `finding "${finding.id}" has no evidence, or evidence is not a non-empty array of ` +
          'non-empty strings -- "no evidence, no finding" is enforced mechanically here'
      );
    }
    assertEnum(finding.severity, SEVERITY_VALUES, 'severity', finding.id);
    assertEnum(finding.basis, BASIS_VALUES, 'basis', finding.id);
    assertEnum(finding.evidence_strength, EVIDENCE_STRENGTH_VALUES, 'evidence_strength', finding.id);
    assertEnum(finding.final_state, FINAL_STATE_VALUES, 'final_state', finding.id);
    if (finding.auditor_check === undefined || typeof finding.auditor_check !== 'object' || finding.auditor_check === null) {
      throw new RelayError(`finding "${finding.id}" is missing a required auditor_check object`);
    }
    assertEnum(finding.auditor_check.result, AUDITOR_CHECK_RESULT_VALUES, 'auditor_check.result', finding.id);
    // Auditors often write "reason": null on every finding; that means no reason, same as leaving it out.
    if (finding.auditor_check.reason === null) delete finding.auditor_check.reason;
    const reason = finding.auditor_check.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0)) {
      throw new RelayError(`finding "${finding.id}" has an auditor_check.reason that is not a non-empty string`);
    }
    if (finding.auditor_check.result === 'NOT_CHECKED') {
      if (finding.auditor_check.basis !== null || finding.auditor_check.evidence !== null) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "NOT_CHECKED" but a non-null basis ` +
            'or evidence -- both must be null when the auditor did not independently check this claim'
        );
      }
      const highStakes = finding.severity === 'HIGH' || finding.severity === 'CRITICAL';
      if (highStakes && finding.final_state !== 'dropped-speculative' && reason === undefined) {
        throw new RelayError(
          `finding "${finding.id}" is ${finding.severity} with auditor_check.result "NOT_CHECKED" and no ` +
            'auditor_check.reason -- a HIGH/CRITICAL finding the auditor did not check must say why'
        );
      }
      // A full audit re-checks every claim, so any finding it skipped must say why, at any severity.
      if (auditDepth === 'full' && finding.final_state !== 'dropped-speculative' && reason === undefined) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "NOT_CHECKED" and no auditor_check.reason ` +
            'under --audit-depth full -- a full audit checks every finding or says why it could not'
        );
      }
    } else {
      assertEnum(finding.auditor_check.basis, BASIS_VALUES, 'auditor_check.basis', finding.id);
      // Absence of proof is not a refutation: a REFUTED check must show what it ran or read.
      if (finding.auditor_check.result === 'REFUTED' && finding.auditor_check.basis === 'INFERENCE') {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "REFUTED" with basis "INFERENCE" -- a refutation needs ` +
            'a command and its output (EXECUTED) or the cited lines (STATIC_TRACE, SOURCE_CITATION); otherwise the result is INCONCLUSIVE'
        );
      }
      if (typeof finding.auditor_check.evidence !== 'string' || finding.auditor_check.evidence.length === 0) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "${finding.auditor_check.result}" but ` +
            'a missing or empty evidence -- required whenever the auditor claims it independently checked a claim'
        );
      }
    }
    // A severity the auditor's own check supports (a peer's conceded correction, or what it found).
    // "severity" stays the claims' own value; severity_audited carries the audited one.
    if (Object.hasOwn(finding, 'severity_audited')) {
      throw new RelayError(
        `finding "${finding.id}" has a top-level severity_audited; translate sets it from auditor_check.severity ` +
          '(with auditor_check.severity_reason, on a CONFIRMED check) -- put the audited severity there'
      );
    }
    if (finding.auditor_check.severity === null) delete finding.auditor_check.severity;
    if (finding.auditor_check.severity_reason === null) delete finding.auditor_check.severity_reason;
    const sevReason = finding.auditor_check.severity_reason;
    if (sevReason !== undefined && finding.auditor_check.severity === undefined) {
      throw new RelayError(`finding "${finding.id}" has auditor_check.severity_reason but no auditor_check.severity`);
    }
    if (finding.auditor_check.severity !== undefined) {
      assertEnum(finding.auditor_check.severity, SEVERITY_VALUES, 'auditor_check.severity', finding.id);
      if (finding.auditor_check.result !== 'CONFIRMED') {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.severity but result "${finding.auditor_check.result}"; ` +
            'a severity is audited only on a claim the auditor CONFIRMED'
        );
      }
      if (typeof sevReason !== 'string' || sevReason.trim().length === 0) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.severity but no auditor_check.severity_reason; ` +
            'give one sentence a ticket writer can read on its own'
        );
      }
      if (finding.auditor_check.severity !== finding.severity) finding.severity_audited = finding.auditor_check.severity;
    }
    if (!Array.isArray(finding.peer_responses)) {
      throw new RelayError(`finding "${finding.id}" has no peer_responses array`);
    }
    for (const pr of finding.peer_responses) {
      if (typeof pr.claim !== 'string' || pr.claim.length === 0) {
        throw new RelayError(`finding "${finding.id}" has a peer_responses[].claim that is not a non-empty string`);
      }
      assertEnum(pr.response, PEER_RESPONSE_VALUES, 'a peer_responses[].response', finding.id);
      if (pr.counter_fact !== undefined && pr.counter_fact !== null) {
        if (typeof pr.counter_fact !== 'string' || pr.counter_fact.trim() === '' || pr.counter_fact.length > COUNTER_FACT_MAX || /[\r\n]/.test(pr.counter_fact)) {
          throw new RelayError(`finding "${finding.id}" has a peer_responses[].counter_fact that is not one non-empty line of at most ${COUNTER_FACT_MAX} characters`);
        }
        if (pr.response !== 'disputed-with-counter-fact') {
          throw new RelayError(`finding "${finding.id}" has a peer_responses[].counter_fact on a "${pr.response}" response; only disputed-with-counter-fact carries one`);
        }
      }
    }
    const responseClaims = new Set(finding.peer_responses.map((pr) => pr.claim));
    const originSet = new Set(finding.origins);
    const noDuplicateResponses = finding.peer_responses.length === responseClaims.size;
    const sameSize = responseClaims.size === originSet.size;
    const allMatch =
      noDuplicateResponses && sameSize && finding.origins.every((id) => responseClaims.has(id));
    if (!allMatch) {
      throw new RelayError(
        `finding "${finding.id}" has peer_responses claims [${[...responseClaims].join(', ')}] ` +
          `that do not exactly match its origins [${finding.origins.join(', ')}] -- ` +
          'one peer_responses entry is required per origin claim, no more, no fewer'
      );
    }
    const seatLetters = new Set(finding.origins.map((id) => id[0]));
    finding.independently_discovered = seatLetters.size === 2;
    if (finding.verifications !== undefined) {
      if (!Array.isArray(finding.verifications)) {
        throw new RelayError(`finding "${finding.id}" has a non-array verifications field`);
      }
      if (finding.verifications.length > 0 && !verificationDir) {
        throw new RelayError(
          `finding "${finding.id}" has a verifications entry but --verification-dir was not ` +
            'supplied; the verifier file, not the auditor\'s JSON, is authoritative for a ' +
            'verification record, so this cannot be validated without it -- this mechanism is ' +
            'not opt-out'
        );
      }
      const seenVerificationClaims = new Set();
      for (const v of finding.verifications) {
        if (typeof v.claim !== 'string' || v.claim.length === 0) {
          throw new RelayError(`finding "${finding.id}" has a verifications[].claim that is not a non-empty string`);
        }
        if (!originSet.has(v.claim)) {
          throw new RelayError(
            `finding "${finding.id}" has a verification for "${v.claim}", which is not one of ` +
              `its origins [${finding.origins.join(', ')}]`
          );
        }
        if (seenVerificationClaims.has(v.claim)) {
          throw new RelayError(`finding "${finding.id}" has more than one verification for "${v.claim}"`);
        }
        seenVerificationClaims.add(v.claim);
        assertEnum(v.verdict, VERIFICATION_VERDICT_VALUES, 'a verifications[].verdict', finding.id);
      }
      // review-protocol.md's "Canonical findings" section groups claims into one F only when
      // they assert the SAME underlying defect -- so any origin's verdict speaks for the
      // finding as a whole, not just for that one origin; this check is NOT origin-count-scoped.
      const anyConfirmed = finding.verifications.some((v) => v.verdict === 'CONFIRMED');
      const anyRefuted = finding.verifications.some((v) => v.verdict === 'REFUTED');
      if (anyConfirmed && finding.final_state === 'settled-refuted') {
        throw new RelayError(
          `finding "${finding.id}" has a verification CONFIRMED but final_state ` +
            '"settled-refuted", which contradicts it'
        );
      }
      if (anyRefuted && finding.final_state === 'settled-agree') {
        throw new RelayError(
          `finding "${finding.id}" has a verification REFUTED but final_state ` +
            '"settled-agree", which contradicts it'
        );
      }
    }
    // "Evidence outranks agreement" as a schema invariant, not just a prompt instruction: a
    // settled-refuted finding needs actual refutation provenance -- a peer's specific
    // counter-fact, the auditor's own independent check, or a falsification verifier's REFUTED
    // verdict -- never just the auditor's bare assertion that it is refuted.
    if (finding.final_state === 'settled-refuted') {
      const peerCounterFact = finding.peer_responses.some((pr) => pr.response === 'disputed-with-counter-fact');
      const auditorRefuted = finding.auditor_check.result === 'REFUTED';
      const verifierRefuted = (finding.verifications ?? []).some((v) => v.verdict === 'REFUTED');
      if (!peerCounterFact && !auditorRefuted && !verifierRefuted) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "settled-refuted" but no refutation ` +
            'provenance exists: no peer_responses entry is "disputed-with-counter-fact", ' +
            'auditor_check.result is not "REFUTED", and no verifications[] entry is "REFUTED" ' +
            '-- a bare auditor assertion cannot settle a claim as refuted'
        );
      }
    }
    // Symmetric to settled-refuted's provenance requirement above: review-protocol.md defines
    // settled-agree as "both sides align, or a falsification-pass verifier returned CONFIRMED"
    // -- absence of refutation is not proof of agreement, same epistemic direction as "absence
    // of proof is not proof against". Note: auditor_check.result CONFIRMED alone is NOT a listed
    // route here (unlike settled-refuted, which explicitly lists auditor_check REFUTED as
    // provenance) -- the protocol text has no equivalent sentence for settled-agree, so it is
    // deliberately excluded until review-protocol.md is updated to say otherwise.
    if (finding.final_state === 'settled-agree') {
      const peerConceded = finding.peer_responses.some((pr) => pr.response === 'conceded');
      const verifierConfirmed = (finding.verifications ?? []).some((v) => v.verdict === 'CONFIRMED');
      if (!finding.independently_discovered && !peerConceded && !verifierConfirmed) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "settled-agree" but no agreement ` +
            'provenance exists: it was not independently_discovered by both seats, no ' +
            'peer_responses entry is "conceded", and no verifications[] entry is "CONFIRMED" ' +
            '-- absence of refutation is not proof of agreement'
        );
      }
      // "A rebuttal overturns a claim only with a specific checkable counter-fact" -- a
      // disputed-with-counter-fact peer response is itself evidence AGAINST the claim, UNLESS a
      // falsification verifier already independently checked that exact dispute and returned
      // CONFIRMED: review-protocol.md's Falsification pass runs precisely on claims with a
      // DISPUTE rebuttal, and its CONFIRMED verdict is the protocol's own designated mechanism
      // for settling a disputed claim in the claim's favor -- the settled-agree table row lists
      // "a falsification-pass verifier returned CONFIRMED" as a route with no carve-out for a
      // prior dispute. Refusing here whenever a counter-fact-dispute existed at all, even after
      // the verifier already checked and confirmed it, would make the auditor's own
      // disputed-no-counter-fact vs. disputed-with-counter-fact classification able to flip a
      // verifier-CONFIRMED finding to unresolved -- exactly the "auditor classification controls
      // the outcome" fragility this mechanical check exists to remove.
      const peerCounterFactAgainst = finding.peer_responses.some((pr) => pr.response === 'disputed-with-counter-fact');
      if (peerCounterFactAgainst && !verifierConfirmed) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "settled-agree" but a peer_responses entry ` +
            'is "disputed-with-counter-fact" with no verifications[] entry of "CONFIRMED" to ' +
            'settle it -- a specific counter-fact contradicts "both sides align" unless a ' +
            'falsification verifier already independently checked and confirmed the claim anyway'
        );
      }
    }
    if (finding.final_state === 'settled-agree' && finding.auditor_check.result === 'REFUTED') {
      throw new RelayError(
        `finding "${finding.id}" has final_state "settled-agree" but auditor_check.result ` +
          '"REFUTED" -- the auditor cannot both independently refute a claim and settle it in its favor'
      );
    }
    if (finding.final_state === 'settled-refuted' && finding.auditor_check.result === 'CONFIRMED') {
      throw new RelayError(
        `finding "${finding.id}" has final_state "settled-refuted" but auditor_check.result ` +
          '"CONFIRMED" -- the auditor cannot both independently confirm a claim and settle it as refuted'
      );
    }
    // dropped-speculative means "SPECULATIVE, neither corroborated nor attacked" per
    // review-protocol.md -- each clause below is one of those three conditions, checked
    // mechanically rather than trusted from the auditor's own classification.
    if (finding.final_state === 'dropped-speculative') {
      // severity_audited needs a CONFIRMED check, which dropped-speculative refuses below, so the claimed severity decides.
      if (finding.severity === 'CRITICAL') {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but is CRITICAL -- an unchecked ` +
            'CRITICAL claim is "unresolved-high-stakes", never dropped from the report'
        );
      }
      if (finding.evidence_strength !== 'SPECULATIVE') {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but evidence_strength ` +
            `"${finding.evidence_strength}" -- only a SPECULATIVE claim can be dropped by this rule`
        );
      }
      if (finding.independently_discovered) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but was independently ` +
            'discovered by both seats -- that is corroboration, not an uncorroborated claim'
        );
      }
      const attacked = finding.peer_responses.some(
        (pr) => pr.response === 'disputed-no-counter-fact' || pr.response === 'disputed-with-counter-fact'
      );
      if (attacked) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but a peer_responses ` +
            'entry disputed it -- a disputed claim was attacked, not merely unaddressed'
        );
      }
      if (finding.auditor_check.result === 'CONFIRMED' || finding.auditor_check.result === 'REFUTED') {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but auditor_check.result ` +
            `"${finding.auditor_check.result}" -- a claim the auditor independently settled is no ` +
            'longer merely an untouched speculative item'
        );
      }
      // A falsification verifier having run at all -- any verdict, including INCONCLUSIVE --
      // means the claim was independently checked, not merely an untouched speculative item;
      // "dropped-speculative" requires zero verifications, same principle as the
      // auditor_check.result check above but for the separate falsification-verifier mechanism.
      if ((finding.verifications ?? []).length > 0) {
        throw new RelayError(
          `finding "${finding.id}" has final_state "dropped-speculative" but has a non-empty ` +
            'verifications array -- a claim a falsification verifier independently checked is no ' +
            'longer merely an untouched speculative item, regardless of the verdict reached'
        );
      }
    }
  }
  if (phase1Dir) await checkPhase1Coverage(translated.findings, phase1Dir);
  if (verificationDir) await checkVerificationsAgainstDir(translated.findings, verificationDir, mapping);
  translated.protocol = 'review-protocol-v1.3';
  translated.audit_depth = auditDepth;
  return translated;
}

// Counts what relabelText will actually touch, so a wrong --from that matches
// nothing fails loudly instead of writing a byte-identical "success". Must walk lines the same
// way relabelText does (raw-line header/rebuttal test, span-scoped claim-ID search), or the two
// can disagree on a line like "`x`# Seat A findings" -- counted as a target here but correctly
// left untouched there (or vice versa).
function countRelabelTargets(text, from, extraIds = []) {
  const { lines } = parseFenceLines(text);
  const claimId = buildClaimIdRe(new Set([...realClaimIds(text, from), ...extraIds]));
  const seatHeader = new RegExp(`^# Seat ${from} findings.*$`);
  const rebuttalHeading = /^## Rebuttals \(from ([A-Z])\) of ([A-Z]) claims$/;
  let count = 0;
  for (const { text: line, inFence } of lines) {
    if (!inFence) {
      if (seatHeader.test(line)) { count += 1; continue; }
      const rebuttalMatch = rebuttalHeading.exec(line);
      if (rebuttalMatch) {
        if (rebuttalMatch[1] === from || rebuttalMatch[2] === from) count += 1;
        continue;
      }
    }
    if (claimId === null) continue;
    for (const span of splitLineSpans(line, inFence)) {
      if (span.code) continue;
      count += (span.text.match(claimId) || []).length;
    }
  }
  return count;
}

// --phase1-dir on relabel: the --from seat's real IDs from its own Phase 1 file, so a Phase 3
// second pass also rewrites prose cross-references to the peer's claims.
async function phase1ExtraIds(from, phase1Dir) {
  if (!phase1Dir) return [];
  if (from !== 'A' && from !== 'B') {
    throw new RelayError('relabel --phase1-dir is only meaningful with --from A or --from B');
  }
  return [...realClaimIds(await readPhase1Seat(from, phase1Dir), from)];
}

async function runRelabel(args) {
  const text = await readUtf8(args.in);
  const extraIds = await phase1ExtraIds(args.from, args.phase1Dir);
  if (text.length > 0 && countRelabelTargets(text, args.from, extraIds) === 0) {
    throw new RelayError(
      `no "${args.from}" claim IDs, seat header, or rebuttal heading found in ${args.in}; ` +
        `wrong --from? (a legitimate zero case is a Phase 3 second pass on a file whose peer had ` +
        `zero findings — verify --in/--from before assuming this is that case)`
    );
  }
  const out = relabelText(text, args.from, args.to, extraIds);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, out);
  io.out(`relabeled ${args.from} -> ${args.to}, wrote ${args.out}\n`);
}

// Library half of scan: every hit class for one text, no printing, no exit.
async function collectScanHits(text, opts) {
  const vendorText = opts.targetDir ? await readTargetText(opts.targetDir) : null;
  // The run folder and its parent hold the run's own evidence and work folders, which seats cite.
  const runDir = opts.phase1Dir ? path.dirname(path.resolve(opts.phase1Dir)) : null;
  const maskDirs = [...(opts.sourceDirs ?? []), ...(runDir ? [runDir, path.dirname(runDir)] : [])];
  const { selfIdHits, identityHits, otherHits } = await scanText(text, opts.targetDir, opts.tokens ?? [], vendorText, maskDirs, opts.sourceDirs ?? []);
  const needTarget = (opts.forbidSeats || opts.peerIds) && opts.targetText === undefined;
  const targetText = needTarget ? await readExemptText(opts.targetDir, opts.sourceDirs ?? []) : opts.targetText ?? null;
  const allClaimIdHits = opts.forbidSeats
    ? await scanForKnownClaimIdLeaks(text, opts.phase1Dir, opts.forbidSeats, targetText)
    : [];
  const allPeerLabelHits = opts.peerIds ? scanForPeerLabelLeaks(text, opts.peerIds, targetText, opts.checklist ?? []) : [];
  const claimIdHits = allClaimIdHits.filter((h) => !h.targetDerived);
  const peerLabelHits = allPeerLabelHits.filter((h) => !h.targetDerived);
  const derivedIdHits = [...allClaimIdHits, ...allPeerLabelHits].filter((h) => h.targetDerived);
  const trustHits = opts.targetUrls ? scanForTargetUrls(text, opts.targetUrls) : [];
  const blocking = selfIdHits.length + identityHits.length + claimIdHits.length + peerLabelHits.length;
  return { selfIdHits, identityHits, otherHits, claimIdHits, peerLabelHits, derivedIdHits, trustHits, blocking };
}

function logScanHits(hits, label = '') {
  const pre = label ? `${label}: ` : '';
  for (const h of hits.otherHits) {
    log(`${pre}report line ${h.line}${h.targetDerived ? ' (target-derived)' : ''}: ${h.text}`);
  }
  for (const h of hits.derivedIdHits) {
    log(`${pre}report line ${h.line} (target-derived "${h.id}", chunk or line occurs in the target): ${h.text}`);
  }
  for (const h of hits.trustHits) {
    log(`${pre}TRUST-BOUNDARY line ${h.line}: ${h.url} is a URL embedded in the target; confirm it was not fetched`);
  }
  for (const h of hits.identityHits) {
    const matched = [...(h.tokens ?? []), ...(h.seatMention ? ['a seat mention'] : [])];
    log(`${pre}IDENTITY line ${h.line}${matched.length > 0 ? ` [matched: ${matched.join(', ')}]` : ''}: ${h.text}`);
  }
  for (const h of hits.claimIdHits) {
    log(`${pre}CLAIM-ID LEAK line ${h.line} (real "${h.id}" survives relabel): ${h.text}`);
  }
  for (const h of hits.peerLabelHits) {
    log(`${pre}PEER-LABEL LEAK line ${h.line} (Phase 2 "${h.id}" survives into this file): ${h.text}`);
  }
  for (const h of hits.selfIdHits) log(`${pre}SELF-IDENTIFICATION line ${h.line}: ${h.text}`);
}

async function runScan(args) {
  const text = await readUtf8(args.in);
  const hits = await collectScanHits(text, {
    targetDir: args.targetDir,
    sourceDirs: args.sourceDirs,
    checklist: args.checklist,
    tokens: parseTokensArg(args.tokens),
    phase1Dir: args.phase1Dir,
    forbidSeats: args.forbidSeats ? args.forbidSeats.split(',') : null,
    peerIds: args.phase2Dir ? await readPhase2PeerIds(args.phase2Dir) : null,
    targetUrls: args.targetUrls ? await readTargetUrls(args.targetUrls) : null,
  });
  logScanHits(hits);
  if (hits.blocking > 0) {
    log(
      `${hits.selfIdHits.length} self-identification match(es), ${hits.identityHits.length} other ` +
        `non-target-derived identity match(es), ${hits.claimIdHits.length} real claim-ID leak(es), ` +
        `${hits.peerLabelHits.length} Phase 2 peer-label leak(es); ` +
        'return this file for redaction, do not forward'
    );
    throw new StepExit(1);
  }
  io.out(
    `scan clean: 0 identity matches, ${hits.otherHits.length + hits.derivedIdHits.length} target-derived reported, ` +
      `${hits.trustHits.length} trust-boundary URL(s) reported\n`
  );
}

async function runFlip(args) {
  const mapping = flipMapping();
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(mapping, null, 2) + '\n');
  io.out(`wrote ${args.out}\n`);
}

async function runTranslate(args) {
  const [auditJson, mappingJson] = await Promise.all([
    readUtf8(args.in),
    readUtf8(args.mapping),
  ]);
  let mapping;
  try {
    mapping = JSON.parse(mappingJson);
  } catch (err) {
    throw new RelayError(`--mapping is not valid JSON: ${err.message}`);
  }
  const translated = await translateFindings(auditJson, mapping, args.phase1Dir, args.verificationDir, args.checklist ?? [], args.auditDepth ?? 'full');
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  // Through a temp file: a later step treats findings.json as the finished audit.
  await writeFileAtomic(args.out, JSON.stringify(translated, null, 2) + '\n');
  io.out(`translated ${translated.findings.length} finding(s), wrote ${args.out}\n`);
}

// Checks every claim block in both seats' real Phase 1 files against claimBlockProblems, listing
// EVERY failure across every claim (not first-fail) so a reformatting round can fix them all at
// once instead of one RelayError per re-run -- the same "collect, don't stop at first" reasoning
// runScan already applies for identity hits. Meant to gate Phase 1 (before Phase 2 exchange) and
// again after any reformatting round, per the phase-1/phase-2 docs.
// Stricter than relabel's own rebuttalHeading regex ([A-Z]): restricted to [AB] since a Phase 1
// file only ever carries real A/B letters, so anything this accepts also matches relabel's
// regex -- a validate-clean file never has a heading relabel would fail to recognize.
// Deliberately placement-agnostic: phase-2-cross-examination.md and review-protocol.md
// standardize placement in prose (onto the PEER's file), but relabel itself relabels a seat's
// letter wherever the heading appears. The only universally-invalid case this check rejects
// is a seat naming itself as its own rebutter.
const REBUTTAL_HEADING_EXACT_RE = /^## Rebuttals \(from ([AB])\) of ([AB]) claims$/;
const REBUTTAL_HEADING_LIKE_RE = /^##\s+Rebuttals\b/;

// Rebuttal sections by line range: from a "## Rebuttals..." heading to the next "## " heading
// that is neither claim-shaped nor another rebuttal heading (or EOF). rebutter is null if malformed.
function rebuttalSections(fenceLines) {
  const sections = [];
  let open = null;
  fenceLines.forEach(({ text: line, inFence }, i) => {
    if (inFence || !/^##\s+/.test(line)) return;
    if (REBUTTAL_HEADING_LIKE_RE.test(line.trim())) {
      if (open) sections.push(open);
      const ex = REBUTTAL_HEADING_EXACT_RE.exec(line);
      open = { start: i + 1, end: Infinity, rebutter: ex ? ex[1] : null, of: ex ? ex[2] : null, heading: line.trim() };
      return;
    }
    if (open && !CLAIM_LIKE_HEADING_RE.test(line)) {
      open.end = i;
      sections.push(open);
      open = null;
    }
  });
  if (open) sections.push(open);
  return sections;
}

// Every validate problem for both seats' texts; each problem names the seat to return it to.
// seats narrows the check to one file (validate --seat) while the other seat is still running;
// the peer's claim IDs are then unknown, so the full two-seat validate must still run later.
function validateProblems(textsBySeat, targetText = null, seats = ['A', 'B']) {
  const problems = [];
  // Every seat's claim IDs, also of a seat file that cannot be parsed yet: a peer's ID in this seat's code is found now,
  // not after both rewrites are spent.
  // In a file with an unclosed fence every heading line counts: a heading after a stray opener is still that seat's claim.
  // Two stray fence lines that balance cannot be told from a quoted claim block, so a closed fence's headings are quotes.
  const runIds = new Set(Object.keys(textsBySeat).flatMap((s) => {
    const { lines, unterminated } = parseFenceLines(textsBySeat[s] ?? '');
    return lines.filter((l) => unterminated || !l.inFence).map((l) => CLAIM_HEADING_RE.exec(l.text)?.[1]).filter(Boolean);
  }));
  const runIdRe = buildClaimIdRe(runIds);
  for (const seat of seats) {
    const text = textsBySeat[seat];
    const { blocks, malformedHeadings, duplicateIds, noFindingsMarker } = extractClaimBlocks(text);
    const { lines: fenceLines } = parseFenceLines(text);
    const sections = rebuttalSections(fenceLines);
    const add = (problemText) => problems.push({ text: problemText, returnTo: seat });
    const sectionAt = (line) => sections.find((s) => line >= s.start && line <= s.end) ?? null;
    // A claim-shaped "##" heading inside a rebuttal section was written by the rebutting seat.
    const rebuttalEntryProblem = (line, text) => {
      const s = sectionAt(line);
      if (s === null) return null;
      const who = s.rebutter ? `seat ${s.rebutter} (the rebutting seat that wrote it)` : 'the rebutting seat that wrote it';
      return {
        text:
          `${seat}-findings.md:${line}: heading "${text}" sits inside "${s.heading}" -- rebuttal ` +
          `entries must use "### <id>" headings, not "##"; return this section to ${who}, not to seat ${seat}`,
        returnTo: s.rebutter ?? 'rebutter',
      };
    };
    // relabel's second (peer-letter) pass legitimately exits nonzero with "no <letter> claim IDs,
    // seat header, or rebuttal heading found" when a seat had zero rebuttals to append -- that
    // exit code is documented as expected, not a failure, so a malformed rebuttal heading must be
    // caught here instead: it produces the identical "no match" signal to relabel and would
    // otherwise be silently routed around the same way.
    // Fence-aware and tested against the RAW line, exactly like relabel's own rebuttalHeading
    // check (never trimmed, never applied inside a fence) -- a looser test here (trim, or ignore
    // fences) could accept a heading relabel itself would not recognize (e.g. trailing
    // whitespace), or flag one quoted verbatim inside an Evidence fence as if it were real.
    fenceLines.forEach(({ text: line, inFence }, i) => {
      if (inFence) return;
      const likeMatch = REBUTTAL_HEADING_LIKE_RE.test(line.trim());
      if (!likeMatch) return;
      const exactMatch = REBUTTAL_HEADING_EXACT_RE.exec(line);
      if (exactMatch && exactMatch[1] !== exactMatch[2]) return;
      if (exactMatch) {
        add(
          `${seat}-findings.md:${i + 1}: heading "${line.trim()}" names a seat rebutting its own ` +
            'claims ("from X) of X") -- a rebuttal always addresses the PEER\'s claims, never ' +
            'the same seat\'s own'
        );
        return;
      }
      add(
        `${seat}-findings.md:${i + 1}: heading "${line.trim()}" looks like a rebuttal-section ` +
          'heading but does not match the required "## Rebuttals (from <letter>) of <letter> ' +
          'claims" form -- relabel\'s "no rebuttal heading found" exit is expected for a seat ' +
          'with zero rebuttals, so a malformed heading here would be silently indistinguishable ' +
          'from that case instead of being caught as a formatting defect'
      );
    });
    // relabel never rewrites code, so a real claim ID in a fence or inline code survives into the blind.
    fenceLines.forEach(({ text: line, inFence }, i) => {
      if (runIdRe === null) return;
      const codeText = splitLineSpans(line, inFence).filter((s) => s.code).map((s) => s.text).join(' ');
      const ids = new Set(codeText.match(runIdRe) || []);
      for (const id of ids) {
        if (targetDerivedHit(line, id, targetText)) continue;
        const s = sectionAt(i + 1);
        const returnTo = s ? s.rebutter ?? 'rebutter' : seat;
        const who = returnTo === 'rebutter' ? 'the rebutting seat' : `seat ${returnTo}`;
        problems.push({
          text:
            `${seat}-findings.md:${i + 1}: claim ID "${id}" inside ${inFence ? 'a fence' : 'inline code'} -- ` +
            `relabel never rewrites code, so it would leak through the blind; return to ${who} to move ` +
            `the reference out of the code: ${line.trim()}`,
          returnTo,
        });
      }
    });
    for (const [id, block] of blocks) {
      const inRebuttal = rebuttalEntryProblem(block.line, `## ${id}`);
      if (inRebuttal) { problems.push(inRebuttal); continue; }
      // Wrong-seat heading: a real "## B<n>" heading inside A-findings.md (CLAIM_HEADING_RE
      // matches [AB]\d+ regardless of which file it's in, since the regex has no seat context --
      // this is the one malformation class only the caller, which DOES know which file it's
      // reading, can catch).
      if (id[0] !== seat) {
        add(`${seat}-findings.md: claim "${id}" uses seat "${id[0]}"'s letter, not this file's own seat "${seat}"`);
        continue;
      }
      for (const p of claimBlockProblems(block)) {
        add(`${seat}-findings.md: claim "${id}" has ${p}`);
      }
      if (block.sameShape === null) add(`${seat}-findings.md: claim "${id}" has no "Same shape elsewhere:" line (name the other places with the same shape, or write "none found" and what you searched)`);
    }
    for (const m of malformedHeadings) {
      const inRebuttal = rebuttalEntryProblem(m.line, m.text);
      if (inRebuttal) { problems.push(inRebuttal); continue; }
      add(
        `${seat}-findings.md:${m.line}: heading "${m.text}" looks like an attempted claim ID ` +
          `("${m.attempted}") but does not match the required "## ${seat}<n>" form -- a model ` +
          'ignoring the claim-ID schema (e.g. a bare "## 1") must not be mistaken for a genuine ' +
          'zero-findings pass'
      );
    }
    for (const d of duplicateIds) {
      const inRebuttal = rebuttalEntryProblem(d.line, d.text);
      if (inRebuttal) { problems.push(inRebuttal); continue; }
      add(
        `${seat}-findings.md:${d.line}: claim "${d.id}" heading appears more than once -- a ` +
          'duplicate real claim ID would silently collapse two different claims into one for ' +
          'mechanical derivation'
      );
    }
    // A seat with zero real claim blocks AND zero malformed-heading attempts must still carry the
    // fixed "## No findings" marker -- otherwise "the model wrote nothing claim-shaped" and "the
    // model genuinely found nothing" are mechanically indistinguishable, the exact ambiguity a
    // live run's false-clean validate result exposed.
    if (blocks.size === 0 && malformedHeadings.length === 0 && !noFindingsMarker) {
      add(
        `${seat}-findings.md: has zero recognized claim headings and no "## No findings" marker ` +
          '-- an empty or unparseable result is never treated as a legitimate zero-findings ' +
          'verdict; the seat must state it explicitly'
      );
    }
  }
  return problems;
}

function logValidateProblems(problems) {
  for (const p of problems) log(p.text);
  const seats = [...new Set(problems.map((p) => p.returnTo))].map((s) => (s === 'rebutter' ? 'the rebutting seat' : `seat ${s}`));
  log(`${problems.length} claim block problem(s); return the affected seat's file to its own ` +
    `context for reformatting -- return to: ${seats.join(', ')} (a problem inside a rebuttal ` +
    'section goes to the rebutting seat named on its line) -- same procedure as a scan ' +
    'redaction round, never a hand edit');
}

// "service.py:345" or "src/x.mjs:12-18" in a claim's Evidence: warns when the line is past the end of
// every file of that name under --target-dir and each --source-dir. A bare name is first narrowed to
// the paths the task packet names ("billing/service.py"), since a repository can hold dozens of
// service.py files. A path found nowhere is left alone: seats also cite logs and outside files.
const CITATION_RE = /(?<![\w/\\.:-])((?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?(?![\w.:-])/g;
const PACKET_PATH_RE = /[\w.-]+(?:[\\/][\w.-]+)+/g;

async function citationWarnings(texts, dirs, packetText = '') {
  const roots = dirs.filter(Boolean);
  if (roots.length === 0) return [];
  const packetPaths = [...new Set((packetText.match(PACKET_PATH_RE) ?? []).map((p) => p.replace(/\\/g, '/')))];
  const listed = [];
  for (const root of roots) {
    const names = gitListedNames(root) ?? (await walkNames(root));
    for (const rel of names) listed.push({ root, rel: rel.split(path.sep).join('/') });
  }
  const lineCounts = new Map();
  const countLines = async (file) => {
    if (!lineCounts.has(file)) {
      let n = null;
      try {
        const text = await fs.readFile(file, 'utf8');
        n = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch (err) {
        if (err.code !== 'EISDIR' && err.code !== 'ENOENT') log(`validate: cannot read ${file} to check a citation: ${err.message}`);
      }
      lineCounts.set(file, n);
    }
    return lineCounts.get(file);
  };
  const warnings = [];
  for (const [seat, text] of Object.entries(texts)) {
    for (const [id, block] of extractClaimBlocks(text).blocks) {
      for (const m of (block.evidence ?? '').matchAll(CITATION_RE)) {
        const cited = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
        const line = Number(m[3] ?? m[2]);
        let matches = listed.filter(({ rel }) => rel === cited || rel.endsWith(`/${cited}`));
        const named = packetPaths.filter((p) => p === cited || p.endsWith(`/${cited}`));
        const narrowed = matches.filter(({ rel }) => named.some((p) => rel === p || rel.endsWith(`/${p}`)));
        if (narrowed.length > 0) matches = narrowed;
        const sizes = [];
        for (const { root, rel } of matches) {
          const n = await countLines(path.join(root, rel));
          if (n !== null) sizes.push([rel, n]);
        }
        if (sizes.length === 0 || sizes.some(([, n]) => line <= n)) continue;
        const [rel, n] = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
        warnings.push(`seat ${seat} ${id} cites ${m[0]}, but ${rel} has ${n} lines${sizes.length > 1 ? ` (the longest of ${sizes.length} files of that name)` : ''}`);
      }
    }
  }
  return warnings;
}

// The Phase 1 seat files' claim-level problems as validate reads them (both seats together, so a peer's claim ID in a
// seat's code is found), by seat, for review-run's format check to send back in each seat's one rewrite. An unterminated
// fence is one problem of that seat. A target or source folder that cannot be read stops the step instead. What the
// reading logs is kept out of review-run's output.
async function seatClaimProblems(textsBySeat, { targetDir = null, sourceDirs = [] } = {}) {
  const saved = io.err;
  io.err = () => true;
  try {
    const targetText = await readExemptText(targetDir, sourceDirs);
    const seats = Object.keys(textsBySeat);
    const bySeat = Object.fromEntries(seats.map((s) => [s, []]));
    const unparsed = seats.filter((s) => {
      try { extractClaimBlocks(textsBySeat[s]); return false; } catch (err) {
        if (!(err instanceof RelayError)) throw err;
        bySeat[s].push(err.message);
        return true;
      }
    });
    const parsed = seats.filter((s) => !unparsed.includes(s));
    if (parsed.length > 0) {
      for (const p of validateProblems(textsBySeat, targetText, parsed)) if (p.returnTo in bySeat) bySeat[p.returnTo].push(p.text);
    }
    return bySeat;
  } finally {
    io.err = saved;
  }
}

async function runValidate(args) {
  const seats = args.seat ? [args.seat] : ['A', 'B'];
  const texts = {};
  for (const seat of seats) texts[seat] = await readPhase1Seat(seat, args.phase1Dir);
  const problems = validateProblems(texts, await readExemptText(args.targetDir, args.sourceDirs), seats);
  if (problems.length > 0) {
    logValidateProblems(problems);
    throw new StepExit(1);
  }
  // A warning, not a refusal: the claim can still be right with a wrong line number.
  const packetText = args.packet ? await readRequired(args.packet, '--packet') : '';
  for (const w of await citationWarnings(texts, [args.targetDir, ...(args.sourceDirs ?? [])], packetText)) {
    log(`WARNING: ${w}; ask the seat to correct the line in its own file, or note it in the report`);
  }
  for (const [seat, text] of Object.entries(texts)) {
    for (const [id, block] of extractClaimBlocks(text).blocks) {
      if ((block.severity === 'HIGH' || block.severity === 'CRITICAL') && block.trigger === null) {
        log(`WARNING: seat ${seat} ${id} is ${block.severity} with no "Trigger:" line; the report cannot say what input makes it happen or how often`);
      }
    }
  }
  if (args.seat) {
    io.out(
      `validate clean (seat ${args.seat} only): its claim blocks and rebuttal headings are well formed; ` +
        'run validate without --seat once both files exist, since the other seat\'s claim IDs were not checked\n'
    );
    return;
  }
  io.out('validate clean: every claim block in both seats has a recognized Severity/Basis/Evidence strength/Evidence, and every rebuttal-section heading matches the required form\n');
}

// Rebuttal entries for one letter within [start, end] (1-based lines): an entry opens at a
// "##"/"###" <L><n> heading, or at a "Claim:" line when the open entry already has one.
function parseRebuttalEntries(fenceLines, letter, start = 1, end = Infinity) {
  const headRe = new RegExp(`^#{2,3}\\s+(${letter}\\d+)\\b`);
  const claimRe = new RegExp(`^Claim:\\s*(${letter}\\d+)\\b`);
  const actionRe = /^Action:\s*([A-Za-z_-]+)/;
  const entries = [];
  let cur = null;
  fenceLines.forEach(({ text: line, inFence }, i) => {
    const lineNo = i + 1;
    if (lineNo < start || lineNo > end || inFence) return;
    const h = headRe.exec(line);
    if (h) {
      cur = { headingId: h[1], claim: null, action: null, line: lineNo };
      entries.push(cur);
      return;
    }
    const c = claimRe.exec(line);
    if (c) {
      if (cur === null || cur.claim !== null) {
        cur = { headingId: null, claim: null, action: null, line: lineNo };
        entries.push(cur);
      }
      cur.claim = c[1];
      return;
    }
    const a = actionRe.exec(line);
    if (a && cur !== null && cur.action === null) cur.action = a[1];
  });
  for (const e of entries) e.id = e.claim ?? e.headingId;
  return entries;
}

const REBUTTAL_ACTIONS = new Set(['CONCEDE', 'DISPUTE']);

// Writes via a same-directory temp file + rename, so a failure never leaves a half-written target.
// mode, when given, applies from creation (no world-readable window before a chmod).
async function writeFileAtomic(filePath, content, mode = undefined) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, mode === undefined ? undefined : { mode, flag: 'wx' });
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function readRequired(filePath, flag) {
  try {
    return await readUtf8(filePath);
  } catch (err) {
    throw new RelayError(`${flag}: could not read ${filePath}: ${err.message}`);
  }
}

async function runAppendRebuttals(args) {
  const rebutter = args.rebutter;
  const peer = rebutter === 'A' ? 'B' : 'A';
  if (path.basename(args.onto) !== `${peer}-findings.md`) {
    throw new RelayError(`--onto must be the peer's Phase 1 file "${peer}-findings.md" (rebutter ${rebutter} rebuts ${peer}'s claims), got ${args.onto}`);
  }
  const [raw, peerViewText, onto] = await Promise.all([
    readRequired(args.in, '--in'),
    readRequired(args.peerView, '--peer-view'),
    readRequired(args.onto, '--onto'),
  ]);
  const peerIds = peerViewClaimIds(peerViewText);
  if (peerIds.size === 0) {
    throw new RelayError(`--peer-view ${args.peerView} has no "## P<n>" claims; there is nothing to rebut or append`);
  }
  const { lines: rawLines, unterminated } = parseFenceLines(raw);
  if (unterminated) throw new RelayError('--in: unterminated fenced code block, fix the file and re-run');
  const problems = [];
  const targetText = await readExemptText(args.targetDir, args.sourceDirs);
  // relabel never rewrites fences or inline code, so a peer-view P id there would leak into Phase 3.
  const checkCode = (codeText, lineNo, where, line) => {
    for (const tok of maskChecklistLabels(codeText, args.checklist ?? []).match(/\bP\d+\b/g) || []) {
      if (peerIds.has(tok)) {
        if (targetDerivedHit(line, tok, targetText)) {
          log(`--in:${lineNo}: report (target-derived "${tok}" inside ${where}, chunk or line occurs in the target): ${line.trim()}`);
          continue;
        }
        problems.push(`--in:${lineNo}: "${tok}" inside ${where} names a peer-view claim; relabel never rewrites it, so it would leak into Phase 3 -- move the reference out of the code`);
      }
    }
  };
  const normalized = rawLines
    .map(({ text: line, inFence, eol }, i) => {
      if (inFence) {
        checkCode(line, i + 1, 'a fence', line);
        return line + eol;
      }
      for (const span of splitLineSpans(line, false)) if (span.code) checkCode(span.text, i + 1, 'inline code', line);
      if (REBUTTAL_HEADING_LIKE_RE.test(line.trim())) {
        problems.push(`--in:${i + 1}: "${line.trim()}" -- the raw file must hold only the entries; append-rebuttals writes the section heading itself`);
      }
      return (/^##\s+P\d+\b/.test(line) ? `#${line}` : line) + eol;
    })
    .join('');
  const entries = parseRebuttalEntries(parseFenceLines(normalized).lines, 'P');
  const seen = new Map();
  for (const e of entries) {
    if (e.headingId !== null && e.claim !== null && e.headingId !== e.claim) {
      problems.push(`--in:${e.line}: entry heading "${e.headingId}" has a "Claim: ${e.claim}" line naming a different claim`);
    }
    if (!REBUTTAL_ACTIONS.has(e.action)) {
      problems.push(`--in:${e.line}: entry "${e.id}" has no "Action: CONCEDE" or "Action: DISPUTE" line`);
    }
    if (!peerIds.has(e.id)) problems.push(`--in:${e.line}: entry "${e.id}" is not a claim in --peer-view`);
    seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) problems.push(`--in: claim "${id}" has ${n} entries; exactly one is required`);
  const gaps = [...peerIds].filter((id) => !seen.has(id));
  if (gaps.length > 0) problems.push(`--in: no rebuttal entry for peer-view claim(s) [${gaps.join(', ')}]`);
  const heading = `## Rebuttals (from ${rebutter}) of ${peer} claims`;
  if (parseFenceLines(onto).lines.some((l) => !l.inFence && l.text === heading)) {
    problems.push(`--onto already contains "${heading}"; refusing to append a second section`);
  }
  if (problems.length > 0) {
    for (const p of problems) log(p);
    throw new RelayError(`${problems.length} rebuttal problem(s); --onto left unchanged -- return --in to seat ${rebutter} to fix`);
  }
  const body = relabelText(normalized, 'P', peer, [...peerIds], args.checklist ?? []).replace(/^(?:[ \t]*\r?\n)+/, '');
  const base = onto.length === 0 || onto.endsWith('\n') ? onto : `${onto}\n`;
  const newOnto = `${base}\n${heading}\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
  const sibling = path.join(path.dirname(args.onto), `${rebutter}-findings.md`);
  const texts = { [peer]: newOnto, [rebutter]: await readRequired(sibling, '--onto sibling') };
  const validation = validateProblems(texts, targetText);
  if (validation.length > 0) {
    logValidateProblems(validation);
    throw new RelayError('validate failed on the appended result; --onto left unchanged');
  }
  await writeFileAtomic(args.onto, newOnto);
  io.out(`appended ${entries.length} rebuttal(s) from ${rebutter} to ${args.onto}; validate clean\n`);
}

// HIGH/CRITICAL claims per seat and what the peer's rebuttal section did with each. disputed_ids names the disputed ones
// (the claims a verifier must check), in the anonymous labels when the seat-to-label mapping is given.
function falsificationBreakdown(textsBySeat, mapping = null) {
  const out = { high_or_critical: 0, disputed: 0, conceded: 0, unaddressed: 0, disputed_ids: [] };
  for (const seat of ['A', 'B']) {
    const actions = new Map();
    for (const text of Object.values(textsBySeat)) {
      const { lines } = parseFenceLines(text);
      for (const s of rebuttalSections(lines).filter((sec) => sec.of === seat)) {
        for (const e of parseRebuttalEntries(lines, seat, s.start, s.end)) {
          if (!actions.has(e.id)) actions.set(e.id, e.action);
        }
      }
    }
    for (const [id, block] of extractClaimBlocks(textsBySeat[seat]).blocks) {
      if (id[0] !== seat || (block.severity !== 'HIGH' && block.severity !== 'CRITICAL')) continue;
      out.high_or_critical += 1;
      const action = actions.get(id);
      if (action === 'DISPUTE') {
        out.disputed += 1;
        out.disputed_ids.push(mapping?.[seat] ? `${mapping[seat]}${id.slice(1)}` : id);
      } else if (action === 'CONCEDE') out.conceded += 1;
      else out.unaddressed += 1;
    }
  }
  return out;
}

function sameDir(a, b) {
  return comparablePath(a) === comparablePath(b);
}

// A seat whose peer view held claims must have its rebuttal section in the peer's findings file,
// unless exchange.mjs finish recorded it as incomplete. Without this, staging after a refused
// finish (which restores both files) would send the auditor findings with no rebuttals at all.
async function requireAppendedRebuttals(phase2Dir, texts) {
  let incomplete = [];
  try {
    incomplete = JSON.parse(await readUtf8(path.join(phase2Dir, 'exchange-result.json'))).incomplete ?? [];
  } catch {
    // No record: a hand-run exchange; the headings below are the only evidence.
  }
  for (const seat of ['A', 'B']) {
    const peer = seat === 'A' ? 'B' : 'A';
    let peerView;
    try {
      peerView = await readUtf8(path.join(phase2Dir, `peer-view-for-${seat}.md`));
    } catch {
      continue;
    }
    if (!/^## P\d+\b/m.test(peerView) || incomplete.includes(seat)) continue;
    if (!new RegExp(`^## Rebuttals \\(from ${seat}\\) of ${peer} claims\\s*$`, 'm').test(texts[peer])) {
      throw new RelayError(
        `seat ${seat} had peer claims to rebut (peer-view-for-${seat}.md), but ${peer}-findings.md has no ` +
          `"## Rebuttals (from ${seat}) of ${peer} claims" section: run review-run phase2 --wait until it succeeds ` +
          `(a seat that cannot finish its exchange makes the review incomplete); nothing written to --out-dir`
      );
    }
  }
}

async function runAuditPrep(args, { renameFn = fs.rename } = {}) {
  let mapping;
  try {
    mapping = JSON.parse(await readRequired(args.mapping, '--mapping'));
  } catch (err) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(`--mapping is not valid JSON: ${err.message}`);
  }
  invertSeatMapping(mapping);
  if (sameDir(args.outDir, args.phase1Dir) || sameDir(args.outDir, path.dirname(path.resolve(args.mapping)))) {
    throw new RelayError('--out-dir must differ from --phase1-dir and from the mapping file\'s folder; the auditor reads everything in it');
  }
  if (args.breakdownOut && isInsidePath(args.breakdownOut, args.outDir)) {
    throw new RelayError('--breakdown-out must not be inside --out-dir; the auditor reads everything there (write it in the run directory, e.g. phase3/falsification-breakdown.json)');
  }
  let existing = [];
  try {
    existing = await fs.readdir(args.outDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new RelayError(`--out-dir: could not read ${args.outDir}: ${err.message}`);
  }
  if (existing.length > 0) {
    throw new RelayError(
      `--out-dir ${args.outDir} is not empty (${existing.join(', ')}); it must hold only the files audit-prep ` +
        'writes -- pass a new empty folder (with --packet, audit-prep stages the packet and protocol itself)'
    );
  }
  // Read (byte-exact) before any write, so a bad --packet path never leaves a half-staged folder.
  const readBytes = async (filePath, flag) => {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      throw new RelayError(`${flag}: could not read ${filePath}: ${err.message}`);
    }
  };
  const staged = args.packet
    ? {
        'task-packet.md': await readBytes(args.packet, '--packet'),
        'review-protocol.md': Buffer.from(auditorProtocol((await readBytes(PROTOCOL_PATH, 'bundled review-protocol.md')).toString('utf8')), 'utf8'),
      }
    : {};
  const texts = { A: await readPhase1Seat('A', args.phase1Dir), B: await readPhase1Seat('B', args.phase1Dir) };
  const targetText = await readExemptText(args.targetDir, args.sourceDirs);
  const problems = validateProblems(texts, targetText);
  if (problems.length > 0) {
    logValidateProblems(problems);
    throw new RelayError('--phase1-dir does not validate; nothing written to --out-dir');
  }
  if (args.phase2Dir) await requireAppendedRebuttals(args.phase2Dir, texts);
  const peerIds = args.phase2Dir ? await readPhase2PeerIds(args.phase2Dir) : null;
  const finals = {};
  let blocked = 0;
  for (const seat of ['A', 'B']) {
    const peer = seat === 'A' ? 'B' : 'A';
    const pass1 = relabelText(texts[seat], seat, mapping[seat]);
    // Zero peer-letter targets (no rebuttals, no cross-references) is a valid second pass here.
    const relabeled = relabelText(pass1, peer, mapping[peer], [...realClaimIds(texts[peer], peer)]);
    const name = `${mapping[seat]}-findings.md`;
    // A run-folder path a seat pasted must not show the auditor where the run's records are.
    const { text: pass2, count: runPaths } = scrubDir(relabeled, path.dirname(path.resolve(args.phase1Dir)));
    if (runPaths > 0) log(`${name}: ${runPaths} run-folder path(s) written as <run-dir>`);
    // The run-folder guard reads every other spelling (~, variables, a drive-less or short name, a link): one left blocks.
    const runPathLeft = runDirNamedIn(pass2, path.dirname(path.resolve(args.phase1Dir)), args.targetDir ?? null);
    if (runPathLeft) {
      log(`${name}: RUN-FOLDER PATH still named (${runPathLeft.leaked}${runPathLeft.resolved ? ', which resolves into it' : ''}); return it to its seat to cite the path another way`);
      blocked += 1;
    }
    const hits = await collectScanHits(pass2, {
      targetDir: args.targetDir,
      sourceDirs: args.sourceDirs,
      tokens: parseTokensArg(args.tokens),
      phase1Dir: args.phase1Dir,
      forbidSeats: ['A', 'B'],
      peerIds,
      targetText,
      checklist: args.checklist,
    });
    logScanHits(hits, name);
    blocked += hits.blocking;
    finals[name] = pass2;
  }
  if (blocked > 0) {
    throw new RelayError(`${blocked} blocking scan hit(s); nothing written to --out-dir -- return the named file(s) for redaction`);
  }
  // The breakdown first, then every staged file in a sibling folder renamed into place last: an interrupted run leaves
  // --out-dir empty (at most a .staging-* sibling), so the same step can run again.
  const breakdownLine = `${JSON.stringify({ falsificationBreakdown: falsificationBreakdown(texts, mapping) })}\n`;
  if (args.breakdownOut) {
    await fs.mkdir(path.dirname(path.resolve(args.breakdownOut)), { recursive: true });
    await writeFileAtomic(args.breakdownOut, breakdownLine);
  }
  const outDir = path.resolve(args.outDir);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const staging = await fs.mkdtemp(`${outDir}.staging-`);
  const written = { ...finals, ...staged };
  for (const [name, content] of Object.entries(written)) await fs.writeFile(path.join(staging, name), content);
  // --out-dir is empty here (checked above); an existing empty folder makes way for the rename.
  await fs.rmdir(outDir).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  // Windows can hold a just-written folder for a moment (a virus scan): EPERM or EBUSY. Retry, and leave no staging folder.
  for (let attempt = 1; ; attempt++) {
    try {
      await renameFn(staging, outDir);
      break;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < 10) { await new Promise((r) => setTimeout(r, 500)); continue; }
      await fs.rm(staging, { recursive: true, force: true }).catch((rmErr) => log(`could not remove ${staging}: ${rmErr.message}`));
      throw err;
    }
  }
  io.out(`audit-prep: wrote ${Object.keys(written).join(', ')} to ${args.outDir}; both scans clean\n`);
  io.out(breakdownLine);
}

const HEADING_RE = /^(#{1,6})\s/;

function headingMatches(lineText, heading) {
  if (!lineText.startsWith(heading)) return false;
  const next = lineText[heading.length];
  return next === undefined || !/\w/.test(next);
}

// Replaces one claim block (--match-heading, up to the next heading of the same or higher level)
// or one exact line (--match-line, fences included) with a seat's redacted text. Pure; returns
// {text, start, end, count} with 1-based inclusive line numbers of what was replaced.
function spliceText(text, { heading, line }, replacementRaw) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) throw new RelayError('--file has an unterminated fenced code block; fix it before splicing');
  const repl = stripBom(replacementRaw).split(/\r?\n/);
  while (repl.length > 0 && repl[0].trim() === '') repl.shift();
  while (repl.length > 0 && repl[repl.length - 1].trim() === '') repl.pop();
  if (parseFenceLines(repl.join('\n')).unterminated) throw new RelayError('the replacement has an unterminated fenced code block');
  const hits = [];
  lines.forEach((l, i) => {
    if (heading !== undefined ? !l.inFence && headingMatches(l.text, heading) : l.text === line) hits.push(i);
  });
  const what = heading !== undefined ? `heading "${heading}"` : `line "${line}"`;
  if (hits.length === 0) throw new RelayError(`--file has no ${what}`);
  if (hits.length > 1) throw new RelayError(`--file has ${hits.length} matches for ${what} (lines ${hits.map((h) => h + 1).join(', ')}); make --match-* unique`);
  const start = hits[0];
  let end = start + 1;
  if (heading !== undefined) {
    const level = heading.match(/^#+/)[0].length;
    if (repl.length === 0 || !headingMatches(repl[0], heading)) {
      throw new RelayError(`the replacement must start with ${what}; save only the redacted block, no other text`);
    }
    const inner = parseFenceLines(repl.join('\n')).lines.slice(1).find((l) => {
      const h = !l.inFence && HEADING_RE.exec(l.text);
      return (h && h[1].length <= level) || (!l.inFence && THEMATIC_BREAK_RE.test(l.text));
    });
    if (inner) throw new RelayError(`the replacement contains another heading or a "---" break ("${inner.text}"); splice one block at a time`);
    // A claim replacement must itself be one well-formed claim block (the schema allows prose after
    // the Evidence fence, so trailing text is checked for structure, not refused outright).
    if (/^## [AB]\d+\b/.test(repl[0])) {
      const { blocks } = extractClaimBlocks(repl.join('\n'));
      const problems = blocks.size === 1 ? claimBlockProblems([...blocks.values()][0]) : ['not exactly one claim block'];
      if (problems.length > 0) throw new RelayError(`the replacement is not a well-formed claim block (${problems.join('; ')}); nothing written`);
    }
    // The block ends at the next heading of the same or higher level, or at a "---" break, which the
    // validator also treats as a claim boundary.
    while (end < lines.length) {
      const h = !lines[end].inFence && HEADING_RE.exec(lines[end].text);
      if (h && h[1].length <= level) break;
      if (!lines[end].inFence && THEMATIC_BREAK_RE.test(lines[end].text)) break;
      end += 1;
    }
    // Keep the block's trailing blank lines, so spacing before the next heading is unchanged.
    while (end - 1 > start && lines[end - 1].text.trim() === '') end -= 1;
  }
  const eol = lines[start].eol || lines.find((l) => l.eol)?.eol || '\n';
  const tailEol = end < lines.length || lines[end - 1].eol !== '' ? eol : '';
  const middle = repl.length === 0 ? '' : repl.join(eol) + tailEol;
  const out = lines.slice(0, start).map((l) => l.text + l.eol).join('') + middle + lines.slice(end).map((l) => l.text + l.eol).join('');
  if (parseFenceLines(out).unterminated) throw new RelayError('the splice would leave an unterminated fenced code block; nothing written');
  return { text: out, start: start + 1, end, count: repl.length };
}

// The exact line comes from a UTF-8 file, so a line with double quotes needs no shell escaping.
async function resolveMatchLine(line) {
  if (typeof line === 'string') return line;
  const text = await readRequired(line.file, '--match-line-file');
  const exact = text.replace(/\r?\n$/, '');
  if (exact.includes('\n') || exact.includes('\r')) throw new RelayError(`--match-line-file ${line.file} holds more than one line; it must hold exactly the one line to replace`);
  if (exact === '') throw new RelayError(`--match-line-file ${line.file} is empty`);
  return exact;
}

async function runSplice(args) {
  const original = await readRequired(args.file, '--file');
  if (args.pairs) {
    // All pairs apply in memory first; any refusal leaves the file unchanged.
    let text = original;
    const done = [];
    for (const pair of args.pairs) {
      const spliced = spliceText(text, { line: await resolveMatchLine(pair.line) }, await readRequired(pair.with, '--with'));
      text = spliced.text;
      done.push(`${spliced.start}-${spliced.end}`);
    }
    await writeFileAtomic(args.file, text);
    io.out(
      `splice: replaced ${args.pairs.length} line(s) (at ${done.join(', ')}) of ${args.file}; ` +
        're-run validate (and scan) on this file before continuing\n'
    );
    return;
  }
  let replacement;
  if (args.with !== undefined) {
    replacement = await readRequired(args.with, '--with');
  } else {
    let result;
    try {
      result = JSON.parse(await readRequired(args.withResult, '--with-result'));
    } catch (err) {
      if (err instanceof RelayError) throw err;
      throw new RelayError(`--with-result is not valid JSON: ${err.message}`);
    }
    if (typeof result.finalMessage !== 'string' || result.finalMessage.trim() === '') {
      throw new RelayError('--with-result has no non-empty "finalMessage" (a dispatcher result.json)');
    }
    replacement = result.finalMessage;
  }
  const spliced = spliceText(original, { heading: args.matchHeading, line: args.matchLine === undefined ? undefined : await resolveMatchLine(args.matchLine) }, replacement);
  await writeFileAtomic(args.file, spliced.text);
  io.out(
    `splice: replaced line(s) ${spliced.start}-${spliced.end} of ${args.file} with ${spliced.count} line(s); ` +
      're-run validate (and scan) on this file before continuing\n'
  );
}

function scorecardCell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

// The disputing seat's counter-fact, as the auditor copied it, so the reader sees what was claimed against the finding.
function counterFactQuote(f) {
  const quotes = (f.peer_responses ?? []).filter((p) => p.response === 'disputed-with-counter-fact' && typeof p.counter_fact === 'string').map((p) => p.counter_fact.trim());
  return quotes.length > 0 ? `: "${quotes.join('" / "')}"` : '';
}

// Why a finding is unresolved or refuted, from its own fields, so "Auditor check: CONFIRMED" next to
// "unresolved-high-stakes" does not read as a contradiction.
function scorecardNote(f) {
  const responses = (f.peer_responses ?? []).map((p) => p.response);
  const verified = Array.isArray(f.verifications) && f.verifications.length > 0;
  if (f.final_state === 'settled-refuted') {
    const by = [];
    if (responses.includes('disputed-with-counter-fact')) by.push('peer counter-fact');
    if (f.auditor_check?.result === 'REFUTED') by.push('auditor check');
    if ((f.verifications ?? []).some((v) => v.verdict === 'REFUTED')) by.push('falsification verifier');
    return `refuted by ${by.join(', ')}${counterFactQuote(f)}`;
  }
  const finalSeverity = f.severity_audited ?? f.severity;
  if (f.final_state === 'settled-agree' && (finalSeverity === 'HIGH' || finalSeverity === 'CRITICAL')
    && (f.auditor_check?.result ?? 'NOT_CHECKED') === 'NOT_CHECKED' && !verified) {
    return 'settled by concession only; the auditor did not check it';
  }
  if (!String(f.final_state).startsWith('unresolved')) return '';
  if (responses.includes('disputed-with-counter-fact') && !verified) {
    return `peer counter-fact not tested${counterFactQuote(f)}; an auditor confirmation alone cannot settle it` +
      (f.final_state === 'unresolved-high-stakes' ? ' (ask for "deep verify disputed high-severity findings"; with a CLI auditor, a new run with --falsification)' : '');
  }
  if (responses.includes('disputed-no-counter-fact')) return 'disputed without a counter-fact, not settled either way';
  if (verified) return `falsification verdict ${(f.verifications ?? []).map((v) => v.verdict).join(', ')}`;
  return 'not settled';
}

// Bracketed task-packet tags such as "[H3]" or "[CHK-2]" in a claim heading.
const HEADING_TAG_RE = /\[([A-Z][A-Z0-9-]*\d+)\]/g;

// claim ID -> tags from its Phase 1 heading, for the scorecard's Hypotheses column. With the run's task packet next to the
// phase1 folder, the packet's own tags are also read the way the report reads them (any case, dots, written without brackets).
async function phase1HeadingTags(phase1Dir) {
  const packetFile = path.join(path.dirname(path.resolve(phase1Dir)), 'task-packet.md');
  const hasPacket = await fs.access(packetFile).then(() => true, () => false);
  const known = hasPacket ? [...packetCriteria(await readUtf8(packetFile)).keys()] : [];
  const tags = new Map();
  for (const seat of ['A', 'B']) {
    for (const [id, block] of extractClaimBlocks(await readPhase1Seat(seat, phase1Dir)).blocks) {
      const own = [...block.heading.matchAll(HEADING_TAG_RE)].map((m) => m[1]);
      const fromPacket = readHeadingTags(block.heading.replace(/^##\s+\S+/, ''), known).filter((t) => known.includes(t));
      tags.set(id, [...new Set([...own, ...fromPacket])]);
    }
  }
  return tags;
}

// How the peers answered each other's claims: a run where every claim was conceded may be two agreeable seats, not right findings.
function peerResponseFigure(findings) {
  const counts = { conceded: 0, disputed: 0, unaddressed: 0 };
  for (const f of findings) {
    for (const p of f.peer_responses ?? []) {
      if (p.response === 'conceded') counts.conceded += 1;
      else if (p.response === 'unaddressed') counts.unaddressed += 1;
      else counts.disputed += 1;
    }
  }
  const total = counts.conceded + counts.disputed + counts.unaddressed;
  if (total === 0) return '';
  return ` Peer responses: ${counts.conceded} conceded, ${counts.disputed} disputed, ${counts.unaddressed} unaddressed (${Math.round((100 * counts.conceded) / total)}% conceded).`;
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// One row per bracketed task-packet tag (an acceptance criterion or hypothesis id) found in the claim headings: which findings carry it.
function tagTable(findings, headingTags) {
  const byTag = new Map();
  for (const f of findings) {
    const severity = String(f.severity_audited ?? f.severity ?? '').toUpperCase();
    for (const tag of new Set(f.origins.flatMap((o) => headingTags.get(o) ?? []))) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ id: f.id, severity, state: f.final_state });
    }
  }
  if (byTag.size === 0) return [];
  const rows = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([tag, list]) => {
    const worst = SEVERITY_ORDER.find((level) => list.some((x) => x.severity === level)) ?? '';
    return `| ${scorecardCell(tag)} | ${list.map((x) => x.id).join(', ')} | ${worst} | ${[...new Set(list.map((x) => x.state))].join(', ')} |`;
  });
  return ['', '| Tag | Findings | Highest severity | Final states |', '|---|---|---|---|', ...rows];
}

// The Phase 3 scorecard table, read from a translated findings.json; nothing is recomputed.
function scorecardMarkdown(doc, headingTags = null) {
  if (!doc || !Array.isArray(doc.findings)) throw new RelayError('scorecard: --in has no "findings" array');
  const findings = doc.findings;
  for (const f of findings) {
    const origins = Array.isArray(f.origins) ? f.origins : [];
    if (origins.length === 0 || !origins.every((o) => typeof o === 'string' && REAL_CLAIM_ID_RE.test(o))) {
      throw new RelayError(`scorecard: finding ${f.id ?? '(no id)'} has origins ${JSON.stringify(f.origins)}; run translate first (a scorecard shows real A/B IDs only)`);
    }
  }
  const count = (pred) => findings.filter(pred).length;
  const states = [...FINAL_STATE_VALUES].map((s) => `${count((f) => f.final_state === s)} ${s}`);
  const finalSeverity = (f) => f.severity_audited ?? f.severity;
  const high = findings.filter((f) => finalSeverity(f) === 'HIGH' || finalSeverity(f) === 'CRITICAL');
  const checked = count((f) => f.auditor_check && f.auditor_check.result !== 'NOT_CHECKED');
  const lines = [
    `${findings.length} findings: ${states.join(', ')}`,
    ...(checked === 0 && high.length > 0
      ? [doc.audit_depth === 'light'
        ? `Note: no claim was independently checked by the auditor (light audit, every claim conceded); ${high.length} HIGH/CRITICAL finding(s) are settled by concession only.`
        : `Note: the auditor could check none of the claims; ${high.length} HIGH/CRITICAL finding(s) are unchecked: see each auditor_check.reason.`]
      : []),
    `Independently discovered: ${count((f) => f.independently_discovered === true)}. ` +
      `HIGH/CRITICAL: ${high.length}. Auditor checked: ${count((f) => f.auditor_check && f.auditor_check.result !== 'NOT_CHECKED')}. ` +
      `Falsification verified: ${count((f) => Array.isArray(f.verifications) && f.verifications.length > 0)}.` +
      (typeof doc.audit_depth === 'string' ? ` Audit depth: ${doc.audit_depth}.` : '') +
      peerResponseFigure(findings),
    '',
    '| Finding | Title | ' + (headingTags ? 'Hypotheses | ' : '') +
      'Origins | Independently discovered | Severity | Basis | Evidence strength | Peer responses | Auditor check | Final state | Note |',
    '|---|---|' + (headingTags ? '---|' : '') + '---|---|---|---|---|---|---|---|---|',
  ];
  for (const f of findings) {
    const tags = headingTags ? [...new Set(f.origins.flatMap((o) => headingTags.get(o) ?? []))] : null;
    const verdicts = new Map((f.verifications ?? []).map((v) => [v.claim, v.verdict]));
    const responses = (f.peer_responses ?? [])
      .map((p) => `${p.claim}: ${p.response}${verdicts.has(p.claim) ? ` (verified: ${verdicts.get(p.claim)})` : ''}`)
      .join('; ');
    const check = f.auditor_check?.result ?? '';
    lines.push('| ' + [
      f.id, f.title ?? f.summary ?? '', ...(tags ? [tags.join(', ')] : []), f.origins.join(', '), f.independently_discovered === true ? 'yes' : 'no',
      f.severity_audited ? `${f.severity_audited} (claimed ${f.severity})` : f.severity, f.basis, f.evidence_strength, responses, check, f.final_state,
      [f.severity_audited && f.auditor_check?.severity_reason ? `severity ${f.severity_audited}: ${f.auditor_check.severity_reason}` : '', scorecardNote(f)].filter(Boolean).join('; '),
    ].map(scorecardCell).join(' | ') + ' |');
  }
  if (headingTags) lines.push(...tagTable(findings, headingTags));
  lines.push('', generatorLine());
  return lines.join('\n') + '\n';
}

async function runScorecard(args) {
  let doc;
  try {
    doc = JSON.parse(await readRequired(args.in, '--in'));
  } catch (err) {
    if (err instanceof RelayError) throw err;
    throw new RelayError(`--in is not valid JSON: ${err.message}`);
  }
  const table = scorecardMarkdown(doc, args.phase1Dir ? await phase1HeadingTags(args.phase1Dir) : null);
  if (args.out) {
    await writeFileAtomic(args.out, table);
    io.out(`scorecard: wrote ${doc.findings.length} row(s) to ${args.out}\n`);
  } else {
    io.out(table);
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      return 2;
    }
    throw err;
  }
  try {
    if (args.sub === 'relabel') await runRelabel(args);
    else if (args.sub === 'scan') await runScan(args);
    else if (args.sub === 'flip') await runFlip(args);
    else if (args.sub === 'translate') await runTranslate(args);
    else if (args.sub === 'validate') await runValidate(args);
    else if (args.sub === 'append-rebuttals') await runAppendRebuttals(args);
    else if (args.sub === 'audit-prep') await runAuditPrep(args);
    else if (args.sub === 'splice') await runSplice(args);
    else if (args.sub === 'scorecard') await runScorecard(args);
    else if (args.sub === 'clear-cache') {
      io.out(`clear-cache: removed ${await clearExemptCache()} cached target text file(s) from ${exemptCacheDir()}\n`);
    }
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  return 0;
}

// One subcommand in-process: { code, stdout, stderr }.
export const runStep = (argv) => runStepWith('blind-relabel', io, main, argv);

export {
  runAuditPrep,
  seatClaimProblems,
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
  VENDOR_TOKENS,
  realClaimIds,
  peerViewClaimIds,
  scanForPeerLabelLeaks,
  scanForTargetUrls,
  normalizeUrl,
  validateProblems,
  falsificationBreakdown,
  parseRebuttalEntries,
  parseFenceLines,
  splitLineSpans,
  spliceText,
  scorecardMarkdown,
  readTargetText,
  exemptCacheDir,
  clearExemptCache,
};

refuseDirectRun(import.meta.url, 'blind-relabel.mjs');
