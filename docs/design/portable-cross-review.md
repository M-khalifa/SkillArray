# Portable cross-review and pair-review for Claude Code and Codex

Status: Revision 2, approved for planning; implementation has not started.
Supersedes the 2026-10-03 draft (SHA-256 `8A1FF81C…6268156`), whose architecture
it keeps and whose scope it narrows.

Date: 2026-10-03. Repository baseline: `30fd93a` (SkillArray 1.0.0). Target
release: 1.1.0.

## 1. Decision and scope

Each of the two review skills, `cross-review` and `pair-review`, ships as one
skill folder that is byte-identical on Claude Code and Codex. The skill reads
one short host reference for the application it runs in, and starts reviewers
through runtime adapters. The review protocol, phase gates, blinding rules and
report formats do not change.

- cross-review keeps one Claude reviewer (seat A), one OpenAI or OpenCode
  reviewer (seat B), adversarial exchange, and a fresh auditor on seat A's model.
- pair-review keeps two distinct Claude models, its `collaborate`,
  `adversarial` and `none` modes, and a fresh auditor in every mode. Under Codex
  it runs two external Claude sessions; it never becomes a pair of OpenAI models. (Superseded, pending approval: see openai-pair-review-and-benchmark.md section A.)
- The Claude Code path stays the default and keeps its native agents.
- `shared-brain`, a native Codex seat, arbitrary seat layouts and unattended
  coordination are out of scope.

Success means a user's saved reviewer choices complete a validated review, with
the same snapshot, gates, scorecard and manifest, from either host. It does not
mean two model runs produce the same findings.

The design favors three properties in this order: correct and honest records,
low token use per review, and few orchestrator turns.

## 2. Terms

| Term | Meaning | Values |
|---|---|---|
| Host | The application executing the skill and its orchestrator | `claude-code`, `codex` |
| Provider | The organization serving a reviewer's model | `anthropic`, `openai`, OpenCode-routed providers |
| Runtime | The model family's execution environment | `claude`, `codex`, `opencode` |
| Transport | How the orchestrator reaches a seat | `native` (host agent tool), `cli` (dispatcher script) |

Transport is resolved per run from the host and run flags. It is never saved in
preferences.

## 3. Evidence

Probes ran on Windows 11 with Claude Code 2.1.288 and Codex CLI 0.160.0, using
haiku seats on a one-line Python target. Rows marked "to verify" come from
documentation or from files seen on disk; every other row was observed.

