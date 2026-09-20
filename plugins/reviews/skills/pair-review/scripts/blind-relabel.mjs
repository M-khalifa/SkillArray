#!/usr/bin/env node
// Mechanical backing for review-protocol.md's blind exchange: relabels claim IDs,
// scans for vendor/model self-identification, and coin-flips the Phase 3 audit
// mapping. Without this, "blind review" was orchestrator-followed prose only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

class RelayError extends Error {}

function log(msg) {
  process.stderr.write(`blind-relabel: ${msg}\n`);
}

const USAGE = `blind-relabel.mjs — relabel, scan, and coin-flip for review-protocol.md's blind exchange.

Usage:
  node blind-relabel.mjs relabel --in <path> --out <path> --from <A|B> --to <P|X|Y>
  node blind-relabel.mjs scan --in <path> [--target-dir <path>] [--tokens t1,t2,...]
    [--phase1-dir <path> --forbid-seats <A|B|A,B>]
  node blind-relabel.mjs flip --out <path>
  node blind-relabel.mjs translate --in <path> --out <path> --mapping <path> [--phase1-dir <path>] [--verification-dir <path>]
  node blind-relabel.mjs validate --phase1-dir <path>
  node blind-relabel.mjs -h | --help

relabel:
  Rewrites heading and prose occurrences of "<from><N>" (e.g. A1, B12) to
  "<to><N>", and any "# Seat <from> findings" header to "# Peer findings".
  Text inside fenced code blocks and inline code spans is left untouched, so
  claim IDs referenced there (a rare but real case) do not relabel; never put
  a claim ID inside an Evidence fence for this reason. Fences follow CommonMark:
  an opening fence is a run of 3+ backticks OR 3+ tildes; the closing fence must
  use the SAME character and be at least as long, so a \`\`\` line inside a
  \~\~\~-opened block (or a longer backtick run) is fenced content, not a
  delimiter -- a shorter or differently-charactered "close" does not end the
  fence. Inline code follows the same rule: a run of N backticks opens a span
  that closes only at the next run of exactly N backticks; an unmatched run is
  literal text, not code. A backslash-escaped backtick (\\\`) is literal
  punctuation, not a delimiter, per CommonMark 6.1 -- it never opens a span, so
  text like \\\`Codex\\\` stays scannable prose; this escape-awareness applies
  only to finding a span's OPENING delimiter, never to matching its closer
  (CommonMark: backslash escapes do not work inside an already-open code span).
  Known limitation: inline code spans are matched WITHIN A SINGLE LINE only,
  unlike CommonMark's real grammar, which allows a span to cross a line ending
  (converted to a space in the rendered span). An opening backtick run with no
  closing run on the SAME line is therefore left as literal text on that line
  -- this over-scans and over-relabels a genuine multiline span (its claim IDs
  get relabeled, its identity tokens get scanned), the fail-safe direction for
  a blind, never the reverse. A real multiline-span implementation is deferred
  (see review-protocol.md) because a naive "span stays open until the next
  matching run, across lines" parser would create a NEW blinding bypass: an
  unclosed backtick anywhere lets a stray later backtick on an unrelated line
  close a span that swallows real headings and claim IDs in between, hiding
  them from relabel/scan -- the unsafe direction. Writes --out; does not
  modify --in. An unterminated fenced code block (missing the matching closing
  fence) exits nonzero and writes nothing, same as scan below.

scan:
  Reads --in, strips fenced/inline code, and checks the remaining prose for
  vendor/model tokens (claude, anthropic, codex, openai, gpt-, opencode,
  fable, opus) plus any --tokens (comma-separated, case-insensitive) supplied
  for this run -- the actual configured model/provider strings, e.g.
  "gpt-5.6-sol,google/gemini-3-pro" -- and for a seat-letter mention (Seat A,
  Reviewer A, seat a, reviewer a, ... -- case-insensitive on the letter).
  A known false-positive shape: ordinary prose like "gives the reviewer a
  chance" also matches (self-identification or identity tier, depending on
  whether a first-person marker is nearby); this costs one redaction round
  and is accepted, since a missed lowercase leak would otherwise defeat the
  blind silently. Three tiers:
    - Self-identification (first person near a token or seat letter, e.g.
      "as Codex I ran" or "As seat A, I found..."): exit 1, listed as
      SELF-IDENTIFICATION on stderr.
    - Any other non-target-derived identity mention -- third person included,
      e.g. "The Codex reviewer found this" or "Reviewer A found the issue":
      ALSO exit 1, listed as IDENTITY on stderr. This tier exists because
      third-person identity prose is as real a leak as first-person self-ID;
      only first person gets its own separate label since it is the strongest,
      most direct signal.
    - A target-derived vendor/model token mention (e.g. a target file named
      codex-dispatch.mjs, or a target's own SKILL.md naming its supported
      providers), OR a seat-letter mention when the target's own SKILL.md or
      references/*.md themselves use seat vocabulary (the target IS a review
      protocol like this one, so "seat A" in prose is target terminology, not
      an identity leak): exit 0, listed on stderr for the orchestrator's own
      review. --target-dir marks a vendor token (built-in or supplied via
      --tokens) as target-derived only when it also appears in that
      directory's own file names, SKILL.md, or references/*.md content; the
      seat-vocabulary exemption is separate and content-based (never
      name-based, since a bare letter would false-positive constantly against
      filenames), checked only against the target's own SKILL.md/references
      prose.
  Residual limitation: writing style, structure, or phrasing can still hint at
  identity; this check catches literal token/seat-mention co-occurrence only.
  The target-derived exemption is token-global (does not distinguish "this
  specific occurrence cites the target" from "this token merely occurs
  somewhere in the target"), a known limitation, not contextual. Like relabel,
  inline code span matching is single-line only (see relabel above); a
  multiline span's identity tokens are scanned as prose rather than exempted
  as code -- fail-safe (over-scans), never a leak. An
  unterminated fenced code block (missing a same-character, same-or-longer
  closing fence, per CommonMark) exits nonzero rather
  than silently skipping every line after it as if it were code.
  (With --phase1-dir and --forbid-seats) Additionally checks the RAW text,
  fenced content INCLUDED (unlike the vendor/seat check above, which exempts
  fences), for each forbidden seat's own real claim IDs -- the exact
  enumerable set from that seat's actual Phase 1 headings, via
  extractClaimHeadings, never a generic \\b[A-Z]\\d+\\b pattern that would
  false-positive on a legitimate target-code identifier, hex digest, or cell
  reference. A hit (e.g. "my A4" surviving inside an Evidence fence after an
  A-to-P/A-to-X relabel) is a hard stop, same exit and same "return for
  redaction" outcome as a self-identification hit -- this closes
  relabelText's own documented "never put a claim ID inside an Evidence
  fence" limitation mechanically. --forbid-seats takes the seat letter(s)
  whose real IDs must not survive in THIS file: the source seat only for a
  Phase 2 peer-view (e.g. --forbid-seats A when scanning the A-to-P relabeled
  file seat B will read), both seats for a Phase 3 double-relabeled X/Y file
  (--forbid-seats A,B). --phase1-dir and --forbid-seats must be supplied
  together or not at all.

flip:
  Writes --out (a JSON file) with a coin-flipped { "A": "X", "B": "Y" } or
  { "A": "Y", "B": "X" } mapping. Read it for the manifest only; never show
  it to the auditor.

translate:
  Rewrites the fresh Phase 3 auditor's canonical-findings JSON (--in, X/Y IDs
  throughout, including inside prose fields -- "evidence" is exempt, kept
  verbatim, since it is captured output/citation, not prose to relabel) back
  to real A/B claim IDs using --mapping (the flip mapping from the "flip"
  subcommand above), and writes --out. Derives each finding's
  "independently_discovered" field mechanically from whether its translated
  origins span both seat letters -- never trusts the auditor's own claim about
  this. Refuses (writes nothing) on: invalid JSON; a malformed or hand-edited
  mapping; an origin that fails to translate to a real A<n>/B<n> ID; (with
  --phase1-dir) an origin whose claim ID has no matching heading in that
  seat's real Phase 1 findings file (headings are a structural property of
  each RAW line -- fence-skipped but never inline-code-stripped first, so a
  "## A99" inside a fenced Evidence excerpt, or a heading-shaped string only
  reachable by first removing a preceding inline-code span, never counts as a
  real heading), catching a hallucinated claim ID; (also
  with --phase1-dir) a real Phase 1 claim from EITHER seat that appears as
  the origin of no finding at all, catching a claim the auditor silently
  dropped; a finding id not of the form F<n>, or a duplicate one; the same claim ID
  appearing as an origin of more than one finding; a peer_responses array that
  does not exactly match its finding's origins, or whose claim is not a
  non-empty string; missing evidence, or evidence that is not a non-empty
  array of non-empty strings ("no evidence, no finding" enforced mechanically);
  any of severity, basis, evidence_strength, final_state, or a
  peer_responses[].response outside the exact enum review-protocol.md defines;
  a missing auditor_check object, an auditor_check.result outside
  CONFIRMED/REFUTED/INCONCLUSIVE/NOT_CHECKED, a non-null basis/evidence when
  NOT_CHECKED, a missing/empty evidence otherwise, or an auditor_check.basis
  not one of the same basis enum used elsewhere (EXECUTED/STATIC_TRACE/
  SOURCE_CITATION/INFERENCE); a final_state of settled-refuted with no
  refutation provenance (no disputed-with-counter-fact peer_responses entry,
  no auditor_check.result of REFUTED, and no verifications[] entry of
  REFUTED), OR with an auditor_check.result of CONFIRMED (the auditor cannot
  both independently confirm a claim and settle it as refuted, even when a
  peer counter-fact exists); a final_state of settled-agree with no agreement
  provenance (independently_discovered is not true, no peer_responses entry
  is conceded, and no verifications[] entry is CONFIRMED -- note
  auditor_check.result of CONFIRMED ALONE is NOT sufficient provenance here,
  unlike settled-refuted's auditor_check REFUTED route, since
  review-protocol.md's settled-agree definition has no equivalent clause), OR
  with an auditor_check.result of REFUTED, OR with any peer_responses entry
  of disputed-with-counter-fact UNLESS a verifications[] entry for that same
  finding is CONFIRMED (a specific counter-fact contradicts "both sides
  align" unless a falsification verifier already independently checked and
  confirmed the claim anyway -- the protocol's own designated mechanism for
  settling a disputed claim in its favor);
  a final_state of dropped-speculative
  unless evidence_strength is SPECULATIVE, independently_discovered is false,
  no peer_responses entry disputed it, auditor_check.result is not CONFIRMED
  or REFUTED, and verifications[] is empty (dropped-speculative means
  "SPECULATIVE, neither corroborated nor attacked, nor independently
  checked by a falsification verifier", checked mechanically, not trusted
  from the auditor's own classification -- a verifications[] entry existing
  at all means a verifier ran, regardless of the verdict it reached); any
  CONFIRMED verifications[] verdict (on any origin, for any finding) paired
  with final_state settled-refuted, or any REFUTED verdict paired with
  settled-agree (review-protocol.md's Canonical findings section groups
  claims into one F only when they assert the SAME defect, so one origin's
  verdict speaks for the finding as a whole, not only for that origin); a
  verifications[].claim that is not one of
  its finding's origins, a duplicate one, or not a non-empty string; a
  verifications[].verdict outside CONFIRMED/REFUTED/INCONCLUSIVE (the auditor
  supplies only claim+verdict here -- basis and evidence are never trusted
  from the auditor's JSON, see below); a finding with a non-empty
  verifications array when --verification-dir was not supplied (this
  mechanism is not opt-out: the verifier file, not the auditor's JSON, is
  authoritative for a verification record, so it cannot be validated without
  the directory); (with --verification-dir) a cited verification file that
  does not exist on disk, a verification-*.md file on disk that no finding
  cites, a verification file missing a "Claim:", "Verdict:", "Basis:" (one of
  the same basis enum as above), or "Evidence:" line (everything from
  "Evidence:" to end of file is the evidence body, preserved verbatim except
  for the single structural blank line immediately after "Evidence:" and any
  trailing blank line(s) from the file's own terminator -- interior
  indentation and interior blank lines are untouched, so a
  "Verdict:"-shaped line inside the evidence text is body content, not a
  second header line), a verification file's own "Claim:" line naming a
  different claim than its filename, or a finding's asserted
  verifications[].verdict disagreeing with what its verification file's own
  "Verdict:" line says (the verifier's file is authoritative for its ENTIRE
  record -- claim, verdict, basis, AND evidence, never the auditor's
  transcription of it; translate populates verifications[].basis and
  verifications[].evidence from the file, discarding whatever the auditor's
  JSON supplied). This is the ONLY supported way to produce
  findings.json; never hand-transcribe the auditor's X/Y output into real IDs.
  (With --phase1-dir) A canonical finding's severity/basis/evidence_strength/
  evidence are recomputed mechanically from its own origins' real Phase 1
  claim blocks and OVERWRITE whatever the auditor's JSON supplied for these --
  same authority precedent as verifications[] over the verifier file above.
  severity takes the single strongest value among the finding's origins,
  independently (CRITICAL>HIGH>MEDIUM>LOW) -- severity is a property of
  impact, not evidence quality, so a finding is never underreported just
  because its most-severe origin had middling evidence. basis and
  evidence_strength are DIFFERENT: they are copied together, as a PAIR, from
  the single "strongest-evidenced origin" (review-protocol.md's own phrase),
  never independently maximized per field -- doing so can synthesize a
  (basis, evidence_strength) combination no origin ever actually asserted
  (e.g. one origin EXECUTED+SUPPORTED, another STATIC_TRACE+REPRODUCED,
  independent-per-field-max wrongly reports EXECUTED+REPRODUCED, overclaiming
  the finding's real evidentiary strength beyond what either origin
  established). The strongest-evidenced origin is chosen by basis first
  (EXECUTED>STATIC_TRACE>SOURCE_CITATION>INFERENCE), evidence_strength as the
  tiebreak (REPRODUCED>DETERMINISTIC>SUPPORTED>PLAUSIBLE>SPECULATIVE), then
  origins[] array order as a final deterministic tiebreak. The chosen
  origin's real ID is recorded as a new "basis_from" field, so which origin
  the pair came from is explicit in the artifact, not just inferable from
  the rule. evidence becomes one verbatim entry per origin, in origins[]
  order, extracted from each origin's own Evidence fence (same
  structural-blank-trim rule as a verification file's Evidence: body).
  Without --phase1-dir, the auditor's own severity/basis/evidence_strength/
  evidence are trusted as before (no basis_from field is added in that case)
  -- this recomputation is opt-in via the same flag as the origin-coverage
  checks above, not a separate flag.

validate:
  Checks every claim block ("## A<n>"/"## B<n>" through the next heading or
  EOF) in BOTH seats' real Phase 1 files under --phase1-dir for a recognized
  "Severity:", "Basis:", "Evidence strength:", and a non-empty "Evidence:"
  body -- the same completeness check translate's --phase1-dir derivation
  requires of every ORIGIN claim, run here on every claim up front, before
  any finding cites it. Also rejects: a claim-like heading that does not
  match the exact "## A<n>"/"## B<n>" form (e.g. a bare "## 1" -- a model
  that ignores the claim-ID schema must never be silently read as zero
  findings, since both parse to zero real claim blocks); a real claim ID
  heading appearing more than once in the same file (the second block would
  otherwise silently overwrite the first for mechanical derivation, so the
  first occurrence is kept and the duplicate is reported, never merged); a
  claim heading using the OTHER seat's letter (e.g. "## B1" inside
  A-findings.md); and a seat with zero recognized claim headings AND zero
  claim-like malformed-heading attempts that does not also contain the exact
  literal marker "## No findings" under its own seat header -- an empty or
  unparseable file is never treated as a legitimate zero-findings verdict on
  its own; ordinary prose like "(no findings)" does NOT satisfy this, only
  the exact marker heading does. Also checks every raw "## Rebuttals..."
  line (once a Phase 2 rebuttal exists) against the exact required form
  "## Rebuttals (from <A|B>) of <A|B> claims" -- matching relabel's own
  rebuttalHeading regex exactly, since a looser match here would pass a
  heading relabel itself does not recognize -- and rejects a seat naming
  itself as its own rebutter ("(from A) of A"). Deliberately does NOT
  enforce which file a rebuttal heading is appended to: placement is
  standardized in prose (review-protocol.md and phase-2-cross-examination.md:
  onto the PEER's file), but relabel itself is placement-agnostic (it
  relabels a seat's letter wherever the heading appears), so validate only
  rejects the universally-invalid case above rather than enforcing
  placement itself. Lists every problem across every claim (not
  just the first), then exits nonzero. A nonzero exit means: return the
  affected seat's file to that seat's OWN context for reformatting --
  restate the required field lines (or the "## No findings" marker), change
  nothing else -- same procedure as a scan redaction round, never a hand
  edit. Run this at the Phase 1 gate (before Phase 2 delta briefs are built),
  again after Phase 2's rebuttals are appended (before Phase 3's double
  relabel, since that is the only point the rebuttal-heading check above can
  fire), and again after any reformatting round. A CommonMark thematic break
  (bare ---/***/___, 3+ chars) between claims is recognized as a claim
  boundary the same way a heading is, so a real reviewer's own paragraph
  separator does not corrupt evidence capture.
`;

