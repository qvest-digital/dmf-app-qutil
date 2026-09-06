import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PlayerRegistry } from '../../core/player/player-registry';
import { FlowPreview } from './flow-preview';

const FLOW = 'b2000000-0000-0000-0000-000000000001';

/**
 * What the card does after its transport has already failed once.
 *
 * HLS is the degraded state, not a destination: it costs the playlist window
 * for as long as the card is open. And a hidden tab has every player torn out
 * from under it, which nothing used to put back.
 */

let offered: string[] = [];
let refuse = true;

class FakePeerConnection {
  iceGatheringState = 'complete';
  connectionState = 'new';
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;

  addTransceiver(): void {}
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'v=0\r\nm=video 9 x 96\r\n', type: 'offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {}
}

describe('FlowPreview transport recovery', () => {
  let fixture: ComponentFixture<FlowPreview>;
  let http: HttpTestingController;
  let registry: PlayerRegistry;
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    offered = [];
    refuse = true;
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        offered.push(url);
        if (refuse) return Promise.resolve(new Response('', { status: 404 }));
        return Promise.resolve(new Response('v=0', { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    TestBed.configureTestingModule({
      imports: [FlowPreview],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    registry = TestBed.inject(PlayerRegistry);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPC;
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
    vi.useRealTimers();
  });

  const SESSION = {
    path: `preview-${FLOW}`,
    hls: `/hls/preview-${FLOW}/index.m3u8`,
    whep: `/webrtc/preview-${FLOW}/whep`,
    format: 'video',
  };

  /** Answer the card's request for a path with the one the aggregator holds. */
  function givePath(): void {
    http
      .expectOne((r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`))
      .flush(SESSION);
    fixture.detectChanges();
  }

  function openVideo(): void {
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', { id: FLOW, label: 'writer-1', format: 'video' });
    fixture.detectChanges();
    givePath();
  }

  function hideTab(): void {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
  }

  function showTab(): void {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
  }

  /** Spend the WHEP rebuilds so the card ends up on HLS. */
  async function fallToHls(): Promise<void> {
    openVideo();
    await vi.advanceTimersByTimeAsync(12000);
    expect(registry.counts().hls).toBe(1);
    expect(registry.counts().pc).toBe(0);
  }

  it('climbs back to WHEP after it has settled on HLS', async () => {
    await fallToHls();
    refuse = false;

    await vi.advanceTimersByTimeAsync(31000);

    expect(registry.counts().pc).toBe(1);
    // One element cannot carry both, and a WHEP srcObject takes precedence
    // over the MSE source, so the HLS player has to have gone first.
    expect(registry.counts().hls).toBe(0);
  });

  /**
   * Climbing back is a visible interruption, so a transport that keeps failing
   * must not be retried on a fixed beat: the card would interrupt a working
   * HLS player every half minute for nothing.
   */
  it('waits longer each time the climb back fails', async () => {
    await fallToHls();
    const afterFirstFall = offered.length;

    // First climb, at the base interval, and it fails again.
    await vi.advanceTimersByTimeAsync(31000);
    expect(offered.length).toBeGreaterThan(afterFirstFall);
    await vi.advanceTimersByTimeAsync(12000);
    const afterSecondFall = offered.length;

    // The same wait again buys nothing now: the next one is further out.
    await vi.advanceTimersByTimeAsync(31000);
    expect(offered.length).toBe(afterSecondFall);

    await vi.advanceTimersByTimeAsync(35000);
    expect(offered.length).toBeGreaterThan(afterSecondFall);
  });

  /**
   * The registry tears every player down when the tab goes away, which is what
   * it is for. Nothing put them back, so a tab left in the background came
   * forward showing a card that would never play again.
   */
  it('rebuilds the player when the tab comes back', async () => {
    refuse = false;
    openVideo();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.counts().pc).toBe(1);

    hideTab();
    expect(registry.counts().pc).toBe(0);

    showTab();
    givePath();
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.counts().pc).toBe(1);
  });

  /** Coming back starts from WHEP, not from whatever the card had degraded to. */
  it('comes back on WHEP even if it was on HLS when it was hidden', async () => {
    await fallToHls();
    refuse = false;

    hideTab();
    showTab();
    givePath();
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.counts().pc).toBe(1);
    expect(registry.counts().hls).toBe(0);
  });

  /** The path is left alone while hidden: whether one is still wanted is
   *  answered by whether anything reads it, which the aggregator watches. */
  it('does not release the mediamtx path while hidden', async () => {
    refuse = false;
    openVideo();
    await vi.advanceTimersByTimeAsync(0);

    hideTab();

    expect(http.match((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  /**
   * Nothing reads a path while the tab is hidden, so the aggregator's reaper
   * drops it once its idle grace is spent. Reconnecting to the name the card
   * still holds then spends the WHEP budget on a path the media server no
   * longer has configured and settles on an HLS playlist that is equally gone,
   * which is a card that never plays again for as long as it is open.
   */
  it('asks the aggregator for the path again before it reconnects', async () => {
    refuse = false;
    openVideo();
    await vi.advanceTimersByTimeAsync(0);

    hideTab();
    showTab();

    const again = http.match(
      (r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`),
    );
    expect(again).toHaveLength(1);
    // Nothing is connected until the path is answered for: the card plays what
    // the aggregator hands back, not the name it was holding.
    expect(registry.counts().pc).toBe(0);

    again[0].flush(SESSION);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.counts().pc).toBe(1);
  });

  /** A card whose path cannot be rebuilt says so rather than sitting on
   *  "starting preview" with nothing behind it. */
  it('reports a path it cannot get back', async () => {
    refuse = false;
    openVideo();
    await vi.advanceTimersByTimeAsync(0);

    hideTab();
    showTab();
    http
      .expectOne((r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`))
      .flush({ error: 'flow not known to the operator' }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pv-state').textContent).toContain(
      'preview failed',
    );
    expect(registry.counts().pc).toBe(0);
  });
});
