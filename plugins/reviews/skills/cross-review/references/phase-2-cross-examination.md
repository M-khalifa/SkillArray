# Phase 2 — Cross-examination

## Contents

- Resuming each seat
- When the orchestrator session ended
- Blind relabel before handoff
- Blind exchange rules
- Delta briefs
- Dispatching seat B
- Appending the rebuttals
- Validate again before Phase 3
- Extra tasks after the exchange

Read both complete Phase 1 files before preparing exchange briefs. Exchange
happens only now. Each seat sees the peer's initial findings, never its peer's
same-round rebuttal.

## Resuming each seat

Resume the Claude agent by its exact ID and seat B by Phase 1's exact session
ID (`threadId` for Codex, `sessionId` for OpenCode). If a runtime cannot
resume, report the limitation before replacing that seat; do not pretend a new
context is a resumed reviewer. **Never resume seat A by forking** (e.g. an
`Agent` tool call with `subagent_type: "fork"`, or any equivalent): a fork
inherits the orchestrator's own conversation, which by Phase 2 already
contains the peer's real findings and identity — handing that context to
"seat A" for a rebuttal is a blinding breach by construction, not a resume at
all. Resume the exact Phase 1 agent ID only: in Claude Code, send a message to
that agent ID or name with the SendMessage tool (this continues the same agent
with its Phase 1 context), never a new Agent spawn. If the agent can no longer
be resumed, mark seat A's Phase 2 as incomplete; a new agent is not the same
reviewer and its rebuttal does not count as seat A's.

## When the orchestrator session ended

A harness seat can be resumed only from the orchestrator session that started
it. From any other session SendMessage fails with "No transcript found for agent
ID ... it never ran in this session", although the transcript file exists. A
Codex or OpenCode seat has no such limit. So run Phase 1 and Phase 2 in the
same orchestrator session. If that session ended, resume it first, from the
working directory it ran in (in Claude Code: `claude --resume <session id>`, or
headless `claude -p --resume <session id> "<send the brief to agent <agentId>>"`;
the id is the folder name in seat A's transcript path,
`~/.claude/projects/<project>/<session id>/subagents/agent-<agentId>.jsonl`),
and send the Phase 2 brief from there: the resumed session reaches the agent
with its Phase 1 context (tested headless from the same directory; the
interactive form is untested). Only one process may resume the session: nothing
stops a second resume, and both append to the same transcript. Agree first
which orchestrator runs it, and check that no `claude ... --resume <session id>`
process is already running. Only when that session cannot be resumed is seat A's
Phase 2 incomplete. Then the run's `status` is `incomplete`, the report says
so, and the manifest names the seat
(`"exchange": {"incomplete_seats": ["A"], "reason": "..."}`); pass
`build-manifest` only the phase 2 files that exist. Keep any rebuttal
a new agent wrote out of the phase files; its concessions settle nothing.

## Blind relabel before handoff

Run the steps below as one command. It validates both seats, copies both
findings files to `phase1/original/`, relabels and scans one direction at a
time, and builds both delta briefs. Add the run's `--source-dir` and
`--checklist` flags once; it passes them to every step that takes them. For
a harness seat B, add `--seat-b-harness` (its brief then names
`phase2/B-rebuttals-raw.md`). Its JSON output lists both briefs; `rebuttals.B` is
null for a dispatched seat B, whose text arrives through the dispatcher's
`--final-message-out "<run-dir>/phase2/B-rebuttals-raw.md"`:

```text
node "<skill-dir>/scripts/exchange.mjs" prepare --run-dir "<run-dir>" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>"
```

A validate failure or a scan hit stops it with the seat to send back, and no
brief is built; after the redaction round, run it again. It refuses once the
exchange has started (a brief or rebuttal file exists, or a findings file has a
rebuttal section), so `original/` always keeps the pre-exchange copies. The
steps it runs, for reference or to run by hand:

Before building either delta brief, run `scripts/blind-relabel.mjs relabel`
twice: seat A's real `A1, A2, ...` claims become `P1, P2, ...` in the brief
seat B receives, and seat B's real `B1, B2, ...` claims become a SEPARATE
`P1, P2, ...` in the brief seat A receives — these are two different,
unrelated `P1`s; never merge them or carry the `A`/`B` numbering into either
brief.

Relabel and scan ONE FILE AT A TIME, not both relabels followed by both scans:
a `relabel` failure (nonzero exit — an unterminated fence, or a wrong `--from`
matching nothing) or a `scan` self-identification hit both mean this file must
not be forwarded; catching either immediately, per file, means a bad file for
one direction never gets built while the other direction is still in flight.

