import { Injectable, signal } from '@angular/core';

export interface PreviewRequest {
  id: string;
  label: string;
  format: 'video' | 'audio';
  channels: number;
}

/**
 * Which flows the preview column is carrying, in the order they were opened.
 *
 * The column lives outside the polled operator-flows list -- a 3s refresh must
 * never tear down a playing preview -- so requests travel through here rather
 * than through the list's own inputs.
 *
 * One entry per flow: two cards on one flow would resolve to the same mediamtx
 * path, and closing either would release it under the other.
 */
@Injectable({ providedIn: 'root' })
export class PreviewController {
  private readonly _requests = signal<PreviewRequest[]>([]);
  readonly requests = this._requests.asReadonly();

  open(request: PreviewRequest): void {
    this._requests.update((open) =>
      open.some((r) => r.id === request.id) ? open : [...open, request],
    );
  }

  close(id: string): void {
    this._requests.update((open) => open.filter((r) => r.id !== id));
  }
}
