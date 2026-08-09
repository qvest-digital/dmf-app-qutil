import { advanceLevelDb } from './audio-meters';

/** A 60 Hz frame, and how many of them fall inside one level poll. */
const FRAME = 16;
const FRAMES_PER_POLL = 7;

/**
 * Levels for a wide flow arrive from the audio preview a few times a second,
 * while the canvas redraws sixty. What happens between two reported values is
 * what decides whether the bars look alive.
 *
 * The regression these guard is a law that arrives: setting the bar to the
 * reported value, or limiting how fast it may change, both reach the target
 * within a frame or two and then hold perfectly still until the next poll,
 * which is a visible step at poll rate. Easing towards it never arrives, so
 * every frame moves.
 */
describe('advanceLevelDb', () => {
  it('is still moving a whole poll interval after the target last changed', () => {
    // The one that matters. A level arrives, then nothing changes until the
    // next poll, and a law that arrives at the target holds still for the rest
    // of the interval: a 2 dB drop under a 30 dB/s rate limit is done in four
    // frames and frozen for the remaining eight, which is the step this
    // replaced. Small enough a drop that any rate limit would finish it.
    let level = -20;
    let last = level;
    let moved = 0;
    for (let i = 0; i < FRAMES_PER_POLL; i++) {
      level = advanceLevelDb(level, -22, FRAME);
      if (level !== last) moved++;
      last = level;
    }
    expect(moved).toBe(FRAMES_PER_POLL);
  });

  it('does not overshoot on the way down', () => {
    let level = -10;
    for (let i = 0; i < 200; i++) level = advanceLevelDb(level, -60, FRAME);
    expect(level).toBeGreaterThanOrEqual(-60);
  });

  it('does not overshoot on the way up', () => {
    let level = -60;
    for (let i = 0; i < 200; i++) level = advanceLevelDb(level, -10, FRAME);
    expect(level).toBeLessThanOrEqual(-10);
  });

  it('rises faster than it falls, so a transient is not missed', () => {
    const up = advanceLevelDb(-40, -10, FRAME) - -40;
    const down = -40 - advanceLevelDb(-40, -70, FRAME);
    // Same 30 dB gap either way, so the two are directly comparable.
    expect(up).toBeGreaterThan(down * 4);
  });

  it('settles below anything the meter can show once the target stops moving', () => {
    let level = 0;
    for (let i = 0; i < 200; i++) level = advanceLevelDb(level, -60, FRAME);
    // Easing asymptotes rather than arriving, which is the whole point of it;
    // the bar reads to a tenth of a dB, so a thousandth is settled.
    expect(Math.abs(level - -60)).toBeLessThan(0.001);
  });

  it('holds still when no time has passed', () => {
    expect(advanceLevelDb(-10, -60, 0)).toBe(-10);
  });

  it('treats a backwards clock as no time passing', () => {
    expect(advanceLevelDb(-10, -60, -50)).toBe(-10);
  });

  it('lands on the target after a long gap, as a hidden tab produces', () => {
    expect(advanceLevelDb(-10, -60, 60_000)).toBeCloseTo(-60, 6);
  });
});
