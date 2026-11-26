#!/usr/bin/env python3
"""Fail-closed gate for marketing/data changes during soft launch.

Any commit touching a path in compliance/protected-paths.txt needs a fresh legal sign-off
recorded in compliance/legal-review.json, with the hash of the signed review document and a
review date at or after that commit. --force treats an uncommitted working tree as protected.
"""

import argparse
import fnmatch
import hashlib
import json
import subprocess
import sys
from datetime import UTC, date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "compliance" / "legal-review.json"
PATHS = ROOT / "compliance" / "protected-paths.txt"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          check=True).stdout.strip()


def changed_files(base: str, head: str) -> list[str]:
    try:
        out = git("diff", "--name-only", f"{base}...{head}")
        if not out:
            out = git("diff", "--name-only", base, head)
    except subprocess.CalledProcessError:
        out = git("diff", "--name-only", base, head)
    return [line for line in out.splitlines() if line]


def protected(paths: list[str]) -> list[str]:
    patterns = [line.strip() for line in PATHS.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
    hits = []
    for path in paths:
        if any(fnmatch.fnmatch(path, pat) or path.startswith(pat.rstrip("/") + "/") for pat in patterns):
            hits.append(path)
    return hits


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--force", action="store_true", help="require sign-off even with no matching changes")
    args = parser.parse_args()

    hits = protected(changed_files(args.base, args.head))
    review = json.loads(MANIFEST.read_text(encoding="utf-8"))
    problems: list[str] = []
    if hits or args.force:
        if not review.get("signed_off"):
            problems.append("legal review not signed off")
        if not review.get("reviewer"):
            problems.append("no reviewer recorded")
        evidence = ROOT / str(review.get("evidence_path") or "")
        digest = hashlib.sha256(evidence.read_bytes()).hexdigest() if evidence.is_file() else None
        if digest != review.get("evidence_sha256"):
            problems.append("signed review hash mismatch")
        try:
            reviewed = date.fromisoformat(str(review.get("reviewed_at")))
            age = (datetime.now(UTC).date() - reviewed).days
            if not 0 <= age <= review["valid_for_days"]:
                problems.append("review date missing or stale")
            commit_date = date.fromisoformat(git("log", "-1", "--format=%cs", args.head)[:10])
            if reviewed < commit_date:
                problems.append("review predates the changed commit; re-review required")
        except (ValueError, subprocess.CalledProcessError):
            problems.append("invalid review or commit date")

    ok = not problems
    print(json.dumps({"ok": ok, "protected_changes": hits, "problems": problems}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
