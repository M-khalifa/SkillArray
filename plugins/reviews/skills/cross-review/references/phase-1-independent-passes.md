# Phase 1 — Independent passes

Resolve configuration and complete SKILL.md preflight before this phase.

## Run directory and source snapshot

Create a unique directory under the harness scratchpad or OS temporary directory.
Use an OS temporary-directory helper or a random run ID, not just the task slug.
Record its absolute path as `<run-dir>`; all later phases reuse it. Keep
`phase1/`, `phase2/`, and optional `phase4/` results separate so no
`result.json` overwrites an earlier phase's audit.

Use the same source snapshot, including relevant dirty files, for both seats.
The default review must not edit the target. Give both seats the actual scope,
test commands, execution permissions, findings schema from
[review-protocol.md](review-protocol.md), and the no-source-edit/no-commit rule.
Tests requiring writes must use approved disposable locations; if that is not
possible, mark those checks blocked and report READING-ONLY evidence.

## Start both seats concurrently

Claude: use the selected seat-A model and supported effort mechanism. Give the
agent a unique name and keep its agent ID for the next phase. Its claims use
`CL1, CL2, ...`. It must not read seat B's findings during this phase.

Seat B: write a self-contained brief under `<run-dir>/phase1/brief.txt`.
Its claims use `CX1, CX2, ...`. It must not read Claude's findings during this
phase. Dispatch through whichever runtime was resolved for seat B — Codex or
OpenCode — never both, and never guess which one based on the provider name
alone; use the saved/resolved `runtime` field.

For a Codex seat B (quote substituted paths in shell):

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --brief "<run-dir>/phase1/brief.txt" --cd "<target-dir>" --sandbox read-only --model SELECTED_MODEL
```

Append `--effort SELECTED_LEVEL` only for a non-default effort.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --brief "<run-dir>/phase1/brief.txt" --cd "<target-dir>" --model SELECTED_MODEL
```

(the saved `model` value already includes the `provider/` prefix, e.g. `google/gemini-x` — do not prepend the provider again.)

Append `--effort SELECTED_LEVEL` (accepted as an alias for OpenCode's own
`--variant` flag) only for a non-default effort. Unlike the Codex seat, there
is no `--sandbox` equivalent to pass — see the read-only caveat below.

Start the dispatcher as a background process while the Claude seat runs.

Both reviewers return their complete structured findings in the final response.
The orchestrator persists these verbatim to `claude-findings.md` and
`codex-findings.md` (or `opencode-findings.md` for an OpenCode seat B) in the
run directory. Returning text avoids requiring seat B's sandbox to write
artifacts outside the target. If a runtime does allow findings-file writes,
accept that file only after validating it; otherwise use the captured final
response. Never replace evidence with a summary.

**Read-only is a Codex-only guarantee.** `codex-dispatch.mjs`'s `--sandbox
read-only` is enforced by the Codex CLI itself; `opencode-dispatch.mjs` has no
equivalent flag, because the installed OpenCode CLI has no such CLI-level
option — permissions there are a per-agent/config concern, not something this
dispatcher can force. An OpenCode seat B's `touchedFiles` (below) is therefore
detection, not prevention: treat any non-empty `touchedFiles` from an OpenCode
seat as a real incident to investigate, not a benign log line, and require a
clean git baseline before the run so the diff means something.

## Completion gate

Wait for both processes/agents to finish. Require a zero dispatcher exit and
`status: completed`. Validate seat B's `finalMessage`, including an explicit
no-findings statement if applicable. Preserve the resumable session ID from
Phase 1's result (`threadId` for Codex, `sessionId` for OpenCode) in the run
manifest; later dispatches must use this exact ID.

Inspect source-change evidence for both seats. `touchedFiles` (from either
dispatcher) is a best-effort git status difference, not a sandbox guarantee —
this is the ONLY protection for an OpenCode seat B, and merely a secondary
check for a Codex seat B. Empty does not prove already-dirty files were
untouched; null means unknown (not a git repo, or the git probe failed).
Unexpected edits require inspection before trusting the pass. Never reset user
changes automatically.

Do not enter Phase 2 until both complete independent findings are persisted.
A failed pass ends this attempt as incomplete. Diagnose before any retry;
do not automatically retry indefinitely or discard a requested model option.
