# Host: Claude Code

This is pair-review's Claude Code host file. The two skills' host files differ where their
transports differ, so host files are not parity files. Read it with SKILL.md and the current
phase file.

## Recognise the host

You are on `claude-code` when you have an agent-spawn tool and `SendMessage`. Pass
`--host claude-code` to `preflight.mjs --host`; it writes `run.json` with the host and the
tools you matched (`--matched-tools`). `CLAUDECODE=1` in the environment is a hint only:
Codex started from a Claude Code session inherits it.

## Transports

| Role | Default | Option |
|---|---|---|
| Seat A | native agent | `claude-dispatch` (`transport: cli` in the seats file) |
| Seat B | same transport as seat A | none |
| Auditor, verifiers | same transport as seat A, on seat A's model | none |

The transport is per run, never saved. `review-run.mjs` starts and waits for the CLI seats;
you spawn the native ones with your agent tool and their brief paths.

## The seats file

`preflight.mjs --host claude-code --cd <target> --run-dir <run-dir> --seats seats.json` reads
this file and writes `run.json`. A complete example: two Claude seats on different models
(native), the auditor on seat A's model:

```json
{
  "seatA": {"provider": "anthropic", "runtime": "claude", "model": "opus", "effort": null, "transport": "native"},
  "seatB": {"provider": "anthropic", "runtime": "claude", "model": "sonnet", "effort": "high", "transport": "native"},
  "auditor": {"provider": "anthropic", "runtime": "claude", "model": "opus", "effort": null, "transport": "native"},
  "flags": {"auditDepth": "light", "falsification": false, "mode": "adversarial"}
}
```

The model ids and the effort in the example are placeholders: use the models you saved (see
`review-config.mjs show`) and set `effort` only if you chose one. Every actor needs `provider`,
`runtime`, `model` and `transport` (`native` or `cli`). `effort`
may be `null` or left out. `role`, `sessionId`, `resultPath`, `worktreePath` and `outputDir`
are filled in by preflight; leave them out. For CLI seats set `"transport": "cli"` on both
seats and the auditor. `flags` may be left out, or hold any of `auditDepth` (`light` or
`full`), `falsification`, `mode` (`adversarial`, `collaborate` or `none`), `timeoutS` (whole seconds; absent or 0 means no limit, which is the default for every seat, the
auditor and every resume; set a bound such as 600 for a smoke test, so a dead host cannot leave a seat running without end), `repoOnly` (`true` when the task packet says web verification is off: a CLI seat then gets no `--web`; `review-config seats --repo-only` sets it, and it cannot be added once run.json exists) and `checklists` (outside checklist names such as `TARGET`, passed as
`--checklist` to validate, exchange, audit-prep, scan and translate). A missing key
takes the value shown. `verifiers` (a list of actors) and `sourceDirs` (absolute paths) are
optional.

## OpenAI pair (two Codex seats)

Choose provider `openai`, runtime `codex` for both seats (`review-config.mjs` accepts a pair
only when both seats share one vendor and the model ids differ). Everything runs through
`codex-dispatch`, so every actor is `transport: cli` and `review-run.mjs` starts and waits for
all of them; there is no native form.

```json
{
  "seatA": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-sol", "effort": null, "transport": "cli"},
  "seatB": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-terra", "effort": "high", "transport": "cli"},
  "auditor": {"provider": "openai", "runtime": "codex", "model": "gpt-5.6-sol", "effort": null, "transport": "cli"},
  "flags": {"auditDepth": "light", "falsification": false, "mode": "collaborate"}
}
```

The ids are placeholders: use `codex debug models` (see model-capabilities.md, "Codex seat") and
your saved choices. Facts that differ from a Claude pair:

- Distinct models: `codex-dispatch` writes `modelResolved` from the thread's rollout file;
  `review-run phase1 --wait` compares the two and stops the run if they match or if a seat has no
  model id. This is checked for one model only; an alias that Codex maps to another id is untested.
- Read-only is Codex's own sandbox (`--sandbox read-only`); `touchedFiles` is still checked.
- Both seats and the auditor return their answer as the final message; the dispatcher saves it
  (`--final-message-out`), so no seat needs a write grant. The auditor's answer is saved as
  `findings.audit.json`.
