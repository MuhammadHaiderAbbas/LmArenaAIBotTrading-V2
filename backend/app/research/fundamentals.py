"""Fundamental ratios and valuation analysis for equities/ETFs.

Two labelled paths, never mixed silently:
  * ``finnhub`` — licensed vendor metrics from /stock/metric (needs AUREX_FINNHUB_API_KEY).
  * ``document_extraction`` — deterministic regex extraction of clearly stated figures
    from ingested earnings/filing chunks, with the source quote retained as evidence.

Missing figures are omitted; no ratios are invented. Every analysis carries source,
as-of time, warnings and the evidence used, so a report can be audited.
"""

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import InvalidOperation
from typing import Any

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models import Instrument, ResearchChunk, ResearchDocument

log = logging.getLogger("aurex.research.fundamentals")

# "revenue was $4.2 billion" / "net income of 1.3 million" etc.
FIGURE = re.compile(
    r"\b(revenue|net income|earnings per share|eps|total debt|long-term debt|"
    r"cash and cash equivalents|shareholders'? equity|total equity|gross profit)\b"
    r"[^.]{0,80}?\$\s*([0-9]+(?:\.[0-9]+)?)\s*(trillion|billion|million|thousand)?",
    re.IGNORECASE)
MULTIPLIER = {"trillion": 1e12, "billion": 1e9, "million": 1e6, "thousand": 1e3}
FIELDS = {
    "revenue": "revenue", "net income": "net_income", "earnings per share": "eps", "eps": "eps",
    "total debt": "total_debt", "long-term debt": "total_debt",
    "cash and cash equivalents": "cash", "shareholders equity": "equity",
    "shareholder equity": "equity", "total equity": "equity", "gross profit": "gross_profit",
}

@dataclass
class FundamentalAnalysis:
    symbol: str
    source: str
    as_of: datetime
    ratios: dict[str, float] = field(default_factory=dict)
    valuation: dict[str, float] = field(default_factory=dict)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol, "source": self.source,
            "as_of": self.as_of.isoformat(),
            "ratios": self.ratios, "valuation": self.valuation,
            "evidence": self.evidence, "warnings": self.warnings,
        }


def _number(value: Any) -> float | None:
    try:
        n = float(value)
        return n if n == n and abs(n) != float("inf") else None  # no NaN/inf
    except (TypeError, ValueError):
        return None


def _safe_div(a: float | None, b: float | None) -> float | None:
    if a is None or b in (None, 0):
        return None
    return a / b


class FinnhubFundamentals:
    """Small read-only client for /stock/metric."""

    def __init__(self, api_key: str, base_url: str, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=10.0,
            headers={"X-Finnhub-Token": api_key, "User-Agent": "aurex-ai/0.4"})
        self._client.headers.update({"X-Finnhub-Token": api_key})

    async def metrics(self, symbol: str) -> dict[str, float]:
        r = await self._client.get("/stock/metric", params={"symbol": symbol, "metric": "all"})
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict) or not isinstance(data.get("metric"), dict):
            raise ValueError("finnhub metrics: unexpected payload")
        return {k: n for k, v in data["metric"].items() if (n := _number(v)) is not None}


def _extract_figures(chunks: list[tuple[ResearchChunk, ResearchDocument]],
                     last_price: float | None) -> tuple[dict[str, float], list[dict[str, Any]]]:
    figures: dict[str, float] = {}
    evidence: list[dict[str, Any]] = []
    for chunk, doc in chunks:
        for match in FIGURE.finditer(chunk.text):
            label = FIELDS.get(re.sub(r"[^a-z ]", "", match.group(1).lower()))
            if label is None or label in figures:
                continue
            try:
                amount = float(match.group(2)) * MULTIPLIER.get((match.group(3) or "").lower(), 1)
            except (ValueError, InvalidOperation):
                continue
            if amount <= 0:
                continue
            figures[label] = amount
            evidence.append({
                "metric": label, "document_id": str(doc.id), "title": doc.title,
                "source_name": doc.source_name, "page": chunk.page,
                "quote": chunk.text[max(0, match.start() - 60):match.end() + 60].strip()[:400],
            })
    ratios: dict[str, float] = {}
    if (v := _safe_div(figures.get("net_income"), figures.get("revenue"))) is not None:
        ratios["net_margin"] = v
    if (v := _safe_div(figures.get("gross_profit"), figures.get("revenue"))) is not None:
        ratios["gross_margin"] = v
    if (v := _safe_div(figures.get("total_debt"), figures.get("equity"))) is not None:
        ratios["debt_to_equity"] = v
    eps = figures.get("eps")
    if eps and last_price and eps <= last_price * 10:
        ratios["pe_ratio"] = last_price / eps
    return ratios, evidence


