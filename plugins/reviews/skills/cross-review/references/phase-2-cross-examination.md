# Phase 2 — Cross-examination

Read both complete Phase 1 files before preparing exchange briefs. Exchange
happens only now. Each seat sees the peer's initial findings, never its peer's
same-round rebuttal.

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

## Blind relabel before handoff

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

```text
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase2/peer-view-for-B.md" --from A --to P
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-B.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase1-dir "<run-dir>/phase1" --forbid-seats A
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase2/peer-view-for-A.md" --from B --to P
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-A.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase1-dir "<run-dir>/phase1" --forbid-seats B
```

`--phase1-dir`/`--forbid-seats` on each `scan` is mandatory, not optional: it
mechanically closes the fenced Evidence claim-ID leak class documented under
Model identity below — the source seat's OWN real claim IDs must never
survive relabel inside its own peer-facing view, including inside an
Evidence fence, which `relabel` deliberately never rewrites. Skipping this
flag on either `scan` call reopens exactly that leak.

A nonzero `scan` exit is a hard stop — first-person self-identification and
any other non-target-derived identity mention (third-person included, e.g.
"the Codex reviewer found this") both exit nonzero, per review-protocol.md's
Blind exchange: DELETE the relabeled output file first, then return the
ORIGINAL (un-relabeled) findings file to the reviewer's own context for
redaction — never hand-edit its prose yourself, and never forward a file a
hard-stopped scan has flagged. Allow at most one redaction round, then stop
and report if it still hits. Keep the real `A`/`B`
mapping only in the orchestrator's own state for the manifest; it never
appears in a peer-facing brief.

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

For a Codex seat B:

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --session EXACT_PHASE1_THREAD_ID --cd "<target-dir>" --brief "<run-dir>/phase2/B/delta-brief.txt" --model SAME_SELECTED_MODEL --web --previous-result "<run-dir>/phase1/B/result.json"
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
node "<skill-dir>/scripts/opencode-dispatch.mjs" --session EXACT_PHASE1_SESSION_ID --cd "<target-dir>" --brief "<run-dir>/phase2/B/delta-brief.txt" --model SAME_SELECTED_MODEL --isolate
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

Run both directions concurrently. Save seat B's `finalMessage` to
`phase2/B-rebuttals-raw.md` with a script (seat A wrote its own file), then
append each seat's rebuttals to the PEER's findings file with one command
per direction:

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

Once both rebuttal sections are appended, run `scripts/blind-relabel.mjs
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
