# Phase 2 — Cross-examination

## Contents

- Resuming each seat
- Exchange
- Blind exchange rules
- Extra tasks after the exchange

Skip this phase when the mode is `none`: the fresh auditor then compares the
two independent findings sets without rebuttal data (SKILL.md, Invocation).

## Resuming each seat

**Never resume by forking** (e.g. an `Agent` tool call with
`subagent_type: "fork"`, or any equivalent that inherits the orchestrator's
own conversation): by the exchange step that conversation already
contains the peer's real findings and identity, so a fork handed to either
seat is a blinding breach by construction, not a resume. Resume the exact
Phase 1 agent/session ID only: in Claude Code, send a message to that
agent ID or name with the SendMessage tool, never a new Agent spawn. Both
seats can be resumed only from the orchestrator session that started them
(from another session SendMessage reports "No transcript found for agent
ID"), so run the exchange in that session. If it ended, resume it first,
from the working directory it ran in (`claude --resume <session id>`, or
headless `claude -p --resume <session id> "<prompt>"`; the resumed session
reaches the seat with its context, tested headless only; the id is the folder name in the seat's
`~/.claude/projects/<project>/<session id>/subagents/agent-<agentId>.jsonl`
path). Only one process may resume it: first check that no
`claude ... --resume <session id>` is already running. If a seat still cannot be resumed, that seat's exchange is
incomplete; a new agent is not the same reviewer.

## Exchange

Unless mode is `none`, run these steps as one command:
`node "<skill-dir>/scripts/exchange.mjs" prepare --run-dir "<run-dir>"
--target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>"
--seat-b-harness` (plus the run's `--source-dir`/`--checklist` flags). It
validates, copies both files to `phase1/original/`, relabels and scans one
direction at a time, and builds both delta briefs (`phase2/delta-brief-A.txt`,
`phase2/delta-brief-B.txt`). A validate failure or scan hit names the seat
to send back and builds no brief; it refuses once the exchange has started.
After both seats wrote their rebuttals, `exchange.mjs finish --run-dir
"<run-dir>" --target-dir "<target-dir>"` appends both and validates
(`--incomplete-seats A|B` for a seat that cannot be resumed; a seat whose
peer wrote `## No findings` gets no brief and is listed under
`no_peer_claims`, which the manifest records as `exchange.no_peer_claims`,
not as an incomplete seat), restoring both
files if any step refuses. The steps they run, by hand:
use `scripts/blind-relabel.mjs relabel` to relabel
each seat's findings per the protocol's Three label layers before sending to
the other reviewer (seat A's claims become `P1..Pn` in seat B's brief, seat
B's claims become a separate `P1..Pn` in seat A's brief), then
`scripts/blind-relabel.mjs scan` the relabeled text for vendor/model tokens
AND (`--phase1-dir <run-dir>/phase1 --forbid-seats A` on the peer-view built from
seat A's file, `--forbid-seats B` on the one built from seat B's file) the
source seat's own real claim IDs surviving anywhere, fenced Evidence
included — `relabel` deliberately never rewrites fence content, so a
reviewer's own cross-reference to an earlier claim by real letter (e.g.
"my A4") inside its Evidence block survives relabel undetected by the
vendor/model-token scan alone; omitting `--forbid-seats` here reopens that
leak. A self-identification hit or a `--forbid-seats` hit is a hard stop,
return it to that seat for redaction (one redaction round, then stop and
report): ask only for the corrected block and put it back with
`blind-relabel.mjs splice --file <seat file> --match-heading "## A3" --with
<reply file>` (or `--match-line` for one line), never by hand. Even with both seats on Claude, this keeps a reviewer from
tailoring its rebuttal to which specific model it believes wrote a claim.
Use file-ready messages when
supported; otherwise relay via the orchestrator. Build each seat's
exchange brief with `build-brief.mjs --mode delta --peer-view <the
scanned peer-view for that seat> --out <brief file> --output-path
<run-dir>/phase2/<seat>-rebuttals-raw.md`; it carries the peer-view
verbatim plus review-protocol.md's Rebuttal instruction, and the seat
writes its `### P<n>` entries to that file.
Append them with `scripts/blind-relabel.mjs append-rebuttals --in
<raw file> --onto <the PEER's findings file> --rebutter <seat> --peer-view
<the peer-view that seat saw> --target-dir <target-dir>`, which checks coverage, translates `P` back
to real IDs, and writes the heading below. Done by hand instead, append rebuttals
(translated back to real `A`/`B` IDs) without overwriting original claims,
under a section heading of the exact literal form `## Rebuttals (from
<seat>) of <peer> claims` (e.g. `## Rebuttals (from A) of B claims`
appended to `B-findings.md`) — `blind-relabel.mjs relabel` matches this
heading by exact regex during the `X`/`Y` relabel in Phase 3 step b; any
other wording is invisible to the tool. Wait for both exchanges before
synthesis. Once both rebuttal sections are appended, run
`scripts/blind-relabel.mjs validate --phase1-dir <run-dir>/phase1` again (Phase 1's
completion gate already ran it before any rebuttal existed) — this second run is a
mechanical check on the rebuttal heading's exact form (both seat letters,
`A`/`B`, never a claim ID or any other shape) and rejects a seat naming
itself as its own rebutter. A malformed heading produces the identical "no
rebuttal heading found" signal `relabel`'s second pass gives for a seat
with zero rebuttals (Phase 3 step b's own expected zero-rebuttal case), so
without this run the two are silently indistinguishable. `validate`
deliberately does not enforce WHICH file a rebuttal heading is appended
to — placement is standardized in prose (this step's own example above
and review-protocol.md: onto the PEER's file), but `relabel` itself is
placement-agnostic (it relabels a seat's letter wherever the heading
appears), so `validate` only rejects the universally-invalid case: a seat
naming itself as its own rebutter. A nonzero exit here uses the same
redaction-round procedure as a `scan` hit.

## Blind exchange rules

Before handing either reviewer's findings file to its peer or to the Phase 3
auditor, run `scripts/blind-relabel.mjs` (`exchange.mjs prepare` and
`audit-prep` run it for you) rather than hand-relabeling or hand-grepping.

`relabel` rewrites claim IDs per review-protocol.md's Three label layers table. It rewrites
only REAL claim IDs: those that appear in the input file as a claim heading
(`## A<n>`), a rebuttal entry heading (`### A<n>`), or a `Claim: A<n>` line, plus
the Phase 1 headings when `--phase1-dir` is given. A product name such as
`A100` stays unchanged. Numbers are preserved (`A7` becomes `P7`), so a peer's
`P7` maps back to the original `A7`. Fenced/inline spans are left untouched,
so never put a claim ID inside an Evidence fence.

`scan` checks the relabeled prose, inline code included (only fenced Evidence is
skipped), for vendor/model tokens (`claude`,
`anthropic`, `codex`, `openai`, `gpt-`, `opencode`, `fable`, `opus`, plus the
actual configured model/provider strings for this run) and for a seat-letter
mention (`seat A`, `reviewer A`, ...). Tokens match whole words only, so
`affable` is not `fable`. The target-derived exemption is built from the
target's tracked and non-ignored files only (never `.git/` contents such as a
branch name, never `node_modules/`). `scan` distinguishes three tiers:

1. **Self-identification (hard stop).** Genuine first-person
   self-identification near a token or seat letter — e.g. "as Codex I ran
   the suite", "As seat A, I found...".
2. **Identity mention (hard stop).** Any OTHER non-target-derived mention of
   a vendor/model token or seat letter, third person included — e.g. "the
   Codex reviewer found this", "reviewer A found the issue". Third-person
   identity prose is as real a leak as first-person self-identification.
3. **Target-derived mention (exempt).** A finding's `Evidence` citing this
   repo's own source (file paths like `codex-dispatch.mjs`, or catalog
   model IDs like a placeholder such as `gpt-6-astra`), OR a seat-letter
   mention when the reviewed target's own docs use seat vocabulary because
   the target IS a review protocol like this one. Expected and reported for
   the orchestrator's own review, never a stop.