| Question | Observation |
|---|---|
| Can a Claude seat run headless without prompts? | Yes: `claude -p --permission-mode dontAsk` never prompts; refused calls are listed in the result's `permission_denials`. |
| Real model identity | The `system/init` event names the served model (`claude-haiku-4-5-20251001` for alias `haiku`). |
| Usage | The `result` event carries `usage`, `modelUsage` and `total_cost_usd`. |
| Resume | `--resume <session_id>` with the full lean flag set (section 7) continues the same session: it recalled a codeword from the first call, appended to its output file, and read 33,970 of 34,836 input tokens from cache. |
| Write scope | `--allowedTools "Edit(//c/<abs run dir>/**)"` allows `Write` there; an `Edit` on the target was refused. The forms `Write(...)`, `//C:/...` and relative paths did not match. |
| Startup cost | Default flags: about 46k context tokens (293 tools, 8 MCP servers, 145 skills). Lean flags (section 7): 10.3k. |
| User instructions | Default flags load `~/.claude/CLAUDE.md`. Lean flags do not. |
| Target instructions | The target's own `CLAUDE.md` is not loaded automatically under lean flags; a seat can still read it as a target file. |
| Read scope | Under `--restricted`, file tools cannot read outside the working directory and `--add-dir` paths; a read of a sibling folder was refused. |
| Shell | `Bash` runs commands (the target's code executed). The refusal text for a denied edit invites the seat to "attempt ... using other tools", so a shell can still write the target. |
| `--bare` | Accepts only `ANTHROPIC_API_KEY` or an API key helper; it cannot use a subscription login. |
| Inherited key | `ANTHROPIC_API_KEY` was set in the orchestrator's shell; a child would bill the API instead of the subscription. |
| Web tools | `--restricted --tools ...,WebFetch,WebSearch` exposes both. |
| Existing guard | `codex-dispatch.mjs` refuses to overwrite a finished final message without `--replace-completed` (lines 904, 1116). It does not detect a turn interrupted mid-delivery. |
| Codex skills | To verify: Codex reads user skills from `~/.agents/skills` (skills installed there by the skills CLI were seen, not seen loading). Plugins with both `.claude-plugin` and `.codex-plugin` manifests and an `.agents/plugins/marketplace.json` already install on this machine. |
| Codex agents | `codex features list` reports `multi_agent` stable and `multi_agent_v2` not stable; the native agent interface is still changing. |

Not yet observed, and assigned to milestone 0: behavior from inside a Codex
sandbox, the Codex tool names used for host detection, the Codex rollout path
for the orchestrator's own session, the Codex skill invocation syntax, lean
flags with larger models and `--effort`, and cache sharing across seats.

## 4. Requirements

Functional:

- Setup, config, reset and review commands work on both hosts.
- Independent passes run concurrently where the host allows; sequential
  execution is disclosed.
- Exchange continues the original reviewer sessions, never fresh replacements.
- Falsification and full-audit stay opt-in, triggered by the same phrases.
- Interrupted or unsupported work is reported incomplete.

Correctness:

- Neither reviewer sees the other's findings before the exchange gate.
- Reviewers, verifiers and the auditor never inherit the orchestrator's
  conversation.
- The orchestrator never fills a seat and never rewrites model-authored output.
- Requested and observed model and effort stay separate; unknown is `null`.
- The manifest records host, transport and the enforced protections per seat.

Operational:

- Node.js 22+; Windows, Linux and macOS as today.
- The skill never changes authentication, installs CLIs, escalates sandbox
  permissions, or bypasses permission checks.
- No silent fallback between providers, models, runtimes or transports.
- Each skill folder stays self-contained; neither imports the other.

## 5. Execution matrix

Superseded where it describes pair-review as Claude-only: pair-review may also be two OpenAI models on a Claude Code host (`openai-pair-review-and-benchmark.md`, section A). The Codex-host cells are replaced by the per-transport matrix in `native-codex-host.md`.

cross-review:

| Host | Seat A (Claude) | Seat B | Auditor and verifiers |
|---|---|---|---|
| Claude Code | Native agent (default) or `claude-dispatch` (`transport: cli` in the seats file) | `codex-dispatch` or `opencode-dispatch` | Same transport as seat A, seat A's model |
| Codex | `claude-dispatch` | `codex-dispatch` or `opencode-dispatch` | `claude-dispatch`, seat A's model |

pair-review:

| Host | Seat A | Seat B | Auditor and verifiers |
|---|---|---|---|
| Claude Code | Native agent (default) or `claude-dispatch` | Same transport as seat A | Same transport, seat A's model |
| Codex | `claude-dispatch` | `claude-dispatch` | `claude-dispatch`, seat A's model |

Seat B stays on `codex-dispatch` on both hosts: it is the proven route and keeps
the CLI-enforced `--sandbox read-only` and exact-session resume. Running in Codex
never replaces the auditor with the current Codex model. A user may still name a
different auditor explicitly for one run.

With the `cli` transport, Phase 2 no longer has to run in the session that
started Phase 1; any orchestrator session can resume a seat by its session ID.

## 6. Host detection

SKILL.md carries a four-row table. The orchestrator matches the tools it
actually has:

| Tools present | Host |
|---|---|
| An agent-spawn tool and `SendMessage` | `claude-code` |
| The Codex agent family (`spawn_agent` and its send and wait tools; exact names from milestone 0) | `codex` |
| Both, or neither | Ask the user |

Environment variables (`CLAUDECODE=1` under Claude Code) and installed CLIs are
hints only; both CLIs are often installed. The host is never inferred from seat
A's model or from the existence of `~/.claude` or `~/.codex`. The orchestrator
passes `--host` to `preflight.mjs`, which records it with the matched tool names
in the run directory and refuses a host whose required dispatchers are missing.

## 7. Claude CLI adapter: `scripts/claude-dispatch.mjs`

Shipped in both skills and added to the byte-parity list. Its flags and
`result.json` schema match `codex-dispatch.mjs`, so `build-manifest`,
`exchange` and `review-run` treat all CLI seats alike.

Interface: `--brief --cd --model [--effort] [--session] [--out-dir] [--isolate
--worktree <path>] [--web] [--wait] [--timeout] [--replace-completed]
[--use-api-key]`. Detached start and `--wait` reuse `spawn-utils.mjs`.

Command, with the brief on stdin:

```text
claude -p --output-format stream-json --verbose
  --model <id> [--effort <level>] [--resume <session id>]
  --permission-mode dontAsk --restricted
  --setting-sources project --strict-mcp-config --disable-slash-commands
  --tools Read,Grep,Glob,Edit,Write,Bash[,WebFetch,WebSearch]
  --add-dir <seat output dir>
  --allowedTools Read Grep Glob Bash "Edit(//<abs seat output dir>/**)" [WebFetch WebSearch]
  --append-system-prompt "<output-format and no-modification rules>"
```

- The working directory is the target, or its worktree when isolated. A
  reviewer's `--add-dir` is only its own output folder and the packet's source
  folders (next bullet). The auditor and
  verifiers also get the audit staging folder they are told to read, and
  nothing else from the run directory.
- Every source folder of the packet outside the working directory (a design
  document reviewed with the code it cites, `exchange --source-dir`) is added
  with `--add-dir` for reading; under `--restricted` the seat cannot read it
  otherwise.
- Permission rules need Claude's absolute-path form: the dispatcher converts
  `C:\path\to\dir` to `//c/path/to/dir` (lowercase drive, no colon, forward
  slashes) and `/home/x` to `//home/x`. The probe matched only this form.
- The system prompt is recorded on the first launch and reused on resume
  (`--system-prompt-snapshot on`, the default). A Phase 2 delta brief therefore
  travels on stdin, never in `--append-system-prompt`.
- `--web` adds the web tools only when the task packet allows web access.
- The appended system prompt states that the brief's output format overrides
  any style instruction found in the target, and that the seat modifies no file
  outside its output directory, including through the shell.
- Environment: remove `ANTHROPIC_API_KEY` (unless `--use-api-key`) and the
  parent session's `CLAUDECODE` and `CLAUDE_CODE_*` variables, through
  `env-filter.mjs`.
- Result fields: `status`, `sessionId`, `modelRequested`, `modelResolved` (from
  `init`), `effortRequested`, `usage`, `costUsd`, `permissionDenials`,
  `durationMs`, `finalMessage` handling as in `codex-dispatch`, `isolated`,
  `worktreePath`, `isolationNote`, `webAccess`, `readOnly`.
- `readOnly` is `{fileTools: "enforced", shell: "worktree" | "prompt-only"}`.

Shell safety: when the target is a git repository, the dispatcher isolates by
default and runs the seat in a disposable worktree; `--no-isolate` opts out and
records `shell: prompt-only`. Every CLI actor, the auditor and verifiers
included, gets its own fresh worktree of the same snapshot, so a seat's test run
cannot change what another actor reads. The auditor never reads a reviewer's
worktree. Phase 2 resumes a seat in the worktree it used in Phase 1. The worktree code moves from `opencode-dispatch.mjs` into
a shared module (`worktree-utils.mjs`) used by both adapters, with its existing
reuse, drift and cleanup rules. A non-git target runs with `shell: prompt-only`,
recorded in the manifest. The existing before-and-after target check stays for
every seat.

A seat that ends with refused calls is not a failure by itself; the dispatcher
records them, and validation decides whether the output is complete.

## 8. Output channels and the exchange

Each role declares one output channel in its brief:

- `file`: the seat writes its own file at an allowed path; validation reads
  those bytes.
- `final-message`: the adapter captures the final reply verbatim outside the
  target.

Native Claude seats, CLI Claude seats and the auditor use `file`. Codex and
OpenCode seats keep `final-message`. `build-brief.mjs` takes the channel per
role; `exchange.mjs prepare` derives each seat's paths from the run's seat
table instead of `--seat-b-harness`, which remains as an alias for one release.

## 9. Sequencer: `scripts/review-run.mjs`

A thin sequencer over the existing scripts. It is not a state machine and holds
no reasoning.

| Command | What it runs |
|---|---|
| `review-run phase1` | Starts every CLI seat of the run at once, waits, runs `blind-relabel validate` |
| `review-run phase2` | `exchange prepare`, resumes every CLI seat, waits, `exchange finish` |
| `review-run audit` | `flip`, `audit-prep`, `build-brief --mode auditor`, the auditor dispatch when it is a CLI seat, `translate`, `scorecard` |

Each command prints at most ten lines plus one `next:` line naming the next
action or the failure to fix. Each phase command has two halves: `--start`
launches the CLI seats and returns, and `--wait` waits for every seat's output
file (native seats included) and runs the gate. On Codex the orchestrator runs
both halves in one call. On Claude Code it runs `--start`, starts the native
seat with its agent tool, then runs `--wait`.

If a step fails, the sequencer stops, leaves every artifact in place, and names
the failed step; the orchestrator fixes it under the phase file's existing
rules. The boundary: the sequencer may only call scripts the phase files already
name, in the order they name them.

## 10. Configuration

The saved preference files and their version do not change. Seat entries keep
`provider`, `runtime`, `model` and `effort`. Consequences:

- No migration, and a preference file written by either host is read by the
  other.
- `review-config.mjs` keeps its layout rules (cross-review: seat A
  `anthropic/claude`, different providers; pair-review: two `anthropic/claude`
  seats). It gains no host field. Superseded for pair-review, pending approval: see
  openai-pair-review-and-benchmark.md section A.
- Run flags, not saved settings: `--host` and the existing per-run overrides. The
  Claude seat transport is `transport: native|cli` in the seats file (default
  `native` on Claude Code, forced `cli` on Codex).
- pair-review distinctness: with `cli` seats, `review-run phase1` compares the
  two `init` model IDs and stops the run if they match. With native seats the
  check stays at distinct requested IDs, recorded as `family-distinct`.

## 11. Usage and provenance

- CLI Claude seats: usage and cost from `result.json`; working time from the
  session file under `~/.claude/projects/<cwd slug>/<session>.jsonl`. The
  existing transcript parser was written for subagent and session files; a
  fixture from a `-p` session confirms it before release (milestone 1).
- Codex orchestrator: `build-manifest --seat-transcript
  orchestrator=<rollout.jsonl>@<start>/<end>` reads Codex rollout token events.
  The rollout parsing in `codex-dispatch.mjs` (around line 733) moves into a
  shared module used by both.
- Native seats: unchanged.
- Each seat entry adds `host`, `transport` and `readOnly`. Missing usage is
  `null` with a reason, never zero.

## 12. Blinding identity terms

`blind-relabel.mjs` adds runtime and host terms to its fixed inventory: CLI
names, agent-tool names and the short Claude model aliases. Each new term gets a
positive fixture and a target-derived exemption fixture. Seat metadata (host,
transport, model) never enters a blinded brief or the audit staging folder.

Lean CLI seats also enforce blinding for file tools: a seat's `--add-dir` covers
only its own output folder and the packet's source folders, so it cannot read
the peer's folder or the mapping files. The shell is still bounded only by the worktree or the prompt.

## 13. Documentation layout and read budget

```text
SKILL.md                         host-neutral; host table; phase checklist
references/hosts/claude-code.md  native spawn, SendMessage, no-fork, transcripts,
                                 scratchpad, background-shell setting
references/hosts/codex.md        detection names, sandbox prefix rule, dispatch
                                 and wait commands, rollout path, invocation
references/phase-*.md            actions named without tool names
```

A run reads SKILL.md, one host file (about 80 lines), and the current phase
file. Claude-only paragraphs move from the phase files into the Claude Code host
file, so the phase files shrink for both hosts. Install commands and the
`/cross-review` and `$cross-review` examples live in the README, not in the
phase files.

## 14. Codex sandbox

Superseded in 1.1.0 by the milestone-0 result: no working route was found, `preflight.mjs --host codex` does not try a probe dispatch (it refuses a Codex host unless `--allow-unsupported-host` is passed), and the cells are named unsupported in the release notes. The per-transport replacement is in `native-codex-host.md`.

Dispatchers run as host shell commands and inherit the Codex sandbox. Starting
`claude -p` or `codex exec` needs network access and writes to the user's
session stores. The supported setup is a user-approved Codex prefix rule for
`node <skill dir>/scripts/*-dispatch.mjs` and `review-run.mjs`, documented in
the Codex host file. `preflight.mjs --host codex` tries one minimal dispatch and,
if it is blocked, prints the rule to add. The skill never requests escalation on
its own. If milestone 0 finds no working route without a permission bypass, the
affected matrix cells leave the release and are named in the release notes.

## 15. Packaging and installation

- `plugins/reviews/.codex-plugin/plugin.json` beside the existing
  `.claude-plugin/plugin.json`, and a repository-root
  `.agents/plugins/marketplace.json`.
- `validate-repository.mjs` checks both manifests, versions and the parity list,
  which gains `claude-dispatch.mjs`, `worktree-utils.mjs`, the rollout module,
  the host files and their tests. `release-check.mjs` checks the versions match.
- Manual Codex install copies both skill folders to `~/.agents/skills`. The
  local maintainer install backs up and removes the older copies there before
  installing.
- Test installing each skill alone and both together on each host.

## 16. Testing

Deterministic (CI):

- `claude-dispatch.test.mjs` with a fake `claude` binary emitting stream-json:
  success, refused calls, resume, empty final message, `--replace-completed`,
  key removal, isolation on and off. Run the timeout and kill path 5 to 10
  times.
- `build-manifest` fixtures: a CLI Claude session file and a Codex orchestrator
  rollout.
- `review-run` with fake dispatchers: success, stop on the first failed step,
  the pair-review same-model stop, mode `none` skipping exchange.
- Exchange output channels preserve bytes; the alias still works.
- Identity-term fixtures; no seat metadata in blinded files.
- Both existing suites (cross 544, pair 390) stay green.

Live (opt-in, uses account quota):

| Workflow | Claude Code host | Codex host |
|---|---|---|
| cross-review | Native A + Codex B; CLI A + Codex B | CLI A + Codex B |
| pair-review | Native A and B, modes collaborate, adversarial, none | CLI A and B, same three modes |

Run first on `bench/cases/fixture-trivial-defect`, then on one real target per
host. Include an interrupted exchange and a lost session. Compare gates,
artifacts and report completeness, not prose or finding counts. Measure, with
`bench/run-comparison.mjs`, token cost and recall of native versus CLI Claude
seats on Claude Code; that result decides whether the CLI path becomes the
default in a later release.

## 17. Milestones

| # | Work | Exit condition |
|---|---|---|
| 0 | Spike from a default-sandbox Codex session: host tool names and rollout path; detached dispatch survival and required approvals; skill invocation syntax, plugin install and whether `agents/openai.yaml` is needed; lean flags with the largest selectable models and `--effort`; whether `--exclude-dynamic-system-prompt-sections` lets seats share cache | Evidence table added to section 3; any out-of-scope cell named |
| 1 | `claude-dispatch`, `worktree-utils`, rollout module, output channels, identity terms, manifest fields | Deterministic tests green on both skills |
| 2 | Host files, host-neutral SKILL.md and phase files, `review-run`, preflight host check | Claude Code regression run passes with the native path unchanged |
| 3 | Packaging, README install guide, live matrix | Every matrix cell passes or is named; release 1.1.0 |

## 18. Deferred items

| Item from the earlier draft | Reason | Trigger to add it |
|---|---|---|
| Version 3 preference schema and migration | Transport is per run; saved settings are unchanged | A saved per-seat transport or a saved non-default auditor is needed |
| Controller state machine, locks, session ownership registry, `delivery-unknown` handling | No observed failure needs them; `--replace-completed` guards finished answers | A Phase 2 brief is delivered twice, or two orchestrators drive one run |
| Shared-source build generator | The byte-parity check already enforces identical copies | The shared list passes about 30 files, or a parity miss reaches a release |
| `host-selection.md`, `recovery.md`, `schemas/`, `runtime-probe.mjs` | Covered by the SKILL.md host table, the host files and `preflight` | — |
| `agents/openai.yaml` | Need not shown yet | Milestone 0 shows Codex triggers the skill wrongly without it |
| Native Codex seat B | The native agent interface is not stable | It passes clean context, continuation, per-spawn model choice and read-only tests |

## 19. Risks

| Risk | Response |
|---|---|
| Claude CLI flags change | `preflight` checks `claude -p --help` for each lean flag; a missing flag stops the run before dispatch |
| Shell writes to a non-git target | Recorded as `shell: prompt-only`; the before-and-after target check reports any change |
| Lean seats behave differently from native seats | The bench comparison in section 16 before any default change |
| Subscription limits shared by several seats | Concurrency is visible in the plan; a rate-limit error is a failed dispatch, not a silent retry on another model |
| Codex sandbox blocks dispatch | Prefix rule; cells named out of scope if no route works |
| The sequencer grows into a framework | It may only call scripts the phase files name, in their order |
| pair-review mistaken for two OpenAI models on Codex | SKILL.md, setup and the manifest state Claude seats explicitly |

## 20. Acceptance criteria

1. Each skill folder is byte-identical in the Claude Code and Codex installs.
2. Every live matrix cell in section 16 completes, or the release notes name it
   as unsupported.
3. Seats and auditor start clean; exchange continues the original sessions.
4. Every phase passes the shared gates; incomplete runs say so.
5. The manifest records host, transport, requested and observed model, usage
   source and `readOnly` for every seat.
6. Existing Claude Code behavior, preferences and tests are unchanged when no
   new flag is used.
7. Clean installs pass on both hosts, each skill alone and both together.
