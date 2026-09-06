import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { copyText } from '../../shared/clipboard';
import { originState, originTooltip } from '../../shared/origin-state';
import { PreviewController, requestFor } from '../preview/preview-controller';
import { OperatorFlowDetail } from './operator-flow-detail';

/**
 * How a libmxl-fabrics provider reads on a badge. `auto` is deliberately
 * absent: it asks the control plane to resolve a provider rather than naming
 * one, so a mirror still carrying it says nothing about what moves the grains.
 */
const FABRIC_LABELS: Record<string, string> = {
  verbs: 'RoCEv2',
  efa: 'EFA',
  tcp: 'TCP',
  shm: 'SHM',
};

@Component({
  selector: 'mv-operator-flow-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OperatorFlowDetail],
  template: `
    <div class="flow">
      <div class="row">
        <span class="dot" [class]="origin().cls" [title]="tooltip()"></span>
        <span class="name">
          @for (fabric of fabrics(); track fabric) {
            <span class="badge fabric" title="Fabric this flow is mirrored over">{{ fabric }}</span>
          }
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
          <!-- Video and audio are both pulled by mediamtx, which reads the flow
               pod, and ANC data is read grain by grain. Anything else has no route
               to a browser, so the button says so instead of opening a card that
               never fills. -->
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
        {{ flow().id }}
        <button
          class="cp"
          [class.done]="copied()"
          type="button"
          title="Copy flow id"
          aria-label="Copy flow id"
          (click)="copyId()"
        >
          {{ copied() ? '✓' : '⧉' }}
        </button>
        · <span class="loc">{{ locations() }}</span> · {{ origin().label }}
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
  protected readonly copied = signal(false);

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

  /**
   * The transports carrying this flow off the node that holds it, taken from
   * the mirrors rather than from the receivers: a receiver's provider is what a
   * consumer asked for and defaults to `auto`, while the control plane stamps
   * the resolved one onto every mirror before the gateway sets it up.
   *
   * Empty for a flow nothing mirrors, which is read straight out of the local
   * domain and crosses no fabric at all. More than one where a flow is mirrored
   * to nodes that resolved differently, so both are named rather than one of
   * them standing for the other.
   */
  protected readonly fabrics = computed(() => {
    const seen = new Set<string>();
    for (const mirror of this.flow().detail?.mirrors ?? []) {
      const label = FABRIC_LABELS[(mirror.provider ?? '').toLowerCase()];
      if (label) seen.add(label);
    }
    return [...seen];
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
   * Open this flow, and only this one.
   *
   * A picture its producer tagged with sound is previewed with that sound from
   * the group's head, which is the only place that can see both. This button
   * stays what it says it is, so a grouped picture can still be watched alone.
   */
  protected preview(): void {
    this.preview$.open(requestFor(this.flow()));
  }

  /** The id is what every kubectl and every log line is keyed on. */
  protected async copyId(): Promise<void> {
    if (!(await copyText(this.flow().id))) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1000);
  }
}
