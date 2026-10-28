import { useEffect, useRef } from "react";

export interface PollResult<T> { value: T | undefined; elapsedMs: number; timedOut: boolean; aborted: boolean }

/** Call `fn` every `intervalMs` until `done(value)`, `timeoutMs`, or `signal` aborts. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number; signal?: AbortSignal; onTick?: (value: T, elapsedMs: number) => void },
): Promise<PollResult<T>> {
  const t0 = performance.now();
  let value: T | undefined;
  while (!opts.signal?.aborted) {
    value = await fn();
    const elapsedMs = performance.now() - t0;
    if (opts.signal?.aborted) break;
    opts.onTick?.(value, elapsedMs);
    if (done(value)) return { value, elapsedMs, timedOut: false, aborted: false };
    if (elapsedMs >= opts.timeoutMs) return { value, elapsedMs, timedOut: true, aborted: false };
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return { value, elapsedMs: performance.now() - t0, timedOut: false, aborted: true };
}

/** A getter for an AbortSignal that aborts when the component unmounts (StrictMode-safe). */
export function useUnmountSignal(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => {
    ref.current = new AbortController();
    return () => ref.current?.abort();
  }, []);
  return () => ref.current?.signal ?? AbortSignal.abort();
}
