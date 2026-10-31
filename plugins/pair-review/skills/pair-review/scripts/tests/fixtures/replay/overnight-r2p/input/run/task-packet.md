# Task packet: self-review of the two review skills (Windows host), round 2 of an overnight fix loop
Review round: 2

Profile: Code + Document (Node.js scripts, tests and markdown protocol files). Target: @@TARGET@@, branch main, HEAD ea0b739, working tree DIRTY: every change since ea0b739 is uncommitted and is the subject of this review.
Read-only review: do not edit, create or delete any file in the target; do not commit.
Still branch main at HEAD ea0b739, working tree dirty; the round-1 fixes below are uncommitted too.

This is a re-review of the previous review. Those findings are listed below as hypotheses only. Confirm or refute each from the code as it is now; do not assume a fix works because a change touched the line.

## Scope
- In scope: `plugins/pair-review/skills/pair-review/` and `plugins/cross-review/skills/cross-review/` (SKILL.md, references/, scripts/, scripts/tests/), the plugin manifests, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `scripts/validate-repository.mjs`, `scripts/release-check.mjs`, `scripts/install-check.mjs`, `bench/outcomes.mjs`, `bench/case-from-run.mjs` and their tests in `bench/tests/`, `README.md`. The shared scripts are byte-identical in both skills (validate-repository enforces it): review one copy, and name the sibling only for a skill-specific finding (`opencode-dispatch.mjs` and `dispatch-integration.test.mjs` exist only in cross-review).
- Out of scope: `plugins/shared-brain/`, the rest of `bench/`, `docs/design/`, CHANGELOG wording, style, naming, formatting, refactors for taste.
- Host: Windows 11, PowerShell 5.1, Node 24, git for Windows. A claim names the platform fact it depends on (Windows, Linux, macOS) or says it holds everywhere. A Linux- or macOS-only claim stays at most MEDIUM unless the code path is shown executing.
Round 2: the scope is unchanged. Weigh the files changed since round 1 (next section) most, but anything in scope may hold a finding.

## What changed since the previous review
- plugins/cross-review/skills/cross-review/references/review-protocol.md (+7 -7)
- plugins/cross-review/skills/cross-review/scripts/build-manifest.mjs (+13 -1)
- plugins/cross-review/skills/cross-review/scripts/build-recheck-packet.mjs (+15 -6)
- plugins/cross-review/skills/cross-review/scripts/build-report.mjs (+50 -21)
- plugins/cross-review/skills/cross-review/scripts/tests/blind-relabel.test.mjs (+11 -2)
- plugins/cross-review/skills/cross-review/scripts/tests/build-manifest.test.mjs (+35 -2)
- plugins/cross-review/skills/cross-review/scripts/tests/build-recheck-packet.test.mjs (+28 -7)
- plugins/cross-review/skills/cross-review/scripts/tests/build-report.test.mjs (+76 -3)
- plugins/pair-review/skills/pair-review/references/review-protocol.md (+7 -7)
- plugins/pair-review/skills/pair-review/scripts/build-manifest.mjs (+13 -1)
- plugins/pair-review/skills/pair-review/scripts/build-recheck-packet.mjs (+15 -6)
- plugins/pair-review/skills/pair-review/scripts/build-report.mjs (+50 -21)
- plugins/pair-review/skills/pair-review/scripts/tests/blind-relabel.test.mjs (+11 -2)
- plugins/pair-review/skills/pair-review/scripts/tests/build-manifest.test.mjs (+35 -2)
- plugins/pair-review/skills/pair-review/scripts/tests/build-recheck-packet.test.mjs (+28 -7)
- plugins/pair-review/skills/pair-review/scripts/tests/build-report.test.mjs (+76 -3)
Every change answers a round-1 finding (H1-H8 below) or a finding of an independent review of those fixes (R1-R6). The two skills' copies are byte-identical.
- build-recheck-packet: the intro says "the previous review", and the run path goes to previous-run.json next to the packet (H1). It warns when a previous-run.json with other contents is kept (R6). "All N previous finding(s) were settled" replaces "no findings", and decided lines name their round (H7).
- build-report: answers to a hypothesis worded "Confirm it is fixed" are flipped, but only when the packet does not define CONFIRMED (H2, R5). A finding marked "wrong" in the notes leaves the blockers, the severity counts and the criterion, hypothesis and ticket lines, with a caveat (H3, R4). A file name that only one diff file in a folder has now matches; a name-only match is tagged "matched by file name" and is weaker than a path match (H5, R1). "Pre-existing" on lines the change added (by path) stays in Fix now, with a caveat (H6); a name-only match does not overrule the notes (R1).
- build-manifest mergedUsage: calls that reported no usage are left out before the merge rule is chosen, and the result is a lower bound with calls_without_usage (H4, R2, R3).
- review-protocol.md: 4 pointers to sections the auditor's copy lacks were reworded (H8); a test checks every "see/per <heading or bold label>".
- Tests: one or more per change; mutation check: each fix reverted, 26 of 26 tests went red.

