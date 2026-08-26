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
            <span class="badge" [class]="format() === 'audio' ? 'audio' : 'video'">{{
              format()
            }}</span>
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
            <button class="btn of-prev" type="button" (click)="preview()">Preview</button>
            <!-- Picture and sound are separate flows. Where the producer said
                 they belong together, offer them as one card rather than
                 making the operator find the other half by hand. -->
            @if (audioSibling(); as audio) {
              <button
                class="btn of-prev-av"
                type="button"
                [title]="'With ' + audio.label"
                (click)="previewWithAudio(audio)"
              >
                Preview A/V
              </button>
            }
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
  protected readonly origin = computed(() => originState(this.flow().originFresh));
  protected readonly tooltip = computed(() => originTooltip(this.flow()));

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

  protected preview(): void {
    const f = this.flow();
    this.preview$.open({
      id: f.id,
      label: f.label,
      format: this.format() as 'video' | 'audio' | 'data',
      channels: f.detail?.media?.channels ?? DEFAULT_CHANNELS,
    });
  }

  protected previewWithAudio(audio: OperatorFlow): void {
    const f = this.flow();
    this.preview$.open({
      id: f.id,
      label: `${f.label} + ${audio.label}`,
      format: 'video',
      channels: audio.detail?.media?.channels ?? DEFAULT_CHANNELS,
      audioId: audio.id,
    });
  }
}
