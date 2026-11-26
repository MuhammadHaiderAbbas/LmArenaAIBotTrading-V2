import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { PaperTradingBanner } from "@/components/layout/PaperTradingBanner";
import { NAV } from "@/components/layout/nav";
import { Spinner } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/AuthProvider";

// Route-level code splitting: the initial shell no longer carries every page and chart.
const AdminPage = lazy(() => import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const AITradingPage = lazy(() => import("@/pages/AITradingPage").then((m) => ({ default: m.AITradingPage })));
const BacktestPage = lazy(() => import("@/pages/BacktestPage").then((m) => ({ default: m.BacktestPage })));
const BinaryPage = lazy(() => import("@/pages/BinaryPage").then((m) => ({ default: m.BinaryPage })));
const LoginPage = lazy(() => import("@/pages/AuthPages").then((m) => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import("@/pages/AuthPages").then((m) => ({ default: m.RegisterPage })));
const MarketsPage = lazy(() => import("@/pages/MarketsPage").then((m) => ({ default: m.MarketsPage })));
const ModelLabPage = lazy(() => import("@/pages/ModelLabPage").then((m) => ({ default: m.ModelLabPage })));
const ModulePage = lazy(() => import("@/pages/ModulePage").then((m) => ({ default: m.ModulePage })));
const OverviewPage = lazy(() => import("@/pages/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const ResearchPage = lazy(() => import("@/pages/ResearchPage").then((m) => ({ default: m.ResearchPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const WalletPage = lazy(() => import("@/pages/WalletPage").then((m) => ({ default: m.WalletPage })));
const PortfolioPage = lazy(() => import("@/pages/PortfolioPage").then((m) => ({ default: m.PortfolioPage })));
const HistoryPage = lazy(() => import("@/pages/HistoryPage").then((m) => ({ default: m.HistoryPage })));
const RiskPage = lazy(() => import("@/pages/RiskPage").then((m) => ({ default: m.RiskPage })));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const OperationsPage = lazy(() => import("@/pages/OperationsPage").then((m) => ({ default: m.OperationsPage })));
const StatusPage = lazy(() => import("@/pages/StatusPage").then((m) => ({ default: m.StatusPage })));
const FeedbackPage = lazy(() => import("@/pages/FeedbackPage").then((m) => ({ default: m.FeedbackPage })));

function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { status, user } = useAuth();
  if (status === "loading") return <div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>;
  if (status === "anonymous") return <Navigate to="/login" replace />;
  if (admin && user?.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-6" /></div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/status" element={<><PaperTradingBanner /><StatusPage /></>} />
        <Route path="/feedback" element={<><PaperTradingBanner /><FeedbackPage /></>} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<OverviewPage />} />
          <Route path="markets" element={<MarketsPage />} />
          <Route path="research" element={<ResearchPage />} />
          <Route path="ai-trading" element={<AITradingPage />} />
          <Route path="strategies" element={<ModelLabPage />} />
          <Route path="backtests" element={<BacktestPage />} />
          <Route path="binary" element={<BinaryPage />} />
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="risk" element={<RiskPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="wallet" element={<WalletPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
          <Route path="operations" element={<RequireAuth admin><OperationsPage /></RequireAuth>} />
          {NAV.filter((n) => n.phase).map((n) => (
            <Route key={n.to} path={n.to.slice(1)} element={<ModulePage item={n} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
