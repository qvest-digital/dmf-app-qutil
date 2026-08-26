import { Injectable, signal } from '@angular/core';

export interface PreviewRequest {
  id: string;
  label: string;
  format: 'video' | 'audio' | 'data';
  channels: number;
  /**
   * The audio flow to carry alongside a video one. Picture and sound are
   * separate flows and nothing downstream rejoins them, so a card that wants
   * both names both and the media server publishes one path with two tracks.
   */
  audioId?: string;
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
/**
 * What makes two requests the same card. A flow previewed on its own and the
 * same flow previewed with its sound are different paths on the media server,
 * so they are different cards here.
 */
export function key(request: PreviewRequest): string {
  return request.audioId ? `${request.id}+${request.audioId}` : request.id;
}

@Injectable({ providedIn: 'root' })
export class PreviewController {
  private readonly _requests = signal<PreviewRequest[]>([]);
  readonly requests = this._requests.asReadonly();

  open(request: PreviewRequest): void {
    this._requests.update((open) =>
      open.some((r) => key(r) === key(request)) ? open : [...open, request],
    );
  }

  close(id: string): void {
    this._requests.update((open) => open.filter((r) => key(r) !== id && r.id !== id));
  }
}
