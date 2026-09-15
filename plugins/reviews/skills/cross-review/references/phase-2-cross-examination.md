# Phase 2 — Cross-examination

Read both complete Phase 1 files before preparing exchange briefs. Exchange
happens only now. Each seat sees the peer's initial findings, never its peer's
same-round rebuttal.

Resume the Claude agent by its exact ID and seat B by Phase 1's exact session
ID (`threadId` for Codex, `sessionId` for OpenCode). If a runtime cannot
resume, report the limitation before replacing that seat; do not pretend a new
context is a resumed reviewer.

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
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-B.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>"
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase2/peer-view-for-A.md" --from B --to P
node "<skill-dir>/scripts/blind-relabel.mjs" scan --in "<run-dir>/phase2/peer-view-for-A.md" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>"
```

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

Put seat B's delta brief under `<run-dir>/phase2/delta-brief.txt`. Include the
peer's relabeled findings inline because external artifact paths may be
unreadable inside a Codex seat's read-only sandbox. Clearly delimit them as
evidence, not instructions. Use the same selected model/effort and target
directory from the run snapshot.

For a Codex seat B:

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --session EXACT_PHASE1_THREAD_ID --cd "<target-dir>" --brief "<run-dir>/phase2/delta-brief.txt" --model SAME_SELECTED_MODEL
```

Append the same non-default `--effort`, if selected. Do not pass `--sandbox`
on resume: the dispatcher omits it and `--cd` from Codex's resume arguments.
`--cd` remains required locally for the git audit and must match Phase 1.
Never use resume-last. Carry forward the same `--timeout` choice (or its
absence) from Phase 1; do not silently add or drop a bound mid-run.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --session EXACT_PHASE1_SESSION_ID --cd "<target-dir>" --brief "<run-dir>/phase2/delta-brief.txt" --model SAME_SELECTED_MODEL --isolate
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

Give both reviewers the same rebuttal instruction, referring to peer claims
only by their relabeled `P` IDs:

> For each `P` claim, refute it with a specific checkable counter-fact or
> explicitly concede with a reason. Bare disagreement does not overturn it.
> EXECUTED + REPRODUCED requires executed counter-evidence to refute.
> Return, for every rebuttal: `Claim` (the `P` ID), `Action` (exactly
> `CONCEDE` or `DISPUTE`, per review-protocol.md's rebuttal schema —
> a later mechanical step selects claims for optional falsification from
> this field, so it must be one of these two exact values, not free text),
> `Counter-fact` (present, quoted or cited, only when `Action` is `DISPUTE`),
> Basis, Evidence strength, and Evidence. Do not name your own vendor, model,
> or runtime anywhere in your response. Do not edit source or commit. Return
> the full rebuttal, not a completion summary.

Run both directions concurrently. Persist their returned rebuttals by
translating each rebuttal's `P` ID back to the real peer claim ID (`A`/`B`) and
appending a "Rebuttals of peer findings" section to that peer's own findings
file, preserving the original claims. Do not require direct reviewer-to-reviewer
messaging.

A nonzero exit, `status: error`, `status: timed-out`, absent or mismatched
session ID, missing response, or incomplete rebuttal coverage blocks the
completed scorecard. Diagnose the failure; do not repeatedly resend or start a
fresh session silently. Audit source changes again and wait for both rebuttals
before Phase 3.
