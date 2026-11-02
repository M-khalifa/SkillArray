// Path and file-entry helpers that see through symlinks (macOS /tmp -> /private/tmp, a symlinked
// home or skills folder) and git calls that ignore the user's diff settings.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, promises as fs, readFileSync, realpathSync as jsRealpath, rmSync, statSync, writeFileSync } from 'node:fs';

// The native realpath restores the on-disk case on case-insensitive volumes (macOS APFS, Windows), where the JS
// implementation keeps the case the caller typed: "myrepo" for a folder on disk called "MyRepo" must equal git's spelling.
const realpathSync = jsRealpath.native;
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// A packet path written through a variable ("$TMPDIR/run1/x", "${HOME}/x", "$env:TEMP\x", "%TEMP%\x"; the macOS default
// run folder lives under TMPDIR), expanded from the environment so the run-folder and reach checks see the real path. On
// Linux and macOS a backslash after the variable is a separator the packet's author meant, so it becomes "/".
// Also PowerShell's "${env:NAME}" and cmd's "%HOMEDRIVE%%HOMEPATH%" (or "$env:HOMEDRIVE$env:HOMEPATH"). The path runs on
// across a space while the next word holds a backslash ("%TEMP%\run space\x.log"), so on Linux and macOS it is converted whole.
// USERNAME and USER stand for one folder name ("C:\Users\%USERNAME%\x", "/home/$USER/x"); each falls back to the other,
// since Windows sets only USERNAME and Linux and macOS often only USER.
const PATH_VAR_NAMES = 'HOME|TMPDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|ONEDRIVE|HOMEPATH|USERNAME|USER';
const PATH_VAR_RE = new RegExp(`(?:(%HOMEDRIVE%%HOMEPATH%|\\$env:HOMEDRIVE\\$env:HOMEPATH)|\\$\\{env:(${PATH_VAR_NAMES})\\}|\\$(?:env:)?\\{?(${PATH_VAR_NAMES})\\}?|%(${PATH_VAR_NAMES})%)([\\\\/][^\\s"'\`)\\]>,;|*]*(?: [^\\s"'\`)\\]>,;|*\\\\/$%]*\\\\[^\\s"'\`)\\]>,;|*]*)*)`, 'gi');
export function expandPathVars(text, { env = process.env, platform = process.platform } = {}) {
  return String(text).replace(PATH_VAR_RE, (all, pair, braced, unix, win, rest) => {
    const name = (braced ?? unix ?? win ?? '').toUpperCase();
    const value = pair ? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null) : env[name] ?? (name === 'HOME' ? os.homedir() : name === 'USER' ? env.USERNAME : name === 'USERNAME' ? env.USER : null);
    if (!value) return all;
    return platform === 'win32' ? path.win32.join(value, rest) : path.posix.join(value, rest.replace(/\\/g, '/'));
  });
}

