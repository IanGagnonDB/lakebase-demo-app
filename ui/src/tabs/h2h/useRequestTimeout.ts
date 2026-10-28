import { useEffect, useRef } from "react";

/** The shared API has no abort signal: cancel local waits and ignore late responses. */
export function useRequestTimeout() {
  const cancellations = useRef(new Set<() => void>());
  useEffect(() => () => {
    for (const cancel of cancellations.current) cancel();
    cancellations.current.clear();
  }, []);
  return function timeout<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const finish = () => { window.clearTimeout(timer); cancellations.current.delete(cancel); };
      const cancel = () => { finish(); reject(new DOMException("Tab unmounted", "AbortError")); };
      const timer = window.setTimeout(() => {
        finish();
        reject(new Error(`Request timed out after ${milliseconds / 1000} s. Run again to retry.`));
      }, milliseconds);
      cancellations.current.add(cancel);
      promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
    });
  };
}
