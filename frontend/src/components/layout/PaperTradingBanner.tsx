import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Unmistakable soft-launch disclosure, shown on every surface and auth state. */
export function PaperTradingBanner({ className, links = true }: { className?: string; links?: boolean }) {
  return (
    <div data-testid="paper-trading-banner"
      className={cn("print:hidden border-b border-warning/50 bg-warning/10 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-warning sm:text-xs", className)}>
      <span>Paper trading only · virtual capital · no real money or live orders</span>
      {links && (
        <span className="ml-2 font-normal normal-case tracking-normal">
          <Link className="underline underline-offset-2" to="/status">Status</Link>
          {" · "}
          <Link className="underline underline-offset-2" to="/feedback">Feedback</Link>
        </span>
      )}
    </div>
  );
}
