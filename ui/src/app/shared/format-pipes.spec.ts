import {
  AgoPipe,
  AgoSPipe,
  ClockTimePipe,
  FmtPipe,
  ShortImgPipe,
  agoSeconds,
} from './format-pipes';

describe('FmtPipe', () => {
  const pipe = new FmtPipe();

  it('rounds to the requested number of decimals', () => {
    expect(pipe.transform(1234.56)).toBe('1235');
    expect(pipe.transform(1234.56, 1)).toBe('1234.6');
    expect(pipe.transform(29.97, 2)).toBe('29.97');
  });

  it('shows nothing rather than a misleading zero', () => {
    expect(pipe.transform(null)).toBe('--');
    expect(pipe.transform(undefined)).toBe('--');
    expect(pipe.transform(Number.NaN)).toBe('--');
  });

  it('keeps a real zero', () => {
    expect(pipe.transform(0)).toBe('0');
  });
});

describe('agoSeconds', () => {
  it('uses seconds below 90', () => {
    expect(agoSeconds(0)).toBe('0s');
    expect(agoSeconds(89)).toBe('89s');
  });

  it('switches to minutes at 90 and to hours at 5400', () => {
    expect(agoSeconds(90)).toBe('2m');
    expect(agoSeconds(5399)).toBe('90m');
    expect(agoSeconds(5400)).toBe('1.5h');
  });

  it('switches to days at 172800', () => {
    expect(agoSeconds(172799)).toBe('48.0h');
    expect(agoSeconds(172800)).toBe('2.0d');
  });

  // Clock skew between the aggregator and the browser can hand back a negative
  // age; "-3s ago" reads as a bug in the demo rather than in the clocks.
  it('clamps a negative age to zero', () => {
    expect(agoSeconds(-3)).toBe('0s');
  });

  it('shows nothing for a missing age', () => {
    expect(agoSeconds(null)).toBe('--');
    expect(agoSeconds(undefined)).toBe('--');
  });
});

describe('AgoSPipe', () => {
  it('delegates to agoSeconds', () => {
    expect(new AgoSPipe().transform(120)).toBe('2m');
  });
});

describe('AgoPipe', () => {
  const pipe = new AgoPipe();

  it('measures back from an ISO stamp', () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    expect(pipe.transform(tenSecondsAgo)).toBe('10s');
  });

  it('shows nothing without a stamp', () => {
    expect(pipe.transform(null)).toBe('--');
    expect(pipe.transform('')).toBe('--');
  });
});

describe('ShortImgPipe', () => {
  const pipe = new ShortImgPipe();

  it('drops the registry and repository prefix', () => {
    expect(pipe.transform('ghcr.io/qvest-digital/mxl-dmf-writer:e5cf194')).toBe(
      'mxl-dmf-writer:e5cf194',
    );
  });

  it('truncates a long digest to something a row can hold', () => {
    const long = `ghcr.io/x/img@sha256:${'a'.repeat(64)}`;
    expect(pipe.transform(long)).toHaveLength(40);
  });

  it('shows nothing for a pod with no image reported yet', () => {
    expect(pipe.transform(null)).toBe('--');
  });
});

describe('ClockTimePipe', () => {
  const pipe = new ClockTimePipe();

  it('takes the wall-clock slice of an event stamp', () => {
    expect(pipe.transform('2026-07-30T14:35:07Z')).toBe('14:35:07');
  });

  it('is empty when the event carried no timestamp', () => {
    expect(pipe.transform(null)).toBe('');
  });
});
