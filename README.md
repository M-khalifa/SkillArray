# SkillArray

Claude Code and Codex skills I use to review code and documents with two AI
models instead of one, plus a small skill for keeping engineering notes across
projects.

## Why I built it

I use Claude Code for most of my day-to-day work: code, design documents,
websites. I started asking it to review that work too. The reviews were
useful, but one model reviewing a change tends to agree with itself, and it
states a guess with the same confidence as something it actually checked.

So I set up two reviewers. Each one reviews the target on its own first. Then
each sees the other's findings, with names and model identity stripped out,
and has to either accept a finding or refute it with evidence. A fresh third
session, which never saw who wrote what, makes the final call. What comes out
is a short list of findings that survived that process, plus the ones that
didn't, with the reason.

## The skills

| Skill | What it does | Needs |
|---|---|---|
| `cross-review` | Two different providers (Claude plus Codex or an OpenCode model) review the same target and cross-examine each other | Node.js 22+, the Codex or OpenCode CLI |
| `pair-review` | Same process with two different models of one vendor (two Claude or two OpenAI models) | Claude Code with access to two models (or the Codex CLI for two OpenAI models), Node.js 22+ |
| `shared-brain` | Search and save engineering notes across projects | An MCP knowledge backend, Python 3.11+ |

## Install

Claude Code:

```text
/plugin marketplace add M-khalifa/SkillArray
/plugin install pair-review@skillarray
/plugin install cross-review@skillarray
/plugin install shared-brain@skillarray
```

Codex: copy the skill folders `plugins/cross-review/skills/cross-review` and
`plugins/pair-review/skills/pair-review` into `.agents/skills/` in the project (or into
`~/.agents/skills/` for every project). The repository also carries Codex plugin
manifests (`plugins/pair-review/.codex-plugin/plugin.json`, `plugins/cross-review/.codex-plugin/plugin.json`) and a marketplace file
(`.agents/plugins/marketplace.json`). Their field names are copied from plugins in
Codex's own curated marketplace; installing through them has not been tested yet.
Both hosts need Node.js 22+. Run the skills from Claude Code; on a Codex host a pair-review of two native OpenAI models is a trial, and a Claude CLI seat
(cross-review, a Claude pair) is a trial only after a session probe passes (see Hosts below).

The first run asks which models to use. You can change that later with
`/cross-review setup` or `/pair-review setup`, and see the current choice with
`/cross-review config`.

## Hosts

Support is decided per actor (host, runtime, transport), not per host (`scripts/host-support.mjs`):
supported, trial (needs `preflight.mjs --allow-trial`, recorded in `run.json` and the manifest) or
unsupported (refused, no override). Claude Code: everything is supported except an OpenCode seat (trial).
Codex host: native OpenAI agents (pair-review) and a single-call Claude CLI auditor are trial routes; a Claude CLI seat is a
trial only after `preflight --probe-claude-session --yes-paid` proves its session survives (it did not in two `codex exec` runs and
did in another launch path); a nested Codex CLI seat is unsupported.
The skill picks the host from the tools it has, in this order, and `preflight.mjs --host`
records the choice.

| Order | Condition | Host |
|---|---|---|
| 1 | A valid `--host` value that does not contradict a tool family that is present | that value |
| 2 | Both a Claude Code and a Codex agent tool family are present | ambiguous: asks you |
| 3 | An agent-spawn tool and `SendMessage` | `claude-code` |
| 4 | The Codex agent tool family (its tool names are not observed: pass `--host codex`) | `codex` |
| 5 | None of the above | ambiguous: asks you |

Environment markers such as `CODEX_THREAD_ID` and `CLAUDECODE` are hints only. On Claude Code,
seat A runs as a native agent by default. On Codex, every Claude seat, the auditor and the
verifiers run through `claude-dispatch.mjs`, and seat B of cross-review runs through
`codex-dispatch.mjs` or `opencode-dispatch.mjs`. `pair-review` takes two distinct models of one
vendor: two Claude models (started through `claude-dispatch.mjs` under Codex) or two OpenAI
models (started through `codex-dispatch.mjs`). Each skill's `references/hosts/` folder has one file per host.

### Codex sandbox