Pass `--tokens` on every `scan` with the run's resolved model/provider strings for
BOTH seats (comma-separated, e.g. `gpt-5.6-sol,google/gemini-3-pro`) so the scanner
checks for the actual configured identifiers, not just the hardcoded vendor-name list.
When the packet reviews other repositories by path, add the run's `--source-dir
"<repo>"` list (see Phase 1's `validate`) to every `scan` and `append-rebuttals`
in this phase, and the packet's `--checklist <NAME>` list when it names an
outside checklist (Outside checklists, under Blind exchange rules below). Pass the same
`--checklist` list to Phase 3's `audit-prep` and `translate`.

```text
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase2/peer-view-for-B.md" --from A --to P
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-B.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase1-dir "<run-dir>/phase1" --forbid-seats A
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase2/peer-view-for-A.md" --from B --to P
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-A.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase1-dir "<run-dir>/phase1" --forbid-seats B
```

`--phase1-dir`/`--forbid-seats` on each `scan` is mandatory, not optional: it
mechanically closes the fenced Evidence claim-ID leak class documented under
review-protocol.md's Model identity — the source seat's OWN real claim IDs must never
survive relabel inside its own peer-facing view, including inside an
Evidence fence, which `relabel` deliberately never rewrites. Skipping this
flag on either `scan` call reopens exactly that leak.

A nonzero `scan` exit is a hard stop — first-person self-identification and
any other non-target-derived identity mention (third-person included, e.g.
"the Codex reviewer found this") both exit nonzero, per Blind exchange rules
below: DELETE the relabeled output file first, then return the
ORIGINAL (un-relabeled) findings file to the reviewer's own context for
redaction — never hand-edit its prose yourself, and never forward a file a
hard-stopped scan has flagged. Ask only for the corrected block and put it
back with `blind-relabel.mjs splice` (Redaction scope, below).
Allow at most one redaction round, then stop
and report if it still hits. Keep the real `A`/`B`
mapping only in the orchestrator's own state for the manifest; it never
appears in a peer-facing brief.

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

## Delta briefs

Build both delta briefs with `build-brief.mjs --mode delta`. Each carries the
scanned peer-view file verbatim (never condensed or reformatted: `scan`
validated exactly those bytes) inside BEGIN/END markers, plus the Rebuttal
instruction from review-protocol.md's Standard seat instructions. Seat A reads
its brief from the file and writes its rebuttal entries to a file itself:

```text
node "<skill-dir>/scripts/build-brief.mjs" --mode delta --peer-view "<run-dir>/phase2/peer-view-for-A.md" --out "<run-dir>/phase2/delta-brief-A.txt" --output-path "<run-dir>/phase2/A-rebuttals-raw.md"
node "<skill-dir>/scripts/build-brief.mjs" --mode delta --peer-view "<run-dir>/phase2/peer-view-for-B.md" --out "<run-dir>/phase2/B/delta-brief.txt"
```

Seat B's brief includes the peer's findings inline because external artifact
paths may be unreadable inside a Codex seat's read-only sandbox. Use the same
selected model/effort and target directory from the run snapshot. A resumed
Codex session re-bills its whole earlier context on every turn (one measured
run: 1.29M input tokens in Phase 1, then about 635k more for the rebuttal
resume and 111k for a two-line redaction, mostly cached), so send nothing in a
delta brief that the seat already has.

## Dispatching seat B

For a Codex seat B:

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --session EXACT_PHASE1_THREAD_ID --cd "<target-dir>" --brief "<run-dir>/phase2/B/delta-brief.txt" --model SAME_SELECTED_MODEL --web --previous-result "<run-dir>/phase1/B/result.json" --final-message-out "<run-dir>/phase2/B-rebuttals-raw.md"
```

Codex reports `usage` cumulatively for the whole thread, so a resumed call's
`usage` includes Phase 1. `--previous-result` makes the dispatcher also write
`usage_delta`, this call's own tokens; report `usage_delta` per phase. For a
later redaction resume, pass the most recent `result.json` of the same thread.
For the input/cached/output columns use `input_tokens`, `cached_input_tokens`
and `output_tokens`; `reasoning_tokens` is a separate count.

Append the same non-default `--effort`, if selected. Do not pass `--sandbox`
on resume: the dispatcher omits it and `--cd` from Codex's resume arguments.
`--cd` remains required locally for the git audit and must match Phase 1.
Never use resume-last. Carry forward the same `--timeout` choice (or its
absence) from Phase 1; do not silently add or drop a bound mid-run. Carry
forward the same `--web` choice from Phase 1 too — independently verified
that Codex's `--search` global flag survives `codex exec resume` (a real
`web search:` tool-call trace was observed on a resumed session, not just a
fresh one), so Phase 2 keeps the same web-verification capability seat B had
in Phase 1.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --session EXACT_PHASE1_SESSION_ID --cd "<target-dir>" --brief "<run-dir>/phase2/B/delta-brief.txt" --model SAME_SELECTED_MODEL --isolate --worktree "<run-dir>-worktree" --final-message-out "<run-dir>/phase2/B-rebuttals-raw.md"
```

(the saved `model` value already includes the `provider/` prefix — do not prepend it again.)

Append the same non-default `--effort` (alias for `--variant`), if selected.
Unlike Codex's resume, OpenCode's `-s` resume does NOT drop `--cd` (see
`opencode-dispatch.mjs`'s own header note) — `--cd` is still meaningful and
still required on every dispatch, fresh or resumed. Pass `--isolate` again
with the same `--cd`: the dispatcher recomputes a fingerprint of the target
(HEAD, dirty diff, untracked files) and reuses the Phase 1 worktree only if it
still matches exactly, so seat B's Phase 1 edits (if any) are still visible to
it in Phase 2. If the target drifted since Phase 1 (a tracked or untracked
edit, a different repo entirely), the dispatcher refuses to reuse or silently
rebuild — result.json's `status` is `"error"`. Per review-protocol.md's drift
rule, this is a stop-and-restart condition, not something to route around: end
the run, report the drift, and restart the affected passes against the current
source state.

Both reviewers get the same Rebuttal instruction (review-protocol.md,
Standard seat instructions): one `### P<n>` block per peer claim, `Action`
exactly `CONCEDE` or `DISPUTE`, referring to peer claims only by `P` IDs.