## Acceptance criteria (tag each one so claims can cite it)
- [AC-1] Never clean when it is not: every step that cannot do its job exits non-zero with a message naming the file or flag; no step exits 0 with a missing, empty or stale output; no `--wait` reports done while a seat wrote nothing; no warning is silenced for a case it exists for.
- [AC-2] Blinding holds both ways: no seat or auditor can read, or is told, the peer's identity, files or labels, or a vendor or model name, before the protocol allows it; the identity scan does not block on text derived from the target or the run's own folders.
- [AC-3] Numbers reconcile: every count a script prints (findings, blockers, groups, tokens, calls, rounds, times) equals an independent count from the files it came from.
- [AC-4] Recoverable, repeatable and clean: after any refused or interrupted step the run folder can be resumed or cleanly refused; nothing half-written; no child process survives a finished, failed, timed-out or stopped step; no console window opens per child on Windows; an unrelated process is never signalled.
- [AC-5] Docs match scripts: every command, flag, default, exit code, file name and message in SKILL.md, references/, README, the task-packet template and each script's --help holds as written.
- [AC-6] Old runs still work: a run folder, manifest, notes file or packet written before these changes renders, rechecks and validates as before, except where a change says otherwise.
- [AC-7] Weight: code, flags, files or doc paragraphs that can be removed with no loss. At most 3 claims per seat.

## Known deviations from the criteria
Everything changed since ea0b739 is in scope; a regression or an incomplete fix in any of it is exactly what this round is for. The changes, by area (details: `git diff ea0b739 -- plugins/pair-review`; the cross-review copies are the same):
- Report (build-report): hypothesis polarity (CONFIRMED is the red line in chat, text and HTML); Trigger and Same-shape lines; Where-in-the-change tags from `--change-diff` / `<run-dir>/since.diff` (diffHunks, whereInChange); outcome words in report-notes `## Finding status` (outcomeOf; wrong to Withdrawn, a blocker needs a reason; intentional/not-worth-it/decided to Can wait; "pre-existing" groups only with a change diff); caveats for a non-outcome "word:", drift by step, REVIEW.md changed or read at the branch tip, a lower-bound cost row; Review round header and step-back caveat; Time line; banner naming the group a notes-moved blocker went to; Decide row.
- Findings (blind-relabel): `Trigger:` and `Same shape elsewhere:` parsed (extractClaimBlocks) into findings.json `trigger` / `same_shape` (deriveFromOrigins); validate warns for HIGH/CRITICAL without Trigger; audit-prep stages only the auditor's protocol sections (auditorProtocol).
- Sequencer (review-run): validate warnings shown; audit --prepare stops after a conceded HIGH with no `--audit-depth`; `--accept-drift` also at phase1 --wait and phase2; `--rules` passed to the phase1 and auditor briefs; `--run-dir` passed to the phase1 brief; the blind-seat warning (SEAT_BLIND_RE, SEAT_BLIND_HARD_RE, SEAT_CHOICE_RE); windowsHide on every child.
- Briefs (build-brief): `--rules` section; the packet-vs-run-folder check now also in phase1 mode (assertPacketOutsideRunDir).
- Preflight: REVIEW.md (readReviewRules: merge-base copy, `--review-rules head|worktree`, `--review-rules-only`, 8 KB cap, changed/used/baseUnknown, peerLabelLines warning); reach-probe summary and `reachProbe` in the JSON result.
- Re-review packets (build-recheck-packet): Review round line (chainRound, `--round`); outcome words from `--notes` or `<old run>/phase3/report-notes.md`; `since.diff` written next to `--out`; `--since-dirs` repeatable with `--ignore-cr-at-eol` and folder prefixes; `--since-only` (filterDiff).
- Manifest (build-manifest): review_rules record and hash; usage sums with `calls_without_usage` (lower bound).
- Dispatchers: runCapture time limit with a process-tree kill (codex-dispatch, opencode-dispatch; `REVIEW_PROBE_TIMEOUT_MS`); spawnCli and taskkill hide their windows.
- Config: seats `flags.repoOnly` always written.
- Tests: fixtures `scripts/tests/fixtures/blind-relabel/target*/references/target.md` (moved from SKILL.md so Codex does not load them as skills).
- Accepted as known or by design: output tokens of native Claude agents are unknown (their transcript does not record them); the round count follows one chain of re-reviews (a printed note says to pass `--round`); a REVIEW.md only the branch added is named and not used; Codex text in result.json is UTF-8 (PowerShell 5.1 shows it as "â€™").
- Known flaky under load, not a finding by itself: the detach tests "five consecutive workers" and "--detach returns at once", and claude-dispatch "an isolated seat writing the real target by absolute path"; a failure that also happens alone is a finding.
All still apply. New: a finding marked "wrong" now leaves every count and list (it was counted before); the flip of "Confirm it is fixed" answers applies only to packets that do not define CONFIRMED (1.1.0 packets).

