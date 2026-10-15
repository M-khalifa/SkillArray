# Host: Codex

This is pair-review's Codex host file. The two skills' host files differ where their transports
differ, so host files are not parity files. Read it with SKILL.md and the current phase file.

Support is decided per actor (`scripts/host-support.mjs`), not per host. On a Codex host:

| Actor | Route | Status |
|---|---|---|
| Codex seat, auditor (an OpenAI pair) | native agents: `spawn_agent` + `followup_task` | **trial**, needs `preflight --allow-trial` |
| Claude seat (a Claude pair) | CLI (`claude-dispatch`) | **trial only after a session probe** (`preflight --host codex --allow-trial --probe-claude-session --yes-paid`): whether a Claude CLI session survives a call depends on how Codex was launched; without the probe the seat is refused |
| Claude auditor, verifiers | CLI, one call each (started as a plain detached process: WMI is refused in a Codex sandbox, so `--detach` falls back) | trial, needs `preflight --allow-trial` |
| Codex CLI seat (nested) | CLI | unsupported: the Codex sandbox blocks a nested start; no override |
| Claude native agent | none | cannot exist: the host spawner offers only OpenAI models |

So on Codex a pair-review is **two native OpenAI models** (this file's sequence), or two Claude CLI processes only after the
session probe passes (the sequencer then does the starting and waiting, as on Claude Code; see cross-review's Codex host file
for the probe). "Trial" means the route runs but has not yet completed a
full run through the sequencer; the manifest records `host_status: trial` and the per-actor `support` rows.

## Recognise the host and write run.json

The Codex agent tool names are not part of the host table in SKILL.md, so pass `--host codex`.
`CODEX_THREAD_ID`, `CODEX_CI` and the other `CODEX_*` variables are hints only: Claude Code started
from Codex, and Codex started from Claude Code, inherit each other's markers.

```json
{
  "seatA": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-sol", "effort": null, "transport": "native"},
  "seatB": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-terra", "effort": null, "transport": "native"},
  "auditor": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-sol", "effort": null, "transport": "native"},
  "flags": {"auditDepth": "light", "falsification": false, "mode": "collaborate"}
}
```

```text
node "<skill-dir>/scripts/preflight.mjs" --host codex --allow-trial --cd "<target>" --run-dir "<run-dir>" --seats seats.json
```

`flags` also takes `timeoutS` (a bound in seconds for a smoke test; the default is no limit) and `repoOnly` (`true` when the packet says web verification is off); see the Claude Code host file for every key. For a smoke run set both. `timeoutS` bounds CLI seats only; a hung native agent is bounded by `--max-wait` on the orchestrator side, so give a native seat `--native-agent` and read its transcript.

Without `--allow-trial` the trial route is refused; with it, `run.json` carries `support[]` and every
later script reads it. Put the run folder inside the folder Codex was started in (the native agents
inherit the Codex sandbox, so their output paths must be inside it) and never inside the target (the
source-fingerprint checks hash the target at every phase boundary). With a Claude CLI seat it must also be
outside the target's git repository, or in a folder that repository git-ignores: that seat's worktree
snapshots the whole repository, so preflight refuses a run folder in it that is not ignored. When
`codex doctor` shows a failed sandbox row, add `--skip-codex-doctor` to the preflight: its `--yes-paid`
probe is a nested `codex exec`, which the Codex sandbox blocks.

## The sequence

`review-run.mjs` cannot spawn agents; for a native actor it prints the brief path, then waits for the
agent's file plus `--native-done`. You do the spawning with the Codex agent tools:

1. `phase1 --start` builds both briefs (file channel) and prints each seat's brief path.
2. `spawn_agent` per seat: the seat's model, `fork_turns: none`, a stable task name, a message that says
   to read its brief from the file and write findings to the output path the sequencer printed. Start
   both before waiting. Never fork the orchestrator conversation into a seat.
3. `wait_agent` for each; when both replied "written", run
   `review-run phase1 --run-dir "<run-dir>" --wait --native-done A,B`. Or pass each agent's thread id or rollout file as
   `--native-agent A=<thread id> --native-agent B=<thread id>`: the sequencer then waits on the rollout (done at
   `task_complete`) instead of trusting your word.
4. `phase2 --start`, then `followup_task` on the same task name with the delta brief path; never replace
   a seat after the exchange began. Then `phase2 --wait --native-done A,B`.
5. `audit --prepare`; spawn the auditor with a new `spawn_agent`, `fork_turns: none`, only the anonymous
   audit inputs; then `audit --finish --native-done auditor`.
6. Manifest: `build-manifest --run-dir "<run-dir>"` copies `host`, `support` and `host_status`;
   `--seat-transcript A=<rollout file>` (and `B=`, `auditor=`) records each agent's usage and the model in
   its rollout. `~/.codex/sessions/<year>/<month>/<day>/rollout-*-<thread id>.jsonl` is the file; the
   orchestrator thread's `findChildThreads` locates the spawned ones by `agent_path`.

If the orchestrator dies, resume its thread with `codex exec resume <thread id> -m <the same model>`;
a native agent stays addressable by task name (shown once with a probe agent: one follow-up and a
`wait_agent` answered after a resume).

## What a trial does and does not give

| Property | Native Codex (trial) |
|---|---|
| Source edits | a prompt rule plus the snapshot-hash check at every phase boundary; no sandbox stops an edit (the same as a native Claude seat on Claude Code) |
| Model identity | `build-manifest` reads the rollout `turn_context` model: the model the thread was configured with. `review-run --wait` prints "requested ids differ; effective distinctness unverified" because no result.json exists yet; the manifest gives the later, better figure |
| Usage | the rollout's token counters |
| `readOnly` in the manifest | not recorded for a native seat |

## Evidence behind the table

- One complete run through the sequencer by a `codex exec` orchestrator (2026-10-07, small target): both native agents found the seeded defect, the exchange, a fresh native auditor, the scorecard and the manifest completed in about 11 minutes with no script failure. The cell stays a trial until a second run on a real target completes.
- Native `spawn_agent` of OpenAI models with `fork_turns: none`, `followup_task` by task name and a fresh
  native auditor completed a full review by hand (2026-10-07); each spawned agent has its own rollout with
  the model and token usage; `codex exec` (non-interactive) exposes `spawn_agent`, `followup_task`,
  `wait_agent`, `wait`, `send_message`, `list_agents` and `interrupt_agent`.
- Nested CLI seats: `codex` was not found in the sandbox shell; a second trial failed with
  `failed to initialize in-process app-server client: Access is denied. (os error 5)`; a detached start was
  refused once (WMI access denied); a 47 s resume died with the turn.
- A foreground `claude-dispatch.mjs` run and a plain detached `claude-dispatch` worker each completed from
  `codex exec` (the WMI start was refused with `Access denied`, so `--detach` falls back to a plain detached
  process). In two `codex exec` runs no Claude CLI call left a session file under `~/.claude/projects` and a Phase 2
  resume failed with `No conversation found with session ID`; in a live Codex run on another launch path the session was
  written and resumed. So a Claude seat is gated on a probe, and a single-call actor (the auditor) needs none.
- The skill never requests escalation, never sets a wider sandbox itself and never bypasses a permission check.

## Orchestrator cost

`CODEX_THREAD_ID` is the thread ID in the orchestrator's rollout file name. Record it with
`build-manifest --seat-transcript orchestrator=<rollout>@<start>/<end>` (ISO times). An `--ephemeral` run
writes no rollout, so a review is never run that way.