function printUsageAndExit(code) {
  process.stdout.write(USAGE);
  process.exit(code);
}

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
  if (!['relabel', 'scan', 'flip', 'translate', 'validate'].includes(sub)) {
    throw new RelayError(`unknown subcommand "${sub}"`);
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
    else throw new RelayError(`unknown argument "${a}"`);
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
    if (args.mapping !== undefined || args.phase1Dir !== undefined || args.verificationDir !== undefined || args.forbidSeats !== undefined) {
      throw new RelayError('--mapping and --verification-dir are only accepted by translate; --phase1-dir and --forbid-seats are only accepted by scan (with --phase1-dir) or translate (--phase1-dir only)');
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
      args.to !== undefined || args.targetDir !== undefined || args.tokens !== undefined ||
      args.mapping !== undefined || args.verificationDir !== undefined || args.forbidSeats !== undefined
    ) {
      throw new RelayError('validate accepts only --phase1-dir');
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
  const pieces = text.split('\n');
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
        return { text: line, inFence: true, eol };
      }
      return { text: line, inFence: false, eol };
    }
    const closeRe = new RegExp(`^ {0,3}(?:${open.char === '`' ? '`' : '~'}{${open.len},})\\s*$`);
    const wasOpen = open;
    if (closeRe.test(line)) open = null;
    return { text: line, inFence: wasOpen !== null ? true : false, eol };
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

