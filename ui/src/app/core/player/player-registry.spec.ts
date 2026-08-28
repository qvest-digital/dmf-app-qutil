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
    expect(registry.counts()).toEqual({ pc: 2, hls: 1, timer: 0, preview: 0 });
  });

  it('forgets a dropped entry', () => {
    const entry = registry.track({ kind: 'hls', stop: () => undefined });
    registry.drop(entry);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0, preview: 0 });
  });

  // The whole point of the registry: a hidden tab must leave nothing decoding.
  it('stops everything and empties itself on teardown', () => {
    const stopped: string[] = [];
    registry.track({ kind: 'pc', stop: () => stopped.push('pc') });
    registry.track({ kind: 'hls', stop: () => stopped.push('hls') });
    registry.track({ kind: 'timer', stop: () => stopped.push('timer') });
    // A held mediamtx path is torn down by the same pass, which is what stops a
    // tile leaving a reader running on the server after it leaves the screen.
    registry.track({ kind: 'preview', stop: () => stopped.push('preview') });

    registry.teardownAll();

    expect(stopped.sort()).toEqual(['hls', 'pc', 'preview', 'timer']);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0, preview: 0 });
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
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0, preview: 0 });
  });

  it('survives an entry that drops itself while being stopped', () => {
    const entry = registry.track({ kind: 'hls', stop: () => registry.drop(entry) });
    expect(() => registry.teardownAll()).not.toThrow();
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0, preview: 0 });
  });

  it('exposes the verification probe the runbook uses', () => {
    const probe = (globalThis as unknown as { __mvDebug?: { counts: () => unknown } }).__mvDebug;
    registry.track({ kind: 'pc', stop: () => undefined });
    expect(probe?.counts()).toEqual({ pc: 1, hls: 0, timer: 0, preview: 0 });
  });
});

/**
 * The reason the registry exists, finally connected to the event that should
 * drive it.
 *
 * Chrome does not throttle background-tab WebRTC decode, so the always-on
 * players kept pulling ~12 Mbit/s while this page sat behind a Google Meet
 * tab, starving the call. teardownAll was written for that and nothing ever
 * called it: no listener existed anywhere in the app.
 */
describe('PlayerRegistry visibility', () => {
  let hidden = false;

  function hide(value: boolean): void {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
  });

  it('tears every player down when the tab goes away', () => {
    const registry = new PlayerRegistry();
    const stopped: string[] = [];
    registry.track({ kind: 'pc', stop: () => stopped.push('pc') });
    registry.track({ kind: 'hls', stop: () => stopped.push('hls') });

    hide(true);

    expect(stopped.sort()).toEqual(['hls', 'pc']);
    expect(registry.counts()).toEqual({ pc: 0, hls: 0, timer: 0, preview: 0 });
  });

  /**
   * The entries are stopped, not suspended, so nothing comes back on its own.
   * An owner needs to be told, or the tab comes forward showing a dead card.
   */
  it('publishes the state an owner rebuilds from', () => {
    const registry = new PlayerRegistry();
    expect(registry.visible()).toBe(true);

    hide(true);
    expect(registry.visible()).toBe(false);

    hide(false);
    expect(registry.visible()).toBe(true);
  });

  /**
   * The teardown has to run before the signal is published, or an owner
   * reacting to it races a pass that is still stopping players and rebuilds
   * one that is about to be torn down.
   */
  it('tears down before it says it is hidden', () => {
    const registry = new PlayerRegistry();
    let visibleDuringStop: boolean | null = null;
    registry.track({ kind: 'pc', stop: () => (visibleDuringStop = registry.visible()) });

    hide(true);

    expect(visibleDuringStop).toBe(true);
    expect(registry.visible()).toBe(false);
    expect(registry.counts().pc).toBe(0);
  });
});