## Start here
1. `git diff ea0b739 -- plugins/pair-review` and `git status --short bench scripts`: read every hunk; the hypotheses below aim at it.
2. The run lifecycle: review-config seats -> preflight -> review-run (phase1, phase2, audit) -> build-manifest -> build-report; then build-recheck-packet for the next round.
3. Trust boundaries: build-brief, blind-relabel (scan, audit-prep, translate), exchange, run-descriptor, spawn-utils, detach-utils, codex-dispatch.
This is a start, not a limit. For this round, also read the diff in `C:/Users/dev/cross-review-runs/overnight-r2/evidence/since.diff` (round 1 to round 2).

## Evidence both seats may cite
Pre-flight `C:/Users/dev/cross-review-runs/overnight-r2/evidence/preflight.json`: HEAD ea0b739, snapshotHash 02027a33423e81c5b5b1de52621c19c0c890a535d515c8f0193a5f095f815e22, 102 changed files (6 untracked). The changes since round 1: `C:/Users/dev/cross-review-runs/overnight-r2/evidence/since.diff`. Run tests yourself in a disposable copy.

## Author-reported evidence (not reproducible; do not cite as EXECUTED)
The installer ran the tests for the changed files: 611 tests, 610 pass, 0 fail, 1 skipped. A full run of both suites was stopped by the host for low memory before it finished (no failure seen). Mutation check: 26 of 26 reverted fixes turned their test red.

