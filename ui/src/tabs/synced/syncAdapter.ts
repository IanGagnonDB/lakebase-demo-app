import { api, type SyncDeltaOp, type SyncPending } from "../../api";

export interface PendingBatch {
  data: SyncPending;
  completedAt: string | null;
  running: boolean;
}
async function withStatus(data: SyncPending, signal?: AbortSignal): Promise<PendingBatch> {
  if (signal?.aborted) return { data, completedAt: null, running: false };
  return { data, completedAt: data.completed_at ?? null, running: data.running ?? false };
}
// The shared client selects live or mock transport. No tab-local fixtures.
export const syncBatch = {
  async change(op: SyncDeltaOp): Promise<PendingBatch> {
    const data = await api.syncDeltaChange(op);
    // Preserve the confirmed write even if the optional pipeline status is unavailable.
    return { data, completedAt: null, running: false };
  },
  async daily(): Promise<PendingBatch> {
    return { data: await api.syncDailyBatch(), completedAt: null, running: false };
  },
  async pending(signal?: AbortSignal, progress = false): Promise<PendingBatch> { return withStatus(await api.syncPending(progress), signal); },
  async trigger(): Promise<void> { await api.syncTrigger(); },
};
