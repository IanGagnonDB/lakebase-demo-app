import { useId } from 'react';
import { GitBranch } from 'lucide-react';
import { Skeleton } from '@databricks/appkit-ui/react';
import type { BranchingState } from '../../api';

export function BranchGraph({ state, changes, loading, unchanged }: { state: BranchingState | null; changes: number; loading: boolean; unchanged: boolean | null }) {
  const arrowId = useId();
  return <section className="branching-header-graph" aria-label="Branch graph">
    {loading ? <Skeleton className="h-28 w-full" /> : !state ? <p className="branching-caption">Branch state unavailable</p> : state.branches.length === 0 ? <p className="branching-caption">No branches found</p> : <div className="branching-tree">

      {state.branches.includes('production') && <div className="branching-node branching-root"><div className="branching-node-title"><GitBranch size={16} aria-hidden />production</div><p className="branching-node-note">{unchanged === false ? 'Warning · production differs' : unchanged === true ? 'Protected · unchanged' : 'Production snapshot'}</p></div>}
      {state.branches.includes('production') && <svg className="branching-arrow" viewBox="0 0 24 16" aria-hidden><defs><marker id={arrowId} markerWidth="5" markerHeight="5" refX="5" refY="2.5" orient="auto"><path d="M 0 0 L 5 2.5 L 0 5" /></marker></defs><line x1="0" y1="8" x2="24" y2="8" markerEnd={`url(#${arrowId})`} /></svg>}
      <div className="branching-children"><div className="branching-child-list">{state.branches.filter(branch => branch !== 'production').map(branch => <div key={branch} className="branching-node branching-child"><div className="branching-node-title"><GitBranch size={16} aria-hidden />{branch}</div>{branch === 'demo' && <p className="branching-node-note" data-testid="graph-count">{changes === 0 ? '0 changes · clean' : `${changes} test ${changes === 1 ? 'change' : 'changes'}`}</p>}</div>)}</div></div>
    </div>}
  </section>;
}
