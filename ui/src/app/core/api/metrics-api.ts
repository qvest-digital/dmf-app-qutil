import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AncGrain,
  BookingResponse,
  FlowsResponse,
  OperatorFlowsResponse,
  PreviewSession,
  PreviewStatus,
} from './models';

/**
 * The demo-metrics aggregator (k8s/metrics/aggregator.py), reached through
 * Caddy's `handle /api/*` reverse proxy. It already answers with
 * `Cache-Control: no-store`, so none of these need cache-busting of their own.
 */
@Injectable({ providedIn: 'root' })
export class MetricsApi {
  private readonly http = inject(HttpClient);

  /** Per-flow writer + compositor + gateway metrics for the four demo tiles. */
  flows(): Observable<FlowsResponse> {
    return this.http.get<FlowsResponse>('/api/flows');
  }

  /** Every MxlFlow CR the mxl-k8s operator knows about, demo-related or not. */
  operatorFlows(): Observable<OperatorFlowsResponse> {
    return this.http.get<OperatorFlowsResponse>('/api/operator-flows');
  }

  booking(): Observable<BookingResponse> {
    return this.http.get<BookingResponse>('/api/booking');
  }

  /**
   * Provision a mediamtx path for this flow (pull for video, push for audio).
   *
   * `owner` names who is asking. A tile and the operator overlay can play the
   * same flow at once and both resolve to the same path, so the aggregator
   * counts holders and only tears the path down when the last one releases it.
   */
  startPreview(uuid: string, owner?: string): Observable<PreviewSession> {
    return this.http.post<PreviewSession>(
      `/api/preview/${encodeURIComponent(uuid)}${this.ownerQuery(owner)}`,
      null,
    );
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

  /**
   * The newest grain of a data flow. No owner and no teardown: unlike a video or
   * audio preview this provisions nothing, it just reads what is already there.
   */
  ancGrain(uuid: string): Observable<AncGrain> {
    return this.http.get<AncGrain>(`/api/anc/${encodeURIComponent(uuid)}`);
  }

  private ownerQuery(owner?: string): string {
    return owner ? `?owner=${encodeURIComponent(owner)}` : '';
  }

  /** Delete flow n's writer pod, so the audience can watch Kubernetes recover it. */
  kill(n: number): Observable<unknown> {
    return this.http.post(`/api/kill/${n}`, null);
  }
}
