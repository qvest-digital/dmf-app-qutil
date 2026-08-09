import { advanceLevelDb } from './audio-meters';

/**
 * Levels for a wide flow arrive from the audio preview a few times a second,
 * while the canvas redraws sixty. Setting the bar to the last reported value
 * leaves it still between polls and then jumping, which reads as lag however
 * current the number is. These pin the ballistics that fill the gap: the fall
 * is the one the reported envelope is already on, and nothing is invented above
 * a level that was actually reported.
 */
describe('advanceLevelDb', () => {
  it('rises to a louder level at once', () => {
    expect(advanceLevelDb(-40, -6, 16)).toBe(-6);
  });

  it('falls at 30 dB/s rather than snapping down', () => {
    expect(advanceLevelDb(-10, -60, 100)).toBeCloseTo(-13, 6);
    expect(advanceLevelDb(-10, -60, 1000)).toBeCloseTo(-40, 6);
  });

  it('never falls past the reported level', () => {
    expect(advanceLevelDb(-10, -12, 1000)).toBe(-12);
  });

  it('holds still when no time has passed', () => {
    expect(advanceLevelDb(-10, -60, 0)).toBe(-10);
  });

  it('treats a backwards clock as no time passing', () => {
    expect(advanceLevelDb(-10, -60, -50)).toBe(-10);
  });

  it('converges on a target that stops moving', () => {
    let level = 0;
    for (let i = 0; i < 200; i++) level = advanceLevelDb(level, -60, 16);
    expect(level).toBe(-60);
  });
});
