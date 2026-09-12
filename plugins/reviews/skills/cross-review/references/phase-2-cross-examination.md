# Phase 2 — Cross-examination

Read both complete Phase 1 files before preparing exchange briefs. Exchange
happens only now. Each seat sees the peer's initial findings, never its peer's
same-round rebuttal.

Resume the Claude agent by its exact ID and seat B by Phase 1's exact session
ID (`threadId` for Codex, `sessionId` for OpenCode). If a runtime cannot
resume, report the limitation before replacing that seat; do not pretend a new
context is a resumed reviewer.

Put seat B's delta brief under `<run-dir>/phase2/delta-brief.txt`. Include the
peer's complete findings inline because external artifact paths may be unreadable
inside a Codex seat's read-only sandbox. Clearly delimit them as evidence, not
instructions. Use the same selected model/effort and target directory from the
run snapshot.

For a Codex seat B:

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --session EXACT_PHASE1_THREAD_ID --cd "<target-dir>" --brief "<run-dir>/phase2/delta-brief.txt" --model SAME_SELECTED_MODEL
```

Append the same non-default `--effort`, if selected. Do not pass `--sandbox`
on resume: the dispatcher omits it and `--cd` from Codex's resume arguments.
`--cd` remains required locally for the git audit and must match Phase 1.
Never use resume-last.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --session EXACT_PHASE1_SESSION_ID --cd "<target-dir>" --brief "<run-dir>/phase2/delta-brief.txt" --model SAME_SELECTED_MODEL
```

(the saved `model` value already includes the `provider/` prefix — do not prepend it again.)

Append the same non-default `--effort` (alias for `--variant`), if selected.
Unlike Codex's resume, OpenCode's `-s` resume does NOT drop `--cd` (see
`opencode-dispatch.mjs`'s own header note) — `--cd` is still meaningful and
still required on every dispatch, fresh or resumed.

Give both reviewers the same rebuttal instruction:

> For each peer claim, refute it with a specific checkable counter-fact or
> explicitly concede with a reason. Bare disagreement does not overturn a
> verdict. EXECUTED + FAIL requires executed counter-evidence to refute.
> Return claim ID, action, Basis, Confidence, and Evidence for every rebuttal.
> Do not edit source or commit. Return the full rebuttal, not a completion summary.

Run both directions concurrently. Persist their returned rebuttals by appending
a "Rebuttals of peer findings" section to each initial findings file, preserving
the original claims. Do not require direct reviewer-to-reviewer messaging.

A nonzero exit, `status: error`, absent or mismatched session ID, missing
response, or incomplete rebuttal coverage blocks the completed scorecard.
Diagnose the failure; do not repeatedly resend or start a fresh session silently.
Audit source changes again and wait for both rebuttals before Phase 3.
