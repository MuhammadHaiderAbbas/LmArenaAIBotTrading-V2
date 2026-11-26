# UK GDPR Data Protection Impact Assessment — AUREX AI

> **Status: draft for DPO/counsel approval.** Not legal advice. Version 0.1 · 2026-11-25.
> Go-live remains blocked until sections 8–10 are signed off and the evidence manifest records
> the SHA-256 of the approved document.

## 1. Processing under assessment

AUREX provides authenticated research and paper-trading tools. Processing includes account
identity and authentication, TOTP seeds, session cookies, virtual ledger and order records,
uploaded research documents, risk/audit logs, and operational telemetry. Market data is
licensed or synthetic and is not personal data. There is no real-money trading, custody,
payment processing, or broker integration in this version.

The static public demo runs entirely in the browser with fictional sample content; no account
data is transmitted to a server.

## 2. Necessity and proportionality

| Processing | Why necessary | Alternatives rejected |
|---|---|---|
| Email, password hash, role | authenticate users and separate tenants | anonymous access cannot protect personal research and account history |
| TOTP seed and recovery codes | mandatory for admins in production; protects consequential actions | email-only 2FA is weaker |
| IP address, request ID, audit log | detect abuse, reconstruct decisions, preserve integrity | no audit trail would make financial-style disputes unverifiable |
| Research documents | provide the requested analysis and citations | generic market commentary would not meet the product purpose |
| Backups and off-site copies | recover from loss/ransomware; off-site copy is required by go-live gates | single-host backups fail on site loss |
| Optional Claude engine | improve document analysis where configured | fully local extraction retained as default |

Data minimisation: no payment or broker credentials; audit details avoid unnecessary secrets;
secrets are file-mounted, never logged; analytics exports are scoped to the requester's data.

## 3. Data flows and processors

1. Browser → Caddy → FastAPI replicas → managed PostgreSQL (pgvector) and Redis.
2. Worker/scheduler writes audit, backup and drift records to PostgreSQL.
3. Ops container writes encrypted/hashed backups and verified off-site copies via rclone.
4. Optional Anthropic API receives document text only when `AUREX_RESEARCH_ENGINE=claude`.
5. Licensed market providers (Finnhub, OANDA, Coinbase, Frankfurter) receive symbol/time
   queries only, not personal data.

Processor register, hosting regions, DPAs and transfer mechanism: `[TO BE COMPLETED BY DPO]`.

## 4. Risks and mitigations

| Risk | Impact | Mitigation | Residual |
|---|---|---|---|
| Cross-tenant data exposure | high | owner-scoped queries; 404 for foreign resources; privacy tests across suites; audit exports scoped | low–medium, verify in pentest |
| Account takeover | high | strong password policy, lockout, rate limits, TOTP for admins, session rotation/revocation, JWT rotation | low–medium |
| Audit-chain rewrite/truncation | high | hash chain, external anchors with signed webhook/off-site copy, verification runbook | low if off-site gate green |
| Ransomware / site loss | high | encrypted backups, weekly restore drills, verified off-site copies, 30h freshness gates | low–medium |
| Research document leakage to LLM | medium | server-side key, no client key exposure, opt-in engine, citations, no training by us | medium; confirm processor terms |
| Excessive retention | medium | retention schedule in privacy policy; backup rotation; deletion workflow `[TO IMPLEMENT]` | medium |
| Automated decision concerns | medium | AI advisory only; zero default vote weight; no autonomous trades; human promotion of models | low |
| Children's data | medium | service not directed to children; registration restricted `[CONFIRM AGE POLICY]` | medium |

## 5. Consultation

Engineering, security review (`docs/security/threat-model.md`), and `[DPO / COUNSEL]` —
the latter's written opinion is required before go-live. Data subjects will be consulted via
`[USER RESEARCH / SUPPORT CHANNEL]` if external onboarding is planned.

## 6. Monitoring and review

Review triggers: new processor, new personal-data field, real-money functionality, LLM
provider change, incident, or 12 months elapsed. Quarterly review of access, retention,
backups, restore drill, anchors and alert delivery.

## 7. Decision

Processing may proceed only if all high residual risks are accepted in writing by the DPO and
the go-live gates are green. Otherwise restrict onboarding or change the design.

## 8. DPO conclusion

`[PENDING — DO NOT PUBLISH]`

## 9. Approvals

- Author: `[NAME]` · date: `[DATE]`
- DPO: `[NAME]` · date: `[DATE]`
- Counsel reference: `[REFERENCE]` · SHA-256 of approved PDF: `[HASH]`

## 10. Evidence

Record the approved document hash, review date and reference in
`compliance/evidence-manifest.json`. `python scripts/check_compliance_evidence.py` must pass.
