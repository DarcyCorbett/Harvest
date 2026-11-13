import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { toggleStarred } from "@/services/firestoreService";
import { report } from "@/components/connected/ui";

export function useFavourite() {
  const { householdId } = useAuth();
  const c = useConnected();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const toggle = useCallback(async (id: string) => {
    if (!id || !householdId || !c.online || inFlight.current.has(id)) return;
    const next = !c.cookbook.find((e) => e.recipeId === id)?.starred;
    inFlight.current.add(id);
    setPending((p) => ({ ...p, [id]: next }));
    try {
      await toggleStarred(householdId, id, next);
    } catch (e) {
      report(e);
    } finally {
      inFlight.current.delete(id);
      setPending((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    }
  }, [householdId, c.online, c.cookbook]);
  return {
    toggle,
    starred: (id: string) =>
      pending[id] ?? !!c.cookbook.find((e) => e.recipeId === id)?.starred,
    pending: (id: string) => Object.prototype.hasOwnProperty.call(pending, id),
    disabled: !householdId || !c.online,
  };
}
