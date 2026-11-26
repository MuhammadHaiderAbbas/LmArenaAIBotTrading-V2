"""Purged walk-forward validation with transaction costs and baselines.

Folds are expanding windows. The training set of every fold ends `horizon` bars before
the test block starts (the purge) so overlapping forward-return labels cannot leak test
information into training. Out-of-sample strategy: long when P(up) > 0.55, otherwise
flat (spot, no shorting), re-decided every `horizon` bars on non-overlapping periods,
paying `cost` per side on every position change.
"""

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sklearn.metrics import roc_auc_score

from app.ml.features import FEATURES, Dataset
from app.ml.models import make_model

THRESHOLD = 0.55
COST_PER_SIDE = {"CRYPTO": 0.0011, "FX": 0.0001, "STOCK": 0.0006, "ETF": 0.0004}
BARS_PER_YEAR = {"CRYPTO": 8760, "FX": 6240, "STOCK": 1764, "ETF": 1764}


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def log_loss(p: np.ndarray, y: np.ndarray) -> float:
    q = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(q) + (1 - y) * np.log(1 - q)))


def calibration(p: np.ndarray, y: np.ndarray, bins: int = 10) -> tuple[float, list[dict[str, float]]]:
    edges = np.linspace(0, 1, bins + 1)
    table, ece = [], 0.0
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= edges[i + 1])
        if m.sum():
            conf, freq = float(p[m].mean()), float(y[m].mean())
            ece += m.sum() / len(p) * abs(conf - freq)
            table.append({"bin": i, "predicted": round(conf, 4), "observed": round(freq, 4), "count": int(m.sum())})
    return float(ece), table


def max_drawdown(equity: np.ndarray) -> float:
    peak = np.maximum.accumulate(equity)
    return float(np.max(1 - equity / peak)) if len(equity) else 0.0


def strategy(p: np.ndarray, fwd: np.ndarray, cost: float, periods_per_year: float) -> dict[str, Any]:
    pos = (p > THRESHOLD).astype(float)
    changes = np.abs(np.diff(np.concatenate([[0.0], pos])))
    rets = pos * fwd - cost * changes
    equity = np.cumprod(1 + rets)
    held = rets[pos > 0]
    sd = rets.std(ddof=1) if len(rets) > 1 else 0.0
    return {
        "net_return": float(equity[-1] - 1) if len(equity) else 0.0,
        "sharpe": float(rets.mean() / sd * math.sqrt(periods_per_year)) if sd > 0 else 0.0,
        "max_drawdown": max_drawdown(equity),
        "trades": int((np.diff(np.concatenate([[0.0], pos])) > 0).sum()),
        "exposure": float(pos.mean()) if len(pos) else 0.0,
        "hit_rate": float((held > 0).mean()) if len(held) else 0.0,
        "periods": len(rets),
        "equity": equity,
    }


@dataclass
class WalkForward:
    folds: list[dict[str, Any]]
    oos: dict[str, Any]
    baselines: dict[str, dict[str, Any]]
    calibration: list[dict[str, float]]
    curves: dict[str, list[float]]
    test_start: int
    gates: list[dict[str, Any]] = field(default_factory=list)
    eligible: bool = False


def _downsample(x: np.ndarray, n: int = 250) -> list[float]:
    if len(x) <= n:
        return [round(float(v), 5) for v in x]
    idx = np.linspace(0, len(x) - 1, n).astype(int)
    return [round(float(x[i]), 5) for i in idx]


