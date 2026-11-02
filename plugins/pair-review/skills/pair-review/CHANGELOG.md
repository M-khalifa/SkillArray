# Changelog

## Unreleased

Fixes for four of the 1.2.0 Known issues:

- With `core.fsmonitor=true` in your Git config, the review's own git commands no longer start fsmonitor daemons
  that keep running after the run (git 2.36 or later; older git is left as it was).
- `preflight --exec` in the default filtered environment now passes the proxy and CA variables, as the dispatchers do.
- After a "No findings" seat with a `Blocked:` line, the `next:` line now says to start a new run, as the message does.
- A run folder stored with a decomposed (NFD) name and quoted composed (NFC), or the other way, is found and
  rewritten as the same folder. Not yet verified on a Mac.

Also: installing through the Codex plugin marketplace is tested (Codex CLI 0.165.0, Windows: both plugins install
and Codex lists both skills); the README shows the three commands.

Also: a target git refuses to open now shows git's reason (the `fatal:` line, such as "detected dubious ownership")
with its `safe.directory` command, not the command alone. On a Codex host the run folder must be inside the folder Codex
was started in (EPERM otherwise), and on Windows git inside the sandbox refuses any repository the sandbox account does
not own; the Codex host file shows the process-local trust to use and how to take back a `.git` the sandbox took over.

From a complete native pair-review on a Codex host (2026-11-01): the Codex host file says to set
`REVIEW_SKILLS_CONFIG_DIR` inside the Codex start folder (the sandbox cannot read `~/.config/review-skills`), to take the
model list from the agent spawn tool (`codex` does not run in the sandbox), and how to find a native agent's rollout
from its task name. The manifest now copies the model of a Codex rollout to the reviewer row, and the report says when
a native seat has no transcript, so its model and token use are not recorded. The catalog labels `haiku` as 5.5 (the
probe resolved it to `claude-haiku-5-5`).

cross-review on a Codex host: the cause of the lost Claude session is found. Claude saves its session in
`~/.claude/projects`, which the Codex sandbox cannot write unless you add that folder as a writable root
(`codex -c "sandbox_workspace_write.writable_roots=[...]"`); then the session probe resumes (seen on Windows). preflight
now checks that folder before the paid probe and names the setting when it cannot write there. The Codex host files and
the README say so.

cross-review on a Codex host, part two: inside the Codex sandbox Claude Code refused every file write of a Claude CLI
seat as "a sensitive file", so seat A could not save its findings (seen 2026-11-01; the cause inside Claude Code is
unconfirmed). A Claude CLI seat or auditor on a Codex host now answers in its final message and the dispatcher writes
the file, as a Codex CLI seat already does. No permission check is bypassed. Such a seat has no scratch folder. A
Codex-host run started before this change cannot be finished: start it again in a new run folder.

A seat or auditor that finished while `--wait` or `audit --finish` was checking it could be dispatched again (a second
paid call), because the worker was checked twice and the second check saw it gone; the result is now read once more
before anything is dispatched again. Seen in a real-target Codex run on 2026-11-01.

From the real-target review of these changes on 2026-11-01:

- A folder name in its other Unicode form (NFC or NFD) counts as the run folder only when it opens the same folder. On
  Windows and Linux a sibling folder spelled the other way is no longer matched; macOS keeps both forms.
- CLI seats and `preflight --exec` now get the review's process-local git settings: `core.fsmonitor=false` and a
  `safe.directory` you set. No other `GIT_CONFIG_*` entry is passed on, since one could carry credentials.
- The report's no-transcript warning counts only real usage data (a token count or a model), not an empty entry.
- The session-folder check stops before the paid probe on any file error; only a refused write suggests the writable root.
- A seat or auditor about to be dispatched again waits for a usage limit its latest result names, and the report names
  the status that result really ended with.
- Known issue: a `git -c core.fsmonitor=true` passed in through `GIT_CONFIG_PARAMETERS` still turns fsmonitor on.

New: `references/worked-example-packet.md`, a filled task packet from a real second-round review with what makes it
work, and the quick recheck recipe; linked from the packet template.

## 1.2.0 - 2026-10-28

Fixes from field runs on real collectors, from self-reviews on Windows, macOS and Linux, and from five rounds of the skills
reviewing their own code.

- Codex seats start with every MCP server off, because a server like node_repl runs code outside Codex's read-only sandbox.
  If Codex can't list its servers, the seat doesn't start.
- `preflight --exec-file <file>` runs one command per line as written. Use it on Windows PowerShell 5.1, which drops inner
  quotes from `--exec`.
- Preflight now refuses a bad setup before any paid call: a run folder inside the target, a target git ignores, no git, a
  repository git can't open, or a Codex seat with no working `codex`.
- The snapshot a CLI seat reviews has the same contents, modes and names as the target's tracked and non-ignored
  untracked files, staged files and line endings included (extended attributes are not copied), and git hooks don't run
  while it's built.
