import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage, type Meta } from "../api";

interface MetaState { meta: Meta | null; error: string | null }
const MetaContext = createContext<MetaState>({ meta: null, error: null });

export function MetaProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MetaState>({ meta: null, error: null });
  useEffect(() => {
    api.meta().then((meta) => setState({ meta, error: null }), (e) => setState({ meta: null, error: errorMessage(e) }));
  }, []);
  return <MetaContext.Provider value={state}>{children}</MetaContext.Provider>;
}

export const useMeta = () => useContext(MetaContext);
