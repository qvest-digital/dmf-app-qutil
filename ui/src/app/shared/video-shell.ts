import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';

/**
 * A <video> with a loading overlay on top of it.
 *
 * The spinner sits over the picture until the element actually plays, and comes
 * back if the source resets (a WebRTC reconnect, a switch to another stream):
 * the ICE handshake takes a moment, and on HLS fallback so does buffering.
 *
 * The host is display:contents so `.vwrap` remains the grid/flex item its parent
 * laid out, exactly as when the original page injected the wrapper by hand.
 */
@Component({
  selector: 'mv-video-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vwrap">
      <video
        #video
        [class]="videoClass()"
        [muted]="muted()"
        [controls]="controls()"
        autoplay
        playsinline
        (playing)="playing.set(true)"
        (emptied)="playing.set(false)"
      ></video>
      <div class="vloader" [class.hide]="playing()">
        <div class="spin"></div>
        <span>Verbinde Stream…</span>
      </div>
    </div>
  `,
})
export class VideoShell {
  readonly videoClass = input('');
  readonly controls = input(false);
  /** The preview overlay is the one player whose whole point is being audible. */
  readonly muted = input(true);

  private readonly videoRef = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  protected readonly playing = signal(false);

  /** The element to attach a WHEP PeerConnection or an Hls instance to. */
  get video(): HTMLVideoElement {
    return this.videoRef().nativeElement;
  }
}
