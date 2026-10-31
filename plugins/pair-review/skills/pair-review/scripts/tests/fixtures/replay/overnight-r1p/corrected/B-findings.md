# Seat B findings

## B1 — [AC-3] Where tag says "outside the change" for a finding whose file is in the change diff when the evidence path carries a snapshot prefix (field run shows it)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: evidence cites a file through a snapshot or review-copy folder (for example `REVIEW/head/Reporter.py:1263`) while since.diff names it repo-relative (`CONTOSO_V4_DEVICE/Reporter.py`). Met in 1 of the 2 field runs that have a since.diff (contoso-2026-10-16-r3, finding F6, and several secondary locations of F3/F4/F5). Holds on every platform.
Evidence:
```
> node build-report.mjs --run-dir field-runs\contoso-2026-10-16-r3\run --format chat --all
  ...
  - **MEDIUM** F6: Pre-existing: the drive summary always reports zero failed drives ...
    Where: outside the change (REVIEW/head/Reporter.py:1263)

since.diff line 1: diff --git a/CONTOSO_V4_DEVICE/Reporter.py b/CONTOSO_V4_DEVICE/Reporter.py   (hunks up to new line 2418)

Direct call of the shipped whereInChange on that since.diff (scratch harness importing build-report.mjs):
REVIEW/head/Reporter.py:1263 -> {"tag":"outside the change"}
Reporter.py:1263 -> {"tag":"changed file"}
CONTOSO_V4_DEVICE/Reporter.py:1263 -> {"tag":"changed file"}
REVIEW/head/Reporter.py:60 -> {"tag":"outside the change"}      <- line 60 is an ADDED line (hunk @@ -57,6 +57,12 @@)
C:/snap/head/CONTOSO_V4_DEVICE/Reporter.py:60 -> {"tag":"added lines"}

build-report.mjs:625-630: a path containing "/" only matches when one path ends with the other at a "/" boundary;
otherwise hits is empty and the tag is 'outside the change' (the basename rule at :627 is used only for bare names).
```
The report prints this tag next to the author's pre-existing / fixed decision, so a reader sees "outside the change" for code the change did touch (even added lines). The help text (build-report.mjs:32) promises "changed file" or "unknown", not a wrong "outside".
Suggested fix: in whereInChange (build-report.mjs:625-630), when a "/" path has no boundary match, fall back to the unique-basename rule, and return 'unknown' (not 'outside the change') when the basename is ambiguous or absent only because of a prefix mismatch.
Same shape elsewhere: build-report.mjs:627-628 (a bare name that two diff files share gives 'outside the change' instead of 'unknown'); build-recheck-packet.mjs evidenceLocation (first location only, no matching, not affected). Searched every whereInChange/evidenceLocations caller.

