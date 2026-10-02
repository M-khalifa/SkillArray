# SkillArray

Claude Code skills I use to review code and documents with two AI models
instead of one, plus a small skill for keeping engineering notes across
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
| `pair-review` | Same process with two different Claude models | Claude Code with access to two models, Node.js 22+ |
| `shared-brain` | Search and save engineering notes across projects | An MCP knowledge backend, Python 3.11+ |

## Install

```text
/plugin marketplace add M-khalifa/SkillArray
/plugin install reviews@skill-array
/plugin install shared-brain@skill-array
```

The first run asks which models to use. You can change that later with
`/cross-review setup` or `/pair-review setup`, and see the current choice with
`/cross-review config`.

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
|-- plugins/reviews/skills/cross-review/   the cross-review skill
|-- plugins/reviews/skills/pair-review/    the pair-review skill
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

That runs everything in order and stops at the first failure: file checks,
the shared-file comparison, both skills' test suites, the benchmark tests and
the shared-brain profile checks. `--release` also refuses uncommitted changes
and tests each skill from a clean copy. CI runs the review skills on Windows,
Linux and macOS.

## License

MIT. See [LICENSE](LICENSE).
