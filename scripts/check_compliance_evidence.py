#!/usr/bin/env python3
"""Fail-closed check of go-live evidence and automated operational controls.

An external penetration test and a UK solicitor opinion cannot be self-certified: the
manifest entries stay unsigned until a real report exists. This script is used by release
gating; it prints machine-readable JSON and exits 1 while any item is missing, stale or
has a hash mismatch.
"""

import hashlib
import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "compliance" / "evidence-manifest.json"


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    results = []
    for item in manifest["evidence"]:
        problems = []
        path = ROOT / item["path"]
        if not path.is_file():
            problems.append("file missing")
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != item.get("sha256"):
                problems.append("sha256 mismatch (document changed or not approved)")
        if not item.get("signed_off"):
            problems.append("not signed off")
        if not item.get("reviewer"):
            problems.append("no reviewer recorded")
        reviewed = item.get("reviewed_at")
        if not reviewed:
            problems.append("no review date")
        else:
            try:
                age = (datetime.now(UTC).date() - date.fromisoformat(reviewed)).days
                if age < 0 or age > item["max_age_days"]:
                    problems.append(f"review date outside {item['max_age_days']} days")
            except ValueError:
                problems.append("invalid review date")
        results.append({"id": item["id"], "ok": not problems, "problems": problems})

    # Operational controls that must exist in the repository for the runtime gates to work.
    automated = {
        "offsite_backup_script": "backend/ops/backup/offsite.sh",
        "offsite_in_scheduler": "backend/ops/backup/schedule.sh",
        "alert_rules": "infrastructure/monitoring/alerts.yml",
        "offsite_alerts": "infrastructure/monitoring/alerts.yml",
    }
    for name, rel in automated.items():
        text = (ROOT / rel).read_text(encoding="utf-8")
        ok = (("offsite.sh" in text) if name == "offsite_in_scheduler" else
              ("AurexOffsiteBackupStale" in text and "AurexOffsiteAnchorStale" in text)
              if name == "offsite_alerts" else bool(text.strip()))
        results.append({"id": name, "ok": ok, "problems": [] if ok else ["missing automated control"]})

    ok = all(r["ok"] for r in results)
    print(json.dumps({"ok": ok, "passed": sum(r["ok"] for r in results), "total": len(results),
                      "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