function relabelText(text, from, to) {
  const { lines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely relabel past it, fix the file and re-run');
  }
  const claimId = new RegExp(`\\b${from}(\\d+)\\b`, 'g');
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
    return (
      splitLineSpans(line, inFence)
        .map((span) => (span.code ? span.text : span.text.replace(claimId, `${to}$1`)))
        .join('') + eol
    );
  });
  return relabeledLines.join('');
}

const VENDOR_TOKENS = ['claude', 'anthropic', 'codex', 'openai', 'gpt-', 'opencode', 'fable', 'opus'];
// A token glued to -._/ (codex-dispatch.mjs, gpt-5.6-sol) is a filename/model ID, not self-reference.
const FIRST_PERSON = String.raw`\b(?:I|I'm|I've|I am|me|my|myself|we|our)\b`;
const VENDOR_TOKEN_ALT = String.raw`(?:\b(?:claude|anthropic|codex|openai|opencode|fable|opus)\b(?![-._/])|\bgpt-[\w.]+)`;
// Not in VENDOR_TOKENS: that list also drives the filename scan, where "seat" false-positives.
// [ABab]: lowercase "seat a"/"reviewer a" hard-stops too; "gives the reviewer a chance" is a
// known, accepted false positive (one redaction round) -- see blind-relabel.test.mjs.
const SEAT_TOKEN_RE =
  String.raw`\b[Ss]eat[\s-]*[ABab]\b|\b[Rr]eviewer[\s-]*[ABab]\b|\b[ABab]-(?:side[\s-]+)?(?:[Ss]eat|[Rr]eviewer)\b`;
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
  return new RegExp(
    `${FIRST_PERSON}[^.\\n]{0,40}${vendorAlt}|${vendorAlt}[^.\\n]{0,40}${FIRST_PERSON}`,
    'i'
  );
}

