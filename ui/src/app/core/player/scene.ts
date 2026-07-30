import { DOCUMENT, DestroyRef, afterNextRender, inject } from '@angular/core';
import { PlayerRegistry } from './player-registry';

/**
 * Wire a page's players to the tab's visibility, replacing the original page's
 * SCENES/showTab pair.
 *
 * A backgrounded tab must decode nothing: closing PeerConnections (not just
 * pausing <video>) is the only way to stop WebRTC decode and RTP, and hls.js
 * instances are destroyed too. On return, only this page's players are rebuilt.
 *
 * Leaving the route destroys the page component, which tears its players down —
 * the router does what `MV.teardownAll()` on every tab click used to do.
 *
 * Call from a page component's constructor or a field initializer.
 */
export function useScene(start: () => void): void {
  const registry = inject(PlayerRegistry);
  const doc = inject(DOCUMENT);
  const destroyRef = inject(DestroyRef);

  const onVisibilityChange = () => {
    // Tear down unconditionally, then rebuild clean: a half-open entry from an
    // attempt that was mid-handshake when the tab was hidden is not reusable.
    registry.teardownAll();
    if (doc.visibilityState !== 'hidden') start();
  };

  // The scene needs its <video> elements to exist before it can attach players.
  afterNextRender(() => {
    if (doc.visibilityState !== 'hidden') start();
    doc.addEventListener('visibilitychange', onVisibilityChange);
  });

  destroyRef.onDestroy(() => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    registry.teardownAll();
  });
}
