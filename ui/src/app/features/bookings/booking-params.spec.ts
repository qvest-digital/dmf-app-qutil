import { classError, parseParams } from './booking-params';

describe('booking parameters', () => {
  it('takes the YAML a claim is written in', () => {
    const { value, error } = parseParams(
      'flow:\n  group_hint: w\n  video_output:\n    id: aaaa\n    frame_width: 1296\n',
    );
    expect(error).toBe('');
    expect(value).toEqual({
      flow: { group_hint: 'w', video_output: { id: 'aaaa', frame_width: 1296 } },
    });
  });

  /** Empty is a class whose defaults are enough, not an error. */
  it('reads nothing as no parameters', () => {
    expect(parseParams('   ')).toEqual({ value: {}, error: '' });
  });

  /**
   * The aggregator validates nothing past "is it a mapping", so a list or a
   * bare scalar has to be caught on the form or it books a claim the
   * provisioner cannot read.
   */
  it('refuses anything that is not a mapping', () => {
    expect(parseParams('- one\n- two').value).toBeNull();
    expect(parseParams('just a string').value).toBeNull();
  });

  it('reports where the YAML broke rather than throwing', () => {
    const { value, error } = parseParams('flow:\n  bad: [unclosed\n');
    expect(value).toBeNull();
    expect(error).not.toBe('');
  });

  it('holds a class name to what Kubernetes accepts', () => {
    expect(classError('mxl-writer')).toBe('');
    expect(classError('matrox-mxl-receiver')).toBe('');
    expect(classError('')).not.toBe('');
    expect(classError('Not Valid')).not.toBe('');
    expect(classError('-leading')).not.toBe('');
  });
});