function parseTokensArg(raw) {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

// seatVocabulary is a SEPARATE exemption from the vendor-token Set: it is content-based (does
// the target's own docs use "seat A"/"reviewer A" prose?), never name-based, since seat letters
// are single characters and would false-positive constantly if checked against filenames the
// way vendor tokens are. Only true when the target IS a review protocol like this one -- for
// any other target, a seat mention has no legitimate reason to appear and always hard-stops.
async function targetDerivedTokens(targetDir, extraTokens = []) {
  if (!targetDir) return { tokens: new Set(), seatVocabulary: false };
  const found = new Set();
  const allTokens = [...VENDOR_TOKENS, ...extraTokens.map((t) => t.toLowerCase())];
  const check = (name) => {
    const lower = name.toLowerCase();
    for (const t of allTokens) if (lower.includes(t)) found.add(t);
  };
  let entries = [];
  try {
    entries = await fs.readdir(targetDir, { recursive: true });
  } catch {
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
    } catch {
      // unreadable entry; not an error for this best-effort check
    }
  }
  return { tokens: found, seatVocabulary };
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
async function scanForKnownClaimIdLeaks(text, phase1Dir, forbidSeats) {
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
        hits.push({ line: i + 1, text: line.trim(), id });
      }
    }
  });
  return hits;
}

