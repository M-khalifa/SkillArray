# Phase 3 — Scorecard

## Contents

- Coin flip and relabel to X/Y
- Falsification pass (optional)
- Spawn the fresh auditor
- Translate back and build the scorecard
- Cache cleanup
- Isolation cleanup
- Manifest
- Report

Synthesis does not happen in the orchestrator's own conversation. The
orchestrator has already read both reviewers' real findings and, in a
cross-vendor run, likely inferred which seat is which vendor from dispatch
mechanics alone — it cannot become blind to that by relabeling files after the
fact. Per [review-protocol.md](review-protocol.md)'s Fresh-context auditor,
synthesis runs in a newly spawned subagent instead.

## Coin flip and relabel to X/Y

Before spawning the auditor, run `scripts/blind-relabel.mjs flip --out
"<run-dir>/phase3-private/seat-to-audit-label.json"` to decide
`seat_to_audit_label`. Record it in the manifest now; never show it to the
auditor. Keep it, and any relabel temp file, in `phase3-private/`, never in a
folder the auditor can read.

Then build the auditor's folder with one command. Create a new, empty folder
OUTSIDE the run directory (for example a sibling `audit-input-<random>`):

```text
node "<skill-dir>/scripts/blind-relabel.mjs" audit-prep --phase1-dir "<run-dir>/phase1" --mapping "<run-dir>/phase3-private/seat-to-audit-label.json" --out-dir "<audit-input-dir>" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase2-dir "<run-dir>/phase2" --packet "<run-dir>/task-packet.md" --breakdown-out "<run-dir>/phase3/falsification-breakdown.json"
```

