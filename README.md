# SkillArray

A multi-model code and document review protocol for Claude Code, plus a
shared engineering-knowledge skill.

## What problem does this solve?

A single model reviewing its own or another model's work tends to agree with
itself, miss what it's not looking for, and state uncertain guesses with the
same confidence as verified facts. SkillArray runs two independent reviewers
against the same target, blinds their identities from each other during
cross-examination, and requires evidence before a finding is reported as
settled; agreement alone is not enough.

## Why not just ask one model, or ask two models and paste their answers together?

Two independent answers pasted together still let false positives from
either model stand unchallenged, and give no structured way to tell whether
a finding both models raised was discovered independently or just copied
from context. SkillArray's reviewers challenge each other's claims with
required evidence, and a canonical-findings step deduplicates only claims
that genuinely corroborate each other, never merely because they touch the
same file.

## What does `pair-review` do?

Two distinct Claude models independently review the same target, then
exchange findings under identity blinding and adjudicate through a
fresh-context auditor. Requires Claude Code access to two distinct models.

## What does `cross-review` do?

The same protocol, run across two different providers (Claude/Fable,
Codex/OpenAI, or a configured OpenCode provider), so the reviewers do not
share a vendor's training data or failure modes. Requires the selected
runtimes and Node.js 22+.

## Why does identity-blinding matter?

Without it, a reviewer can tailor its rebuttal to which specific model or
vendor it believes wrote a claim, rather than to the claim's actual evidence.
Peer exchange is blinded by mechanical relabeling, not just instruction:
provider, model, and seat identity are stripped from what either reviewer,
and the fresh-context auditor that later adjudicates, actually see. A scan
hard-stops on first-person self-identification and on any other
non-target-derived identity mention. This is a mechanical guarantee against
explicit identity leakage, not a claim that writing style or phrasing can
never hint at who's who; that residual limitation is documented, not hidden.

## What does "evidence-grounded" mean?

A rebuttal only overturns a finding with a specific, checkable counter-fact,
never bare disagreement. A finding is marked settled only when
`findings.json`'s schema-enforced provenance actually supports it: a peer
concession, independent corroboration, or a verified checked result. Bare
agreement is not enough on its own. Unresolved disagreement is reported as
unresolved, not smoothed into a false consensus.

```text
Independent first passes
        |
Blind cross-examination  (peer sees findings only as anonymous "P" claims)
        |
Evidence-based refutation  (a rebuttal needs a counter-fact, not disagreement)
        |
Fresh-context adjudication  (a new subagent, coin-flipped "X"/"Y" identities)
        |
Disagreement preserved  (unresolved claims are reported, not discarded)
```

## What are the trust/privacy implications?

