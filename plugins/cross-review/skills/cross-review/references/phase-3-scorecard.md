# Phase 3 — Scorecard

> **With `review-run` you do not need this file for the normal path.** SKILL.md's Quickstart lists the commands in order. Read it when a
> step fails, a seat must be replaced or resumed, a scan or validation stops the run, or you run the falsification
> pass or a re-review.

## Contents

- Audit steps
- Auditor and verifier snapshot
- Isolation cleanup
- Manifest
- Report
- Re-review

## Audit steps

Do not synthesize in this conversation. `review-run audit --prepare` and `audit --finish` run the
steps below in this order and stop at the first refusal; the text says what each step checks.

a. **Coin flip.** `audit --prepare` first decides `seat_to_audit_label` with a coin flip and keeps
   the mapping and every relabel temp file in `<run-dir>/phase3-private/`, never where the auditor
   can read. This order is required: an `X`/`Y`-labeled claim cannot exist before the coin flip has
   decided which real letter maps to which anonymous one, so falsification (which operates on
   `X`/`Y`-labeled claims) can only run after this relabel, never before it.
b. **Staged auditor folder.** `audit --prepare` then builds a new, empty folder OUTSIDE the run
   directory (`<run-dir>-audit-input`, or `auditor.outputDir` in `run.json`). It relabels both
   seats' complete findings-plus-rebuttals to `X`/`Y` (two passes per file, one per letter, since
   each file carries both real letters), scans each result for vendor/model tokens, both real seat
   letters (`--forbid-seats A,B`, fenced Evidence included) and leftover peer `P` labels, and only
   if everything is clean writes `X-findings.md`, `Y-findings.md`, a byte-exact `task-packet.md`
   and review-protocol.md into the folder. A hit is a hard stop, one redaction round, then stop and
   report — same as Phase 2's scan. It refuses, writing nothing, when a seat had peer claims but its
   rebuttal section is missing from the peer's findings file (for example after the Phase 2 append
   step refused and restored both files), unless that step recorded the seat as incomplete in
   `phase2/exchange-result.json`. It refuses a folder that is not empty: never copy files into it by
   hand; after a redaction, set `auditor.outputDir` in `run.json` to a new empty folder and rerun
   `audit --prepare`. It prints the number of falsification-qualified claims and writes
   `phase3/falsification-breakdown.json` for the manifest, then stops so the verifiers can run. In
   mode `none` it gets no Phase 2 folder.
c. **Falsification (only when explicitly requested).** Apply the protocol's Falsification pass
   now, on the just-relabeled `X`/`Y` files:
   - The qualifying claims are every claim with `Severity` HIGH or CRITICAL AND a rebuttal `Action`
     of `DISPUTE`, taken from the real (pre-relabel) rebuttals. `audit --prepare` counts them and
     lists their `X`/`Y` IDs (`disputed_ids`). Never use the auditor's `Peer response` field for
     selection; it does not exist yet at this point.
   - Extract each qualifying claim's block and its rebuttal from the staged `X`/`Y` files into
     files of their own, and build that verifier's brief with
     `node "<skill-dir>/scripts/review-run.mjs" verifier-brief --claim <claim block file> --rebuttal <rebuttal file> --target-dir <target-dir> --out <run-dir>/phase3/verifier-<n>/brief.txt`
     (add `--source-dir <repo>` for each other repository the packet reviews).
   - Start one fresh verifier per qualifying claim with only that brief, read-only target access,
     and review-protocol.md (Auditor and verifier snapshot, below, says how). It returns a
     fixed-schema block: `Claim: <its own X|Y id>`,
     `Verdict: CONFIRMED | REFUTED | INCONCLUSIVE`, `Basis:`, `Evidence:`.
   - Run `review-run scan` on each returned verdict before saving it, same as any other X/Y-labeled
     content. A self-identification or identity hit is a hard stop.
   - Save each verdict as `<run-dir>/phase3/verification-<X|Y-id>.md`, named by the anonymous ID.
     Never save it under the real ID. `audit --finish` scans each file again (with
     `--forbid-seats A,B`), refuses a file not named for a staged `X`/`Y` claim or one that says
     `Verdict: REFUTED` with `Basis: INFERENCE` (have the verifier rerun its check or write
     INCONCLUSIVE), copies the files
     into the staged folder for the auditor and passes `--verification-dir` to translate. It stops
     when a qualifying claim has no verification file, unless you rerun it with
     `--accept-missing-verifiers` (the report then says the pass is incomplete).
   - Translate parses each file's own `Claim:`/`Verdict:` lines and refuses if either
     disagrees with the filename or with the auditor's asserted verdict.
     The verifier's file is authoritative for its ENTIRE record (claim,
     verdict, basis, evidence); the auditor's own transcription of it is
     never trusted. The auditor's `verifications` entries must carry only
     `{claim, verdict}` — translate populates `basis`/`evidence`
     directly from each file's own `Basis:`/`Evidence:` lines.
   - When falsification was not requested, skip this entire step, but
     still report how many claims would have qualified.
