# Phase 1 — Independent passes

Resolve configuration and complete SKILL.md preflight before this phase.

## Run directory and source snapshot

Create a unique directory under the harness scratchpad or OS temporary directory.
Use an OS temporary-directory helper or a random run ID, not just the task slug.
Record its absolute path as `<run-dir>`; all later phases reuse it. Keep
`phase1/`, `phase2/`, and `phase3/` results separate so no `result.json`
overwrites an earlier phase's audit.

Use the same source snapshot, including relevant dirty files, for both seats.
The default review must not edit the target. Give both seats the actual scope,
test commands, execution permissions, findings schema from
[review-protocol.md](review-protocol.md), and the no-source-edit/no-commit rule.
Tests requiring writes must use approved disposable locations; if that is not
possible, mark those checks blocked and report a non-EXECUTED basis instead.

Pick a lens from [review-profiles.md](review-profiles.md) (Code, Architecture,
or Document — inferred from the target, not asked of the user unless genuinely
ambiguous) and give both seats the same choice in the task packet.

## Start both seats concurrently

Both seats write findings under their own `A`/`B` claim numbering per
[review-protocol.md](review-protocol.md)'s Three label layers — never `CL`/`CX`,
never a vendor name in the claim ID. Give both seats the Model identity
instruction verbatim: never name your own vendor, model, or runtime anywhere in
your findings, and never name your own seat letter in prose either (it belongs
only in claim IDs and the seat header); describe tools generically.

Claude (seat A): use the selected seat-A model and supported effort mechanism.
Give the agent a unique name and keep its agent ID for the next phase. Its
claims use `A1, A2, ...`. It must not read seat B's findings during this phase.

Seat B: write a self-contained brief under `<run-dir>/phase1/brief.txt`.
Its claims use `B1, B2, ...`. It must not read seat A's findings during this
phase. Dispatch through whichever runtime was resolved for seat B — Codex or
OpenCode — never both, and never guess which one based on the provider name
alone; use the saved/resolved `runtime` field.

For a Codex seat B (quote substituted paths in shell):

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --brief "<run-dir>/phase1/brief.txt" --cd "<target-dir>" --sandbox read-only --model SELECTED_MODEL
```

Append `--effort SELECTED_LEVEL` only for a non-default effort. Append
`--timeout SELECTED_TIMEOUT_SECONDS` only when the user opted into a bound for
this run; the orchestrator's default is no limit, so omit the flag entirely
otherwise.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --brief "<run-dir>/phase1/brief.txt" --cd "<target-dir>" --model SELECTED_MODEL --isolate
```

(the saved `model` value already includes the `provider/` prefix, e.g. `google/gemini-x` — do not prepend the provider again.)

Append `--effort SELECTED_LEVEL` (accepted as an alias for OpenCode's own
`--variant` flag) only for a non-default effort. Append `--timeout`, same
condition as the Codex template. Always pass `--isolate` for a seat-B OpenCode
dispatch — it is what makes the read-only guarantee below real instead of
detection-only; see the read-only caveat for what happens when it fails.

Start the dispatcher as a background process while the Claude seat runs.

Both reviewers return their complete structured findings in the final response.
The orchestrator persists these verbatim to `A-findings.md` and `B-findings.md`
in the run directory. Returning text avoids requiring seat B's sandbox to write
artifacts outside the target. If a runtime does allow findings-file writes,
accept that file only after validating it; otherwise use the captured final
response. Never replace evidence with a summary.

**Read-only is enforced two different ways.** `codex-dispatch.mjs`'s `--sandbox
read-only` is enforced by the Codex CLI itself. `opencode-dispatch.mjs` has no
equivalent CLI flag, so `--isolate` instead redirects seat B into a disposable
`git worktree` copy of the target: edits land there, never in `<target-dir>`.
When `--isolate` was passed, the dispatcher itself refuses to run OpenCode at
all if isolation cannot be set up (target is not a git repo, or worktree setup
fails) — it exits non-zero with `status: "error"` rather than falling back to
running against the real target. Seat B's result.json therefore always shows
`isolated: true` on a completed run; a nonzero exit here is a failed pass like
any other, not a warning to note and continue past. `touchedFiles` remains a
secondary detection check, not the primary guarantee for OpenCode anymore.

## Completion gate

Wait for both processes/agents to finish. Require a zero dispatcher exit and
`status: completed` (a `timed-out` status, when `--timeout` was passed, ends
this attempt the same as any other failed pass — diagnose before retrying, do
not silently drop the timeout on retry). Validate seat B's `finalMessage`,
including an explicit no-findings statement if applicable. Preserve the
resumable session ID from Phase 1's result (`threadId` for Codex, `sessionId`
for OpenCode) in the run manifest; later dispatches must use this exact ID.
When `--isolate` was used, also preserve `worktreePath` from seat B's
result.json — Phase 2's resume dispatch reuses it, and Phase 3 removes it.

Both dispatchers write the same result.json schema (`codex-dispatch.mjs` and
`opencode-dispatch.mjs`'s own USAGE blocks list every field). Copy
`modelRequested`/`effortRequested`/`modelResolved`/`effortResolved`/`isolated`/
`worktreePath`/`isolationNote` from each seat's result.json into that seat's
manifest entry verbatim; `selectionNote` becomes the manifest's
`verification_note`. Codex seats always show `isolated: false,
worktreePath: null, isolationNote: null` (its read-only guarantee is a native
CLI flag, not a worktree). For an isolated OpenCode seat, `isolationNote`
records whether the worktree was reused or rebuilt and names any untracked
nested-git-repo directories that were skipped rather than copied in.

Inspect source-change evidence for both seats. `touchedFiles` (from either
dispatcher) is a best-effort git status difference, not a sandbox guarantee —
for a Codex seat B or an isolated OpenCode seat B this is a secondary check;
for an OpenCode seat B that fell back to non-isolated (should not happen given
the hard stop above, but if it somehow did) this would be the only protection.
Empty does not prove already-dirty files were untouched; null means unknown
(not a git repo, or the git probe failed). Unexpected edits require inspection
before trusting the pass. Never reset user changes automatically.

Do not enter Phase 2 until both complete independent findings are persisted.
A failed pass ends this attempt as incomplete. Diagnose before any retry;
do not automatically retry indefinitely or discard a requested model option.
