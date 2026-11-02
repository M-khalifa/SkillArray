# Phase 2 — Cross-examination

> **With `review-run` you do not need this file for the normal path.** SKILL.md's Quickstart lists the commands in order. Read it when a
> step fails, a seat must be replaced or resumed, or a scan or validation stops the run.

## Contents

- Resuming each seat
- Exchange
- Blind exchange rules
- Resuming a native seat by hand
- Extra tasks after the exchange

Skip this phase when the mode is `none`: the fresh auditor then compares the
two independent findings sets without rebuttal data (SKILL.md, Invocation).

## Resuming each seat

**Never resume by forking** the orchestrator's own conversation: by the exchange step that
conversation already contains the peer's real findings and identity, so a fork handed to either
seat is a blinding breach by construction, not a resume. Resume the exact Phase 1 seat identity
only: a CLI seat by its session ID, a native seat by its agent ID (the host file gives the
mechanics, and the recovery when the session that started a native seat has ended). If a seat
still cannot be resumed, that seat's exchange is incomplete; a new agent is not the same reviewer. Finish the
exchange without it with `review-run.mjs phase2 --run-dir <run-dir> --wait --incomplete-seat <A|B>`: the other
seat's rebuttals are appended, and the run is recorded as incomplete.

## Exchange

`node "<skill-dir>/scripts/review-run.mjs" phase2 --run-dir "<run-dir>" --start` prepares the
exchange and resumes every CLI seat on its Phase 1 session with its delta brief. It prints the
brief path of each native seat, which you resume with the host's action. `--wait` waits for both
seats, then appends both rebuttal files and validates again. In mode `none` it says so and does
nothing.

Before it, `review-run phase2 --start` moves each seat's leftover Phase 1 scratch folder (`scratch-<hash>`: test files, a link, a mock run) out of the run folder to `<run-dir>-scratch-kept` and says so, since the grant check refuses such files.
The prepare step validates both seat files, copies them to `phase1/original/`, relabels and scans
one direction at a time, and builds both delta briefs. The relabel follows the protocol's Three
label layers: seat A's claims become `P1..Pn` in seat B's brief, and seat B's claims become a
separate `P1..Pn` in seat A's brief. The scan checks the relabeled text for vendor/model tokens AND
for the source seat's own real claim IDs anywhere, fenced Evidence included (`--forbid-seats A` on
the peer view built from seat A's file, `--forbid-seats B` on the one built from seat B's file).
`relabel` never rewrites fence content, so a reviewer's own cross-reference to an earlier claim by
real letter (for example "my A4") inside its Evidence block survives relabel, and only the
`--forbid-seats` check catches it. A validate failure or a scan hit names the seat to send back,
and no brief is built. A self-identification hit or a `--forbid-seats` hit is a hard stop: return
it to that seat for redaction (one redaction round, then stop and report), ask only for the
corrected block, and put it back with `review-run splice` (Redaction scope, below), never by hand.
Even with both seats on Claude, this keeps a reviewer from tailoring its rebuttal to which specific
model it believes wrote a claim. The prepare step refuses once the exchange has started.

Each delta brief carries the scanned peer view verbatim plus review-protocol.md's Rebuttal
instruction, and the seat writes its `### P<n>` entries to its rebuttal file. A seat whose peer
wrote `## No findings` gets no brief and is listed under `no_peer_claims`, which the manifest
records as `exchange.no_peer_claims`, not as an incomplete seat.

