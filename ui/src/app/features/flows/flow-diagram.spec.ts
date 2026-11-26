import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MxlGraph } from '../../core/api/models';
import { burstTiers, FlowDiagram } from './flow-diagram';
import {
  ACROSS,
  DEGRADED,
  LEFTWARD,
  LOCAL_LEG,
  PAIR,
  PLAIN,
  READER_OFF_MERGE,
} from './flow-fixtures';

const LONG = 'matrox-network-ts-transmitter';

const GRAPH: MxlGraph = {
  nodes: ['n01', 'n02'],
  flows: [
    {
      id: 'a',
      label: 'cam 1',
      kind: 'video',
      group: 'g',
      originNode: 'n01',
      producer: { function: LONG, class: LONG, node: 'n01', ready: true },
      consumers: [
        {
          function: 'mediamtx',
          class: 'mediamtx',
          node: 'n02',
          ready: true,
          local: false,
          mirrored: true,
        },
      ],
      mirrors: ['n02'],
    },
  ],
};

/** An ST 2110 sender or receiver reaches the fabric without a pod, so the API
 *  reports no node for it. */
const NODELESS: MxlGraph = {
  nodes: ['n01'],
  flows: [
    {
      id: 'b',
      label: 'cam 2',
      kind: 'video',
      group: 'g',
      originNode: 'n01',
      producer: { function: 'writer', class: 'mxl-writer', node: 'n01', ready: true },
      consumers: [
        {
          function: 'bmd-udc-1',
          class: 'st2110-receiver',
          node: '',
          ready: true,
          local: false,
          mirrored: false,
        },
        {
          function: 'bmd-udc-2',
          class: 'st2110-receiver',
          node: '',
          ready: true,
          local: false,
          mirrored: false,
        },
      ],
      mirrors: [],
    },
  ],
};