d. **Fresh auditor.** `audit --finish` builds the auditor's brief in the staged folder (the audit
   depth from `run.json`, the repository's REVIEW.md rules when preflight wrote
   `<run-dir>/review-rules.md`, and the run's `sourceDirs`). The brief copies review-protocol.md's
   Auditor instructions; the brief step refuses a staged folder, brief or output path inside the run
   directory, or a task packet that names it (a sibling such as `<run-dir>-evidence` is fine). A CLI
   auditor is dispatched and waited on by `audit --finish`. For a native auditor it prints the brief
   path: spawn a genuinely new subagent — **never** a fork of this conversation (e.g. an `Agent`
   tool call with `subagent_type: "fork"`, or any equivalent that inherits context): this
   conversation already contains both un-relabeled findings files, the coin-flip mapping, and seat
   identity, so a fork would hand the auditor exactly the leak the fresh-context auditor exists to
   prevent. Give it only the staged folder (the task packet, the relabeled findings, any
   verification files from step c, review-protocol.md), read-only access to the exact Phase 1
   target snapshot, and its one output path inside the staged folder for its JSON; never point it
   at the run directory. The auditor reads the brief from the staged folder, never from the run
   directory. No seat identity or model names. The target snapshot is the isolated worktree path if
   `--isolate` was used, the target directory otherwise; the auditor must never modify it. Run the
   auditor as a general-purpose agent (it writes its own output file) on seat A's model, unless the
   user names another, and record that family in the manifest's `auditor_model_family`. The
   auditor re-checks every claim, also the conceded ones and the ones both seats raised.
