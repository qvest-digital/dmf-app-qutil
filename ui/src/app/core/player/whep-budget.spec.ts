import { PlayerRegistry } from './player-registry';
import { whep } from './whep';

/**
 * A preview path is created on demand, so the first offer for a flow is
 * answered only once the server has opened it, started an encoder and produced
 * a frame -- seconds, where the flow has to be mirrored to that node first.
 *
 * None of that says anything about whether the connection will work, so none
 * of it may be charged to the connection's budget. Sharing one budget meant a
 * slow source spent it: measured on one cluster, a cold offer took five of
 * eight seconds to answer, and the card fell back to HLS on a connection that
 * would have formed.
 */
class SlowAnswerPeerConnection {
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

describe('whep budgets', () => {
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPC;
    vi.useRealTimers();
  });

  it('does not charge a slow answer to the connection', async () => {
    vi.useFakeTimers();
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      SlowAnswerPeerConnection;

    // The preflight answers at once; the offer takes seven seconds, which is
    // what a cold source costs and is under the old eight-second budget only
    // by a margin the candidate exchange then has to live inside.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('v=0', { status: 201 })), 7000);
      });
    }) as unknown as typeof fetch;

    let failed = false;
    const registry = new PlayerRegistry();
    const video = { play: () => Promise.resolve() } as unknown as HTMLVideoElement;
    whep(registry, 'preview-x', video, { onFail: () => (failed = true) });

    // Past the old shared budget, and past the answer.
    await vi.advanceTimersByTimeAsync(7500);
    expect(failed).toBe(false);

    // The connection's own budget starts at the answer, so it has its full
    // span from there rather than the remainder of someone else's.
    await vi.advanceTimersByTimeAsync(7000);
    expect(failed).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(failed).toBe(true);
  });
});
