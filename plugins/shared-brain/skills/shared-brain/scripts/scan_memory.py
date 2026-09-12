"""Worksheet builder and safety gate for shared-brain's memory-sync mode.

Enumerates the local memory dir, parses frontmatter, computes stable hashes, runs
a deterministic secret scan, and reports ledger status. Read-only against the
memory dir -- there is no code path here that writes to it, by design. The only
file this writes is the ledger, which lives in the skill dir.

Deliberately does NOT classify publish/skip. Deciding whether a file is durable
engineering knowledge or a personal working-style preference needs judgment
about content, and a keyword classifier would pass preferences into a shared
store. This produces the worksheet; the agent judges each row.

What it DOES decide mechanically, because these must not depend on judgment:
  - `type: user` is a hard block (frontmatter rule).
  - Unparseable frontmatter is a hard block, never a "?" the agent might wave
    through. Parse uncertainty on a hard-block field has to fail closed.
  - Anything matching the secret patterns is a hard block.

Locations are discovered at runtime, never hardcoded: the Claude config root comes
from CLAUDE_CONFIG_DIR or ~/.claude, and every projects/*/memory/ under it is
scanned, plus a global memory/ if present. Same file works on Windows, Linux and
macOS for any user.

Python 3.8+; PyYAML required (the script needs only 3.7, but current PyYAML declares 3.8). Without PyYAML every file BLOCKs with a reason
rather than falling back to a hand-rolled parser -- a mis-parsed `type` would
bypass a hard block, so it fails closed instead of guessing.

    python scan_memory.py --list-dirs         # memory dirs found, with file counts
    python scan_memory.py                     # worksheet across all of them
    python scan_memory.py --project <substr>  # limit to matching project names
    python scan_memory.py --memory-dir <path> # one explicit directory
    python scan_memory.py --body <slug>       # one body; project/slug if ambiguous
    python scan_memory.py --json              # same table, machine-readable
    python scan_memory.py --scan-text <file>  # secret-scan a drafted thought
    python scan_memory.py --record <slug> --thought-hash <h> [--marker <m>]
    python scan_memory.py --ledger            # dump ledger
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple

# ---------------------------------------------------------------------------
# Locations -- discovered, never hardcoded, so this runs on any machine and project.
# ---------------------------------------------------------------------------

def claude_home() -> Path:
    """Root of the Claude config tree.

    CLAUDE_CONFIG_DIR wins when set (some installs relocate it); otherwise the
    conventional ~/.claude. Path.home() is correct on all three platforms.
    """
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".claude"


def projects_root() -> Path:
    return claude_home() / "projects"


def discover_memory_dirs() -> list:
    """Every memory dir under the projects tree, plus a global one if present.

    Returns [(label, Path), ...] sorted with global first, then by file count
    descending, so the biggest corpora lead the worksheet.
    """
    found = []

    for candidate in (claude_home() / "memory", claude_home() / "global" / "memory"):
        if candidate.is_dir():
            found.append(("<global>", candidate))
            break

    root = projects_root()
    if root.is_dir():
        for child in sorted(root.iterdir()):
            mem = child / "memory"
            try:
                if mem.is_dir() and any(mem.glob("*.md")):
                    found.append((child.name, mem))
            except OSError:
                continue

    def _count(pair):
        try:
            return len(list(pair[1].glob("*.md")))
        except OSError:
            return 0

    # Drop directories that resolve to the same place. A symlinked project would
    # otherwise be scanned twice under two labels, and the same lesson would be
    # proposed twice in one batch.
    seen_real = set()
    deduped = []
    for label, path in found:
        try:
            real = path.resolve()
        except OSError:
            real = path
        if real in seen_real:
            continue
        seen_real.add(real)
        deduped.append((label, path))
    found = deduped

    globals_ = [p for p in found if p[0] == "<global>"]
    rest = sorted([p for p in found if p[0] != "<global>"], key=_count, reverse=True)
    return globals_ + rest


# lives in the skill dir, never in a memory dir -- those are read-only
LEDGER_PATH = Path(__file__).resolve().parent.parent / ".synced.json"

# an index, not a memory; nothing to publish from it
SKIP_FILENAMES = {"MEMORY.md"}

# Hard-blocked frontmatter types. `user` is personal data by definition.
BLOCKED_TYPES = {"user"}


# --------------------------------------------------------------------------
# Secret / PII scanning
#
# Prose telling an agent to "scan for secrets" is not a gate -- it is a hope.
# These patterns are the mechanical floor. They are deliberately broad: a false
# block costs one conversation, a false publish is permanent and shared.
#
# This list is a floor, not a ceiling. It cannot know your customer names, so
# CUSTOMER_DENYLIST below has to be maintained by hand.
# --------------------------------------------------------------------------
SECRET_PATTERNS: list = [
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    # ADO/Azure PATs are base32-ish and long; catch generic high-entropy assignments
    ("assigned-secret", re.compile(
        r"(?i)\b(pat|token|api[_-]?key|secret|passwd|password|client[_-]?secret|"
        r"authorization|bearer)\b\s*[:=]\s*['\"]?[A-Za-z0-9+/_.=-]{16,}")),
    ("url-userinfo", re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:[^/\s@]+@")),
    ("connection-string", re.compile(
        r"(?i)\b(?:Data Source|Server|Initial Catalog|User ID|Pwd)\s*=\s*[^;\s]{2,};")),
    ("pem-block", re.compile(r"-----BEGIN CERTIFICATE-----")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    # IPv6 is matched loosely here and then VALIDATED with the ipaddress module
    # in scan_secrets. Hand-written IPv6 regexes accumulate holes -- successive
    # attempts here missed the compressed form, then leading-compressed
    # (::dead:beef), then IPv4-mapped (::ffff:192.0.2.128). The stdlib already
    # knows the grammar exactly; use it rather than growing a fourth pattern.
    ("ipv6", re.compile(r"(?<![:.\w])(?=[0-9A-Fa-f:]*::|(?:[0-9A-Fa-f]{1,4}:){7})"
                        r"[0-9A-Fa-f:]{2,}(?:\.\d{1,3}){0,3}(?![:\w])")),
    ("windows-home-path", re.compile(r"(?i)[A-Z]:\\+Users\\+[^\\\s]+")),
    ("posix-home-path", re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+")),
    ("unc-path", re.compile(r"\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+")),
    ("wwn", re.compile(r"\b(?:[0-9A-Fa-f]{2}:){7}[0-9A-Fa-f]{2}\b")),
]

# Allowlisted non-secrets that the broad patterns above would otherwise trip on.
#
# Keep this list SHORT and each entry narrow. A "version-like triple" rule
# (^\d{1,3}(\.\d{1,3}){3}$, meant to spare strings like "2.5.10.1") matches every
# dotted quad, so it would exempt 192.168.1.50 and every other real address too,
# killing the whole ipv4 pattern. A permissive allowlist silently disables the
# rule above it, which is worse than no rule, since the table still claims coverage.
SECRET_ALLOWLIST: list = [
    re.compile(r"^(?:127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255)$"),
    re.compile(r"^(?:localhost|example\.com|example\.org)$"),
    # documentation placeholders, not real addresses
    re.compile(r"^(?:\d{1,3}\.){3}(?:x|X|N|nnn)$"),
    re.compile(r"^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$"),  # RFC 5737 doc ranges
]

# A version string and an IP are the same shape, so shape alone cannot separate
# them, and neither can scanning the whole line for version vocabulary: addresses
# and versions routinely share a sentence ("ONTAP 9.13 cluster mgmt lif is
# 10.5.5.5" leaks under that approach, as do most realistic storage sentences).
# Any heuristic keyed on neighbouring words has the same flaw.
#
# Judge the TOKEN instead. A version is introduced by a marker attached to it
# ("v1.4.0.2", "version 2.5.10.1") or has a component above 255, which no octet
# can. Everything else that parses as a dotted quad is treated as an address.
# The bias is deliberate: a blocked version string costs one conversation, a
# published customer address is permanent and shared.
_VERSION_PREFIX = re.compile(
    r"(?i)(?:\b(?:v|ver|version|rel|release|build|rev|revision|firmware|"
    r"semver)\b[\s:=]*|(?<![\w.])v)$"
)


def _is_version_token(text: str, start: int, quad: str) -> bool:
    """True when a dotted quad is a version rather than an address."""
    # any component > 255 cannot be an octet
    try:
        if any(int(p) > 255 for p in quad.split(".")):
            return True
    except ValueError:
        return False
    # a version marker immediately preceding it, e.g. "version 2.5.10.1", "v1.4.0.2"
    preceding = text[max(0, start - 24):start]
    return bool(_VERSION_PREFIX.search(preceding))

# Names that identify customers or internal hosts. This CANNOT be inferred --
# the model does not know which names are customers. Maintain it by hand; an
# empty list means this class of leak is unguarded.
CUSTOMER_DENYLIST: list = []


def _allowlisted(match_text: str) -> bool:
    t = match_text.strip()
    return any(p.match(t) for p in SECRET_ALLOWLIST)


def scan_secrets(text: str) -> list:
    """Return [(label, matched_text), ...]. Empty means no pattern fired.

    Runs over whatever it is given -- a raw source body OR a drafted thought.
    Both need scanning: a scrubbed body can still be published with a leaky
    filename or an example the transform introduced.
    """
    findings: list = []
    body = text or ""
    for label, pattern in SECRET_PATTERNS:
        for m in pattern.finditer(body):
            hit = m.group(0)
            if _allowlisted(hit):
                continue
            # A dotted quad is either an address or a version. Decide from the
            # token and what immediately introduces it, never from the line --
            # in storage prose, versions and addresses share sentences constantly.
            if label == "ipv4" and _is_version_token(body, m.start(), hit):
                continue
            # let the stdlib arbitrate IPv6 rather than trusting the regex
            if label == "ipv6":
                try:
                    import ipaddress
                    ipaddress.IPv6Address(hit)
                except (ImportError, ValueError):
                    continue
            findings.append((label, hit))
    lowered = (text or "").lower()
    for name in CUSTOMER_DENYLIST:
        if name.lower() in lowered:
            findings.append(("customer-name", name))
    return findings


# --------------------------------------------------------------------------
# Frontmatter
# --------------------------------------------------------------------------
class FrontmatterError(Exception):
    """Frontmatter could not be parsed with confidence.

    Raised rather than returning a sentinel: `type: user` is a hard block, so a
    parse failure must not degrade into an ordinary row with type "?" that an
    agent then judges on content and publishes.
    """


def split_frontmatter(text: str) -> Tuple[str, str]:
    """Return (frontmatter, body). Both handled for BOM and CRLF."""
    if text.startswith("\ufeff"):
        text = text[1:]
    normalized = text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        return "", normalized
    end = normalized.find("\n---", 3)
    if end == -1:
        # opened a frontmatter block and never closed it. Returning ("", text)
        # would call this "no frontmatter" and let a `type: user` line inside the
        # unterminated block go unread -- a hard block silently skipped. Signal it.
        raise FrontmatterError("frontmatter opened with --- but never closed")
    # the closing delimiter must be its own line, not a "---" inside prose
    after = normalized[end + 4:end + 5]
    if after not in ("\n", ""):
        raise FrontmatterError("closing --- is not on its own line")
    fm = normalized[4:end].strip("\n")
    body = normalized[end + 4:].lstrip("\n")
    return fm, body


def parse_frontmatter(fm: str) -> dict:
    """Parse with PyYAML when available, else fail closed.

    The old hand-rolled parser hoisted every `key: value` line regardless of
    nesting and let the last duplicate win, so a nested `type:` could mask the
    real one. On a hard-block field that is not an acceptable failure mode.
    """
    if not fm.strip():
        return {}
    try:
        import yaml  # type: ignore
    except ImportError:
        # No PyYAML. Do NOT guess with a hand-rolled parser: a naive one can
        # hoist nested keys and let duplicates win, masking a `type: user` that
        # must hard-block. Fail closed instead so a missing dependency can
        # never turn into a silent publish.
        raise FrontmatterError(
            "PyYAML not installed -- cannot parse frontmatter safely. "
            "Every file will BLOCK until you `pip install pyyaml`. "
            "Refusing to guess: a mis-parsed type field would bypass a hard block."
        )
    try:
        data = yaml.safe_load(fm)
    except Exception as exc:  # yaml.YAMLError and anything it wraps
        raise FrontmatterError(f"invalid YAML: {exc}") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise FrontmatterError(f"frontmatter is {type(data).__name__}, expected mapping")
    return data


class ProfileError(Exception):
    """A profile YAML file does not have the shape SKILL.md and memory-sync.md promise."""


def check_profile(path: str) -> list:
    """Validate a shared-brain profile's shape. Returns a list of error strings;
    empty means the profile is well-formed. Never returns partial success --
    a caller checks `if errors:` and treats any non-empty list as a hard fail.

    This exists because nothing else in this script is profile-aware: Rule 6
    in memory-sync.md says a profile "must" define allowlist/blocklist/
    tiebreaker, but until this function existed nothing enforced that -- a
    malformed profile loaded fine and failed silently at agent-judgment time,
    the one place in this whole filter that was NOT fail-closed like every
    other gate here (see parse_frontmatter's fail-closed behavior above).
    """
    errors = []
    try:
        import yaml  # type: ignore
    except ImportError:
        return ["PyYAML not installed -- cannot validate a profile. "
                "Install pyyaml before trusting any profile's shape."]

    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as exc:
        return [f"cannot read {path}: {exc}"]

    try:
        data = yaml.safe_load(raw)
    except Exception as exc:  # yaml.YAMLError and anything it wraps
        return [f"{path}: invalid YAML: {exc}"]

    if not isinstance(data, dict):
        return [f"{path}: profile must be a YAML mapping, got {type(data).__name__}"]

    allowed_keys = {"allowlist", "blocklist", "tiebreaker", "project", "notes"}
    for key in data:
        if key not in allowed_keys:
            errors.append(
                f"{path}: unexpected key '{key}' -- allowed keys are "
                f"{', '.join(sorted(allowed_keys))}"
            )

    for key in ("allowlist", "blocklist"):
        val = data.get(key)
        if val is None:
            errors.append(f"{path}: missing required key '{key}'")
        elif not isinstance(val, list):
            errors.append(f"{path}: '{key}' must be a list of strings, got {type(val).__name__}")
        elif not val:
            errors.append(f"{path}: '{key}' is present but empty -- an empty allowlist "
                          f"blocks everything, an empty blocklist blocks nothing; confirm "
                          f"that's actually intended before shipping this profile")
        else:
            for i, item in enumerate(val):
                if not isinstance(item, str) or not item.strip():
                    errors.append(f"{path}: '{key}[{i}]' must be a non-empty string")

    tiebreaker = data.get("tiebreaker")
    if tiebreaker is None:
        errors.append(f"{path}: missing required key 'tiebreaker'")
    elif not isinstance(tiebreaker, str) or not tiebreaker.strip():
        errors.append(f"{path}: 'tiebreaker' must be a non-empty string")

    return errors


def resolve_type(fm: dict) -> Optional[str]:
    """Read type from root and metadata, and refuse to pick when they disagree."""
    root = fm.get("type")
    meta = fm.get("metadata")
    nested = meta.get("type") if isinstance(meta, dict) else None

    values = set()
    for v in (root, nested):
        if v is None:
            continue
        if isinstance(v, (list, tuple, set)):
            # `type: [user]` would stringify to "['user']" and slip past the
            # BLOCKED_TYPES membership test. Flatten so each element is checked.
            # Nesting has to fail closed rather than stringify: `type: [[user]]`
            # became "['user']" and `type: [{kind: user}]` became "{'kind':
            # 'user'}" -- neither matches BLOCKED_TYPES, so both scored REVIEW on
            # a file the hard block exists to stop.
            for x in v:
                if isinstance(x, (list, tuple, set, dict)):
                    raise FrontmatterError(
                        f"type contains a nested {type(x).__name__}; expected scalars"
                    )
                values.add(str(x).strip().lower())
        elif isinstance(v, (str, int, float, bool)):
            values.add(str(v).strip().lower())
        else:
            raise FrontmatterError(f"type is {type(v).__name__}, expected a scalar")

    if not values:
        return None
    if values & BLOCKED_TYPES:
        # any blocked value anywhere wins, even alongside a benign one
        return sorted(values & BLOCKED_TYPES)[0]
    if len(values) > 1:
        raise FrontmatterError(f"conflicting type values: {sorted(values)}")
    return values.pop()


# --------------------------------------------------------------------------
# Hashing
# --------------------------------------------------------------------------
def _normalize(text: str) -> str:
    return text.replace("\r\n", "\n").strip()


def body_hash(body: str) -> str:
    """Full sha256 of the normalized body. Compare on this, display a prefix.

    Full hash, not 8 hex: 32 bits is needlessly weak for an identity that
    decides whether a permanent, undeletable write happens.
    """
    return hashlib.sha256(_normalize(body).encode("utf-8")).hexdigest()


def thought_hash(final_text: str) -> str:
    """Identity of one drafted thought -- what actually gets published.

    Source-body hash alone cannot represent one file becoming three thoughts,
    nor a re-worded transform of an unchanged source. Dedup and approval both
    key on this.
    """
    return hashlib.sha256(_normalize(final_text).encode("utf-8")).hexdigest()


def source_id(slug: str, project: str = "") -> str:
    """Opaque, stable source identity for the published marker.

    Never the raw filename stem: filenames can name a customer, a host, or a
    person, and the marker survives every scrub applied to the body. Never the
    bare slug either: the same filename exists in many memory dirs, so two
    different lessons would produce one marker and defeat the store's dedup.
    Hash the slug qualified by project instead.
    """
    key = "{}/{}".format(project, slug) if project else slug
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------
# Ledger  (the only thing this script writes, and never into the memory dir)
# --------------------------------------------------------------------------
def load_ledger() -> dict:
    if not LEDGER_PATH.exists():
        return {"version": 2, "sources": {}}
    try:
        data = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SystemExit(
            f"ledger unreadable ({exc}). Refusing to continue -- an unreadable "
            f"ledger silently looks like 'nothing published yet', which is how "
            f"a re-sync duplicates everything.\n"
            f"REPAIR it, do not delete it: {LEDGER_PATH}\n"
            f"Deleting produces the same empty state as a fresh install, so the "
            f"next run re-publishes everything already in the store and the "
            f"duplicates cannot be removed. If the file is beyond repair, "
            f"reconstruct it by searching the store for memory-sync: markers "
            f"before running any sync."
        )
    if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
        raise SystemExit(f"ledger at {LEDGER_PATH} is malformed; refusing to continue")
    return data


def save_ledger(ledger: dict) -> None:
    """Atomic replace -- a half-written ledger is indistinguishable from a lost one."""
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(LEDGER_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(ledger, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, LEDGER_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def record_published(slug: str, sha: str, t_hash: str, marker: str) -> None:
    """Record one CONFIRMED-PUBLISHED thought. Call only after verifying presence."""
    ledger = load_ledger()
    entry = ledger["sources"].setdefault(slug, {"source_sha256": sha, "thoughts": []})
    entry["source_sha256"] = sha
    for t in entry["thoughts"]:
        if t.get("thought_sha256") == t_hash:
            return
    entry["thoughts"].append({"thought_sha256": t_hash, "marker": marker})
    save_ledger(ledger)


# --------------------------------------------------------------------------
# Scan
# --------------------------------------------------------------------------
def _contained(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


def scan(memory_dir=None, project: str = "") -> list:
    """Scan one memory dir. Pass project= to label rows when scanning several."""
    if memory_dir is None:
        dirs = discover_memory_dirs()
        if not dirs:
            raise SystemExit(
                f"no memory directories found under {projects_root()}\n"
                f"Set CLAUDE_CONFIG_DIR, or pass --memory-dir explicitly."
            )
        rows = []
        for label, mem in dirs:
            rows.extend(scan(mem, project=label))
        return rows

    memory_dir = Path(memory_dir)
    if not memory_dir.is_dir():
        raise SystemExit(f"memory dir not found: {memory_dir}")

    ledger = load_ledger()
    rows: list = []

    for path in sorted(memory_dir.glob("*.md")):
        if path.name in SKIP_FILENAMES:
            continue
        # A symlink inside a memory dir can point anywhere. Reading it would pull
        # a file the user never put in the corpus into a permanent shared store.
        if not _contained(path, memory_dir):
            print(f"warning: skipping {path.name} -- resolves outside {memory_dir}",
                  file=sys.stderr)
            continue
        slug = path.stem
        # Same filename can exist in two projects, and the ledger is keyed on
        # slug -- qualify it so one project's sync cannot mask another's.
        key = "{}/{}".format(project, slug) if project else slug
        row: dict = {"slug": slug, "key": key, "project": project,
                     "gate": "review", "gate_reason": ""}

        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            row.update(type="?", sha256="", gate="BLOCK",
                       gate_reason=f"unreadable: {exc}", body_chars=0,
                       ledger="unknown", description="")
            rows.append(row)
            continue

        try:
            fm_text, body = split_frontmatter(text)
            fm = parse_frontmatter(fm_text)
            ftype = resolve_type(fm)
        except FrontmatterError as exc:
            row.update(type="?", sha256="", gate="BLOCK",
                       gate_reason=f"metadata-parse-error: {exc}",
                       body_chars=0, ledger="unknown", description="")
            rows.append(row)
            continue

        sha = body_hash(body)
        secrets = scan_secrets(text)

        if ftype in BLOCKED_TYPES:
            row["gate"] = "BLOCK"
            row["gate_reason"] = f"type:{ftype}"
        elif secrets:
            labels = sorted({lbl for lbl, _ in secrets})
            row["gate"] = "BLOCK"
            row["gate_reason"] = "secret-scan: " + ",".join(labels)
            # Flag the path-only case. Rule 1 allows extracting the lesson from a
            # file whose ONLY finding is a local path, since that is a username
            # rather than a secret and Rule 7 already strips it from passing files.
            # Surfacing it matters: a file whose only finding is a bare
            # "C:\Users\<name>" can still hold a real, extractable framework or
            # API trap that would otherwise be lost to an outright block.
            if set(labels) <= {"windows-home-path", "posix-home-path"}:
                row["gate_reason"] += "  [path-only: lesson may be extractable, see Rule 1]"

        # Qualified key only. A bare-slug fallback looks like harmless backward
        # compatibility and is not: the same filename exists in many projects
        # (MEMORY.md is in all of them), so one legacy unqualified entry matches
        # every project's copy and reports them all as already published. A
        # false "synced" silently skips a file forever, which is the one
        # direction of error this whole design tries to avoid. Legacy entries
        # are migrated below instead of being matched loosely.
        prior = ledger["sources"].get(key) or {}
        if not prior and not project:
            prior = ledger["sources"].get(slug) or {}
        prior_sha = prior.get("source_sha256")
        published = prior.get("thoughts") or []
        if not published:
            status = "new"
        elif prior_sha == sha:
            status = f"synced({len(published)})"
        else:
            status = "CHANGED"

        row.update(
            type=ftype or "none",
            sha256=sha,
            body_chars=len(body.strip()),
            ledger=status,
            prior_sha256=prior_sha,
            secret_hits=[{"label": l, "match": m} for l, m in secrets],
            description=str(fm.get("description", ""))[:120],
        )
        rows.append(row)
    return rows


def print_table(rows: list) -> None:
    if not rows:
        print("no memory files found")
        return

    multi = len({r.get("project", "") for r in rows}) > 1
    width = min(max(len(r["slug"]) for r in rows), 46)

    for r in rows:
        if multi and r.get("project") != getattr(print_table, "_last", None):
            proj = r.get("project") or "(unlabelled)"
            count = sum(1 for x in rows if x.get("project") == r.get("project"))
            print(f"\n=== {proj}  ({count} files) ===")
            print_table._last = r.get("project")
        print(
            f"{r['slug'][:width].ljust(width)}  {str(r['type'])[:9]:9}  "
            f"{r.get('sha256','')[:8]:8}  {r['gate']:6}  {r['ledger']:11}  "
            f"{r['body_chars']}"
        )
        if r["gate"] == "BLOCK":
            print(f"{' ' * width}  -> {r['gate_reason']}")
    if hasattr(print_table, "_last"):
        del print_table._last

    blocked = sum(1 for r in rows if r["gate"] == "BLOCK")
    print(f"\n{len(rows)} files: {blocked} hard-BLOCKED, {len(rows) - blocked} to judge")
    if multi:
        print("Per project:")
        seen = []
        for r in rows:
            p = r.get("project") or "(unlabelled)"
            if p not in seen:
                seen.append(p)
        for p in seen:
            grp = [r for r in rows if (r.get("project") or "(unlabelled)") == p]
            b = sum(1 for r in grp if r["gate"] == "BLOCK")
            print(f"  {p[:44]:44} {len(grp):>4} files  {b:>3} blocked")
        print(
            "\nThis is an OVERVIEW, not a sync worklist. A sync run takes ONE project:\n"
            "  python scripts/scan_memory.py --project <name>\n"
            "Publishing across projects in one run is not supported -- see the three hard\n"
            "limits in references/memory-sync.md (one project, ten proposals, triage first)."
        )
    print(
        "\nBLOCK is mechanical and final. 'review' means the gate found nothing "
        "automatic\nagainst it -- it is NOT a recommendation to publish. Judge every "
        "review row\nagainst references/memory-sync.md rules 3-6 (preferences, run "
        "logs, transient\nstatus). Most review rows should still be skipped."
    )


def print_body(slug: str, memory_dir=None) -> int:
    """Print one body. Accepts `slug` or `project/slug` when several projects match."""
    project = ""
    if "/" in slug and memory_dir is None:
        project, _, slug = slug.rpartition("/")

    if "/" in slug or "\\" in slug or slug in (".", ".."):
        print(f"invalid slug: {slug}", file=sys.stderr)
        return 2

    if memory_dir is None:
        matches = []
        for label, mem in discover_memory_dirs():
            if project and label != project:
                continue
            if (mem / f"{slug}.md").is_file():
                matches.append((label, mem))
        if not matches:
            print(f"no such memory: {slug}", file=sys.stderr)
            return 1
        if len(matches) > 1:
            print(f"'{slug}' exists in {len(matches)} projects; qualify it:",
                  file=sys.stderr)
            for label, _ in matches:
                print(f"  --body {label}/{slug}", file=sys.stderr)
            return 2
        memory_dir = matches[0][1]

    memory_dir = Path(memory_dir)
    path = memory_dir / f"{slug}.md"
    if not _contained(path, memory_dir):
        print(f"refusing path outside memory dir: {slug}", file=sys.stderr)
        return 2
    if not path.is_file():
        print(f"no such memory: {slug}", file=sys.stderr)
        return 1
    try:
        _, body = split_frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as exc:
        print(f"could not read {slug}: {exc}", file=sys.stderr)
        return 1
    print(body.strip())
    return 0


# Only this exact grammar counts as the provenance line. Matching a bare
# "Source:" prefix was wrong: a body may legitimately end with an evidence line
# like "Source: vendor manual section 4", and stripping that made the pre-marker
# hash differ from the post-marker one, so the documented two-pass construction
# produced a marker that could never be recovered from the finished thought.
#
# "cerebro-auto" is kept as an accepted value for compatibility with entries
# written by open-brain's original (VSI-specific) integration; "auto-capture"
# is the generic name any other project's automatic capture pipeline should
# use going forward.
_PROVENANCE_RE = re.compile(
    r"^Source:\s*(?:hand-capture|memory-sync|cerebro-auto|auto-capture)\b.*\|\s*verified:\s*",
    re.IGNORECASE,
)


def body_of(text: str) -> str:
    """Everything above the trailing provenance line, or the whole text if absent.

    The marker is derived from this, not from the finished thought: the marker is
    written INTO the thought, so hashing the finished text to produce a value you
    then insert changes the thing you hashed. Only text fixed before the marker
    exists can feed the marker.

    Recognising the full provenance grammar (not just "Source:") is what makes the
    two-pass construction stable -- pass one sees no provenance line and hashes
    the whole draft; pass two strips exactly the line it added and recovers the
    same hash.
    """
    lines = _normalize(text).splitlines()
    for i in range(len(lines) - 1, -1, -1):
        if _PROVENANCE_RE.match(lines[i]):
            return "\n".join(lines[:i]).strip()
    return _normalize(text)


def check_verdicts(verdict_path: str, memory_dir=None, project: str = "") -> int:
    """Confirm a classification covers every judged slug exactly once.

    Reads a file of `slug: verdict` lines (or bare slugs) and diffs it against the
    slugs the gate says need judgment. Exists because a skipped file is invisible:
    one audited run classified 59 of 69 files and nothing noticed, and every one
    of the eight never-judged files turned out to be publishable.
    """
    try:
        text = Path(verdict_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"could not read {verdict_path}: {exc}", file=sys.stderr)
        return 2

    claimed = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        claimed.append(re.split(r"[\s:,|]", line, 1)[0].strip().strip("`*-"))

    if memory_dir is None and project:
        matched = [(l, m) for l, m in discover_memory_dirs()
                   if project.lower() in l.lower()]
        if not matched:
            print(f"no memory dir matches --project {project!r}", file=sys.stderr)
            return 2
        # Same guard the scan path uses. Without it an ambiguous substring silently
        # merges several projects into one judged set, so a classification covering
        # one project reports dozens of "missing" slugs from projects the user never
        # meant to include -- and the check that exists to catch omissions becomes
        # the thing producing false ones.
        if len(matched) > 1:
            print(f"--project {project!r} matches {len(matched)} directories:",
                  file=sys.stderr)
            for label, _ in matched:
                print(f"  {label}", file=sys.stderr)
            print("Narrow it, or use --memory-dir for one exact path.", file=sys.stderr)
            return 2
        rows = []
        for label, mem in matched:
            rows.extend(scan(mem, project=label))
    else:
        rows = scan(memory_dir)

    judged = [r["slug"] for r in rows if r["gate"] != "BLOCK"]
    claimed_set, judged_set = set(claimed), set(judged)

    missing = sorted(judged_set - claimed_set)
    extra = sorted(claimed_set - judged_set)
    dupes = sorted({s for s in claimed if claimed.count(s) > 1})

    print(f"judged by gate : {len(judged)}")
    print(f"verdicts given : {len(claimed)} ({len(claimed_set)} unique)")
    if missing:
        print(f"\nMISSING a verdict ({len(missing)}) -- these were never judged:")
        for s in missing:
            print(f"  {s}")
    if extra:
        print(f"\nNot in the judged set ({len(extra)}) -- typo, or gate-blocked already:")
        for s in extra:
            print(f"  {s}")
    if dupes:
        print(f"\nJudged more than once ({len(dupes)}):")
        for s in dupes:
            print(f"  {s}")
    if not (missing or extra or dupes):
        print("\nOK: every judged file has exactly one verdict.")
        return 0
    print("\nClassification does not close. Do not present it until it does.")
    return 1


def scan_text_file(path_str: str) -> int:
    """Secret-scan a drafted thought before it is shown for approval."""
    p = Path(path_str)
    try:
        text = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"could not read {p}: {exc}", file=sys.stderr)
        return 2
    hits = scan_secrets(text)
    body = body_of(text)
    body_h = hashlib.sha256(body.encode("utf-8")).hexdigest()
    print(f"body_sha256:    {body_h}   (marker uses first 12: {body_h[:12]})")
    print(f"thought_sha256: {thought_hash(text)}   (approval + ledger)")
    print(f"chars: {len(_normalize(text))}")
    if not hits:
        print("secret-scan: clean")
        return 0
    print("secret-scan: BLOCKED")
    for label, match in hits:
        print(f"  {label}: {match}")
    return 1


def main(argv: Optional[list] = None) -> int:
    # Windows consoles default to cp1252, and these memory files are full of
    # arrows and dashes. Without this, --body dies on UnicodeEncodeError partway
    # through printing -- which looks like a corrupt memory file rather than a
    # console-encoding problem, and hides the content you were trying to review.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="open-brain memory-sync worksheet")
    ap.add_argument("--body", metavar="SLUG", help="print one memory's body")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--memory-dir", default=None,
                    help="scan one directory instead of discovering all of them")
    ap.add_argument("--project", default=None,
                    help="limit discovery to project names containing this substring")
    ap.add_argument("--list-dirs", action="store_true",
                    help="show the memory directories that would be scanned, then exit")
    ap.add_argument("--scan-text", metavar="FILE",
                    help="secret-scan a drafted thought and print its hash")
    ap.add_argument("--record", metavar="SLUG", help="record a CONFIRMED publication")
    ap.add_argument("--thought-hash", help="thought sha256 (with --record)")
    ap.add_argument("--source-hash", help="source sha256 (with --record)")
    ap.add_argument("--marker", default="", help="published marker (with --record)")
    ap.add_argument("--ledger", action="store_true", help="dump the ledger")
    ap.add_argument("--verdicts", metavar="FILE",
                    help="check a verdict file covers every judged slug exactly once")
    ap.add_argument("--check-profile", metavar="FILE",
                    help="validate a profiles/*.yml file's shape (allowlist/blocklist/"
                         "tiebreaker); exits nonzero and prints every problem found")
    args = ap.parse_args(argv)

    if args.list_dirs:
        dirs = discover_memory_dirs()
        if not dirs:
            print(f"no memory dirs found under {projects_root()}")
            return 1
        total = 0
        for label, mem in dirs:
            n = len([p for p in mem.glob("*.md") if p.name not in SKIP_FILENAMES])
            total += n
            print(f"{n:>5}  {label}")
        print(f"{total:>5}  TOTAL across {len(dirs)} directories")
        print(f"\nclaude home: {claude_home()}")
        return 0

    if args.ledger:
        print(json.dumps(load_ledger(), indent=2, sort_keys=True))
        return 0
    if args.check_profile:
        errors = check_profile(args.check_profile)
        if errors:
            print(f"{args.check_profile}: INVALID")
            for e in errors:
                print(f"  - {e}", file=sys.stderr)
            return 1
        print(f"{args.check_profile}: OK")
        return 0
    if args.verdicts:
        return check_verdicts(args.verdicts,
                              Path(args.memory_dir) if args.memory_dir else None,
                              args.project or "")
    if args.scan_text:
        return scan_text_file(args.scan_text)
    if args.record:
        if not args.thought_hash or not args.source_hash:
            print("--record needs --thought-hash and --source-hash", file=sys.stderr)
            return 2
        # The scan writes qualified keys, so an unqualified --record creates an
        # entry no later lookup finds, and the file silently re-publishes on the
        # next run. Require the same shape the worksheet reports.
        if "/" not in args.record and len(discover_memory_dirs()) > 1:
            print(
                f"--record needs a project-qualified key like 'project/{args.record}'.\n"
                f"The worksheet's 'key' column has the exact value; an unqualified key "
                f"would not be found on the next run and the file would re-publish.",
                file=sys.stderr,
            )
            return 2
        record_published(args.record, args.source_hash, args.thought_hash, args.marker)
        print(f"recorded {args.record} / {args.thought_hash[:12]}")
        return 0

    memory_dir = Path(args.memory_dir) if args.memory_dir else None
    if args.body:
        return print_body(args.body, memory_dir)

    if memory_dir is None and args.project:
        matched = [(l, m) for l, m in discover_memory_dirs()
                   if args.project.lower() in l.lower()]
        if not matched:
            print(f"no memory dir matches --project {args.project!r}", file=sys.stderr)
            return 1
        # A substring can quietly select more than intended, and the protocol
        # wants one project per init run. Make the ambiguity visible instead of
        # silently widening the batch.
        if len(matched) > 1:
            print(f"--project {args.project!r} matches {len(matched)} directories:",
                  file=sys.stderr)
            for label, _ in matched:
                print(f"  {label}", file=sys.stderr)
            print("Narrow it, or use --memory-dir for one exact path.", file=sys.stderr)
            return 2
        rows = []
        for label, mem in matched:
            rows.extend(scan(mem, project=label))
    else:
        rows = scan(memory_dir)

    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        print_table(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