async function scanText(text, targetDir, extraTokens = []) {
  const derived = await targetDerivedTokens(targetDir, extraTokens);
  const { lines: fenceLines, unterminated } = parseFenceLines(text);
  if (unterminated) {
    throw new RelayError('unterminated fenced code block: cannot safely scan past it, fix the file and re-run');
  }
  const lines = fenceLines.map(({ text: line, inFence }) =>
    inFence ? '' : splitLineSpans(line, inFence).filter((s) => !s.code).map((s) => s.text).join('')
  );
  const allTokens = [...VENDOR_TOKENS, ...extraTokens.map((t) => t.toLowerCase())];
  const selfIdRe = buildSelfIdRe(extraTokens);
  const selfIdHits = [];
  const identityHits = [];
  const otherHits = [];
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    const hasVendorToken = allTokens.some((t) => lower.includes(t));
    const hasSeatMention = SEAT_MENTION_RE.test(line);
    if (!hasVendorToken && !hasSeatMention) return;
    if (selfIdRe.test(line) || SEAT_SELF_ID_RE.test(line)) {
      selfIdHits.push({ line: i + 1, text: line.trim() });
      return;
    }
    const matchedTokens = allTokens.filter((t) => lower.includes(t));
    const vendorLeak = hasVendorToken && !matchedTokens.every((t) => derived.tokens.has(t));
    const seatLeak = hasSeatMention && !derived.seatVocabulary;
    if (vendorLeak || seatLeak) {
      identityHits.push({ line: i + 1, text: line.trim() });
      return;
    }
    otherHits.push({ line: i + 1, text: line.trim(), targetDerived: true });
  });
  return { selfIdHits, identityHits, otherHits };
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

