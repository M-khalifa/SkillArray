# Native Codex host and per-transport support — design, draft 2

Status: design agreed in outline by the user (full scope; the user left the isolation and flag
questions to the maintainer after an advisor review; the maintainer runs the live Codex trial).
Nothing is built yet. Version stays 1.1.0. Inputs: the 1.1.0 end-to-end cross-review (run
`review-7-xr`, findings F15, F16, F19, F20, F21), the Codex-native review run
`pair-review-native-495364c0`, and field feedback from the gravemind session.

## 1. Principle

Support is decided per (host, actor runtime, transport), never per host. Today preflight asks "which
host?" and refuses the whole Codex host. The evidence shows some cells work and some cannot.

| Evidence | Cell it proves |
|---|---|
| Native Codex agents: explicit model, `fork_turns: none`, followed up by task name, fresh native auditor; each spawned agent has its own rollout with `turn_context` model and token usage (checked on the three real rollouts: models `gpt-5.6-terra`, `gpt-6-luna`, `gpt-5.6-terra`; usage 4.1M, 4.0M, 0.5M input tokens) | Codex host, OpenAI actor, native: **runs, orchestrated by hand** |
| Foreground `claude-dispatch.mjs` launch and same-session resume, about 10 s each, from inside Codex | Codex host, Claude actor, cli foreground: **short calls only; the sequencer cannot do it** |
| A 47 s resume ended with the Codex turn (result stayed `running`); detached start refused once (WMI access denied) | Codex host, cli detached or long foreground: **not reliable** |
| `codex` not found in the sandbox shell; `os error 5` on `~/.codex/tmp` (two trials) | Codex host, OpenAI actor, nested cli: **blocked by sandbox policy, not by path discovery** |
| The host's native spawner offers only OpenAI models (`sonnet` was rejected) | Codex host, Claude actor, native: **cannot exist** |
| The Claude Code agent tool runs Claude models only | Claude Code host, OpenAI actor, native: **cannot exist** |

## 2. Which skill the Codex cells serve (the user's target, answered plainly)

- **pair-review, two OpenAI models, on a Codex host:** reachable now as a **trial**, with native
  Codex agents for both seats and the auditor. This is the only Codex-host cell this design opens.
- **cross-review on a Codex host:** a trial **when the session probe passes** (section 7): the Claude CLI seat's session may or may not
  survive on a given Codex launch, so preflight proves it with two small calls instead of assuming either way.
- **pair-review, two Claude models, on a Codex host:** the same, probe-gated.
- Claude Code host: all current cells stay as they are; the OpenCode seat is a behaviour change (below).

## 3. Support table in code, enforced where `run.json` is read