// A path written from the reader's own working folder ("$PWD/../run", "${PWD}/x", "/proc/self/cwd/../run",
// "/proc/thread-self/cwd/x") starts in baseDir, the folder the reader runs in; a named user's home
// ("~root/x") comes from the password file. Without baseDir the working-folder forms are left as written.
// The same folder in every shell, any letter case: "~+", "$(pwd)", "$(pwd -W)", "`pwd`", PowerShell's "$pwd", "${pwd}" and
// "$(Get-Location)", cmd's "%CD%". A closing quote may sit between the form and the next separator.
const CWD_FORM_RE = /(?<![\w$])(?:\$\{PWD\}|\$(?:env:)?PWD\b|\/proc\/(?:self|thread-self)\/cwd|~\+|\$\((?:pwd|Get-Location|gl)(?:\s+-[A-Za-z]+)*\)|`pwd(?:\s+-[A-Za-z]+)*`|%CD%)(?=["'`]*(?:[\\/]|\s|$))/gi;
const USER_HOME_RE = /(?<![\w~])~([A-Za-z_][\w.-]*)(?=[\\/])/g;
function userHome(user) {
  try {
    if (user === os.userInfo().username) return os.homedir();
  } catch { /* no user info: the password file below */ }
  if (process.platform === 'win32') return null;
  try {
    const entry = readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find((f) => f[0] === user);
    return entry?.[5] || null;
  } catch {
    return null;
  }
}
export function expandWorkingFolderForms(text, baseDir, { homeOf = userHome } = {}) {
  let out = String(text);
  if (baseDir) out = out.replace(CWD_FORM_RE, () => baseDir);
  return out.replace(USER_HOME_RE, (all, user) => homeOf(user) ?? all);
}

// "file:///home/u/a%20b" as a path ("/home/u/a b"): the URL prefix goes, a rooted path keeps its root, "file:///C:/x"
// loses the slash before the drive ("file:///c%3A/x" too), and %XX sequences are decoded inside the URL only: a plain
// path may hold a literal "%20".
export function decodeFileUrls(text) {
  const decode = (s) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (e) => { try { return decodeURIComponent(e); } catch { return e; } });
  return String(text).replace(/\bfile:\/\/(?:localhost)?([^\s"`<>|]*)/gi, (m, rest) => decode(rest))
    .replace(/(^|[^\w])\/([A-Za-z]:[\\/])/g, '$1$2');
}

// Real path of p: the nearest existing ancestor is resolved and the missing rest appended, so a
// folder that does not exist yet still compares equal to its real parent's children.
export function realPath(p) {
  const abs = path.resolve(p);
  const rest = [];
  for (let cur = abs; ; ) {
    try {
      return rest.length > 0 ? path.join(realpathSync(cur), ...rest) : realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// The form two paths are compared in: real path, case-folded on Windows and where the run's folder was found to fold case.
export function comparablePath(p) {
  const real = realPath(p);
  return process.platform === 'win32' || runFoldsCase === true ? real.toLowerCase() : real;
}

export function isInsidePath(child, parent) {
  const c = comparablePath(child);
  const p = comparablePath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// macOS links /tmp, /var and /etc to /private/...: the other spelling of a POSIX path under them, or null.
export function linkSpellingOf(abs) {
  const real = /^\/private(\/(?:tmp|var|etc)(?:\/|$).*)$/.exec(abs);
  if (real) return real[1];
  return /^\/(?:tmp|var|etc)(?:\/|$)/.test(abs) ? `/private${abs}` : null;
}

// The lexical and the real spelling of p, plus on macOS the link spelling of each, without duplicates: a path
// given in its real /private form is also written as /tmp/... by a shell whose working folder came through the link.
// Each also in its other Unicode form (composed NFC or decomposed NFD) when that form opens the same folder: macOS can
// store a name decomposed while a seat quotes it composed. Where the file system keeps the two forms apart, the other
// form can be a different folder, so it is left out; when either form does not exist yet, macOS keeps it.
export function pathSpellingsOf(p, { platform = process.platform, real = realPath, sameEntry = sameFileEntry } = {}) {
  const spellings = [path.resolve(p), real(p)];
  if (platform === 'darwin') spellings.push(...spellings.map(linkSpellingOf).filter(Boolean));
  const forms = (s) => [s.normalize('NFC'), s.normalize('NFD')].filter((v) => v === s || (sameEntry(s, v) ?? platform === 'darwin'));
  return [...new Set(spellings.flatMap((s) => [s, ...forms(s)]))];
}

// Whether a and b open the same file system entry; null when either cannot be read.
export function sameFileEntry(a, b) {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    // Some network and FUSE file systems report inode 0 for every entry: no answer, not "the same".
    if (x.ino === 0n || y.ino === 0n) return null;
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return null;
  }
}

// Where the file system ignores letter case (Windows, macOS by default), so two spellings that differ only in case are one path.
// A run records what preflight found for its own folder (a Linux run folder on WSL /mnt/c, CIFS or exFAT folds case too);
// review-run sets it here for the run, and the platform default applies without it. Windows paths always fold.
let runFoldsCase = null;
export function setFoldsCase(value) {
  runFoldsCase = typeof value === 'boolean' ? value : null;
}
export const foldsCase = (platform = process.platform) => platform === 'win32' || (runFoldsCase !== null && platform === process.platform ? runFoldsCase : platform === 'darwin');

// Whether the file system that holds dir (or its nearest existing parent) folds case: a probe file named in mixed case is
// looked up in lower case, then removed. null when no folder could be written.
export function probeFoldsCase(dir) {
  let at = path.resolve(dir);
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  const file = path.join(at, `.Case-Probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(file, '', { flag: 'wx' });
  } catch {
    return null;
  }
  try {
    return existsSync(path.join(at, path.basename(file).toLowerCase()));
  } finally {
    rmSync(file, { force: true });
  }
}

// A run-folder path a seat pasted (often inside a tool's error message) would show the peer or the auditor where the run's
// records are: every spelling of dir, in any letter case and with any mix of separators (also JSON-escaped, Git Bash /c/
// and WSL /mnt/c/), becomes the placeholder. Returns the text and the count replaced.
// What continues a folder's name into a sibling's ("run2", "run-evidence", "run.bak", "runé", "run+1", "run@x", "run(2)"):
// a letter, digit or one of _+@(- next, or a dot followed by a letter, digit or _. A regex source for the u flag, shared
// by every check that decides where a named folder ends, so the leak guard, the scrub and the rewrite agree.
export const NAME_CONTINUES = String.raw`[\p{L}\p{N}_+@(-]|\.[\p{L}\p{N}_]`;
const NAME_CONTINUES_RE = new RegExp(`^(?:${NAME_CONTINUES})`, 'u');
// True when the text after a folder name (rest) makes it a longer name, not the folder itself.
export const continuesName = (rest) => NAME_CONTINUES_RE.test(String(rest));

// Git Bash on Windows mounts the OS temp folder at /tmp and prints a folder inside it that way ("/tmp/rv-1"); null for a
// folder outside it or on another platform.
export function gitBashTmpForm(p, { platform = process.platform, tmp = os.tmpdir() } = {}) {
  if (platform !== 'win32') return null;
  const [real, base] = [realPath(p), realPath(tmp)];
  const rel = path.win32.relative(base.toLowerCase(), real.toLowerCase());
  if (rel === '' || rel.startsWith('..') || path.win32.isAbsolute(rel)) return null;
  return `/tmp/${real.slice(base.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')}`;
}

export function scrubDir(text, dir, placeholder = '<run-dir>') {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '[\\\\/]+';
  const alts = new Set();
  const tmpForm = gitBashTmpForm(dir);
  if (tmpForm) alts.add(tmpForm.split('/').map(esc).join(sep));
  for (const p of pathSpellingsOf(dir)) {
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/);
    const drive = /^[A-Za-z]:$/.test(parts[0]) ? parts[0][0] : null;
    const rest = parts.slice(1).map(esc).join(sep);
    if (rest === '') continue;
    if (drive) alts.add(`(?:${drive}:|(?:/mnt)?/${drive})${sep}${rest}`);
    else alts.add(`${parts[0] === '' ? sep : `${esc(parts[0])}${sep}`}${rest}`);
  }
  let count = 0;
  // A sibling whose name only continues the folder's is another folder (NAME_CONTINUES); a match must not start inside a
  // longer name either. Letter case counts only where the file system ignores it.
  const flags = foldsCase() ? 'giu' : 'gu';
  const out = alts.size === 0 ? String(text) : String(text).replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${[...alts].join('|')})(?!${NAME_CONTINUES})`, flags), () => { count += 1; return placeholder; });
  return { text: out, count };
}

// True when the module at metaUrl is the script node was started with, also through a symlinked path:
// node loads the main module by its real path, so import.meta.url never equals a symlinked argv[1].
export function isMainModule(metaUrl) {
  if (typeof process.argv[1] !== 'string') return false;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return fold(realpathSync(fileURLToPath(metaUrl))) === fold(realpathSync(path.resolve(process.argv[1])));
  } catch {
    return metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

// Content hash of one directory entry; a symlink hashes as its link text, so a dangling link or a
// link to a folder hashes instead of failing with ENOENT or EISDIR. The "link:" prefix keeps it apart from any file hash.
export async function entrySha256(filePath) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) return `link:${createHash('sha256').update(await fs.readlink(filePath)).digest('hex')}`;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Copies one entry; a symlink is recreated as the same link instead of followed.
export async function copyEntry(src, dest) {
  const stat = await fs.lstat(src);
  if (!stat.isSymbolicLink()) return fs.copyFile(src, dest);
  const link = await fs.readlink(src);
  let type;
  if (process.platform === 'win32') {
    // A dangling link is most often a junction whose folder is gone; only a link to an existing file is a file link.
    const isFile = (await fs.stat(src).catch(() => null))?.isFile();
    type = isFile ? 'file' : path.isAbsolute(link) ? 'junction' : 'dir';
  }
  try {
    return await fs.symlink(link, dest, type);
  } catch (err) {
    // Windows without the symlink privilege: copy what the link points to, or skip a dangling link.
    if (err.code !== 'EPERM') throw err;
    if ((await fs.stat(src).catch(() => null))?.isFile()) return fs.copyFile(src, dest);
  }
}

// A git -z name list as entries { text, raw }. A Linux file name need not be valid UTF-8, and decoding it loses bytes
// the file system needs: raw keeps them (a Buffer) for such a name and is null for every other. text is for display,
// sorting and JSON; two fingerprints of the same tree decode a name the same way, so comparing text stays consistent.
export function gitNames(stdout) {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
  const entries = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0) continue;
    if (i > start) {
      const raw = buf.subarray(start, i);
      const text = raw.toString('utf8');
      entries.push({ text, raw: Buffer.from(text, 'utf8').equals(raw) ? null : Buffer.from(raw) });
    }
    start = i + 1;
  }
  return entries;
}

// The file system path of a gitNames entry under dir: a string, or a Buffer when its name is not valid UTF-8.
export function entryPath(dir, entry) {
  if (!entry.raw) return path.join(dir, entry.text);
  return Buffer.concat([Buffer.from(dir.endsWith(path.sep) ? dir : dir + path.sep, 'utf8'), entry.raw]);
}

// A key for a gitNames entry: its text, plus its bytes in hex when its name is not valid UTF-8, because every
// invalid byte decodes to the same replacement character and two such names would share one key.
export function entryKey(entry) {
  return entry.raw ? `${entry.text} [bytes ${entry.raw.toString('hex')}]` : entry.text;
}

// The bytes a gitNames entry's name is hashed as: for a valid name exactly the UTF-8 text hashed before.
export function nameBytes(entry) {
  return entry.raw ?? Buffer.from(entry.text, 'utf8');
}

// Run a "git rev-parse" repository probe with this environment: the C locale keeps git's messages in English.
export const GIT_C_LOCALE = { LC_ALL: 'C', LANGUAGE: '' };

// With core.fsmonitor=true in the user's config, every git command these scripts run on the target starts an fsmonitor
// daemon that keeps running after the review. core.fsmonitor=false is added for every git child through GIT_CONFIG_COUNT,
// only on git 2.36 or later: before that core.fsmonitor named a hook command, and "false" would be run as one.
export function gitConfigNoFsmonitor(env = process.env, version = () => spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout) {
  if (env.REVIEW_GIT_NO_FSMONITOR === '1') return env;
  const m = /git version (\d+)\.(\d+)/.exec(String(version() ?? ''));
  if (!m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 36)) return env;
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  Object.assign(env, { [`GIT_CONFIG_KEY_${n}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${n}`]: 'false', GIT_CONFIG_COUNT: String(n + 1), REVIEW_GIT_NO_FSMONITOR: '1' });
  return env;
}
gitConfigNoFsmonitor();

// Whether a "git rev-parse --git-dir" or "--is-inside-work-tree" probe found a repository. A folder outside any repository
// (exit 128, "not a git repository") is false; any other failure, such as a repository git refuses to open (dubious ownership,
// a newer format), throws: such a target is never reviewed as a plain folder.
export function gitRepoFromProbe({ code, stdout = '', stderr = '' }, dir) {
  if (code === 0) return String(stdout).trim() !== 'false';
  if (code === 128 && /^fatal: not a git repository\b/m.test(String(stderr))) return false;
  const lines = String(stderr).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fix = lines.find((l) => /safe\.directory/.test(l));
  const reason = lines.find((l) => /^fatal:/.test(l)) ?? lines[0] ?? '';
  throw new Error(`git cannot open the repository at ${dir} (exit ${code}): ${[reason, fix && fix !== reason ? `fix: ${fix}` : ''].filter(Boolean).join('; ')}`);
}

// `git diff` options that make the output independent of the user's git config: no colour, no
// external diff or textconv, a/ and b/ prefixes, 3 context lines (git apply needs them), file names unquoted.
export const GIT_PLAIN = ['-c', 'color.diff=false', '-c', 'core.quotepath=false', '-c', 'diff.context=3'];
export const DIFF_PLAIN = ['--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
