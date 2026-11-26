import { useEffect, useState } from "react";

/**
 * The paper account selected in this tab. Stored separately from the demo corpus so a
 * stale ?account= deep link or an old localStorage account cannot silently take over.
 * The id is always validated against the current account list before use.
 */
const KEY = "aurex-active-account-v2";
let current: string | null = null;
try {
  current = localStorage.getItem(KEY);
  if (!current) localStorage.removeItem("aurex-active-account");
} catch { /* storage may be unavailable */ }
if (!current) {
  try { localStorage.removeItem("aurex-active-account"); } catch { /* ignore */ }
}
const listeners = new Set<(id: string | null) => void>();

export function getActiveAccountId() {
  return current;
}

export function setActiveAccountId(id: string | null) {
  current = id;
  try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(id));
}

export function useActiveAccountId() {
  const [id, setId] = useState(current);
  useEffect(() => {
    listeners.add(setId);
    return () => { listeners.delete(setId); };
  }, []);
  return id;
}