Tiers 1 and 2 behave identically: return the file to the reviewer's own
context for redaction. Never silently forward or hand-edit prose on the
reviewer's behalf. Allow at most one redaction round per file; if the second
scan still hits, stop and report to the user rather than looping.

**Every `scan` in this run MUST also pass `--phase1-dir <run-dir>/phase1
--forbid-seats <the real seat letter(s) that must not survive in THIS
file>`** (the source seat only for a Phase 2 peer-view; both real letters for
a Phase 3 double-relabeled file). Unlike the vendor/model-token check above,
this scans the RAW text — fenced Evidence content INCLUDED — for the run's
actual enumerable real claim IDs, so a claim ID a reviewer places inside its
own Evidence fence (which `relabel` never touches) is still caught. A hit is
a hard stop, same redaction procedure as tiers 1/2. Never scoped to a generic
pattern like `\b[AB]\d+\b`, which would false-positive on a legitimate
target-code identifier, hex digest, or cell reference — only the real claim
IDs that exist in this run's own Phase 1 files are forbidden.

**Every Phase 3 `scan` MUST also pass `--phase2-dir <run-dir>/phase2`.** A
reviewer's rebuttal can mention a peer claim as `P12`, including inside an
Evidence fence that relabel never rewrites. That `P12` means a different claim
in the auditor's namespace. With `--phase2-dir`, any `P<n>` whose number is a
claim in that run's peer-view files is a hard stop, fences included.
`blind-relabel.mjs audit-prep` runs this check for you.