describe('FlowDiagram', () => {
  let fixture: ComponentFixture<FlowDiagram>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(FlowDiagram);
    fixture.componentRef.setInput('graph', GRAPH);
    await fixture.whenStable();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const transform = () => el().querySelector('svg > g')?.getAttribute('transform') ?? '';

  it('highlights only a hovered writer, its outgoing wires and their readers', () => {
    fixture.componentRef.setInput('graph', {
      ...GRAPH,
      flows: [
        ...GRAPH.flows,
        {
          ...GRAPH.flows[0],
          id: 'unrelated',
          producer: { function: 'other-writer', node: 'n02', ready: true },
          consumers: [
            { function: 'other-reader', node: 'n01', ready: true, local: false, mirrored: true },
          ],
        },
      ],
    });
    fixture.detectChanges();
    const writer = [...el().querySelectorAll<SVGGElement>('.card')].find((card) =>
      card.querySelector('title')?.textContent?.includes(LONG),
    )!;
    writer.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();

    expect(el().querySelectorAll('.card.highlighted').length).toBe(2);
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
    expect(el().querySelectorAll('.wire.dimmed').length).toBe(1);
    expect(el().querySelector('.wire.highlighted path')?.getAttribute('stroke-width')).toBe('2.5');
    expect(el().querySelectorAll('.wire')[1].classList.contains('highlighted')).toBe(true);

    writer.dispatchEvent(new Event('pointerleave'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.highlighted, .dimmed').length).toBe(0);
  });

  it('tints the card a highlight is traced from in its own border colour', () => {
    const reader = [...el().querySelectorAll<SVGGElement>('.card')].find((card) =>
      card.querySelector('title')?.textContent?.includes('mediamtx'),
    )!;
    const plainFill = reader.querySelector('rect')?.getAttribute('fill');
    reader.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();

    const source = el().querySelectorAll('.card.source');
    expect(source.length).toBe(1);
    expect(source[0]).toBe(reader);
    expect(reader.querySelector('rect')?.getAttribute('fill')).toBe('var(--diagram-reader-tint)');
    const writer = el().querySelector<SVGGElement>('.card.highlighted:not(.source)')!;
    expect(writer.querySelector('rect')?.getAttribute('fill')).toBe('var(--diagram-card)');
    expect(writer.querySelector('rect')?.getAttribute('stroke-width')).toBe('1.5');
    expect(reader.querySelector('rect')?.getAttribute('stroke-width')).toBe('1.75');

    reader.dispatchEvent(new Event('pointerleave'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.card.source').length).toBe(0);
    expect(reader.querySelector('rect')?.getAttribute('fill')).toBe(plainFill);

    writer.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(writer.querySelector('rect')?.getAttribute('fill')).toBe('var(--diagram-writer-tint)');
  });

  it('also traces incoming connections on reader hover and keyboard focus', () => {
    const writer = el().querySelector<SVGGElement>('.card[tabindex="0"]')!;
    writer.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
    writer.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    const reader = [...el().querySelectorAll<SVGGElement>('.card')].find((card) =>
      card.querySelector('title')?.textContent?.includes('mediamtx'),
    )!;
    reader.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
    expect(el().querySelectorAll('.card.highlighted').length).toBe(2);
    reader.dispatchEvent(new Event('pointerleave'));
    reader.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
  });

  it('traces every direct reader without following a reader into its own output', () => {
    fixture.componentRef.setInput('graph', {
      ...GRAPH,
      flows: [
        {
          ...GRAPH.flows[0],
          consumers: [
            ...GRAPH.flows[0].consumers,
            { function: 'local-reader', node: 'n01', ready: true, local: true, mirrored: false },
          ],
        },
        {
          ...GRAPH.flows[0],
          id: 'processed',
          producer: { function: 'mediamtx', class: 'mediamtx', node: 'n02', ready: true },
          consumers: [
            { function: 'downstream', node: 'n01', ready: true, local: false, mirrored: true },
          ],
        },
      ],
    });
    fixture.detectChanges();
    const writer = [...el().querySelectorAll<SVGGElement>('.card')].find((card) =>
      card.querySelector('title')?.textContent?.includes(LONG),
    )!;
    writer.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(2);
    expect(el().querySelectorAll('.card.highlighted').length).toBe(3);
    expect(el().querySelectorAll('.wire.dimmed').length).toBe(1);

    writer.dispatchEvent(new Event('pointerleave'));
    const processor = [...el().querySelectorAll<SVGGElement>('.card')].find((card) =>
      card.querySelector('title')?.textContent?.includes('mediamtx'),
    )!;
    processor.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(el().querySelectorAll('.wire.highlighted').length).toBe(2);
    expect(el().querySelectorAll('.card.highlighted').length).toBe(3);
    expect(el().querySelectorAll('.wire.dimmed').length).toBe(1);
  });

  it('requests fullscreen for the graph including its controls and legend', async () => {
    const figure = el().querySelector('figure')!;
    const request = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(figure, 'requestFullscreen', { value: request });

    await fixture.componentInstance['toggleFullscreen']();

    expect(request).toHaveBeenCalledOnce();
    expect(figure.querySelector('button')).not.toBeNull();
    expect(figure.querySelector('figcaption')).not.toBeNull();
  });

  it('tracks fullscreen changes including escape and exits through its control', async () => {
    const figure = el().querySelector('figure')!;
    let active: Element | null = figure;
    const exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    try {
      document.dispatchEvent(new Event('fullscreenchange'));
      fixture.detectChanges();
      expect(figure.classList.contains('fullscreen')).toBe(true);
      expect(figure.textContent).toContain('Exit fullscreen');
      expect(el().querySelector('svg')?.style.maxWidth).toBe('');

      await fixture.componentInstance['toggleFullscreen']();
      expect(exit).toHaveBeenCalledOnce();

      active = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      fixture.detectChanges();
      expect(figure.classList.contains('fullscreen')).toBe(false);
      expect(el().querySelector('svg')?.style.maxWidth).not.toBe('');
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
    }
  });

  it('keeps a selection through the Escape that leaves fullscreen', () => {
    const figure = el().querySelector('figure')!;
    const card = el().querySelector<SVGGElement>('.card')!;
    let active: Element | null = figure;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active });
    const escape = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
    };
    try {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      escape();
      active = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      fixture.detectChanges();
      expect(el().querySelector('.card.source')).toBe(card);

      escape();
      expect(el().querySelector('.card.source')).toBeNull();
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });

  it('fades the highlight in and out instead of switching it', () => {
    const card = el().querySelector<SVGGElement>('.card')!;
    const wire = el().querySelector<SVGGElement>('.wire')!;
    expect(getComputedStyle(card).transition).toContain('opacity');
    expect(getComputedStyle(wire).transition).toContain('opacity');
    const rect = getComputedStyle(card.querySelector('rect')!).transition;
    expect(rect).toContain('fill');
    expect(rect).toContain('stroke-width');
  });

  it('reports a rejected fullscreen request', async () => {
    const error = new Error('Fullscreen denied');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(el().querySelector('figure')!, 'requestFullscreen', {
      value: vi.fn().mockRejectedValue(error),
    });
    try {
      await fixture.componentInstance['toggleFullscreen']();
      fixture.detectChanges();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain(
        'Could not change fullscreen mode',
      );
      expect(log).toHaveBeenCalledWith('Could not change graph fullscreen mode', error);
    } finally {
      log.mockRestore();
    }
  });

  it('maps zoom and pan through the letterboxing of a fullscreen frame', () => {
    const svg = el().querySelector('svg')!;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 1000, 1000));
    const size = fixture.componentInstance['size']();
    const center = fixture.componentInstance['toDrawing']({ clientX: 510, clientY: 520 });
    expect(center.x).toBeCloseTo(size.w / 2);
    expect(center.y).toBeCloseTo(size.h / 2);
    expect(fixture.componentInstance['perPixel']()).toBeCloseTo(
      Math.max(size.w / 1000, size.h / 1000),
    );
  });

  /**
   * SVG text neither wraps nor clips, so a name longer than its card runs out
   * through the node box and across the diagram. A drawn name stops at the
   * card; the whole one stays reachable in the title.
   */
  it('stops a long name at the edge of its card', () => {
    const drawn = [...el().querySelectorAll('text')].map((t) => t.textContent!.trim());
    const name = drawn.find((t) => t.startsWith('matrox-network'));

    expect(name).toBeDefined();
    expect(name).not.toBe(LONG);
    expect(name!.endsWith('...')).toBe(true);
    // The full value is still there to be read.
    const titles = [...el().querySelectorAll('title')].map((t) => t.textContent!);
    expect(titles.some((t) => t.includes(LONG))).toBe(true);
  });

  it('zooms in and back out again', () => {
    expect(transform()).toContain('scale(1)');

    fixture.componentInstance['zoomBy'](1.25);
    fixture.detectChanges();
    expect(fixture.componentInstance['scale']()).toBeCloseTo(1.25, 5);

    fixture.componentInstance['reset']();
    fixture.detectChanges();
    expect(transform()).toBe('translate(0,0) scale(1)');
  });

  it('holds the zoom between its bounds', () => {
    for (let i = 0; i < 20; i++) fixture.componentInstance['zoomBy'](2);
    expect(fixture.componentInstance['scale']()).toBeLessThanOrEqual(4);

    for (let i = 0; i < 40; i++) fixture.componentInstance['zoomBy'](0.5);
    expect(fixture.componentInstance['scale']()).toBeGreaterThanOrEqual(0.4);
  });

  /**
   * The diagram sits in a page that scrolls. A wheel that zoomed on its own
   * would trap the scroll of anybody who happened to pass over it, so it zooms
   * only while a modifier is held.
   */
  it('leaves a plain wheel to the page', () => {
    const before = fixture.componentInstance['scale']();

    fixture.componentInstance['wheel'](new WheelEvent('wheel', { deltaY: -100 }));

    expect(fixture.componentInstance['scale']()).toBe(before);
  });

  it('zooms on a wheel with the modifier held', () => {
    const before = fixture.componentInstance['scale']();

    fixture.componentInstance['wheel'](new WheelEvent('wheel', { deltaY: -100, ctrlKey: true }));

    expect(fixture.componentInstance['scale']()).toBeGreaterThan(before);
  });

  it('pans on a drag', () => {
    const c = fixture.componentInstance;
    c['grab']({
      clientX: 100,
      clientY: 100,
      pointerId: 1,
      target: el(),
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);
    c['drag']({ clientX: 140, clientY: 130, pointerId: 1 } as unknown as PointerEvent);
    fixture.detectChanges();

    expect(c['tx']()).not.toBe(0);
    expect(c['ty']()).not.toBe(0);
    expect(c['panning']()).toBe(true);

    c['release']({ pointerId: 1, target: el() } as unknown as PointerEvent);
    expect(c['panning']()).toBe(false);
  });

  describe('selecting a card by clicking', () => {
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, bubbles: true });
    let svg: SVGSVGElement;
    let cards: SVGGElement[];
    let points: { clientX: number; clientY: number }[];
    const press = (target: Element, p: { clientX: number; clientY: number }, moveBy = 0) => {
      target.dispatchEvent(new MouseEvent('pointerdown', { ...at(p.clientX, p.clientY) }));
      const end = at(p.clientX + moveBy, p.clientY + moveBy);
      if (moveBy) svg.dispatchEvent(new MouseEvent('pointermove', end));
      svg.dispatchEvent(new MouseEvent('pointerup', end));
      fixture.detectChanges();
    };
    const source = () => el().querySelector('.card.source');

    beforeEach(() => {
      svg = el().querySelector('svg')!;
      const size = fixture.componentInstance['size']();
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, size.w, size.h));
      const layout = fixture.componentInstance['layout']().cards;
      cards = layout.map((c) => el().querySelector<SVGGElement>(`.card[data-key="${c.key}"]`)!);
      points = layout.map((c) => ({ clientX: c.x + 10, clientY: c.y + 10 }));
    });

    it('keeps the clicked card highlighted while the pointer hovers elsewhere', () => {
      press(cards[0], points[0]);
      expect(source()).toBe(cards[0]);

      cards[0].dispatchEvent(new Event('pointerleave'));
      cards[1].dispatchEvent(new Event('pointerenter'));
      svg.dispatchEvent(new MouseEvent('pointermove', at(points[1].clientX, points[1].clientY)));
      svg.dispatchEvent(new MouseEvent('pointerleave'));
      fixture.detectChanges();
      expect(source()).toBe(cards[0]);
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
    });

    it('clears the selection on a second click, a click on empty space or Escape', () => {
      const leave = () => {
        svg.dispatchEvent(new MouseEvent('pointerleave'));
        fixture.detectChanges();
      };
      press(cards[0], points[0]);
      press(cards[0], points[0]);
      leave();
      expect(source()).toBeNull();

      press(cards[0], points[0]);
      press(svg, { clientX: 1, clientY: 1 });
      leave();
      expect(source()).toBeNull();

      press(cards[0], points[0]);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      leave();
      expect(source()).toBeNull();
    });

    it('moves the selection to another clicked card', () => {
      press(cards[0], points[0]);
      press(cards[1], points[1]);
      expect(source()).toBe(cards[1]);
    });

    it('explains how to leave and move a selection only while there is one', () => {
      const hint = () => el().querySelector<HTMLElement>('[data-testid="selection-hint"]')!;
      expect(hint().textContent!.trim()).toBe('');
      press(cards[0], points[0]);
      expect(hint().textContent).toMatch(/^To unselect/);
      // The hint is cut off rather than wrapping or pushing the toolbar wider.
      const style = getComputedStyle(hint());
      expect(style.whiteSpace).toBe('nowrap');
      expect(style.textOverflow).toBe('ellipsis');
      expect(style.minWidth).toBe('0px');
      press(cards[0], points[0]);
      expect(hint().textContent!.trim()).toBe('');
    });

    it('shows a pointer over a card it can select, but not while panning', () => {
      expect(cards[0].style.cursor).toBe('pointer');
      cards[0].dispatchEvent(
        new MouseEvent('pointerdown', at(points[0].clientX, points[0].clientY)),
      );
      fixture.detectChanges();
      expect(cards[0].style.cursor).toBe('');
      svg.dispatchEvent(new MouseEvent('pointerup', at(points[0].clientX, points[0].clientY)));
    });

    it('does not select a card a pan started on', () => {
      press(cards[0], points[0], 20);
      svg.dispatchEvent(new MouseEvent('pointerleave'));
      fixture.detectChanges();
      expect(source()).toBeNull();
    });

    it('selects a focused card with Enter', () => {
      cards[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      expect(source()).toBe(cards[1]);
    });

    it('treats a drag that returns to where it started as a pan, not a click', () => {
      const start = at(points[0].clientX, points[0].clientY);
      cards[0].dispatchEvent(new MouseEvent('pointerdown', start));
      svg.dispatchEvent(new MouseEvent('pointermove', at(start.clientX + 30, start.clientY)));
      svg.dispatchEvent(new MouseEvent('pointermove', start));
      svg.dispatchEvent(new MouseEvent('pointerup', start));
      svg.dispatchEvent(new MouseEvent('pointerleave'));
      fixture.detectChanges();
      expect(source()).toBeNull();
    });

    it('exposes each card as a toggle button carrying its selected state', () => {
      // An img role would hide the cards from assistive technology.
      expect(svg.getAttribute('role')).not.toBe('img');
      expect(cards.every((c) => c.getAttribute('role') === 'button')).toBe(true);
      expect(cards[0].getAttribute('aria-pressed')).toBe('false');
      press(cards[0], points[0]);
      expect(cards[0].getAttribute('aria-pressed')).toBe('true');
      expect(cards[1].getAttribute('aria-pressed')).toBe('false');
      const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
      cards[1].dispatchEvent(space);
      fixture.detectChanges();
      expect(space.defaultPrevented).toBe(true);
      expect(cards[1].getAttribute('aria-pressed')).toBe('true');
    });

    it('drops a selection whose card a refresh removed', () => {
      press(cards[0], points[0]);
      const remaining = fixture.componentInstance['layout']().cards[1].key;
      fixture.componentRef.setInput('graph', {
        ...GRAPH,
        flows: [{ ...GRAPH.flows[0], producer: { ...GRAPH.flows[0].producer, function: 'new' } }],
      });
      fixture.detectChanges();
      expect(fixture.componentInstance['selectedCard']()).toBeNull();
      const hint = el().querySelector('[data-testid="selection-hint"]')!;
      expect(hint.textContent!.trim()).toBe('');
      el()
        .querySelector(`.card[data-key="${remaining}"]`)!
        .dispatchEvent(new Event('pointerenter'));
      fixture.detectChanges();
      expect(source()?.getAttribute('data-key')).toBe(remaining);
    });
  });

  describe('moving a selection with the keyboard', () => {
    const flow = (id: string, writer: string, reader: string) => ({
      id,
      label: id,
      kind: 'video' as const,
      group: 'g',
      originNode: 'n01',
      producer: { function: writer, class: 'mxl-writer', node: 'n01', ready: true },
      consumers: [
        {
          function: reader,
          class: 'mxl-reader',
          node: 'n02',
          ready: true,
          local: false,
          mirrored: true,
        },
      ],
      mirrors: ['n02'],
    });
    const GRID: MxlGraph = {
      nodes: ['n01', 'n02'],
      flows: [flow('a', 'w1', 'r1'), flow('b', 'w2', 'r2')],
    };
    const press = (key: string, shiftKey = false, on: EventTarget = document) => {
      const event = new KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      on.dispatchEvent(event);
      fixture.detectChanges();
      return event;
    };
    const selected = () => el().querySelector('.card.source')?.getAttribute('data-key');
    const card = (name: string) => {
      const c = fixture.componentInstance['layout']().cards.find((c) => c.title === name)!;
      return { key: c.key, el: el().querySelector<SVGGElement>(`.card[data-key="${c.key}"]`)! };
    };
    const select = (name: string) => {
      card(name).el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
    };

    beforeEach(async () => {
      fixture.componentRef.setInput('graph', GRID);
      await fixture.whenStable();
    });

    it('leaves the keys to the page while nothing is selected', () => {
      expect(press('ArrowDown').defaultPrevented).toBe(false);
      expect(press('Tab').defaultPrevented).toBe(false);
      expect(selected()).toBeUndefined();
    });

    it('moves to the neighbouring card an arrow points at', () => {
      select('w1');
      expect(press('ArrowDown').defaultPrevented).toBe(true);
      expect(selected()).toBe(card('w2').key);
      press('ArrowRight');
      expect(selected()).toBe(card('r2').key);
      press('ArrowUp');
      expect(selected()).toBe(card('r1').key);
      press('ArrowLeft');
      expect(selected()).toBe(card('w1').key);
      // Nothing further up: the selection stays.
      press('ArrowUp');
      expect(selected()).toBe(card('w1').key);
    });

    it('steps through every card column by column with Tab and back with Shift+Tab', () => {
      select('w1');
      const visited = [selected()];
      for (let i = 0; i < 4; i++) {
        expect(press('Tab').defaultPrevented).toBe(true);
        visited.push(selected());
      }
      expect(visited).toEqual(['w1', 'w2', 'r1', 'r2', 'w1'].map((n) => card(n).key));
      press('Tab', true);
      expect(selected()).toBe(card('r2').key);
    });

    it('moves focus with the selection, so Enter acts on the selected card', () => {
      card('w1').el.focus();
      press('Enter', false, document.activeElement!);
      expect(selected()).toBe(card('w1').key);
      press('ArrowRight');
      expect(document.activeElement).toBe(card('r1').el);
      press('Enter', false, document.activeElement!);
      expect(fixture.componentInstance['selectedCard']()).toBeNull();
      expect(card('w1').el.getAttribute('aria-pressed')).toBe('false');
    });

    it('keeps moving the focus after Enter unselects, until Escape lets go', () => {
      card('w1').el.focus();
      press('Enter', false, document.activeElement!);
      press('Enter', false, document.activeElement!);
      expect(fixture.componentInstance['selectedCard']()).toBeNull();

      expect(press('ArrowDown').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(card('w2').el);
      expect(press('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(card('r1').el);
      expect(fixture.componentInstance['selectedCard']()).toBeNull();

      press('Escape');
      expect(document.activeElement).not.toBe(card('r1').el);
      expect(el().querySelectorAll('.source, .highlighted, .dimmed').length).toBe(0);
      expect(press('ArrowDown').defaultPrevented).toBe(false);
    });

    it('leaves no highlight behind on Escape after moving off a focused card', () => {
      card('w1').el.focus();
      select('w1');
      press('ArrowRight');
      press('Escape');
      expect(el().querySelectorAll('.source, .highlighted, .dimmed').length).toBe(0);
    });

    it('ignores keys typed into a form field', () => {
      select('w1');
      const input = document.createElement('input');
      document.body.appendChild(input);
      expect(press('ArrowDown', false, input).defaultPrevented).toBe(false);
      expect(selected()).toBe(card('w1').key);
      input.remove();
    });
  });

  for (const endEvent of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    it(`keeps highlighting under the pointer when a drag ends with ${endEvent}`, () => {
      const card = el().querySelector<SVGGElement>('.card')!;
      const svg = el().querySelector('svg')!;
      const size = fixture.componentInstance['size']();
      const box = fixture.componentInstance['layout']().cards[0];
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, size.w, size.h));
      const position = { clientX: box.x + 10, clientY: box.y + 10 };
      card.dispatchEvent(new Event('focus'));
      card.dispatchEvent(new Event('pointerenter'));
      fixture.detectChanges();
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);

      const down = new MouseEvent('pointerdown', { ...position, bubbles: true, cancelable: true });
      card.dispatchEvent(down);
      fixture.detectChanges();
      expect(down.defaultPrevented).toBe(true);
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);

      svg.dispatchEvent(
        new MouseEvent('pointermove', {
          clientX: position.clientX + 30,
          clientY: position.clientY + 20,
        }),
      );
      fixture.detectChanges();
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);

      svg.dispatchEvent(
        new MouseEvent(endEvent, {
          clientX: position.clientX + 30,
          clientY: position.clientY + 20,
        }),
      );
      fixture.detectChanges();
      expect(fixture.componentInstance['panning']()).toBe(false);
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(
        endEvent === 'pointercancel' ? 0 : 1,
      );

      card.dispatchEvent(new Event('pointerenter'));
      fixture.detectChanges();
      expect(el().querySelectorAll('.wire.highlighted').length).toBe(1);
      card.dispatchEvent(new Event('pointerleave'));
      fixture.detectChanges();
      expect(el().querySelectorAll('.highlighted, .dimmed').length).toBe(0);
    });
  }

  /**
   * A function no node claims was created at the origin and then skipped by
   * the placement loop, so every one of them stacked on top of the first
   * node's header. They get a column of their own instead.
   */
  it('keeps a function with no node off the origin', async () => {
    fixture.componentRef.setInput('graph', NODELESS);
    await fixture.whenStable();

    const cards = [...el().querySelectorAll('rect[rx="10"]')];
    const atOrigin = cards.filter(
      (c) => c.getAttribute('x') === '0' && c.getAttribute('y') === '0',
    );
    expect(atOrigin.length).toBe(0);

    // No two cards share a position. Cards in different columns share a row, so
    // the pair is what says they are not stacked.
    const at = cards.map((c) => `${c.getAttribute('x')},${c.getAttribute('y')}`);
    expect(new Set(at).size).toBe(at.length);

    // The two nodeless ones sit together in a column of their own.
    const nodeless = cards.filter((c) => Number(c.getAttribute('x')) > 250);
    expect(nodeless.length).toBe(2);
    expect(new Set(nodeless.map((c) => c.getAttribute('x'))).size).toBe(1);

    // The column says what it is rather than rendering an empty label.
    const drawn = [...el().querySelectorAll('text')].map((t) => t.textContent!.trim());
    expect(drawn).toContain('NO NODE');
  });

  it('counts only real nodes in the summary', async () => {
    fixture.componentRef.setInput('graph', NODELESS);
    await fixture.whenStable();
    // The summary is the svg's accessible name, not drawn text.
    const label = el().querySelector('svg')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('on 1 nodes');
  });
});