- `review-run --wait` is safe to rerun at any step. It never runs a step twice, and its `next:` line tells you what to run next.
- Ctrl-C stops everything a run started, including background jobs a seat left on Linux and macOS. On macOS the run id
  finds a job that is a non-Apple program (node, Homebrew python); an Apple system program (`/bin/sh`, `/bin/sleep`,
  `/usr/bin/perl`) hides its environment and is not found.
- A seat CLI that keeps running after its final answer is stopped 30 seconds later and the answer kept (result.json
  `stoppedAfterAnswer`), instead of holding memory until its timeout.
- `review-run` shows that stop, and warns (also in the report) when the seat's output stayed open after it, because a
  process it started may still be running.
- A native Codex agent whose last turn was aborted is no longer read as finished: `review-run` asks you to resume it.
- `review-config seats` notes when a seat or the auditor runs as a native agent, which also sees the host's own
  instructions and memory.
- From a macOS self-test: preflight `--exec` no longer waits for output that a process outside the command's process group
  holds open (it warns and records `outputHeldOpen`), and on Linux and macOS it warns when it stops what a command left in
  its process group. Every seat and auditor brief says to read nothing in the run folder beyond the files it names. A run
  with a seat's Phase 1 file missing is recorded as incomplete. The host pre-flight warns about a `P1`-style label in the
  task packet. The model catalog lists gpt-6.1-sol.
- From a Linux self-test: a run-folder path a seat pasted into its findings reaches the other seat and the auditor as
  `<run-dir>`; on Linux and macOS a path written as `//root/...` counts in the run-folder checks; on Linux letter case is
  no longer folded there (a folder `r` next to the run folder `R` is another folder); a seat CLI that had exited while
  its output was still open is no longer signalled, and the warning says so.
- From the third closing review: after the `<run-dir>` rewrite, the run-folder guard runs over the peer views and the
  auditor's files and stops on any other spelling (`~`, a variable, a drive-less or short name, a link); the `Blocked:`
  reader takes the section heading at any level and any run of list, number, heading, table or task-box markers; the
  pre-flight label warning covers the letters A, B, X and Y too; an empty or cut-off seat file counts as missing; a
  timeout or Ctrl-C never signals a seat CLI that already exited; audit-prep retries a rename Windows briefly refuses and
  leaves no staging folder; a native agent that ends its last turn with no reply gets a warning.
- From the fourth closing review: the `Blocked:` reader also takes an emphasized or numbered section heading, a
  letter or roman list label (`a.`, `iv)`) and a full-width colon; build-manifest counts a seat file only with an unfenced
  `## Checks performed` or `## No findings` and reads the original Phase 1 copy first; a seat CLI that exits without an
  answer while its output stays open ends after 5 s with a warning instead of waiting for the timeout; `%USERNAME%`,
  `$USER` and `$env:USERNAME` inside a path count in the run-folder checks; the run-folder guard, the `<run-dir>`
  rewrite and the re-review packet's path rewrite agree on where a folder name ends; a relative path that walks up
  through `..` (`docs/../../runs/...`) is checked against the target; preflight and the OpenCode dispatcher never stop
  the tree of a command that already exited; a resumed native Claude agent's turn with no text no longer reports the
  earlier turn's reply; the Phase 2 resume message allows what the delta brief allows; the packet template's own
  examples no longer look like claim labels.
- From the fifth closing review: a relative path that walks up through `..` is also found inside markdown emphasis,
  strikethrough, a table cell or a quote; a `Blocked:` line may follow several stacked list labels (`1. a.`);
  build-manifest and build-report read the seat's section under the same headings review-run's reader takes, and a seat
  file with only that heading (no claim, no No findings) counts as missing; a finite `--timeout` that falls due after a
  seat CLI exited with no answer and its output open ends the run as the exit wait does (its exit code, a warning), not as
  a kill, and review-run records it; the re-review packet's path rewrite leaves a longer path that ends with the old one
  alone; `$USER` and `$USERNAME` fall back to each other; the resume messages also allow the seat's own output file.
- Upgrade note: finish or restart any review that uses an isolated copy (a Claude CLI seat, or OpenCode with `--isolate`)
  before updating. The new version refuses to resume a copy made by the old one; remove that copy and restart the affected
  review steps.
- If the target changes during a review, `audit --finish` names the changed files and can go on with `--accept-drift`, which
  the report then shows. A refused auditor file comes back with a ready message for the auditor.
- The report no longer counts withdrawn findings under their severity, and its cost columns mean the same thing for every
  seat. A seat that says it could not read or run things gets a warning.
- New: `--exec-in-file`, `review-run status` for several runs at once, and `preflight --probe-reach` to check what a Codex
  seat can reach.
- The re-review packet maps every repository of the old run (`--repo-target`), can build its own diff (`--since-dirs`), and
  words each old finding as "still present", so REFUTED means fixed.
