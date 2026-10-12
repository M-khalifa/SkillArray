# Implementation plan: portable cross-review and pair-review (1.1.0)

Status: draft 2, 2026-10-04. Draft 1 was reviewed by a cross-review (two reviewers, one
exchange, a fresh auditor: 31 findings, 4 of them settled-refuted or polish); this draft
folds the findings in. It implements `docs/design/portable-cross-review.md` (Revision 2).
Baseline: commit `30fd93a` (SkillArray 1.0.0).

This plan is the contract for the implementers (Codex per milestone, a Sonnet subagent as
fallback). Where the design and this plan differ, this plan wins and section 3 says why.

## 1. Goal and acceptance

Both skills, `cross-review` and `pair-review`, run a complete validated review from Claude
Code and from Codex, with the same snapshot, gates, scorecard and manifest. The Claude Code
path keeps its native agents and behaves as in 1.0.0 when no new flag is used.

Done means all of these, each shown by a command and its output:

1. `node scripts/validate-repository.mjs` exits 0 from the repository root.
2. In each skill folder `node scripts/validate-package.mjs` exits 0 and `node --test`
   passes with no failure. Baseline: cross-review 544, pair-review 390. Tests only grow.
3. `node scripts/compare-baseline.mjs --base 30fd93a` exits 0 (section 6, task 1): the
   briefs rebuild byte for byte and every rule sentence of the 1.0.0 skill docs is found
   in the new docs or on the written drop list.
4. Every live matrix cell (section 8) either completes with its gates passing, or is named
   unsupported with the reason in the 1.1.0 release notes. "Not run" is not allowed.
5. A final cross-review in Code profile, `double check all claims`, leaves no open HIGH or
   CRITICAL finding.
6. Clean installs pass (section 7, task 5) and both skill folders are byte-identical between
   the Claude Code install and the Codex install (hash lists equal).

## 2. Evidence (milestone 0, observed 2026-10-04)

Environment: Windows 11, Claude Code 2.1.289, Codex CLI 0.160.0. Probes used `codex exec`
with `gpt-5.6-luna` from a scratch folder. Raw output is kept with the review run
(`portable-1.1.0/review-3-plan/run-evidence/m0-evidence/`, four `.jsonl` files).

| Question | Observation |
|---|---|
| Claude lean flags exist | `claude -p --help` lists `--restricted`, `--setting-sources`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools`, `--add-dir`, `--allowedTools`, `--permission-mode`, `--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`, `--effort`, `--resume`, `--output-format`, `--model`, `--bare`. |
| Codex reads project-level skills | A skill at `<cwd>/.agents/skills/probe-skill/SKILL.md` appeared in the Codex skill list, labelled project. User-level `~/.agents/skills` skills appeared as user; plugin skills as system. |
| `~/.agents/skills` today | It already holds OLD `cross-review` and `pair-review` copies (an earlier Codex-era skill). They are backed up in `portable-1.1.0/backup-1.0.0-before-portable/installed-agents/`. The final install replaces them. |
| Native sub-agent tools under `codex exec` | The model reported none exposed. The names of the Codex agent tools are therefore NOT observed. |
| Codex shell environment | `CODEX_CI`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_VERSION`, `CODEX_SANDBOX_NETWORK_DISABLED` are set. Started from a Claude Code session, Codex also inherits `CLAUDECODE` and `CLAUDE_CODE_*`. Environment markers cross host boundaries in both directions. |
| Orchestrator rollout path | Observed on a non-ephemeral run: `CODEX_THREAD_ID=01a10928-9412-77e0-a87b-9cd3006a65c0` and the file `~/.codex/sessions/2026/10/04/rollout-2026-10-04T18-03-37-01a10928-9412-77e0-a87b-9cd3006a65c0.jsonl`. The thread id is the id in the file name. `--ephemeral` runs write no rollout; Codex-host matrix cells never use it. |
| Inherited key | `ANTHROPIC_API_KEY` is set in this machine's shell (length 108) and is invalid. A child that inherits it fails with `401 API key is invalid`. |
| `claude -p` inside the Codex `workspace-write` sandbox | Launches, reaches the network, and with the key and every `CLAUDE*` variable removed (checked: none remained) returns a result (`OK`, 0.083 USD, 41,378 cache-creation tokens at default flags). **The session is not persisted: three probe session ids were searched for under every `C:\Users\*\.claude\projects` and `~/.claude` and none exists.** A resumed seat and the session-file working time therefore cannot work from inside that sandbox. |
| Real lean claude -p seat from Claude Code (2026-10-05, haiku, the design's flag set) | Works. init reported model claude-haiku-4-5-20251001 and exactly the six requested tools; output file written through Edit(//c/...); 0 denials; cost 0.011 USD; startup cost 2.7k cache-creation tokens (default flags: 41k). --resume <session id> with the full flag set and a new stdin brief continued the same session (102k cache-read tokens). The session file persisted at ~/.claude/projects/<cwd slug>/<session id>.jsonl (<cwd slug> is the seat's cwd with separators turned into -). File tools are restricted: a Read outside the granted folders was refused (--restricted). **The shell is not restricted: the seat's Bash wrote to a file in the target.** Worktree isolation and the before-and-after target check are therefore required, not optional. Raw captures: portable-1.1.0/evidence/lean-claude/. |
| Codex-host route trials (L0, 2026-10-05) | `claude-dispatch.mjs` run through `codex exec` in `workspace-write` with no allow rule: 2 of 2 failed (`ECONNREFUSED` after 192 s; an immediate error), no session persisted; the sandbox disables the network. With a user-added allow rule `["node", "<abs path>\claude-dispatch.mjs"]`: 1 of 4 attempts completed (short dispatch, session persisted); a 47 s resume was killed when the Codex turn ended; `--detach` failed (WMI access denied); a 30-minute-timeout resume failed with `ECONNREFUSED`. A bare `claude -p` run left no session file in 3 trials. Conclusion: no reliable route, so cells C5 and C6 are unsupported in 1.1.0. The trial rule was removed and `~/.codex/rules/default.rules` restored (hash checked). Raw output: `portable-1.1.0/evidence/codex-route/`. |
| Codex approval config | `approval_policy = "on-request"`, `approvals_reviewer = "auto_review"`. `~/.codex/rules/default.rules` holds `prefix_rule(pattern=[...], decision="allow")` entries; the ones seen match an exact argument list, some starting with `node`, some with the Windows PowerShell executable and a single `-Command` string. A general rule for scripts with varying arguments is not shown to be expressible. |

