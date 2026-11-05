#!/usr/bin/env python3
"""Reproducibly redact engineering transcripts without removing their sequence or code.

Default: report documents requiring redaction. --write updates only Markdown under
packages/opencode-recall/doc. No original-to-alias mapping is persisted.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def alias(value, kind):
    return f"{kind}_example_{hashlib.sha256(value.encode()).hexdigest()[:12]}"


def redact(text):
    # Keep cross-document IDs consistent, including fork suffixes, without publishing live IDs.
    text = re.sub(
        r"\b(ses|msg|tool)_(?!example_)[a-f0-9][A-Za-z0-9]{7,}(?:_\d+)?",
        lambda m: alias(m[0], m[1]),
        text,
    )
    text = re.sub(
        r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
        lambda m: alias(m[0], "trace"),
        text,
        flags=re.I,
    )
    text = re.sub(r"(?:/Users|/home)/[^/\s`\"'<>\\]+", "~", text)
    text = re.sub(r"/private/var/folders/[^\s`\"'<>\\]+", "<temp-dir>", text)
    text = re.sub(
        r"(?<![\w.])(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+(?![\w.])",
        "192.0.2.10",
        text,
    )
    text = re.sub(r"(?<![\w/])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "user@example.com", text)
    # Historical provider identifiers are illustrative, not a required private gateway.
    text = re.sub(
        r"\bgbu-[A-Za-z0-9._-]+",
        lambda m: "decision-model" if "decisions" in m[0] else "chat-model",
        text,
    )
    text = re.sub(r"\bgateway(?=/|[\"\\])", "example-provider", text)
    # Remove credential values, including copies inside escaped JSON/tool payloads.
    text = re.sub(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
        "REDACTED_CREDENTIAL",
        text,
    )
    text = re.sub(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        "REDACTED_PRIVATE_KEY",
        text,
        flags=re.S,
    )
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument(
        "--rules",
        type=Path,
        help="Private JSON object mapping exact sensitive phrases to public aliases; keep it outside version control",
    )
    args = parser.parse_args()
    replacements = json.loads(args.rules.read_text()) if args.rules else {}
    if not isinstance(replacements, dict) or any(
        not isinstance(k, str) or not k or not isinstance(v, str)
        for k, v in replacements.items()
    ):
        parser.error(
            "--rules must contain an object of non-empty strings to string replacements"
        )
    changed = []
    for path in sorted((ROOT / "packages/opencode-recall/doc").rglob("*.md")):
        old = path.read_text()
        new = redact(old)
        for original, replacement in replacements.items():
            new = new.replace(original, replacement)
        if old == new:
            continue
        changed.append(path.relative_to(ROOT).as_posix())
        if args.write:
            path.write_text(new)
    for path in changed:
        print(path)
    print(
        f"{'Redacted' if args.write else 'Needs redaction:'} {len(changed)} document(s)"
    )
    if changed and not args.write:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