e. The auditor applies the protocol's evidence and evidence-strength
   rules and returns adjudication-added fields (Peer response,
   Verification, Final state) per claim. `Verification` is a REQUIRED
   structured `auditor_check: {result, basis, evidence}` object per
   finding in the JSON output:
   - `result` MUST be one of `CONFIRMED`/`REFUTED`/`INCONCLUSIVE`/`NOT_CHECKED`.
   - `evidence` MUST be a non-empty string, and `basis` MUST be one of
     `EXECUTED`/`STATIC_TRACE`/`SOURCE_CITATION`/`INFERENCE` (the same
     enum a verifier's own `Basis:` line uses) — UNLESS `result` is
     `NOT_CHECKED`, in which case both MUST be `null`. `REFUTED` MUST NOT
     have basis `INFERENCE` (absence of proof is `INCONCLUSIVE`).
   - A HIGH or CRITICAL finding left `NOT_CHECKED` (other than
     `dropped-speculative`) MUST carry `reason`, one sentence on why.
   - Translate refuses any finding missing `auditor_check`, and a top-level
     `severity_audited` (translate sets it from `auditor_check.severity`).
   - Translate refuses `settled-refuted` when `result` is `CONFIRMED`,
     and refuses `settled-agree` when `result` is `REFUTED`.
   - Translate refuses `settled-agree` UNLESS at least one of
     `independently_discovered`, a `conceded` peer response, or a
     `CONFIRMED` verification exists. `result: CONFIRMED` alone is NOT
     sufficient provenance here — unlike `settled-refuted`'s `REFUTED`
     route.
   - Translate also refuses `settled-agree` when any peer response is
     `disputed-with-counter-fact`, UNLESS a `verifications[]` entry for
     that finding is `CONFIRMED`.
   - Translate refuses `dropped-speculative` UNLESS the finding is
     genuinely SPECULATIVE, not CRITICAL, not independently discovered by both seats,
     unattacked by any peer response, `result` is not `CONFIRMED` or
     `REFUTED`, and it has no `verifications` entry.
   - Translate refuses any finding whose `verifications[]` has a
     `CONFIRMED` verdict alongside `settled-refuted`, or a `REFUTED`
     verdict alongside `settled-agree`, for any origin.
f. The auditor groups surviving claims into canonical findings per the
   protocol's Canonical findings section — only merging claims describing
   the SAME underlying defect; when in doubt, keep them separate. IDs are
   sequential integers only (`F1`, `F2`, `F3`, ...), never sub-lettered
   (`F8a`/`F8b`) — an origin claim describing two independent sub-defects
   is one over-broad claim, not two findings; put both under the one `F`
   instead. The auditor
   writes these as JSON per the `findings.json` schema, still under `X`/`Y`
   IDs. The returned JSON MUST be a top-level object with a `findings` array, e.g.
   `{"findings": [...]}`, never a bare array of finding objects —
   translate refuses a bare array outright (any other top-level keys,
   including `protocol`, are ignored on input and overwritten on output,
   so the auditor does not need to supply one). The auditor writes it to
   its output path; `audit --finish` copies that file to `<run-dir>/phase3/findings.audit.json`.
   In `summary`/`recommended_fix`/`title` it never writes a claim ID
   (translate refuses one).
   Never record `settled-agree` on a finding with a
   `disputed-with-counter-fact` peer response unless a `CONFIRMED`
   `verifications[]` entry exists for it — its own `auditor_check.result:
   CONFIRMED` alone does not qualify.
g. **Translate.** `audit --finish` translates the auditor's `X`/`Y` file back to real IDs into
   `<run-dir>/phase3/findings.json`, with the coin-flip mapping, the Phase 1 headings, the audit
   depth and (when the Falsification pass ran) the verification files. This is the only supported
   way to produce it. Never hand-transcribe the auditor's `X`/`Y` output into real IDs. When
   translate refuses the auditor's file, `findings.json` was not written: the refused file is kept
   as `phase3/findings.audit.attempt-<n>.json`, and the step writes `phase3/prompt-auditor-fix.txt`
   for a native auditor (send it that message; never edit its file yourself); for a CLI auditor it
   moves the attempt aside, so rerunning `audit --finish` dispatches it again (a new paid run). Do not report synthesis complete until
   `audit --finish` passes this step.
h. **Scorecard.** `audit --finish` writes `<run-dir>/phase3/scorecard.md` from the translated
   `findings.json`, one row per finding, with a Hypotheses column when the packet tags claims
   `[H1]`... Read its `independently_discovered` field; never re-derive it. In collaborate mode
   write `joint-findings.md` from `findings.json` yourself (the settled findings with their
   evidence, then the unresolved ones with both positions); there is no joint-findings script.
i. **Cleanup.** `audit --finish` then deletes the cached plain-text copy of the target kept in the
   OS temp folder (Phase 2, Blind exchange rules) and removes every actor's worktree (Isolation
   cleanup, below). Then build the manifest (Manifest, below): its body holds honest
   requested-versus-observed model and effort information, the `seat_to_audit_label` mapping, and
   the auditor model-family limitation (both seats and the auditor are Claude; this bounds but does
   not eliminate self-preference risk).

