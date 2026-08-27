import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { originState, originTooltip } from '../../shared/origin-state';
import { PreviewController } from '../preview/preview-controller';
import { OperatorFlowDetail } from './operator-flow-detail';

/** Fallback channel count when the flow definition does not state one. */
const DEFAULT_CHANNELS = 2;

@Component({
  selector: 'mv-operator-flow-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OperatorFlowDetail],
  template: `
    <div class="flow">
      <div class="row">
        <span class="dot" [class]="origin().cls" [title]="tooltip()"></span>
        <span class="name">
          {{ flow().label }}
          @if (format()) {
            <span class="badge" [class]="badgeClass()">{{ format() }}</span>
          }
        </span>
        <span class="quick">
          <span class="m">
            <div class="k">media</div>
            <div class="v">{{ media() || '--' }}</div>
          </span>
          <span class="m">
            <div class="k">rate</div>
            <div class="v lime">{{ flow().rate || '--' }}</div>
          </span>
        </span>
        <span class="actions">
          <button class="btn of-det" type="button" (click)="open.set(!open())">
            Details {{ open() ? '▴' : '▾' }}
          </button>
          <!-- Video is pulled by mediamtx, audio is pushed by the audio-preview
               pod, and ANC data is read grain by grain. Anything else has no route
               to a browser, so the button says so instead of opening a card that
               never fills. -->
          @if (previewable()) {
            <button class="btn of-prev" type="button" [title]="previewTitle()" (click)="preview()">
              Preview
            </button>
          } @else {
            <button
              class="btn"
              type="button"
              disabled
              [title]="'No preview route for a ' + (format() || 'flow of unknown format') + ' flow'"
            >
              Preview
            </button>
          }
        </span>
      </div>
      <div class="of-meta">
        {{ flow().id }} · <span class="loc">{{ locations() }}</span> · {{ origin().label }}
        @if (flow().grouphint) {
          · {{ flow().grouphint }}
        }
      </div>
      <div class="detail" [class.open]="open()">
        @if (open()) {
          <mv-operator-flow-detail [flow]="flow()" />
        }
      </div>
    </div>
  `,
})
export class OperatorFlowRow {
  readonly flow = input.required<OperatorFlow>();
  /**
   * The audio flow tagged with the same NMOS source as this one, when the
   * producer published both. Supplied by the list, which is the only place
   * that can see a flow's siblings.
   */
  readonly audioSibling = input<OperatorFlow | null>(null);

  private readonly preview$ = inject(PreviewController);

  protected readonly open = signal(false);

  protected readonly format = computed(() => (this.flow().format ?? '').toLowerCase());
  /**
   * One pill per format the list can show. An unrecognised format borrows the
   * video pill rather than rendering an unstyled badge.
   */
  protected readonly badgeClass = computed(() => {
    const format = this.format();
    return format === 'audio' || format === 'data' ? format : 'video';
  });
  protected readonly origin = computed(() => originState(this.flow().originFresh));
  protected readonly tooltip = computed(() => originTooltip(this.flow()));

  /** Names the sound that comes with the picture, where there is any. */
  protected readonly previewTitle = computed(() => {
    const audio = this.audioSibling();
    return audio ? `Picture and sound, with ${audio.label}` : '';
  });

  /**
   * Video is pulled by mediamtx, audio is pushed by the audio-preview pod, and a
   * data flow is read as decoded ANC packets. Anything else has no route to a
   * browser at all.
   */
  protected readonly previewable = computed(
    () => this.format() === 'video' || this.format() === 'audio' || this.format() === 'data',
  );

  protected readonly media = computed(() => {
    const f = this.flow();
    const parts =
      this.format() === 'audio'
        ? [f.mediaType, f.channels ? `${f.channels} ch` : null]
        : [f.mediaType, f.resolution];
    return parts.filter(Boolean).join(' · ');
  });

  protected readonly locations = computed(
    () =>
      (this.flow().locations ?? []).map((l) => `${l.node}:${l.phase}`).join(', ') || 'no locations',
  );

  /**
   * Open this flow's canonical preview.
   *
   * Where the producer tagged a video flow and an audio flow with one source,
   * the canonical preview is the pair. It is not an alternative offered beside
   * a picture-only one: two affordances would be two paths on the media
   * server, so the same picture would be decoded and encoded twice, at about
   * 1.4 cores each against roughly one percent for the sound. A viewer who
   * does not want to hear it mutes the element.
   */
  protected preview(): void {
    const f = this.flow();
    const audio = this.audioSibling();
    this.preview$.open({
      id: f.id,
      label: audio ? `${f.label} + ${audio.label}` : f.label,
      format: this.format() as 'video' | 'audio' | 'data',
      channels: (audio ?? f).detail?.media?.channels ?? DEFAULT_CHANNELS,
      audioId: audio?.id,
    });
  }
}
