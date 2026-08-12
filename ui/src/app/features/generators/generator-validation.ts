import { GeneratorRequest, GeneratorsResponse } from '../../core/api/models';

/**
 * The form's copy of the aggregator's rules.
 *
 * charts/qutil/files/aggregator.py's _validate_generator is the authority: it
 * runs whatever a client sends, and these strings are copied from it word for
 * word so an operator hears the same sentence before and after a round trip.
 * Nothing here is a substitute for that check -- a flow id reaches a `rm -rf`
 * glob in the writer chart, so the server validates it whatever the page does.
 *
 * The allowed sets are not repeated here: they arrive with /api/generators, so a
 * server that accepts another pattern needs no UI change.
 */

/** 36 characters, exactly: a truncated id is a prefix glob over the MXL domain. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_OVERLAY = 32;
const MAX_CHANNELS = 16;

function list(values: readonly (string | number)[]): string {
  return values.join(', ');
}

/** The first thing wrong with a submission, or null. */
export function validateGenerator(
  request: GeneratorRequest,
  limits: GeneratorsResponse | null,
): string | null {
  const video = request.video;
  const audio = request.audio;
  if (!video.enabled && !audio.enabled) return 'enable at least one of video or audio';

  const ttls = limits?.ttls ?? [];
  if (ttls.length && !ttls.includes(request.ttl)) {
    return `expiry must be one of ${list(ttls)}`;
  }

  for (const [on, block, what] of [
    [video.enabled, video, 'video'],
    [audio.enabled, audio, 'audio'],
  ] as const) {
    if (!on) continue;
    const id = (block.id ?? '').trim();
    if (!id) {
      return (
        `a ${what} flow id is required: a writer without one runs on the class ` +
        `default id, and two writers on one flow delete each other's grains`
      );
    }
    if (!UUID_RE.test(id)) return `${what} flow id must be a full UUID, all 36 characters of it`;
    if (id.toLowerCase() === NIL_UUID) return `${what} flow id must not be the nil UUID`;
  }
  if (video.enabled && audio.enabled && video.id.toLowerCase() === audio.id.toLowerCase()) {
    return 'the video and audio flows need different ids';
  }

  if (video.enabled) {
    const patterns = limits?.patterns ?? [];
    if (patterns.length && !patterns.includes(video.pattern)) {
      return `pattern must be one of ${list(patterns)}`;
    }
    const sizes = limits?.frameSizes ?? [];
    if (
      sizes.length &&
      !sizes.some((s) => s.width === video.frameWidth && s.height === video.frameHeight)
    ) {
      return `frame size must be one of ${list(sizes.map((s) => `${s.width}x${s.height}`))}`;
    }
    const rates = limits?.grainRates ?? [];
    if (
      rates.length &&
      !rates.some(
        (r) =>
          r.numerator === video.grainRate.numerator &&
          r.denominator === video.grainRate.denominator,
      )
    ) {
      return `grain rate must be one of ${list(rates.map((r) => `${r.numerator}/${r.denominator}`))}`;
    }
    const overlay = video.overlayText ?? '';
    if (overlay.length > MAX_OVERLAY || !/^[\x20-\x7e]*$/.test(overlay)) {
      return `overlay text must be at most ${MAX_OVERLAY} printable ASCII characters`;
    }
  }

  if (audio.enabled) {
    const rates = limits?.sampleRates ?? [];
    if (rates.length && !rates.includes(audio.sampleRate)) {
      return `sample rate must be one of ${list(rates)}`;
    }
    if (
      !Number.isInteger(audio.channelCount) ||
      audio.channelCount < 1 ||
      audio.channelCount > MAX_CHANNELS
    ) {
      return `channel count must be between 1 and ${MAX_CHANNELS}`;
    }
  }
  return null;
}