When neither seat raised a claim, `audit --prepare` writes an empty `phase3/findings.json` and
skips the auditor; go straight to `review-run manifest` and `review-run report`.

## Auditor and verifier snapshot

The auditor and every verifier read the exact Phase 1 snapshot, never a later working-tree state.
A CLI auditor or verifier gets a fresh worktree rebuilt from the Phase 1 fingerprint recorded in
`run.json` (HEAD, the dirty diff, the untracked files). If the target no longer matches that
fingerprint, the dispatch is refused (the drift rule): stop and report, never audit a changed
target. The auditor never reads a seat's worktree, and no actor reads another actor's.
`review-run.mjs audit --finish` checks the fingerprint before every auditor dispatch. A verifier
is the one actor `review-run` does not start: a native verifier is a fresh agent you spawn with its
brief; dispatch each CLI Claude verifier with
`node "<skill-dir>/scripts/claude-dispatch.mjs" --run-dir "<run-dir>" --brief "<run-dir>/phase3/verifier-<n>/brief.txt" --cd "<target-dir>" --model <model>`,
which refuses a changed target before it builds the worktree and, with no environment option of its own, takes
the auditor's environment settings from `run.json` (the host file names the verifier's model and transport). Give each CLI verifier its own dispatch folder, `<run-dir>/phase3/verifier-<n>/`
(its brief goes there as `brief.txt` and its `result.json` is written beside the brief), so that
`audit --finish` finds the `result.json` and removes the verifier's worktree whether or not the
verifier is listed in `run.json`.

The auditor's staged folder (`<run-dir>-audit-input`) is kept: it is the auditor's input record,
and a rerun of `audit --finish` reads it again. Delete it with the run folder. For a native auditor
`audit --finish` prints the brief path; rerun it with `--native-agent auditor=<agent id>` (or
`--native-done auditor` once its agent replied "written").

## Isolation cleanup

Every actor that ran in a worktree is cleaned up: each seat, the auditor and each verifier. Read
`worktreePath` from every `result.json` and `result.attempt-<n>.json` of the run (`phase1/<role>/`, `phase2/<role>/`, the
auditor's and each verifier's dispatch folder) and from `run.json`. Remove each one from the target
repository, not from the worktree: `git -C "<target-dir>" worktree remove --force "<worktreePath>"`,
and delete the sibling marker file `<worktreePath>.snapshot-complete`. Do this after the report is
written. Then run `git -C "<target-dir>" worktree prune` once; it also clears the stale entry left
in `.git/worktrees/` when a run directory holding a worktree was deleted before the cleanup ran.
`review-run.mjs audit --finish` does this as its last step and prints how many it removed.

## Manifest

Lead the report with pairing, mode, and completion status. Record the actual run, not intended
success. Build the manifest with two calls:

```text
node "<skill-dir>/scripts/review-run.mjs" manifest --run-dir "<run-dir>" --init --seat-transcript orchestrator=auto@<review start>/<review end>
node "<skill-dir>/scripts/review-run.mjs" manifest --run-dir "<run-dir>"
```

The `--init` call is optional: without it the second call builds the same minimal body itself, so one call is
enough when you have nothing to add (give it `--seat-transcript orchestrator=...` then). `--init` writes only the minimal body (topology, mode, status, reviewers, exchange from `run.json`)
to `phase3/manifest-body.json`, so you can add what only you know (the fields in review-protocol.md's
Manifest and final output, except `run_id` and `hashes`). The second call reads that body and
collects every input itself: the packet, the untouched Phase 1 copies, the peer views,
`findings.json`, the verification files, `phase3/falsification-breakdown.json` (when `run.json`
`flags.falsification` is true) and every completed
`result.json` and archived `result.attempt-<n>.json` of a retried call (also the auditor's,
the verifiers' and the redaction rounds'); an attempt that ended without completing (error,
timed out, rate-limited) is not counted. It writes `<run-dir>/manifest.json` and
takes the remembered `--native-agent` ids as seat transcripts. It stamps a fresh `run_id` and
content hashes deterministically; never author `run_id` or `hashes` by hand, and it refuses a body
that already declares either key. The options below add what the run folder does not hold; each
takes ONE value and repeats per value, never a single comma-joined value.