def walk_forward(ds: Dataset, algorithm: str, asset_class: str, n_folds: int = 5,
                 train_frac: float = 0.4, data_source: str = "synthetic") -> WalkForward:
    n, H = len(ds.y), ds.horizon
    start = int(n * train_frac)
    size = (n - start) // n_folds
    if size < 5 * H or start < 200:
        raise ValueError("Not enough data for walk-forward validation")
    cost = COST_PER_SIDE[asset_class]
    ppy = BARS_PER_YEAR[asset_class] / H
    mom_col = FEATURES.index("ret_24")

    p_all, p_clim, p_mom, idx_all, folds = [], [], [], [], []
    for k in range(n_folds):
        s = start + k * size
        e = n if k == n_folds - 1 else s + size
        train_end = s - H                      # purge overlapping labels
        model = make_model(algorithm)
        model.fit(ds.X[:train_end], ds.y[:train_end])
        test = np.arange(s, e)[::H]           # non-overlapping decision points
        p = model.predict_proba(ds.X[test])[:, 1]
        clim = np.full(len(test), ds.y[:train_end].mean())
        mom = np.where(ds.X[test, mom_col] > 0, 0.6, 0.4)
        y, fwd = ds.y[test], ds.fwd[test]
        m_s = strategy(p, fwd, cost, ppy)
        bh = strategy(np.ones(len(test)), fwd, cost, ppy)
        folds.append({
            "fold": k + 1, "train_size": int(train_end), "test_size": int(len(test)),
            "test_from": ds.times[s].isoformat(), "test_to": ds.times[e - 1].isoformat(),
            "brier": round(brier(p, y), 5), "brier_climatology": round(brier(clim, y), 5),
            "net_return": round(m_s["net_return"], 5), "buy_hold_return": round(bh["net_return"], 5),
            "beats_buy_hold": m_s["net_return"] > bh["net_return"],
        })
        p_all.append(p), p_clim.append(clim), p_mom.append(mom), idx_all.append(test)

    idx = np.concatenate(idx_all)
    p, clim, mom = np.concatenate(p_all), np.concatenate(p_clim), np.concatenate(p_mom)
    y, fwd = ds.y[idx], ds.fwd[idx]
    ece, cal = calibration(p, y)
    model_s = strategy(p, fwd, cost, ppy)
    bh_s = strategy(np.ones(len(idx)), fwd, cost, ppy)
    mom_s = strategy(mom, fwd, cost, ppy)
    try:
        auc = float(roc_auc_score(y, p))
    except ValueError:
        auc = 0.5

    def pub(s: dict[str, Any]) -> dict[str, Any]:
        return {k: (round(v, 5) if isinstance(v, float) else v) for k, v in s.items() if k != "equity"}

    oos = {
        "samples": int(len(idx)), "accuracy": round(float(((p > 0.5) == y).mean()), 4),
        "brier": round(brier(p, y), 5), "brier_climatology": round(brier(clim, y), 5),
        "log_loss": round(log_loss(p, y), 5), "auc": round(auc, 4), "ece": round(ece, 4),
        "base_rate": round(float(y.mean()), 4), "cost_per_side": cost, "threshold": THRESHOLD,
        **{f"strategy_{k}": v for k, v in pub(model_s).items()},
    }
    wf = WalkForward(
        folds=folds, oos=oos,
        baselines={"buy_hold": pub(bh_s), "momentum": pub(mom_s),
                   "climatology": {"brier": round(brier(clim, y), 5)}},
        calibration=cal,
        curves={"times": [ds.times[i].isoformat() for i in idx[np.linspace(0, len(idx) - 1, min(250, len(idx))).astype(int)]],
                "model": _downsample(model_s["equity"]), "buy_hold": _downsample(bh_s["equity"]),
                "momentum": _downsample(mom_s["equity"])},
        test_start=start,
    )
    wf.gates = gates(wf, data_source)
    wf.eligible = all(g["passed"] for g in wf.gates)
    return wf


MAX_PLAUSIBLE_SHARPE, MAX_PLAUSIBLE_AUC = 4.0, 0.75
# Only tradable market feeds may produce a promotable model. "synthetic" is the demo
# generator; "ecb_reference" is a real but non-executable daily fixing, so neither can
# underwrite a trading model. Unknown provider names are fail-closed too.
REAL_TRAINING_SOURCES = frozenset({"coinbase", "finnhub", "oanda"})


def recheck_gates(metrics: dict[str, Any], data_source: str = "synthetic") -> list[dict[str, Any]]:
    """Recompute the nine gates from persisted walk-forward evidence at promotion time.

    Stored `eligible` flags and gate results are cached decisions, not proof. Rebuilding the
    gates from recorded out-of-sample metrics with the version's *actual* data source means a
    stale approval cannot survive a synthetic/provider mismatch.
    """
    return gates(WalkForward(metrics.get("folds", []), metrics["oos"], metrics["baselines"],
                             metrics.get("calibration", []), {}, 0), data_source)


def gates(wf: WalkForward, data_source: str = "synthetic") -> list[dict[str, Any]]:
    o, b = wf.oos, wf.baselines
    consistency = sum(f["beats_buy_hold"] for f in wf.folds) / len(wf.folds)

    def g(name: str, passed: bool, value: str, threshold: str) -> dict[str, Any]:
        return {"name": name, "passed": bool(passed), "value": value, "threshold": threshold}

    return [
        g("Beats buy & hold after costs", o["strategy_net_return"] > b["buy_hold"]["net_return"],
          f"{o['strategy_net_return']:+.2%} vs {b['buy_hold']['net_return']:+.2%}", "> buy & hold"),
        g("Beats momentum baseline after costs", o["strategy_net_return"] > b["momentum"]["net_return"],
          f"{o['strategy_net_return']:+.2%} vs {b['momentum']['net_return']:+.2%}", "> momentum"),
        g("Probabilistic skill (Brier)", o["brier"] < o["brier_climatology"],
          f"{o['brier']:.4f} vs {o['brier_climatology']:.4f}", "< climatology"),
        g("Calibration error", o["ece"] < 0.08, f"{o['ece']:.3f}", "< 0.080"),
        g("Positive risk-adjusted return", o["strategy_sharpe"] > 0.5, f"{o['strategy_sharpe']:.2f}", "Sharpe > 0.5"),
        g("Enough out-of-sample trades", o["strategy_trades"] >= 20, str(o["strategy_trades"]), "≥ 20"),
        g("Consistent across folds", consistency >= 0.6, f"{consistency:.0%} of folds", "≥ 60% beat buy & hold"),
        # Skill this strong on financial returns almost always means look-ahead leakage or a
        # non-market data source (e.g. the deterministic synthetic generator). Never promote it.
        g("Plausible performance", o["strategy_sharpe"] <= MAX_PLAUSIBLE_SHARPE and o["auc"] <= MAX_PLAUSIBLE_AUC,
          f"Sharpe {o['strategy_sharpe']:.1f}, AUC {o['auc']:.2f}",
          f"Sharpe ≤ {MAX_PLAUSIBLE_SHARPE:.0f} and AUC ≤ {MAX_PLAUSIBLE_AUC:.2f}"),
        g("Trained on real market data", data_source in REAL_TRAINING_SOURCES, data_source,
          "one of " + ", ".join(sorted(REAL_TRAINING_SOURCES))),
    ]
