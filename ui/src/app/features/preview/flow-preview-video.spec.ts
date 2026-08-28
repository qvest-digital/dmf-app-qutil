import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PlayerRegistry } from '../../core/player/player-registry';
import { FlowPreview } from './flow-preview';

const FLOW = 'b2000000-0000-0000-0000-000000000001';

/**
 * The real players run. The Angular unit-test system refuses vi.mock for
 * relative imports, and mocking them would not have covered the thing worth
 * covering anyway: which address the card actually asks for. Only the two
 * browser APIs beneath WHEP are replaced, because jsdom has neither.
 */
let offered: string[] = [];
let answerWith: (() => Promise<Response>) | null = null;

class FakePeerConnection {
  iceGatheringState = 'complete';
  localDescription = { sdp: 'v=0', type: 'offer' };
  connectionState = 'new';
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;

  addTransceiver(): void {}
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'v=0', type: 'offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

/** Let every pending promise in the WHEP handshake settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * A video card played HLS and nothing else, which costs the whole playlist
 * window before the picture is reached. These cover which transport it asks
 * for first, what it hands over, and what happens when that fails.
 */
describe('FlowPreview video transport', () => {
  let fixture: ComponentFixture<FlowPreview>;
  let http: HttpTestingController;
  let registry: PlayerRegistry;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    offered = [];
    answerWith = async () =>
      new Response('v=0', { status: 201, headers: { 'Content-Type': 'application/sdp' } });

    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((url: string) => {
      offered.push(url);
      return answerWith!();
    }) as typeof fetch;

    TestBed.configureTestingModule({
      imports: [FlowPreview],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    registry = TestBed.inject(PlayerRegistry);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  function openVideo(): void {
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', { id: FLOW, label: 'writer-1', format: 'video' });
    fixture.detectChanges();
    const req = http.expectOne(
      (r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`),
    );
    req.flush({
      path: `preview-${FLOW}`,
      hls: `/hls/preview-${FLOW}/index.m3u8`,
      whep: `/webrtc/preview-${FLOW}/whep`,
      format: 'video',
    });
    fixture.detectChanges();
  }

  it('reaches for WHEP rather than HLS', () => {
    openVideo();

    expect(registry.counts().pc).toBe(1);
    expect(registry.counts().hls).toBe(0);
  });

  /**
   * whep() builds /webrtc/<path>/whep itself. Handing it the address the
   * session carries, by symmetry with the HLS call beside it, asks for
   * /webrtc//webrtc/preview-.../whep/whep.
   */
  it('offers against the path, not the address the session carries', async () => {
    openVideo();
    await settle();

    // Two requests, both to the same endpoint: the OPTIONS preflight that
    // asks which relay to use, then the offer. Every candidate the server
    // returns is a pod address, so a client that skips the preflight has
    // nothing to pair with and drops to HLS having looked like it tried.
    expect(offered).toEqual([`/webrtc/preview-${FLOW}/whep`, `/webrtc/preview-${FLOW}/whep`]);
  });

  /**
   * A refused offer is not a verdict on the transport. The path is created on
   * demand, so an offer can arrive before the media server has it, and
   * dropping to HLS on that costs the playlist window for the life of the
   * card. The connection is rebuilt first.
   */
  it('rebuilds a refused offer rather than dropping straight to HLS', async () => {
    vi.useFakeTimers();
    try {
      answerWith = async () => new Response('', { status: 404 });
      openVideo();
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.counts().pc).toBe(1);
      expect(registry.counts().hls).toBe(0);

      const before = offered.length;
      await vi.advanceTimersByTimeAsync(2500);
      expect(offered.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to HLS once the rebuilds are spent', async () => {
    vi.useFakeTimers();
    try {
      answerWith = async () => new Response('', { status: 404 });
      openVideo();
      // Three rebuilds two seconds apart, then the transport is given up on.
      await vi.advanceTimersByTimeAsync(12000);

      expect(registry.counts().pc).toBe(0);
      expect(registry.counts().hls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The card used to wait a fixed 900 ms before playing, because a path that
   * was not on demand refused a reader arriving before the first frame. On
   * demand the media server holds that reader instead, so the wait had nothing
   * left behind it.
   */
  it('starts without waiting out a warmup delay', () => {
    openVideo();

    expect(registry.counts().pc).toBe(1);
  });

  /**
   * Picture and sound are separate flows, so a card that wants both names both
   * and the media server publishes one path with two tracks.
   */
  it('names the audio flow on the wire when one was asked for', () => {
    const audio = 'aea7b9e9-1e5b-4333-9ac4-8689053a77de';
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', {
      id: FLOW,
      label: 'writer-1 + writer-1 audio',
      format: 'video',
      audioId: audio,
    });
    fixture.detectChanges();

    const req = http.expectOne((r) => r.method === 'POST' && r.url.startsWith('/api/preview/'));
    expect(req.request.url).toContain(`audio=${audio}`);
    req.flush({ path: 'p', hls: 'h', whep: 'w', format: 'video', audio });
  });
});