class FundamentalService:
    def __init__(self, client: httpx.AsyncClient | None = None):
        s = get_settings()
        self.s = s
        self._client = client
        self._cache: dict[str, tuple[float, FundamentalAnalysis]] = {}

    async def analyse(self, inst: Instrument, last_price: float | None = None,
                      db=None) -> FundamentalAnalysis:
        now = datetime.now(UTC)
        if inst.asset_class not in ("STOCK", "ETF"):
            return FundamentalAnalysis(inst.symbol, "not_applicable", now,
                                       warnings=["Fundamental ratios apply to stocks and ETFs only"])
        cached = self._cache.get(inst.symbol)
        if cached and time.monotonic() - cached[0] < self.s.fundamentals_ttl_seconds:
            return cached[1]

        warnings: list[str] = []
        ratios: dict[str, float] = {}
        valuation: dict[str, float] = {}
        evidence: list[dict[str, Any]] = []
        source = "unavailable"
        if self.s.finnhub_api_key:
            try:
                client = FinnhubFundamentals(
                    self.s.finnhub_api_key, self.s.finnhub_base_url, client=self._client)
                m = await client.metrics(inst.provider_symbol)
                source = "finnhub"
                mapping = {
                    "peTTM": "pe_ratio", "peBasicExclExtraTTM": "pe_ratio",
                    "pbQuarterly": "pb_ratio", "psTTM": "ps_ratio", "psAnnual": "ps_ratio",
                    "netMarginTTM": "net_margin", "grossMarginTTM": "gross_margin",
                    "currentRatioQuarterly": "current_ratio", "roeTTM": "roe",
                    "dividendYieldIndicatedAnnual": "dividend_yield",
                    "totalDebt/totalEquityQuarterly": "debt_to_equity",
                }
                for vendor_key, our_key in mapping.items():
                    if (v := m.get(vendor_key)) is not None:
                        ratios.setdefault(our_key, v)
                cap = m.get("marketCapitalization")
                ev = m.get("enterpriseValue")
                if ev and cap:
                    valuation["market_cap"] = cap
                    valuation["enterprise_value"] = ev
                    if (v := _safe_div(ev, cap)) is not None:
                        valuation["ev_to_market_cap"] = v
                if not ratios:
                    warnings.append("Licensed feed returned no usable ratios")
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
                log.warning("fundamentals feed unavailable for %s: %s", inst.symbol,
                            e.__class__.__name__)
                warnings.append("Licensed fundamentals feed unavailable")

        if source != "finnhub":
            own_db = db is None
            session = db or SessionLocal()
            try:
                rows = (await session.execute(
                    select(ResearchChunk, ResearchDocument)
                    .join(ResearchDocument, ResearchChunk.document_id == ResearchDocument.id)
                    .where(ResearchDocument.symbols.any(inst.symbol))
                    .where(ResearchDocument.doc_type.in_(("earnings", "filing")))
                    .order_by(ResearchDocument.published_at.desc().nulls_last())
                    .limit(60))).all()
                ratios, evidence = _extract_figures(list(rows), last_price)
                source = "document_extraction" if ratios else "unavailable"
                if ratios:
                    warnings.append(
                        "Figures parsed from research text; verify against the original filing")
                else:
                    warnings.append("No licensed metrics or extractable filing figures found")
            finally:
                if own_db:
                    await session.close()

        result = FundamentalAnalysis(inst.symbol, source, now, ratios, valuation, evidence, warnings)
        self._cache[inst.symbol] = (time.monotonic(), result)
        return result
