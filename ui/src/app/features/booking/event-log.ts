import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { StoryBeat } from '../../core/api/models';
import { ClockTimePipe } from '../../shared/format-pipes';

const ICON: Record<StoryBeat['kind'], string> = {
  deploy: '▶',
  live: '●',
  teardown: '■',
};

/**
 * The few cluster events an audience can follow, newest first. The aggregator has
 * already filtered Kubernetes' own plumbing out and phrased what is left in the
 * language of the schedule.
 */
@Component({
  selector: 'mv-event-log',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ClockTimePipe],
  template: `
    <ol class="bk-log">
      @for (beat of newestFirst(); track $index) {
        <li>
          <span class="t">{{ beat.at | clockTime }}</span>
          <span class="i">{{ icon(beat.kind) }}</span>
          <span>{{ beat.text }}</span>
        </li>
      }
    </ol>
  `,
})
export class EventLog {
  readonly story = input<StoryBeat[]>([]);

  /** The payload is oldest-last so it can be appended to; the log reads down. */
  protected readonly newestFirst = computed(() => [...this.story()].reverse());

  protected icon(kind: StoryBeat['kind']): string {
    return ICON[kind] ?? '';
  }
}