Not observed, and named open items for the live phase (section 8, step L0): the Codex agent
tool names; whether a dispatcher launched through an approved prefix route runs outside the
sandbox and persists the Claude session (and so can resume); the form of a rule that matches
`node <skill>/scripts/claude-dispatch.mjs` with varying arguments; whether a detached
dispatcher survives the end of a Codex tool call; lean flags with `--effort` and the largest
models; cache sharing across seats.

## 3. Changes to the design, and why

1. **Codex-host sandbox is the gating risk.** Because a Claude session started inside the
   Codex sandbox is not persisted, Codex-host cells that resume a Claude seat (C5, C6) work
   only if the dispatcher runs outside the sandbox, which needs a user-approved route
   (design section 14). The skill never requests escalation or bypasses a permission check.
   Step L0 finds the route. If none exists, C5 and C6 are named unsupported in the release
   notes with this evidence, and the Codex host runs only what it can: seat B through
   `codex-dispatch` with the orchestrator on Codex and seat A not available (so a Codex-host
   cross-review is unsupported, and the documents say so). Rejected: pointing
   `CLAUDE_CONFIG_DIR` at a writable folder (it would copy Claude credentials), and a
   skill-chosen `--sandbox danger-full-access`. A user who starts Codex with a wider sandbox
   by their own choice is covered by the same cells.
