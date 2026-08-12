import { GeneratorRequest, GeneratorsResponse } from '../../core/api/models';
import { validateGenerator } from './generator-validation';

const LIMITS: GeneratorsResponse = {
  namespace: 'production-demo-app',
  className: 'mxl-writer',
  enabled: true,
  max: 8,
  ttls: ['1h', '8h', '24h', 'none'],
  patterns: ['smpte', 'ball', 'gamut', 'checkers-8', 'snow', 'zone-plate'],
  animated: ['ball', 'snow', 'zone-plate'],
  frameSizes: [
    { width: 640, height: 360 },
    { width: 1296, height: 720 },
    { width: 1920, height: 1080 },
  ],
  grainRates: [
    { numerator: 30000, denominator: 1001 },
    { numerator: 25, denominator: 1 },
  ],
  sampleRates: [44100, 48000, 96000],
  generators: [],
};

const VIDEO_ID = '3f2c8a1e-1111-4222-8333-444455556666';
const AUDIO_ID = '9b1d0000-2222-4333-8444-555566667777';

type Over = {
  ttl?: string;
  video?: Partial<GeneratorRequest['video']>;
  audio?: Partial<GeneratorRequest['audio']>;
};

function request(over: Over = {}): GeneratorRequest {
  return {
    label: 'Bars 1',
    ttl: over.ttl ?? '1h',
    video: {
      enabled: true,
      id: VIDEO_ID,
      pattern: 'smpte',
      overlayText: '',
      frameWidth: 1296,
      frameHeight: 720,
      grainRate: { numerator: 30000, denominator: 1001 },
      ...over.video,
    },
    audio: {
      enabled: false,
      id: AUDIO_ID,
      sampleRate: 48000,
      channelCount: 2,
      ...over.audio,
    },
  };
}

/**
 * These rules exist because of what a flow id reaches. The writer chart's
 * prepareDomain container runs `rm -rf "<domain>/<id>"*` as root with the glob
 * outside the quotes, so a truncated id matches several production flows and a
 * borrowed one deletes that flow's grains. The server refuses both; this is the
 * copy that spares an operator finding out over the wire.
 */
describe('validateGenerator', () => {
  it('accepts the default form', () => {
    expect(validateGenerator(request(), LIMITS)).toBeNull();
  });

  it('requires a flow id, and says what an empty one would do', () => {
    const error = validateGenerator(request({ video: { id: '' } }), LIMITS);
    expect(error).toContain('a video flow id is required');
    expect(error).toContain("delete each other's grains");
  });

  it('refuses a truncated id, which would glob several flows at once', () => {
    const error = validateGenerator(
      request({ video: { id: 'd4d00000-0000-0000-0000-0000000000' } }),
      LIMITS,
    );
    expect(error).toBe('video flow id must be a full UUID, all 36 characters of it');
  });

  it('refuses the nil UUID', () => {
    const error = validateGenerator(
      request({ video: { id: '00000000-0000-0000-0000-000000000000' } }),
      LIMITS,
    );
    expect(error).toContain('must not be the nil UUID');
  });

  it('refuses one id on both outputs', () => {
    const error = validateGenerator(request({ audio: { enabled: true, id: VIDEO_ID } }), LIMITS);
    expect(error).toBe('the video and audio flows need different ids');
  });

  it('refuses an animated pattern above 1296x720, and allows it below', () => {
    const tooBig = request({
      video: { pattern: 'ball', frameWidth: 1920, frameHeight: 1080 },
    });
    expect(validateGenerator(tooBig, LIMITS)).toContain('stalls the test source');
    expect(validateGenerator(request({ video: { pattern: 'ball' } }), LIMITS)).toBeNull();
  });

  it('allows a still pattern at 1080p', () => {
    const at1080 = request({ video: { frameWidth: 1920, frameHeight: 1080 } });
    expect(validateGenerator(at1080, LIMITS)).toBeNull();
  });

  it('refuses a frame size the server does not offer', () => {
    const odd = request({ video: { frameWidth: 1297, frameHeight: 720 } });
    expect(validateGenerator(odd, LIMITS)).toContain('frame size must be one of');
  });

  it('refuses a pattern outside the server list', () => {
    const error = validateGenerator(request({ video: { pattern: 'rm -rf' } }), LIMITS);
    expect(error).toContain('pattern must be one of');
  });

  it('refuses a grain rate the server does not offer', () => {
    const error = validateGenerator(
      request({ video: { grainRate: { numerator: 0, denominator: 0 } } }),
      LIMITS,
    );
    expect(error).toContain('grain rate must be one of');
  });

  it('refuses an over-long or non-ASCII overlay', () => {
    expect(
      validateGenerator(request({ video: { overlayText: 'x'.repeat(33) } }), LIMITS),
    ).toContain('printable ASCII');
    expect(validateGenerator(request({ video: { overlayText: 'GEN \u00e9' } }), LIMITS)).toContain(
      'printable ASCII',
    );
  });

  it('refuses a submission with neither output', () => {
    const error = validateGenerator(request({ video: { enabled: false } }), LIMITS);
    expect(error).toBe('enable at least one of video or audio');
  });

  it('checks the audio fields only when audio is on', () => {
    expect(
      validateGenerator(request({ audio: { enabled: true, sampleRate: 44000 } }), LIMITS),
    ).toContain('sample rate must be one of');
    expect(
      validateGenerator(request({ audio: { enabled: true, channelCount: 0 } }), LIMITS),
    ).toContain('channel count must be between 1 and 16');
    // Audio off: the same bad rate is nobody's problem.
    expect(validateGenerator(request({ audio: { sampleRate: 44000 } }), LIMITS)).toBeNull();
  });

  it('refuses an expiry the server does not offer', () => {
    expect(validateGenerator(request({ ttl: 'forever' }), LIMITS)).toContain(
      'expiry must be one of',
    );
  });

  /** Before the first poll there is nothing to check a value against, and a form
   *  that refused everything until then would look broken. */
  it('checks what it can before the server has said what it accepts', () => {
    expect(validateGenerator(request(), null)).toBeNull();
    expect(validateGenerator(request({ video: { id: 'nope' } }), null)).toContain(
      'must be a full UUID',
    );
  });
});
