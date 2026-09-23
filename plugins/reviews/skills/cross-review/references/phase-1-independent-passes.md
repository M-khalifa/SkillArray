# Phase 1 — Independent passes

Resolve configuration and complete SKILL.md preflight before this phase.

## Run directory and source snapshot

Create a unique directory under the harness scratchpad or OS temporary directory.
Use an OS temporary-directory helper or a random run ID, not just the task slug.
Record its absolute path as `<run-dir>`; all later phases reuse it. Keep
`phase1/`, `phase2/`, and `phase3/` results separate, and give every CLI-seat
dispatch its own folder (`phase1/B/brief.txt`, `phase2/B/delta-brief.txt`, a
redaction brief in `phase3/redact-B/`): a dispatcher writes `result.json` next
to its brief, so two dispatches sharing a folder overwrite each other's audit.

Use the same source snapshot, including relevant dirty files, for both seats.
The default review must not edit the target. Give both seats the actual scope,
test commands, execution permissions, findings schema from
[review-protocol.md](review-protocol.md), and the no-source-edit/no-commit rule.
Tests requiring writes must use approved disposable locations; if that is not
possible, mark those checks blocked and report a non-EXECUTED basis instead.

Run pre-flight evidence per [review-protocol.md](review-protocol.md)'s
Scope and independence section
([scripts/preflight.mjs](../scripts/preflight.mjs)) before dispatching either
seat, and include its output in the task packet. When Tier 2 runs a test
suite, pass `--compact --out <run-dir>/preflight.json` and inline the compact
JSON; the full logs stay on disk for EXECUTED citations. For a target that is
not a git repository, pre-flight's `snapshotHash` is a content-hash inventory
of every file; record it, and re-run `--check-stale` at the end of the review
to prove the target did not change.

For a binary document target, freeze the extraction first (review-profiles.md,
Document). If the orchestrator has hypotheses of its own about the target, list
them in the packet as `H1, H2, ...` under a heading that says they are
unverified; both seats must confirm or refute each (review-protocol.md,
Standard seat instructions).

Pick a lens from [review-profiles.md](review-profiles.md) (Code, Architecture,
or Document — inferred from the target, not asked of the user unless genuinely
ambiguous) and give both seats the same choice in the task packet.

## Start both seats concurrently

Both seats write findings under their own `A`/`B` claim numbering per
[review-protocol.md](review-protocol.md)'s Three label layers — never `CL`/`CX`,
never a vendor name in the claim ID. Build both briefs with
[scripts/build-brief.mjs](../scripts/build-brief.mjs) so each carries the same
verbatim rule blocks (Standard seat instructions, Model identity, the findings
schema, and Web verification unless the task says "repo-only review"):

```text
node "<skill-dir>/scripts/build-brief.mjs" --mode phase1 --packet "<run-dir>/task-packet.md" --seat A --out "<run-dir>/phase1/brief-A.txt" --output-path "<run-dir>/phase1/A-findings.md"
node "<skill-dir>/scripts/build-brief.mjs" --mode phase1 --packet "<run-dir>/task-packet.md" --seat B --out "<run-dir>/phase1/B/brief.txt"
```

A hand-written brief is allowed only when the script cannot run; it must then
copy those sections verbatim.

Claude (seat A): use the selected seat-A model and supported effort mechanism.
Spawn it as a general-purpose agent (`Tools: *`), not a restricted-toolset
subagent type — this is what gives it WebFetch/WebSearch for the Web
verification rules in [review-protocol.md](review-protocol.md) and the
file-writing tool it needs for `--output-path`; naming a more restricted spawn
type silently loses both without any error to catch it. Tell it to read its
brief from the file and to write its findings to `phase1/A-findings.md`
itself, replying only with counts. The orchestrator then validates that file;
it never re-types a seat's findings from a reply, which doubles the token cost
of every finding and adds transcription risk. If the agent cannot write the
file, capture its reply verbatim instead and say so in the manifest. Give the
agent a unique name and keep its agent ID for the next phase. Its claims use
`A1, A2, ...`. It must not read seat B's findings during this phase.

Seat B: the brief from `build-brief.mjs` above, in its own folder.
Its claims use `B1, B2, ...`. It must not read seat A's findings during this
phase. Dispatch through whichever runtime was resolved for seat B — Codex or
OpenCode — never both, and never guess which one based on the provider name
alone; use the saved/resolved `runtime` field.

For a Codex seat B (quote substituted paths in shell):

```text
node "<skill-dir>/scripts/codex-dispatch.mjs" --brief "<run-dir>/phase1/B/brief.txt" --cd "<target-dir>" --sandbox read-only --model SELECTED_MODEL --web
```

