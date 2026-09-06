import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FlowGroup } from '../preview/flow-groups';
import { PreviewController, requestFor } from '../preview/preview-controller';

/**
 * The head of one box in the flow list: what the producer called this group,
 * and the preview that plays its picture and its sound together.
 *
 * The pair lives here rather than on the picture's own row because a row
 * cannot see its siblings, and because a row's Preview button that quietly
 * opened a second flow left no way to watch the picture alone. One button per
 * thing that can be played: the group's, and each member's own.
 */
@Component({
  selector: 'mv-flow-group-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fg-head">
      <span class="fg-name" title="NMOS group name">{{ group().name }}</span>
      @if (pair()) {
        <button class="btn fg-prev" type="button" [title]="title()" (click)="preview()">
          Preview A/V
        </button>
      } @else {
        <button class="btn fg-prev" type="button" disabled [title]="title()">Preview A/V</button>
      }
    </div>
  `,
})
export class FlowGroupHead {
  readonly group = input.required<FlowGroup>();

  private readonly preview$ = inject(PreviewController);

  /** Picture and sound both, or nothing to combine. */
  protected readonly pair = computed(() => {
    const { video, audio } = this.group();
    return video && audio ? { video, audio } : null;
  });

  protected readonly title = computed(() => {
    const pair = this.pair();
    if (pair) return `${pair.video.label} with ${pair.audio.label}`;
    return `${this.group().name} published no video and audio pair`;
  });

  /**
   * Open the pair as one card.
   *
   * One path on the media server carries both, so the picture is decoded and
   * encoded once. Opening the two flows as separate cards would cost a second
   * encoder for the same frames, at about 1.4 cores against roughly one
   * percent for the sound.
   */
  protected preview(): void {
    const pair = this.pair();
    if (!pair) return;
    this.preview$.open(requestFor(pair.video, pair.audio));
  }
}
