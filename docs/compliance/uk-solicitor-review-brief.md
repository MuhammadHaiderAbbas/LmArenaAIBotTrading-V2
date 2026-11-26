# UK solicitor review — scope and sign-off template

> **Status: brief only.** No solicitor has reviewed this system. The go-live gate stays red
> until a signed opinion is recorded in the evidence manifest. This is not legal advice.

## Questions for counsel

1. Does the paper-trading and research platform, including AI-generated signals and reports,
   fall outside the FCA/PRA perimeter as a purely simulated service? Identify any feature
   that changes that conclusion (licensed quotes, signal weighting, public promotion).
2. Is the binary-options simulator lawful as a clearly labelled educational simulation for
   UK/EEA retail audiences, given the FCA prohibition on retail binary options? What wording
   and geographic controls are required?
3. Are research outputs "financial advice", "arranging", or a financial promotion? What
   disclaimers, risk warnings and approvals are required if launched publicly?
4. Do cryptoasset promotion rules apply to the demo or live build? Which FCA sourcebook
   provisions and financial-promotion restrictions must be satisfied?
5. Confirm the UK GDPR controller/processor arrangement, international transfer mechanism,
   retention schedule and whether a DPO is required.
6. Review the privacy policy and DPIA in `docs/compliance/` and note any required changes.
7. Confirm whether registration should remain closed (invite-only) for Stage 1.

## What we assert (engineering facts, not legal conclusions)

- No real money, payment, custody, broker or withdrawal integration exists.
- Accounts are database-constrained to `PAPER`; live trading is hard-coded off.
- Binary contracts settle only to virtual ledger balances and carry an explicit retail warning.
- AI agents are advisory and have zero default vote weight; a human admin promotes models.
- Market prices are labelled `actual`, `estimated_spread`, `reference` or `simulated`.

## Sign-off template

Save the signed opinion at `docs/compliance/uk-solicitor-opinion.md` (or link a PDF) and record
its SHA-256, reviewer, review date and reference in the evidence manifest. The opinion should
state: (a) answers to questions 1–7; (b) any mandatory pre-launch changes; (c) whether public
onboarding is permitted; (d) firm, solicitor name, date and signature.
