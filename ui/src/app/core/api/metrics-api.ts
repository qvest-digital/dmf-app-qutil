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

  /** Provision a mediamtx path for this flow (pull for video, push for audio). */
  startPreview(uuid: string): Observable<PreviewSession> {
    return this.http.post<PreviewSession>(`/api/preview/${encodeURIComponent(uuid)}`, null);
  }

  /**
   * Whether an audio preview is actually producing yet. /start only spawns the
   * reader; opening the flow can take seconds or fail outright.
   */
  previewStatus(uuid: string): Observable<PreviewStatus> {
    return this.http.get<PreviewStatus>(`/api/preview/${encodeURIComponent(uuid)}`);
  }

  /**
   * The newest grain of a data flow. Nothing is provisioned and nothing needs
   * tearing down — unlike startPreview, this is a plain read.
   */
  ancGrain(uuid: string): Observable<AncGrain> {
    return this.http.get<AncGrain>(`/api/anc/${encodeURIComponent(uuid)}`);
  }

  /** Tear the path (and any audio publisher) back down. */
  stopPreview(uuid: string): Observable<unknown> {
    return this.http.delete(`/api/preview/${encodeURIComponent(uuid)}`);
  }

  /** Delete flow n's writer pod, so the audience can watch Kubernetes recover it. */
  kill(n: number): Observable<unknown> {
    return this.http.post(`/api/kill/${n}`, null);
  }
}
