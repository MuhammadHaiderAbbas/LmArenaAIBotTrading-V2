import math
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from app.ml import drift, validation
from app.ml.features import FEATURES, WARMUP, build_dataset, feature_matrix
from app.ml.validation import (
    WalkForward,
    brier,
    calibration,
    gates,
    max_drawdown,
    recheck_gates,
    strategy,
    walk_forward,
)

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def bars(n: int, seed: int = 1):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.004, n)))
    h, lo = c * 1.002, c * 0.998
    times = [T0 + timedelta(hours=i) for i in range(n)]
    return times, h, lo, c


def test_features_never_look_ahead():
    times, h, lo, c = bars(400)
    full = feature_matrix(times, h, lo, c)
    k = 300
    c2 = c.copy()
    c2[k:] *= 1.5          # perturb the future violently
    part = feature_matrix(times, h, lo, c2)
    assert np.allclose(full[:k], part[:k], equal_nan=True)
    assert full.shape == (400, len(FEATURES))


def test_dataset_target_alignment_and_warmup():
    times, h, lo, c = bars(600)
    ds = build_dataset(times, list(h), list(lo), list(c), horizon=4)
    first = times.index(ds.times[0])
    assert first >= WARMUP and np.isfinite(ds.X).all()
    i = times.index(ds.times[10])
    assert math.isclose(ds.fwd[10], c[i + 4] / c[i] - 1)
    assert ds.y[10] == int(c[i + 4] > c[i])
    assert times.index(ds.times[-1]) == len(c) - 5     # last 4 rows have no label


def test_metrics():
    y = np.array([1, 0, 1, 0])
    assert brier(y.astype(float), y) == 0.0
    assert brier(np.full(4, 0.5), y) == 0.25
    assert max_drawdown(np.array([1.0, 1.2, 0.9, 1.3])) == pytest.approx(0.25)
    p = np.array([0.2] * 50 + [0.8] * 50)
    yy = np.array([0] * 40 + [1] * 10 + [1] * 40 + [0] * 10)
    ece, table = calibration(p, yy)
    assert ece == pytest.approx(0.0) and len(table) == 2
    s = strategy(np.ones(3), np.array([0.01, 0.01, 0.01]), cost=0.001, periods_per_year=100)
    assert s["trades"] == 1 and s["net_return"] == pytest.approx(1.01 ** 3 - 1 - 0.001 * 1.01 ** 2, rel=1e-3)
    flat = strategy(np.zeros(3), np.array([0.05, -0.05, 0.05]), cost=0.001, periods_per_year=100)
    assert flat["net_return"] == 0 and flat["trades"] == 0


def test_walk_forward_purges_overlapping_labels(monkeypatch):
    times, h, lo, c = bars(2000)
    ds = build_dataset(times, list(h), list(lo), list(c), horizon=6)
    fits = []

    class Spy:
        def fit(self, X, y):
            fits.append(len(X))
            return self

        def predict_proba(self, X):
            return np.column_stack([np.full(len(X), 0.5), np.full(len(X), 0.5)])

    monkeypatch.setattr(validation, "make_model", lambda _: Spy())
    wf = walk_forward(ds, "logistic", "CRYPTO", data_source="coinbase")
    start, size = wf.test_start, (len(ds.y) - wf.test_start) // 5
    assert fits == [start + k * size - 6 for k in range(5)]     # train ends `horizon` bars before each test block
    assert len(wf.folds) == 5 and all(f["test_size"] > 0 for f in wf.folds)
    assert wf.oos["samples"] == sum(f["test_size"] for f in wf.folds)
    assert wf.oos["strategy_trades"] == 0          # p = 0.5 never crosses the 0.55 threshold
    assert not wf.eligible


def _wf(**oos) -> WalkForward:
    base = {"strategy_net_return": 0.2, "brier": 0.24, "brier_climatology": 0.25, "ece": 0.03, "strategy_sharpe": 1.5,
            "strategy_trades": 40, "auc": 0.58}
    base.update(oos)
    folds = [{"beats_buy_hold": True}] * 4 + [{"beats_buy_hold": False}]
    return WalkForward(folds, base, {"buy_hold": {"net_return": 0.05}, "momentum": {"net_return": 0.1}}, [], {}, 0)


def test_gates_logic():
    assert all(g["passed"] for g in gates(_wf(), "coinbase"))
    failed = {g["name"] for g in gates(_wf(), "synthetic") if not g["passed"]}
    assert failed == {"Trained on real market data"}
    assert {g["name"] for g in gates(_wf(), "ecb_reference") if not g["passed"]} == {
        "Trained on real market data"}              # real but non-executable feed
    wf = _wf()
    metrics = {"oos": wf.oos, "baselines": wf.baselines, "folds": wf.folds,
               "calibration": wf.calibration}
    assert all(g["passed"] for g in recheck_gates(metrics, "coinbase"))
    assert not recheck_gates(metrics, "synthetic")[-1]["passed"]
    failed = {g["name"] for g in gates(_wf(strategy_sharpe=9, auc=0.95), "coinbase") if not g["passed"]}
    assert failed == {"Plausible performance"}
    failed = {g["name"] for g in gates(_wf(strategy_net_return=0.01, brier=0.26, ece=0.2, strategy_trades=3),
                                       "coinbase") if not g["passed"]}
    assert failed == {"Beats buy & hold after costs", "Beats momentum baseline after costs",
                      "Probabilistic skill (Brier)", "Calibration error", "Enough out-of-sample trades"}


def test_psi_and_drift_assessment():
    rng = np.random.default_rng(3)
    X = rng.normal(0, 1, (5000, len(FEATURES)))
    ref = drift.reference(X)
    same = drift.psi(ref, rng.normal(0, 1, (2000, len(FEATURES))))
    assert max(same.values()) < 0.02
    shifted = rng.normal(0, 1, (2000, len(FEATURES)))
    shifted[:, :3] += 1.5
    p = drift.psi(ref, shifted)
    assert all(p[f] > 0.25 for f in FEATURES[:3]) and p[FEATURES[5]] < 0.05
    a = drift.assess(p, recent_brier=0.25, oos_brier=0.24)
    assert a["status"] == "drift" and "significant shift in 3 features" in a["reasons"][0]
    assert drift.assess(same, 0.30, 0.24)["status"] == "drift"           # calibration decay alone
    assert drift.assess(same, 0.24, 0.24)["status"] == "ok"