// Recursively rewrites every X<n>/Y<n> token in string values (keys and non-string
// values untouched) using the inverted seat mapping -- prose fields included, since
// a human reading findings.json should see A3, not X3. "evidence" is exempt: it is
// verbatim captured output/citation, same rule as relabelText never touching fence
// content -- a literal "X11" (X11 forwarding) or "Y2" in real output must survive
// byte-identical, not be corrupted into a fake claim ID.
function translateValue(value, auditToSeat, key) {
  if (key === 'evidence') return value;
  if (typeof value === 'string') {
    return value.replace(AUDIT_ID_RE, (m, letter, digits) => `${auditToSeat[letter]}${digits}`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => translateValue(v, auditToSeat, key));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = translateValue(v, auditToSeat, k);
    return out;
  }
  return value;
}

const REAL_CLAIM_ID_RE = /^[AB]\d+$/;
const FINDING_ID_RE = /^F\d+$/;

// The exact enums review-protocol.md defines, so an auditor emitting a value outside
// them (a hallucinated state, a typo) is refused rather than published -- same class
// of gap --phase1-dir closes for a hallucinated claim ID.
const SEVERITY_VALUES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const BASIS_VALUES = new Set(['EXECUTED', 'STATIC_TRACE', 'SOURCE_CITATION', 'INFERENCE']);
const EVIDENCE_STRENGTH_VALUES = new Set(['REPRODUCED', 'DETERMINISTIC', 'SUPPORTED', 'PLAUSIBLE', 'SPECULATIVE']);
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
const CLAIM_EVIDENCE_LINE_RE = /^Evidence:\s*(.*)$/;
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
// body reuses parseVerificationFile's exact structural-blank-trim rule (leading blank line from
// "Evidence:" alone, trailing blank line(s) from the block's own end) so a claim's Evidence fence
// is captured the same verbatim way a falsification verifier's Evidence: block already is.
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
  const finishEvidence = () => {
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
  lines.forEach(({ text: line, inFence, eol }, idx) => {
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
      current = { id: headingMatch[1], severity: null, basis: null, evidenceStrength: null, evidence: null };
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
    if (evidenceLines !== null) {
      if (inFence) {
        // A fence delimiter line (opener, matched by FENCE_OPEN_RE regardless of an info string
        // like "```text"; or closer, the line whose OWN inFence is true but the NEXT line's is
        // not, or end of file) is a structural marker, not evidence content -- only lines strictly
        // BETWEEN the delimiters are the fenced body. A bare ``` mid-fence inside a ~~~-opened
        // block stays content (parseFenceLines already keeps inFence true across it).
        const prevInFence = idx > 0 ? lines[idx - 1].inFence : false;
        const nextInFence = idx + 1 < lines.length ? lines[idx + 1].inFence : false;
        const isOpener = !prevInFence && FENCE_OPEN_RE.test(line);
        const isCloser = !isOpener && !nextInFence;
        if (isOpener || isCloser) return;
      }
      evidenceLines.push({ text: line, eol });
      return;
    }
    if (inFence) return;
    const sevMatch = CLAIM_SEVERITY_LINE_RE.exec(line);
    if (sevMatch && current.severity === null) { current.severity = sevMatch[1]; return; }
    const basisMatch = CLAIM_BASIS_LINE_RE.exec(line);
    if (basisMatch && current.basis === null) { current.basis = basisMatch[1]; return; }
    const esMatch = CLAIM_EVIDENCE_STRENGTH_LINE_RE.exec(line);
    if (esMatch && current.evidenceStrength === null) { current.evidenceStrength = esMatch[1]; return; }
    const evMatch = CLAIM_EVIDENCE_LINE_RE.exec(line);
    if (evMatch && current.evidence === null) { evidenceLines = [{ text: evMatch[1], eol }]; return; }
  });
  finishEvidence();
  return { blocks, malformedHeadings, duplicateIds, noFindingsMarker };
}

