# Host: Codex

This is cross-review's Codex host file. The two skills' host files differ where their transports
differ, so host files are not parity files. Read it with SKILL.md and the current phase file.

Support is decided per actor (`scripts/host-support.mjs`), not per host. A cross-review on a Codex host is a
**trial that preflight must prove first**: Claude seat A and the auditor run as Claude CLI processes, Codex
seat B runs as a native Codex agent, and the Claude seat is usable only if its session survives a call, which
depends on how Codex was launched.

| Actor | Route on a Codex host | Status |
|---|---|---|
| Claude seat A | CLI (`claude-dispatch`), started by the sequencer as a plain detached process | **trial only after a session probe**: `preflight --host codex --allow-trial --probe-claude-session --yes-paid` |
| Claude auditor, verifiers | CLI, one call each (no resume needed) | trial, needs `--allow-trial` |
| Codex seat B | native agent: `spawn_agent` + `followup_task` | trial |
| Codex seat B | CLI (nested `codex-dispatch`) | unsupported: the Codex sandbox blocks a nested start; no override |
| Claude native agent | none | cannot exist: the host spawner offers only OpenAI models |

Why the probe: Claude saves each session under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). A Codex
sandbox lets a command write only inside the folder Codex was started in and its writable roots, so a Claude CLI call
answers but loses its session, and Phase 2's resume of seat A fails with `No conversation found with session ID`. To
run a Claude CLI seat from Codex, start Codex with that folder as a writable root (or set the same under
`[sandbox_workspace_write]` in `~/.codex/config.toml`; single quotes keep the backslashes):

```text
codex -c "sandbox_workspace_write.writable_roots=['C:\Users\<you>\.claude\projects']"
```

Allow only `projects`, not all of `~/.claude`: that folder also holds Claude's settings and login, and any command the
sandbox runs could then change them. preflight checks that the folder can be written before any paid call and names it
when it cannot. Seen on Windows on 2026-11-01: with the writable root the probe resumed its session inside
`codex sandbox`; without it the resume failed. The 2026-10-07 run that kept its session had Codex started in the home
folder, which made `~/.claude/projects` writable.

Writing files: inside the Codex sandbox, which runs commands under its own Windows account (`CodexSandboxOffline`),
Claude Code refuses every file write of a Claude CLI actor as "a sensitive file", whatever the allow rules say (seen on
2026-11-01; the cause inside Claude Code is unconfirmed, and `os.userInfo()` failing there is a likely one). So on a
Codex host a Claude CLI seat and a Claude CLI auditor answer in their final message, and the dispatcher writes the
file (`--final-message-out`), as for a Codex CLI seat. The skill never bypasses that permission check. Such a seat
gets no scratch folder (its brief says to write no file), so a check that needs temp files is run in preflight
(`--exec`) and cited in the packet instead.

The skill still proves it before a run: `--probe-claude-session` makes two small Claude
Haiku calls (remember a nonce, then resume the session and recall it; it needs `--yes-paid`), refuses the run
if the recall fails, and records the result (`support[].probe`) in `run.json`. Without the probe a Claude seat
on a Codex host is refused. "Trial" means the route runs but has not been run at length; the manifest records
`host_status: trial` and the per-actor `support` rows.

How the Claude CLI starts: WMI, which `--detach` uses on Windows to leave the host's job object, is refused
inside a Codex sandbox (`Access denied`). `claude-dispatch` and `codex-dispatch` then fall back to a plain
detached Node process (they say so on stderr; `REVIEW_DETACH_MODE=wmi` forbids the fallback). A probe from
`codex exec` showed such a worker survives the shell call that started it; whether it survives the end of the
Codex turn is not shown, so keep the orchestrator working (rerun `--wait`) until every seat is done.

## Recognise the host and write run.json

The Codex agent tool names are not part of the host table in SKILL.md, so pass `--host codex`.
`CODEX_THREAD_ID`, `CODEX_CI` and the other `CODEX_*` variables are hints only: Claude Code started
from Codex, and Codex started from Claude Code, inherit each other's markers.

```json
{
  "seatA": {"provider": "anthropic", "runtime": "claude", "model": "opus", "effort": null, "transport": "cli"},
  "seatB": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-terra", "effort": null, "transport": "native"},
  "auditor": {"provider": "anthropic", "runtime": "claude", "model": "opus", "effort": null, "transport": "cli"},
  "flags": {"falsification": false, "mode": "adversarial"}
}
```

```text
node "<skill-dir>/scripts/preflight.mjs" --host codex --allow-trial --probe-claude-session --yes-paid --cd "<target>" --run-dir "<run-dir>" --seats seats.json
```

`flags` also takes `timeoutS` (a bound in seconds for a smoke test; the default is no limit) and `repoOnly` (`true` when the packet says web verification is off); see the Claude Code host file for every key. For a smoke run set both. `timeoutS` bounds CLI seats only; a hung native agent is bounded by `--max-wait` on the orchestrator side, so give a native seat `--native-agent` and read its transcript.

Put the run folder inside the folder Codex was started in (the native agent inherits the Codex sandbox, so its
output path must be inside it) but outside the target's git repository, or in a folder that repository
git-ignores: the Claude CLI seat's worktree snapshots the whole repository, so preflight refuses a run folder
in it that is not ignored. Start Codex one level above the repository, or ignore a folder yourself; the skill
never edits the target's `.gitignore`. When `codex doctor` shows a failed sandbox row, add `--skip-codex-doctor`
to the preflight: its `--yes-paid` probe is a nested `codex exec`, which the Codex sandbox blocks.

Keep the target inside the folder Codex was started in too. The run folder must be inside it, or the sandbox cannot
write it (`EPERM` on `run.json`).

