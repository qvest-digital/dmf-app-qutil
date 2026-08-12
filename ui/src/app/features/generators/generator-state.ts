import { Generator } from '../../core/api/models';

export interface GeneratorState {
  /** Feeds the shared .dot classes: live, bad, or grey for anything in between. */
  cls: 'live' | 'bad' | '';
  label: string;
}

/**
 * What a booked generator is doing, in one dot and one word.
 *
 * A writer publishes no endpoints, so `handle.ready` and the binder's Reachable
 * reason are the whole account of it. The reason is shown rather than translated:
 * WaitingForProvisioner and WorkloadProgressing mean different things to whoever
 * has to fix them, and flattening both to "pending" would throw that away.
 */
export function generatorState(generator: Generator): GeneratorState {
  if (generator.deleting) return { cls: '', label: 'deleting' };

  const reason = generator.reachable?.reason ?? '';
  if (generator.phase === 'Failed' || reason === 'ProvisionFailed') {
    return { cls: 'bad', label: reason || 'failed' };
  }
  if (generator.phase === 'Expired') return { cls: '', label: 'expired' };
  if (generator.ready) return { cls: 'live', label: 'ready' };
  return { cls: '', label: reason || generator.phase?.toLowerCase() || 'pending' };
}
