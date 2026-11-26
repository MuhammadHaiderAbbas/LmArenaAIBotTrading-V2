import { AlertTriangle, Award, CheckCircle2, FlaskConical, GitBranch, Radar, Trophy, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { CalibrationPlot, EQUITY_SERIES, EquityChart } from "@/charts/EquityChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Field, Select } from "@/components/ui/form";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthProvider";
import { useMarketOverview } from "@/features/markets/hooks";
import { useAlgorithms, useDriftCheck, useModels, useTrain, useVersion, useVersionAction } from "@/features/ml/hooks";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { isDemo, type MLVersionDetail, type MLVersionSummary } from "@/services/api";

const pct = (v: number | undefined | null, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const STATUS_TONE = { champion: "positive", candidate: "info", retired: "neutral" } as const;

function StatusBadge({ v }: { v: Pick<MLVersionSummary, "status" | "eligible"> }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge tone={STATUS_TONE[v.status]}>{v.status === "champion" && <Trophy className="size-3" />}{v.status}</Badge>
      {!v.eligible && <Badge tone="warning">ineligible</Badge>}
    </span>
  );
}

function TrainPanel({ onTrained }: { onTrained: (id: string) => void }) {
  const { user } = useAuth();
  const algos = useAlgorithms();
  const overview = useMarketOverview();
  const train = useTrain();
  const [form, setForm] = useState({ symbol: "BTC-USD", algorithm: "", horizon: "4", days: "180" });
  const instruments = Object.values(overview.data?.groups ?? {}).flat().map((g) => g.instrument.symbol);
  // The demo advertises only browser-runnable algorithms; never submit the live build's
  // lightgbm default to the static demo (it would be rejected as unsupported).
  const algorithm = form.algorithm || algos.data?.[0]?.key || "logistic";
  if (user?.role !== "admin") return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = await train.mutateAsync({ symbol: form.symbol, algorithm, horizon: +form.horizon, days: +form.days });
    onTrained(v.id);
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><FlaskConical className="size-4" />Train a candidate</span>}
        description="Purged walk-forward validation, after costs. Never promotes automatically." />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBanner error={train.error} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Instrument" htmlFor="ml-sym">
              <Select id="ml-sym" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>
                {instruments.map((s) => <option key={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Algorithm" htmlFor="ml-algo">
              <Select id="ml-algo" value={algorithm} onChange={(e) => setForm({ ...form, algorithm: e.target.value })}>
                {(algos.data ?? []).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </Select>
            </Field>
            <Field label="Horizon" htmlFor="ml-h">
              <Select id="ml-h" value={form.horizon} onChange={(e) => setForm({ ...form, horizon: e.target.value })}>
                {[1, 2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
              </Select>
            </Field>
            <Field label="History" htmlFor="ml-d">
              <Select id="ml-d" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
                {[60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              </Select>
            </Field>
          </div>
          <p className="text-[11px] text-subtle">{algos.data?.find((a) => a.key === form.algorithm)?.description}</p>
          <Button type="submit" className="w-full" disabled={train.isPending}>{train.isPending ? <Spinner className="text-accent-fg" /> : <FlaskConical />}{train.isPending ? "Training & validating…" : "Train & validate"}</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function Registry({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const models = useModels();
  const list = models.data ?? [];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><GitBranch className="size-4" />Model registry</span>} description={`${list.length} specification(s)`} />
      {models.isLoading ? <div className="p-6"><Spinner /></div> : list.length === 0 ? (
        <EmptyState icon={<FlaskConical />} title="No models yet">An administrator can train the first candidate.</EmptyState>
      ) : (
        <ul className="max-h-[520px] divide-y divide-border/60 overflow-y-auto">
          {list.map((m) => (
            <li key={m.id} className="py-2">
              <p className="px-4 text-xs font-semibold">{m.name}</p>
              {m.versions.map((v) => (
                <button key={v.id} onClick={() => onSelect(v.id)}
                  className={cn("flex w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-2", selected === v.id && "bg-surface-3")}>
                  <span className="num w-8 text-xs text-muted">v{v.version}</span>
                  <span className="flex-1"><StatusBadge v={v} /></span>
                  <span className="num text-[11px] text-subtle">AUC {v.summary.auc?.toFixed(2)} · {relativeTime(v.trained_at)}</span>
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" | "negative" }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 px-3 py-2">
      <p className="text-[11px] text-subtle">{label}</p>
      <p className={cn("num text-base font-semibold", tone === "positive" && "text-positive", tone === "negative" && "text-negative")}>{value}</p>
      {sub && <p className="num text-[11px] text-subtle">{sub}</p>}
    </div>
  );
}

function VersionView({ v }: { v: MLVersionDetail }) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const action = useVersionAction();
  const driftCheck = useDriftCheck();
  const o = v.metrics.oos, b = v.metrics.baselines;
  const importance = Object.entries(v.feature_importance).slice(0, 10);
  const maxImp = Math.max(...importance.map(([, x]) => x), 0.0001);
  const drifts = v.evaluations.filter((e) => e.kind === "drift_check");
  const lastDrift = drifts[0];
  return (
    <div className="space-y-4" aria-label="Model version">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-subtle">{v.model.algorithm} · {v.model.horizon}h horizon · {v.model.timeframe} bars</p>
              <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold">{v.model.name} <span className="num text-muted">v{v.version}</span><StatusBadge v={v} /></h2>
              <p className="mt-1 text-xs text-muted">
                Trained {formatDateTime(v.trained_at)} on {v.n_samples.toLocaleString()} samples ({formatDateTime(v.train_from)} → {formatDateTime(v.train_to)}) · data: <Badge tone={v.data_source === "synthetic" ? "warning" : "info"}>{v.data_source}</Badge>
              </p>
              <p className="num mt-1 text-[10px] text-subtle" title="SHA-256 of the stored artifact; verified before every load">artifact {v.artifact_sha256.slice(0, 16)}…</p>
            </div>
            {admin && (
              <div className="flex flex-wrap gap-2">
                {v.status === "candidate" && (
                  <Button size="sm" onClick={() => action.mutate({ id: v.id, action: "promote" })} disabled={!v.eligible || action.isPending}
                    title={v.eligible ? "Promote to champion (audited)" : "Every validation gate must pass before promotion"}><Award />Promote</Button>
                )}
                {v.status !== "retired" && <Button size="sm" variant="outline" onClick={() => action.mutate({ id: v.id, action: "retire" })} disabled={action.isPending}>Retire</Button>}
                <Button size="sm" variant="secondary" onClick={() => driftCheck.mutate(v.id)} disabled={driftCheck.isPending}>{driftCheck.isPending ? <Spinner /> : <Radar />}Drift check</Button>
              </div>
            )}
          </div>
          <ErrorBanner error={action.error ?? driftCheck.error} />
          {v.data_source === "synthetic" && (
            <p className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              Trained on the deterministic synthetic generator. It is built from smooth cycles, so models can "predict" it far better than any real market allows. These scores show the pipeline works; they are not evidence of a trading edge, and such versions can never be promoted.
            </p>
          )}
          <p className={cn("text-sm", v.eligible ? "text-positive" : "text-muted")}>{v.eligibility_note}</p>
        </CardBody>
      </Card>

      <div className="grid gap-4 2xl:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Out-of-sample performance" description={`${o.samples} non-overlapping decisions across 5 purged walk-forward folds · cost ${(o.cost_per_side * 1e4).toFixed(0)} bps per side · long when P(up) > ${o.threshold}`} />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Net return (model)" value={pct(o.strategy_net_return)} tone={o.strategy_net_return >= 0 ? "positive" : "negative"} sub={`buy & hold ${pct(b.buy_hold.net_return)}`} />
              <Kpi label="Sharpe (annualised)" value={o.strategy_sharpe.toFixed(2)} sub={`max DD ${pct(-o.strategy_max_drawdown)}`} />
              <Kpi label="AUC" value={o.auc.toFixed(3)} sub={`accuracy ${(o.accuracy * 100).toFixed(1)}%`} />
              <Kpi label="Brier score" value={o.brier.toFixed(4)} sub={`climatology ${o.brier_climatology.toFixed(4)}`} />
              <Kpi label="Calibration (ECE)" value={o.ece.toFixed(3)} />
              <Kpi label="Trades" value={String(o.strategy_trades)} sub={`exposure ${(o.strategy_exposure * 100).toFixed(0)}%`} />
              <Kpi label="Hit rate" value={`${(o.strategy_hit_rate * 100).toFixed(0)}%`} />
              <Kpi label="Momentum baseline" value={pct(b.momentum.net_return)} />
            </div>
            <div>
              <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted">
                {EQUITY_SERIES.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: `var(${s.color})` }} />{s.label}</span>)}
              </div>
              <EquityChart times={v.metrics.curves.times} series={{ model: v.metrics.curves.model, buy_hold: v.metrics.curves.buy_hold, momentum: v.metrics.curves.momentum }} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Validation gates" description="All must pass before promotion" />
          <ul className="divide-y divide-border/60" data-testid="gates">
            {v.gates.map((g) => (
              <li key={g.name} className="flex items-start gap-2 px-5 py-2.5 text-sm">
                {g.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-negative" />}
                <span className="min-w-0"><span className="block">{g.name}</span><span className="num text-[11px] text-subtle">{g.value} · needs {g.threshold}</span></span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Calibration" description="Point size = samples per bin; the dashed line is perfect calibration" />
          <CardBody className="flex justify-center"><CalibrationPlot bins={v.metrics.calibration} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Feature importance" description={v.model.algorithm === "logistic" ? "Normalised |coefficient| on standardised features" : "Normalised split gain / impurity"} />
          <CardBody className="space-y-1.5">
            {importance.map(([name, val]) => (
              <div key={name} className="grid grid-cols-[110px_1fr_44px] items-center gap-2 text-xs">
                <span className="num truncate text-muted">{name}</span>
                <div className="h-2 rounded-full bg-surface-3"><div className="h-2 rounded-full bg-accent" style={{ width: `${(val / maxImp) * 100}%` }} /></div>
                <span className="num text-right text-subtle">{(val * 100).toFixed(1)}%</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Walk-forward folds" description="Expanding window; each training set ends one horizon before its test block (purge)" />
        <Table>
          <thead><tr><Th>Fold</Th><Th>Test window</Th><Th className="text-right">Train</Th><Th className="text-right">Test</Th><Th className="text-right">Brier</Th><Th className="text-right">Model</Th><Th className="text-right">Buy & hold</Th><Th /></tr></thead>
          <tbody>
            {v.metrics.folds.map((f) => (
              <Tr key={f.fold}>
                <Td className="num">{f.fold}</Td>
                <Td className="num whitespace-nowrap text-xs text-muted">{formatDateTime(f.test_from)} → {formatDateTime(f.test_to)}</Td>
                <Td className="num text-right text-xs">{f.train_size}</Td><Td className="num text-right text-xs">{f.test_size}</Td>
                <Td className="num text-right text-xs">{f.brier.toFixed(4)}</Td>
                <Td className={cn("num text-right text-xs", f.net_return >= 0 ? "text-positive" : "text-negative")}>{pct(f.net_return)}</Td>
                <Td className="num text-right text-xs">{pct(f.buy_hold_return)}</Td>
                <Td>{f.beats_buy_hold ? <CheckCircle2 className="size-4 text-positive" /> : <XCircle className="size-4 text-subtle" />}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Radar className="size-4" />Concept-drift monitoring</span>}
          description="Population Stability Index per feature (recent 30 days vs training) and calibration decay" />
        {!lastDrift ? <EmptyState title="No drift check yet">{admin ? "Run a drift check to compare recent data with the training distribution." : "An administrator can run a drift check."}</EmptyState> : (
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={lastDrift.status === "ok" ? "positive" : lastDrift.status === "warning" ? "warning" : "negative"}>{lastDrift.status}</Badge>
              <span className="text-muted">{formatDateTime(lastDrift.created_at)} · max PSI {Number(lastDrift.metrics.max_psi).toFixed(3)} · recent Brier {lastDrift.metrics.recent_brier ?? "—"} (OOS {lastDrift.metrics.oos_brier})</span>
            </div>
            {(lastDrift.metrics.reasons as string[]).length > 0 && <ul className="list-disc pl-5 text-xs text-muted">{(lastDrift.metrics.reasons as string[]).map((r) => <li key={r}>{r}</li>)}</ul>}
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(lastDrift.metrics.psi as Record<string, number>).sort((a, c) => c[1] - a[1]).map(([f, psi]) => (
                <div key={f} className="grid grid-cols-[110px_1fr_48px] items-center gap-2 text-xs">
                  <span className="num truncate text-muted">{f}</span>
                  <div className="relative h-2 rounded-full bg-surface-3">
                    <div className={cn("h-2 rounded-full", psi > 0.25 ? "bg-negative" : psi > 0.1 ? "bg-warning" : "bg-positive")} style={{ width: `${Math.min(100, (psi / 0.5) * 100)}%` }} />
                  </div>
                  <span className="num text-right text-subtle">{psi.toFixed(3)}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-subtle">PSI &lt; 0.10 stable · 0.10–0.25 moderate · &gt; 0.25 significant. Drift on a champion removes its trading eligibility; it is never retrained or replaced automatically.</p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}

export function ModelLabPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("version");
  const version = useVersion(selected);
  const select = (id: string) => setParams({ version: id });
  return (
    <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
      <div className="space-y-4">
        <TrainPanel onTrained={select} />
        <Registry selected={selected} onSelect={select} />
        {isDemo && <p className="px-1 text-[11px] text-subtle">Demo build: logistic regression runs in your browser; random forest and LightGBM need the AUREX backend.</p>}
      </div>
      <div className="min-w-0">
        {version.data ? <VersionView v={version.data} /> : version.isLoading ? <Spinner className="mx-auto mt-16" /> : (
          <Card><EmptyState icon={<FlaskConical />} title="Select or train a model version">
            Every version is validated walk-forward against buy & hold, momentum and base-rate baselines after costs. Promotion needs every gate and an administrator.
          </EmptyState></Card>
        )}
      </div>
    </div>
  );
}
