import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AncGrain,
  FlowIds,
  FlowsResponse,
  Generator,
  GeneratorRequest,
  GeneratorsResponse,
  OperatorFlowsResponse,
  PreviewSession,
  PreviewStatus,
  ServicesResponse,
} from './models';

/**
 * The demo-metrics aggregator (k8s/metrics/aggregator.py), reached through
 * Caddy's `handle /api/*` reverse proxy. It already answers with
 * `Cache-Control: no-store`, so none of these need cache-busting of their own.
 */
@Injectable({ providedIn: 'root' })
export class MetricsApi {
  private readonly http = inject(HttpClient);

  /** Per-flow writer + compositor + gateway metrics for the four demo flows. */
  flows(): Observable<FlowsResponse> {
    return this.http.get<FlowsResponse>('/api/flows');
  }

  /** Booked functions and the addresses they publish. */
  services(): Observable<ServicesResponse> {
    return this.http.get<ServicesResponse>('/api/services');
  }

  /** Every MxlFlow CR the mxl-k8s operator knows about, demo-related or not. */
  operatorFlows(): Observable<OperatorFlowsResponse> {
    return this.http.get<OperatorFlowsResponse>('/api/operator-flows');
  }

  /**
   * Provision a mediamtx path for this flow (pull for video, push for audio).
   *
   * `owner` names who is asking. Two viewers can play the same flow at once and
   * both resolve to the same path, so the aggregator counts holders and only
   * tears the path down when the last one releases it.
   *
   * `channels` is the 1-based source pair an audio preview should publish; a
   * browser gets stereo however wide the flow is. Repeating the call with a
   * different pair moves a running session instead of restarting it, which is
   * what `selectPreviewChannels` relies on.
   */
  startPreview(
    uuid: string,
    owner?: string,
    channels?: number[],
    audio?: string,
  ): Observable<PreviewSession> {
    return this.http.post<PreviewSession>(
      `/api/preview/${encodeURIComponent(uuid)}${this.previewQuery(owner, channels, audio)}`,
      null,
    );
  }

  /**
   * Move a playing audio preview onto another channel pair. Same call as
   * starting one, because the pair is a property of the path: the media server
   * reads the flow itself now, so moving it reconfigures the path and restarts
   * the reader, which a listener hears as a gap.
   */
  selectPreviewChannels(
    uuid: string,
    channels: number[],
    owner?: string,
  ): Observable<PreviewSession> {
    return this.startPreview(uuid, owner, channels);
  }

  /**
   * The generators booked from the UI, plus what the server will accept: the
   * pattern, frame size, grain rate and expiry lists come from there so the form
   * cannot offer a value the aggregator would refuse.
   */
  generators(): Observable<GeneratorsResponse> {
    return this.http.get<GeneratorsResponse>('/api/generators');
  }

  /**
   * Two flow ids nothing holds. Server-side because uniqueness can only be
   * judged against the cluster's index, and because crypto.randomUUID is
   * undefined outside a secure context, which this demo often is not.
   */
  newFlowIds(): Observable<FlowIds> {
    return this.http.get<FlowIds>('/api/generators/flow-ids');
  }

  /** Book a writer. The response is the created generator, so the list does not
   *  have to wait for the next poll. */
  createGenerator(request: GeneratorRequest): Observable<Generator> {
    return this.http.post<Generator>('/api/generators', request);
  }

  /** Release one. The aggregator refuses any name it did not book. */
  deleteGenerator(name: string): Observable<unknown> {
    return this.http.delete(`/api/generators/${encodeURIComponent(name)}`);
  }

  /**
   * The latest decoded ANC grain of a data flow. Polled: there is no stream to
   * subscribe to, only whatever the current grain carries.
   */
  ancGrain(uuid: string): Observable<AncGrain> {
    return this.http.get<AncGrain>(`/api/anc/${encodeURIComponent(uuid)}`);
  }

  /**
   * Whether an audio preview is actually producing yet. /start only spawns the
   * reader; opening the flow can take seconds or fail outright.
   */
  previewStatus(uuid: string): Observable<PreviewStatus> {
    return this.http.get<PreviewStatus>(`/api/preview/${encodeURIComponent(uuid)}`);
  }

  /**
   * Release this owner's hold on the path. The path itself only goes when no
   * other owner is still holding it.
   */
  stopPreview(uuid: string, owner?: string): Observable<unknown> {
    return this.http.delete(`/api/preview/${encodeURIComponent(uuid)}${this.ownerQuery(owner)}`);
  }

  private ownerQuery(owner?: string): string {
    return owner ? `?owner=${encodeURIComponent(owner)}` : '';
  }

  private previewQuery(owner?: string, channels?: number[], audio?: string): string {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    if (channels?.length) params.set('channels', channels.join(','));
    if (audio) params.set('audio', audio);
    const query = params.toString();
    return query ? `?${query}` : '';
  }
}