Git ownership: on Windows the sandbox runs commands under its own account (`CodexSandboxOffline`), and git refuses any
repository that account does not own, inside the start folder or not (`fatal: detected dubious ownership`). A
repository you created or cloned yourself is refused. Trust it for the review's shell calls only, in the same call as
preflight and review-run, never with `git config --global` (tested with git 2.52):

```powershell
$env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'safe.directory'; $env:GIT_CONFIG_VALUE_0 = 'C:/path/to/target'
```

A Codex session started inside a repository can take ownership of the files it writes there, `.git` included; in an
admin shell `takeown /F <repository>\.git /R /D Y` gives them back (seen on Windows, 2026-11-01).

Three more sandbox limits, seen on Windows on 2026-11-01:

- Settings: the sandbox cannot read `~/.config/review-skills` (`EPERM`). Before `setup`, `show` and `seats`, set
  `REVIEW_SKILLS_CONFIG_DIR` to a folder inside the Codex start folder, in the same shell call (PowerShell:
  `$env:REVIEW_SKILLS_CONFIG_DIR = Join-Path (Get-Location) 'review-settings'`).
- Models: `codex` itself does not run in the sandbox shell, so `codex debug models` cannot check a model. The models
  the agent spawn tool offers are the list to choose from.
- Usage: the spawn tool returns a task name such as `/root/pair_a`, not a thread id. The agent's rollout is the file
  under `~/.codex/sessions/<year>/<month>/<day>/` whose first line holds `"agent_path":"/root/<task name>"` and this
  session's `CODEX_THREAD_ID`. Give it to `phase1 --wait --native-agent <role>=<rollout>`, or afterwards to
  `review-run manifest --seat-transcript <role>=<rollout>`; without it the manifest has no model or usage for that
  agent and the report says so. To find it (PowerShell):

```powershell
Get-ChildItem "$HOME\.codex\sessions" -Recurse -Filter 'rollout-*.jsonl' | Where-Object { $l = Get-Content -LiteralPath $_.FullName -TotalCount 1; $l -match '"agent_path":"/root/pair_a"' -and $l -match $env:CODEX_THREAD_ID } | Select-Object -ExpandProperty FullName
```

## The sequence

1. `phase1 --start` starts seat A (Claude CLI, detached) and prints seat B's brief path and output path.
2. `spawn_agent` for seat B: its model, `fork_turns: none`, a stable task name, a message to read its brief
   from the file and write findings to the printed output path. Never fork the orchestrator conversation.
3. `wait_agent` for B; then `review-run phase1 --run-dir "<run-dir>" --wait --native-done B`
   (or `--native-agent B=<thread id or rollout file>`, which waits on B's rollout instead of your word). Rerun on exit 3
   until seat A completes too.
4. `phase2 --start` resumes seat A (Claude CLI) on its session and prints B's delta brief; send it with
   `followup_task` on the same task name; never replace a seat after the exchange began. Then
   `phase2 --wait --native-done B`.
5. `audit --prepare`, then `audit --finish`: the Claude CLI auditor is dispatched and waited on by the
   sequencer; no spawn is needed.
6. `review-run manifest --run-dir "<run-dir>"` copies `host`, `support` and `host_status`;
   `--seat-transcript B=<rollout file>` records seat B's usage and model (the rollout is
   `~/.codex/sessions/<year>/<month>/<day>/rollout-*-<thread id>.jsonl`).

If the orchestrator dies, resume its thread with `codex exec resume <thread id> -m <the same model>`; a
native agent stays addressable by task name and a Claude seat resumes by its session id.

## Evidence

Observed on 2026-10-05 to 2026-10-07 (Windows, Codex CLI 0.160.x):

- `codex exec -s workspace-write`, no allow rule: a cross-review attempt through the sequencer (Claude CLI seat A and
  auditor, native Codex seat B) completed Phase 1, then failed in Phase 2 with `No conversation found with session ID`;
  `~/.claude/projects` held no session file for any of the three Claude CLI calls. The sequencer reported the failure
  and kept every artifact.
- A live Codex run on its file-tool launch path (reported by that session): the Claude CLI wrote its session under
  `.claude/projects` and resumed the exact session; a manual cross-review through the official phase helpers passed
  (blind exchange, a fresh Claude audit, translated scorecard and manifest); the sequencer's host gate refused it,
  which is what the probe now replaces.
- `claude-dispatch --detach` from `codex exec` failed with `Invoke-CimMethod ... Access denied` (WMI); a plain
  detached start works and the dispatchers fall back to it. A foreground and a detached Claude CLI call each completed
  (model resolved) although `CODEX_SANDBOX_NETWORK_DISABLED=1` was set.
- Nested Codex CLI seats: `codex` was not found in the sandbox shell, and a second trial failed with
  `failed to initialize in-process app-server client: Access is denied. (os error 5)`.
- First complete cross-review on a Codex host (2026-11-01, Windows, interactive Codex started with `--sandbox
  workspace-write --add-dir <home>\.claude\projects`, small target): Claude Haiku as CLI seat A on the final-message
  channel, `gpt-6.1-sol` as native seat B, a Claude CLI auditor. Both seats found the seeded defect, the exchange ran,
  and the auditor confirmed it. Seat A's first file was refused by the format check and its one rewrite passed. The
  manifest leaves out the two paid session-probe calls (it warns); their cost is in `probe-session/*/result.json`.
- The skill never requests escalation, never sets a wider sandbox itself and never bypasses a permission check.

## Orchestrator cost

`CODEX_THREAD_ID` is the thread ID in the orchestrator's rollout file name. Record it with
`review-run manifest --seat-transcript orchestrator=<rollout>@<start>/<end>` (ISO times).
