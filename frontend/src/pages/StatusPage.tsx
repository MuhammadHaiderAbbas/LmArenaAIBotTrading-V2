import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner, Spinner } from "@/components/ui/feedback";
import { api } from "@/services/api";

type PublicStatus = {
  name: string; version: string; environment: string; phase: string; status: string;
  trading_mode: "PAPER"; live_trading_enabled: false;
  checks: Record<string, string | null>; announcements: string[];
  feedback_enabled: boolean; legal_review_required_for: string[];
};

export function StatusPage() {
  const status = useQuery({ queryKey: ["public-status"], queryFn: () => api<PublicStatus>("/system/status"), refetchInterval: 30_000 });
  if (status.isLoading) return <Spinner className="mx-auto mt-16" />;
  if (status.isError || !status.data) return <div className="mx-auto mt-8 max-w-xl"><ErrorBanner error={status.error} /></div>;
  const s = status.data;
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-5">
      <Card>
        <CardHeader title="Public status" description="No sign-in required · refreshes every 30 seconds" />
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === "operational" ? "positive" : "warning"} data-testid="public-status-state">
              {s.status === "operational" ? "Operational" : "Degraded"}
            </Badge>
            <Badge tone="accent">Soft launch · {s.phase}</Badge>
            <Badge tone="neutral">Paper trading only</Badge>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {Object.entries(s.checks).map(([key, value]) => (
              <div key={key} className="rounded-md border border-border p-3">
                <dt className="text-xs uppercase tracking-wide text-subtle">{key}</dt>
                <dd className="num mt-1 font-medium">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-subtle">Version {s.version} · {s.environment} · live trading is disabled in code.</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="What to expect during the soft launch" />
        <CardBody>
          <ul className="space-y-2 text-sm text-muted" data-testid="public-announcements">
            {s.announcements.map((a) => <li key={a}>• {a}</li>)}
          </ul>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <Link className="underline underline-offset-2" to="/feedback">Send feedback</Link>
            <Link className="underline underline-offset-2" to="/login">Sign in</Link>
          </div>
          <p className="mt-4 text-[11px] text-subtle">
            Legal re-review is required before marketing, data-provider or privacy-disclosure changes:
            {s.legal_review_required_for.join(", ")}.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
