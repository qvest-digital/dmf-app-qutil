import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BookingInstance } from '../../core/api/models';
import { SignalChain } from './signal-chain';

describe('SignalChain', () => {
  let fixture: ComponentFixture<SignalChain>;

  beforeEach(() => {
    fixture = TestBed.createComponent(SignalChain);
  });

  /** Each node's label paired with its dot state: ok, warn, or neither. */
  async function render(instances: BookingInstance[], frames: boolean) {
    fixture.componentRef.setInput('instances', instances);
    fixture.componentRef.setInput('frames', frames);
    await fixture.whenStable();
    const nodes = [...fixture.nativeElement.querySelectorAll('.bk-node')] as HTMLElement[];
    return nodes.map((node) => {
      const dot = node.querySelector('.bk-dot')!;
      return [
        node.textContent!.trim(),
        dot.classList.contains('ok') ? 'ok' : dot.classList.contains('warn') ? 'warn' : '',
      ];
    });
  }

  it('shows the whole path, in order', async () => {
    const states = await render([], false);
    expect(states.map(([label]) => label)).toEqual([
      'SRT source',
      'Bridge',
      'MXL-Flow',
      'Reader',
      'Writer',
      'Multiviewer',
    ]);
  });

  it('leaves every node neutral with nothing booked and nothing arriving', async () => {
    const states = await render([], false);
    expect(states.every(([, state]) => state === '')).toBe(true);
  });

  // An instance on air but no frames is the interesting case: the path is wired,
  // so everything the booking created is amber rather than green, and the tile at
  // the end stays neutral because nothing has reached it.
  it('goes amber where an on-air instance is not delivering', async () => {
    expect(await render([{ name: 't1', phase: 'on-air' }], false)).toEqual([
      ['SRT source', 'warn'],
      ['Bridge', 'warn'],
      ['MXL-Flow', 'ok'],
      ['Reader', 'warn'],
      ['Writer', 'warn'],
      ['Multiviewer', ''],
    ]);
  });

  it('goes green end to end once frames arrive', async () => {
    expect(await render([{ name: 't1', phase: 'on-air' }], true)).toEqual([
      ['SRT source', 'ok'],
      ['Bridge', 'ok'],
      ['MXL-Flow', 'ok'],
      ['Reader', 'ok'],
      ['Writer', 'ok'],
      ['Multiviewer', 'ok'],
    ]);
  });

  // Frames without an on-air instance happens on the way out of a booking: the
  // player is still draining its buffer after the CR is gone. Report what is
  // observed at the ends, and nothing about the flow in between.
  it('credits only the observed ends when frames outlive the booking', async () => {
    expect(await render([{ name: 't1', phase: 'post-roll' }], true)).toEqual([
      ['SRT source', 'ok'],
      ['Bridge', 'ok'],
      ['MXL-Flow', ''],
      ['Reader', ''],
      ['Writer', ''],
      ['Multiviewer', 'ok'],
    ]);
  });
});
