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

Why the probe: in two `codex exec` runs (2026-10-07) a Claude CLI call left no session file under
`~/.claude/projects`, and Phase 2's resume of seat A failed with `No conversation found with session ID`; in a
live Codex run launched another way (2026-10-07, file-tool launch path) the same CLI wrote its session and
resumed it. The skill does not guess which launch it is in: `--probe-claude-session` makes two small Claude
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
  "flags": {"auditDepth": "light", "falsification": false, "mode": "adversarial"}
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
6. `build-manifest --run-dir "<run-dir>"` copies `host`, `support` and `host_status`;
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
- The skill never requests escalation, never sets a wider sandbox itself and never bypasses a permission check.

## Orchestrator cost

`CODEX_THREAD_ID` is the thread ID in the orchestrator's rollout file name. Record it with
`build-manifest --seat-transcript orchestrator=<rollout>@<start>/<end>` (ISO times).