Source content sent to a reviewer is sent to that reviewer's model provider
under that provider's own terms. `cross-review` can route to more providers
than just Anthropic/OpenAI when configured through OpenCode. A reviewer in
either skill can execute commands from the reviewed repository when checking
a claim. See [SECURITY.md](SECURITY.md) for what is currently documented
about these boundaries before reviewing code you don't want a third-party
model to see or execute against; the full threat-model documentation is
still in progress (see CHANGELOG's Known limitations).

## What does a user run, and what do they get back?

Run `/pair-review` or `/cross-review` against a target (see Configure review
models below for first-time setup). The skill returns a human-readable report
plus a machine-readable `findings.json`; see `review-protocol.md`'s
Canonical findings and `findings.json` sections in either review skill for
the schema. Independently-corroborated findings are marked as such; so is
every unresolved disagreement.

## What are the important known limitations?

No quality-improvement claim in this repository is backed by a benchmark
yet. See the Known limitations section of [CHANGELOG.md](CHANGELOG.md) for
the current, honestly-scoped list, including: single-line-only code-span
detection, no default timeout on external provider processes, the full
parent environment currently passed to spawned provider CLIs by
`cross-review`'s dispatchers, no mechanical verification of the auditor's
own dispute classification, a canonical finding's evidence/severity/basis
still trusted from the auditor's JSON rather than cross-checked, and gaps
in `--isolate`'s drift detection around gitignored/untracked content. See
[docs/releases/1.3.0-engineering-notes.md](docs/releases/1.3.0-engineering-notes.md)
for full detail on any of these.

## Included skills

| Skill | Purpose | Requirements |
|---|---|---|
| `pair-review` | Two distinct Claude models run this protocol against the same target, then collaborate or adversarially challenge each other. | Claude Code with access to two distinct models; Node.js 22+ |
| `cross-review` | Two different providers run this protocol independently and cross-examine findings. Supports Claude/Fable, Codex/OpenAI, and configured OpenCode providers. | Selected runtime(s); Node.js 22+ |
| `shared-brain` | Search, capture, and migrate durable engineering knowledge across projects. | Compatible MCP knowledge backend; Python 3.11+ for profile validation |

The review skills preserve independent first passes, require evidence for
findings, retain unresolved disagreements, and record requested versus observed
provider, runtime, model, and effort configuration. `cross-review` requires two
different selected providers.

## Install

Add this repository as a Claude Code marketplace:

```text
/plugin marketplace add M-khalifa/SkillArray
```

Install the review bundle:

```text
/plugin install reviews@skill-array
```

Install Shared Brain separately when its MCP backend is configured:

```text
/plugin install shared-brain@skill-array
```

## Configure review models

The first review asks for provider, runtime, model, and optional effort choices.
Codex setup offers `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, and
`gpt-5.6-luna`; Claude setup includes Fable when exposed by the harness.
Settings are saved outside the repository and can be changed at any time.

```text
/pair-review setup
/pair-review config
/cross-review setup
/cross-review config
```

No model is silently selected on first use. One-run overrides do not modify
saved preferences.

## Repository layout

```text
SkillArray/
|-- .claude-plugin/marketplace.json
|-- plugins/
|   |-- reviews/
|   |   |-- .claude-plugin/plugin.json
|   |   `-- skills/
|   |       |-- pair-review/
|   |       `-- cross-review/
|   `-- shared-brain/
|       |-- .claude-plugin/plugin.json
|       `-- skills/shared-brain/
|-- bench/            (scoring/benchmark tooling, not part of either plugin)
|-- docs/
|   |-- design/        (1.4+ design proposals, not yet implemented)
|   `-- releases/      (per-release engineering detail)
`-- .github/workflows/test.yml
```

Each review skill is also independently installable. It carries its own
references, scripts, tests, README, and license without requiring a sibling
skill. `bench/` and `docs/` are repository-level tooling and documentation;
neither ships as part of either plugin.

## Validate

Requirements: Node.js 22 or 24, plus Python 3.11 and PyYAML for Shared Brain.

```powershell
node scripts/release-check.mjs
```

Runs every release-readiness check in one command, in order, stopping at the
first failure: repository parity (shared review files stay byte-identical
between packages), both packages' own validators and test suites, the
benchmark scorer's own test suite (`bench/tests/score.test.mjs`), and Shared
Brain's profile validation. Package-local green tests are not sufficient on
their own — a package can pass its own suite while a shared file has drifted
from its sibling package, which only `scripts/validate-repository.mjs` (run
first, inside `release-check.mjs`) catches; run the full script rather than
individual steps before calling anything release-ready.

To run one step in isolation instead of the full chain:

```powershell
node scripts/validate-repository.mjs

Push-Location plugins/reviews/skills/pair-review
node scripts/validate-package.mjs
node --test
Pop-Location

Push-Location plugins/reviews/skills/cross-review
node scripts/validate-package.mjs
node --test
Pop-Location

node --test bench/tests/score.test.mjs

python -m py_compile plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py
python plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py --check-profile plugins/shared-brain/skills/shared-brain/profiles/default.yml
python plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py --check-profile plugins/shared-brain/skills/shared-brain/profiles/vsi-engineering.yml
```

`release-check.mjs` runs both packages' suites with `--test-concurrency=1`.
This dates from an early, unreproduced flake report; 22 stress-test runs in
default parallel mode have since shown no failures (see CHANGELOG's Known
limitations). If `node --test` ever fails under parallel scheduling for you,
re-run with `--test-concurrency=1` and report the failure — it should not be
expected behavior.

CI runs the review packages on Windows, Linux, and macOS with Node.js 22 and
24. Shared Brain profile validation runs on all three operating systems.
`cross-review` currently carries 220 tests (one platform-conditional skip off
Windows) and `pair-review` 125, covering identity-leak scanning (including
case-insensitive seat-letter matching with a strict, separately-scoped
vocabulary exemption), CommonMark-compliant fence-indentation limits (a 4+
space or tab "fence" is exposed as ordinary prose, never treated as an
exemption from the blind), fence-aware parsing of both claim headings and the
verifier's own schema, relabel-direction correctness, provider/runtime
validation, snapshot drift and worktree isolation (source repo AND the
isolated worktree's own content), submodule and nested-repo edge cases,
canonical-findings translation with mechanically-enforced refutation
provenance and final-state/auditor-verdict contradiction checks, verifier-file
content authority (verdict, basis, AND evidence), and process-tree
termination — not just the happy path. `node scripts/release-check.mjs
--release` refuses a dirty working tree before running any check.

## License

MIT. See [LICENSE](LICENSE).
