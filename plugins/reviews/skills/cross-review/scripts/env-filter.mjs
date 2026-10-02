// Shared child-process environment filtering, extracted from
// codex-dispatch.mjs and opencode-dispatch.mjs (pure extraction, no behavior
// change -- both dispatchers' own test suites pass unchanged against this
// module). Base OS environment a child process needs to function at all --
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

// Builds the env object to pass to a spawned child. 'inherit' returns
// undefined (Node's spawn() default: full parent env). 'filtered' returns an
// explicit object containing only the base OS allowlist, any
// provider-specific credential-locator vars the caller names in
// providerAllowlist (e.g. codex-dispatch.mjs passes ['CODEX_HOME'];
// opencode-dispatch.mjs passes none, since OpenCode's own credentials are
// located entirely via already-allowlisted vars), and anything the caller
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
  return result;
}