Add the run's `--source-dir "<repo>"` list when the packet reviews other
repositories by path, and its `--checklist <NAME>` list when the packet names
an outside checklist (phase-2-cross-examination.md, Outside checklists). `audit-prep` runs both relabel passes per seat with
output names taken from the mapping, handles a seat with zero rebuttals, runs
`scan` with `--forbid-seats A,B` and the Phase 2 peer-label check on each
result, and only if both scans are clean writes `X-findings.md`,
`Y-findings.md`, a byte-exact `task-packet.md` and this skill's
`review-protocol.md` into `<audit-input-dir>`. On any hit it writes nothing
there and prints the hits; the redaction procedure is the one in
phase-2-cross-examination.md's Blind exchange rules. Do not copy anything into the folder by
hand: after a redaction, run `audit-prep` again with a new empty folder. It
also prints `falsificationBreakdown` for the manifest. It refuses, writing nothing, when a seat had peer claims but its rebuttal
section is missing from the peer's findings file (for example after `exchange.mjs
finish` refused and restored both files), unless `finish` recorded that seat as
incomplete in `phase2/exchange-result.json`.

The manual steps below are what `audit-prep` does; follow them only when the
command cannot run.

Each findings-plus-rebuttals file contains BOTH that seat's own claims (its own
letter) AND the peer's rebuttal OF those claims (the peer's letter, carried
through Phase 2's translate-back-to-real-IDs step). MUST relabel each file
TWICE, once per letter, chaining the second pass onto the first file's output
rather than the original.

MUST name the output file after the flip's label for THAT SEAT, never a fixed
`X`-for-`A` assumption: `phase1/A-findings.md` becomes
`<seat_to_audit_label.A>-findings.md`, whatever that letter actually is.

Rationale: reusing a fixed X/A, Y/B pairing regardless of the coin-flip result
puts content labeled with one letter into a file named after the other. That
filename-vs-content mismatch is exactly the correlation this phase exists to
prevent.

MUST read `seat_to_audit_label` from the manifest FIRST and substitute both
the `--to` values and the `--out` filenames from it before running anything
below. `<label-A>` and `<label-B>` are that mapping's values for seat A and
seat B respectively (with `{"A":"X","B":"Y"}`, `<label-A>` is `X`; with
`{"A":"Y","B":"X"}`, `<label-A>` is `Y`):

```text
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase3-private/tmp-A.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-A.md" --out "<audit-input-dir>/<label-A>-findings.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase3-private/tmp-B.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-B.md" --out "<audit-input-dir>/<label-B>-findings.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
```

(`phase1/A-findings.md` and `phase1/B-findings.md` are Phase 2's target files:
Phase 2 appends each seat's rebuttal onto the PEER'S Phase 1 file — the file
of the seat being rebutted, not the rebutting seat's own — rather than
writing new ones. `A-findings.md` therefore carries seat A's own claims AND
seat B's rebuttal of them.)

Pass `--phase1-dir` on every pass: relabel rewrites only real claim IDs, and a
second pass needs the Phase 1 headings to know the peer's real IDs.

MUST NOT relabel a file only once. A single pass leaves the peer's real letter
inside that file's rebuttal-section heading and prose (see review-protocol.md's
Three label layers), handing the auditor a direct `A`/`B` cross-reference and
defeating the blind.

MUST NOT reuse Phase 2's `P` labels here — this is a third, separate namespace.

`blind-relabel.mjs relabel` also rewrites each seat's "Rebuttals (from ...) of
... claims" heading in the same pass, so the auditor sees who is rebutting whom
(e.g. "Rebuttals (from Y) of X claims") without any manual heading edits or
real identity.

MUST run `blind-relabel.mjs scan` (with the same `--tokens` model/provider
strings used in Phase 2, AND `--phase1-dir "<run-dir>/phase1" --forbid-seats
A,B` — both real seat letters, since a double-relabeled file must contain
NEITHER real letter anywhere, fenced Evidence included, plus `--phase2-dir
"<run-dir>/phase2"` for leftover peer `P` labels) over each fully
double-relabeled file, same self-identification hard stop as Phase 2's Blind
exchange check. Omitting `--forbid-seats` here reopens the fenced Evidence
claim-ID leak class documented under review-protocol.md's Model identity. Allow at most
one redaction round, then stop and report.

The second (peer-letter) pass on a seat that had zero rebuttals to append —
no rebuttal section, so nothing for that pass to relabel — exits nonzero with
"no <letter> claim IDs, seat header, or rebuttal heading found"; this is
expected, not a failure. Copy `tmp-A.md`/`tmp-B.md` to the final
`<label-A>-findings.md`/`<label-B>-findings.md` name in that case instead of
treating the second command's exit code as an error.

## Falsification pass (optional)

Only when the task explicitly requests it.

Selection: from the real (pre-relabel) Phase 2 files, select every claim with
`Severity` HIGH or CRITICAL AND a rebuttal entry whose `Action` is `DISPUTE`
(review-protocol.md's Interaction modes rebuttal schema). This is a mechanical
selection, not the auditor's job.

MUST NOT use the auditor's `Peer response` field for selection — it does not
exist yet at this point, since the auditor runs after this pass.

MUST record the structured `falsification` object in the manifest regardless
of whether this pass ran (`requested`, `qualified_claims`, `verifiers_run` —
see review-protocol.md's Manifest and final output). When not requested, still
count and report how many claims qualified, with `verifiers_run: 0`.

For each qualifying claim:

1. Map its real claim ID to its `X`/`Y` label via `seat_to_audit_label`.
2. Extract that claim's block and rebuttal block from the
   `<label-A>-findings.md`/`<label-B>-findings.md` files already built above
   (Coin flip and relabel to X/Y). Do not re-relabel — those files already
   carry this claim under its `X`/`Y` label.
3. Spawn one fresh verifier subagent per claim with ONLY: that extracted
   `X`/`Y` claim block, its `X`/`Y` rebuttal block, read-only target access
   under Phase 1's no-edit rule, and review-protocol.md.
   MUST NOT give it the seat-to-audit mapping, vendor/model names, or this
   skill's own SKILL.md.

The verifier returns a fixed-schema block: `Claim: <its own X|Y id>`,
`Verdict: CONFIRMED | REFUTED | INCONCLUSIVE`, `Basis:`, `Evidence:`. Evidence
MUST be independent and appropriate to the target:

- Code review-profile targets: executed evidence.
- Architecture/Document review-profile targets (see
  references/review-profiles.md): SOURCE_CITATION, STATIC_TRACE, or an
  explicit constraint or contradiction trace.
- Exception: never a weaker substitute for a real independent check, on
  either target type.

MUST NOT return a new finding. MUST reject any claim ID in its output other
than the one it was given.

MUST run `blind-relabel.mjs scan` on the verifier's returned text before
saving it.

Save each verdict as `<run-dir>/phase3/verification-<X|Y-id>.md` (e.g.
`verification-X3.md`), named by the anonymous ID the verifier was given.

MUST NOT save it under the real `A<n>`/`B<n>` ID — the auditor reads these
files. The orchestrator saves it and copies it into `<audit-input-dir>`; the
verifier is pathless like the auditor (see Spawn the fresh auditor below).
`build-brief.mjs --mode verifier` builds its prompt.

These files become additional auditor input. `translate --verification-dir`
parses each file's own `Claim:`/`Verdict:` lines and refuses if either
disagrees with the filename or with what the auditor's
`verifications[].verdict` asserts. The verifier's file is authoritative for
its ENTIRE record; `translate` never trusts the auditor's transcription of it,
and populates `verifications[].basis`/`.evidence` directly from the file's own
`Basis:`/`Evidence:` lines, never from the auditor's JSON.

**Deep verify after the audit.** When the user accepts the falsification offer
for an `unresolved-high-stakes` finding after the audit ran, the order changes:
take the finding's `X`/`Y` origin from the staged findings and the mapping, run
one verifier per claim as above (pass the run's `--source-dir` list to
`build-brief --mode verifier` too, so it can read code outside the target),
save and scan each file, copy it into the staged audit folder, then resume the
SAME auditor with a request that only adds `verifications[]` and updates
`final_state` for those findings. `translate` refuses a verification file that
no finding cites. Keep the earlier `findings.json`, scorecard and manifest in
`phase3/before-verify/`, rerun `translate --verification-dir`, `scorecard` and
`build-manifest` (it stamps a new `run_id`, which is expected), and record each
verifier's cost with `--seat-transcript verifier=<agentId>` (repeatable; the
calls are summed). `falsification.verifiers_run` may be lower than
`qualified_claims` when the user chose only some; the report says which.

## Spawn the fresh auditor

Spawn a genuinely new subagent with ONLY the items below — **never** a fork
of the orchestrator's own conversation (e.g. an `Agent` tool call with
`subagent_type: "fork"`, or any equivalent that inherits context): a fork
would hand the auditor the orchestrator's own conversation, which by Phase 3
already contains both un-relabeled findings files, the coin-flip mapping, and
seat identity — the exact leak the fresh-context auditor exists to prevent.
Give it ONLY the staged `<audit-input-dir>` (see Coin flip above), which holds:

- the original task packet;
- the relabeled `X`/`Y` combined findings;
- any `verification-<X|Y-id>.md` files from the Falsification pass above
  (copied in from `phase3/`);
- review-protocol.md;

plus read-only access to the exact Phase 1 target snapshot (the isolated
worktree path for a seat that used `--isolate`, the target directory otherwise
— never a later, drifted working-tree state). Never point it at the run
directory or `phase3/`.

MUST NOT give it seat identity, provider/model names, dispatch transcripts, or
this skill's own SKILL.md. The auditor MUST NOT modify the target.

Run the auditor as a general-purpose agent (it writes its own output file) on
seat A's model, unless the user names another, and record that family in the
manifest's `auditor_model_family`.

Build its prompt with `build-brief.mjs`, which refuses a staged folder that
holds real-letter, mapping or temp files, a staged folder inside the run
directory, or a task packet that mentions the run directory (for example a
pre-flight log path), and give it one output path inside
the staged folder so it writes the JSON itself instead of returning 30-40 KB of
text for the orchestrator to retype:

```text
node "<skill-dir>/scripts/build-brief.mjs" --mode auditor --packet "<audit-input-dir>/task-packet.md" --audit-dir "<audit-input-dir>" --target-dir "<target-dir>" --run-dir "<run-dir>" --out "<audit-input-dir>/auditor-brief.txt" --output-path "<audit-input-dir>/findings.audit.json" --audit-depth light
```

The brief goes in the staged folder because the auditor reads it;
`build-brief.mjs` refuses an `--out` or `--output-path` inside the run
directory. A sibling folder whose name continues the run directory's name with
a letter, digit, `.`, `_` or `-` (`<run-dir>-evidence`) is not treated as
inside it; a name continued by a space (`<run-dir> 2`) is refused, because such
a path can be a link or walk back with `..`. Name evidence folders
`<run-dir>-evidence` or similar.

Add `--source-dir "<repo>"` for each other repository the packet reviews, so
the auditor can check claims about code there.

`--audit-depth light` (the default) has the auditor re-check only findings the
other reviewer did not concede. Use `--audit-depth full` when the task text
says "double check all claims": the auditor then re-checks every finding, at
the cost of more time and tokens (in one design review the full audit took
6.2 minutes and 143k tokens, and about half of its checks were on claims both
reviewers agreed on). Pass the same value to `translate` below, and record it
as `audit_depth` in the manifest. When `exchange.mjs finish` warns that every rebuttal conceded, a light audit
would re-check nothing; use full depth unless the user chose light. Only
`build-brief.mjs --mode auditor` and `translate` take `--audit-depth`;
`audit-prep` has no depth flag.

Tell the auditor to read that brief file. Its instructions are the list below.

Its instructions are review-protocol.md's Auditor instructions (under
Fresh-context auditor), which `build-brief.mjs --mode auditor` copies into the
brief verbatim; both skills use that one list.

State this limitation explicitly in the eventual report: the auditor is still
the same model family as one or both reviewers (Claude), so this bounds but
does not eliminate self-preference risk; it is not vendor-neutral adjudication.

## Translate back and build the scorecard

Copy the auditor's `<audit-input-dir>/findings.audit.json` to
`<run-dir>/phase3/findings.audit.json` (still `X`/`Y` IDs throughout — do not
hand-edit or hand-translate it). If the auditor could only return text, save
that reply with a script, never by retyping it. Run:

```text
node "<skill-dir>/scripts/blind-relabel.mjs" translate --in "<run-dir>/phase3/findings.audit.json" --out "<run-dir>/phase3/findings.json" --mapping "<run-dir>/phase3-private/seat-to-audit-label.json" --phase1-dir "<run-dir>/phase1" --verification-dir "<run-dir>/phase3" --audit-depth light
```

Omit `--verification-dir` when the Falsification pass did not run this round.
Use the same `--audit-depth` as the auditor brief.
Add the run's `--checklist <NAME>` list when the packet names an outside
checklist, or a declared label such as `CHK-P2` in the auditor's prose is
refused as an unresolved peer label.

This is the ONLY supported way to produce `findings.json`. MUST NOT
hand-transcribe the auditor's `X`/`Y` output into real IDs — that reintroduces
exactly the retyping-is-unreviewed-code risk this script exists to avoid.

A nonzero exit means `findings.json` was NOT written; do not report synthesis
as complete until it exits 0. Causes include:

- invalid JSON, or a malformed `--mapping`;
- an origin that fails to translate to a real `A<n>`/`B<n>` ID;
- with `--phase1-dir`: an origin whose claim ID has no matching heading in
  that seat's real Phase 1 file (catches a hallucinated ID), or a real Phase 1
  claim from either seat that is the origin of no finding at all (catches one
  the auditor silently dropped);
- with `--verification-dir`: a cited verification file missing on disk, or a
  verification file on disk that no finding cites;
- a prose field (`summary`, `recommended_fix`, `title`) that contains one of the
  run's anonymous claim IDs or a peer `P` label. Ask the auditor to reword it;
  do not edit the JSON yourself.

Build the human-readable scorecard from the translated `findings.json`, one row
per finding, not per origin claim, with the script rather than by hand:

```text
node "<skill-dir>/scripts/blind-relabel.mjs" scorecard --in "<run-dir>/phase3/findings.json" --out "<run-dir>/phase3/scorecard.md" [--phase1-dir "<run-dir>/phase1"]
```

It prints a totals line per `final_state`, then this table. The table has no
evidence column; quote the evidence for key findings in the report itself,
from `findings.json`'s `evidence`:

| Finding | Title | Origins | Independently discovered | Severity | Basis | Evidence strength | Peer responses | Auditor check | Final state | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Retry drops the first error | A1, B4 | yes | HIGH | EXECUTED | REPRODUCED | A1: conceded; B4: disputed-no-counter-fact (verified: CONFIRMED) | CONFIRMED | settled-agree | |
| F2 | Stale version in the header | B1 | no | MEDIUM | SOURCE_CITATION | SUPPORTED | B1: disputed-no-counter-fact | NOT_CHECKED | unresolved-low-stakes | disputed without a counter-fact, not settled either way |

The Note column says why a refuted or unresolved finding ended that way, for
example that an auditor confirmation alone cannot settle a peer's untested
counter-fact. When the packet gives the seats a numbered list to confirm or
refute (`[H1]`, `[H2]`, ...) and asks them to put the tag in each claim title,
add `--phase1-dir`: a Hypotheses column then maps each finding to its tags.

A falsification verdict appears inline in Peer responses, as in F1 above; a
verifications entry only exists for a claim the Falsification pass actually
ran on.

"Independently discovered" is `findings.json`'s own `independently_discovered`
field, never re-derived or asserted by hand in the report — read it, don't
recompute it.

Example rows illustrate the format, not actual findings.

Rebuttals without counter-facts cannot refute a claim. Agreement based only on
a static trace or citation stays at that basis; it does not become EXECUTED
merely because both reviewers agree. Report important evidence gaps as well as
disagreements. State how many SPECULATIVE claims were filtered by the auditor;
never filter EXECUTED + REPRODUCED.

## Cache cleanup

Once `translate` has run, delete the cached target text the blind-relabel
commands kept in the OS temp folder: `node "<skill-dir>/scripts/blind-relabel.mjs"
clear-cache`. It holds a plain-text copy of every file of the target and each
`--source-dir`.

## Isolation cleanup

If any seat used `--isolate`, remove its worktree once this run is fully done
(including the Falsification pass, if it ran): `git -C "<target-dir>" worktree remove
--force "<worktreePath>"`, using the path preserved from that seat's Phase 1
result.json. Run this from the target repository, not the worktree — `-C
<target-dir>` makes the caller's own working directory irrelevant. Also delete
the sibling marker file `<worktreePath>.snapshot-complete` (opencode-dispatch.mjs
writes it outside the worktree to detect reuse; `worktree remove` does not clean
it up). Do this after the report is written, not before — the worktree may
still be useful for manual inspection if something looks wrong.

If the run directory holding `worktreePath` was already deleted (e.g. a
scratchpad wipe) before this cleanup ran, `worktree remove` has nothing to
target and `.git/worktrees/<name>/` is left behind as a stale entry. Recover
with `git -C "<target-dir>" worktree prune`, and confirm with `git -C
"<target-dir>" worktree list`.

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

Produce `manifest.json` per Manifest above (write the manifest body, then run `build-manifest.mjs` to stamp
`run_id`/`hashes` — never author those two fields by hand). Lead with the
manifest and whether both seats completed. Put any `unresolved-high-stakes`
finding first, with the falsification offer described below. Include key findings,
the scorecard, prominent unresolved disagreements, execution limitations, pass
counts (reviewer passes, blind rebuttal exchanges, whether the fresh auditor
ran, falsification verifiers run — from `manifest.json`'s `falsification`
object — never lump these together as generic "rounds"), the reason behind the
falsification count in words (from `falsification.breakdown`, e.g. "0
qualified: all 5 HIGH claims were conceded"), the audit depth (for light, say that agreed claims were
not re-checked), each seat's web usage as
`<n> queries, <m> page fetches`, any `TRUST-BOUNDARY` lines from `scan
--target-urls`, and the auditor model-family limitation stated above. Unknown actual model/effort and
source-write audit results stay explicitly unknown. Never turn an incomplete
review into a completed verdict.

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
