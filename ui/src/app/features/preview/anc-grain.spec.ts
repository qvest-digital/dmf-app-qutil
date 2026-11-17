import { TestBed } from '@angular/core/testing';
import { AncCaptions, AncGrain } from '../../core/api/models';
import { AncGrainView } from './anc-grain';

/**
 * The caption text of an ANC data flow.
 *
 * No single grain holds a caption, so the reader decodes it by following the
 * flow and hands over the screen as rows. The card shows those rows as text,
 * says when a decoder fault means they may be wrong, and keeps the packets
 * readable below for a flow that carries none.
 */

const clean: AncCaptions = {
  cdps: 305,
  badCdps: 0,
  parityErrors: 0,
  droppedPackets: 0,
  missedGrains: 0,
  resets: 0,
};

function render(grain: AncGrain): HTMLElement {
  const fixture = TestBed.createComponent(AncGrainView);
  fixture.componentRef.setInput('grain', grain);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function texts(el: HTMLElement, selector: string): string[] {
  return Array.from(el.querySelectorAll(selector)).map((n) =>
    Array.from(n.children.length ? n.children : [n])
      .map((c) => c.textContent!.trim())
      .join(' '),
  );
}

describe('AncGrainView captions', () => {
  it('shows each service and channel as its rows, 708 first', () => {
    const el = render({
      flow: 'f',
      captions: {
        ...clean,
        cea608: [{ channel: 'CC1', language: 'ger', rows: ['Vorstandschef der', 'Deutschen Bank.'] }],
        cea708: [{ service: 1, language: 'ger', rows: ['Deutschen Bank.'] }],
      },
    });

    expect(texts(el, '.anc-cc-head')).toEqual(['CEA-708 service 1 ger', 'CEA-608 CC1 ger']);
    expect(texts(el, '.anc-cc-row')).toEqual(['Deutschen Bank.', 'Vorstandschef der', 'Deutschen Bank.']);
    expect(el.querySelector('.anc-note')?.textContent).not.toContain('error');
  });

  it('keeps a cleared screen on the card instead of dropping it', () => {
    const el = render({ flow: 'f', captions: { ...clean, cea708: [{ service: 1, rows: [] }] } });

    expect(texts(el, '.anc-cc-head')).toEqual(['CEA-708 service 1']);
    expect(texts(el, '.anc-cc-blank')).toEqual(['no caption on screen']);
  });

  it('names the counters that make the text untrustworthy', () => {
    const el = render({
      flow: 'f',
      captions: { ...clean, parityErrors: 3, resets: 1, missedGrains: 7, cea608: [] },
    });

    expect(texts(el, '.anc-note')).toContain('3 parity errors, 1 screen resets');
  });

  it('shows no caption block for a flow that carried none', () => {
    const el = render({ flow: 'f', elements: [] });

    expect(el.querySelector('.anc-cc')).toBeNull();
    expect(texts(el, '.anc-note')).toEqual(['no ANC packets in this grain']);
  });
});