- Findings keep the seat's "Same shape elsewhere" sites and a new "Trigger" line (what input makes the bug happen). The
  report shows both, the next re-review checks those sites too, and a light audit no longer starts silently after a HIGH
  claim was conceded.
- The report shows the review round (with a step-back note from round 3), wall and orchestrator time, a "Where" hint per
  finding from the change diff, and reads outcome words in the notes (fixed, wrong, intentional, not-worth-it, decided), which
  the next re-review packet uses too.
- A repository's REVIEW.md (the committed copy by default) goes into the seat and auditor briefs. Two repository tools:
  `bench/outcomes.mjs` counts outcomes per seat model, and `bench/case-from-run.mjs` turns a finished run into a bench case.
- On Windows each `preflight --exec` command runs in a job object, so a background process it leaves is stopped even after
  the program that started it has exited. The brief's run-folder check sees spaced folders and `${env:X}` /
  `%HOMEDRIVE%%HOMEPATH%` spellings and paths through a link or junction. Each seat ends its Checks performed with a
  `Blocked: none` or `Blocked: <what>: <error>` line, the only signal for the blind-seat warning: a No findings seat without it
  stops the step (the wording guess is gone). The packet scans take a backticked path whole and a bare one up to the first
  space, and only URLs, IPv4, [IPv6] and localhost as endpoints. The orchestrator copies project knowledge into the packet.
- From the first Windows CI run: the Windows job wrapper starts PowerShell with this process's `PSModulePath` and sets
  the filtered one only on the command it starts. Before, the wrapper took about 20 seconds per seat CLI or `--exec`
  command on a GitHub Windows runner (0.5 s now); the command's environment is unchanged. Test files (`.diff`, `.jsonl`,
  `.txt`) check out with LF line endings on every OS, the stored-run replays no longer depend on the skill's version,
  and a path test no longer assumes the temp folder and the working folder share a drive.

Restructure (one entry, fewer moving parts):

- Tests: nine stored review runs replay through validate, the exchange, audit-prep, translate, the manifest and the
  report, and must give the recorded result.
- Per-seat environment: `review-config seats --env <role>=NAME,...`, `--env-mode <role>=inherit` and
  `--use-api-key <role>` write variable names (never values) into run.json, and `review-run` passes them to every
  dispatch of that seat or the auditor, so a Bedrock seat no longer needs a hand-run dispatcher.
- OpenCode is gone: the dispatcher, its catalog providers, host rules, tests and docs. Seat B of a cross-review runs on
  Codex.
- The Claude and Codex dispatchers share one process module (`cli-run.mjs`) for the answer stop, the exit wait, the
  timeout and Ctrl-C. On Windows each seat CLI runs in a job object, so a process it started is stopped with it, also
  one whose launcher has exited (result.json `leftoversStopped`); a refused job is named (`jobRefused`) and the old
  warning stays.
- One strict seat file format, read by one module (`seat-file.mjs`) in review-run, the manifest and the report: claims,
  then exactly `## Checks performed` (or only `## No findings`), with exactly one line `Blocked: none` or
  `Blocked: <what>: <the error>` and no other unfenced Blocked text. A refused file goes back to its seat once with the
  reasons; refused again, the review is INCOMPLETE (`phase1/format-refused.json`). The loose `Blocked:` readers are gone.
  A `## No findings` seat that names a block makes the manifest incomplete, also in a run built without review-run.
- One entry: `review-run` (with `review-config` and `preflight`). blind-relabel, exchange, build-brief, build-manifest,
  build-report and build-recheck-packet are modules that review-run calls in-process, with no command line and no help
  text. New `review-run` commands: `manifest`, `report`, `recheck`, `splice`, `scan` and `verifier-brief`. Tests inject
  the steps (`io.steps`); `REVIEW_RUN_SCRIPTS_DIR` is gone. The manual route and its options (`--seat-b-harness`,
  `--incomplete-seats`) are gone.
- Every audit re-checks every claim: the light audit, `--audit-depth` and the depth advice are gone. A `run.json` from an
  older run keeps the depth it ran with.
- Every Phase 1 claim fills `Same shape elsewhere:`; a claim without it is refused (one rewrite).
- The report prints the observed overlap of the two seats: raised by seat A only, seat B only, or both.
- A step module started with node by hand exits 2 and points at `review-run`, instead of doing nothing and exiting 0.
- From the first review of the restructure: a deep verify the user asks for after the audit (a run that started without
  falsification) is staged and read by translate, also after the audit finished (the earlier output and findings are kept); `review-run status` names a seat file refused twice also after the
  manifest is written, and says when a manifest is incomplete; the report renders such a run as INCOMPLETE instead of
  failing; rebuilding the manifest of a run written before the strict format no longer marks it incomplete (a format
  note and a report caveat instead); a quoted `Blocked:` line in an inline code span of any width is read as code; a
  format rewrite that failed before its CLI reported a session is sent again on the Phase 1 session; a verifier started
  with `--run-dir` gets the auditor's run.json environment settings; a refused Windows job is reported also when the
  seat was stopped after its answer; messages no longer advise dispatcher options `review-run` cannot pass.
