# Task packet: self-review of the two review skills (Windows host), round 3 of an overnight fix loop
Review round: 3

Profile: Code + Document (Node.js scripts, tests and markdown protocol files). Target: @@TARGET@@, branch main, HEAD ea0b739, working tree DIRTY: every change since ea0b739 is uncommitted and is the subject of this review.
Read-only review: do not edit, create or delete any file in the target; do not commit.
Still branch main at HEAD ea0b739, working tree dirty; the round-1 and round-2 fixes are uncommitted too.

This is a re-review of the previous review. Those findings are listed below as hypotheses only. Confirm or refute each from the code as it is now; do not assume a fix works because a change touched the line.

## Scope
- In scope: `plugins/pair-review/skills/pair-review/` and `plugins/cross-review/skills/cross-review/` (SKILL.md, references/, scripts/, scripts/tests/), the plugin manifests, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `scripts/validate-repository.mjs`, `scripts/release-check.mjs`, `scripts/install-check.mjs`, `bench/outcomes.mjs`, `bench/case-from-run.mjs` and their tests in `bench/tests/`, `README.md`. The shared scripts are byte-identical in both skills (validate-repository enforces it): review one copy, and name the sibling only for a skill-specific finding (`opencode-dispatch.mjs` and `dispatch-integration.test.mjs` exist only in cross-review).
- Out of scope: `plugins/shared-brain/`, the rest of `bench/`, `docs/design/`, CHANGELOG wording, style, naming, formatting, refactors for taste.
- Host: Windows 11, PowerShell 5.1, Node 24, git for Windows. A claim names the platform fact it depends on (Windows, Linux, macOS) or says it holds everywhere. A Linux- or macOS-only claim stays at most MEDIUM unless the code path is shown executing.
Round 3: the scope is unchanged. Weigh the files changed since round 2 (next section) most, but anything in scope may hold a finding.

## What changed since the previous review
- plugins/cross-review/skills/cross-review/SKILL.md (+1 -1)
- plugins/cross-review/skills/cross-review/references/review-protocol.md (+1 -1)
- plugins/cross-review/skills/cross-review/scripts/build-recheck-packet.mjs (+2 -0)
- plugins/cross-review/skills/cross-review/scripts/build-report.mjs (+30 -24)
- plugins/cross-review/skills/cross-review/scripts/tests/blind-relabel.test.mjs (+5 -0)
- plugins/cross-review/skills/cross-review/scripts/tests/build-recheck-packet.test.mjs (+1 -0)
- plugins/cross-review/skills/cross-review/scripts/tests/build-report.test.mjs (+33 -4)
- plugins/pair-review/skills/pair-review/SKILL.md (+1 -1)
- plugins/pair-review/skills/pair-review/references/review-protocol.md (+1 -1)
- plugins/pair-review/skills/pair-review/scripts/build-recheck-packet.mjs (+2 -0)
- plugins/pair-review/skills/pair-review/scripts/build-report.mjs (+30 -24)
- plugins/pair-review/skills/pair-review/scripts/tests/blind-relabel.test.mjs (+5 -0)
- plugins/pair-review/skills/pair-review/scripts/tests/build-recheck-packet.test.mjs (+1 -0)
- plugins/pair-review/skills/pair-review/scripts/tests/build-report.test.mjs (+33 -4)
Every change answers a round-2 finding (H1-H5 below). The two skills' copies are byte-identical, except SKILL.md (one sentence added to each).
- build-report whereInChange: any match made by file name alone (a bare name, or a path under a snapshot folder) is marked byName. When several changed files share the name, the tag they all agree on is used; if they differ, the tag is "unknown" (ranked above "outside the change"). "Outside the change" now means no changed file has the name (H1, H2).
- build-report: a byName match never moves a finding out of a group. A pre-existing note on a finding whose name-only match points at added lines gets a caveat asking to check it (H1, H2).
- build-report: the "Confirm it is fixed" flip is decided from the run's phase1/brief-A.txt (does it define CONFIRMED?); the packet is used only when the run has no brief (H3).
- review-protocol.md: "(see the skill's own Invocation section)" removed; the pointer test now also catches "see ... section" phrases (H4).
- build-recheck-packet --help and both SKILL.md name previous-run.json (H5).
- Tests: one or more per change; mutation check: 31 of 31 reverted fixes turned a test red.

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
All still apply. By design: a finding marked "wrong" leaves every count and list; the flip of "Confirm it is fixed" answers applies only to runs whose seat brief does not define CONFIRMED (1.1.0 runs); a file-name-only Where match never regroups a finding.

