import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@databricks/appkit-ui/react";

type Handler = { clear: () => void; busy: boolean; available: boolean; active: boolean };
const Context = createContext<{ handlers: Map<symbol, Handler>; register: (id: symbol, handler: Handler | null) => void } | null>(null);
export function ClearResultsProvider({ children }: { children: ReactNode }) {
  const [handlers, setHandlers] = useState(new Map<symbol, Handler>());
  const register = useRef((id: symbol, handler: Handler | null) => setHandlers(previous => {
    const next = new Map(previous); if (handler) next.set(id, handler); else next.delete(id); return next;
  })).current;
  return <Context.Provider value={{ handlers, register }}>{children}</Context.Provider>;
}
export function useClearResults(clear: () => void, busy: boolean, available = true, active = busy) {
  const context = useContext(Context);
  const register = context?.register;
  const id = useRef(Symbol());
  const action = useRef(clear); action.current = clear;
  useEffect(() => {
    register?.(id.current, { clear: () => action.current(), busy, available, active });
    return () => register?.(id.current, null);
  }, [register, busy, available, active]);
}
export function useClearResultsBusy() {
  const context = useContext(Context);
  return [...(context?.handlers.values() ?? [])].some(handler => handler.active);
}
export function ClearResultsButton() {
  const context = useContext(Context);
  const handlers = [...(context?.handlers.values() ?? [])];
  if (!handlers.length) return null;
  return <Button variant="secondary" className="clear-results-button" title="Clear displayed results; preserve database state and pending changes" disabled={handlers.some(h => h.busy) || !handlers.some(h => h.available)}
    onClick={() => handlers.forEach(h => h.clear())}>Clear results</Button>;
}
