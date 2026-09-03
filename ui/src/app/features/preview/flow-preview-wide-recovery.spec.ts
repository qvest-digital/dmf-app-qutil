import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AudioMeters } from './audio-meters';
import { FlowPreview } from './flow-preview';

const FLOW = 'd4d00000-0000-0000-0000-00000000a003';

/**
 * A wide flow opens one WHEP connection per pair, and each of those is wired
 * the same as the single-connection path already was: a measured readout, and
 * a pair that spends its retry budget going back to unmeasured rather than
 * being drawn as measured silence.
 */

interface Stat {
  type: string;
  id: string;
  kind?: string;
  bytesReceived?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
}

class FakePeerConnection {
  static built: FakePeerConnection[] = [];
  connectionState = 'new';
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly stats = new Map<string, Stat>();

  constructor() {
    FakePeerConnection.built.push(this);
  }

  addTransceiver(): void {}
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'v=0\r\nm=audio 9 x 96\r\n', type: 'offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async getStats(): Promise<Map<string, Stat>> {
    return this.stats;
  }
  close(): void {}

  /** Drive a connection-state transition the way the browser would. */
  enter(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

describe('FlowPreview wide flow per-pair connections', () => {
  let fixture: ComponentFixture<FlowPreview>;
  let http: HttpTestingController;
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;
  let refuse: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    refuse = false;
    FakePeerConnection.built = [];
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (refuse) return Promise.resolve(new Response('', { status: 404 }));
        return Promise.resolve(
          new Response('v=0', { status: 201, headers: { Location: '/session' } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    TestBed.configureTestingModule({
      imports: [FlowPreview],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPC;
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A 4-channel flow: two pairs, [1,2] connected first and [3,4] second. */
  function openWide(): void {
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', {
      id: FLOW,
      label: 'telos-upmax-out',
      format: 'audio',
      channels: 4,
    });
    fixture.detectChanges();
    const requests = http.match(
      (r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`),
    );
    requests.forEach((r, i) => r.flush({ path: `p${i}`, hls: '', whep: '', format: 'audio' }));
    fixture.detectChanges();
  }

  function state(): string {
    return fixture.nativeElement.querySelector('.pv-state')?.textContent ?? '';
  }

  function measure(): string {
    return fixture.nativeElement.querySelector('.pv-meas')?.textContent ?? '';
  }

  function internals() {
    return fixture.componentInstance as unknown as {
      pcs: Map<string, unknown>;
      streamsByPair: Map<string, unknown>;
    };
  }

  it('drops a pair that spends its retry budget instead of reading as measured silence', async () => {
    refuse = true;
    openWide();
    expect(internals().pcs.size).toBe(2);

    await vi.advanceTimersByTimeAsync(12000);
    fixture.detectChanges();

    expect(internals().pcs.size).toBe(0);
    expect(internals().streamsByPair.size).toBe(0);
    expect(state()).toContain('failed to connect');
  });

  it("feeds the selected pair's connection stats into the measure readout", async () => {
    openWide();
    await vi.advanceTimersByTimeAsync(0);
    // [1,2] is requested first and is the pair marked selected as soon as the
    // card opens.
    const peer = FakePeerConnection.built[0];
    peer.enter('connected');

    peer.stats.set('a', {
      type: 'inbound-rtp',
      id: 'a',
      kind: 'audio',
      bytesReceived: 1000,
      jitterBufferDelay: 4.8,
      jitterBufferEmittedCount: 48000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    fixture.detectChanges();

    expect(measure()).toContain('WebRTC');
  });

  it('does not rebuild the meters for a repeated identical stream', async () => {
    const spy = vi.spyOn(AudioMeters.prototype, 'startMulti');
    openWide();
    await vi.advanceTimersByTimeAsync(0);
    // [3,4] rather than [1,2]: the selected pair's stream also gets attached
    // to the <video>, and jsdom's real element has no working play().
    const peer = FakePeerConnection.built[1];
    const stream = {} as MediaStream;

    peer.ontrack?.({ streams: [stream] });
    fixture.detectChanges();
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    peer.ontrack?.({ streams: [stream] });
    fixture.detectChanges();

    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});
