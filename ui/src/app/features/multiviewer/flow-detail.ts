import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Flow } from '../../core/api/models';
import { AgoPipe, FmtPipe, ShortImgPipe } from '../../shared/format-pipes';
import { KvRow } from '../../shared/kv-row';

/** Everything known about one of the four demo flows, from three sources at once. */
@Component({
  selector: 'mv-flow-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KvRow, FmtPipe, AgoPipe, ShortImgPipe],
  templateUrl: './flow-detail.html',
})
export class FlowDetail {
  readonly flow = input.required<Flow>();

  protected readonly writer = computed(() => this.flow().writer ?? {});
  protected readonly compositor = computed(() => this.flow().compositor ?? {});
  protected readonly receiver = computed(() => this.flow().receiver ?? {});
  protected readonly media = computed(() => this.flow().media ?? {});
  protected readonly flowCr = computed(() => this.flow().flow ?? {});

  protected readonly resolution = computed(() => {
    const { width, height } = this.media();
    return width && height ? `${width}×${height}` : '--';
  });

  protected readonly grainSize = computed(() => {
    const bytes = this.media().grainBytes;
    return bytes ? `${(bytes / 1048576).toFixed(2)} MiB` : '--';
  });

  /** v210 overlay blending is the expensive path; I420 is the cheap one. */
  protected readonly overlayState = computed(() => {
    const fmt = this.writer().overlayFormat;
    if (fmt === 'v210') return 'bad' as const;
    return fmt ? ('ok' as const) : ('' as const);
  });

  protected readonly locations = computed(
    () => (this.flowCr().locations ?? []).map((l) => `${l.node}:${l.phase}`).join(', ') || '--',
  );

  protected readonly mirrors = computed(() =>
    (this.flow().mirrors ?? []).map(
      (m) => `${m.sourceNode}→${m.name.split('--').pop()} ${m.phase} (${m.provider})`,
    ),
  );

  /**
   * /api/flows ships the raw MxlFlow condition status, so this is the string
   * 'True' — not a boolean. /api/operator-flows is the endpoint that normalises it.
   */
  protected readonly originFresh = computed(() => this.flowCr().originFresh === 'True');
}