2. **Host detection** (replaces design section 6), applied in this order: (1) both a Claude
   Code agent tool family and a Codex agent tool family present: ambiguous; (2) a validated
   `--host` value that does not contradict a present tool family wins; (3) a Claude Code
   agent-spawn tool plus `SendMessage`: `claude-code`; (4) the Codex agent tool family:
   `codex` (names unobserved until L0, so until then the Codex host file says "pass
   `--host codex`"); (5) none of these: ambiguous. Inherited environment markers
   (`CODEX_THREAD_ID`, `CLAUDECODE`) are hints that appear in the error text only; they never
   decide. An ambiguous result in a non-interactive run fails with "pass --host", it does not
   ask. `claude-dispatch` removes `CODEX_*` and `CLAUDE*` markers from its children, and
   `codex-dispatch` keeps its existing filtered environment.
3. **Key and variable handling is specified in `env-filter.mjs` terms.** `claude-dispatch`
   takes `--env-mode filtered|inherit` and `--env-passthrough` like `codex-dispatch`.
   Default `filtered` uses a named Claude allowlist (including `CLAUDE_CONFIG_DIR` when set
   by the user for their own login, `HOME`/`USERPROFILE`, `PATH`, `SystemRoot`, proxy and
   certificate variables, as in the existing Codex allowlist). `--use-api-key` adds
   `ANTHROPIC_API_KEY` only; the parent session's `CLAUDECODE` and `CLAUDE_CODE_*` are
   always removed, also in `inherit` mode, where every variable starting `CLAUDE` and `CODEX_`
   is removed. Tests cover both authentication modes and the detached worker's child.
4. **Per-seat private output folders** (design section 8 left this open). A CLI seat writes
   only into `<run-dir>/phase1/seat-<role>/` (Phase 1) and `<run-dir>/phase2/seat-<role>/`
   (Phase 2), each created empty. Its grants are `--add-dir` and `Edit(//.../**)` for that
   folder only. `review-run phase1 --wait` and `phase2 --wait`, after both seats finish,
   copy each seat's file to the canonical path (`phase1/<role>-findings.md`,
   `phase2/<role>-rebuttals-raw.md`) and record both hashes. Phase 2 briefs go on stdin and
   already carry the peer view inline, so a seat never needs to read the run directory.
   Scripts and docs that read the canonical paths do not change. A test asserts that no
   grant of any actor covers a folder holding a peer's file or a mapping file.
5. **Auditor and verifier snapshot.** The protocol says the auditor reads the exact Phase 1
   snapshot. A CLI auditor or verifier gets a fresh worktree rebuilt from the Phase 1
   fingerprint recorded in `run.json` (HEAD, dirty diff, untracked files); a fingerprint
   mismatch refuses the dispatch (the existing drift rule). Both skills' phase-3 docs and
   the protocol wording are made consistent with this in M2. The auditor never reads a
   reviewer's worktree.
6. **Read-only is stated as it is.** For every CLI Claude seat, `readOnly` is
   `{fileTools: "enforced", shell: "prompt-only", cwd: "worktree" | "target"}`. A worktree
   cwd stops relative-path writes from touching the real target; the shell can still read
   peer files and write by absolute path. The report says so, and `touchedFiles` against
   the real target is checked after every seat. Worktree isolation stays the default for a
   git target as defence in depth, with `--no-isolate` as the opt-out recorded as `cwd:
   "target"`.
7. **Isolation on subdirectory and submodule targets.** `worktree-utils.mjs` keeps the
   existing refusal as its default behaviour (the opencode tests stay unchanged). It gains an
   option, used by `claude-dispatch`, that builds the worktree of the repository root and
   sets the seat's cwd to the same relative path. A repository with submodules is refused
   with a message naming `--no-isolate`; there is no silent fallback.
8. **`--detach` and `--wait` code.** `spawn-utils.mjs` has none; it lives in
   `codex-dispatch.mjs`. M1 extracts it into `scripts/detach-utils.mjs` (shared, parity-
   listed, tested) used by both dispatchers.
9. **Usage semantics.** `result.json` gains `usageSemantics`: `cumulative` for a Codex
   thread, `per-call` for a Claude `-p` session. `build-manifest` sums per-call results and
   takes the last of cumulative results; old files without the field are read by `threadId`
   as before. A Claude result carries `sessionId`, and `host`/`transport` are set by the
   dispatcher and by the orchestrator for native seats.
10. **Run descriptor.** `run.json` in the run directory is the "seat table" the design
    mentions. Created by `preflight.mjs --host` (M2). Fields: `skill`, `skillDir`,
    `targetDir`, `host`, `flags` (audit depth, falsification, mode), `fingerprint`, and per
    actor (`seatA`, `seatB`, `auditor`, verifiers): `role`, `provider`, `runtime`, `model`,
    `effort`, `transport`, `sessionId`, `outputDir`, `resultPath`, `worktreePath`. Read by
    dispatchers, `exchange.mjs`, `review-run.mjs` and a cross-session Phase 2 resume.
    Tests: malformed descriptor, missing actor, cross-session resume.
11. **Evidence corrections** (draft 1 overstated two rows). The rollout path row is now
    observed on a non-ephemeral run; the claim that `claude -p` inside Codex "wrote a
    session" was wrong, see section 2.
12. **Bench comparison deferred.** The design's native-versus-CLI token and recall comparison
    (`bench/run-comparison.mjs`) is not part of 1.1.0: the native path stays the Claude Code
    default and nothing here changes that default. Reason: it spends several full reviews of
    quota and only informs a later default change.