New parity file `scripts/host-support.mjs` holds the table and `validateSupport(descriptor)`.
`run-descriptor.mjs` calls it on every read and write (as it does for F14's native-runtime check), so
a hand-edited `run.json` is caught by the sequencer, not only by preflight. `preflight --host` calls
the same function and reports per actor.

| Host | Runtime | Transport | Status |
|---|---|---|---|
| claude-code | claude | native | supported |
| claude-code | claude | cli | supported |
| claude-code | codex | cli | supported |
| claude-code | opencode | cli | **trial** (never run end to end) |
| claude-code | codex, opencode | native | unsupported |
| codex | codex | native | trial |
| codex | claude (auditor, verifiers) | cli | **trial** (single call; the detached start falls back to a plain detached process when WMI is refused) |
| codex | claude (seats A, B) | cli | **probe**: a trial only when `preflight --probe-claude-session --yes-paid` proves the session survives a call on this launch (it did not in two `codex exec` runs and did in another Codex launch path); refused otherwise |
| codex | codex, opencode | cli | unsupported (nested CLI is blocked by the sandbox) |
| codex | claude, opencode | native | unsupported |

Mechanism (how "enforced on every read" and "needs `--allow-trial`" fit together): the descriptor reader
has no flags, so the flag acts at write time. `preflight --host` evaluates every actor; an unsupported actor
refuses the run with no override; a trial actor is accepted only with `--allow-trial`, and preflight then writes
`support: [{role, runtime, transport, status}]` and `hostStatus: supported | trial` into `run.json`.
`validateSupport` runs on every read and write: it refuses any unsupported actor outright, and accepts a trial
actor only when `support[]` is present and names that actor as trial; a trial actor without `support[]` fails with
"run preflight --host with --allow-trial". `build-manifest` reads `support[]` from `<run-dir>/run.json`, found from
a new `--run-dir` argument (the existing `skill-versions.jsonl` lookup stays folder-relative to `--out`), and
copies it, so a report reader sees the label.

Test consequences, listed so they are not read as regressions: every test helper that writes `run.json`
directly with an OpenCode seat (`opencodeSeat`, the final-F4, F5 and F10 tests, R2-F8, F9 and the descriptor
tests) must also write `support[]`; the F14 test (today reached with `--host codex --allow-unsupported-host`)
becomes "`--host codex` with a native Claude auditor is refused as unsupported, no flag"; the "codex host is
refused" test becomes "native Codex seats need `--allow-trial`; without it refused; with it `hostStatus: trial`".

`--allow-unsupported-host` is **removed, with no alias**: it was added during 1.1.0 and 1.1.0 is not
released, so nothing shipped with it, and its meaning splits under this table (trial cells open with
`--allow-trial`, unsupported cells have no override). Consumers found by search: `preflight.mjs`, its
test, both Codex host files and CHANGELOG; the Codex review run's temporary launch files are not part of
the repository.

**Visible behaviour change to confirm with the user:** a saved cross-review configuration with an
OpenCode seat B starts needing `--allow-trial` after this step. That is honest (the cell was never
verified) but it is a change for anyone using it.

## 4. Output channel by transport (finding F15)

`channelFor(actor)` follows the runtime today, so a native Codex agent gets a final-message brief while
the sequencer waits for a findings file. Change: native transport is always `file`; cli keeps `file` for
Claude and `final-message` for Codex and OpenCode. Native Codex fixtures join the `review-run` and
`exchange` tests; the Claude Code native path's tests are the regression gate because `channelFor`
feeds the sequencer, `exchange.mjs` and the auditor brief.

## 5. Native Codex orchestration (host file) and what it provides

The sequencer cannot spawn agents; for a native actor it prints the brief path and waits for the file
plus `--native-done`. The Codex host file gets the sequence the native review run used:

1. `spawn_agent` per seat: explicit model, `fork_turns: none`, a stable task name, the Phase 1 brief
   path and the seat's own output path. Never fork the orchestrator conversation.
2. Start both before waiting; run `review-run phase1 --wait --native-done A,B` once both reply.
3. Exchange: `followup_task` on the same task name with the delta brief; never replace a seat.
4. Auditor: a new `spawn_agent`, `fork_turns: none`, only the anonymous audit inputs; then
   `audit --finish --native-done auditor`.
5. Cost and identity: `build-manifest` accepts the spawned thread's rollout as
   `--seat-transcript <role>=<rollout .jsonl>` for a native Codex seat (it already does for the
   orchestrator), and calls `rolloutModel` and `rolloutUsage` on it. `findChildThreads` locates the rollouts
   from the orchestrator thread and `agent_path`.

How the trial compares (the same guarantee the supported native Claude cell has today):

| Property | Native Claude (supported today) | Native Codex (trial) | CLI Codex |
|---|---|---|---|
| Source edits | prompt rule + snapshot hash at every phase boundary (F3-F6); host file: "no sandbox stops a source edit" | the same | sandbox `read-only`, enforced |
| Model identity | not observable; recorded `family-distinct` | rollout `turn_context` model (configured model, the same evidence the CLI path records as `modelResolved`) | rollout `turn_context` model |
| Usage | transcript | rollout | rollout |
| Manifest `readOnly` | absent | absent, same treatment | `fileTools/shell enforced` |

At `--wait` there is no `result.json` for a native seat, so the sequencer prints "requested ids differ; effective
distinctness unverified"; the manifest later records the rollout `turn_context` model. The two outputs are
consistent: the first is the gate's evidence at that moment, the second is the later, better evidence.

A fresh worktree as the agent's cwd is a hardening step for **both** native cells, to be taken when
`spawn_agent` is shown to accept a working directory; it is not a prerequisite for the trial. A cell
moves from trial to supported only after one full run through the sequencer by a Codex orchestrator
completes with a defect found, a blinded exchange, a fresh audit, the manifest and cleanup.

## 6. The live trial (3b), run by the maintainer

Layout: one scratch folder is `-C` for `codex exec` (workspace-write needs everything under cwd, and the native
agents inherit that sandbox, so their output paths must be inside it). It holds, as **siblings**, a copy of the
small target (`bench/targets/tiny-defect`) and the run folder. The run folder must not sit inside the target:
the F3-F6 fingerprint checks hash the target at every boundary, and seat writes inside it would refuse `--wait`.

Feasibility probe, done 2026-10-07 (folder `live/P3`): a non-interactive `codex exec -s workspace-write` session
lists these tools: `spawn_agent`, `followup_task`, `wait_agent`, `wait`, `send_message`, `list_agents`,
`interrupt_agent`, and a `spawn_agent` call with `task_name`, `fork_turns: none` and `model: gpt-5.6-luna`
returned `{"task_name":"/root/probe_agent"}`. So the trial can be orchestrated by `codex exec` launched from here;
it starts through a detached `Start-Process` (so the harness does not own the shell) and the run is followed
through files. `wait_agent` is the Codex-side wait for a native agent, which answers the polling question for
that host (the Claude Code side gets the agent's hand-back as a message).

Resume probe, same day: `codex exec resume <orchestrator thread id>` brought the orchestrator back and a
`followup_task` on `/root/probe_agent` then `wait_agent` answered (`{"message":"Wait completed","timed_out":false}`),
so a native agent stays addressable after its orchestrator was stopped and resumed. The Codex host file may therefore say
"if the orchestrator dies, resume its thread with `codex exec resume <thread id>` and the same `-m` model" (the resume
warned that the thread was recorded with `gpt-5.6-terra` and resumed with `gpt-6.1-sol`; pass the model explicitly).
First-time proof only: one tiny agent, one follow-up.

Result of the trial, 2026-10-07 (folder `live/P4`): a `codex exec -s workspace-write -m gpt-5.6-sol` orchestrator, started with a
detached `Start-Process`, ran the whole sequence through the installed skill in about 11 minutes: `preflight --host codex --allow-trial`
(`hostStatus: trial`), `phase1 --start`, two native agents (`gpt-5.6-luna`, `gpt-5.6-terra`) spawned with `fork_turns: none`,
`phase1 --wait --native-done A,B` (validate clean), `phase2` (concede 2, the all-concede warning and the audit-depth `next:` line appeared),
a fresh native auditor, `audit --finish --native-done auditor`, scorecard: 1 finding settled-agree (MEDIUM, EXECUTED), the seeded off-by-one,
found independently by both seats. `findChildThreads` located the three agents' rollouts from the orchestrator thread, and `build-manifest
--run-dir ... --seat-transcript A=<rollout>` recorded host `codex`, `host_status: trial`, the three `support` rows and per-agent usage and models
(luna 395k input, terra 313k, auditor luna 193k, orchestrator gpt-5.6-sol 2.4M). No script failed. This meets the promotion rule in section 5 for one
run on a small target; the cell stays **trial** until a second run on a real target (a long seat, a larger target) completes cleanly.

## 7. Step 4 as built: no foreground transport, a detach fallback (probes 2026-10-07, folder `live/P5`)

The advisor's probe ladder, run from `codex exec -s workspace-write` with no allow rule, removed the need for a foreground transport:

1. A foreground `claude-dispatch` completed (model resolved, session persisted) although `CODEX_SANDBOX_NETWORK_DISABLED=1` was set.
2. `claude-dispatch --detach` failed: `Invoke-CimMethod ... Access denied` (the WMI start is refused in the sandbox).
3. A plain Node-detached `claude-dispatch` (`detached: true`, `unref`, stdio to a log) started from one shell call completed while a second
   shell call polled; the session persisted. Not shown: survival past the end of the Codex turn (the orchestrator keeps working while it waits).

So `--detach` now tries WMI first (it leaves the host's job object) and, when WMI is refused, starts the worker as a plain detached process
and says so on stderr (`REVIEW_DETACH_MODE`: `auto`, `plain`, `wmi`). A foreground transport and `--executable <path>` are **not built**.

**Probes 1 and 3 did not check whether the Claude CLI session was persisted; a full attempt did, and it differs by launch.** The cross-review trial
on a Codex host through `codex exec` (`live/P6`: Claude CLI seat A and auditor, native Codex seat B) completed Phase 1 and failed in
Phase 2: resuming seat A returned `No conversation found with session ID`, and `~/.claude/projects` held no session file for any of the three
Claude CLI calls. A later live Codex run on its file-tool launch path (reported by that session, `review-live-4e85554a`) saw the Claude CLI write
its session and resume it, and passed a manual cross-review, while the sequencer's host gate refused it. Two launch paths, opposite results: an
unconditional "unsupported" was as wrong as an unconditional "supported". So the Claude CLI **seat** is gated by a **probe**: `preflight --host codex
--allow-trial --probe-claude-session --yes-paid` makes two small Claude Haiku calls (remember a nonce, resume and recall it), refuses the run with the
failure text when the recall fails, and records `support[].probe` in `run.json`; the descriptor refuses a probe-gated seat without that evidence on every read.
A single-call auditor or verifier needs no probe. The plain-detach fallback stays: it is what makes those actors startable there.

## 8. Usability and token backlog (all built and installed 2026-10-07 except the items marked open)

Built: the per-host Quickstart in SKILL.md and a read-this-only-on-failure note on every phase file (the reading cut); `review-config seats`; `references/task-packet-template.md` with the Windows note; ready prompt files for native agents; `build-manifest --run-dir` (collects the packet, untouched Phase 1 copies, peer views, findings, verification files and every completed result.json) and `--init`; `review-run --local`; the concession rate in the scorecard header; a tag table keyed by bracketed packet tags (`[AC-1]`); `counter_fact` in the Note; `--audit-depth`; `--native-agent`; the manifest token split and `usage_ref`. Open: a measurement of the reading saved (size of the files an orchestrator opens for a normal run, before and after); a per-ticket table beyond the tag convention.
 (from the gravemind feedback and the review)

| Item | Where it lands |
|---|---|
| Orchestrator cost is the largest line (22.8M of about 35M input tokens in the review run; 8-11M per review in the field) | (a) F16: split each phase file into a short normal path and a recovery reference; (b) a documented "run the review from a fresh session" recipe with the three arguments it needs; (c) SKILL.md rule 1 to batch reads and not reload unchanged references. All doc work, step 5 |
| Native agent completion: nothing to wait on except polling the file | Host file recipe: the agent's hand-back arrives as a message; do not poll; then rerun `--wait --native-done` |
| `build-manifest` needs a hand-written `--in` body | `build-manifest --init` writes the minimal valid body from `run.json`, step 5 |
| Task packet and plain-directory target snapshot are hand work | A packet skeleton file in `references/` first; a `build-target` helper only if the skeleton proves too little |
| UTC times in sequencer output | `--local` output option, step 5 |
| Scorecard Note does not show the disputing counter-fact | Needs a schema field; deferred |
| `build-manifest` needs a hand-made body and a long flag list, and still warned about an unlisted result.json (vsi-client-26) | `build-manifest --run-dir` collects the task packet, both phase1 files, both rebuttals, `findings.json` and every `result.json` by itself, and `--init` writes the minimal body. Step 5 |
| The scorecard has no per-ticket or per-acceptance-criterion table; concession rate is not shown (vsi-client-26: 17 of 17 conceded on both sides) | A header figure for conceded versus disputed claims; a second table keyed by the packet's acceptance-criterion ids needs a schema field and a packet convention, deferred. Step 5 for the header |
| Reading cost: SKILL.md sends the orchestrator through the phase files (545 lines for phase 1) plus the host file, configuration and profiles before about 6 commands (vsi-client-26, run 2026-10-07) | A 15-line quickstart per host at the top of SKILL.md that names only the commands and says which file to open when something fails; the recovery text stays in the phase files. Step 5 |
| `seats.json` is hand-built from `review-config show` | `review-config seats --host <host> [--transport ...]` writes it from the saved choices, so model ids and transport fields are not retyped. Step 5 |
| The task packet is assembled by hand (scope, ticket text, pre-flight summary, hypotheses; about 16 KB) | A packet skeleton in `references/` with named slots (scope files, out of scope, acceptance source, declared deviations, start-here list); a Windows note (a `C:\Users` path in a Python string, `az` needing a shell) in the packet step. Step 5 |
| The native seat prompt is written by the orchestrator each time, including the blinding rule | `review-run phase1 --start` and `phase2 --start` print a ready-to-paste prompt for each native seat (brief path, output path, the blinding rule, the reply word). Step 5 |
| Manifest `usage: null` on reviewers while usage sits in `seat_usage` | Documented in the manifest section of the protocol; step 5 |

## 9. Order, tests, risk

| Step | Change | Risk | Gate |
|---|---|---|---|
| 2a | `channelFor` by transport; native Codex fixtures | shared code, both skills | Claude Code native tests unchanged and green |
| 2b | `host-support.mjs`, `validateSupport` in the descriptor, preflight per actor, `--allow-trial`, `support` in run.json, remove the old flag | a flag removed, OpenCode behaviour change | descriptor, preflight and review-run tests; manifest copies `support` |
| 3a | Codex host file: native sequence and labels; `build-manifest` native rollout seats and `--run-dir` for `support[]`. Docs the table replaces: both `SKILL.md` host tables ("A Codex-host review is not supported in 1.1.0"), README and CHANGELOG "Known unsupported cells", both `codex.md` status lines, the `review-run.mjs` USAGE text about the native auditor (it still says to rerun `--finish` once the file exists; it needs `--native-done auditor`) | docs and manifest | host-file sample test; manifest test with a real rollout fixture; a grep test that no doc still says the whole Codex host is unsupported |
| 3b | Native Codex trial through the sequencer, run by the maintainer | needs `codex exec` to expose the spawn tools | one complete run, evidence folder |
| 4 | Detach fallback to a plain detached process (section 7); no foreground transport, no executable path | one launcher change | done: probes, unit tests, a mixed-layout sequencer test; the live cross-review trial (P6) showed the Claude CLI seat cannot be resumed from the Codex sandbox, so the Claude CLI seat became probe-gated (a later live Codex run on another launch path kept the session) |
| 5 | Usability and token items above | docs, small helpers | size check of the files an orchestrator reads |

Test gaps this design closes: no fixture for a native Codex actor; no test that a hand-edited
`run.json` with an unsupported combination is refused by the sequencer; no test of an OpenCode seat in
the no-limit path (done in step 1).