async function readPhase1Seat(seat, phase1Dir) {
  const filePath = path.join(phase1Dir, `${seat}-findings.md`);
  try {
    return await fs.readFile(filePath, 'utf8');
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
// still trusted, matching the pre-existing behavior and USAGE's known-limitation text for that case.
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
  if (block.severity === null || !SEVERITY_VALUES.has(block.severity)) {
    problems.push('no recognized "Severity:" line');
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
        `translated origin "${id}" has no "## ${id}" heading in ${seat}-findings.md; ` +
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
        content = await fs.readFile(filePath, 'utf8');
      } catch {
        throw new RelayError(
          `--verification-dir: finding "${finding.id}" cites a verification for "${v.claim}" ` +
            `(anonymous "${anonId}") but ${filePath} does not exist`
        );
      }
      const parsed = parseVerificationFile(content, filePath);
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

async function translateFindings(auditJson, mapping, phase1Dir, verificationDir) {
  const auditToSeat = invertSeatMapping(mapping);
  let parsed;
  try {
    parsed = JSON.parse(auditJson);
  } catch (err) {
    throw new RelayError(`--in is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new RelayError('--in must be a JSON object with a "findings" array');
  }
  const translated = translateValue(parsed, auditToSeat);
  const seenFindingIds = new Set();
  const seenOrigins = new Set();
  const blocksBySeat = new Map();
  for (const finding of translated.findings) {
    if (!FINDING_ID_RE.test(finding.id)) {
      throw new RelayError(`finding id "${finding.id}" is not of the form "F<n>"`);
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
    if (finding.auditor_check.result === 'NOT_CHECKED') {
      if (finding.auditor_check.basis !== null || finding.auditor_check.evidence !== null) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "NOT_CHECKED" but a non-null basis ` +
            'or evidence -- both must be null when the auditor did not independently check this claim'
        );
      }
    } else {
      assertEnum(finding.auditor_check.basis, BASIS_VALUES, 'auditor_check.basis', finding.id);
      if (typeof finding.auditor_check.evidence !== 'string' || finding.auditor_check.evidence.length === 0) {
        throw new RelayError(
          `finding "${finding.id}" has auditor_check.result "${finding.auditor_check.result}" but ` +
            'a missing or empty evidence -- required whenever the auditor claims it independently checked a claim'
        );
      }
    }
    if (!Array.isArray(finding.peer_responses)) {
      throw new RelayError(`finding "${finding.id}" has no peer_responses array`);
    }
    for (const pr of finding.peer_responses) {
      if (typeof pr.claim !== 'string' || pr.claim.length === 0) {
        throw new RelayError(`finding "${finding.id}" has a peer_responses[].claim that is not a non-empty string`);
      }
      assertEnum(pr.response, PEER_RESPONSE_VALUES, 'a peer_responses[].response', finding.id);
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
  return translated;
}

// Counts what relabelText will actually touch, so a wrong --from that matches
// nothing fails loudly instead of writing a byte-identical "success". Must walk lines the same
// way relabelText does (raw-line header/rebuttal test, span-scoped claim-ID search), or the two
// can disagree on a line like "`x`# Seat A findings" -- counted as a target here but correctly
// left untouched there (or vice versa).
function countRelabelTargets(text, from) {
  const { lines } = parseFenceLines(text);
  const claimId = new RegExp(`\\b${from}(\\d+)\\b`, 'g');
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
    for (const span of splitLineSpans(line, inFence)) {
      if (span.code) continue;
      count += (span.text.match(claimId) || []).length;
    }
  }
  return count;
}

async function runRelabel(args) {
  const text = await fs.readFile(args.in, 'utf8');
  if (text.length > 0 && countRelabelTargets(text, args.from) === 0) {
    throw new RelayError(
      `no "${args.from}" claim IDs, seat header, or rebuttal heading found in ${args.in}; ` +
        `wrong --from? (a legitimate zero case is a Phase 3 second pass on a file whose peer had ` +
        `zero findings — verify --in/--from before assuming this is that case)`
    );
  }
  const out = relabelText(text, args.from, args.to);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, out);
  process.stdout.write(`relabeled ${args.from} -> ${args.to}, wrote ${args.out}\n`);
}

async function runScan(args) {
  const text = await fs.readFile(args.in, 'utf8');
  const { selfIdHits, identityHits, otherHits } = await scanText(text, args.targetDir, parseTokensArg(args.tokens));
  const claimIdHits = args.forbidSeats
    ? await scanForKnownClaimIdLeaks(text, args.phase1Dir, args.forbidSeats.split(','))
    : [];
  for (const h of otherHits) {
    log(`report line ${h.line}${h.targetDerived ? ' (target-derived)' : ''}: ${h.text}`);
  }
  for (const h of identityHits) {
    log(`IDENTITY line ${h.line}: ${h.text}`);
  }
  for (const h of claimIdHits) {
    log(`CLAIM-ID LEAK line ${h.line} (real "${h.id}" survives relabel): ${h.text}`);
  }
  for (const h of selfIdHits) {
    log(`SELF-IDENTIFICATION line ${h.line}: ${h.text}`);
  }
  if (selfIdHits.length > 0 || identityHits.length > 0 || claimIdHits.length > 0) {
    log(
      `${selfIdHits.length} self-identification match(es), ${identityHits.length} other ` +
        `non-target-derived identity match(es), ${claimIdHits.length} real claim-ID leak(es); ` +
        'return this file for redaction, do not forward'
    );
    process.exit(1);
  }
  process.stdout.write(`scan clean: 0 identity matches, ${otherHits.length} target-derived reported\n`);
}

async function runFlip(args) {
  const mapping = flipMapping();
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(mapping, null, 2) + '\n');
  process.stdout.write(`wrote ${args.out}\n`);
}

async function runTranslate(args) {
  const [auditJson, mappingJson] = await Promise.all([
    fs.readFile(args.in, 'utf8'),
    fs.readFile(args.mapping, 'utf8'),
  ]);
  let mapping;
  try {
    mapping = JSON.parse(mappingJson);
  } catch (err) {
    throw new RelayError(`--mapping is not valid JSON: ${err.message}`);
  }
  const translated = await translateFindings(auditJson, mapping, args.phase1Dir, args.verificationDir);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(translated, null, 2) + '\n');
  process.stdout.write(`translated ${translated.findings.length} finding(s), wrote ${args.out}\n`);
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