interface Pt {
  x: number;
  y: number;
}

/**
 * The drawn lines, read back out of the DOM: each one's path sampled along
 * its length, where its arrowhead touches, and which way it points there.
 * Paths use M, L, Q and C only, and the tip is the arrowhead polygon's first
 * point where there is one, else the end of the path.
 */
function drawnWires(
  root: HTMLElement,
): { samples: Pt[]; start: Pt; tip: Pt; dir: number; d: string }[] {
  const paths = [...root.querySelectorAll('svg > g path')].filter((p) => !p.closest('defs'));
  return paths.map((p) => {
    const d = p.getAttribute('d') ?? '';
    const nums = (s: string) =>
      s
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
    const samples: Pt[] = [];
    let at: Pt = { x: 0, y: 0 };
    let before: Pt = at;
    for (const [, cmd, args] of d.matchAll(/([MLQC])([^MLQC]*)/g)) {
      const n = nums(args);
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
      if (cmd === 'M') {
        at = pts[0];
        samples.push(at);
        continue;
      }
      const ctrl = [at, ...pts];
      for (let s = 1; s <= 50; s++) {
        const t = s / 50;
        // De Casteljau over however many points the command carries.
        let row = ctrl;
        while (row.length > 1) {
          row = row.slice(1).map((q, i) => ({
            x: row[i].x + (q.x - row[i].x) * t,
            y: row[i].y + (q.y - row[i].y) * t,
          }));
        }
        samples.push(row[0]);
      }
      before = ctrl[ctrl.length - 2];
      at = pts[pts.length - 1];
    }
    const head = p.parentElement?.querySelector('polygon')?.getAttribute('points');
    const tip = head ? (([x, y]) => ({ x, y }))(head.split(' ')[0].split(',').map(Number)) : at;
    return { samples, start: samples[0], tip, dir: Math.sign(at.x - before.x), d };
  });
}

