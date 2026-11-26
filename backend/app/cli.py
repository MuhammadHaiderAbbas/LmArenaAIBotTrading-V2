"""Operator CLI.

    python -m app.cli create-admin --email you@example.com --name "Your Name"
    python -m app.cli audit-verify                       # verify the chain in the database
    python -m app.cli audit-export --out audit.jsonl     # export (JSON Lines) for archiving
    python -m app.cli audit-verify-file audit.jsonl      # verify an export offline, no database
    python -m app.cli ml-sign-artifacts                  # sign model artifacts trained before Phase 11
    python -m app.cli integrity-check                    # schema, audit chain, ledger, triggers, anchors
    python -m app.cli audit-anchor                       # write the audit head to the configured sinks
    python -m app.cli audit-verify-anchors anchors.jsonl # check external anchors against the chain
    python -m app.cli ops-record backup --file f --sha256 h --size n   # used by infrastructure/backup scripts
    python -m app.cli worker-once                        # one tick (matcher/autopilot/drift/anchor)
    python -m app.cli go-live-check                      # exit 1 unless every operational gate passes

The admin password is read from AUREX_ADMIN_PASSWORD or prompted for interactively.
"""

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import select

from app.core.errors import Conflict
from app.core.security import sign_artifact
from app.database.session import SessionLocal, engine
from app.models import ModelVersion, RoleName
from app.schemas.auth import RegisterRequest
from app.services.audit_service import AuditContext, AuditService, export_lines, verify_export
from app.services.auth_service import AuthService


async def create_admin(email: str, name: str, password: str) -> int:
    try:
        RegisterRequest(email=email, full_name=name, password=password)
    except ValidationError as e:
        print(f"Invalid input: {e.errors()[0]['msg']}", file=sys.stderr)
        return 2
    async with SessionLocal() as db:
        try:
            user = await AuthService(db).create_user(email, name, password, RoleName.ADMIN)
        except Conflict as e:
            print(e.message, file=sys.stderr)
            return 1
        await AuditService(db).record(AuditContext(actor_user_id=user.id), "admin.bootstrap",
                                      resource_type="user", resource_id=user.id,
                                      details={"via": "cli"})
        await db.commit()
        print(f"Created administrator {user.email} ({user.id})")
    await engine.dispose()
    return 0


async def audit_verify() -> int:
    async with SessionLocal() as db:
        r = await AuditService(db).verify_chain()
    await engine.dispose()
    print(json.dumps(r, default=str))
    return 0 if r["valid"] else 1


async def audit_export(out: str, from_id: int) -> int:
    async with SessionLocal() as db:
        lines = [line async for line in export_lines(db, from_id)]
        n = len(lines)
        await asyncio.to_thread(Path(out).write_text, "".join(lines), encoding="utf-8")
        await AuditService(db).record(AuditContext(), "admin.audit.export", details={"from_id": from_id, "via": "cli"})
        await db.commit()
    await engine.dispose()
    print(f"Exported {n - 1} records to {out}")
    return 0


