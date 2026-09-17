#!/usr/bin/env node
// Experimental, opt-in Context Builder: assembles a STARTING task-packet
// context (scoped diff, changed-file list, colocated tests found by naming
// convention, best-effort grep-based symbol lookup) instead of the default
// full-repository free-text scope. Status: experimental only -- this must
// not become the default packet-construction path until the benchmark
// runner (bench/run-comparison.mjs) has actually compared scoped-vs-full
// recall on real cases. Both reviewer seats retain their existing, already
// real ability to read beyond this packet (codex/opencode via --cd
// filesystem access, pair-review via Read/Grep) -- this script's output is
// a starting point, never presented to a reviewer as "the complete
// relevant context."
//
// Fallback behavior: if the builder cannot confidently scope context (a
// non-git target, no --base given, or any internal error), it returns
// { packet: null, reason: "..." } -- never a silent, arbitrarily-narrow
// guess. This mirrors review-protocol.md's "a failed isolation attempt is
// a failed pass, never a fallback to unsandboxed" principle.
//
// This script emits facts only, same discipline as preflight.mjs: no
// interpretive text, no LLM call anywhere in this file.

import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runCapture, isGitRepo } from './preflight.mjs';

class RelayError extends Error {}

function printUsageAndExit(code) {
  process.stdout.write(USAGE);
  process.exit(code);
}

const USAGE = `context-builder.mjs — experimental scoped task-packet context builder.

Usage:
  node context-builder.mjs --cd <path> --base <ref> [--symbol-file-cap <n>]
                 [--out <path>]
  node context-builder.mjs --proxy-metric --findings <findings.json> --packet <packet.json>

Build mode (default):
--cd <path>          Target directory. Required.
--base <ref>          Git ref to diff against (e.g. a commit sha, "HEAD~1",
                     a branch name). Required for build mode -- with no
                     stated diff base, this script refuses rather than
                     guessing one, per its own fallback-to-null contract.
--symbol-file-cap <n> Cap on files reported per extracted symbol from the
                     best-effort caller/callee grep (default: 10). This is
                     a heuristic over identifier names in changed +/- diff
                     lines, not a real parser -- it will both over- and
                     under-match depending on language and naming.
--out <path>          Write the JSON result here instead of stdout.

Proxy-metric mode (post-hoc, no target access needed):
--proxy-metric        Switches to proxy-metric mode.
--findings <path>     A findings.json (or any {findings:[...]} document) to
                     scan for evidence citing a file path NOT present in
                     the packet.
--packet <path>       A packet.json previously produced by build mode.

Output (build mode): { packet: {...} } or { packet: null, reason: "..." }.
packet, when non-null: { base, changedFiles, diff, colocatedTests:
{<file>: [<test file>,...]}, symbolReferences: {<symbol>: [<file>,...]} }.
changedFiles includes newly-created untracked files, but diff does not cover
them (git diff cannot show an untracked file's content against a ref) --
do not assume diff covers every entry in changedFiles.
Output (proxy-metric mode): { citedOutsidePacket: [{evidence, path}],
totalEvidenceStrings: number }. No interpretive text is ever generated.
`;

function parseArgs(argv) {
  const args = {
    proxyMetric: false,
    cd: null,
    base: null,
    symbolFileCap: 10,
    out: null,
    findings: null,
    packet: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RelayError(`${tok} requires a value`);
      return v;
    };
    if (tok === '--proxy-metric') args.proxyMetric = true;
    else if (tok === '--cd') args.cd = takeValue();
    else if (tok === '--base') args.base = takeValue();
    else if (tok === '--symbol-file-cap') {
      const v = takeValue();
      if (!/^[0-9]+$/.test(v)) throw new RelayError('--symbol-file-cap must be a non-negative integer');
      args.symbolFileCap = Number(v);
    } else if (tok === '--out') args.out = takeValue();
    else if (tok === '--findings') args.findings = takeValue();
    else if (tok === '--packet') args.packet = takeValue();
    else if (tok === '-h' || tok === '--help') printUsageAndExit(0);
    else throw new RelayError(`unrecognized argument: ${tok}`);
  }
  if (args.proxyMetric) {
    if (!args.findings || !args.packet) {
      throw new RelayError('--proxy-metric requires both --findings and --packet');
    }
  } else if (!args.cd) {
    throw new RelayError('--cd <path> is required (or use --proxy-metric mode)');
  }
  return args;
}

