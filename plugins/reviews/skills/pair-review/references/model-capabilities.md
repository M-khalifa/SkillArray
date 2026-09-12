# Model and effort validation

Do not ship a fixed model catalog as an entitlement list. Model names, supported
effort levels, aliases, and access vary by account, provider, and harness version.
Resolve availability at setup and revalidate before each review.

## Claude seat

Inspect the current harness's model-selection interface and tool schema.
A model available to the main chat is not necessarily selectable for a subagent.
Use the supported per-agent model field; never use a prompt instruction as a
substitute for selecting the runtime model.

Explicit effort requires a supported runtime setting. Claude Code documents
effort in custom subagent definitions; this does not mean every Agent tool
invocation accepts an effort argument. Use a supported definition or runtime
mechanism without modifying unrelated agent definitions. If unavailable, explain
the limitation and ask the user to choose default effort or another supported
runtime. Do not drop the requested effort.

Check model-forcing environment settings and organization restrictions.
Verify the actual agent model through runtime metadata when available; do not
trust an alias alone. Pair-review must not resolve both seats to the same model.
If exact identity is unobservable, record it as unverified rather than inventing
a pinned ID.

Source: [Claude Code subagent configuration](https://code.claude.com/docs/en/sub-agents).
Runtime behavior takes precedence over examples; inspect the installed version.

## Codex seat

Verify CLI help and model availability in the installed CLI. Read only relevant
nonsecret model/provider configuration if needed; do not dump authentication files.
Cross-review requires the OpenAI provider, not merely a model name resembling GPT.

The bundled dispatcher forwards:
- `--model MODEL` to Codex's `--model MODEL`.
- `--effort LEVEL` to `-c model_reasoning_effort=LEVEL`.
- Both options on fresh and exact-session resumed runs.

The dispatcher validates safe token syntax, not the changing list of model
capabilities. Validate support before dispatch; if a choice is unsupported,
stop the review rather than retrying without the requested option. The runtime
may reject, ignore, or normalize unsupported settings; this behavior has not
been verified here. A successful exit does not establish that the requested
effort took effect. Use `default` only in the preferences helper; omit
`--effort` at dispatch for that setting.

Sources: [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
and [configuration reference](https://developers.openai.com/codex/config-reference).
Run local CLI help before dispatch; no release-specific model default is assumed.

## Reporting

Separate requested, passed, and observed settings. A successful process exit or
an echoed request is not proof of the server's exact model or effort. Record
unknown resolved fields as `null` with a verification note. Never claim a
particular default effort without runtime evidence.

Choose effort deliberately. Do not raise effort, select a more expensive model,
or rewrite global configuration automatically because the target seems difficult.
The user's saved or explicit choice controls the run.
