import { api, ApiError, type BranchExperiment, type BranchSample, type BranchStep } from '../../api';

export class RecoverableResetError extends Error {}
export class BranchBusyError extends Error {
  constructor() { super('Another change is in progress — try again in a moment'); }
}
export interface TestChange { id: 'add' | 'update' | 'drop'; title: string }
export interface Experiment {
  schema: BranchExperiment['state'];
  changes: TestChange[];
  productionSamples: BranchSample[];
  demoSamples: BranchSample[];
  notice?: string;
  result?: string;
}
const STEPS: { step: BranchStep; change: TestChange }[] = [
  { step: 'add_win_probability', change: { id: 'add', title: 'Add win_probability' } },
  { step: 'halve_sample_amounts', change: { id: 'update', title: 'Halve sample opportunity amounts' } },
  { step: 'drop_service_line', change: { id: 'drop', title: 'Drop service_line' } },
];
export async function loadExperiment(): Promise<Experiment> {
  const data = await api.branchingExperiment();
  return {
    schema: data.state,
    changes: STEPS.filter(({ step }) => data.applied_steps.includes(step)).map(({ change }) => change),
    productionSamples: data.production_samples,
    demoSamples: data.demo_samples,
  };
}
export function canApply(experiment: Experiment | null): boolean {
  return !experiment || experiment.changes.length < STEPS.length;
}
export async function applyNext(experiment: Experiment | null): Promise<Experiment> {
  const current = experiment ?? await loadExperiment();
  const next = STEPS.find(({ change }) => !current.changes.some(applied => applied.id === change.id));
  if (!next) return { ...current, notice: 'All changes are already applied.' };
  let result = next.change.title;
  try {
    if (next.step === 'add_win_probability') await api.branchingAddColumn();
    else {
      const response = await api.branchingTestChange(next.step);
      result = response.applied_step === 'halve_sample_amounts'
        ? `${response.affected_rows} rows halved in ${response.seconds} s`
        : `service_line dropped in ${response.seconds} s`;
    }
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    if (!/already applied|steps? in order/i.test(error.message)) throw new BranchBusyError();
    // Another client may have advanced the sequence. Refresh rather than repeat a write.
    return { ...await loadExperiment(), notice: 'Experiment changed elsewhere. Latest state loaded; no change repeated.' };
  }
  return { ...await loadExperiment(), result };
}
export async function recreate(): Promise<Experiment> {
  let reset: BranchExperiment['state'];
  try {
    reset = await api.branchingReset();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new BranchBusyError();
    throw error;
  }
  if (reset.recoverable) {
    throw new RecoverableResetError(reset.message || 'Recreation failed. Your changes were preserved.');
  }
  const current = await loadExperiment();
  return { ...current, schema: { ...current.schema, seconds: reset.seconds } };
}

export function productionUnchanged(experiment: Experiment | null, baseline: string[] | null): boolean | null {
  if (!experiment || baseline === null) return null;
  return baseline.length === experiment.schema.production.length
    && baseline.every(column => experiment.schema.production.includes(column));
}
