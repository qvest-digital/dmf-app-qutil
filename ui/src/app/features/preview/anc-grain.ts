import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AncGrain } from '../../core/api/models';
import { decodeAtc } from '../../shared/atc-timecode';

/** How many user data words to print before eliding the rest. */
const UDW_SHOWN = 24;
/** A decoded timecode is only trustworthy if the words were read in step. */
function decodable(element: { parityOk?: boolean }): boolean {
  return element.parityOk !== false;
}

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
        <!-- A timecode is the one ANC payload worth reading as a value rather than
             as bytes, so it gets the top of the card and the bytes stay below. -->
        @if (timecode(); as tc) {
          <div class="anc-tc">
            <span class="anc-tc-v">{{ tc.text }}</span>
            <span class="anc-tc-k">ST 12-2 timecode</span>
            @if (tc.dropFrame) {
              <span class="anc-flag">drop frame</span>
            }
            @if (tc.colorFrame) {
              <span class="anc-flag">colour frame</span>
            }
          </div>
        }
        <!-- Captions read as text like a screen shows them; the packets that
             carry them stay below with the rest. -->
        @for (screen of screens(); track screen.key) {
          <div class="anc-cc">
            <div class="anc-cc-head">
              <span class="anc-tc-k">{{ screen.label }}</span>
              @if (screen.language) {
                <span class="anc-tc-k">{{ screen.language }}</span>
              }
            </div>
            <div class="anc-cc-screen">
              @for (row of screen.rows; track $index) {
                <div class="anc-cc-row">{{ row }}</div>
              } @empty {
                <div class="anc-cc-blank">no caption on screen</div>
              }
            </div>
          </div>
        }
        @if (captionFaults(); as faults) {
          <div class="anc-note">{{ faults }}</div>
        }
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
            <div class="anc-pkt-meta">
              line {{ element.line }} · DC {{ element.dataCount }}
              @if (element.parityOk === false) {
                <span class="anc-flag">parity mismatch</span>
              }
            </div>
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

  /** The first timecode in the grain; senders repeat it per line rather than vary it. */
  protected readonly timecode = computed(() => {
    for (const element of this.grain()?.elements ?? []) {
      if (!decodable(element)) continue;
      const tc = decodeAtc(element);
      if (tc) return tc;
    }
    return null;
  });

  /** CEA-708 services first: a sender writing both carries the same text twice. */
  protected readonly screens = computed(() => {
    const c = this.grain()?.captions;
    if (!c) return [];
    return [
      ...(c.cea708 ?? []).map((s) => ({
        key: `708-${s.service}`,
        label: `CEA-708 service ${s.service}`,
        language: s.language,
        rows: s.rows,
      })),
      ...(c.cea608 ?? []).map((s) => ({
        key: `608-${s.channel}`,
        label: `CEA-608 ${s.channel}`,
        language: s.language,
        rows: s.rows,
      })),
    ];
  });

  /** Only the counters that say the text may be wrong, and only when they do. */
  protected readonly captionFaults = computed(() => {
    const c = this.grain()?.captions;
    if (!c) return '';
    const faults: [number, string][] = [
      [c.badCdps, 'bad CDPs'],
      [c.parityErrors, 'parity errors'],
      [c.droppedPackets, 'dropped 708 packets'],
      [c.resets, 'screen resets'],
    ];
    return faults
      .filter(([n]) => n > 0)
      .map(([n, what]) => `${n} ${what}`)
      .join(', ');
  });

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
