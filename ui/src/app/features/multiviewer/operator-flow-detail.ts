import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { AgoSPipe, FmtPipe } from '../../shared/format-pipes';
import { KvRow } from '../../shared/kv-row';

/**
 * Everything the control plane knows about one flow: the MxlFlow CR plus the
 * receivers and mirrors wired to it. Nothing here is measured — the live delivery
 * signal for a flow the compositor does not read is "last grain" under Mirrors.
 */
@Component({
  selector: 'mv-operator-flow-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KvRow, AgoSPipe, FmtPipe],
  templateUrl: './operator-flow-detail.html',
})
export class OperatorFlowDetail {
  readonly flow = input.required<OperatorFlow>();

  protected readonly detail = computed(() => this.flow().detail ?? {});
  protected readonly media = computed(() => this.detail().media ?? {});
  protected readonly isAudio = computed(() => this.flow().format === 'audio');

  protected readonly resolution = computed(() => {
    const { width, height } = this.media();
    return width && height ? `${width}×${height}` : '--';
  });

  /**
   * Only v210 carries the padded-stride derivation, so anything else says so
   * rather than quoting a number its format does not imply.
   */
  protected readonly grainSize = computed(() => {
    const bytes = this.media().grainBytes;
    return bytes ? `${(bytes / 1048576).toFixed(2)} MiB` : 'n/a for this format';
  });

  protected readonly originState = computed(() => {
    const fresh = this.flow().originFresh;
    if (fresh == null) return 'warn' as const;
    return fresh ? ('ok' as const) : ('bad' as const);
  });

  protected readonly tags = computed(() => {
    const tags = this.detail().tags ?? {};
    return Object.keys(tags).map((key) => ({
      // urn:x-nmos:tag:grouphint/v1.0 -> grouphint
      label: key.replace(/^urn:x-nmos:tag:/, '').replace(/\/v[\d.]+$/, ''),
      value: ([] as string[]).concat(tags[key]).join(', '),
    }));
  });

  protected locationState(phase: string | null | undefined): 'ok' | 'bad' | '' {
    if (phase === 'Stale') return 'bad';
    if (phase === 'Origin') return 'ok';
    return '';
  }
}
