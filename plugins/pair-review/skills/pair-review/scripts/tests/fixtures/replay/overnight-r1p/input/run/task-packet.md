# Task packet: self-review of the two review skills (Windows host), round 1 of an overnight fix loop

Profile: Code + Document (Node.js scripts, tests and markdown protocol files). Target: @@TARGET@@, branch main, HEAD ea0b739, working tree DIRTY: every change since ea0b739 is uncommitted and is the subject of this review.
Read-only review: do not edit, create or delete any file in the target; do not commit.

## Scope
- In scope: `plugins/pair-review/skills/pair-review/` and `plugins/cross-review/skills/cross-review/` (SKILL.md, references/, scripts/, scripts/tests/), the plugin manifests, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `scripts/validate-repository.mjs`, `scripts/release-check.mjs`, `scripts/install-check.mjs`, `bench/outcomes.mjs`, `bench/case-from-run.mjs` and their tests in `bench/tests/`, `README.md`. The shared scripts are byte-identical in both skills (validate-repository enforces it): review one copy, and name the sibling only for a skill-specific finding (`opencode-dispatch.mjs` and `dispatch-integration.test.mjs` exist only in cross-review).
- Out of scope: `plugins/shared-brain/`, the rest of `bench/`, `docs/design/`, CHANGELOG wording, style, naming, formatting, refactors for taste.
- Host: Windows 11, PowerShell 5.1, Node 24, git for Windows. A claim names the platform fact it depends on (Windows, Linux, macOS) or says it holds everywhere. A Linux- or macOS-only claim stays at most MEDIUM unless the code path is shown executing.

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

## Start here
1. `git diff ea0b739 -- plugins/pair-review` and `git status --short bench scripts`: read every hunk; the hypotheses below aim at it.
2. The run lifecycle: review-config seats -> preflight -> review-run (phase1, phase2, audit) -> build-manifest -> build-report; then build-recheck-packet for the next round.
3. Trust boundaries: build-brief, blind-relabel (scan, audit-prep, translate), exchange, run-descriptor, spawn-utils, detach-utils, codex-dispatch.
This is a start, not a limit.

## Evidence both seats may cite
- Pre-flight (this host, working tree as reviewed): `C:\Users\dev\cross-review-runs\overnight-r1\evidence\preflight.json` (compact), logs next to it in `preflight.json.logs`. Tier 2 commands and results are in that file; cite them from it.
- Five real field runs from 2026-10-16, extracted under `C:\Users\dev\cross-review-runs\overnight-r1\evidence\field-runs\` (each has a `run\` folder): `app-client-pr6064-2026-10-16-r3` (pair-review re-review), `contoso-2026-10-16-r3` (cross-review round 4 with notes and a since-diff), `contoso-replay-r2-2026-10-16` (cross-review, full audit), `site-cross-review-2026-10-16` (whole-repo review, no change diff), `northwind-1a-cross-review-2026-10-16-1` (two repositories, REVIEW.md, accepted drift, a rate-limited extra call). Use them as INPUT to the shipped scripts (for example `build-report.mjs --run-dir <field run>\run --format chat --all`, `build-recheck-packet.mjs --from-run <field run>\run --out <your own scratch folder>\p.md`, `build-manifest.mjs`) and cite the script output. Never copy text from their seat files: cite a seat file only by path and line, and never write a claim heading or an A/B/X/Y/P claim id from them in your prose or in a fence. A read-only seat runs only commands that print to stdout; write nothing in those folders.
- Author-reported (run by the orchestrator on this tree, never cite as EXECUTED): pair-review and cross-review `node --test` pass in thirds; both validate-package pass; a mutation script (92+ mutants, each reverts one fix) goes red for every mutant; the installed copies match the tree.

## Hypotheses to test
For each, sweep every script in scope (grep first, then read the hits) and report one line in Checks performed.
- [H1] Fix-pass regressions: a change since ea0b739 breaks a case the old code handled, or a test was changed to fit behaviour that is wrong. Read the deleted and narrowed lines first and say what each used to reject or allow.
- [H2] False-alarm fixes that hide a real signal: an exclusion or a relaxed check (SEAT_CHOICE_RE, phase-level `--accept-drift`, "pre-existing" without a change diff, the non-outcome-word caveat, the reach-probe summary, the lower-bound usage) that now lets a real problem through silently.
- [H3] New text reaching seats or the auditor: the REVIEW.md rules section, Trigger and Same-shape lines, the Review round line, the decided lines, `since.diff`, the trimmed auditor protocol; check each for claim ids, seat letters, vendor or model names, or the run folder, and check that the auditor's copy still holds every section the auditor brief tells it to consult.
- [H4] Real-shape parsing: the field runs' real files (CRLF, BOM, fences, quoted git names, plain `diff -u`, binary diffs, empty or missing optional lines, notes written by hand) break a parser or a count. Run the scripts on the field runs and reconcile what they print with the files.
- [H5] Old-run compatibility (AC-6): each field run renders with the same finding count and blockers it had, and an older run folder without the new files (no since.diff, no review-rules.md, no step in drift records, notes without outcome words) behaves as before.
- [H6] Process lifecycle and windows (AC-4): a child left alive after any exit path (success, error, timeout, refused, Ctrl-C, a hung probe), a spawn without windowsHide, a kill that reaches an unrelated process, a promise that never settles.
- [H7] Drift: a flag, file name, default, exit code or message in SKILL.md, references/, README, the template, a --help text, a test or the other skill no longer matches the code, including every new flag (`--review-rules`, `--review-rules-only`, `--rules`, `--since-only`, repeatable `--since-dirs`, `--round`, `--notes`, `--change-diff`, phase-level `--accept-drift`).
- [H8] Guards that do not guard: a check whose failure branch no test executes, or that a plausible input bypasses (for example the audit-depth stop, the phase1 run-folder check, the REVIEW.md cap and merge-base read, the probe time limit).

## Checks
- Run tests only in a disposable copy outside the target, with TMPDIR/TEMP pointed at your own output folder.
- Evidence rules: execute before you claim (a HIGH needs the input, command and output); prove reachability from a supported route; sweep the class and list every site; check what a removed or narrowed line used to reject; for a process claim show the process list before and after.
- Coverage line in `## Checks performed`: read fully / read partly / not read.
- Proposals: the smallest change that closes the defect, lines named; no new flag, mode, file or dependency unless the defect needs it; no style claims.

## Severity note
Default rubric: a review that reports clean when it is not, a blinding leak, a lost or corrupted run, worktree or target file, a surviving child process, a console window per child, or a kill of an unrelated process is HIGH. A wrong number in a report a reader acts on is HIGH. A crash with a clear error and no data loss is MEDIUM. A portability problem that blocks a normal user on a common setup is MEDIUM. An AC-7 weight claim is LOW. Every HIGH and CRITICAL claim states its Trigger (what input or state makes it happen, and how often a real run meets it). The reader is the maintainer deciding what to fix before the next release.

## Output
Findings in the required schema in your own findings file. A `## Checks performed` section: one line per AC and per H tag, ending in MET / PARTIAL / NOT MET or CONFIRMED / REFUTED / PARTLY CONFIRMED, plus the Coverage line.
Web verification is off (repo-only review). Close with one line: `web: 0 queries, 0 page fetches`.