## Start here
1. `git diff ea0b739 -- plugins/pair-review` and `git status --short bench scripts`: read every hunk; the hypotheses below aim at it.
2. The run lifecycle: review-config seats -> preflight -> review-run (phase1, phase2, audit) -> build-manifest -> build-report; then build-recheck-packet for the next round.
3. Trust boundaries: build-brief, blind-relabel (scan, audit-prep, translate), exchange, run-descriptor, spawn-utils, detach-utils, codex-dispatch.
This is a start, not a limit. For this round, also read the diff in `C:/Users/dev/cross-review-runs/overnight-r3/evidence/since.diff` (round 2 to round 3).

## Evidence both seats may cite
Pre-flight `C:/Users/dev/cross-review-runs/overnight-r3/evidence/preflight.json`: HEAD ea0b739, snapshotHash b7c80e849b67b5387693f51758817b1db7b8653e8843663229ae0efbd8bf8c20, 102 changed files (6 untracked). The changes since round 2: `C:/Users/dev/cross-review-runs/overnight-r3/evidence/since.diff`. Run tests yourself in a disposable copy.

## Author-reported evidence (not reproducible; do not cite as EXECUTED)
The installer ran the tests for the changed files: 625 tests, 624 pass, 0 fail, 1 skipped. Mutation check: 31 of 31 reverted fixes turned their test red. A full run of both suites has not finished this night (the host stopped it for low memory).

## Hypotheses to test
In `## Checks performed`, end each hypothesis line with CONFIRMED (the previous defect is still there), REFUTED (it is gone) or PARTLY CONFIRMED; the report prints that outcome.
- [H1] Previous finding F1 (medium, settled-agree) is still present: When a cited file name (bare or under a snapshot prefix) matches two or more same-named files in the change diff, the Where tag says 'outside the change' instead of 'unknown' or the agreed tag, and a 'pre-existing' note then moves a blocker on added lines out of Fix now without a caveat. It was at build-report.mjs:11. Also check the same shape at: build-report.mjs:635 (byName, snapshot prefix with two same-named files) and :636 (plainName, bare name); build-report.mjs:802 and :1149 consume the result. build-recheck-packet.mjs evidenceLocation does not match diffs (not affected). Both skills' copies identical: plugins/pair-review/skills/pai...
- [H2] Previous finding F2 (medium, settled-agree) is still present: A bare file name that matches exactly one changed file is treated as a full path match: it is not labelled 'matched by file name' and it overrides the author's 'pre-existing' note, while the folder-qualified spelling of the same guess does not. It was at build-report.mjs:636. Also check the same shape at: build-report.mjs:802 and :1149 (both read where.byName); build-recheck-packet.mjs evidenceLocation does no matching, not affected.
- [H3] Previous finding F3 (medium, settled-agree) is still present: The 'Confirm it is fixed' polarity flip is keyed on the packet text, not on the brief the seats received, so a current-run seat's defect-side CONFIRMED on a packet without the definition sentence is shown as a green REFUTED with a misleading caveat. It was at build-report.mjs:700.
- [H4] Previous finding F4 (low, settled-agree) is still present: The auditor's staged protocol still points to the skill's Invocation section, which the auditor does not receive, and the new pointer test cannot detect pointers to SKILL.md sections.
- [H5] Previous finding F5 (low, settled-agree) is still present: build-recheck-packet writes previous-run.json that nothing reads and no doc mentions; the stdout line already carries the same information. It was at build-recheck-packet.mjs:481. Also check the same shape at: build-recheck-packet.mjs:489-494 (since.diff beside --out is documented in --help and in the stdout note).

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
