// Shared child-process environment filtering for the dispatchers and preflight. Base OS environment a child process needs to function at all --
// not specific to either CLI's own auth. The threat this filter addresses is
// the REVIEWED REPOSITORY's own code (running inside a review CLI's
// sandbox, or via command execution the sandbox allows) reading unrelated
// secrets (AWS keys, GITHUB_TOKEN, database passwords) that happened to be
// in the orchestrator's shell environment for an unrelated reason -- never
// meant to hide a CLI's own credential-locator variables, which are
// directory locators, not secrets themselves.

const WIN32_BASE_ENV_ALLOWLIST = [
  'SystemRoot', 'PATH', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
];
const POSIX_BASE_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'SHELL'];
// Prefix matches, checked case-sensitively against the exact env key.
const POSIX_BASE_ENV_PREFIXES = ['LC_', 'XDG_'];
// Proxy and certificate locations (no secrets): without them a command behind a corporate proxy cannot reach the network.
// The same names the dispatchers allow for their CLIs.
export const NETWORK_ENV_ALLOWLIST = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
];

// Process-local git settings the review relies on: fsmonitor off (path-utils) and a trusted target (a Codex sandbox).
// Other GIT_CONFIG_* entries can carry credentials (http.extraHeader), so only these keys pass, renumbered from 0.
const GIT_CONFIG_PASSTHROUGH = new Set(['core.fsmonitor', 'safe.directory']);
export function gitConfigPassthrough(sourceEnv) {
  const kept = [];
  const count = Math.min(Number(sourceEnv.GIT_CONFIG_COUNT) || 0, 1000);
  for (let i = 0; i < count && sourceEnv[`GIT_CONFIG_KEY_${i}`] !== undefined; i++) {
    const key = sourceEnv[`GIT_CONFIG_KEY_${i}`];
    const value = sourceEnv[`GIT_CONFIG_VALUE_${i}`];
    if (typeof key === 'string' && typeof value === 'string' && GIT_CONFIG_PASSTHROUGH.has(key.toLowerCase())) kept.push([key, value]);
  }
  const out = kept.length ? { GIT_CONFIG_COUNT: String(kept.length) } : {};
  kept.forEach(([key, value], i) => Object.assign(out, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
  return out;
}

// Builds the env object to pass to a spawned child. 'inherit' returns
// undefined (Node's spawn() default: full parent env). 'filtered' returns an
// explicit object containing only the base OS allowlist, any
// provider-specific credential-locator vars the caller names in
// providerAllowlist (e.g. codex-dispatch.mjs passes ['CODEX_HOME']), and anything the caller
// named in envPassthrough -- everything else in the orchestrator's
// environment (AWS_*, GITHUB_TOKEN, database passwords, etc.) is excluded.
export function buildChildEnv({
  envMode,
  envPassthrough = [],
  providerAllowlist = [],
  platform = process.platform,
  sourceEnv = process.env,
}) {
  if (envMode === 'inherit') return undefined;
  const baseAllowlist = platform === 'win32' ? WIN32_BASE_ENV_ALLOWLIST : POSIX_BASE_ENV_ALLOWLIST;
  const prefixes = platform === 'win32' ? [] : POSIX_BASE_ENV_PREFIXES;
  const allowed = new Set([...baseAllowlist, ...providerAllowlist, ...envPassthrough]);
  // Windows env var names are case-insensitive and inconsistently cased across
  // shells (cmd.exe/PowerShell commonly expose "Path", not "PATH") -- matching
  // case-sensitively here would silently drop PATH under --env-mode filtered
  // whenever the process env spells it any way other than the allowlist's casing.
  const allowedLower = platform === 'win32' ? new Set([...allowed].map((k) => k.toLowerCase())) : null;
  const result = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const isAllowed = platform === 'win32' ? allowedLower.has(key.toLowerCase()) : allowed.has(key);
    if (isAllowed || prefixes.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  // GIT_CONFIG_* names the caller passes on itself (git auth for a private remote) go through as given.
  const namedGit = envPassthrough.some((name) => /^GIT_CONFIG_/i.test(name));
  return namedGit ? result : { ...result, ...gitConfigPassthrough(sourceEnv) };
}