## Hypotheses to test
In `## Checks performed`, end each hypothesis line with CONFIRMED (the previous defect is still there), REFUTED (it is gone) or PARTLY CONFIRMED; the report prints that outcome.
- [H1] Previous finding F1 (high, settled-agree) is still present: Every re-review packet now carries the absolute path of the previous run folder, whose manifest maps seat letters to vendor and model, and it reaches seats and the auditor unflagged. It was at p.md:8. Also check the same shape at: build-recheck-packet.mjs:484 stdout note names since.diff in the new run folder but tells the author not to cite it (not a leak); none other found (searched every `run` path written into the packet text: the `pairs` rewrite maps the old run folder to the new one, so only the marker line keeps it).
- [H2] Previous finding F2 (high, settled-agree) is still present: Re-rendering a run whose packet used the 1.1.0 positive 'Confirm it is fixed' wording now inverts hypothesis polarity, showing an unfixed defect as a green all-clear. It was at build-report.mjs:906. Also check the same shape at: build-report.mjs:906-907 and :916 (renderText summary and row colour), :1049 (HTML chip colour: 'confirmed' now 'high'), :1208-1210 (chat). build-recheck-packet.mjs notesOutcomes is independent of polarity (not affected).
- [H3] Previous finding F3 (medium, settled-agree) is still present: Findings the author withdraws with a 'wrong' note move to the Withdrawn row but are still counted under their severity, in the blocker count and in the SEVERITY lines. It was at build-report.mjs:671. Also check the same shape at: build-report.mjs:782 (blocker count), :1154 (SEVERITY lines), renderMarkdown/renderHtml headers (same report.counts). Searched every WITHDRAWN_STATES and counts.* use.
- [H4] Previous finding F4 (medium, settled-agree) is still present: The new lower-bound usage sum never applies to a Codex seat whose last call reported no usage, so the whole seat cost shows as unknown in exactly the rate-limited case the change targeted. It was at build-manifest.mjs:417. Also check the same shape at: build-manifest.mjs:419-424 (legacy cumulative branch: finals.set keeps the last result of a thread even when it is the failed one, so a summed-per-thread total also loses that thread). Searched every return in mergedUsage and every sumUsages caller.
- [H5] Previous finding F5 (medium, settled-agree) is still present: The Where tag reports 'outside the change' for evidence cited through a snapshot or review-copy prefix, even on lines the change added. It was at REVIEW/head/Reporter.py:1263. Also check the same shape at: build-report.mjs:627-628 (a bare name that two diff files share gives 'outside the change' instead of 'unknown'); build-recheck-packet.mjs evidenceLocation (first location only, no matching, not affected). Searched every whereInChange/evidenceLocations caller.
- [H6] Previous finding F6 (medium, settled-agree) is still present: An author's 'pre-existing' note silently moves a finding out of Fix now even when the report's own Where tag says its evidence is on added lines. It was at Reporter.py:60.
- [H7] Previous finding F7 (medium, settled-agree) is still present: A re-review packet says the previous review had no findings when all were settled in the notes, and decided lines from different rounds reuse the same bare finding id. It was at build-recheck-packet.mjs:250. Also check the same shape at: findingHypothesis ("Previous finding F3 ...") names bare ids too, but only of the immediately previous round; none other found (searched every "Previous finding" template in build-recheck-packet.mjs).
- [H8] Previous finding F8 (low, settled-agree) is still present: The trimmed protocol staged for the auditor drops two passages that its own auditor instructions tell it to consult. It was at references/review-protocol.md:864.

## Checks
- Run tests only in a disposable copy outside the target, with TMPDIR/TEMP pointed at your own output folder.
- Evidence rules: execute before you claim (a HIGH needs the input, command and output); prove reachability from a supported route; sweep the class and list every site; check what a removed or narrowed line used to reject; for a process claim show the process list before and after.
- Coverage line in `## Checks performed`: read fully / read partly / not read.
- Proposals: the smallest change that closes the defect, lines named; no new flag, mode, file or dependency unless the defect needs it; no style claims.
The machine has about 2 GB of free memory: run single test files (`node --test scripts/tests/<name>.test.mjs`), not the whole suite at once.

## Severity note
Default rubric: a review that reports clean when it is not, a blinding leak, a lost or corrupted run, worktree or target file, a surviving child process, a console window per child, or a kill of an unrelated process is HIGH. A wrong number in a report a reader acts on is HIGH. A crash with a clear error and no data loss is MEDIUM. A portability problem that blocks a normal user on a common setup is MEDIUM. An AC-7 weight claim is LOW. Every HIGH and CRITICAL claim states its Trigger (what input or state makes it happen, and how often a real run meets it). The reader is the maintainer deciding what to fix before the next release.

## Output
Findings in the required schema in your own findings file. A `## Checks performed` section: one line per AC and per H tag, ending in MET / PARTIAL / NOT MET or CONFIRMED / REFUTED / PARTLY CONFIRMED, plus the Coverage line.
Web verification is off (repo-only review). Close with one line: `web: 0 queries, 0 page fetches`.
