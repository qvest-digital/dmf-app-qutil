import { describe, expect, it } from 'vitest';
import { decodeV210, v210Stride } from './v210';

/** One v210 group: four 32-bit words carrying six pixels, three components each. */
function group(
  cb0: number,
  y0: number,
  cr0: number,
  y1: number,
  cb1: number,
  y2: number,
  cr1: number,
  y3: number,
  cb2: number,
  y4: number,
  cr2: number,
  y5: number,
): number[] {
  return [
    cb0 | (y0 << 10) | (cr0 << 20),
    y1 | (cb1 << 10) | (y2 << 20),
    cr1 | (y3 << 10) | (cb2 << 20),
    y4 | (cr2 << 10) | (y5 << 20),
  ];
}

function frame(words: number[], stride: number, height: number): ArrayBuffer {
  const buf = new ArrayBuffer(stride * height);
  new Uint32Array(buf).set(words);
  return buf;
}

describe('v210Stride', () => {
  // The padding is the whole point: a decoder that uses width * 8 / 3 drifts
  // diagonally across the picture instead of failing outright.
  it('pads each row to a 128-byte boundary', () => {
    expect(v210Stride(1296)).toBe(3456);
    expect(v210Stride(1920)).toBe(5120);
    // 1280 is not a multiple of 48, so the row carries padding past its pixels.
    expect(v210Stride(1280)).toBe(3456);
  });
});

describe('decodeV210', () => {
  const stride = v210Stride(6);

  it('decodes limited-range white and black', () => {
    // Y 940 is limited-range white, Y 64 is limited-range black; neutral
    // chroma sits at 512.
    const white = group(512, 940, 512, 940, 512, 940, 512, 940, 512, 940, 512, 940);
    const img = decodeV210(frame(white, stride, 1), 6, 1, stride);
    expect([img.data[0], img.data[1], img.data[2]]).toEqual([255, 255, 255]);

    const black = group(512, 64, 512, 64, 512, 64, 512, 64, 512, 64, 512, 64);
    const dark = decodeV210(frame(black, stride, 1), 6, 1, stride);
    expect([dark.data[0], dark.data[1], dark.data[2]]).toEqual([0, 0, 0]);
  });

  it('shares chroma across each pixel pair', () => {
    // Two pixels of one pair carry the same chroma but different luma, so a
    // decoder that advanced chroma per pixel would colour them differently.
    const w = group(400, 500, 600, 700, 400, 500, 600, 500, 400, 500, 600, 500);
    const img = decodeV210(frame(w, stride, 1), 6, 1, stride);
    const px = (i: number) => [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
    // Pixel 0 and 1 share cb0/cr0; their luma differs, so only brightness does.
    expect(px(0)).not.toEqual(px(1));
    expect(img.width).toBe(6);
  });

  it('reads each row at the padded stride', () => {
    // Row 1 is black, row 0 is white. Reading at the wrong stride would pick
    // row 1's words up inside row 0.
    const white = group(512, 940, 512, 940, 512, 940, 512, 940, 512, 940, 512, 940);
    const black = group(512, 64, 512, 64, 512, 64, 512, 64, 512, 64, 512, 64);
    const buf = new ArrayBuffer(stride * 2);
    const words = new Uint32Array(buf);
    words.set(white, 0);
    words.set(black, stride / 4);
    const img = decodeV210(buf, 6, 2, stride);
    expect(img.data[0]).toBe(255);
    // First pixel of the second row.
    expect(img.data[6 * 4]).toBe(0);
  });

  it('stops at the payload rather than reading past it', () => {
    // A short grain: the reader hands back what was committed, and a partial
    // one must not throw.
    const short = new ArrayBuffer(stride);
    expect(() => decodeV210(short, 6, 4, stride)).not.toThrow();
  });
});
