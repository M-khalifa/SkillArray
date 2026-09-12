// Curated setup choices. Availability is verified by the selected runtime at review time.
// Keep model IDs here only when the runtime's official catalog establishes them.

export const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic / Claude',
    runtimes: ['claude', 'opencode'],
    models: [
      { id: 'fable', label: 'Fable', note: 'Available only when the Claude harness exposes it.' },
      { id: 'opus', label: 'Opus', note: 'Resolve the exact currently selectable Claude ID in the harness.' },
      { id: 'sonnet', label: 'Sonnet', note: 'Resolve the exact currently selectable Claude ID in the harness.' },
      { id: 'haiku', label: 'Haiku', note: 'Resolve the exact currently selectable Claude ID in the harness.' },
    ],
  },
  openai: {
    label: 'OpenAI / Codex',
    runtimes: ['codex', 'opencode'],
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'Highest capability.' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Flagship professional-work model.' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Balanced capability and cost.' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Cost-sensitive, high-volume model.' },
    ],
  },
  google: { label: 'Google / Gemini', runtimes: ['opencode'], models: [] },
  xai: { label: 'xAI / Grok', runtimes: ['opencode'], models: [] },
  mistral: { label: 'Mistral', runtimes: ['opencode'], models: [] },
  moonshot: { label: 'Moonshot / Kimi', runtimes: ['opencode'], models: [] },
  deepseek: { label: 'DeepSeek', runtimes: ['opencode'], models: [] },
  openrouter: { label: 'OpenRouter', runtimes: ['opencode'], models: [] },
  opencode: { label: 'OpenCode (bundled)', runtimes: ['opencode'], models: [] },
});

export const RUNTIMES = Object.freeze({
  claude: 'Claude Code isolated subagent',
  codex: 'OpenAI Codex CLI',
  opencode: 'OpenCode provider bridge',
});

const UNCATALOGUED_OPENCODE_PROVIDER = /^[a-z][a-z0-9-]*$/;

export function isSupportedPair(provider, runtime) {
  if (typeof provider !== 'string' || typeof runtime !== 'string') return false;
  if (Object.hasOwn(PROVIDERS, provider)) return PROVIDERS[provider].runtimes.includes(runtime);
  // Uncatalogued OpenCode vendors are accepted by shape only; opencode models is the source of truth.
  return runtime === 'opencode' && UNCATALOGUED_OPENCODE_PROVIDER.test(provider);
}

export function catalog() {
  return {
    catalogVersion: 1,
    providers: PROVIDERS,
    runtimes: RUNTIMES,
    verification: {
      openai: 'Verify model and effort against the installed Codex CLI before dispatch.',
      claude: 'Verify exact model IDs in the harness picker; Fable is a candidate, not an entitlement.',
      opencode: 'Use `opencode models` and select a configured provider/model ID before dispatch.',
    },
  };
}