async function runValidate(args) {
  const problems = [];
  for (const seat of ['A', 'B']) {
    const text = await readPhase1Seat(seat, args.phase1Dir);
    const { blocks, malformedHeadings, duplicateIds, noFindingsMarker } = extractClaimBlocks(text);
    // relabel's second (peer-letter) pass legitimately exits nonzero with "no <letter> claim IDs,
    // seat header, or rebuttal heading found" when a seat had zero rebuttals to append -- that
    // exit code is documented as expected, not a failure, so a malformed rebuttal heading must be
    // caught here instead: it produces the identical "no match" signal to relabel and would
    // otherwise be silently routed around the same way.
    // Fence-aware and tested against the RAW line, exactly like relabel's own rebuttalHeading
    // check (never trimmed, never applied inside a fence) -- a looser test here (trim, or ignore
    // fences) could accept a heading relabel itself would not recognize (e.g. trailing
    // whitespace), or flag one quoted verbatim inside an Evidence fence as if it were real.
    const { lines: fenceLines } = parseFenceLines(text);
    fenceLines.forEach(({ text: line, inFence }, i) => {
      if (inFence) return;
      const likeMatch = REBUTTAL_HEADING_LIKE_RE.test(line.trim());
      if (!likeMatch) return;
      const exactMatch = REBUTTAL_HEADING_EXACT_RE.exec(line);
      if (exactMatch && exactMatch[1] !== exactMatch[2]) return;
      if (exactMatch) {
        problems.push(
          `${seat}-findings.md:${i + 1}: heading "${line.trim()}" names a seat rebutting its own ` +
            'claims ("from X) of X") -- a rebuttal always addresses the PEER\'s claims, never ' +
            'the same seat\'s own'
        );
        return;
      }
      problems.push(
        `${seat}-findings.md:${i + 1}: heading "${line.trim()}" looks like a rebuttal-section ` +
          'heading but does not match the required "## Rebuttals (from <letter>) of <letter> ' +
          'claims" form -- relabel\'s "no rebuttal heading found" exit is expected for a seat ' +
          'with zero rebuttals, so a malformed heading here would be silently indistinguishable ' +
          'from that case instead of being caught as a formatting defect'
      );
    });
    for (const [id, block] of blocks) {
      // Wrong-seat heading: a real "## B<n>" heading inside A-findings.md (CLAIM_HEADING_RE
      // matches [AB]\d+ regardless of which file it's in, since the regex has no seat context --
      // this is the one malformation class only the caller, which DOES know which file it's
      // reading, can catch).
      if (id[0] !== seat) {
        problems.push(`${seat}-findings.md: claim "${id}" uses seat "${id[0]}"'s letter, not this file's own seat "${seat}"`);
        continue;
      }
      for (const p of claimBlockProblems(block)) {
        problems.push(`${seat}-findings.md: claim "${id}" has ${p}`);
      }
    }
    for (const m of malformedHeadings) {
      problems.push(
        `${seat}-findings.md:${m.line}: heading "${m.text}" looks like an attempted claim ID ` +
          `("${m.attempted}") but does not match the required "## ${seat}<n>" form -- a model ` +
          'ignoring the claim-ID schema (e.g. a bare "## 1") must not be mistaken for a genuine ' +
          'zero-findings pass'
      );
    }
    for (const d of duplicateIds) {
      problems.push(
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
      problems.push(
        `${seat}-findings.md: has zero recognized claim headings and no "## No findings" marker ` +
          '-- an empty or unparseable result is never treated as a legitimate zero-findings ' +
          'verdict; the seat must state it explicitly'
      );
    }
  }
  if (problems.length > 0) {
    for (const p of problems) log(p);
    log(`${problems.length} claim block problem(s); return the affected seat's file to its own ` +
      'context for reformatting (same procedure as a scan redaction round, never a hand edit)');
    process.exit(1);
  }
  process.stdout.write('validate clean: every claim block in both seats has a recognized Severity/Basis/Evidence strength/Evidence, and every rebuttal-section heading matches the required form\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') printUsageAndExit(0);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      process.stderr.write('\n' + USAGE);
      process.exit(2);
    }
    throw err;
  }
  try {
    if (args.sub === 'relabel') await runRelabel(args);
    else if (args.sub === 'scan') await runScan(args);
    else if (args.sub === 'flip') await runFlip(args);
    else if (args.sub === 'translate') await runTranslate(args);
    else if (args.sub === 'validate') await runValidate(args);
  } catch (err) {
    if (err instanceof RelayError) {
      log(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    log(`unexpected failure: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

export {
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
};
