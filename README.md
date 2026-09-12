# SkillArray

Production-ready Claude Code skills for multi-model review, cross-vendor
verification, and shared engineering knowledge.

## Included skills

| Skill | Purpose | Requirements |
|---|---|---|
| `pair-review` | Two distinct Claude models review independently, then collaborate or challenge each other. | Claude Code with access to two distinct models; Node.js 22+ |
| `cross-review` | Two different providers independently review and cross-examine findings. Supports Claude/Fable, Codex/OpenAI, and configured OpenCode providers. | Selected runtime(s); Node.js 22+ |
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
/plugin install skill-array-reviews@skill-array
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
`-- .github/workflows/test.yml
```

Each review skill is also independently installable. It carries its own
references, scripts, tests, README, and license without requiring a sibling
skill.

## Validate

Requirements: Node.js 22 or 24, plus Python 3.11 and PyYAML for Shared Brain.

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

python -m py_compile plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py
python plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py --check-profile plugins/shared-brain/skills/shared-brain/profiles/default.yml
python plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py --check-profile plugins/shared-brain/skills/shared-brain/profiles/vsi-engineering.yml
```

CI runs the review packages on Windows, Linux, and macOS with Node.js 22 and
24. Shared Brain profile validation runs on all three operating systems.

## License

MIT. See [LICENSE](LICENSE).
