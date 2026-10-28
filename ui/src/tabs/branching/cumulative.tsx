import { Badge } from '@databricks/appkit-ui/react';
import { ShieldCheck, Timer } from 'lucide-react';
import { type Experiment } from './adapter';

export function CumulativeDemo({ experiment, unchanged, elapsed, duration, running }: {
  experiment: Experiment; unchanged: boolean | null; elapsed: number; duration: number | null; running: boolean;
}) {
  const { schema, changes } = experiment;
  const latest = changes.at(-1);
  const droppedServiceLine = changes.some(change => change.id === 'drop');
  const demoColumns = [...schema.demo];
  if (droppedServiceLine && !demoColumns.includes('service_line')) {
    const originalIndex = schema.production.indexOf('service_line');
    demoColumns.splice(originalIndex < 0 ? demoColumns.length : originalIndex, 0, 'service_line');
  }
  return <div className="branching-cumulative">
    <div className="branching-summary-row">
    <div className="branching-review-score"><span className="branching-big-number" data-testid="change-count">{changes.length}</span><div><strong>cumulative test changes</strong><p>{latest ? `Latest: ${latest.title}` : duration !== null ? 'Reset complete · all test changes discarded' : 'Clean dev environment · ready to experiment'}</p></div></div>
    <div className="branching-stopwatch"><span className="branching-eyebrow"><Timer size={16} aria-hidden />{running ? 'Recreating dev environment' : 'Last successful recreate'}</span><strong>{running ? (elapsed / 1000).toFixed(1) : duration === null ? '—' : String(duration)}<small> s</small></strong></div>
    </div>
    <div className="branching-environments">{(['production', 'demo'] as const).map(branch => <article className="branching-schema" key={branch}><h4 className="branching-schema-heading">{branch === 'production' && <ShieldCheck size={18} className="branching-production-shield" role="img" aria-label={unchanged ? 'Production schema unchanged' : 'Production schema snapshot'} />}<span>{branch} · {branch === 'production' ? 'protected' : 'isolated dev'}</span>{branch === 'production' && <Badge variant="outline" className="branching-production-badge">{schema.production.length} columns</Badge>}</h4><ul className="branching-columns">{(branch === 'demo' ? demoColumns : schema.production).map(column => <li className={`branching-column ${branch === 'demo' && droppedServiceLine && column === 'service_line' ? 'branching-removed' : branch === 'demo' && schema.only_on_demo.includes(column) ? 'branching-column-new' : ''}`} key={column}><code>{column}</code>{branch === 'demo' && droppedServiceLine && column === 'service_line' && <Badge variant="outline" className="branching-dropped-badge">dropped</Badge>}{branch === 'demo' && schema.only_on_demo.includes(column) && <Badge variant="outline" className="branching-new-badge">new</Badge>}</li>)}</ul><div className="branching-sample"><strong>Sample opportunity amounts</strong>{(branch === 'production' ? experiment.productionSamples : experiment.demoSamples).length === 0 ? <p className="branching-caption">No sample opportunities found</p> : (branch === 'production' ? experiment.productionSamples : experiment.demoSamples).map(sample => {
      const production = experiment.productionSamples.find(row => row.opportunity_id === sample.opportunity_id);
      const changed = branch === 'demo' && production !== undefined && production.amount !== sample.amount;
      return <div key={sample.opportunity_id} className={changed ? 'branching-sample-updated' : ''}><span>Opportunity {sample.opportunity_id}</span><code>{changed ? `${production.amount} → ${sample.amount}` : sample.amount}</code></div>;
    })}</div></article>)}</div>

  </div>;
}
