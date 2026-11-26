# Privacy Policy (draft for UK GDPR review)

> **Status: draft.** This is an engineering-prepared template, not legal advice. It must be
> reviewed by qualified UK counsel/DPO and published at the production domain before any
> external user is onboarded. Replace every `[PLACEHOLDER]` and record approval in the
> go-live evidence manifest.

Last updated: 2026-11-25 · Effective: `[DATE]` · Version: 0.1-draft

## 1. Who we are

AUREX AI ("we") provides a research and **paper-trading** platform. For personal data in the
UK we are the controller. Contact: `[CONTACT EMAIL]` · Data protection contact: `[DPO/PRIVACY EMAIL]`
· Registered address: `[ADDRESS]`.

## 2. What we collect

| Category | Examples | Source |
|---|---|---|
| Account data | email, full name, password hash, role | you / administrator |
| Authentication & security | encrypted TOTP seed, recovery-code hashes, session tokens, login timestamps, IP address, user agent | you / your device |
| Paper-trading data | virtual accounts, ledger entries, orders, executions, positions, portfolio snapshots | your activity and synthetic/licensed market data |
| Research data | documents you upload, extracted text, chunks, reports | you; cited public or licensed sources |
| Preferences | watchlists, risk limits, agent weights, alert settings | you |
| Operational records | audit log with actor, IP, request ID; backups; audit anchors | our systems |

We do **not** collect payment details, bank credentials, client money, or brokerage
credentials. There is no real-money trading in this version. Market prices used for research
may come from Coinbase, Finnhub, OANDA, Frankfurter/ECB or a labelled synthetic generator;
we do not send your personal data to those feeds.

## 3. Why we use it and our lawful bases

| Purpose | Data | Lawful basis (to confirm with counsel) |
|---|---|---|
| Provide accounts, sessions, paper trading and research tools | account, session, trading, research | contract (Art. 6(1)(b)) |
| Keep the platform secure and auditable | auth, IP, audit log, risk decisions | legitimate interests (Art. 6(1)(f)) in preventing fraud and confirming integrity |
| Meet legal and regulatory obligations | audit, operational records | legal obligation (Art. 6(1)(c)), where applicable |
| Optional research LLM processing | document text sent to Anthropic when the server-side Claude engine is enabled | consent or legitimate interests, subject to counsel's view and DPIA |

We do not sell personal data and do not use it for advertising.

## 4. Who receives it

- Infrastructure providers hosting the database, Redis, object storage and off-site backups
  (`[PROVIDERS AND LOCATIONS]`).
- `[ANTHROPIC / LLM PROVIDER]` only when the Claude research engine is enabled; document
  text is sent for analysis and is not used for model training by us.
- Professional advisers and regulators where legally required.

A current processor list with transfer safeguards is maintained in the DPIA. International
transfers outside the UK/EEA rely on adequacy regulations or the UK IDTA/Addendum
(`[CONFIRM PER PROCESSOR]`).

## 5. How long we keep it

| Data | Retention |
|---|---|
| Active account and paper-trading records | while the account is active |
| Audit log and anchors | `[RETENTION]`; anchored copies retained `[RETENTION]` for integrity |
| Backups and verified off-site copies | `[BACKUP_RETENTION_DAYS]` days, then deleted |
| Session tokens | until expiry or revocation |
| Research documents uploaded by a user | until deleted by the user or account closure |

Deletion from live systems is followed by expiry from the backup cycle; we do not keep data
 indefinitely.

## 6. Your rights

Subject to conditions and exemptions in UK GDPR, you may request access, rectification,
erasure, restriction, portability, or object to processing based on legitimate interests. You
may withdraw consent where consent is the basis. Contact `[PRIVACY EMAIL]`. You can complain
to the Information Commissioner's Office (ico.org.uk). You are not subject to solely
automated decisions with legal or similarly significant effects: the AI agents are advisory,
have zero default vote weight, and never execute trades automatically.

## 7. Cookies and local storage

Authentication uses HttpOnly, Secure cookies. The static demo stores simulated data in your
browser's localStorage and makes no server-side account. No advertising or cross-site
tracking cookies are used.

## 8. Security

Password hashing, TOTP, session rotation, rate limits, tenant-scoped queries, append-only
ledger and audit records, encrypted secrets, HMAC-signed model artifacts, token-protected
metrics, external audit anchors and verified off-site backups. See
`docs/security/security-model.md`. No system is perfectly secure; incidents are handled
under the runbook.

## 9. Changes

Material changes will be published here with a new version and effective date.

## 10. Approvals

- Privacy lead: `[NAME]` · date: `[DATE]`
- UK counsel review: `[NAME/FIRM]` · date: `[DATE]`
- Evidence SHA-256 and reference: record in `compliance/evidence-manifest.json`.