Hash the untouched Phase 1 copies in `phase1/original/` (see the Phase 1
completion gate), not the working files that Phase 2 appended rebuttals to:
the manifest must prove what each seat wrote before it saw its peer.
`review-run manifest` refuses two files with the same name under one flag, and warns
about any completed `result.json` or `result.attempt-<n>.json` under the run directory (or in the auditor's `<run-dir>-audit-dispatch`) that no
`--reviewer-result` names. Without the flag it collects every result.json itself; once you pass one
`--reviewer-result` (a redaction call, say), pass every call you want counted.

For a Codex seat, `--reviewer-result B=<result.json>` fills that
seat's `reviewers[]` entry (requested/resolved model and effort, verification
note, isolation, web access, usage, duration) without touching fields the body
already sets; `null` and the example's placeholders count as not set, and a
written value that differs from result.json is kept but printed as a WARNING.
Repeat it once per call of that seat (Phase 1, exchange, redaction): the files
must agree on model, effort and isolation (the manifest step refuses otherwise),
`duration_ms` is the sum, `usage_per_call` lists each call (a resumed call's own
tokens, result.json's `usage_delta`, are there; the entry has no `usage_delta`
key), and `usage` is the
last call's for one Codex thread (its totals are cumulative) or the per-call
sum otherwise. `provider` and `selection_source` are still written by hand, so
the smallest body entry for a Codex seat is
`{"role": "B", "provider": "openai", "selection_source": "saved"}`
plus `--reviewer-result B=<run-dir>/phase1/B/result.json --reviewer-result
B=<run-dir>/phase2/B/result.json`. `--falsification <run-dir>/phase3/falsification-breakdown.json`
(the file `audit --prepare` wrote) fills `falsification.breakdown`
and `qualified_claims`; write only `requested` and `verifiers_run` yourself. A harness seat and the auditor have no `result.json`, so their cost is lost
unless recorded: add `--seat-transcript A=<agentId>` (and
`--seat-transcript auditor=<agentId>`; `B=` too when seat B is a harness seat),
with the agentId the Agent tool returned when it started that subagent (or the
path of its `agent-<id>.jsonl`). The manifest step sums every API call in that
transcript, which is the same quantity a Codex `result.json` reports, on the
input side (`output_tokens` is null: the transcript logs it before each reply
is written). Do NOT
use the `totalTokens` in the harness's completion notice as the seat's cost:
it is the size of the seat's last call only (a seat that read 9.3M input tokens
over 51 calls showed 261k), so comparing it with a Codex seat's usage makes the
Claude seat look 20-35 times cheaper than it was. Add `--seat-usage
A=<final context tokens>,<duration ms>` for the same seat to record the
duration; it lands in `seat_usage` as `duration_ms` next to the transcript
figures. Never type a guess as a plain number: write `unknown` for a figure
you do not have (`A=261000,unknown`, stored as null; both unknown gives
`source: "unknown"`), and append `,estimated` to a number you worked out
yourself (`auditor=150000,480000,estimated`). The harness's reported duration
is sometimes per turn and sometimes a running total, so do not use it.
`--seat-transcript` measures a Claude seat's time itself: the sum of the gaps
between its transcript entries, leaving out each wait after a final reply until
the next brief (`active_ms`, recorded as `duration_ms` with `duration_source:
"transcript"`). A hand figure marked `estimated` or `harness` is kept beside it as
`duration_hand_ms`. Only a span you timed yourself, from the clock time
(`Get-Date -Format o`, or `date -u +%FT%TZ`) at each start or resume and at
each completion notice, overrides it: pass it as
`--seat-usage <seat>=unknown,<ms>,clock`.
A transcript given with `@<start>[/<end>]` counts only its entries in that window. A file is counted once
per window given, so never give one file overlapping windows; of the copies of one session (the same file
name in several project folders) given with the same window, only the copy with the latest entry is counted;
copies given with different windows are each counted. With several windows, `counted_from` and
`counted_until` are the earliest start and the latest end (the gaps between windows are not counted);
either is left out when a transcript was given without that bound.
The scripts store every time in UTC (`startedAt`, `finishedAt`, pre-flight
times), except Codex's `retryAfter`, which is this machine's local time. When
you tell the user a time, in a progress note or the report, give this machine's
local time first, for example "started 8:14 AM (13:14 UTC)"; plain `Get-Date` or
`date` prints the local time and offset. A file the protocol does not name
(an auditor's prose synthesis, for example) is hashed with
`--extra-artifact <name>=<path>`; say in the body why it exists. The manifest also gets `skill_version`,
stamped from the SKILL.md of the skill that ran `review-run manifest`, and
`skill_versions` (for example `{"phase1": "1.6.4", "phase3": "1.6.6"}`), which
it fills from `<run-dir>/skill-versions.jsonl`: every brief `review-run` builds
appends the version to it, so keep the manifest at its default path,
`<run-dir>/manifest.json`. It warns when the version changed during the run.
Write `skill_versions` in the body only for a run whose briefs left no such file.

Hash only the bytes the scripts wrote. In Windows PowerShell, `git diff >
file` and `Set-Content` re-encode text (UTF-16 or a BOM, CRLF endings), so the
hash no longer matches the raw git output another session computes. Write
evidence files with Git Bash, `git diff --output=<file>`, or
`[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`.

## Report

**Which findings need a human.** The report has no separate confidence field: the Decide group is the list a person
must settle. It holds the `unresolved-high-stakes` findings, the unresolved blockers, and a finding whose `## Finding status`
line in report-notes.md says a decision is needed, unless the review withdrew it or that line marks it fixed, wrong (a blocker only with a reason
after the colon), intentional, not-worth-it or decided; an unresolved low-stakes finding that is not a blocker is listed by severity (Fix next, or Can wait when LOW)
with both positions.

**Build the report with the script.** Write `<run-dir>/phase3/report-notes.md` with `## Why` (one sentence) and
`## Decisions needed` (a table: decision, options, recommended, what changes), and when they apply `## Finding status`
(`- F4: fixed after the snapshot, not re-reviewed`; a first word of fixed, wrong, intentional, not-worth-it, pre-existing or
decided, followed by ":" and the reason, is the author's outcome: the report moves a finding marked wrong to Withdrawn and
intentional, not-worth-it or decided to Can wait, and the next `review-run recheck` reads it; with no note, a non-blocker a seat
marked `Pre-existing: yes` (and none marked `no`) is listed as pre-existing too, under the same added-lines rule), `## Open items` (gaps that are not findings) and `## Criteria source`
(where and when the criteria text came from), then run
`node "<skill-dir>/scripts/review-run.mjs" report --run-dir <run-dir>`. It prints the terminal report (colour only on a terminal, or with
`FORCE_COLOR` or `--color always`; never with `NO_COLOR` or `--color never`) from `findings.json`, `manifest.json`, the task packet and
the Phase 1 files: status, blockers, findings by severity,
every packet criterion as issue found, not met or partial (no finding), no issue found or NOT VERIFIED, coverage, caveats and cost. IDs, counts and
states are never retyped. Status is COMPLETE only when the manifest's status is `completed`; no merge or ship verdict is printed.
A missing cost figure prints as unknown, never an estimate. `--format chat` prints plain markdown for a chat window (paste it
verbatim as your reply); `--all` adds every finding, criterion and the cost to it. `--notes <file>` names the notes file when it
is not `<run-dir>/phase3/report-notes.md`. `--change-diff <diff>` (repeat it for a second repository; default `<run-dir>/since.diff`,
which `review-run recheck` writes; for a first round the preflight's `tier1.diff` log) adds a Where hint per finding (added lines, near the
change (within 20 lines of a hunk), changed file, outside the change, unknown); it never moves a finding. `--out report.md` adds a plain
copy for a ticket; `--json report.json` writes the facts the report is built from; `--html page.html` adds a standalone page (no scripts,
light and dark theme), only when the user asks for it. The checklist below is what the report must cover; it says nothing the script already prints.

**An unresolved-high-stakes finding needs a next step.** When a finding ends
`unresolved-high-stakes` and falsification was not requested, list it at the top
of the report with both sides' evidence and the auditor's own check, and offer
the user one falsification verifier for exactly that claim ("deep verify
disputed high-severity findings"). A verifier after the audit needs a native auditor, which can be resumed; with a CLI auditor, offer a new run with `--falsification` instead. Never run it without that request: the
Falsification pass is opt-in. Record the offer, and the user's answer if one
came, in the report.

**Fixes made after the review are not reviewed.** The findings cover the
snapshot the seats read. When the target changes after it (a fix for a finding,
typically), `preflight --check-stale` reports `stale: true`; say in the report
which findings were fixed after the reviewed snapshot and that those fixes were
not re-reviewed, so nobody reads the final diff as the reviewed one.
Final output: pairing/manifest, key findings, unresolved disagreements, evidence
basis, checks run or blocked, and pass counts — reviewer passes, blind rebuttal
exchanges, whether a fresh auditor ran, and falsification verifiers run. Avoid
"rounds" as a catch-all term: a falsification verifier is not a debate round
with the original seats, and counting it as one obscures what actually ran.
Do not include setup details in every report unless settings changed or could
not be verified.

When the review leaves questions only the user can answer (a ticket's wording, a
product choice), end the report with a "Decisions needed" table: one row per
decision, with the options, a recommended default, and what each answer
changes.

**Checking fixes after the review.** A completed review stays as it is; its
manifest covers the snapshot the seats read. To confirm fixes, run a new review
on the fixed snapshot (new run directory and manifest) with the original
findings listed in the task packet as hypotheses `H1, H2, ...` for the seats to
confirm or refute. `review-run recheck` drafts that packet (Re-review, below). Resuming the original seats on the fixed code is a quicker
check but not a review: they have seen each other's findings, so it is not
independent. Keep its files and costs out of the original manifest, and say in
the report who checked the fixes and how.

**What a fix round does not show.** Confirming fixes shows that each fix closes
its finding, not what the fix broke. Before release, the last round of fixes
needs one release-versus-changed comparison (review-profiles.md, Code,
Differential) by a reviewer that took no part in the earlier rounds; say in the
report whether it ran. When the report quotes the implementers' mutation
checks, say what they prove: that the tests notice a change in the code, not
that the behavior is right.

**Read-only statement for CLI Claude seats.** For every CLI Claude seat, the auditor and each
verifier, the report says: file tools are enforced (`fileTools: enforced`) and the shell is
prompt-only (`shell: prompt-only`), so a shell can still read peer files and write by absolute
path. `touchedFiles` in each `result.json`, checked against the real target after every actor,
is the check. `review-run audit --finish` reads every verifier's `result.json` and attempt files and stops on a recorded write; a result that says `node_modules` was not inventoried (`touchedFilesNote`) is reported in the run line. The manifest records `readOnly` per actor, with `cwd` as `worktree` or `target`.

## Re-review

`review-run recheck` writes a draft task packet for a new review of an earlier run's target after
fixes. Write it into the new run folder:

```text
node "<skill-dir>/scripts/review-run.mjs" recheck --from-run "<old-run-dir>" --out "<new-run-dir>/task-packet.md" --since-diff "<diff file>"
```

It reads `<old-run-dir>/task-packet.md` and `<old-run-dir>/phase3/findings.json` and writes a new packet:

- the old packet's sections, kept as they were, except the ones below;
- "What changed since the previous review": the files and +/- line counts of the diff, with a FILL
  line for why each change was made. An older "What changed since ..." section is replaced by the
  new one;
- "Hypotheses to test": every previous finding as `[H1]`, `[H2]`, ..., worded as a suspected defect,
  CONFIRMED if it is still present, REFUTED if the change removed it. Hypotheses of the old packet are
  dropped, because their numbers would clash. After them one more hypothesis, not a previous finding: a
  field the changed code reads is handled wrongly when null, missing, empty, zero or negative;
- "Known deviations" gets a FILL line;
- "Evidence both seats may cite" is reset to FILL, because the old snapshot hash and test counts
  are stale;
- "Author-reported evidence (not reproducible; do not cite as EXECUTED)": a FILL slot after the
  evidence section.

Options:

- `--since-diff <diff file>`: a unified diff of the change, for example `git diff --no-index`
  between the two snapshots.
- `--since-dirs <old> <new>`: instead of `--since-diff`, the diff between two snapshot folders of the
  target (`git diff --no-index`, line-ending-only changes ignored), with paths relative to them.
  Repeat it for each second repository: its paths get its new folder's name in front.
- `--since-commit <commit>`: instead of the two above, the target's diff from that commit to its
  working tree (`git diff <commit>`), for work already committed; untracked files are not in it.
  The target is `--target`, else the old run's.
  With none of the three, the changed files are listed by name (no line counts) from the previous run's
  `fingerprint-files.json`, for example for an uncommitted worktree with no commit to diff against.
- `--since-only <path>`: keep only these files or folders (relative to the snapshot; repeat it or
  separate them with commas) from the diff, for example when another ticket changed other files. A
  later `--since-dirs` pair's files are named `<new-folder-name>/<path>`.
- `--target <dir>`: the new target folder. The old target path in the packet is rewritten (the old
  target comes from the old run's `run.json`). The old run folder path is always rewritten to the
  folder of `--out`.
- `--repo-target <old>=<new>`: the same for each second repository the old run reviewed (its
  `run.json` `extraRepos`). One is required for each; `<old>=<old>` keeps a path.
- `--title "<text>"`: the packet's title line, instead of "Task packet: re-review after fixes
  (previous: <old title>)".
- `--skip F7,F8`: leave these previous findings out of the hypotheses (settled, nothing left to
  re-check).
- `--drop-tag <tag>`: remove a criterion tag, its `- [tag]` bullet and its entry in the Tickets line (a hypothesis tag is refused: in the new packet H1..Hn are the previous findings; leave one out with `--skip F<n>`)
  (repeat it or separate tags with commas).
- `--notes <file>`: the previous run's report notes (default `<old-run-dir>/phase3/report-notes.md`,
  when it exists). A `## Finding status` line `- F2: wrong: <reason>` whose first word is wrong,
  intentional, not-worth-it or decided puts the finding under Known deviations instead of the
  hypotheses; pre-existing marks its hypothesis; fixed, or no outcome word, keeps it a hypothesis.
  `--skip` wins over the notes.
- `--preflight <file>`: this run's evidence preflight (`preflight.mjs --compact --out <file>`, run
  before the packet): the evidence section is written from it (snapshotHash, each repository's
  HEAD, each command's exit, summary line and log) instead of a FILL line.
- `--round N`: the review round written under the title (default: the old packet's "Review round:"
  plus 1, or 2). From round 3 the report asks you to step back (SKILL.md, Reviewing the same code
  again).

With `--since-diff`, `--since-dirs` or `--since-commit` the diff is also written to `since.diff` next to `--out`, so
in the new run folder; `review-run report` reads it from there to tag where each finding sits in the
change. The packet never names the old run folder (its manifest names the seats' models):
`previous-run.json` next to `--out` records it for you; give the seats no path to it. When either
file already exists with other contents (another attempt), the command refuses and writes nothing;
the two are written before the packet. `--out` is never overwritten. Every "FILL" marker must be
replaced before the seats start; the command lists them.
