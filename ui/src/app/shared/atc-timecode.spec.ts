import { AncElement } from '../core/api/models';
import { decodeAtc } from './atc-timecode';

function element(udw: number[], did = 0x60, sdid = 0x60): AncElement {
  return { line: 9, did, sdid, dataCount: udw.length, description: '', udw };
}

/**
 * The bytes below are a grain off the ST 2110 ANC flow on the bench, which reads
 * 12:15:40:15 -- one nibble of the LTC payload per word, in the high half of each
 * data byte, with the binary groups in between.
 */
const BENCH_UDW = [
  0x50, 0x08, 0x10, 0x00, 0x00, 0x00, 0x40, 0x00, 0x50, 0x00, 0x10, 0x00, 0x20, 0x00, 0x10, 0x00,
];

describe('decodeAtc', () => {
  it('reads the timecode a conformant ATC packet carries', () => {
    const tc = decodeAtc(element(BENCH_UDW));

    expect(tc?.text).toBe('12:15:40:15');
    expect(tc).toMatchObject({ hours: 12, minutes: 15, seconds: 40, frames: 15 });
  });

  it('takes the flags out of the tens nibbles rather than the digits', () => {
    // Frame tens nibble with both flags set: 0b1101 -> tens 1, drop and colour.
    const udw = [...BENCH_UDW];
    udw[2] = 0xd0;
    const tc = decodeAtc(element(udw));

    expect(tc?.frames).toBe(15);
    expect(tc?.dropFrame).toBe(true);
    expect(tc?.colorFrame).toBe(true);
  });

  it('ignores a packet that is not ancillary timecode', () => {
    expect(decodeAtc(element(BENCH_UDW, 0x61, 0x02))).toBeNull();
  });

  it('ignores a short packet', () => {
    expect(decodeAtc(element(BENCH_UDW.slice(0, 8)))).toBeNull();
  });

  /**
   * The demo generators write BCD in the first four words instead. That decodes
   * to an in-range time under ST 12M-2, so it cannot be told apart from a
   * conformant packet -- pinned here so the limitation is not mistaken for a bug
   * later. A caller that needs certainty has to know which side wrote the flow.
   */
  it('cannot tell a BCD-convention payload apart, and decodes it wrongly', () => {
    const bcd = [0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(decodeAtc(element(bcd))?.text).toBe('00:00:00:11');
  });

  it('rejects a decode whose fields fall out of range', () => {
    // Second tens nibble 7 -> 70 seconds, which no timecode has.
    const udw = [...BENCH_UDW];
    udw[6] = 0x70;
    expect(decodeAtc(element(udw))).toBeNull();
  });
});
