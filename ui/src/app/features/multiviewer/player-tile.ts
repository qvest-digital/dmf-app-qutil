import { ChangeDetectionStrategy, Component, input, viewChild } from '@angular/core';
import { VideoShell } from '../../shared/video-shell';

/**
 * One tile of the 2x2 grid: the badge naming the node that produces the flow,
 * and the player itself. The badge turns orange when the compositor stops seeing
 * grains for this flow.
 */
@Component({
  selector: 'mv-player-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell],
  template: `
    <div class="playercard">
      <div class="pc-badge" [class.down]="!live()">
        <span class="pc-mxl">MXL-{{ n() }}</span>
        <span class="pc-origin">origin</span>
        <span class="pc-node">{{ node() }}</span>
      </div>
      <mv-video-shell videoClass="pc-video" />
    </div>
  `,
})
export class PlayerTile {
  readonly n = input.required<number>();
  readonly node = input('--');
  readonly live = input(false);

  private readonly shell = viewChild.required(VideoShell);

  get video(): HTMLVideoElement {
    return this.shell().video;
  }
}
