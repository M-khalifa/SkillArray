// Curated setup choices. Availability is verified by the selected runtime at review time.
// Keep model IDs here only when the runtime's official catalog establishes them.

export const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic / Claude',
    runtimes: ['claude'],
    models: [
      { id: 'fable', label: 'Fable (5.2)', note: 'Available only when the Claude harness exposes it.' },
      { id: 'opus', label: 'Opus (5.5)', note: 'Resolve the exact currently selectable Claude ID in the harness.' },
      { id: 'sonnet', label: 'Sonnet (5.x)', note: 'The harness has served both claude-sonnet-5 and claude-sonnet-5-5; record the resolved ID.' },
      { id: 'haiku', label: 'Haiku (5.5)', note: 'Resolve the exact currently selectable Claude ID in the harness.' },
    ],
  },
  openai: {
    label: 'OpenAI / Codex',
    runtimes: ['codex'],
    models: [
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', note: 'Most capable model for complex coding and professional work.' },
      { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', note: 'Fast, go-to model for coding and everyday work.' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', note: 'Efficient model for visual understanding and computer use.' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', note: 'Previous generation model for coding and everyday work.' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'Previous generation model for complex coding and professional work.' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', note: 'Legacy model for coding and everyday work.' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'Fast and affordable model for easier tasks.' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Legacy model for coding and everyday work.' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Legacy balanced model for agentic coding.' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Legacy fast model for simpler tasks.' },
    ],
  },
});

export const RUNTIMES = Object.freeze({
  claude: 'Claude Code isolated subagent',
  codex: 'OpenAI Codex CLI',
});

export function isSupportedPair(provider, runtime) {
  if (typeof provider !== 'string' || typeof runtime !== 'string') return false;
  return Object.hasOwn(PROVIDERS, provider) && PROVIDERS[provider].runtimes.includes(runtime);
}

export function catalog() {
  return {
    catalogVersion: 1,
    providers: PROVIDERS,
    runtimes: RUNTIMES,
    verification: {
      openai: 'Verify model and effort against the installed Codex CLI before dispatch.',
      claude: 'Verify exact model IDs in the harness picker; Fable is a candidate, not an entitlement.',
    },
  };
}
