import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Exercise the real session store with a controlled API and clock.
const output = await build({
  entryPoints: [new URL("../src/tabs/h2h/store.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "session-dependencies", setup(builder) {
    builder.onResolve({ filter: /^(react|\.\.\/\.\.\/api)$/ }, args => ({ path: args.path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "react"
      ? "export const useCallback = x => x; export const useSyncExternalStore = () => {};"
      : "export const api = { h2hWarmup: () => globalThis.probe() }; export const errorMessage = e => e.message;" }));
  } }],
});
const { h2hSession, comparisonRequest } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

test("warm-up recovers, backs off, and cannot leak across resets", async () => {
  const timers = new Map();
  let nextTimer = 0, calls = 0;
  globalThis.window = {
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const retry = () => {
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); return timer.ms;
  };
  const warm = { lakebase_ms: 2, dbsql_ms: 10 };
  globalThis.probe = () => { calls++; return Promise.reject(new Error("Demo controls are still provisioning")); };
  h2hSession.warmup("Timed out");
  h2hSession.warmup("Timed out");
  await flush();
  assert.equal(calls, 1, "remounts do not duplicate the probe");
  assert.match(h2hSession.get().warmError, /still provisioning/);
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    assert.equal(retry(), delay); await flush();
  }
  comparisonRequest.id++;
  globalThis.probe = () => Promise.resolve(warm);
  retry(); await flush();
  assert.deepEqual(h2hSession.get().warm, warm);
  assert.equal(h2hSession.get().warmError, undefined);
  assert.equal(timers.size, 0, "success stops retries");

  h2hSession.reset();
  globalThis.probe = () => Promise.reject(new Error("not ready"));
  h2hSession.warmup("Timed out"); await flush();
  h2hSession.reset();
  assert.equal(timers.size, 0, "reset cancels scheduled retries");

  let resolveOld;
  globalThis.probe = () => new Promise(resolve => { resolveOld = resolve; });
  h2hSession.warmup("Timed out");
  h2hSession.reset();
  resolveOld(warm); await flush();
  assert.equal(h2hSession.get().warm, undefined, "old responses cannot update a new session");
  assert.equal(h2hSession.get().warmError, undefined);
  assert.equal(timers.size, 0);
  delete globalThis.window;
  delete globalThis.probe;
});
