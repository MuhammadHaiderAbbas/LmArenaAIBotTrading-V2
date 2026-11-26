"""Soft launch: public status, feedback loop and the legal change gate."""

from pathlib import Path

from tests.conftest import API, admin_headers

ROOT = Path(__file__).resolve().parents[2]


async def test_public_status_is_safe(client):
    r = await client.get(f"{API}/system/status")
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "soft_launch" and body["trading_mode"] == "PAPER"
    assert body["live_trading_enabled"] is False and body["feedback_enabled"] is True
    assert set(body["checks"]) == {"database", "schema", "redis", "worker"}
    assert "legal_review_required_for" in body
    assert "gates" not in body and "users" not in body


async def test_feedback_submit_and_admin_review(client):
    r = await client.post(f"{API}/feedback", json={
        "category": "idea", "message": "Please add a GBP paper account preset.",
        "reply_email": "tester@example.com"})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "new" and r.json()["category"] == "idea"
    assert (await client.post(f"{API}/feedback", json={"category": "bug", "message": "too short"})).status_code == 422

    ah = await admin_headers(client)
    listing = (await client.get(f"{API}/admin/feedback", headers=ah)).json()
    assert listing["total"] == 1 and listing["items"][0]["message"].startswith("Please add")
    assert (await client.get(f"{API}/admin/feedback", headers={"Authorization": "Bearer invalid"})).status_code == 401


async def test_feedback_is_rate_limited(client):
    payload = {"category": "other", "message": "A sufficiently long soft-launch comment."}
    for _ in range(5):
        assert (await client.post(f"{API}/feedback", json=payload)).status_code == 201
    assert (await client.post(f"{API}/feedback", json=payload)).status_code == 429


def test_legal_review_gate_is_fail_closed():
    import subprocess
    import sys

    result = subprocess.run(  # noqa: S603 - fixed local script, no untrusted input
        [sys.executable, str(ROOT / "scripts" / "check_legal_gate.py"),
         "--base", "HEAD", "--head", "HEAD", "--force"],
        capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "not signed off" in result.stdout or "not signed off" in result.stderr