def audit_verify_file(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        r = verify_export(f)
    print(json.dumps(r))
    return 0 if r["valid"] else 1


async def ml_sign_artifacts(confirm: bool) -> int:
    """Sign artifacts that predate HMAC signing. Run only on a database you trust: signing
    vouches for the bytes that are there now. Artifacts whose SHA-256 no longer matches are skipped."""
    signed = skipped = 0
    async with SessionLocal() as db:
        rows = await db.scalars(select(ModelVersion).where(ModelVersion.artifact_hmac.is_(None)))
        for v in rows:
            await db.refresh(v, ["artifact"])
            if hashlib.sha256(v.artifact).hexdigest() != v.artifact_sha256:
                skipped += 1
                continue
            if confirm:
                v.artifact_hmac = sign_artifact(v.artifact)
            signed += 1
        if confirm:
            await AuditService(db).record(AuditContext(), "ml.artifacts.sign",
                                          details={"signed": signed, "skipped": skipped})
            await db.commit()
    await engine.dispose()
    print(f"{'Signed' if confirm else 'Would sign'} {signed} artifact(s); skipped {skipped} with a hash mismatch."
          + ("" if confirm else " Re-run with --yes to apply."))
    return 0


async def integrity_check() -> int:
    from app.ops.integrity import run_checks
    async with SessionLocal() as db:
        checks = await run_checks(db)
    await engine.dispose()
    for c in checks:
        print(f"{'OK  ' if c['ok'] else 'FAIL'} {c['name']:<30} {c['detail']}")
    return 0 if all(c["ok"] for c in checks) else 1


def verify_evidence_manifest(attestations: dict[str, dict] | None = None) -> tuple[bool, list[str]]:
    """Cross-check recorded attestations against the signed evidence manifest on disk.

    A reference typed into the UI cannot certify an external review: the manifest must point
    at a real, unchanged, signed document with a reviewer and a review date, and its SHA-256
    must match the hash recorded in the attestation. Drafts and placeholders stay unsigned.
    """
    roots = [Path.cwd(), *Path(__file__).resolve().parents]
    manifest_path = next((p / "compliance" / "evidence-manifest.json" for p in roots
                          if (p / "compliance" / "evidence-manifest.json").is_file()), None)
    if manifest_path is None:
        return False, ["evidence manifest missing"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = {item["id"]: item for item in manifest["evidence"]}
    problems: list[str] = []
    for gate in ("pentest", "solicitor", "dpia", "privacy_policy"):
        item = items.get(gate)
        if not item:
            problems.append(f"{gate}: no manifest entry")
            continue
        path = manifest_path.parents[1] / item["path"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        if not item.get("signed_off") or not item.get("reviewer") or not item.get("reviewed_at"):
            problems.append(f"{gate}: not signed off")
        if digest != item.get("sha256"):
            problems.append(f"{gate}: document hash mismatch")
        attested = (attestations or {}).get(gate)
        if attested and attested.get("evidence_sha256") != item.get("sha256"):
            problems.append(f"{gate}: attestation hash does not match the approved document")
    return not problems, problems


async def go_live_check() -> int:
    """Machine-readable go-live decision. Exit 1 means the launch is blocked."""
    from app.ops import controls
    from app.ops.status import ATTESTABLE, ops_status

    async with SessionLocal() as db:
        st = await ops_status(db)
        attestations = {k: await controls.get(db, controls.ATTEST_PREFIX + k) for k in ATTESTABLE}
    await engine.dispose()
    failed = [g["key"] for g in st["gates"] if not g["ok"]]
    manifest_ok, evidence_problems = verify_evidence_manifest(attestations)
    if not manifest_ok:
        failed.append("evidence_manifest")
    # Defense in depth: even a green status cannot authorise live trading at Stage 1.
    if st["live_trading_enabled"]:
        failed.append("live_trading")
    ok = not failed
    print(json.dumps({"ok": ok, "gates_met": st["gates_met"], "gates_total": st["gates_total"],
                      "failed": failed, "evidence_problems": evidence_problems,
                      "live_trading_enabled": st["live_trading_enabled"]}, default=str))
    return 0 if ok else 1


async def audit_anchor() -> int:
    from app.ops import anchoring
    if not anchoring.sinks_configured():
        print("No anchor sink configured (AUREX_AUDIT_ANCHOR_FILE / AUREX_AUDIT_ANCHOR_WEBHOOK_URL)", file=sys.stderr)
        return 2
    async with SessionLocal() as db:
        a = await anchoring.anchor_now(db)
        await db.commit()
    await engine.dispose()
    print(json.dumps({"last_record_id": a.last_record_id, "head_hash": a.head_hash, "sinks": a.sinks}))
    return 0 if all(r["ok"] for r in a.sinks) else 1


async def audit_verify_anchors(path: str) -> int:
    from app.ops.anchoring import verify_anchors
    lines = (await asyncio.to_thread(Path(path).read_text, encoding="utf-8")).splitlines()
    async with SessionLocal() as db:
        r = await verify_anchors(db, lines)
    await engine.dispose()
    print(json.dumps(r))
    return 0 if r["valid"] else 1


async def worker_once() -> int:
    """One external-scheduler tick. Exits 0 when skipped because another worker holds the lease."""
    from app.ops import worker

    out = await worker.run_once()
    print(json.dumps(out if out is not None else {"skipped": "lease_held"}, default=str))
    return 0


async def ops_record(kind: str, file: str, sha256: str, size: int, ok: bool, detail: str) -> int:
    from datetime import UTC, datetime

    from app.ops import controls
    key = {"backup": controls.LAST_BACKUP, "restore-drill": controls.LAST_RESTORE_DRILL,
           "offsite-backup": controls.LAST_OFFSITE_BACKUP, "offsite-anchor": controls.LAST_OFFSITE_ANCHOR}[kind]
    value = {"at": datetime.now(UTC).isoformat(), "file": os.path.basename(file), "sha256": sha256, "size": size, "ok": ok, "detail": detail}
    async with SessionLocal() as db:
        await controls.put(db, key, value)
        await AuditService(db).record(AuditContext(), f"ops.{kind.replace('-', '_')}", outcome="success" if ok else "failure", details=value)
        await db.commit()
    await engine.dispose()
    print(json.dumps(value))
    return 0


def main() -> None:
    p = argparse.ArgumentParser(prog="aurex")
    sub = p.add_subparsers(dest="cmd", required=True)
    ca = sub.add_parser("create-admin")
    ca.add_argument("--email", required=True)
    ca.add_argument("--name", default="Administrator")
    sub.add_parser("audit-verify")
    ae = sub.add_parser("audit-export")
    ae.add_argument("--out", required=True)
    ae.add_argument("--from-id", type=int, default=1)
    av = sub.add_parser("audit-verify-file")
    av.add_argument("path")
    ms = sub.add_parser("ml-sign-artifacts")
    ms.add_argument("--yes", action="store_true")
    sub.add_parser("integrity-check")
    sub.add_parser("audit-anchor")
    va = sub.add_parser("audit-verify-anchors")
    va.add_argument("path")
    sub.add_parser("worker-once")
    sub.add_parser("go-live-check")
    orc = sub.add_parser("ops-record")
    orc.add_argument("kind", choices=["backup", "restore-drill", "offsite-backup", "offsite-anchor"])
    orc.add_argument("--file", required=True)
    orc.add_argument("--sha256", required=True)
    orc.add_argument("--size", type=int, required=True)
    orc.add_argument("--failed", action="store_true")
    orc.add_argument("--detail", default="")
    args = p.parse_args()
    if args.cmd == "create-admin":
        password = os.environ.get("AUREX_ADMIN_PASSWORD") or getpass.getpass("Password: ")
        sys.exit(asyncio.run(create_admin(args.email, args.name, password)))
    elif args.cmd == "audit-verify":
        sys.exit(asyncio.run(audit_verify()))
    elif args.cmd == "audit-export":
        sys.exit(asyncio.run(audit_export(args.out, args.from_id)))
    elif args.cmd == "audit-verify-file":
        sys.exit(audit_verify_file(args.path))
    elif args.cmd == "ml-sign-artifacts":
        sys.exit(asyncio.run(ml_sign_artifacts(args.yes)))
    elif args.cmd == "integrity-check":
        sys.exit(asyncio.run(integrity_check()))
    elif args.cmd == "go-live-check":
        sys.exit(asyncio.run(go_live_check()))
    elif args.cmd == "audit-anchor":
        sys.exit(asyncio.run(audit_anchor()))
    elif args.cmd == "audit-verify-anchors":
        sys.exit(asyncio.run(audit_verify_anchors(args.path)))
    elif args.cmd == "worker-once":
        sys.exit(asyncio.run(worker_once()))
    elif args.cmd == "ops-record":
        sys.exit(asyncio.run(ops_record(args.kind, args.file, args.sha256, args.size, not args.failed, args.detail)))


if __name__ == "__main__":
    main()
