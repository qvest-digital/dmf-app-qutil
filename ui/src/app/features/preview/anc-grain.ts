import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AncGrain } from '../../core/api/models';

/** How many user data words to print before eliding the rest. */
const UDW_SHOWN = 24;

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * The latest ANC grain of a data flow: what the grain is, and one block per
 * RFC-8331 packet in it.
 *
 * ANC has no transport to a browser and nothing to play, so a data preview shows
 * the decoded packets instead. It refreshes on a poll, which means what is on
 * screen is the grain that was current when the poll landed rather than every
 * grain that passed -- enough to read a timecode counting up or to see captions
 * appear, not a capture.
 */
@Component({
  selector: 'mv-anc-grain',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (grain(); as g) {
      @if (g.error) {
        <div class="anc-error">{{ g.error }}</div>
      } @else {
        <div class="anc-head">
          <span class="anc-k">grain</span>
          <span class="anc-v">{{ g.index }}</span>
          <span class="anc-k">RFC-8331</span>
          <span class="anc-v">{{ g.rfc8331Length }} B</span>
          <span class="anc-k">packets</span>
          <span class="anc-v">{{ g.ancCount ?? 0 }}</span>
          <span class="anc-k">slices</span>
          <span class="anc-v">{{ g.validSlices }}/{{ g.totalSlices }}</span>
        </div>
        <!-- The senders here declare ANC_Count 0 and still send packets, so the
             count being wrong is the normal case rather than a fault. -->
        @if (countMismatch()) {
          <div class="anc-note">header declares ANC_Count {{ g.declaredCount }}</div>
        }
        @for (element of g.elements ?? []; track $index) {
          <div class="anc-pkt">
            <div class="anc-pkt-head">
              <span class="anc-did">{{ hexOf(element.did) }}/{{ hexOf(element.sdid) }}</span>
              <span class="anc-desc">{{ element.description }}</span>
            </div>
            <div class="anc-pkt-meta">line {{ element.line }} · DC {{ element.dataCount }}</div>
            <div class="anc-udw">{{ udw(element.udw) }}</div>
          </div>
        } @empty {
          <div class="anc-note">no ANC packets in this grain</div>
        }
      }
    } @else {
      <div class="anc-note">waiting for a grain…</div>
    }
  `,
})
export class AncGrainView {
  readonly grain = input<AncGrain | null>(null);

  protected readonly countMismatch = computed(() => {
    const g = this.grain();
    if (!g) return false;
    return (g.declaredCount ?? 0) !== (g.ancCount ?? 0);
  });

  protected hexOf(value: number): string {
    return hex(value);
  }

  protected udw(words: number[]): string {
    const shown = words.slice(0, UDW_SHOWN).map(hex).join(' ');
    return words.length > UDW_SHOWN ? `${shown} … +${words.length - UDW_SHOWN}` : shown;
  }
}
