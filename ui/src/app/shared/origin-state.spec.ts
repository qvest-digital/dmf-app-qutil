import { originState, originTooltip } from './origin-state';

describe('originState', () => {
  it('reports a renewed origin Lease as live', () => {
    expect(originState(true)).toEqual({ cls: 'live', label: 'origin fresh' });
  });

  it('reports a lapsed Lease as bad', () => {
    expect(originState(false)).toEqual({ cls: 'bad', label: 'origin stale' });
  });

  // The regression this guards: status.conditions[OriginFresh] is only stamped
  // while reconciling an MxlReceiver, so most flows carry no condition at all.
  // Treating that absence as "not fresh" painted a red dot on healthy flows.
  it('leaves an unclaimed origin grey rather than calling it stale', () => {
    expect(originState(null)).toEqual({ cls: '', label: 'no origin claimed' });
    expect(originState(undefined)).toEqual({ cls: '', label: 'no origin claimed' });
  });
});

describe('originTooltip', () => {
  it('joins the state with whatever the operator can say about it', () => {
    expect(
      originTooltip({
        originFresh: true,
        originReason: 'LeaseRenewed',
        originNode: 'node-1',
        originAge: 7,
      }),
    ).toBe('origin fresh · LeaseRenewed · node-1 · 7s ago');
  });

  it('drops the parts the payload does not carry', () => {
    expect(originTooltip({ originFresh: null, originReason: 'NoOrigin' })).toBe(
      'no origin claimed · NoOrigin',
    );
  });

  it('keeps a zero age, which is the freshest a Lease gets', () => {
    expect(originTooltip({ originFresh: true, originAge: 0 })).toBe('origin fresh · 0s ago');
  });
});
