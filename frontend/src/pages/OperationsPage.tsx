import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Anchor, CheckCircle2, CircleSlash, DatabaseBackup, HeartPulse, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { cn, formatDateTime } from "@/lib/utils";
import { api, type IntegrityResult, type OpsStatus } from "@/services/api";

const age = (h: number | null | undefined) =>
  h == null ? "never" : h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${h.toFixed(1)} h ago` : `${(h / 24).toFixed(1)} days ago`;
const secs = (s: number | null) => (s == null ? "no heartbeat yet" : s < 120 ? `${Math.round(s)} s ago` : age(s / 3600));
const good = (v: string) => v === "ok" || v === "not configured" || v.startsWith("disabled") || v === "browser storage" || v === "simulated";

function Row({ label, value, ok }: { label: string; value: React.ReactNode; ok?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className={cn("num text-right", ok === true && "text-positive", ok === false && "text-negative")}>{value}</span>
    </div>
  );
}

export function OperationsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["ops"], queryFn: () => api<OpsStatus>("/admin/ops/status"), refetchInterval: 15_000 });
  const anchor = useMutation({ mutationFn: () => api("/admin/ops/anchor", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["ops"] }) });
  const integrity = useMutation({ mutationFn: () => api<IntegrityResult>("/admin/ops/integrity-check", { method: "POST" }) });
  const [gate, setGate] = useState("pentest");
  const [reference, setReference] = useState("");
  const [evidenceSha, setEvidenceSha] = useState("");
  const [reviewedAt, setReviewedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const attest = useMutation({
    mutationFn: () => api("/admin/ops/attestations", { method: "POST",
      json: { gate, reference, evidence_sha256: evidenceSha, reviewed_at: reviewedAt } }),
    onSuccess: () => { setReference(""); setEvidenceSha(""); qc.invalidateQueries({ queryKey: ["ops"] }); },
  });
  if (status.isLoading) return <Spinner className="mx-auto mt-16" />;
  const s = status.data;
  if (!s) return <ErrorBanner error={status.error} />;
  return (
    <div className="space-y-6">
      <ErrorBanner error={anchor.error ?? integrity.error ?? attest.error} />
      <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm",
        s.ready ? "border-positive/40 bg-positive/10 text-positive" : "border-warning/40 bg-warning/10 text-warning")} data-testid="ops-ready">
        <HeartPulse className="size-4" />
        <span className="font-medium">{s.ready ? "Ready" : "Not ready"}</span>
        <span className="text-muted">version {s.version} · {s.environment} · {s.users.total} users, {s.users.admins} admin{s.users.admins === 1 ? "" : "s"}</span>
        <Badge tone="neutral" className="ml-auto"><CircleSlash className="size-3" />Live trading disabled (Stage 1)</Badge>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><HeartPulse className="size-4" />Health</span>} description="What load balancers see at /system/ready" />
          <CardBody className="divide-y divide-border/60 pt-0">
            {Object.entries(s.checks).map(([k, v]) => <Row key={k} label={k} value={v} ok={good(v)} />)}
            <Row label="worker leader" value={s.worker.leader_instance ?? "none yet"} />
            <Row label="last worker pass" value={secs(s.worker.heartbeat_age_seconds)} ok={s.worker.heartbeat_age_seconds != null && s.worker.heartbeat_age_seconds < 120} />
            {s.worker.last_error && <Row label="last error" value={s.worker.last_error} ok={false} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><DatabaseBackup className="size-4" />Backups</span>} description="Daily backups; weekly restore drills into a scratch database" />
          <CardBody className="divide-y divide-border/60 pt-0" data-testid="ops-backups">
            <Row label="last backup" value={age(s.backup.age_hours)} ok={s.backup.age_hours != null && s.backup.age_hours < 26} />
            {s.backup.file && <Row label="file" value={<span className="text-xs">{s.backup.file}</span>} />}
            {s.backup.sha256 && <Row label="sha256" value={<span className="text-xs">{s.backup.sha256.slice(0, 16)}…</span>} />}
            <Row label="last restore drill" value={s.restore_drill.at ? `${age(s.restore_drill.age_hours)} · ${s.restore_drill.ok ? "passed" : "FAILED"}` : "never"}
              ok={s.restore_drill.at ? !!s.restore_drill.ok : undefined} />
            {s.restore_drill.detail && <Row label="drill detail" value={<span className="text-xs">{s.restore_drill.detail}</span>} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Anchor className="size-4" />Audit anchoring</span>} description="Head of the audit chain written outside the database"
            action={<Button size="sm" variant="secondary" disabled={anchor.isPending || !s.anchoring.sinks.length} onClick={() => anchor.mutate()}>Anchor now</Button>} />
          <CardBody className="divide-y divide-border/60 pt-0" data-testid="ops-anchoring">
            <Row label="sinks" value={s.anchoring.sinks.join(", ") || "none configured"} ok={s.anchoring.sinks.length > 0} />
            <Row label="last anchor" value={s.anchoring.last ? age(s.anchoring.last.age_hours) : "never"} />
            {s.anchoring.last && <>
              <Row label="covers record" value={`#${s.anchoring.last.last_record_id} of ${s.anchoring.last.records}`} />
              <Row label="head hash" value={<span className="text-xs">{s.anchoring.last.head_hash.slice(0, 16)}…</span>} />
              <Row label="delivery" value={s.anchoring.last.sinks.map((x) => `${x.sink} ${x.ok ? "ok" : "failed"}`).join(", ")} ok={s.anchoring.last.sinks.every((x) => x.ok)} />
            </>}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" />Go-live gates</span>}
            description={`${s.gates_met} of ${s.gates_total} operational gates met. Even with every gate met, live trading stays off until a reviewed code change enables it.`} />
          <ul className="divide-y divide-border/60" data-testid="ops-gates">
            {s.gates.map((g) => (
              <li key={g.key} className="flex items-start gap-3 px-5 py-2.5">
                {g.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-subtle" />}
                <div className="min-w-0"><div className="text-sm">{g.label}</div><div className="text-[11px] text-subtle">{g.detail}</div></div>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Integrity check" description="Schema, audit chain, ledger balance, append-only triggers, anchors" />
            <CardBody className="space-y-3">
              <Button size="sm" variant="secondary" onClick={() => integrity.mutate()} disabled={integrity.isPending}>{integrity.isPending && <Spinner />}Run integrity check</Button>
              {integrity.data && (
                <ul className="space-y-1 text-xs" data-testid="integrity-result">
                  {integrity.data.checks.map((c) => (
                    <li key={c.name} className="flex items-start gap-2">{c.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-positive" /> : <XCircle className="size-3.5 shrink-0 text-negative" />}
                      <span><span className="font-medium">{c.name}</span> <span className="text-subtle">{c.detail}</span></span></li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Record an attestation" description="For gates that need a human sign-off. Audited." />
            <CardBody>
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); attest.mutate(); }}>
                <Select aria-label="Gate" value={gate} onChange={(e) => setGate(e.target.value)}>
                  <option value="pentest">External penetration test</option>
                  <option value="solicitor">UK solicitor review</option>
                  <option value="dpia">GDPR DPIA approval</option>
                  <option value="privacy_policy">Privacy policy approval</option>
                  <option value="broker_sandbox">Broker sandbox certification</option>
                </Select>
                <Input aria-label="Reference" placeholder="Report ID or link" required minLength={3} maxLength={300} value={reference} onChange={(e) => setReference(e.target.value)} />
                <Input aria-label="Evidence SHA-256" placeholder="64-character sha256 of the signed report" value={evidenceSha}
                  onChange={(e) => setEvidenceSha(e.target.value.trim())} pattern="[0-9a-f]{64}" required />
                <Input aria-label="Review date" type="date" value={reviewedAt} onChange={(e) => setReviewedAt(e.target.value)} required />
                <Button type="submit" size="sm" disabled={attest.isPending || reference.length < 3 || !/^[0-9a-f]{64}$/.test(evidenceSha)}>Record attestation</Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
      <p className="text-[11px] text-subtle">Refreshed {formatDateTime(new Date().toISOString())} · this process {s.worker.this_process}{s.worker.this_process_is_leader ? " (worker leader)" : ""}</p>
    </div>
  );
}