function drawnCards(root: HTMLElement) {
  return [...root.querySelectorAll('rect[rx="10"]')].map((r) => ({
    x: Number(r.getAttribute('x')),
    y: Number(r.getAttribute('y')),
    w: Number(r.getAttribute('width')),
    h: Number(r.getAttribute('height')),
  }));
}

type Box = ReturnType<typeof drawnCards>[number];
const inY = (c: Box, y: number) => y > c.y && y < c.y + c.h;

/** The card an arrowhead points into: within an arrowhead and a half of the
 *  edge it faces, on its side of that edge. */
function target(cards: Box[], tip: Pt, dir: number): Box | undefined {
  return cards.find((c) => {
    if (!inY(c, tip.y)) return false;
    const gap = dir > 0 ? c.x - tip.x : tip.x - (c.x + c.w);
    return gap >= -0.5 && gap <= 12;
  });
}

describe('FlowDiagram, as drawn', () => {
  async function draw(graph: MxlGraph): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(FlowDiagram);
    fixture.componentRef.setInput('graph', graph);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * A reader drawn left of its writer: the old curve ended left of the reader
   * travelling left, so its arrowhead pointed away from the card it was for.
   */
  it('points every arrowhead into a card', async () => {
    for (const g of [LEFTWARD, PLAIN, ACROSS, PAIR]) {
      const root = await draw(g);
      const cards = drawnCards(root);
      for (const w of drawnWires(root)) {
        expect(
          target(cards, w.tip, w.dir),
          `arrow at ${w.tip.x},${w.tip.y} of ${w.d}`,
        ).toBeDefined();
      }
    }
  });

  /** A read from n01 to n03 ran through n02's cards, so it seemed to start at
   *  a writer it has nothing to do with. */
  it('runs no line through a card other than its own two', async () => {
    for (const g of [ACROSS, LEFTWARD, PLAIN]) {
      const root = await draw(g);
      const cards = drawnCards(root);
      for (const w of drawnWires(root)) {
        const from = cards.find((c) => Math.abs(c.x + c.w - w.start.x) < 0.5 && inY(c, w.start.y));
        const to = target(cards, w.tip, w.dir);
        for (const c of cards) {
          if (c === from || c === to) continue;
          const inside = w.samples.find(
            (p) =>
              p.x > c.x + 0.5 && p.x < c.x + c.w - 0.5 && p.y > c.y + 0.5 && p.y < c.y + c.h - 0.5,
          );
          expect(inside, `${w.d} runs through the card at ${c.x},${c.y}`).toBeUndefined();
        }
      }
    }
  });

  /** The picture and sound of one writer read by one function were one curve
   *  drawn twice. */
  it('draws two reads between the same functions apart', async () => {
    const wires = drawnWires(await draw(PAIR));
    expect(wires.length).toBe(2);
    expect(wires[0].d).not.toBe(wires[1].d);
  });

  /**
   * The frame was as tall in screen pixels as the drawing is in its own units,
   * while the width scaled the drawing down to fit, so a wide cluster sat in a
   * band of white several times its height. The frame follows the drawing's
   * proportions instead.
   */
  it('sizes the frame by the drawing, not by a fixed height', async () => {
    const svg = (await draw(ACROSS)).querySelector('svg[viewBox]') as SVGSVGElement;
    const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect(svg.style.height).toBe('');
    expect(svg.style.aspectRatio.replace(/\s/g, '')).toBe(`${w}/${h}`);
  });

  it('draws a redundancy set: members, output, legs and state', async () => {
    const root = await draw(LOCAL_LEG);
    const text = [...root.querySelectorAll('text')].map((t) => t.textContent!.trim());
    expect(text.some((t) => t.includes('engine a'))).toBe(true);
    expect(text.some((t) => t.includes('engine b'))).toBe(true);
    expect(text).toContain('sf-video');

    const legs = root.querySelectorAll('g[data-kind="leg"]');
    expect(legs.length).toBe(2);
    const titles = [...legs].map((g) => g.querySelector('title')!.textContent!);
    expect(titles.some((t) => t.includes('no mirror') && t.includes('shared memory'))).toBe(true);
    expect(titles.some((t) => t.includes('mirror Ready') && t.includes('across the fabric'))).toBe(
      true,
    );

    const output = root.querySelector('g[data-kind="output"]')!;
    expect(output.querySelector('circle')!.getAttribute('fill')).toBe('#c8f169');
  });

  it('tints a set member or output it is traced from in teal', () => {
    const setFixture = TestBed.createComponent(FlowDiagram);
    setFixture.componentRef.setInput('graph', LOCAL_LEG);
    setFixture.detectChanges();
    const root = setFixture.nativeElement as HTMLElement;
    for (const kind of ['member', 'output']) {
      const card = root.querySelector(`g[data-kind="${kind}"]`)!;
      card.dispatchEvent(new Event('pointerenter'));
      setFixture.detectChanges();
      expect(card.querySelector('rect')!.getAttribute('fill')).toBe('var(--diagram-teal-tint)');
      card.dispatchEvent(new Event('pointerleave'));
    }
  });

  it('marks a broken leg and a degraded set', async () => {
    const root = await draw(DEGRADED);
    const broken = [...root.querySelectorAll('g[data-kind="leg"] path')].filter(
      (p) => p.getAttribute('stroke-dasharray') === '2 3',
    );
    expect(broken.length).toBe(1);
    const output = root.querySelector('g[data-kind="output"]')!;
    // Served from the member that is left, so degraded rather than down.
    expect(output.querySelector('circle')!.getAttribute('fill')).toBe('#f05012');
    expect(output.querySelector('title')!.textContent).toContain('MemberMissing');
  });

  /**
   * A line the legend does not show is a line a visitor cannot read. A local
   * read of an output not merged on its node yet is drawn grey and dashed,
   * and the legend had only the orange dashed line for a remote one.
   */
  it('explains every line it draws with an entry drawn the same way', async () => {
    const style = (el: Element) =>
      ['stroke', 'stroke-width', 'stroke-dasharray'].map((a) => el.getAttribute(a)).join('|');
    for (const g of [PLAIN, LOCAL_LEG, DEGRADED, READER_OFF_MERGE]) {
      const root = await draw(g);
      const legend = new Set([...root.querySelectorAll('figcaption line')].map(style));
      // A pipe is drawn over a line of its own, and has its own entry.
      for (const path of root.querySelectorAll('g.wire path:not(.pipe, .grains)')) {
        expect(legend, `${path.closest('g')!.querySelector('title')!.textContent}`).toContain(
          style(path),
        );
      }
    }
  });

  /** The reader waits on the same node as the output card it reads, which
   *  is a local line, grey, dashed while the output is not merged there. */
  it('has an entry for a local read waiting on a merge, in the grey it is drawn', async () => {
    const root = await draw(READER_OFF_MERGE);
    const waiting = root.querySelector(
      'g.wire[data-from="output:sf-video:n02"][data-to$="late-monitor@n02"] path',
    )!;
    expect(waiting.getAttribute('stroke')).toBe('#9aa0a6');
    expect(waiting.getAttribute('stroke-dasharray')).toBe('5 4');
    const entry = [...root.querySelectorAll('figcaption span')].find((s) =>
      s.textContent!.includes('same node'),
    );
    expect(entry).toBeDefined();
    const line = entry!.querySelector('line')!;
    expect(line.getAttribute('stroke')).toBe(waiting.getAttribute('stroke'));
    expect(line.getAttribute('stroke-dasharray')).toBe(waiting.getAttribute('stroke-dasharray'));
  });

  /** The dots are the flow's frames, so how many a line carries says how
   *  fast the flow runs: ten times the rate, ten times the dots. */
  it('draws a served flow as a pipe whose dots are as dense as its frame rate', async () => {
    const at = (rate: number): MxlGraph => ({
      ...PLAIN,
      flows: PLAIN.flows.map((f) => ({ ...f, rate })),
    });
    const gap = (root: HTMLElement) =>
      root
        .querySelector('g.wire[data-to$="far-viewer@n02"] .grains')!
        .getAttribute('stroke-dasharray');

    const slow = await draw(at(24));
    const fast = await draw(at(240));
    expect(gap(slow)).toBe('0 60');
    expect(gap(fast)).toBe('0 6');
    // Every dot moves one gap per period, so all rates move at one speed.
    const grains = slow.querySelector<SVGPathElement>('g.wire[data-to$="far-viewer@n02"] .grains')!;
    expect(grains.style.getPropertyValue('--grain-gap')).toBe('60px');
    expect(grains.style.animationDuration).toBe('1.25s');
    expect(slow.querySelector('g.wire[data-to$="far-viewer@n02"] .pipe')).not.toBeNull();
    expect(slow.querySelector('g.wire[data-to$="far-viewer@n02"] title')!.textContent).toContain(
      'at 24 fps',
    );
    // Nothing moves through a read still waiting on its mirror.
    expect(slow.querySelector('g.wire[data-to$="waiting-viewer@n03"] .grains')).toBeNull();
    expect(
      [...slow.querySelectorAll('figcaption span')].some((s) =>
        s.textContent!.includes('one dot per frame'),
      ),
    ).toBe(true);
  });

  /** Audio has no frames, so its line says how many channels it carries:
   *  one bar per channel in each burst, bursts moving at the frames' speed. */
  it('draws a served audio flow with one bar per channel', async () => {
    const withChannels = (channels: number): MxlGraph => ({
      ...PLAIN,
      flows: PLAIN.flows.map((f) => ({ ...f, channels })),
    });
    const wire = (root: HTMLElement, to: string) => root.querySelector(`g.wire[data-to$="${to}"]`)!;
    const bars = (root: HTMLElement) =>
      [...wire(root, 'far-viewer@n02').querySelectorAll<SVGPathElement>('.bars')].flatMap((p) =>
        p
          .getAttribute('stroke-dasharray')!
          .split(' ')
          .filter((_, i) => i % 2 === 0)
          .map(Number)
          .filter((dash) => dash > 0),
      );

    const stereo = await draw(withChannels(2));
    const eight = await draw(withChannels(8));
    // Four bursts to a repeat, each with its own heights, and every bar drawn
    // in three slivers.
    expect(bars(stereo).length).toBe(2 * 4 * 3);
    expect(bars(eight).length).toBe(8 * 4 * 3);

    const first = wire(eight, 'far-viewer@n02').querySelector<SVGPathElement>('.bars')!;
    expect(first.style.getPropertyValue('--grain-gap')).toBe('576px');
    expect(first.style.animationDuration).toBe('12s');
    expect(wire(eight, 'far-viewer@n02').querySelector('.pipe')).not.toBeNull();
    expect(wire(eight, 'far-viewer@n02').querySelector('title')!.textContent).toContain(
      '8 channels',
    );
    // Nothing moves through a read still waiting on its mirror.
    expect(wire(eight, 'waiting-viewer@n03').querySelector('.bars, .pipe')).toBeNull();
    expect(
      [...eight.querySelectorAll('figcaption span')].some((s) =>
        s.textContent!.includes('one bar per audio channel'),
      ),
    ).toBe(true);
  });

  /** A burst reads as a waveform: it rises from a short bar to at least one
   *  tall one and falls back, and differs from the next burst. */
  it('shapes every audio burst like a waveform', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const SHORT = 0;
    const TALL = 2;

    expect(burstTiers(1, random)).toEqual([TALL]);
    for (let run = 0; run < 50; run++) {
      expect([...burstTiers(2, random)].sort()).toEqual([SHORT, TALL]);
      for (const n of [3, 8, 16]) {
        const tiers = burstTiers(n, random);
        expect(tiers.length).toBe(n);
        expect(tiers[0]).toBe(SHORT);
        expect(tiers[n - 1]).toBe(SHORT);
        expect(tiers).toContain(TALL);
      }
    }
    const shapes = new Set(Array.from({ length: 10 }, () => burstTiers(8, random).join()));
    expect(shapes.size).toBeGreaterThan(1);
    const stereo = new Set(Array.from({ length: 10 }, () => burstTiers(2, random).join()));
    expect(stereo.size).toBe(2);
  });

  it('draws no dots and no dot legend for a flow without a frame rate', async () => {
    const root = await draw(PLAIN);
    expect(root.querySelector('.grains, .pipe')).toBeNull();
    expect(
      [...root.querySelectorAll('figcaption span')].some((s) =>
        s.textContent!.includes('one dot per frame'),
      ),
    ).toBe(false);
  });
});
