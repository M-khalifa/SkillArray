# Phase 3 — Scorecard

Synthesis does not happen in the orchestrator's own conversation. The
orchestrator has already read both reviewers' real findings and, in a
cross-vendor run, likely inferred which seat is which vendor from dispatch
mechanics alone — it cannot become blind to that by relabeling files after the
fact. Per [review-protocol.md](review-protocol.md)'s Fresh-context auditor,
synthesis runs in a newly spawned subagent instead.

## Coin flip and relabel to X/Y

Before spawning the auditor, run `scripts/blind-relabel.mjs flip --out
"<run-dir>/phase3/seat-to-audit-label.json"` to decide `seat_to_audit_label`.
Record it in the manifest now; never show it to the auditor.

Each findings-plus-rebuttals file contains BOTH that seat's own claims (its own
letter) AND its rebuttal of the peer's claims (the peer's letter, carried
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
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase3/tmp-A.md" --from A --to <label-A>
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3/tmp-A.md" --out "<run-dir>/phase3/<label-A>-findings.md" --from B --to <label-B>
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase3/tmp-B.md" --from B --to <label-B>
node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3/tmp-B.md" --out "<run-dir>/phase3/<label-B>-findings.md" --from A --to <label-A>
```

(`phase1/A-findings.md` and `phase1/B-findings.md` are Phase 2's target files:
Phase 2 appends each seat's rebuttal directly onto its own Phase 1 file rather
than writing new ones.)

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
strings used in Phase 2) over each fully double-relabeled file, same
self-identification hard stop as Phase 2's Blind exchange check. Allow at most
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

MUST NOT save it under the real `A<n>`/`B<n>` ID — the auditor reads this same
directory. The orchestrator saves it; the verifier is pathless like the
auditor (see Spawn the fresh auditor below).

These files become additional auditor input. `translate --verification-dir`
parses each file's own `Claim:`/`Verdict:` lines and refuses if either
disagrees with the filename or with what the auditor's
`verifications[].verdict` asserts. The verifier's file is authoritative for
its ENTIRE record; `translate` never trusts the auditor's transcription of it,
and populates `verifications[].basis`/`.evidence` directly from the file's own
`Basis:`/`Evidence:` lines, never from the auditor's JSON.

## Spawn the fresh auditor

Spawn a new subagent (not the orchestrator's own context) with ONLY:

- the original task packet;
- the relabeled `X`/`Y` combined findings;
- any `phase3/verification-<X|Y-id>.md` files from the Falsification pass
  above;
- read-only access to the exact Phase 1 target snapshot (the isolated
  worktree path for a seat that used `--isolate`, the target directory
  otherwise — never a later, drifted working-tree state);
- review-protocol.md.

MUST NOT give it seat identity, provider/model names, dispatch transcripts, or
this skill's own SKILL.md. The auditor MUST NOT modify the target.

Instruct it to:

1. Spot-check the highest-impact or most-contested claims itself, using its
   own read-only target access — this is what makes "Verification: the
   auditor's own independent check" a real check and not just re-weighing the
   two reviewers' own arguments.
2. For every surviving claim, apply review-protocol.md's rebuttal-overturn rule
   (a rebuttal only overturns a claim with a specific checkable counter-fact,
   never bare disagreement) and its SPECULATIVE-claim-drop rule, then produce
   the adjudication-added fields (Peer response, Verification, Final state)
   defined in review-protocol.md's Synthesis section.
3. Group surviving claims (including a dropped-SPECULATIVE one — grouping is
   not filtering) into canonical findings per review-protocol.md's Canonical
   findings section. MUST only merge claims asserting the SAME underlying
   defect, never merely the same file or area; when in doubt, keep them
   separate.

   The `Verification` field from step 2 has its structured `findings.json`
   home HERE, recorded once per canonical finding (not once per origin claim
   — per-origin granularity is deferred) as an `auditor_check: {result,
   basis, evidence}` object:

   - `result` MUST be one of `CONFIRMED`/`REFUTED`/`INCONCLUSIVE`/`NOT_CHECKED`
     (`NOT_CHECKED` when none of this finding's origin claims were
     spot-checked in step 1).
   - `evidence` MUST be a non-empty string, and `basis` MUST be one of
     `EXECUTED`/`STATIC_TRACE`/`SOURCE_CITATION`/`INFERENCE` (the same enum a
     verifier's own `Basis:` line uses) — UNLESS `result` is `NOT_CHECKED`, in
     which case both MUST be `null`.

   `translate` refuses:

   - any finding missing the `auditor_check` object;
   - `settled-refuted` when `result` is `CONFIRMED`, and `settled-agree` when
     `result` is `REFUTED` — the auditor cannot both independently settle a
     claim one way and record the opposite `final_state`;
   - `settled-agree` UNLESS at least one of `independently_discovered`, a
     `conceded` peer response, or a `CONFIRMED` verification actually exists.
     Exception does not apply the other way: `result: CONFIRMED` alone is NOT
     enough, unlike `settled-refuted`'s `REFUTED` route — review-protocol.md's
     `settled-agree` definition has no equivalent auditor-alone clause;
   - `settled-agree` when any peer response is `disputed-with-counter-fact`,
     UNLESS a `verifications[]` entry for that finding is `CONFIRMED` — the
     falsification verifier's CONFIRMED verdict is the protocol's own
     designated mechanism for settling a disputed claim in its favor;
   - `dropped-speculative` UNLESS the finding is genuinely SPECULATIVE, not
     independently discovered by both seats, unattacked by any peer response,
     `result` is not `CONFIRMED` or `REFUTED`, and it has no `verifications`
     entry — a falsification verifier having checked it at all, any verdict,
     means it is no longer merely an untouched speculative claim;
   - any finding whose `verifications[]` has a `CONFIRMED` verdict alongside
     `settled-refuted`, or a `REFUTED` verdict alongside `settled-agree`, for
     any origin — one origin's verdict speaks for the whole canonical
     finding.

   Emit one `F<n>` JSON object per finding with `origins` listing every
   `X`/`Y` claim ID it covers, per the `findings.json` schema in
   review-protocol.md. The auditor returns this shape under `X`/`Y` IDs as its
   own output; it never computes or sees `independently_discovered` — that
   field is derived mechanically after translate-back, not the auditor's job.

   If any of a finding's origins has a `phase3/verification-<claim-id>.md`
   file, record it as a `verifications` entry `{ claim, verdict }` on that
   finding. `basis` and `evidence` are NOT the auditor's to supply —
   `translate` reads the verifier file itself and populates both from its own
   `Basis:`/`Evidence:` lines, refusing if the file's `Verdict:` disagrees
   with what's recorded here.

State this limitation explicitly in the eventual report: the auditor is still
the same model family as one or both reviewers (Claude), so this bounds but
does not eliminate self-preference risk; it is not vendor-neutral adjudication.

## Translate back and build the scorecard

Save the auditor's raw returned JSON as `<run-dir>/phase3/findings.audit.json`
(still `X`/`Y` IDs throughout — do not hand-edit or hand-translate it). Run:

```text
node "<skill-dir>/scripts/blind-relabel.mjs" translate --in "<run-dir>/phase3/findings.audit.json" --out "<run-dir>/phase3/findings.json" --mapping "<run-dir>/phase3/seat-to-audit-label.json" --phase1-dir "<run-dir>/phase1" --verification-dir "<run-dir>/phase3"
```

Omit `--verification-dir` when the Falsification pass did not run this round.

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
  verification file on disk that no finding cites.

Build the human-readable scorecard from the translated `findings.json`, one row
per finding, not per origin claim:

| Finding | Origins | Independently discovered | Severity | Basis | Evidence strength | Peer responses | Final state | Evidence |
|---|---|---|---|---|---|---|---|---|
| F1 | A1, B4 | yes | HIGH | EXECUTED | REPRODUCED | A1: conceded; B4: disputed-no-counter-fact | settled-agree | Actual command/output |
| F2 | B1 | no | MEDIUM | SOURCE_CITATION | SUPPORTED | B1: disputed-no-counter-fact | unresolved-low-stakes | Actual cited source |

When a finding carries a `verifications` entry, add its verdict to that row
(e.g. "B4: disputed-no-counter-fact (verified: CONFIRMED)") rather than a
separate column — a verifications entry only exists for a claim the
Falsification pass actually ran on.

"Independently discovered" is `findings.json`'s own `independently_discovered`
field, never re-derived or asserted by hand in the report — read it, don't
recompute it.

Example rows illustrate the format, not actual findings.

Rebuttals without counter-facts cannot refute a claim. Agreement based only on
a static trace or citation stays at that basis; it does not become EXECUTED
merely because both reviewers agree. Report important evidence gaps as well as
disagreements. State how many SPECULATIVE claims were filtered by the auditor;
never filter EXECUTED + REPRODUCED.

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

## Report

Lead with the manifest and whether both seats completed. Include key findings,
the scorecard, prominent unresolved disagreements, execution limitations, pass
counts (reviewer passes, blind rebuttal exchanges, whether the fresh auditor
ran, falsification verifiers run — from `manifest.json`'s `falsification`
object — never lump these together as generic "rounds"), and the auditor
model-family limitation stated above. Unknown actual model/effort and
source-write audit results stay explicitly unknown. Never turn an incomplete
review into a completed verdict.
