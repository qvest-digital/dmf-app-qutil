import { PlayerRegistry } from './player-registry';

describe('PlayerRegistry', () => {
  let registry: PlayerRegistry;

  beforeEach(() => {
    registry = new PlayerRegistry();
  });

  it('counts what is live by kind', () => {
    registry.track({ kind: 'pc', stop: () => undefined });
    registry.track({ kind: 'pc', stop: () => undefined });
    registry.track({ kind: 'hls', stop: () => undefined });
    expect(registry.counts()).toEqual({ pc: 2, hls: 1, timer: 0 });
  });

  it('forgets a dropped entry', () => {
    const entry = registry.track({ kind: 'hls', stop: () => undefined });
    registry.drop(entry);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0 });
  });

  // The whole point of the registry: a hidden tab must leave nothing decoding.
  it('stops everything and empties itself on teardown', () => {
    const stopped: string[] = [];
    registry.track({ kind: 'pc', stop: () => stopped.push('pc') });
    registry.track({ kind: 'hls', stop: () => stopped.push('hls') });
    registry.track({ kind: 'timer', stop: () => stopped.push('timer') });

    registry.teardownAll();

    expect(stopped.sort()).toEqual(['hls', 'pc', 'timer']);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0 });
  });

  // The original swallowed a ReferenceError here and left the PeerConnection open.
  // Swallowing is still right — one bad player must not block the rest — but the
  // others have to be stopped regardless of the order the failure comes in.
  it('keeps tearing down after a stop() throws', () => {
    const stopped: string[] = [];
    registry.track({
      kind: 'pc',
      stop: () => {
        throw new Error('already closed');
      },
    });
    registry.track({ kind: 'hls', stop: () => stopped.push('hls') });

    expect(() => registry.teardownAll()).not.toThrow();
    expect(stopped).toEqual(['hls']);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0 });
  });

  it('survives an entry that drops itself while being stopped', () => {
    const entry = registry.track({ kind: 'hls', stop: () => registry.drop(entry) });
    expect(() => registry.teardownAll()).not.toThrow();
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0 });
  });

  it('exposes the verification probe the runbook uses', () => {
    const probe = (globalThis as unknown as { __mvDebug?: { counts: () => unknown } }).__mvDebug;
    registry.track({ kind: 'pc', stop: () => undefined });
    expect(probe?.counts()).toEqual({ pc: 1, hls: 0, timer: 0 });
  });
});