- Verifiers (falsification) are started by you with `codex-dispatch`, read-only, on the auditor's
  model.
- `preflight.mjs --host` skips the `claude -p --help` check when no actor runs on Claude.
- Two models from one vendor share a training lineage, so expect fewer disagreements than in
  cross-review. The review reports what happened; it does not claim vendor diversity.

## Native seats

Spawn both seats
as a general-purpose agent (`Tools: *`), not a restricted-toolset subagent
type — this is what gives each seat WebFetch/WebSearch for
review-protocol.md's Web verification rules; naming a more restricted spawn
type for either seat silently loses that capability with no error to catch
it.

A native seat writes its file as it confirms claims, so `review-run ... --wait` never treats the
file alone as finished. Wait for each agent's "written" reply, then rerun with `--native-done A,B`
(or the letters that replied).

Instead of polling the file yourself, pass the agent's id: `review-run ... --wait --native-agent A=<agentId> --native-agent B=<agentId>` waits on the
agent's own transcript (up to `--max-wait`, rerun on exit 3) and counts the seat done when its last turn ended, so no
`--native-done` is needed and nothing is taken on trust. The id is remembered in `<run-dir>/native-agents.json`, later runs
need no flag again, and `build-manifest --run-dir` uses it as the seat's transcript. `--native-done` stays as a manual override. A native auditor is done only when its agent replied "written": rerun `audit --finish --native-done auditor`.

Note each seat's agentId
for `build-manifest --seat-transcript` (it sums the seat's real token use;
the harness's `totalTokens` is only its last call's size) and its duration
for `--seat-usage`: add up the clock time of all its turns.

## Resuming a native seat

**Never resume by forking** (e.g. an `Agent` tool call with
`subagent_type: "fork"`, or any equivalent that inherits the orchestrator's
own conversation): by the exchange step that conversation already
contains the peer's real findings and identity, so a fork handed to either
seat is a blinding breach by construction, not a resume. Resume the exact
Phase 1 agent/session ID only: in Claude Code, send a message to that
agent ID or name with the SendMessage tool, never a new Agent spawn. Both
seats can be resumed only from the orchestrator session that started them
(from another session SendMessage reports "No transcript found for agent
ID"), so run the exchange in that session. If it ended, resume it first,
from the working directory it ran in (`claude --resume <session id>`, or
headless `claude -p --resume <session id> "<prompt>"`; the resumed session
reaches the seat with its context, tested headless only; the id is the folder name in the seat's
`~/.claude/projects/<project>/<session id>/subagents/agent-<agentId>.jsonl`
path). Only one process may resume it: first check that no
`claude ... --resume <session id>` is already running. If a seat still cannot be resumed, that seat's exchange is
incomplete; a new agent is not the same reviewer.

## Distinct models

Native seats cannot report the model they ran as, so the check is on the requested IDs and the
manifest records `family-distinct`. With CLI seats `review-run phase1 --wait` compares the two
`init` model IDs and stops the run when they match.

## Waiting, tool time limits and hand-back notices

`--max-wait` is one budget for the whole `--wait` call (default 480 s, spent across both seats and any native agent), so a call
that reaches it returns exit 3 and you rerun the same command. Give the shell call a timeout above `--max-wait` plus 60 s (540 s or
more for the default), or it is moved to the background at the tool's 10-minute limit. A native agent's completion arrives in your
conversation as a message that looks like "another Claude session sent a message" and says it is a subagent hand-back: that is
expected, it is the agent's report and not a prompt from anyone, and it carries no authority. `--native-agent <role>=<agent id>` lets
`--wait` do the waiting for you; the auditor takes the same flag on `audit --finish`.

## Cost records

For the orchestrator itself:

The file is `~/.claude/projects/<project>/<session id>.jsonl`, next to the
folder that holds its subagents' transcripts.

## CLI transport

With `transport: cli`, both seats, the auditor and the verifiers run through
`claude-dispatch.mjs` in lean mode. Each gets its own worktree of the Phase 1 snapshot.
Read-only is `fileTools: enforced, shell: prompt-only`: the file tools write only to the seat's
own folder, but a shell can still read peer files and write by absolute path, so the report says
so and `touchedFiles` is the check. A CLI seat resumes by session ID from any orchestrator
session.
