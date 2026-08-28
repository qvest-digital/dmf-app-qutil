import { Injectable, Signal, signal } from '@angular/core';

/**
 * `preview` is not a decoder: it is a server-side mediamtx path held open for a
 * player. It registers here so that whatever tears players down releases the
 * path in the same pass, rather than leaving a reader running for a tile that
 * is no longer on screen.
 */
export type PlayerKind = 'pc' | 'hls' | 'timer' | 'preview';

export interface PlayerEntry {
  kind: PlayerKind;
  stop: () => void;
}

/**
 * Player lifecycle registry.
 *
 * Chrome does NOT throttle background-tab WebRTC decode, so the always-on WHEP
 * players kept decoding (and pulling ~12 Mbit/s) while this page sat behind a
 * Google Meet tab, starving Meet and dropping the call. Every PeerConnection,
 * Hls instance and scene timer registers here so a hidden tab or a route change
 * can tear the whole set down and rebuild only what the visible page needs.
 */
@Injectable({ providedIn: 'root' })
export class PlayerRegistry {
  private readonly live = new Set<PlayerEntry>();
  private readonly _visible = signal(true);

  /**
   * Whether the tab is on screen. A player owner watches this to rebuild what
   * the teardown below took away, because nothing else will: the entries are
   * stopped, not suspended, and a stopped player does not come back on its own.
   */
  readonly visible: Signal<boolean> = this._visible.asReadonly();

  constructor() {
    // Verification probe, carried over from the page this replaces: counts
    // should be {pc:0,hls:0} when the tab is hidden, and equal the visible
    // route's player count when shown.
    (globalThis as unknown as { __mvDebug?: unknown }).__mvDebug = {
      counts: () => this.counts(),
    };

    if (typeof document === 'undefined') return;
    this._visible.set(!document.hidden);
    document.addEventListener('visibilitychange', () => {
      const visible = !document.hidden;
      // Torn down before the signal is published, so an owner reacting to it
      // sees a set that is already empty rather than racing this pass.
      if (!visible) this.teardownAll();
      this._visible.set(visible);
    });
  }

  track(entry: PlayerEntry): PlayerEntry {
    this.live.add(entry);
    return entry;
  }

  drop(entry: PlayerEntry): void {
    this.live.delete(entry);
  }

  teardownAll(): void {
    // Snapshot first: a stop() that drops its own entry would otherwise mutate
    // the set we are iterating.
    for (const entry of [...this.live]) {
      try {
        entry.stop();
      } catch {
        // A player that fails to stop must not block the rest of the teardown.
      }
    }
    this.live.clear();
  }

  counts(): Record<PlayerKind, number> {
    const c: Record<PlayerKind, number> = { pc: 0, hls: 0, timer: 0, preview: 0 };
    for (const entry of this.live) c[entry.kind]++;
    return c;
  }
}
