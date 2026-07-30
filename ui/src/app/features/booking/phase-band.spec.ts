import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BookingInstance, BookingPhase } from '../../core/api/models';
import { PhaseBand } from './phase-band';

function instance(name: string, phase: BookingPhase): BookingInstance {
  return { name, phase };
}

describe('PhaseBand', () => {
  let fixture: ComponentFixture<PhaseBand>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(PhaseBand);
  });

  /** The label of the phase marked `now`, plus the ones marked `done`. */
  async function render(instances: BookingInstance[]) {
    fixture.componentRef.setInput('instances', instances);
    await fixture.whenStable();
    const cells = [...fixture.nativeElement.querySelectorAll('.bk-phase')] as HTMLElement[];
    return {
      labels: cells.map((c) => c.textContent!.trim()),
      now: cells.find((c) => c.classList.contains('now'))?.textContent?.trim() ?? null,
      done: cells.filter((c) => c.classList.contains('done')).map((c) => c.textContent!.trim()),
    };
  }

  it('always shows the schedule in its own vocabulary', async () => {
    const { labels } = await render([]);
    expect(labels).toEqual(['Booked', 'Pre-Roll', 'On Air', 'Post-Roll', 'Reclaimed']);
  });

  it('highlights nothing before a booking exists', async () => {
    const { now, done } = await render([]);
    expect(now).toBeNull();
    expect(done).toEqual([]);
  });

  it('marks the current phase and everything behind it', async () => {
    const { now, done } = await render([instance('t1', 'on-air')]);
    expect(now).toBe('On Air');
    expect(done).toEqual(['Booked', 'Pre-Roll']);
  });

  // The band follows the booking driving the cluster, so a handover shows the
  // instance going on air rather than the one still winding down.
  it('follows the furthest-along instance when two overlap', async () => {
    const { now } = await render([instance('t1', 'post-roll'), instance('t2', 'deploying')]);
    expect(now).toBe('Post-Roll');
  });

  it('does not care which order the aggregator listed them in', async () => {
    const { now } = await render([instance('t2', 'deploying'), instance('t1', 'post-roll')]);
    expect(now).toBe('Post-Roll');
  });

  // 'booked' carries no progress score — an instance that only exists on paper
  // must not outrank one already deploying.
  it('prefers a deploying instance over a merely booked one', async () => {
    const { now } = await render([instance('t1', 'booked'), instance('t2', 'deploying')]);
    expect(now).toBe('Pre-Roll');
  });
});