// Naming-convention colocated test lookup. Checks a small, fixed set of
// candidate paths per changed file (existence via stat, nothing else) --
// never a project-wide search, never a build-system query. changedFile
// comes from git's own output, which always uses forward slashes regardless
// of platform -- candidates are built with posix.join (not path.join, which
// would emit backslashes on win32) so the returned relative paths match
// git's own separator convention throughout the packet.
function candidateTestPaths(cd, changedFile) {
  const dir = path.posix.dirname(changedFile);
  const base = path.posix.basename(changedFile);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const candidates = [];
  if (ext === '.py') {
    candidates.push(
      path.posix.join(dir, `test_${stem}.py`),
      path.posix.join(dir, `${stem}_test.py`),
      path.posix.join(dir, 'tests', `test_${stem}.py`),
    );
  } else if (['.js', '.jsx', '.ts', '.tsx', '.mjs'].includes(ext)) {
    candidates.push(
      path.posix.join(dir, `${stem}.test${ext}`),
      path.posix.join(dir, `${stem}.spec${ext}`),
      path.posix.join(dir, '__tests__', `${stem}.test${ext}`),
      path.posix.join(dir, 'tests', `${stem}.test${ext}`),
    );
  } else {
    // No naming convention known for this extension -- return nothing
    // rather than guessing one.
    return Promise.resolve([]);
  }
  return Promise.all(
    candidates.map(async (rel) => {
      try {
        await stat(path.join(cd, rel));
        return rel;
      } catch {
        return null;
      }
    })
  ).then((results) => results.filter(Boolean));
}

// Best-effort, language-agnostic heuristic: extracts identifiers named on a
// changed +/- diff line that look like a definition (def/function/class/
// export const|function|class NAME), then greps the repo for other files
// referencing that identifier as a whole word. This is NOT a parser and
// will both over-match (a common name like "run" collides across the
// codebase) and under-match (arrow functions, destructured exports,
// non-Latin identifiers) -- documented as a heuristic, not relied on for
// correctness anywhere else in this script.
const SYMBOL_DEF_RE = /^[+-]\s*(?:def|function|class|export\s+(?:const|function|class))\s+(\w+)/;

function extractChangedSymbols(diffText) {
  const symbols = new Set();
  for (const line of diffText.split('\n')) {
    const m = SYMBOL_DEF_RE.exec(line);
    if (m) symbols.add(m[1]);
  }
  return [...symbols];
}

async function findSymbolReferences(cd, symbol, fileCap) {
  const result = await runCapture('git', ['grep', '-l', '-w', symbol], cd);
  if (result.code !== 0) return [];
  return result.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, fileCap);
}

async function buildPacket({ cd, base, symbolFileCap }) {
  const gitTracked = await isGitRepo(cd);
  if (!gitTracked) {
    return { packet: null, reason: `"${cd}" is not a git repository -- cannot compute a scoped diff` };
  }
  if (!base) {
    return { packet: null, reason: 'no --base given -- refusing to guess a diff base rather than silently scoping to an arbitrary range' };
  }
  const baseCheck = await runCapture('git', ['rev-parse', '--verify', base], cd);
  if (baseCheck.code !== 0) {
    return { packet: null, reason: `--base "${base}" does not resolve to a valid git ref in "${cd}"` };
  }

  // --relative makes git diff report paths relative to --cd (cwd), not the
  // repo root. Without it, when --cd is a subdirectory, git diff paths are
  // root-relative while git ls-files/git grep paths below are cwd-relative
  // -- changedFiles would mix two bases, stat(path.join(cd, rel)) in
  // candidateTestPaths would miss every entry, and symbolReferences paths
  // would never match changedFiles paths in allPacketFiles. --relative also
  // correctly scopes the diff to the target subtree, matching what --cd
  // means everywhere else in this script.
  let diffResult, nameOnlyResult, untrackedResult;
  try {
    [diffResult, nameOnlyResult, untrackedResult] = await Promise.all([
      runCapture('git', ['diff', '--relative', base], cd),
      runCapture('git', ['diff', '--relative', base, '--name-only'], cd),
      runCapture('git', ['ls-files', '--others', '--exclude-standard'], cd),
    ]);
  } catch (err) {
    return { packet: null, reason: `git diff against --base "${base}" failed: ${err.message}` };
  }
  if (diffResult.code !== 0 || nameOnlyResult.code !== 0) {
    return { packet: null, reason: `git diff against --base "${base}" exited non-zero` };
  }
  if (untrackedResult.code !== 0) {
    return { packet: null, reason: `git ls-files against "${cd}" exited non-zero` };
  }

  const diff = diffResult.stdout.toString('utf8');
  // git diff --name-only only reports changes to TRACKED files; a file
  // created since --base but never `git add`-ed would otherwise be silently
  // absent from changedFiles even though it's a real part of the change
  // under review. Its content is not included in `diff` either -- git diff
  // cannot show an untracked file's content against a ref -- so a packet
  // reader must not assume `diff` covers every entry in `changedFiles`.
  const diffedFiles = nameOnlyResult.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const untrackedFiles = untrackedResult.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const changedFiles = [...new Set([...diffedFiles, ...untrackedFiles])];

  const colocatedTests = {};
  for (const file of changedFiles) {
    const tests = await candidateTestPaths(cd, file);
    if (tests.length > 0) colocatedTests[file] = tests;
  }

  const symbols = extractChangedSymbols(diff);
  const symbolReferences = {};
  for (const symbol of symbols) {
    const files = await findSymbolReferences(cd, symbol, symbolFileCap);
    if (files.length > 0) symbolReferences[symbol] = files;
  }

  return {
    packet: { base, changedFiles, diff, colocatedTests, symbolReferences },
    reason: null,
  };
}