- From the second review of the restructure: `review-run phase2 --wait --incomplete-seat <A|B>` finishes the exchange
  without a seat that cannot be resumed (the review is recorded as incomplete); after a finished audit, a changed native
  auditor file waits for `--native-done auditor` again; a seat file refused twice no longer also gets the "written before
  that rule" note; the report says "blind exchange: no" and "fresh auditor: none" when neither ran, and names only files
  that exist; a git target with submodules names a native seat as the way to review it; preflight `--exec` reports a refused Windows job also on a timeout or stop; the ten-line output cap keeps
  warning and failure lines first; the docs say how a deep verify after the audit works with a native auditor and that a
  CLI auditor needs a run with `--falsification`.
- From the third review of the restructure: `--incomplete-seat` stops that seat's Phase 2 CLI when it is still running,
  so it cannot write rebuttals after the finish; the manifest records a blind exchange only when rebuttals were
  appended; a seat file with text after `Blocked: none` is refused; a deep verify after a finished native audit is
  scanned and staged for the resumed auditor; when warnings overflow the ten-line cap, the rest share one line instead
  of being dropped; the scorecard and the docs say a CLI auditor needs a new run with `--falsification` for a deep
  verify; the submodule message says such a target cannot be reviewed from a Codex host.
- From the pair review after the third review: a `Blocked:` line that says "none" with anything after it, or another
  word for nothing (`n/a`, `nothing`, `-`, `(none)`), gets the one rewrite instead of being read as a block; a saved
  configuration this version cannot use (an OpenCode seat) names its file and says reset, then setup; when warnings
  overflow the ten-line cap, each one keeps its start and the omitted progress lines are counted; a seat that answered
  and is still running when its `--timeout` ends keeps its answer; the identity scan no longer stops on the target's
  own folder name (or a source folder's) when it holds a vendor word; review-run's usage names `--accept-drift` and
  `--local` where they are accepted, and the ten-line cap is stated for the phase commands only; the replay test data is
  no longer ignored by git (the repository check now refuses an ignored fixture), its byte counts no longer depend on
  the temp folder's length, and a short-form profile name was removed from it; the phase-2 docs say how to send a
  redaction request to a CLI seat.
- From the Linux review (Ubuntu 24.04, the review run as root): on Linux and macOS a background job a seat's tool command
  left running is stopped when the seat ends, also one in a process group whose leader has exited (the groups the CLI's
  tool commands lead are watched while it runs, once a second) and one that left its group (every process the CLI or a
  preflight `--exec` command starts carries a run id, `REVIEW_SEAT_RUN_ID`); `leftoversStopped` names them. On macOS the
  run id finds a job that is a non-Apple program (node, Homebrew python); an Apple system program (`/bin/sh`,
  `/bin/sleep`, `/usr/bin/perl`) hides its environment and is not found. The run-folder guard reads `$PWD`,
  `${PWD}`, `/proc/self/cwd`, `/proc/thread-self/cwd` and `~user/` from the reader's folder, and on
  Linux and macOS a backslash as a separator. Preflight probes whether the run folder's file system folds letter case
  (WSL `/mnt/c`, CIFS, exFAT) and records it in run.json (`flags.foldsCase`); the run-folder checks and the identity scan
  use it. `--incomplete-seat` also stops a seat worker that has not started its CLI yet. A claim-level defect in a seat
  file (a missing or invalid field, a duplicate heading, an unclosed fence) gets the same one rewrite as the section
  format. `phase2 --start` moves a seat's leftover Phase 1 scratch folder out of the run folder (to
  `<run-dir>-scratch-kept`). phase1 --start no longer warns about outside paths a reach probe of the run already read. A
  failed exchange step's summary keeps the line that names a run-folder leak. The WMI worker start has a timeout. Tests
  that held on Windows only (a fake process in the caller's process group, a lower-case spelling of a case-sensitive
  folder) and test timeouts too short for a full parallel run were fixed.