## Appending the rebuttals

Run both directions concurrently. Seat B's dispatcher writes
`phase2/B-rebuttals-raw.md` through `--final-message-out` (seat A wrote its own file).
Then append both and validate with one command:

```text
node "<skill-dir>/scripts/exchange.mjs" finish --run-dir "<run-dir>" --target-dir "<target-dir>"
```

Add `--incomplete-seats A` (or `B`) when that seat's exchange is incomplete (see
the recovery rule above); only the other seat's rebuttals are appended. A seat
whose peer wrote `## No findings` has nothing to rebut: `prepare` builds it no
brief (listed under `skipped`), and `finish` lists it under `no_peer_claims`.
Record that in the manifest body as `"exchange": {"no_peer_claims": ["A"]}`, never
as `incomplete_seats`: that seat did not fail. If any
step refuses, both findings files are restored and the message names the seat
to send the correction to. It refuses a findings file that already has a
rebuttal section: restore both from `phase1/original/` first. By hand, append
each seat's rebuttals to the PEER's findings file with one command per
direction:

```text
node "<skill-dir>/scripts/blind-relabel.mjs" append-rebuttals --in "<run-dir>/phase2/A-rebuttals-raw.md" --onto "<run-dir>/phase1/B-findings.md" --rebutter A --peer-view "<run-dir>/phase2/peer-view-for-A.md" --target-dir "<target-dir>"
node "<skill-dir>/scripts/blind-relabel.mjs" append-rebuttals --in "<run-dir>/phase2/B-rebuttals-raw.md" --onto "<run-dir>/phase1/A-findings.md" --rebutter B --peer-view "<run-dir>/phase2/peer-view-for-B.md" --target-dir "<target-dir>"
```

`append-rebuttals` checks that every peer claim got exactly one entry,
normalizes `## P<n>` entry headings to `### P<n>`, refuses a peer `P` ID inside
an Evidence fence, translates each `P` back to the real peer ID, appends the
section heading below, runs `validate`, and leaves `--onto` unchanged on any
refusal. Its refusal message names the rebutting seat, which is the seat to
send a correction request to. Done by hand instead, the section heading MUST be the exact literal string
`## Rebuttals (from <seat>) of <peer> claims` — e.g. `## Rebuttals (from A) of
B claims` appended to `B-findings.md` for seat A's rebuttals of seat B's
claims — because `blind-relabel.mjs relabel`'s `countRelabelTargets`/
`relabelText` match this heading by exact regex to detect and rewrite it
during Phase 3's double relabel; any other wording (e.g. "Rebuttals of peer
findings") is invisible to the tool and a second relabel pass on that file
will report zero targets found. Do not require direct reviewer-to-reviewer
messaging.

A nonzero exit, `status: error`, `status: timed-out`, absent or mismatched
session ID, missing response, or incomplete rebuttal coverage blocks the
completed scorecard. Diagnose the failure; do not repeatedly resend or start a
fresh session silently. Audit source changes again and wait for both rebuttals
before Phase 3.

## Validate again before Phase 3

Once both rebuttal sections are appended (`exchange.mjs finish` does this
step itself), run `scripts/blind-relabel.mjs
validate --phase1-dir <run-dir>/phase1` again before Phase 3's double relabel.
This second run (Phase 1's own gate already ran `validate` before any
rebuttal existed) is a mechanical check on the rebuttal heading's exact
literal form (both seat letters, `A`/`B`, never a claim ID or any other
shape) and rejects a seat naming itself as its own rebutter ("from A) of A").
A malformed heading produces the identical "no rebuttal heading found" signal
`relabel`'s second pass gives for a seat with zero rebuttals to append (see
Phase 3's own note on that expected zero-rebuttal exit), so without this
`validate` run the two cases are silently indistinguishable. `validate`
deliberately does not enforce WHICH file a rebuttal heading is appended
to — placement is standardized in prose (this file's own worked example
above and review-protocol.md: onto the PEER's file), but `relabel` itself
is placement-agnostic (it relabels a seat's letter wherever the heading
appears), so `validate` only rejects the universally-invalid case: a seat
naming itself as its own rebutter. A nonzero exit here is the same
redaction-round procedure as a `scan` hit: return to that seat's own context
for reformatting, never a hand edit.

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