13. **Restructure-review lessons that bind this work.** `scripts/validate-repository.mjs`
    holds hand-written lists (`forbidSeatsFiles`, the parity list, the `.git/worktrees`
    sentence check): every new file is added to the right list in the same step that
    creates it. Every shared file is one atomic edit across both skills, checked for parity
    before moving on. Every "compare with baseline" step is a command that exits nonzero on
    a difference.

## 4. Rules for every implementer

- Read this plan, the design, and the files you change. Match neighbouring style. Smallest
  diff that does the task. Node 22, ESM, no new dependency.
- Before editing, list files that carry a BOM or a `\uFEFF` escape with
  `node -e "..."` scanning for bytes `EF BB BF` and the text `uFEFF`, and change any file on
  the list only with a Node script, then check the bytes. (`codex-dispatch.mjs` is one.)
- Never write a regex or template literal through a shell heredoc or `sed`.
- Timeout, kill and detach tests run 5 to 10 times in a loop before they count as green.
- Do not run `git commit`, `git push`, `git add`, tag, or touch `main`. Do not change the
  version except in M3. Do not touch `~/.claude`, `~/.codex`, `~/.agents` or any live
  install. Do not start `claude -p` or `codex exec` in tests (use the fake executables);
  live runs belong to section 8.
- A failing existing test is a regression. Fix the cause. A test changes only when the plan
  names it.
- After each milestone report: files changed, tests added, the exact commands run and their
  last lines.

## 5. Milestone 1: adapters and shared modules

Exit: `node --test` passes in both skill folders with the new tests; `validate-repository.mjs`
exits 0.

1. `scripts/detach-utils.mjs` (shared): extract the detached start, `--wait`, `--wait-retry`
   and the detached worker out of `codex-dispatch.mjs`; `codex-dispatch.mjs` imports it.
   Existing codex tests stay green unchanged. The env-removal test also covers the detached
   worker's child.
2. `scripts/worktree-utils.mjs` (shared): move the isolated-worktree code out of
   `opencode-dispatch.mjs` unchanged in behaviour; add the subdirectory option (section 3,
   item 7) with tests; `opencode-dispatch.mjs` imports it. Existing opencode tests stay green.
3. `scripts/rollout-utils.mjs` (shared): move the Codex rollout parsing out of
   `codex-dispatch.mjs`; add finding the orchestrator rollout from `CODEX_THREAD_ID`
   (file name suffix and `session_meta` first line) and a window rule: usage is the last
   `total_token_usage` at or before the end minus the last at or before the start; the
   `--seat-transcript` output `source` value is `codex-rollout`. Fixtures include a repeated
   `token_count` event.
4. `scripts/claude-dispatch.mjs` (shared): the adapter of design section 7 with section 3
   items 3, 4, 6, 7 and 9. Flags like `codex-dispatch`, plus `--env-mode`,
   `--env-passthrough`, `--use-api-key`, `--no-isolate`. `result.json` contains every key in
   `RESULT_REQUIRED_KEYS` of `codex-dispatch.mjs` (read the list there, do not copy a stale
   one) plus `sessionId`, `usageSemantics`, `costUsd`, `permissionDenials`, `readOnly`,
   `host`, `transport`, `touchedFiles`, `worktreePath`. Permission paths use the absolute
   `//c/...` form, with fixtures for spaces and for UNC paths. Fake-executable tests
   (stream-json): success, refused calls, resume (assert the exact resume argv: all lean
   flags and the system rules passed again with the Phase 2 folder), empty final message,
   `--replace-completed`, variable removal by name for both auth modes, both isolation
   modes, a subdirectory target, a submodule refusal, a two-call per-call usage fixture,
   timeout and kill path (looped).
5. Output channels: `build-brief.mjs` takes a channel per role; `exchange.mjs prepare`
   derives each seat's folders from `run.json` and publishes through the canonical paths
   (section 3, item 4); `--seat-b-harness` stays as an alias. Tests: byte fidelity for both
   channels; alias; the grant-isolation test of section 3 item 4.
6. `blind-relabel.mjs` identity terms: add only the terms absent from `VENDOR_TOKENS` (list
   them in the milestone report), each with a positive fixture and a target-derived
   exemption fixture; add path fixtures where a vendor word sits inside a path. Test that
   host, transport and model fields never enter a blinded brief or the audit staging
   folder. Note the suite's dependence on a vendor-free temp path.
