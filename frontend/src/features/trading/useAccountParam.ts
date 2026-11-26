import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAccounts } from "@/features/accounts/hooks";
import { getActiveAccountId, setActiveAccountId, useActiveAccountId } from "@/features/accounts/activeAccount";

/**
 * The selected paper account, kept in ?account= so links and reloads keep it.
 * An unknown id (for example a deep link copied from an older session) is never used:
 * it falls back to the last valid selection or, failing that, the first current account.
 */
export function useAccountParam() {
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const storedId = useActiveAccountId();
  const list = accounts.data ?? [];
  const requested = params.get("account");
  const requestedAccount = list.find((a) => a.id === requested);
  const storedAccount = list.find((a) => a.id === storedId);
  const account = requestedAccount ?? storedAccount ?? list[0];
  const id = account?.id ?? null;

  useEffect(() => {
    if (!id) {
      if (requested) {
        const next = new URLSearchParams(params); next.delete("account");
        setParams(next, { replace: true });
      }
      if (getActiveAccountId()) setActiveAccountId(null);
      return;
    }
    if (requested !== id) {
      const next = new URLSearchParams(params); next.set("account", id);
      setParams(next, { replace: true });
    }
    if (getActiveAccountId() !== id) setActiveAccountId(id);
  }, [id, requested, params, setParams]);

  const select = (nextId: string) => {
    if (!list.some((a) => a.id === nextId)) return;
    setActiveAccountId(nextId);
    const next = new URLSearchParams(params); next.set("account", nextId);
    setParams(next);
  };
  return { accounts, list, account, select, params, setParams };
}