**Target-derived exemption for claim-ID and peer-label hits.** Give `scan`,
`audit-prep`, `append-rebuttals` and `validate` the `--target-dir`. A hit is
then non-blocking (reported as `target-derived`) when every occurrence of the
token on that line either sits inside a larger chunk that appears verbatim in
the target (a hardware ID `20:00:00:25:B5:00:00:0A`, `df -B1`, "P0-P4"), or the whole
line (20+ characters) appears verbatim in the target (a quoted docstring "P1
scope ... is P2"). A bare "see A2" or "as P7 says" in a reviewer's own words
still hard-stops. In one 14-target run, 11 of 13 hard-stop hits were exactly
these target identifiers and cost 5 redaction rounds.

When the task packet reviews code in other repositories by path, pass each one
as `--source-dir <repo>` (repeatable) to the same four commands. A verbatim
quote from one of them then counts as target text for this exemption only;
vendor-name and seat-vocabulary exemptions still come from `--target-dir`
alone. In one live run a quoted source line with "P2" from a second repository
hard-stopped audit-prep and cost an extra seat turn. The first command reads
every listed repository (`validate` with six repositories, about 1.2 GB on
disk, took 18 s on one Windows machine); later commands in the run reuse a
cached copy in a per-user folder under the OS temp folder, keyed by the size,
mtime and ctime of every file plus, for git, HEAD, the status list and the bytes
of changed files, so any edit forces a fresh read. The cache is used only from a
directory this user owns and others cannot read; it keeps one entry per target,
drops entries older than a week, and `blind-relabel.mjs clear-cache` deletes it
(the run's cleanup step).

**Outside checklists.** When the packet reviews against a checklist or standard
whose items are numbered like claims, name it in the packet ("checklist CHK:
items C1-C18, R1-R15, P1-P3; cite them as CHK-P1") and pass `--checklist CHK`
to every `scan`, `append-rebuttals`, `audit-prep` and `translate` of the run.
Only a declared name exempts: `CHK-P1` and `CHK-P1-P3` pass, while `P1`, `OK-P1`
or a spaced range tail (`CHK-P1 - P7`) is still checked.

**Model names quoted from the target.** A target can itself name vendors or
models (a pricing page that says "GPT-5.4/5.5 calls above 272K input"). A
third-person vendor or model mention is reported, not a hard stop, when every
occurrence on the line sits inside a longer chunk found verbatim in the
`--target-dir` text (not `--source-dir`), or the whole 20+ character line is
target text. The bare name in a reviewer's own words ("the GPT-5.4 reviewer
found") still hard-stops, and first-person self-identification ("as GPT-5.4 I
checked") always does.

This check is necessary but not sufficient. Five residual limitations:

- A real leak whose exact chunk, or whose whole 20+ character line, also
  appears in the target (or in any `--source-dir`) passes as target-derived.
  Each `--source-dir` adds text, so pass only repositories the packet names.

- A token shaped like a claim ID that is not a real claim of this run (a
  hallucinated `A99`) is not rewritten by `relabel`, and `--forbid-seats` does
  not flag it, because it is not a real ID. It carries no seat identity, but
  the auditor sees it as written.

- Writing style, file layout conventions, or phrasing can still hint at
  identity.
- The target-derived exemption (tier 3) is token-global: a token found
  anywhere in the target grants blanket exemption everywhere in the scanned
  text, not just where it's genuinely citing the target. It does not check
  each occurrence's actual context.
- `relabel`/`scan` match inline code spans within a single line only, unlike
  CommonMark's real grammar, which permits a span to cross a line ending. An
  opening backtick run with no matching close on the same line is treated as
  literal text there. This over-scans and over-relabels genuine multiline
  code content (a claim ID inside it gets relabeled instead of staying
  untouched; an identity token inside it gets scanned instead of being
  exempt) — the fail-safe direction for a blind, never a leak. This is
  deliberately not "fixed" with a naive cross-line matcher: a span that
  stays open until the next matching backtick run anywhere later in the
  file would let one unrelated stray backtick swallow real headings and
  claim IDs in between, hiding them from `relabel`/`scan` — the unsafe
  direction this protocol's fence/span rules exist to avoid. A correct fix
  needs span matching bounded to a single block (CommonMark inlines never
  cross a blank line or a block-interrupting line), deferred to a later
  release.

Document all five as residual limitations rather than claiming perfect
blinding.

**Redaction scope.** A redaction round sends the reviewer only the flagged
lines (the `scan` output names them) and asks for just the corrected claim
block, with no other text, then re-scans the whole file. Re-sending the whole
file to change two lines costs a full seat turn for no quality gain. Put the
reply back with `blind-relabel.mjs splice --file <seat file> --match-heading
"## A3" --with-result <result.json>` (a Codex/OpenCode seat) or `--with
<file>` (a seat that wrote its reply to a file); `--match-line "<exact line>"`
replaces one line, such as a leaked Evidence line. `--file` can also be a seat's
raw rebuttal file (`phase2/<seat>-rebuttals-raw.md`) before `finish`. The block ends at the next
heading or `---` break, which stays in place. `splice` refuses, leaving the
file unchanged: a match that is not unique, text before the heading, a reply
holding another heading or a `---` break, and a claim reply that is not one
well-formed claim block (Severity, Basis, Evidence strength, Evidence). Prose
after the Evidence fence is allowed, as in any claim. Never edit seat text by
hand or with an ad-hoc script.

**Target URLs (mechanical check).** Give a `blind-relabel.mjs scan` with the
usual `--phase1-dir`/`--forbid-seats` flags the target's own URLs with
`--target-urls <file>` (one per line; extract them from the target, e.g. the
hyperlinks of a document). Every matching URL in a findings file is reported
as a `TRUST-BOUNDARY` line. It does not change the exit code: the orchestrator
checks whether the seat fetched that URL or only quoted it, and a fetched
target-embedded URL is not independent evidence for the claim it supports.
For a Codex seat, `result.json`'s `webCalls` lists every web search it ran
(its `queries`, the opened page URL and the result URLs; one batched call can
carry several queries, so count queries, not entries, against the cap); a URL
that appears there was seen
through the web, one that does not was quoted from the target. A Claude seat
has no such record; ask it in the exchange or redaction turn.

## Extra tasks after the exchange

A task the review adds for the seats, such as designing a fix for each
finding, is not part of the exchange: `append-rebuttals` accepts exactly one
entry per peer claim. Run it after `exchange.mjs finish`, with its brief in a
folder of its own (for example `phase2/extra/B/brief.txt`): a dispatcher writes
result.json next to its `--brief`, so a brief left in `phase2/` itself writes
`phase2/result.json`, which is easy to leave out of the manifest. Resume a
dispatched seat with `--previous-result` set to its thread's last result.json.
Before anyone else reads an output, run `blind-relabel.mjs scan --phase1-dir
<run-dir>/phase1 --forbid-seats A,B` on it, and pass each dispatched call's
result.json to `build-manifest --reviewer-result`. Extra outputs are not
auditor input (`audit-prep` stages only the findings files); name in the report
any fact an extra output raised that no claim covers.