// Extracts tokens that contain a path SEPARATOR and an extension (e.g.
// "src/a.py", "tests\\test_a.py") -- these are the only tokens ever flagged
// as "outside the packet." A bare basename-with-extension ("a.py", "3.14",
// "e.g.", "v2.0") is deliberately NOT extracted: on real reviewer prose a
// bare token is indistinguishable from a number, an abbreviation, or a
// version string, and would flag ordinary prose as an out-of-packet
// citation. This proxy metric is allowed to under-flag (miss a real
// out-of-packet citation written as a bare basename) but must not over-flag
// on ordinary prose.
const PATH_TOKEN_RE = /(?:^|[\s"'`(])((?:[\w.-]+[/\\])+[\w.-]+\.\w+)(?:$|[\s"'`).,:;])/g;

function extractPathTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    tokens.add(m[1]);
  }
  return [...tokens];
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Every file the packet actually surfaces: changedFiles plus every
// colocated-test and symbol-reference file, since those are also "in the
// packet" a reviewer was given -- citing one is not an out-of-packet read.
function allPacketFiles(packet) {
  const files = new Set(packet.changedFiles ?? []);
  for (const tests of Object.values(packet.colocatedTests ?? {})) {
    for (const t of tests) files.add(t);
  }
  for (const refs of Object.values(packet.symbolReferences ?? {})) {
    for (const f of refs) files.add(f);
  }
  return files;
}

// Reports, per evidence string, any path-separator-containing token (see
// PATH_TOKEN_RE) that does not match a packet file by full normalized path.
// Bare basename-with-extension tokens ("a.py") are never flagged on their
// own -- see PATH_TOKEN_RE's comment -- so citedOutsidePacket only ever
// contains tokens that look like an actual path, never a stray number or
// abbreviation. A proxy metric for "did the packet actually constrain what
// got found" -- not a precise instrumentation of actual file reads, since
// neither dispatcher's event stream exposes one.
function computeProxyMetric(findingsDoc, packet) {
  const packetFiles = new Set([...allPacketFiles(packet)].map(normalizePath));
  const citedOutsidePacket = [];
  let totalEvidenceStrings = 0;

  for (const finding of findingsDoc.findings ?? []) {
    for (const evidence of finding.evidence ?? []) {
      totalEvidenceStrings += 1;
      for (const token of extractPathTokens(evidence)) {
        const normalized = normalizePath(token);
        if (!packetFiles.has(normalized)) {
          citedOutsidePacket.push({ evidence, path: token });
        }
      }
    }
  }
  return { citedOutsidePacket, totalEvidenceStrings };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printUsageAndExit(0);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`context-builder.mjs: ${err.message}\n\n`);
      printUsageAndExit(2);
    }
    throw err;
  }
  try {
    let result;
    if (args.proxyMetric) {
      const findingsDoc = JSON.parse(await readFile(args.findings, 'utf8'));
      const packet = JSON.parse(await readFile(args.packet, 'utf8'));
      result = computeProxyMetric(findingsDoc, packet.packet ?? packet);
    } else {
      const cdAbs = path.resolve(args.cd);
      try {
        await stat(cdAbs);
      } catch (err) {
        throw new RelayError(`--cd "${cdAbs}" does not exist or is not accessible: ${err.message}`);
      }
      result = await buildPacket({ cd: cdAbs, base: args.base, symbolFileCap: args.symbolFileCap });
    }
    const text = JSON.stringify(result, null, 2) + '\n';
    if (args.out) {
      await writeFile(args.out, text, 'utf8');
    } else {
      process.stdout.write(text);
    }
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`context-builder.mjs: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`context-builder.mjs: unexpected failure: ${err.stack || err}\n`);
    process.exit(1);
  });
}

export {
  parseArgs, buildPacket, computeProxyMetric, extractPathTokens, extractChangedSymbols,
  candidateTestPaths, RelayError,
};
