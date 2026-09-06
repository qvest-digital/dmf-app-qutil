import { Injectable, signal } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';

/** Fallback channel count when the flow definition does not state one. */
const DEFAULT_CHANNELS = 2;

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
 * What makes two requests the same card. A flow previewed on its own and the
 * same flow previewed with its sound are different paths on the media server,
 * so they are different cards here.
 */
export function key(request: PreviewRequest): string {
  return request.audioId ? `${request.id}+${request.audioId}` : request.id;
}

/**
 * What to open a card with for one flow, or for a picture carrying the sound a
 * producer tagged into the same group.
 *
 * The channel count comes from the flow definition rather than from the row's
 * summary field, because it decides how many pairs the card connects to. On a
 * pair it is the audio flow's, whatever the picture states.
 */
export function requestFor(flow: OperatorFlow, audio?: OperatorFlow | null): PreviewRequest {
  return {
    id: flow.id,
    label: audio ? `${flow.label} + ${audio.label}` : flow.label,
    format: (flow.format ?? '').toLowerCase() as PreviewRequest['format'],
    channels: (audio ?? flow).detail?.media?.channels ?? DEFAULT_CHANNELS,
    audioId: audio?.id,
  };
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
      open.some((r) => key(r) === key(request)) ? open : [...open, request],
    );
  }

  close(id: string): void {
    this._requests.update((open) => open.filter((r) => key(r) !== id && r.id !== id));
  }
}