The append step checks that every peer claim has exactly one entry, translates `P` back to real
IDs and appends the entries without overwriting the original claims, under a heading of the exact
form `## Rebuttals (from <seat>) of <peer> claims` (for example `## Rebuttals (from A) of B claims`
appended to `B-findings.md`, the PEER's file). Phase 3's `X`/`Y` relabel matches this heading by
exact regex; any other wording is invisible to it. If any step refuses, both findings files are
restored. The append step then runs `validate` again (Phase 1's completion gate ran it before any
rebuttal existed). This second run checks the rebuttal heading's exact form (both seat letters,
`A`/`B`, never a claim ID or any other shape) and rejects a seat naming itself as its own
rebutter. A malformed heading gives the same "no rebuttal heading found" signal that the second
relabel pass gives for a seat with zero rebuttals, so without this run the two cases look the same.
`validate` does not check WHICH file a rebuttal heading is appended to: placement is fixed in prose
(the example above and review-protocol.md: onto the PEER's file), and `relabel` relabels a seat's
letter wherever the heading appears, so `validate` only rejects a seat naming itself as its own
rebutter. A refusal here uses the same redaction-round procedure as a `scan` hit. For a seat that
answers in its final message (a Codex CLI seat, or a Claude CLI seat on a Codex host), rename its
`phase2/<seat>-rebuttals-raw.md` to `<seat>-rebuttals-raw.attempt-<n>.md` before resuming it with the
correction: the dispatcher refuses to overwrite an answer that exists. Wait for both exchanges before
synthesis.

## Blind exchange rules

Before handing either reviewer's findings file to its peer or to the Phase 3
auditor, the files are relabeled and scanned by script, never by hand-relabeling or
hand-grepping: `review-run phase2 --start` and `review-run audit --prepare` do it.

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
scan names the same token again, stop and report to the user rather than looping. A different
token means the first round worked: allow one more round for it. Each scan hit lists its matched token.

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
`review-run audit --prepare` runs this check for you.

**Target-derived exemption for claim-ID and peer-label hits.** `review-run` gives every
validate, scan, append and audit-prep step the target folder; give `review-run scan` the
`--target-dir` too, next to its usual `--phase1-dir` and `--forbid-seats`. A hit is then non-blocking (reported as `target-derived`) when every occurrence of the
token on that line either sits inside a larger chunk that appears verbatim in
the target (a hardware ID `20:00:00:25:B5:00:00:0A`, `df -B1`, "P0-P4"), or the whole
line (20+ characters) appears verbatim in the target (a quoted docstring "P1
scope ... is P2"). A bare "see A2" or "as P7 says" in a reviewer's own words
still hard-stops. In one 14-target run, 11 of 13 hard-stop hits were exactly
these target identifiers and cost 5 redaction rounds.

When the task packet reviews code in other repositories by path, list each one
in the seats file's `sourceDirs`; `review-run` passes them as `--source-dir` to the same
steps. A verbatim
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
drops entries older than a week, and `review-run audit --finish` deletes it as its
cleanup step.

**Outside checklists.** When the packet reviews against a checklist or standard
whose items are numbered like claims, name it in the packet ("checklist CHK:
items C1-C18, R1-R15, P1-P3; cite them as CHK-P1") and add `CHK` to the seats
file's `flags.checklists`: `review-run` passes `--checklist CHK` to every step that
checks labels (scan, append, audit-prep, translate). Give `review-run scan` the same
`--checklist CHK`, next to its usual `--phase1-dir` and `--forbid-seats`.
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
- `relabel` matches inline code spans within a single line only, unlike
  CommonMark's real grammar, which permits a span to cross a line ending. An
  opening backtick run with no matching close on the same line is treated as
  literal text there. This over-relabels genuine multiline code content (a
  claim ID inside it gets relabeled instead of staying untouched) — the
  fail-safe direction for a blind, never a leak. `scan` scans inline code like
  prose in any case. This is
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
reply back with `node "<skill-dir>/scripts/review-run.mjs" splice --file <seat file> --match-heading
"## A3" --with-result <result.json>` (a Codex seat: the reply is the dispatcher's `finalMessage`) or
`--with <file>` (a seat that wrote its reply to a file). `--match-heading "## A3"` replaces that
claim block: the one heading line that starts with it (not `## A30`), up to the next heading of the
same or higher level or an unfenced `---` break, which stays in place. The reply must start with
the same heading. `--match-line "<exact line>"` replaces the one line equal to it, fences included,
such as a leaked Evidence line; an empty reply deletes it. Repeat `--match-line` and `--with` in
pairs (same order) to fix several lines in one call; every pair must apply or the file stays
unchanged. On Windows PowerShell 5.1 use `--match-line-file <file>` (the exact line in a UTF-8
file, one line only) for a line that contains double quotes; it pairs with `--with` the same way.
`--file` can also be a seat's raw rebuttal file (`phase2/<seat>-rebuttals-raw.md`) before the
append step. Leading and trailing blank lines of the reply are dropped, and the file keeps its own
line ending. `splice` refuses, leaving the file unchanged: zero or several matches, an unterminated
fence, text before the heading, a reply holding another heading or a `---` break, and a claim reply
that is not one well-formed claim block (Severity, Basis, Evidence strength, Evidence). Prose
after the Evidence fence is allowed, as in any claim. It writes the file atomically. Never edit
seat text by hand or with an ad-hoc script. Then rerun the `review-run` step that stopped: it
validates and scans the file again. To scan one file yourself first, run
`node "<skill-dir>/scripts/review-run.mjs" scan --in <file> --target-dir <target-dir>
--tokens <seat-a-model>,<seat-b-model> --phase1-dir <run-dir>/phase1 --forbid-seats <A|B|A,B>`
(`--forbid-seats` names the real seat letters that must not survive in that file: the source seat
for a Phase 2 peer view, `A,B` for a Phase 3 file; `--phase1-dir` and `--forbid-seats` go together),
plus `--phase2-dir <run-dir>/phase2` for a Phase 3 file and `--target-urls <file>` (below).

**A CLI seat's redaction turn.** `review-run` has no command for it: resume the seat by hand with its
dispatcher (`claude-dispatch.mjs` or `codex-dispatch.mjs`) and `--session <sessionId or threadId from
phase1/<seat>/result.json>`, its model and effort, the same `--cd` as Phase 1 (for a Claude seat also
`--worktree <worktreePath from that file>`), a brief that holds only the flagged lines and asks for the
corrected block, placed in a new folder outside `phase1/` (the call writes its result.json beside the
brief or in `--out-dir`, so the Phase 1 record stays), `--final-message-out <reply file>` and
`--run-dir <run-dir>`. Do not propose the replacement wording in that brief: the seat writes it. Then
`splice --with <reply file>`.
**Target URLs (mechanical check).** Give a `review-run scan` with the
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

## Resuming a native seat by hand

`phase2 --start` writes each native seat's message to `<run-dir>/phase2/prompt-<seat>.txt`. When that file is
missing (the step stopped on a check you have since cleared), send the seat's agent:
"Phase 2. Read your delta brief from <brief> and follow it exactly. Write your rebuttal entries to <output> in one write
at the end. Do not read any other file in the run folder except the delta brief, your Phase 1 brief, the task packet, your rebuttal file and your own scratch folder. Do not edit any file except your rebuttal file and the files you create in your own scratch folder. Reply with only the word written
and your concede / dispute counts. If you cannot read the brief or write the file, reply with blocked: and the error
message, then stop." Then run the next `review-run` step it accepts (`review-run status` names it).

## Extra tasks after the exchange

A task the review adds for the seats, such as designing a fix for each
finding, is not part of the exchange: the append step accepts exactly one
entry per peer claim. Run it after `review-run phase2 --wait` finished, with its brief in a
folder of its own (for example `phase2/extra/B/brief.txt`): a dispatcher writes
result.json next to its brief, so a brief left in `phase2/` itself writes
`phase2/result.json`, which is easy to leave out of the manifest. Resume a native seat by
sending its agent: "Read your task from <brief> and follow it exactly. Write your result to <output> in one
write at the end. Do not read any other file in the run folder except the brief, your Phase 1 brief, the task packet, your output and your own scratch folder. Do not edit any file except your output and the files you create in your own scratch folder. Reply with only
the word written. If you cannot read the brief or write the file, reply with blocked: and the error
message, then stop." Before anyone else reads an output, run `review-run scan --in <output> --phase1-dir
<run-dir>/phase1 --forbid-seats <the other seat's letter>` on it (a brief that asks the seat to cite its own
claim IDs makes them expected in its output), and pass each dispatched call's
result.json to `review-run manifest --reviewer-result`. Extra outputs are not
auditor input (`audit --prepare` stages only the findings files); name in the report
any fact an extra output raised that no claim covers.