7. `build-manifest.mjs`: seat entries gain `host`, `transport`, `readOnly`; accept
   `--reviewer-result auditor=<result.json>` and repeatable `verifier-<n>=<result.json>`
   roles (aggregated like seats, listed under `actors`); accept a Codex rollout through the
   existing `--seat-transcript orchestrator=<file>@<start>/<end>` by detecting the rollout
   format from the `session_meta` first line; use `usageSemantics`; missing usage is `null`
   with a reason. Update the manifest example in both shared copies of
   `references/review-protocol.md` (the "Manifest and final output" section, not a section
   `build-brief` copies), with a test that the example keys cover what the script stamps.
8. Real-session fixture: capture one redacted real lean `claude -p` session file and add a
   test that `--seat-transcript` returns calls, models and `active_ms` from it.
9. `scripts/validate-repository.mjs`: add every new shared file and test to the parity list in
   the same step it is created.

## 6. Milestone 2: host files, host-neutral docs, sequencer, descriptor

Exit: both suites green; `validate-repository.mjs` and `compare-baseline.mjs --base 30fd93a`
exit 0; the Claude Code regression cell (C1) completes.

1. First task, before any doc edit: `scripts/compare-baseline.mjs` (+ test), a maintainer
   script in the repository. `--base <rev>` extracts that revision with `git archive` into a
   temp folder, then (a) builds the 7 brief types for both skills from a fixed fixture
   packet in the base and in the working tree and compares bytes; (b) builds a normalized
   (whitespace-collapsed) sentence list of `SKILL.md` and every `references/*.md` in the base
   and requires each sentence to appear in some doc of the working tree, or in the written
   drop list `docs/design/drops-1.1.0.txt` (one sentence and a reason per line). Exits nonzero
   on any difference and prints the first differences. Run it at the end of every doc task.
2. `references/hosts/claude-code.md` and `references/hosts/codex.md` in both skills (about
   80 lines each): detection rule order (section 3 item 2), the native spawn, `SendMessage`
   and no-fork rules moved out of the phase files, the dispatch and wait commands, the
   sandbox finding and route (section 3 item 1), the rollout path, the invocation syntax.
   The README keeps install commands and slash-command examples. State per file whether it
   is on the parity list: the two skills' host files differ where transports differ.
3. `SKILL.md` and `phase-*.md` in both skills: host-neutral wording, the host table, "read
   SKILL.md, one host file and the current phase file". Update the SKILL.md Maintenance
   paragraph for the new shared scripts. Phase-3 docs in both skills clean up every actor's
   worktree (reviewers, auditor, verifiers) and the auditor's snapshot rule is section 3
   item 5; extend the `validate-repository` cleanup assertions to pair-review's phase 3.
   Protocol sections that `build-brief` copies are not edited.
4. `scripts/review-run.mjs` (shared; derives the skill from its own folder): `phase1`,
   `phase2` and `audit`, each with `--start` and `--wait`; `audit` has two halves,
   `--prepare` (flip, `audit-prep`, prints the falsification-qualified claims and stops so
   verifiers can run) and `--finish` (auditor dispatch for a CLI auditor, `translate`,
   `scorecard`, worktree cleanup); at most ten lines plus one `next:` line; stops at the
   first failed step; calls only scripts the phase files name, in their order. Tests with
   fake dispatchers: success, first-failure stop, pair-review same-model stop, mode `none`,
   requested falsification and full audit reaching the auditor's input.
5. `preflight.mjs --host`: writes `run.json` (section 3 item 10), checks `claude -p --help`
   for each lean flag, refuses a host whose dispatchers are missing. A paid probe dispatch
   is opt-in (`--probe-dispatch`), uses the cheapest model with lean flags, and records its
   cost in the run directory; the default check is free.
6. `validate-repository.mjs`: add the new docs to `forbidSeatsFiles` wherever they contain
   a `blind-relabel.mjs scan` line; the `.git/worktrees` sentence stays in
   `review-protocol.md`.
7. pair-review docs: Claude seats on both hosts; under Codex both seats and the auditor run
   through `claude-dispatch`; distinctness: `init` model ids for CLI seats, requested ids
   (`family-distinct`) for native seats; modes `collaborate`, `adversarial`, `none` unchanged.
8. A tiny real live target with a known defect, `bench/targets/tiny-defect/` (one small
   source file and a test that fails on the defect), for section 8; the existing bench case
   stays for the fake-adapter tests.

