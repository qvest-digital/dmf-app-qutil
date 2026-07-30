import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BookingInstance, BookingPhase } from '../../core/api/models';

/** The schedule's own vocabulary, in the order a booking moves through it. */
const PHASES: readonly [BookingPhase, string][] = [
  ['booked', 'Booked'],
  ['deploying', 'Pre-Roll'],
  ['on-air', 'On Air'],
  ['post-roll', 'Post-Roll'],
  ['reclaimed', 'Reclaimed'],
];

/** How far along a phase is, for picking the booking that leads the cluster. */
const PROGRESS: Partial<Record<BookingPhase, number>> = {
  deploying: 1,
  'on-air': 2,
  'post-roll': 3,
  reclaimed: 4,
};

/**
 * One band for the booking that is currently driving the cluster: the instance on
 * air if there is one, otherwise the one coming up or going.
 */
@Component({
  selector: 'mv-phase-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bk-phases">
      @for (phase of phases(); track phase.label) {
        <div class="bk-phase" [class]="phase.cls">{{ phase.label }}</div>
      }
    </div>
  `,
})
export class PhaseBand {
  readonly instances = input<BookingInstance[]>([]);

  protected readonly phases = computed(() => {
    const lead = [...this.instances()].sort(
      (a, b) => (PROGRESS[b.phase!] ?? 0) - (PROGRESS[a.phase!] ?? 0),
    )[0];
    const current = lead?.phase ?? null;
    const index = current ? PHASES.findIndex(([key]) => key === current) : -1;
    return PHASES.map(([, label], i) => ({
      label,
      cls: i === index ? 'now' : index > i ? 'done' : '',
    }));
  });
}
