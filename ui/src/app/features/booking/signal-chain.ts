import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BookingInstance } from '../../core/api/models';

/**
 * Source → bridge → flow → reader → writer → tile, so a stalled source is visible
 * where it stalls. Green where there is positive evidence, amber where the
 * instance is up but nothing arrives.
 */
@Component({
  selector: 'mv-signal-chain',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bk-chain">
      @for (node of nodes(); track node.label; let last = $last) {
        <span class="bk-node"
          ><span class="bk-dot" [class]="node.state"></span>{{ node.label }}</span
        >
        @if (!last) {
          <span class="bk-arrow">→</span>
        }
      }
    </div>
  `,
})
export class SignalChain {
  readonly instances = input<BookingInstance[]>([]);
  /** Whether either tile is actually showing moving frames. */
  readonly frames = input(false);

  protected readonly nodes = computed(() => {
    const onAir = this.instances().some((i) => i.phase === 'on-air');
    const frames = this.frames();
    const state = (ok: boolean, warn = false) => (ok ? 'ok' : warn ? 'warn' : '');
    return [
      { label: 'SRT source', state: state(frames, onAir) },
      { label: 'Bridge', state: state(frames, onAir) },
      { label: 'MXL-Flow', state: state(onAir) },
      { label: 'Reader', state: state(onAir && frames, onAir) },
      { label: 'Writer', state: state(onAir && frames, onAir) },
      { label: 'Multiviewer', state: state(frames) },
    ];
  });
}