## 7. Milestone 3: packaging, documentation, release

Exit: `node scripts/release-check.mjs` passes; the install cases below pass.

1. `plugins/reviews/.codex-plugin/plugin.json` and a repository-root
   `.agents/plugins/marketplace.json`; copy the file shapes from a plugin that already
   installs on this machine and check them against Codex's own validator if it has one.
2. `validate-repository.mjs` and `release-check.mjs`: check both manifests, equal versions,
   the extended parity list.
3. README: install steps per host, the Codex sandbox route and its limits, the host table,
   pair-review under Codex stated as Claude seats, the unsupported cells.
4. One version bump to 1.1.0 across both `SKILL.md` metadata, both plugin manifests and the
   CHANGELOG (root and the shared copies, byte-identical); one CHANGELOG entry.
5. Install cases. For each host, with a scratch project folder: each skill alone, then both.
   Claude Code: `<scratch>/.claude/skills/<skill>`; Codex: `<scratch>/.agents/skills/<skill>`.
   Mechanical pass: the host lists the skill (Codex: a `codex exec` skill listing; Claude
   Code: a `claude -p` listing with the project skills), `validate-package.mjs` exits 0 in
   the installed copy, and the hash list of the installed folder equals the source's.

## 8. Live phase (after M3; small targets, cheap models)

Targets: `bench/targets/tiny-defect/` first, then one small real target. Compare gates,
artifacts and report completeness, not wording or counts. After every seat check
`touchedFiles`; a source write fails the cell.

| Step | What |
|---|---|
| L0 | Codex-host route, before C5 and C6: find a user-approved route where `claude-dispatch` runs outside the sandbox and the session persists (probe: dispatch, then resume, then read the session file). Back up `~/.codex/rules` first. Record the result in the evidence table. No route: C5 and C6 are named unsupported with the section 2 evidence. |
| C1 | Claude Code, cross-review, native A + Codex B (regression; must match 1.0.0) |
| C2 | Claude Code, cross-review, CLI A + Codex B; also an interrupted Phase 2 and a lost session; run folder path containing spaces (this machine's OneDrive folder) |
| C3 | Claude Code, pair-review, native A and B, modes collaborate, adversarial, none |
| C4 | Claude Code, pair-review, CLI A and B, one mode |
| C5 | Codex, cross-review, CLI A + Codex B, with falsification and `double check all claims`, and an interrupted exchange |
| C6 | Codex, pair-review, CLI A and B, modes collaborate, adversarial, none |
| C7 | OpenCode seat B on Claude Code, only if `opencode --version` works here; otherwise named unsupported-not-testable with the reason |
| F | Fixture tests for what the matrix cannot reach unattended: `--use-api-key`, a rate-limit result, an interrupted Phase 1 |

Codex-host cells run from `codex exec` without `--ephemeral`, in a scratch folder that
holds `.agents/skills/<skill>` copied from the working tree.

## 9. Order of work and delegation

1. Draft 2 of this plan is final for implementation (one cross-review done; findings folded
   by the orchestrator).
2. M1, M2, M3 each delegated to Codex with `/codex-delegate`, one task file per milestone
   (this plan plus that milestone's section). After each: review the diff, run both suites,
   `validate-repository.mjs` and (from M2) `compare-baseline.mjs`, fix, at most two loops.
   Fallback per milestone: a Sonnet subagent with the same task file.
3. Live phase (section 8).
4. Final `/cross-review`, Code profile, `double check all claims`, target the working tree
   against `30fd93a` plus the live-run artifacts.
5. Install only when step 4 leaves no open HIGH or CRITICAL: back up the live skills, install
   to `~/.claude/skills` and `~/.agents/skills`, compare hashes. No commit, no push.

## 10. Risks that remain

| Risk | Handling |
|---|---|
| No route for the Claude seat to persist sessions inside the Codex sandbox | L0; C5 and C6 named unsupported with evidence; never a bypass |
| A Codex delegate times out on a milestone | Split by task number; every task is independently testable |
| `claude -p` flag drift | `preflight` flag check stops the run before dispatch |
| Shell reads and absolute writes by a CLI Claude seat | Stated as prompt-only; `touchedFiles` check; worktree default |
| Host cannot be told apart | Section 3 item 2; ambiguous fails with "pass --host" |
| Quota with several concurrent seats | A rate limit is a failed dispatch, reported; never a silent model switch |
