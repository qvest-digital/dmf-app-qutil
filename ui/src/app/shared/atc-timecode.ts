import { AncElement } from '../core/api/models';

/** DID/SDID of SMPTE ST 12-2 Ancillary Time Code. */
const ATC_DID = 0x60;
const ATC_SDID = 0x60;
/** The 64-bit LTC payload is 16 nibbles, one per user data word. */
const ATC_WORDS = 16;

export interface AtcTimecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  /** HH:MM:SS:FF. Always ':' before the frames, drop-frame included. */
  text: string;
  dropFrame: boolean;
  colorFrame: boolean;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * The timecode an ATC packet carries, or null if the packet is not one or does
 * not decode.
 *
 * Each user data word contributes one nibble of the 64-bit LTC payload in the
 * high half of its data byte, and the nibbles alternate between timecode digits
 * and the binary groups, which are skipped here. Tens digits carry the flags in
 * their upper bits, so each is masked to the width the field actually has.
 *
 * Only the field ranges are checked, so a packet that is ATC-framed but encoded
 * some other way decodes to a wrong time rather than to nothing: the demo's own
 * generators (anc-testsrc, the SRT bridge) put plain BCD in the first four words,
 * which lands in range and is indistinguishable here. Nothing in the packet says
 * which convention wrote it, so the caller has to know its source.
 */
export function decodeAtc(element: AncElement): AtcTimecode | null {
  if (element.did !== ATC_DID || element.sdid !== ATC_SDID) return null;
  if (element.udw.length < ATC_WORDS) return null;

  const nibble = element.udw.map((byte) => (byte >> 4) & 0xf);
  const frames = nibble[0] + (nibble[2] & 0x3) * 10;
  const seconds = nibble[4] + (nibble[6] & 0x7) * 10;
  const minutes = nibble[8] + (nibble[10] & 0x7) * 10;
  const hours = nibble[12] + (nibble[14] & 0x3) * 10;

  // A misread shows as no timecode rather than as a plausible-looking wrong one.
  if (frames > 59 || seconds > 59 || minutes > 59 || hours > 23) return null;

  return {
    hours,
    minutes,
    seconds,
    frames,
    text: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`,
    dropFrame: (nibble[2] & 0x4) !== 0,
    colorFrame: (nibble[2] & 0x8) !== 0,
  };
}
