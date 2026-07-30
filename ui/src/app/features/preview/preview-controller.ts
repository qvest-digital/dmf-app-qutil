import { Injectable, signal } from '@angular/core';

export interface PreviewRequest {
  id: string;
  label: string;
  format: 'video' | 'audio';
  channels: number;
}

/**
 * Which flow the preview overlay should be showing, if any.
 *
 * The overlay lives outside the polled operator-flows list — a 3s refresh must
 * never tear down a playing preview — so the request travels through here rather
 * than through the list's own inputs.
 */
@Injectable({ providedIn: 'root' })
export class PreviewController {
  private readonly _request = signal<PreviewRequest | null>(null);
  readonly request = this._request.asReadonly();

  open(request: PreviewRequest): void {
    this._request.set(request);
  }

  close(): void {
    this._request.set(null);
  }
}
