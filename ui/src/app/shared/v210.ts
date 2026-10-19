/**
 * v210 to RGBA, for drawing a grain onto a canvas.
 *
 * v210 is 10-bit 4:2:2 packed into 32-bit little-endian words: three
 * components per word in the low 30 bits, six pixels per four words. Each row
 * is padded to a 128-byte boundary, so the stride is not width * 8 / 3 and a
 * decoder that assumes it drifts diagonally across the picture.
 *
 * The component order per group of four words is
 *   Cb Y Cr | Y Cb Y | Cr Y Cb | Y Cr Y
 * which is two pixels per word-pair at 4:2:2, chroma shared across each pair.
 */

/** Bytes per row, padded as v210 requires. */
export function v210Stride(width: number): number {
  return Math.ceil(width / 48) * 128;
}

/**
 * BT.709 limited-range YCbCr to RGB, on 10-bit input.
 *
 * Limited range because that is what the writers produce: a v210 flow carries
 * Y in 64..940 and chroma in 64..960, so treating it as full range crushes the
 * blacks and clips the whites of a test pattern that is meant to be exact.
 */
function yuvToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const yf = (y - 64) / 876;
  const cbf = (cb - 512) / 896;
  const crf = (cr - 512) / 896;
  const r = yf + 1.5748 * crf;
  const g = yf - 0.1873 * cbf - 0.4681 * crf;
  const b = yf + 1.8556 * cbf;
  return [clamp8(r), clamp8(g), clamp8(b)];
}

function clamp8(v: number): number {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** RGBA bytes plus the geometry they were decoded at. Not an ImageData: that
 *  is a DOM type, and this has to stay callable where there is no document. */
export interface DecodedFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Decode one v210 frame into RGBA bytes.
 *
 * `stride` comes from the server rather than being recomputed here: the reader
 * takes it off the flow, and a mismatch between the two is the kind of bug
 * that renders as a picture that looks almost right.
 */
export function decodeV210(
  payload: ArrayBuffer,
  width: number,
  height: number,
  stride = v210Stride(width),
): DecodedFrame {
  const words = new Uint32Array(payload);
  const wordsPerRow = stride / 4;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row++) {
    const base = row * wordsPerRow;
    if ((base + wordsPerRow) * 4 > payload.byteLength) break;
    let x = 0;
    // Each group of four words carries six pixels.
    for (let group = 0; x < width; group++) {
      const w0 = words[base + group * 4];
      const w1 = words[base + group * 4 + 1];
      const w2 = words[base + group * 4 + 2];
      const w3 = words[base + group * 4 + 3];
      if (w0 === undefined) break;

      const cb0 = w0 & 0x3ff;
      const y0 = (w0 >>> 10) & 0x3ff;
      const cr0 = (w0 >>> 20) & 0x3ff;
      const y1 = w1 & 0x3ff;
      const cb1 = (w1 >>> 10) & 0x3ff;
      const y2 = (w1 >>> 20) & 0x3ff;
      const cr1 = w2 & 0x3ff;
      const y3 = (w2 >>> 10) & 0x3ff;
      const cb2 = (w2 >>> 20) & 0x3ff;
      const y4 = w3 & 0x3ff;
      const cr2 = (w3 >>> 10) & 0x3ff;
      const y5 = (w3 >>> 20) & 0x3ff;

      // Chroma is shared across each pixel pair.
      emit(out, width, row, x++, y0, cb0, cr0);
      emit(out, width, row, x++, y1, cb0, cr0);
      emit(out, width, row, x++, y2, cb1, cr1);
      emit(out, width, row, x++, y3, cb1, cr1);
      emit(out, width, row, x++, y4, cb2, cr2);
      emit(out, width, row, x++, y5, cb2, cr2);
    }
  }
  return { data: out, width, height };
}

function emit(
  out: Uint8ClampedArray,
  width: number,
  row: number,
  x: number,
  y: number,
  cb: number,
  cr: number,
): void {
  if (x >= width) return;
  const [r, g, b] = yuvToRgb(y, cb, cr);
  const i = (row * width + x) * 4;
  out[i] = r;
  out[i + 1] = g;
  out[i + 2] = b;
  out[i + 3] = 255;
}