The Codex `workspace-write` sandbox disables the network, and a bare `claude -p` run from a
Codex shell left no session file in three trials. `claude-dispatch.mjs` run through Codex failed
in 2 of 2 trials with no allow rule. With a user-added allow rule for the dispatcher, 1 of 4
attempts completed; the others were killed with the Codex turn, failed on `--detach` (WMI access
denied), or failed with ECONNREFUSED. Because no route has proved reliable, a Codex-host review runs only
on the trial routes listed above. The skill never requests escalation, never sets a wider sandbox itself, and never
bypasses a permission check. Details: each skill's `references/hosts/codex.md`.

### Known limits: trial and unverified routes

- Cross-review on a Codex host, and a Claude pair on a Codex host: a trial only when the session probe passes. In two
  `codex exec` runs a Claude CLI call left no session, so the exchange could not resume the seat; another Codex launch path kept
  it. A nested Codex CLI start is blocked. The native OpenAI pair-review there is a trial that has completed one short run. See
  each skill's `references/hosts/codex.md`.
- The OpenCode seat is not verified end to end. A live trial (OpenCode 1.18.25, isolated worktree, two free models) ended twice with no final text after tool calls, and the dispatcher reported that as an error. A direct short OpenCode call returned the events the dispatcher parses.

## Using it

```text
/cross-review -- review the changes in this branch
/pair-review adversarial -- check this design doc against the ticket
```

A run takes 20 to 30 minutes for a medium change. You get a report and a
`findings.json`. Each finding has a severity, the evidence behind it, what the
other reviewer said about it, and whether the final check confirmed it.

This is one finding from a review of this repository's own code:

```text
F1  HIGH  confirmed by both reviewers, verified by the auditor
A packet path like "<run-dir> 2\..\run\..." passed the run-directory guard,
so the auditor could have been pointed at files it must not read.
Fix: refuse any run-directory name followed by a space.
```

## How it has been used so far

- Real work: code changes across several repositories, design documents and
  website content. The largest single run covered 14 targets and produced 545
  findings.
- More than 40 end-to-end reviews: bug hunts on large
  codebases, design and strategy documents, and websites. Most were run by
  separate sessions that sent a report after each run: what broke, what was
  slow, and what it cost in tokens.
- After each real run I collected what broke or slowed things down and fixed
  it.
- Several rounds of reviewing the skill itself. The last three found 15, 11
  and 11 problems, and every one was fixed and covered by a test before the
  next round.

[CHANGELOG.md](CHANGELOG.md) lists what the skills do and their known
limitations.

## Things to know before you run it

- What you review is sent to the model providers you picked, under their
  terms. Reviewers can also run commands from the repository they are
  checking. Read [SECURITY.md](SECURITY.md) first if that matters for your
  code.
- The two reviewers never see each other's model names, but writing style can
  still give a hint. The scripts catch explicit leaks; they cannot catch style.
- There is no protection against prompt injection hidden in the reviewed
  material.
- A review of a large codebase uses a lot of tokens, mostly cached reads. In
  my recent runs a Codex seat read 4 to 10 million input tokens per call, a
  Claude seat 7 to 20 million over the whole review, and the auditor 2 to 3
  million. The manifest records each seat's usage.
- I have not benchmarked this against a single reviewer yet. The `bench/`
  folder has the start of that work.

## Repository layout

```text
SkillArray/
|-- plugins/cross-review/skills/cross-review/   the cross-review skill
|-- plugins/pair-review/skills/pair-review/    the pair-review skill
|-- plugins/shared-brain/                  the notes skill
|-- bench/                                 benchmark tooling (not installed)
|-- docs/                                  design notes
`-- scripts/                               repository checks
```

Each review skill installs on its own. The two share some scripts and
reference files, and the repository check makes sure those copies stay
identical.

## Running the checks

Needs Node.js 22 or 24, and Python 3.11 with PyYAML for shared-brain.

```text
node scripts/release-check.mjs
```

It also runs `node scripts/install-check.mjs`, which copies each skill into a scratch Claude
Code layout (`.claude/skills`) and a scratch Codex layout (`.agents/skills`) and checks the
copies. Before a documentation change, `node scripts/compare-baseline.mjs --base <rev>` checks
that the briefs of an earlier revision still build byte for byte and that every documented
rule is still present.

That runs everything in order and stops at the first failure: file checks,
the shared-file comparison, both skills' test suites, the benchmark tests and
the shared-brain profile checks. `--release` also refuses uncommitted changes
and tests each skill from a clean copy. CI runs the review skills on Windows,
Linux and macOS.

## License

MIT. See [LICENSE](LICENSE).
