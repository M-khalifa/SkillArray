# Phase 3 — Scorecard

## Contents

- Audit steps
- Manifest
- Report

## Audit steps

Do not synthesize in this conversation. Follow this exact order:

a. Run `scripts/blind-relabel.mjs flip --out
   <run-dir>/phase3-private/seat-to-audit-label.json` for
   `seat_to_audit_label` FIRST, and keep it and every relabel temp file in
   `phase3-private/`, never where the auditor can read.
   This order is required: an `X`/`Y`-labeled claim cannot exist before
   the coin flip has decided which real letter maps to which anonymous
   one, so falsification (which operates on `X`/`Y`-labeled claims) can
   only run after this relabel, never before it.
b. Create a new, empty folder OUTSIDE the run directory for the auditor
   and build it with one command:

   ```text
   node "<skill-dir>/scripts/blind-relabel.mjs" audit-prep --phase1-dir "<run-dir>/phase1" --mapping "<run-dir>/phase3-private/seat-to-audit-label.json" --out-dir "<audit-input-dir>" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase2-dir "<run-dir>/phase2" --packet "<task-packet>" --breakdown-out "<run-dir>/phase3/falsification-breakdown.json"
   ```

   It relabels both seats' complete findings-plus-rebuttals to `X`/`Y`
   (two passes per file, one per letter, since each file carries both
   real letters), scans each result for vendor/model tokens, both real
   seat letters (fenced Evidence included), and leftover peer `P` labels,
   and only if everything is clean writes `X-findings.md`,
   `Y-findings.md`, a byte-exact `task-packet.md` and review-protocol.md
   into `<audit-input-dir>`. A hit is a hard stop, one redaction round,
   then stop and report — same as Phase 2's scan. It refuses, writing nothing, when a seat had peer claims but its rebuttal
   section is missing from the peer's findings file (for example after `exchange.mjs
   finish` refused and restored both files), unless `finish` recorded that seat as
   incomplete in `phase2/exchange-result.json`. Never copy files into the
   folder by hand; after a redaction, re-run into a new empty folder. If the
   command cannot run, the manual equivalent (then copy the task packet and
   review-protocol.md in yourself) is:

   ```text
   node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase3-private/tmp-A.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
   node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-A.md" --out "<audit-input-dir>/<label-A>-findings.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
   node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase3-private/tmp-B.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
   node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-B.md" --out "<audit-input-dir>/<label-B>-findings.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
   ```

   followed by `scan --phase1-dir <run-dir>/phase1 --forbid-seats A,B
   --phase2-dir <run-dir>/phase2` on each result.
c. If falsification was explicitly requested, apply the protocol's
   Falsification pass now, using the just-relabeled `X`/`Y` files:
   - Select every claim with `Severity` HIGH or CRITICAL AND a rebuttal
     `Action` of `DISPUTE`, from the real (pre-relabel) rebuttals. Never
     use the auditor's `Peer response` field for selection; it does not
     exist yet at this point.
   - Map each selected real claim ID to its `X`/`Y` label via
     `seat_to_audit_label`, then extract that claim's block and rebuttal
     from the already-relabeled `X`/`Y` files.
   - Spawn one fresh verifier subagent per qualifying claim with only
     that extracted block, read-only target access, and
     review-protocol.md. It returns a fixed-schema block:
     `Claim: <its own X|Y id>`,
     `Verdict: CONFIRMED | REFUTED | INCONCLUSIVE`, `Basis:`, `Evidence:`.
   - Run `scripts/blind-relabel.mjs scan` on each returned verdict before
     saving it, same as any other X/Y-labeled content. A
     self-identification or identity hit is a hard stop.
   - Save each verdict as `verification-<X|Y-id>.md`, named by the
     anonymous ID. Never save it under the real ID.
   - Supply these files to the auditor (step d) and pass
     `--verification-dir` when translating (step g). `translate` parses
     each file's own `Claim:`/`Verdict:` lines and refuses if either
     disagrees with the filename or with the auditor's asserted verdict.
     The verifier's file is authoritative for its ENTIRE record (claim,
     verdict, basis, evidence); the auditor's own transcription of it is
     never trusted. The auditor's `verifications` entries must carry only
     `{claim, verdict}` — `translate` populates `basis`/`evidence`
     directly from each file's own `Basis:`/`Evidence:` lines.
   - When falsification was not requested, skip this entire step, but
     still report how many claims would have qualified.
d. Spawn a genuinely new subagent — **never** a fork of this
   conversation (e.g. an `Agent` tool call with `subagent_type: "fork"`,
   or any equivalent that inherits context): this conversation already
   contains both un-relabeled findings files, the coin-flip mapping, and
   seat identity, so a fork would hand the auditor exactly the leak the
   fresh-context auditor exists to prevent. Give it only `<audit-input-dir>`
   (the task packet, the relabeled findings, any verification files from
   step c, review-protocol.md), read-only access to the exact Phase 1
   target snapshot, and one output path inside `<audit-input-dir>` for
   its JSON; never point it at the run directory. Build its prompt with
   `build-brief.mjs --mode auditor --packet <audit-input-dir>/task-packet.md
   --audit-dir <audit-input-dir> --target-dir <target-dir> --run-dir
   <run-dir> --out <audit-input-dir>/auditor-brief.txt --output-path
   <audit-input-dir>/findings.audit.json`, plus `--source-dir <repo>` for
   each other repository the packet reviews and `--audit-depth full` when
   the task asks to double check all claims, or when `exchange.mjs finish`
   warned that every rebuttal conceded (a light audit would re-check nothing;
   `audit-prep` has no depth flag); it copies review-protocol.md's
   Auditor instructions and refuses a staged folder, brief or output path
   inside the run directory, or a task packet that names it (a sibling
   such as `<run-dir>-evidence` is fine). The auditor reads the brief
   from the staged folder, never from the run directory.
   No seat identity or model names. The target snapshot is the isolated
   worktree path if `--isolate` was used, the target directory otherwise;
   the auditor must never modify it. Run the auditor as a general-purpose agent (it writes its own output file) on
   seat A's model, unless the user names another, and record that family in the
   manifest's `auditor_model_family`.
e. The auditor applies the protocol's evidence and evidence-strength
   rules and returns adjudication-added fields (Peer response,
   Verification, Final state) per claim. `Verification` is a REQUIRED
   structured `auditor_check: {result, basis, evidence}` object per
   finding in the JSON output:
   - `result` MUST be one of `CONFIRMED`/`REFUTED`/`INCONCLUSIVE`/`NOT_CHECKED`.
   - `evidence` MUST be a non-empty string, and `basis` MUST be one of
     `EXECUTED`/`STATIC_TRACE`/`SOURCE_CITATION`/`INFERENCE` (the same
     enum a verifier's own `Basis:` line uses) — UNLESS `result` is
     `NOT_CHECKED`, in which case both MUST be `null`.
   - A HIGH or CRITICAL finding left `NOT_CHECKED` (other than
     `dropped-speculative`) MUST carry `reason`, one sentence on why.
   - `translate` refuses any finding missing `auditor_check`.
   - `translate` refuses `settled-refuted` when `result` is `CONFIRMED`,
     and refuses `settled-agree` when `result` is `REFUTED`.
   - `translate` refuses `settled-agree` UNLESS at least one of
     `independently_discovered`, a `conceded` peer response, or a
     `CONFIRMED` verification exists. `result: CONFIRMED` alone is NOT
     sufficient provenance here — unlike `settled-refuted`'s `REFUTED`
     route.
   - `translate` also refuses `settled-agree` when any peer response is
     `disputed-with-counter-fact`, UNLESS a `verifications[]` entry for
     that finding is `CONFIRMED`.
   - `translate` refuses `dropped-speculative` UNLESS the finding is
     genuinely SPECULATIVE, not independently discovered by both seats,
     unattacked by any peer response, `result` is not `CONFIRMED` or
     `REFUTED`, and it has no `verifications` entry.
   - `translate` refuses any finding whose `verifications[]` has a
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
   IDs. State this explicitly in the auditor's own task prompt: the
   returned JSON MUST be a top-level object with a `findings` array, e.g.
   `{"findings": [...]}`, never a bare array of finding objects —
   `translate` refuses a bare array outright (any other top-level keys,
   including `protocol`, are ignored on input and overwritten on output,
   so the auditor does not need to supply one). The auditor writes it to
   its output path; copy that file to `<run-dir>/phase3/findings.audit.json`.
   In `summary`/`recommended_fix`/`title` it never writes a claim ID
   (translate refuses one).
   Never record `settled-agree` on a finding with a
   `disputed-with-counter-fact` peer response unless a `CONFIRMED`
   `verifications[]` entry exists for it — its own `auditor_check.result:
   CONFIRMED` alone does not qualify.
g. Run `scripts/blind-relabel.mjs translate --in findings.audit.json --out
   findings.json --mapping <run-dir>/phase3-private/seat-to-audit-label.json --phase1-dir <run-dir>/phase1
   [--verification-dir <phase3 dir>] [--audit-depth full]` (the verification flag only when
   the Falsification pass ran; the depth flag when the auditor brief used it) to produce the real-ID `findings.json`.
   This is the only supported way to produce it. Never hand-transcribe
   the auditor's `X`/`Y` output into real IDs. A nonzero exit means
   `findings.json` was not written; do not report synthesis complete
   until it exits 0.
h. Build `joint-findings.md` (collaborate mode) or a scorecard
   (adversarial/independent mode) from the translated `findings.json`,
   one row per finding. For the scorecard, run `node
   scripts/blind-relabel.mjs scorecard --in <run-dir>/phase3/findings.json
   --out <run-dir>/phase3/scorecard.md` (plus `--phase1-dir <run-dir>/phase1`
   for a Hypotheses column when the packet tags claims `[H1]`...) rather
   than building the table by hand. Read its `independently_discovered` field; never re-derive it.
   There is no joint-findings script: in collaborate mode run `scorecard` too,
   and write `joint-findings.md` from `findings.json` (the settled findings with
   their evidence, then the unresolved ones with both positions).
i. Write the manifest body with honest requested-versus-observed model
   and effort information, the `seat_to_audit_label` mapping, and the
   auditor model-family limitation (both seats and the auditor are
   Claude; this bounds but does not eliminate self-preference risk).
   Then run `scripts/build-manifest.mjs --in <that body> --out
   manifest.json` with `--task-packet`/`--phase1` (the `phase1/original/`
   copies)/`--phase2`/`--verification`/`--findings` pointing at whichever
   artifact files this run produced, plus `falsification.breakdown` from
   `audit-prep`'s output, `--seat-transcript A=<agentId>
   --seat-transcript B=<agentId> --seat-transcript auditor=<agentId>`,
   and `--seat-usage <role>=<final context tokens>,<ms>` for each
   duration (all three are subagents with no result.json; write `unknown`
   for a number you do not have, never a guess),
   to stamp a deterministic `run_id` and content hashes — see Manifest
   below, and review-protocol.md's Manifest and final output for the fields. Never
   author `run_id` or `hashes` by hand. Then run `scripts/blind-relabel.mjs
   clear-cache`: it deletes the cached plain-text copy of the target the
   blind-relabel commands kept in the OS temp folder.

## Manifest

Write the manifest body (the fields in review-protocol.md's Manifest and final
output, except `run_id` and `hashes`) and
lead the report with pairing, mode, and completion status. Record the actual
run, not intended success. Then run `scripts/build-manifest.mjs` with `--in`
pointing at that body and `--out manifest.json`, passing `--task-packet`/
`--phase1`/`--phase2`/`--verification`/`--findings` for whichever artifact
files this run actually produced — the script stamps a fresh `run_id` and
content hashes onto the manifest deterministically; never author `run_id` or
`hashes` by hand, and the
script itself refuses to run if the input body already declares either key.
`--phase1`/`--phase2`/`--verification` each take ONE path and repeat per
file — never a single comma-joined value:

```text
node "<skill-dir>/scripts/build-manifest.mjs" --in "<run-dir>/phase3/manifest-body.json" --out "<run-dir>/manifest.json" --task-packet "<run-dir>/task-packet.md" --phase1 "<run-dir>/phase1/original/A-findings.md" --phase1 "<run-dir>/phase1/original/B-findings.md" --phase2 "<run-dir>/phase2/peer-view-for-A.md" --phase2 "<run-dir>/phase2/peer-view-for-B.md" --findings "<run-dir>/phase3/findings.json" --falsification "<run-dir>/phase3/falsification-breakdown.json" --seat-transcript A=<seat A agentId> --seat-transcript auditor=<auditor agentId>
```

Hash the untouched Phase 1 copies in `phase1/original/` (see the Phase 1
completion gate), not the working files that Phase 2 appended rebuttals to:
the manifest must prove what each seat wrote before it saw its peer.
`build-manifest.mjs` refuses two files with the same name under one flag, and warns
about any completed `result.json` under the run directory that no
`--reviewer-result` names.

For a Codex or OpenCode seat, `--reviewer-result B=<result.json>` fills that
seat's `reviewers[]` entry (requested/resolved model and effort, verification
note, isolation, web access, usage, duration) without touching fields the body
already sets; `null` and the example's placeholders count as not set, and a
written value that differs from result.json is kept but printed as a WARNING.
Repeat it once per call of that seat (Phase 1, exchange, redaction): the files
must agree on model, effort and isolation (build-manifest refuses otherwise),
`duration_ms` is the sum, `usage_per_call` lists each call (a resumed call's own
tokens, result.json's `usage_delta`, are there; the entry has no `usage_delta`
key), and `usage` is the
last call's for one Codex thread (its totals are cumulative) or the per-call
sum otherwise. `provider` and `selection_source` are still written by hand, so
the smallest body entry for a Codex seat is
`{"role": "B", "provider": "openai", "selection_source": "saved"}`
plus `--reviewer-result B=<run-dir>/phase1/B/result.json --reviewer-result
B=<run-dir>/phase2/B/result.json`. `--falsification <run-dir>/phase3/falsification-breakdown.json`
(the file `audit-prep --breakdown-out` wrote) fills `falsification.breakdown`
and `qualified_claims`; write only `requested` and `verifiers_run` yourself. A harness seat and the auditor have no `result.json`, so their cost is lost
unless recorded: add `--seat-transcript A=<agentId>` (and
`--seat-transcript auditor=<agentId>`; `B=` too when seat B is a harness seat),
with the agentId the Agent tool returned when it started that subagent (or the
path of its `agent-<id>.jsonl`). build-manifest sums every API call in that
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
The scripts store every time in UTC (`startedAt`, `finishedAt`, pre-flight
times), except Codex's `retryAfter`, which is this machine's local time. When
you tell the user a time, in a progress note or the report, give this machine's
local time first, for example "started 8:14 AM (13:14 UTC)"; plain `Get-Date` or
`date` prints the local time and offset. A file the protocol does not name
(an auditor's prose synthesis, for example) is hashed with
`--extra-artifact <name>=<path>`; say in the body why it exists. The manifest also gets `skill_version`,
stamped from the SKILL.md of the skill that ran `build-manifest`, and
`skill_versions` (for example `{"phase1": "1.6.4", "phase3": "1.6.6"}`), which
`build-manifest` fills from `<run-dir>/skill-versions.jsonl`: `build-brief`
appends the version to it for every brief, so keep `--out` at
`<run-dir>/manifest.json`. It warns when the version changed during the run.
Write `skill_versions` in the body only for a run whose briefs left no such file.

Hash only the bytes the scripts wrote. In Windows PowerShell, `git diff >
file` and `Set-Content` re-encode text (UTF-16 or a BOM, CRLF endings), so the
hash no longer matches the raw git output another session computes. Write
evidence files with Git Bash, `git diff --output=<file>`, or
`[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`.

## Report

**An unresolved-high-stakes finding needs a next step.** When a finding ends
`unresolved-high-stakes` and falsification was not requested, list it at the top
of the report with both sides' evidence and the auditor's own check, and offer
the user one falsification verifier for exactly that claim ("deep verify
disputed high-severity findings"). Never run it without that request: the
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
confirm or refute. Resuming the original seats on the fixed code is a quicker
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