## B2 — [AC-6] An older re-review run (packet worded "Confirm it is fixed") now renders "not fixed" as a green all-clear and "fixed" as a red defect line
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: re-rendering (build-report, or a recheck that reads it) any run whose packet hypotheses use the positive polarity: every packet the shipped 1.1.0 build-recheck-packet wrote ("... Confirm it is fixed, or refute it with evidence."), and hand-written packets in the same style (the contoso-replay field run's H1-H4 read "No combination ... makes ...", "Every consumer ... handles ..."). Every 1.1.0 re-review run meets it. Holds on every platform.
Evidence:
```
Fixture: copy of field run app-client-pr6064-2026-10-16-r3\run in my scratch folder; only change: packet line 52
rewritten to the 1.1.0 wording "- [H1] Previous finding F3 (high, settled-agree): <title> Confirm it is fixed, or
refute it with evidence." Seat lines keep "REFUTED" (both seats: under that wording, the fix did NOT work).

ea0b739 build-report.mjs (git archive into scratch) --format chat:
23:- REFUTED      H1 H2 H3          <- red "-" line
working tree build-report.mjs --format chat:
23:+ REFUTED      H1 H2 H3          <- green "+" line (all refuted = good news)
working tree, --color always: "HYPOTHESES (3)  ESC[32m 3 REFUTED" (green)

Same fixture with seat lines ending CONFIRMED (both seats: the fix works):
ea0b739:  "  HYPOTHESES   3 confirmed"   (neutral)
now:      "- CONFIRMED    H1 H2 H3"      (red defect line)

build-report.mjs:906-907 (text colour), :1208-1210 (chat lines), :488 (a tagged finding forces 'confirmed')
assume every hypothesis is worded as a suspected defect. Nothing reads the packet wording; the polarity rule exists
only in the new template text (task-packet-template.md "Write every hypothesis as a suspected defect").
CHANGELOG 1.2.0 says only that the NEW packet words findings "still present"; it does not say old runs flip.
```
AC-6 says an old run renders as before unless a change says otherwise; here the result flips in the direction that reports clean when it is not. The packet's change list ("hypothesis polarity (CONFIRMED is the red line...)") describes the new rendering; neither it nor the CHANGELOG says a packet written under the 1.1.0 wording renders inverted, and nothing in build-report detects that wording.
Suggested fix: in buildCriteria, mark a hypothesis row "polarity unknown" (neutral colour plus one caveat) when its packet text matches the 1.1.0 "Confirm it is fixed, or refute it" wording.
Same shape elsewhere: build-report.mjs:906-907 and :916 (renderText summary and row colour), :1049 (HTML chip colour: 'confirmed' now 'high'), :1208-1210 (chat). build-recheck-packet.mjs notesOutcomes is independent of polarity (not affected).

## B3 — [AC-3] A finding the author marks "wrong: <reason>" moves to Withdrawn in the table but is still counted under its severity, in the blocker count and in the SEVERITY lines
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: report-notes.md `## Finding status` with a "wrong: <reason>" line (the new outcome word); any run whose author withdraws a finding this way. Holds on every platform.
Evidence:
```
Fixture: copy of field run contoso-replay-r2-2026-10-16\run in my scratch folder, plus phase3/report-notes.md:
## Finding status
- F1: wrong: the cap is never reached
- F5: wrong

> node build-report.mjs --run-dir <copy> --format chat
> **REVIEW COMPLETE · 7 blockers (fix F2, F3, F4, ... first; F1 marked withdrawn in the report notes, not fix now) · ... · 14 findings**
HIGH     ████████████████████████   7
MEDIUM   ██████████                 3
LOW      ██████████████             4
| Fix now | F2 F3 F4 F7 F9 F10 | 6 |
| Can wait | F6 F12 F14 | 3 |
| Withdrawn | F1 F5 | 2 |
  WITHDRAWN    2 claim(s) refuted or dropped, or marked wrong by the author: F1 F5
  SEVERITY     F5 MEDIUM to LOW: ...                  <- severity change still listed for a withdrawn finding

> node build-report.mjs --run-dir <copy> --color never
STATUS COMPLETE   Blockers: 7   14 findings: 0 critical  7 high  3 medium  4 low      <- no "2 withdrawn"

build-report.mjs:671-674  standing/counts.withdrawn use f.state only; groupFindings uses authorWithdrawn (state OR notes)
build-report.mjs:782      blockers = findings.filter(f => f.blocker)  (notes ignored)
build-report.mjs:1154     changed = ... !WITHDRAWN_STATES.includes(f.state)  (notes ignored)
```
Independent count from the same files: 14 findings, 2 withdrawn by the notes, so 6 HIGH, 3 MEDIUM, 3 LOW standing (F5's audited severity is LOW); the header and bars say 7/3/4 with 0 withdrawn while the table says 2 withdrawn. The CHANGELOG line "The report no longer counts withdrawn findings under their severity" does not hold for author-withdrawn findings. Rated MEDIUM, not HIGH: the Fix-now table and banner are right; the wrong numbers overstate work rather than hide it.
Suggested fix: compute `standing` (build-report.mjs:671) after statuses are attached, excluding authorWithdrawn findings too, and use the same predicate for the blocker count (:782) and the SEVERITY list (:1154).
Same shape elsewhere: build-report.mjs:782 (blocker count), :1154 (SEVERITY lines), renderMarkdown/renderHtml headers (same report.counts). Searched every WITHDRAWN_STATES and counts.* use.

## B4 — [AC-5] The re-review packet says "the previous review had no findings" when every finding was settled in the notes, and lists two different "Previous finding F1" lines as decided
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a re-review of a run whose findings are all settled by report-notes outcome words (wrong/intentional/not-worth-it/decided) or --skip, and any round 3+ packet whose Known deviations carry a decided line from an earlier round (finding ids restart at F1 every round). The app-client field run meets both. Holds on every platform.
Evidence:
```
> node build-recheck-packet.mjs --from-run field-runs\app-client-pr6064-2026-10-16-r3\run --out <scratch>\p.md --since-diff <that run>\since.diff
build-recheck-packet: outcomes from ...\phase3\report-notes.md: F1 not-worth-it (known deviation)
...
p.md, ## Known deviations from the criteria:
- Previous finding F1 (decided, not re-checked; ...): partial_run reads as a whole-run completeness flag ...   <- round-1 F1, carried over
- Previous finding F2 (decided, not re-checked; ...): The fixed 1000-page cap ...
- Previous finding F1 (decided, not re-checked; ...): The page-2 completeness check words a replayed page 1 ...  <- round-2 F1, new
p.md, ## Hypotheses to test:
- FILL: the previous review had no findings; list what to re-check, or delete this section.

findings.json of that run holds 1 finding (F1, LOW). build-recheck-packet.mjs:250 prints the "no findings" text
whenever `previous` (findings minus settled ones) is empty; the decided line (build-recheck-packet.mjs:254-257)
names the bare id with no round.
```
The FILL text states a false fact and suggests deleting the section; the duplicated "F1" tells seats not to spend a claim on "F1" for two different defects, and a seat or the auditor cannot tell which a later "F1" means.
Suggested fix: at build-recheck-packet.mjs:250 say "every previous finding was settled (see Known deviations)" when findings exist but all are settled; in the decided line write the round with the id ("round 2 F1").
Same shape elsewhere: findingHypothesis ("Previous finding F3 ...") names bare ids too, but only of the immediately previous round; none other found (searched every "Previous finding" template in build-recheck-packet.mjs).

## B5 — [AC-3] The new lower-bound usage sum never applies to a Codex seat whose extra call was rate-limited: the seat's whole cost becomes "unknown" (the northwind field case)
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: a dispatched Codex seat with two or more result.json files on one thread where any call (usually the last: an extra task, a retry) reports no usage, for example rate-limited. codex-dispatch.mjs does not write usageSemantics (only claude-dispatch.mjs:307 and opencode-dispatch.mjs:728 do), so every Codex seat meets the shape; the northwind field run (packet: "a rate-limited extra call") meets it. Holds on every platform.
Evidence:
```
Fixture: copy of field run northwind-1a-cross-review-2026-10-16-1\run in my scratch folder (fx3).
The three result.json of seat B: all threadId 01a14758-..., none has usageSemantics;
  phase1/B: completed, usage_delta input 2549424 ...
  phase2/B: completed, usage_delta input 1250243 ...
  phase2/extra/B: rate-limited, usage {"source":"unavailable"}

> node build-manifest.mjs --run-dir fx3 --out m4.json --reviewer-result B=fx3/phase1/B/result.json
    --reviewer-result B=fx3/phase2/B/result.json --reviewer-result B=fx3/phase2/extra/B/result.json
build-manifest: wrote m4.json ...
> reviewers[B].usage  ->  {"source":"unavailable"}
> build-report.mjs --run-dir fx3 --format chat --all   (with m4.json as manifest.json)
| seat B | unknown | - | unknown | unknown | - | 51 tried, 8 failed |        <- no "lower bound" note

Without the extra call (auto-collected, 2 results) the same seat sums to input 3799667, cached 3610496, output 46603.

build-manifest.mjs:417-418: everyDelta is false (the failed call has no usable usage_delta), every result lacks
usageSemantics and there is one thread, so mergedUsage returns `last` = the failed call's {"source":"unavailable"};
sumUsages (:392-402, the new calls_without_usage path) is never reached.
```
The CHANGELOG/packet change ("usage sums with calls_without_usage (lower bound)") was made for this field case, and it still shows the seat's 3.8M input tokens as unknown.
Suggested fix: in mergedUsage (build-manifest.mjs:417-418), compute everyDelta and the "return last" branch over the results with usable usage only, and add calls_without_usage for the rest (or route a mix to sumUsages over usage_delta).
Same shape elsewhere: build-manifest.mjs:419-424 (legacy cumulative branch: finals.set keeps the last result of a thread even when it is the failed one, so a summed-per-thread total also loses that thread). Searched every return in mergedUsage and every sumUsages caller.

## B6 — [AC-2] Every re-review packet now gives the seats and the auditor the absolute path of the previous run folder, whose manifest names each seat's vendor and model
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: every packet build-recheck-packet writes (the intro line is not a FILL line, so nothing prompts the author to remove it); every round 2+ review. Holds on every platform.
Evidence:
```
> node build-recheck-packet.mjs --from-run field-runs\app-client-pr6064-2026-10-16-r3\run --out <scratch>\rp\p.md --since-diff ...
p.md:8: This is a re-review of the previous review (C:\Users\dev\cross-review-runs\overnight-r1\evidence\field-runs\app-client-pr6064-2026-10-16-r3\run). Those f...
(same line in the contoso-2026-10-16-r3 packet, p.md:10)

That folder holds manifest.json with  2x "provider": "<vendor redacted>", "model_requested": "<model redacted>" (one per seat letter),
and phase3-private/seat-to-audit-label.json.

> node build-brief.mjs --mode phase1 --packet <scratch>\rp\p.md --seat A --out <scratch>\newrun\brief-A.txt --run-dir <scratch>\newrun
build-brief: wrote newrun/brief-A.txt (20740 bytes)    exit 0
> grep -c "field-runs.app-client-pr6064-2026-10-16-r3.run" brief-A.txt  ->  1
> node blind-relabel.mjs scan --in <scratch>\rp\p.md
  (one IDENTITY hit, on line 4, text carried from the old packet; the previous-run path line is not flagged)

build-recheck-packet.mjs:461-474: previousRun is '{{previous-run-path}}', filled with the full `run` path after rewritePaths.
ea0b739 build-recheck-packet.mjs:284: previousRun was `the review in ${path.basename(run)}` (folder name only).
assertPacketOutsideRunDir (build-brief.mjs) checks only the CURRENT run folder.
```
A seat that follows the pointer (the intro invites it: "Those findings are listed below") reads which vendor/model held which seat letter, and the previous seats' findings files; the auditor brief inlines the same packet. The path is there so chainRound (build-recheck-packet.mjs:361-379) can walk the chain; that need does not require the seats to see it.
Suggested fix: keep the previous-run path out of the packet text (write it to a side file next to --out, for example since.diff's folder, for chainRound to read), and leave the intro as "the previous review" with no path.
Same shape elsewhere: build-recheck-packet.mjs:484 stdout note names since.diff in the new run folder but tells the author not to cite it (not a leak); none other found (searched every `run` path written into the packet text: the `pairs` rewrite maps the old run folder to the new one, so only the marker line keeps it).

## B7 — [AC-5] The trimmed protocol staged for the auditor drops two passages its own instructions tell it to consult
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
references/review-protocol.md:864 (Auditor instructions): "(see Not built by this feature in review-protocol.md's Web verification section)"
references/review-protocol.md:357 that passage sits under "### Web verification: orchestrator notes" (line 351)
references/review-protocol.md:827-828: "(see Manifest and final output for the explicit limitation statement ...)"
blind-relabel.mjs:21-22 AUDITOR_PROTOCOL_SECTIONS: includes '### Web verification: reviewer rules', not the orchestrator notes, and not '## Manifest and final output'

Scratch harness calling the shipped auditorProtocol() on both skills' review-protocol.md:
"Phase 3 auditor web" false        <- text of the passage at :357
"## Manifest and final output" false
```
No wrong verdict follows (the instruction states the conclusion itself), but the auditor is pointed at text it cannot find in its copy.
Suggested fix: reword the two pointers in the Auditor instructions to state the fact inline, or add the orchestrator-notes subsection to AUDITOR_PROTOCOL_SECTIONS after checking it names no vendor.
Same shape elsewhere: none found (searched every "see ..." and "review-protocol.md's ... section" pointer in the Fresh-context auditor section against the staged list).

## Checks performed
- AC-1: read the new failure paths (audit-prep staging rename, translate through writeFileAtomic, build-manifest readJsonOrAbsent, --since-only no-match refusal, codex mcp list refusal, review-run audit-depth stop); ran build-recheck-packet on 4 field runs (missing --since-diff and missing --repo-target both refuse with the path named). One step reports a cost as unknown instead of a lower bound (claim about the rate-limited Codex call). PARTIAL (claim B5 is the cost case; no step found that exits 0 with a missing output).
- AC-2: ran build-recheck-packet and build-brief phase1 on field runs; scanned the new packet with blind-relabel scan; ran auditorProtocol() and counted vendor/model tokens in the staged copy (0 in both skills); checked the same-shape lines carried into hypotheses for claim-id tokens (none). The new packet hands the previous run folder's path to seats and auditor. NOT MET (claim B6).
- AC-3: rendered all 5 field runs (chat, --all) and reconciled finding totals and severity counts with findings.json (14, 9, 18, 6, 1: all match); probed author-withdrawn counts and the rate-limited usage sum on scratch copies. NOT MET (claims B1, B3, B5).
- AC-4: read runCapture time limit and kill (codex-dispatch.mjs:441-456), signal forwarding now kept installed (on, with a stopping guard), killGroupOnExit on each seat spawn, detach worker re-read before declaring it gone; swept every spawn/spawnSync/execFile in the skill scripts, scripts/ and bench/ for windowsHide: every Windows-reachable spawn in the skill has it (directly or via spawnCli, spawn-utils.mjs:205-210); the ps calls without it are POSIX-only; release-check.mjs/install-check.mjs/compare-baseline.mjs spawns lack it but run from the maintainer's console. No process-list before/after run (no seat CLI dispatched). PARTIAL (not executed end to end; no defect found).
- AC-5: cross-checked the new flags (--review-rules, --review-rules-only, --rules, --since-only, --since-dirs, --round, --notes, --change-diff, --accept-drift, --repo-target) between parseArgs, --help and SKILL.md/references; --review-rules-only, --since-only and --round appear only in --help (not in references), review-run's phase1 usage line omits [--accept-drift] while its prose lists phase1 --wait. Defects found in packet and auditor-protocol text. NOT MET (claims B4, B7).
- AC-6: rendered every field run with the working tree; ran the ea0b739 build-report (git archive into scratch) against the same fixture with 1.1.0-style hypothesis wording. NOT MET (claim B2).
- AC-7: not assessed beyond reading; no weight claim made. MET (no claim).
- H1: read every deleted and narrowed line of the script diff and the removed test assertions: the `--all` refusal (now accepted, documented in --help), readJsonIfPresent to readJsonOrAbsent (corrupt run files now stop the run instead of reading as absent), scan no longer exempts inline code (stricter), gitListedNames now throws when git cannot run (preflight refuses no-git too), sumUsages' "one missing call makes the sum unknown" (narrowed to a lower bound), the FIX NOW "+N more" cap removed, the 1.1.0 hypothesis wording; tests changed with them say the new behaviour. The hypothesis-polarity change breaks old runs. PARTLY CONFIRMED (claim B2).
- H2: checked SEAT_CHOICE_RE only by reading (no fixture); phase-level --accept-drift re-checks every later step (assertFingerprint compares against Phase 1 each time, review-run.mjs:325-356), "pre-existing" without a diff is shown as a caveat on the northwind and site runs, the non-outcome-word caveat skips links; the lower-bound usage never triggers for the Codex case it was made for. PARTLY CONFIRMED (claim B5).
- H3: the new packet's intro carries the previous run folder path (claim B6); trimmed auditor protocol has 0 vendor tokens but misses two passages it is told to consult (claim B7); same-shape and evidence-location lines carried into recheck hypotheses hold no claim ids (grep of both generated packets). CONFIRMED.
- H4: ran build-report on all 5 field runs and build-recheck-packet on 4 (CRLF/BOM handled, the quoted Windows absolute path in the app-client since.diff header parsed to vsiclient/collectors/Contoso.py (+38 -7)); whereInChange mis-tags snapshot-prefixed evidence paths. CONFIRMED (claim B1).
- H5: every field run renders with the finding count and blocker count in its findings.json/report.md; an old 1.1.0-wording packet renders hypothesis outcomes inverted. CONFIRMED (claim B2).
- H6: static sweep only (see AC-4 line); runCapture settles once (settled flag) on close, error or timeout; no spawn without windowsHide on a Windows path in the skill scripts. REFUTED (not executed with a hung probe).
- H7: flag drift found only as gaps in references for --since-only/--round/--review-rules-only (present in --help) and the phase1 usage line; docs for --rules, --change-diff, --since-dirs, --notes, --repo-target and phase-level --accept-drift match the code. PARTLY CONFIRMED (minor, folded into the AC-5 line; no separate claim).
- H8: audit-depth stop is executed by review-run.test.mjs:814-830 (gated, light, high_conceded 0, old record); REVIEW_PROBE_TIMEOUT_MS is exercised only in dispatch-integration.test.mjs:143 (cross-review only); the REVIEW.md 8 KB cap (preflight.mjs:1588) and merge-base read read only, not executed. PARTLY CONFIRMED (no bypass shown; failure-branch coverage of the cap not checked).
- Tests: did not run node --test (relied on the author-reported pass); every command above ran against shipped scripts with field runs copied to a scratch folder outside the target.
- Coverage: script diff (blind-relabel, build-brief, build-manifest, build-recheck-packet, build-report, claude/codex-dispatch, detach-utils, exchange start) read fully; preflight.mjs, review-run.mjs, worktree-utils.mjs, path-utils.mjs, rollout-utils.mjs, spawn-utils.mjs read partly; tests read partly (removed assertions only); references read partly; SKILL.md read partly; README, bench/, scripts/validate-repository.mjs, release-check.mjs, install-check.mjs and plugin manifests not read.

web: 0 queries, 0 page fetches
Blocked: none