- From a second Linux review: stopping a recorded seat (`--incomplete-seat`, Ctrl-C) also stops every process that carries
  its run id, and sends the seat worker SIGTERM before SIGKILL; a preflight `--exec` command that times out or is stopped
  has its marked leftovers stopped too (`leftoversStopped`). The group watch stops when the CLI process is gone or was
  replaced. The run-folder guard no longer rewrites `/proc/<pid>/cwd` of another process, and resolves a relative run
  folder from a CLI seat's worktree as well. The identity scan reads the case-folding setting on every check. The
  claim-level check reads both seat files together and reports a target it cannot read. A step counts as finished only
  when its record holds its own result (a findings list, the exchange's appended seats, a manifest status). Replay
  summaries count each step's warnings.
- From other sessions' field runs: preflight runs `python` (`python3` on Linux and macOS), `rg` and `git` inside the Codex
  sandbox (`codex sandbox`, free) and warns about each one a Codex seat cannot start, naming where this host has it (the
  Windows sandbox account cannot start a program under the user profile); `phase1 --start` repeats it (`seat-tools.json`).
  A run stopped after Phase 1 gets a report of each seat's own claims, marked as neither cross-examined nor audited. A
  split GO / NO GO ticket whose NO GO rests on a finding the auditor confirmed says the finding settles it. The
  orchestrator's own transcript with no usage in its window is a manifest warning, not a failed manifest. `review-run
  cleanup` lists and, with `--yes`, deletes the seats' scratch folders. `review-config seats --replace` overwrites an
  existing seats file. `--audit-depth` names what replaced it. SKILL.md says the next `--wait` dispatches again only the
  CLI seat that stopped part way.
- From a third review on Linux: the run-folder guard follows a link before a "..": "/proc/<pid>/cwd/../x" and
  "<link>/../x" land where the link points. It also reads a path with shell quotes in it, a path glued to an option
  ("-C/x", "--out=/x"), and "~+", "$(pwd)" and "`pwd`". Shell globs, brace lists and "${PWD%...}" operators are still not
  read. `cleanup` skips a folder that is a link or lies behind one. On macOS the process table carries each process's
  start, so a reused pid is told apart. A manifest of an older run whose exchange record has counts but no list of
  appended seats reads its rebuttal sections again. An unreadable source folder at the Phase 1 format check is a FAILED
  line, not a stack trace. The Phase 1 report needs both seat files finished (each reached its closing section); a seat's claim IDs reach the other seat's code check even when its own file cannot be parsed yet. A Codex rollout with no token
  events in the orchestrator's window is a manifest warning. `--incomplete-seat` repeats what the stopped worker's log
  says its CLI left running. From a third review on Windows: the guard and the scrub read Git Bash's /tmp spelling of a run folder in the OS temp folder and a drive-relative path ("C:../x"); `cleanup` names a folder it cannot list or delete (EBUSY) and fails with a next: line instead of reporting it clean.
- From a fourth review on Linux and Windows: the guard reads every shell's working-folder form in any letter case
  ("$pwd", "${pwd}", "$(Get-Location)", "%CD%", "$(pwd -W)", "`pwd -P`", also inside quotes), a path glued to an option
  cluster ("tar -czf../x"), a one-letter option before a relative path that walks up ("-Cdocs/../x") and, on Windows, a
  switch glued to a path ("/LOG:..\x", "/Fo..\x"). `phase2 --start` moves no scratch folder out of a linked phase or seat
  folder, and `cleanup` no longer follows a seat folder inside a linked phase folder. The Phase 1 report needs both seat
  files well formed, the closing section with its Blocked: line. A falsification verifier's file that names the run
  folder is refused before it reaches the auditor. A seat file whose fence is not closed still lends every claim heading
  to the other seat's code check. The guard looks up each folder's link once per text.
- From a fifth review on Linux: an option cluster before a rooted or "./" path ("tar -cf/x/../run") and a one-letter
  option before a folder name ("-Cdocs/../run") are both read, as the two readings cannot be told apart; the link walk
  covers the first 20 cuts of each path, so a linked folder whose name has a space is followed too. The Phase 1 report
  applies only the format rules the seat's brief stated (a run older than the Blocked: or Same shape rule is read without
  it), also on the zero-finding path. A verification file that arrives after the auditor brief is staged on the next
  `audit --finish`, which says to resume the auditor.
- From a fifth review on Windows: the guard reads Windows switches with "+:" ("/LOG+:"), dash-colon switches ("-out:",
  "-Path:") and "/Fo" before "./" or a folder name, and reads switches before glued options, so "-out:..\x" is not taken
  for a drive-relative path. `phase2 --start` moves no scratch folder into a linked `<run-dir>-scratch-kept`. The Phase 1
  report refuses a seat file with an unclosed fence, and reads a format rule from the protocol's own wording in the
  brief, not from the word in a quoted log. Two stray fence lines that balance still hide the claim between them: no
  script can tell them from a quoted claim block.
- From a sixth review on Linux: after `audit --finish --accept-missing-verifiers`, the rerun its next: line names no
  longer fails the missing-verifier check again; a verification file that arrives later says how to reach a CLI auditor.
  Off Windows the guard also reads a path with a backslash-escaped space or shell character ("my\ side"). A dangling
  `<run-dir>-scratch-kept` link counts as a link. The Phase 1 report reads the format rules from the brief outside its
  frozen packet, and a run older than the Blocked: rule is excused that rule only.
- From a sixth review on Windows: a quoted relative path whose first folder name has a space ("All Users/../run") is
  read as a path; on Windows "/Users/x/../run" stays a rooted path (the "/Fo" switch reading is the second reading
  only). A verification file that arrives after the auditor brief stops `audit --finish` naming it, as verifiers run
  between `audit --prepare` and `--finish`; after a finished audit a CLI auditor is told to start a new run with
  falsification. An older run is excused every Blocked-line rule, and a packet quoting the closing reminder does not
  make it strict.
- From a seventh review on Linux and Windows: the guard reads a path as the shell makes it from a line: quoted parts
  joined to their neighbours ("All Users"/../run), a backslash escape before any character off Windows and before a
  space or shell character on Windows (Git Bash), and $'...' quoting; a quoted piece is read between two quotes of one
  kind, so an apostrophe or inline code around it does not hide it. A deep verify after a finished audit is staged and
  the step stops, so the auditor is resumed with the file in its folder before translate; a verification file changed
  after it was staged stops the step. An older run is excused the Blocked-line rules by their own wording only.
- From two field runs on Windows: the second preflight now warns when the task packet names the run folder (an
  evidence folder inside it), instead of the first refusal coming at `phase1 --start`; the Quickstart says to keep the
  evidence folder outside the run folder. The warning about packet paths outside the target, which a Codex seat may not
  read, now also shows on Windows, and in the second preflight too, before Phase 1 is paid for. When the Codex seat can
  run neither python nor rg, preflight says once that it will review by reading only. The scratch-folder line at
  `phase2 --start` names the seat. The chat report lists the flagged criteria past the first eight by tag, and names the
  findings the seats left unresolved. The packet template says which label spellings count as claim labels.
  `review-run recheck` without a diff lists the files changed since the previous run from its snapshot, and
  `review-run status` prints each run's first brief time (the latest safe start of an orchestrator usage window).
  When translate refuses a CLI auditor's file, the attempt is moved aside by the step itself, so rerunning
  `audit --finish` dispatches the auditor again; no file has to be removed by hand.
  `review-run recheck` prints the step-back note from round 3 on, before the round is paid for.
  A Claude CLI seat that hits a session limit (the CLI's "You've hit your session limit · resets 3:30am", given as the
  result text) is recorded as rate-limited with its reset time instead of a plain error, and a failed wait names the
  error, so a limit can be told from a crash.
  `review-run status` and the report say when manifest.json was built before the finished audit (its findings hash
  differs, or it has none and is not complete), so a manifest left by a failed chain is rebuilt, not trusted. The
  Codex-seat warnings say to paste the test result lines into the packet, since a log outside the target may not be
  readable to that seat. The replay records of closing-plan, closing-r3 and closing-r5 were rewritten for the new
  `unresolved (F<n>)` and `MORE` report lines; nothing else in them changed.
  A Tier 2 command that times out now says its limit and the flag that raises it ("timeout after 1800 s (raise with
  --timeout <seconds>, 0 = unlimited)"); the Quickstart shows `--timeout`.
  On a target that is not a git repository, the drift check now leaves out Python and Gradle caches (`__pycache__`,
  `*.pyc`, `.pytest_cache`, `.gradle`) that a build or test run wrote, so a review is no longer stopped for them; a
  seat that writes into the target is still caught by its own write check (`touchedFiles`). SKILL.md notes how to
  split a large target into several scoped runs, and the Windows PowerShell Constrained Language limit of a Codex seat.
  The private project names in the test data are replaced with neutral ones.
  A seat may now add an optional `Pre-existing: yes | no | unknown` line to a claim, for a review of a change. The
  report lists a finding as pre-existing from that line only when no seat wrote `no`, the author's notes say nothing
  about it, its evidence is not on lines the change added, and it is not a blocker (a HIGH or CRITICAL stays under Fix
  now or Decide). The second preflight warns when the change is over 500 files or 8,000 changed lines in tracked
  files, and suggests several scoped runs. The pull request template asks for the risk and how to revert.
  `preflight --host ... --keep-target-copy` keeps the target's files as the seats review them in
  `<run-dir>-target-copy` (git: tracked and untracked files git does not ignore; links are not followed; each copy is
  checked against its source), so a run can later become a bench case. Phase 1 refuses a target that changed after the
  host preflight, so the copy is the reviewed code.
- From a review of the proposed next features: a REFUTED auditor check or falsification verdict needs a command and its
  output or the cited lines; `Basis: INFERENCE` with REFUTED is refused (absence of proof is INCONCLUSIVE), for a
  verifier file already when `audit --finish` stages it, before the auditor runs. A CRITICAL claim can no longer be
  dropped as `dropped-speculative`; unchecked, it stays `unresolved-high-stakes`. `translate` refuses a top-level
  `severity_audited` in the auditor's file (it is set only from `auditor_check.severity`).
  `review-run recheck --drop-tag` refuses a hypothesis tag, which in a re-review packet is a previous finding (it was
  removed without a trace); use `--skip F<n>`. The re-review packet and the recheck output count the previous findings
  carried as hypotheses and those decided. Preflight reads the committed REVIEW.md of every folder between `--cd` and
  the repository root, not only those two (the 8 KB limit covers all of them, so a repository near the limit can now
  be refused). Docs: one `review-run manifest` call is enough (`--init` is optional), the Decide group is the list a
  person must settle, static analysis tools run as preflight `--exec` (a secret scanner only in redacting mode), a
  recipe for counting false positives on a known-clean target, and the protocol no longer says the auditor spot-checks.
- From the release gate on a loaded Windows host: a seat worker whose result.json rename Windows refused for a moment
  (EPERM, EBUSY: a virus scan or a reader holding the file) crashed and left the seat "running" until `--wait` called
  its worker gone. The dispatchers now retry that rename (and the `--final-message-out` one) for up to 5 s. On Windows a
  stop waits up to 30 s for taskkill instead of 5 s: taskkill ends with the dispatcher, so a slow one was cut off and
  left the process it was stopping running. A usage limit's clock time (`retryAfter`) is the first moment, from one
  hour before its record was written (`finishedAt`, else `startedAt`), at which the local clock shows that time (a
  time the spring change skips counts when the clock jumps past it), instead of within 12 hours of the moment it is
  read: read after midnight, a day later or on either daylight-saving night (also a reset in the repeated autumn
  hour), a passed time no longer counts as tomorrow, which made `--wait-retry` wait and `review-run` refuse to
  dispatch for about a day, and a reset from 12 to just under 23 hours ahead no longer counts as passed.
  Tests that assumed a fast host now leave room for a slow one.
- From field reports of other review sessions: `review-run phase2 --start` before Phase 1 has finished refuses and
  names `phase1 --wait`, instead of failing in exchange prepare on a missing findings file. Preflight `--base
  <commit>` lists the diff and changed files of work already committed (snapshotHash is unchanged), and
  `review-run recheck --since-commit <commit>` writes the change since that commit with line counts; `recheck
  --preflight <file>` writes the evidence section from the evidence preflight (snapshotHash, each repository's HEAD,
  each command's result and log) instead of a FILL line. `--seat-transcript orchestrator=auto` reads every transcript
  of the session (a session that moved to another project folder has one in each) and counts a call once, so its
  cost is no longer lost. Every report (terminal, markdown, chat, HTML, `--json`) and `scorecard.md` ends with one
  line naming the skill, its version and the project page.
- From a Linux review of those changes and two more field reports: a usage limit whose look-back starts on the spring
  clock jump is no longer moved a day; of the copies of one session's transcript (the same file name in several project
  folders) only the one with the latest entry is counted, so working time and commands no longer depend on the order
  the copies are given (one file given twice with overlapping windows still counts twice), a role's other transcripts
  are still timed apart, and `auto` skips a copy with no reply (errors name the full path); the auditor's
  instructions say that a changed severity needs `auditor_check.severity_reason` (three runs were refused without it); recheck evidence quotes the last test-summary line, names a non-empty stderr log, warns when a command changed
  the target or left a process behind, and is added to a packet that had no evidence
  section; `recheck --out` creates its folder; each carried-over FILL line names its section; changed-file lists
  (preflight Tier 1, `--base`, context-builder, the run fingerprint) name a renamed file's old path too; the
  `phase2 --start` refusal says a run from before this version needs one `phase1 --wait`; preflight `--help` names
  the shell `--exec` runs through (cmd.exe on Windows, /bin/sh elsewhere).
- From a Linux review of those changes: `review-run manifest` now counts the archived `result.attempt-<n>.json` of a
  retried call for every actor (exchange, redaction, auditor, verifiers), not only Phase 1, so a refused auditor run
  that is dispatched again keeps its cost and time, and it warns about such a file that was left out. An attempt that
  ended without completing (error, timed out, rate-limited) is still not counted. Because the retried calls are
  merged, an auditor or verifier retried with another model or effort is now refused as for a seat; a different
  worktree is accepted for them, since each such dispatch gets its own temporary worktree. The left-out-call warning
  also reads the auditor's `<run-dir>-audit-dispatch` folder, and with `--run-dir` it scans the run folder wherever
  `--out` writes the manifest. With several
  `--seat-transcript` windows for one role, `counted_from` and `counted_until` are the earliest start and the latest
  end (left out when a transcript was given without that bound), and the late-start warning reads that earliest start.
  The scorecard says copies of one session count once only when given the same window. The auditor brief and the
  protocol say which fields translate refuses a claim ID in, and that `auditor_check.evidence` is not checked.
- Final field fixes: on Windows the preflight tool check runs `python`, `rg` and `git` in the Codex sandbox through
  PowerShell, the seat's own shell, so a Python the seat can run is no longer reported as missing, and a missing
  tool's "is not recognized" line is the reason shown; the advice adds a copy under Program Files on PATH. A report
  run on an audited run before `review-run manifest` now says NOT FINAL (run the manifest, then the report again)
  instead of INCOMPLETE, in every format and in `--json`. `recheck --since-dirs` leaves `.git` folders out of
  `since.diff`. `review-run manifest` warns once when the orchestrator's own cost is not counted and names the
  `--seat-transcript orchestrator=auto@<first brief time>` flag to add. A re-review packet adds one hypothesis on the
  edge values (null, missing, empty, zero, negative) of the fields the change reads; its no-diff FILL line names
  `--since-commit`, `--since-dirs` and `--since-diff`, and a carried-over section's FILL line says its counts are the
  previous packet's. A `--wait` that exits 3 says not to start the next phase yet; an agent id that matches no
  transcript says to check the id the Agent tool returned. The report says when an auditor file was refused and
  `audit --finish` is still pending, and that the auditor does not rule on a hypothesis the seats disagree on. The
  Claude Code host notes say how to wait on Windows, where Git Bash has no `pgrep`. The stored replay records' report
  hashes were made again for the new split-hypothesis caveat.
- From a Linux review of those changes: a report whose manifest was built before the current `phase3/findings.json`
  is NOT FINAL instead of COMPLETE or INCOMPLETE. The orchestrator-cost warning is skipped only for a manifest-body
  orchestrator entry that holds a number, not for a null or empty one. `audit --finish` removes
  `phase3/prompt-auditor-fix.txt` once translate passes, so a later failure is not reported as a refused auditor file.
  The manual worktree cleanup in phase-3-scorecard.md also reads `result.attempt-<n>.json`.
- `--since-commit` and `--since-dirs` run `git diff --no-color`: with `color.ui` or `color.diff` set to `always` in the Git
  config, `--since-commit` stopped with a TypeError. `--since-commit` also sets the `a/` `b/` prefixes: with `diff.noprefix`,
  `diff.mnemonicPrefix`, `diff.srcPrefix` or `diff.dstPrefix` it listed wrong paths or left out a binary file.
  `review-run status` reports an audit after the manifest was built as pending, not finished: a re-audit (findings moved
  to `findings.attempt-<n>.json`) or an auditor file that was refused (`prompt-auditor-fix.txt` only).
- From a macOS review: a seat's background job that left its process group is now found on macOS too, by the run id in
  its environment (see Known issues). The process table reads start times in UTC, so a time-zone change while a seat
  runs no longer stops the group watch. `NODE_USE_SYSTEM_CA` reaches the seats in the filtered environment.
  `--since-commit` lists a submodule pointer change also when the Git config sets `diff.submodule=log`. A test helper no
  longer counts a live process as stopped on macOS. On macOS every process check runs `/bin/ps` by its path, so a PATH
  without `/bin` (or another `ps` on it) does not hide what a seat left running. The macOS run-folder and fsmonitor
  advice is in SKILL.md.

### Known issues

- macOS: a run folder whose name is stored decomposed (NFD) and that a seat quotes composed (NFC) stops the exchange
  with a run-folder leak. Use an ASCII run-folder path.
- macOS with `core.precomposeunicode`: an untracked file with a decomposed (NFD) name is recreated under its composed
  (NFC) name in the snapshot. The contents are the same.
- With `core.fsmonitor=true` in the Git config, the snapshot's git commands start git fsmonitor daemons that keep running
  after the run. Set `core.fsmonitor=false`. A future fix with `-c core.fsmonitor=false` needs git 2.36 or later.
- macOS: a leftover job that is an Apple system program (`/bin/sh`, `/bin/sleep`, `/usr/bin/perl`) is not found by the
  run id.
- Windows: a job-object helper can hang in a kernel wait until the machine restarts.
- Linux as root: the Codex sandbox may block `python` or `git`, so the report carries the "may have reviewed blind"
  caveat.
- The blinding scan can stop on product names when the reviewed code is itself about those products. A
  redaction with `review-run splice` gets past it.
- After a "No findings" seat with a `Blocked:` line, the `next:` line says to rerun `--wait` while the message says to
  start a new run. Start a new run.
- `preflight --exec` with the default filtered environment passes no proxy or CA variables (the dispatchers do). Name
  them in `--env-passthrough`, or use `--env-mode inherit`.

## 1.1.0 - 2026-10-05

- Each skill is its own plugin in the `skillarray` marketplace (`pair-review@skillarray`, `cross-review@skillarray`).
- A seat can run headless through the Claude CLI as well as a native agent, and reviews can be started from Codex as a trial.
- `preflight --host` writes a `run.json` for the run, and `review-run.mjs` drives the three phases from it with a short
  status and one `next:` line.
- pair-review can pair two OpenAI models through Codex.
- `build-report.mjs` prints a short chat report: severity bars, a fix now / fix next / decide table, and the cost per seat with
  the commands each seat ran.
- The OpenCode seat is still not verified end to end.

## 1.0.0 - 2026-10-01

- First release. In `cross-review` a Claude reviewer and a Codex or OpenCode reviewer check the same target on their own,
  trade findings once without knowing who wrote what, and a fresh auditor settles each finding. `pair-review` does the same
  with two Claude models.
- A run leaves `findings.json`, a scorecard and a `manifest.json` with file hashes, models, token use and time.
- A light audit only re-checks disputed findings. Ask for "double check all claims" when both reviewers could be wrong the same
  way.
