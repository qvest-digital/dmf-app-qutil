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
               pod. Anything else (data/smpte291) has no route to a browser, so the
               button says so instead of opening an overlay that never loads. -->
          @if (previewable()) {
            <button class="btn of-prev" type="button" (click)="preview()">Preview</button>
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

  private readonly preview$ = inject(PreviewController);

  protected readonly open = signal(false);

  protected readonly format = computed(() => (this.flow().format ?? '').toLowerCase());
  protected readonly origin = computed(() => originState(this.flow().originFresh));
  protected readonly tooltip = computed(() => originTooltip(this.flow()));

  protected readonly previewable = computed(
    () => this.format() === 'video' || this.format() === 'audio',
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
      format: this.format() as 'video' | 'audio',
      channels: f.detail?.media?.channels ?? DEFAULT_CHANNELS,
    });
  }
}
