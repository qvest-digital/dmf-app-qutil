/**
 * Origin health is genuinely three-state, so the dot is too.
 *
 * green  — an origin Lease is being renewed
 * orange — a node claims Origin but its Lease lapsed
 * grey   — nothing claims Origin (a mirror-only flow, or one just published)
 *
 * That last case is unknown, not broken. Collapsing it into orange used to mark
 * healthy flows as down: status.conditions[OriginFresh] is only stamped while
 * reconciling an MxlReceiver that names the flow, so every flow nobody receives
 * cross-node carries no condition at all.
 */
export interface OriginState {
  /** Modifier for the shared `.dot` class. */
  cls: 'live' | 'bad' | '';
  label: string;
}

export function originState(fresh: boolean | null | undefined): OriginState {
  if (fresh === true) return { cls: 'live', label: 'origin fresh' };
  if (fresh === false) return { cls: 'bad', label: 'origin stale' };
  return { cls: '', label: 'no origin claimed' };
}

/** The dot's tooltip: the state, plus whatever the operator can say about why. */
export function originTooltip(flow: {
  originFresh?: boolean | null;
  originReason?: string | null;
  originNode?: string | null;
  originAge?: number | null;
}): string {
  return [
    originState(flow.originFresh).label,
    flow.originReason,
    flow.originNode,
    flow.originAge == null ? null : `${flow.originAge}s ago`,
  ]
    .filter(Boolean)
    .join(' · ');
}