Append `--effort SELECTED_LEVEL` only for a non-default effort. Timeout: when
`--timeout` is omitted, both dispatchers stop the seat after 1800 seconds (30
minutes) and write `status: "timed-out"`. Pass `--timeout SECONDS` for a
different bound the user chose, or `--timeout 0` for no limit (a large target
at high effort can run longer than 30 minutes). Keep the same choice on every
dispatch of the run. `--web` enables Codex's native web search per Web verification in
review-protocol.md — always pass it unless the task text disabled web
verification ("repo-only review"); the brief must still carry the Web
verification rules verbatim regardless of this flag, since the flag alone
does not tell the model when or how to use the capability.

For an OpenCode seat B:

```text
node "<skill-dir>/scripts/opencode-dispatch.mjs" --brief "<run-dir>/phase1/B/brief.txt" --cd "<target-dir>" --model SELECTED_MODEL --isolate --web
```

`--web` is accepted here for call-site parity only — OpenCode has no
web-capable CLI flag, so this seat's `webAccess` is always `false` regardless
(see Web verification in review-protocol.md). Still include the Web
verification rules in its brief so it reports the gap explicitly rather than
silently reasoning without web access when a claim would have needed it.

(the saved `model` value already includes the `provider/` prefix, e.g. `google/gemini-x` — do not prepend the provider again.)

Append `--effort SELECTED_LEVEL` (accepted as an alias for OpenCode's own
`--variant` flag) only for a non-default effort. Append `--timeout`, same
condition as the Codex template. Always pass `--isolate` for a seat-B OpenCode
dispatch — it is what makes the read-only guarantee below real instead of
detection-only; see the read-only caveat for what happens when it fails.

Start the dispatcher as a background process while the Claude seat runs.

Seat A writes `phase1/A-findings.md` itself (above). Seat B, in a read-only
sandbox, returns its complete findings as the final response; the orchestrator
saves `result.json`'s `finalMessage` to `phase1/B-findings.md` with a script,
not by retyping it. Accept any seat-written file only after validating it.
Never replace evidence with a summary.

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
not silently drop the timeout on retry), AND `scripts/blind-relabel.mjs
validate --phase1-dir <run-dir>/phase1` exits zero. A nonzero `validate` exit
means at least one claim block is missing a recognized `Severity:`, `Basis:`,
`Evidence strength:`, or non-empty `Evidence:` — return the affected seat's
file to its OWN context for reformatting (restate the required field lines
verbatim, change nothing else), the same procedure as a `scan` redaction
round, never a hand edit. A reviewer following the brief template loosely
(e.g. dropping the `Evidence:` label and going straight to prose) is common
enough in practice to gate here rather than discover it only when Phase 3's
`translate --phase1-dir` refuses much later. Validate seat B's `finalMessage`,
including an explicit no-findings statement if applicable. Preserve the
resumable session ID from Phase 1's result (`threadId` for Codex, `sessionId`
for OpenCode) in the run manifest; later dispatches must use this exact ID.
When `--isolate` was used, also preserve `worktreePath` from seat B's
result.json — Phase 2's resume dispatch reuses it, and Phase 3 removes it.

After `validate` passes, copy both findings files to `phase1/original/` and
never touch those copies again. Phase 2 appends rebuttals to the working files
in `phase1/`, so only the copies still hold what each seat wrote before it saw
its peer; `build-manifest.mjs --phase1` hashes the copies.

A pass can complete and still be too shallow to exchange (few claims, and its
own `Checks performed` says most checks were not run). Before Phase 2, the
orchestrator may resume the SAME seat once with a coverage brief that names the
unchecked scope; this is still the independent pass (the peer's findings are
not shown), and the manifest records it as `coverage_rounds: 1` for that seat.

Both dispatchers write the same result.json schema (`codex-dispatch.mjs` and
`opencode-dispatch.mjs`'s own USAGE blocks list every field). Copy
`modelRequested`/`effortRequested`/`modelResolved`/`effortResolved`/`isolated`/
`worktreePath`/`isolationNote`/`webAccess` from each seat's result.json into
that seat's manifest entry verbatim; `selectionNote` becomes the manifest's
`verification_note`. Codex seats always show `isolated: false,
worktreePath: null, isolationNote: null` (its read-only guarantee is a native
CLI flag, not a worktree). For an isolated OpenCode seat, `isolationNote`
records whether the worktree was reused or rebuilt and names any untracked
nested-git-repo directories that were skipped rather than copied in.

Inspect source-change evidence for both seats. `touchedFiles` (from either
dispatcher) is a best-effort git status difference, or a content-hash
inventory difference for a non-git `--cd`, not a sandbox guarantee —
for a Codex seat B or an isolated OpenCode seat B this is a secondary check;
for an OpenCode seat B that fell back to non-isolated (should not happen given
the hard stop above, but if it somehow did) this would be the only protection.
Empty does not prove already-dirty files were untouched on the git path; null
means unknown (a git or inventory probe failed). Unexpected edits require inspection
before trusting the pass. Never reset user changes automatically.

Do not enter Phase 2 until both complete independent findings are persisted.
A failed pass ends this attempt as incomplete. Diagnose before any retry;
do not automatically retry indefinitely or discard a requested model option.
