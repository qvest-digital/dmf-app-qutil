import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DetailMirror, OperatorFlow } from '../../core/api/models';
import { PreviewController } from '../preview/preview-controller';
import { OperatorFlowRow } from './operator-flow-row';

const AUDIO: OperatorFlow = {
  id: 'a0d10000-0000-0000-0000-000000000001',
  label: 'audio-testsrc',
  format: 'audio',
  // The width the card is opened with comes from the flow definition, not from
  // the row's own summary field.
  detail: { media: { channels: 4 } },
};

const DATA: OperatorFlow = {
  id: 'c3000000-0000-0000-0000-000000000001',
  label: 'srt-ingest-1-anc',
  format: 'data',
};

const VIDEO: OperatorFlow = {
  id: 'b2000000-0000-0000-0000-000000000001',
  label: 'writer-mxl-1',
  format: 'video',
  grouphint: 'srt-ingest-1:Video',
};

const UNKNOWN: OperatorFlow = {
  id: 'deadbeef-0000-0000-0000-000000000001',
  label: 'mystery-flow',
  format: 'mux',
};

/**
 * The Preview button is what grows the preview column, so what it hands the
 * controller has to be right: the flow's own channel count decides how many pairs
 * the card offers, and a format with no route to a browser must not open a card
 * at all.
 */
describe('OperatorFlowRow preview button', () => {
  let fixture: ComponentFixture<OperatorFlowRow>;
  let controller: PreviewController;

  function mount(flow: OperatorFlow): void {
    fixture = TestBed.createComponent(OperatorFlowRow);
    fixture.componentRef.setInput('flow', flow);
    fixture.detectChanges();
  }

  function previewButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.of-prev');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OperatorFlowRow] });
    controller = TestBed.inject(PreviewController);
  });

  afterEach(() => {
    for (const request of controller.requests()) controller.close(request.id);
  });

  it('adds the flow to the column, with its channel count', () => {
    mount(AUDIO);
    previewButton()!.click();

    expect(controller.requests()).toEqual([
      { id: AUDIO.id, label: 'audio-testsrc', format: 'audio', channels: 4 },
    ]);
  });

  it('leaves the column alone when the same flow is asked for twice', () => {
    mount(AUDIO);
    previewButton()!.click();
    previewButton()!.click();

    expect(controller.requests()).toHaveLength(1);
  });

  it('previews an ANC data flow, which is read rather than played', () => {
    mount(DATA);
    previewButton()!.click();

    expect(controller.requests()[0].format).toBe('data');
  });

  /**
   * The row previews the flow it names and nothing else. Opening the picture's
   * sound from here as well left no way to watch a grouped picture alone; the
   * pair is the group head's button.
   */
  it('previews a grouped video flow alone', () => {
    mount(VIDEO);
    previewButton()!.click();

    expect(controller.requests()).toEqual([
      { id: VIDEO.id, label: 'writer-mxl-1', format: 'video', channels: 2 },
    ]);
  });

  it('offers no preview for a format with no route to a browser', () => {
    mount(UNKNOWN);

    expect(previewButton()).toBeNull();
    expect(controller.requests()).toHaveLength(0);
  });
});

/**
 * The pill's class is what colours it, and the colour is what an operator reads
 * the format off at a glance. A format that falls through to the wrong pill
 * claims a data flow is video.
 */
describe('OperatorFlowRow format badge', () => {
  let fixture: ComponentFixture<OperatorFlowRow>;

  function badgeClasses(flow: OperatorFlow): string[] {
    fixture = TestBed.createComponent(OperatorFlowRow);
    fixture.componentRef.setInput('flow', flow);
    fixture.detectChanges();
    const badge: HTMLElement = fixture.nativeElement.querySelector('.badge:not(.fabric)');
    return [...badge.classList];
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OperatorFlowRow] });
  });

  it('gives a data flow its own pill rather than the video one', () => {
    const classes = badgeClasses(DATA);

    expect(classes).toContain('data');
    expect(classes).not.toContain('video');
  });

  it('keeps the video and audio pills on their own formats', () => {
    expect(badgeClasses(VIDEO)).toContain('video');
    expect(badgeClasses(AUDIO)).toContain('audio');
  });

  it('falls back to the video pill for a format it does not know', () => {
    expect(badgeClasses(UNKNOWN)).toContain('video');
  });
});

/**
 * What moves a flow off the node that holds it, read where an operator is
 * already looking. The value is the mirror's, because that is the one the
 * control plane resolved: a receiver's provider is a request and defaults to
 * `auto`.
 */
describe('OperatorFlowRow fabric badge', () => {
  let fixture: ComponentFixture<OperatorFlowRow>;

  function badges(mirrors: DetailMirror[]): string[] {
    fixture = TestBed.createComponent(OperatorFlowRow);
    fixture.componentRef.setInput('flow', { ...VIDEO, detail: { mirrors } });
    fixture.detectChanges();
    return Array.from(fixture.nativeElement.querySelectorAll('.badge.fabric')).map((b) =>
      ((b as HTMLElement).textContent ?? '').trim(),
    );
  }

  function mirror(provider: string, name = provider): DetailMirror {
    return { name, provider, targetNode: name };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OperatorFlowRow] });
  });

  it.each([
    ['verbs', 'RoCEv2'],
    ['efa', 'EFA'],
    ['tcp', 'TCP'],
  ])('reads the provider %p as %p', (provider, shown) => {
    expect(badges([mirror(provider)])).toEqual([shown]);
  });

  /** Nothing crosses a fabric, so naming one would be an invention. */
  it('shows none for a flow nothing mirrors', () => {
    expect(badges([])).toEqual([]);
  });

  /**
   * `auto` asks the control plane to resolve a provider rather than naming one.
   * A mirror still carrying it says nothing about what moves the grains.
   */
  it.each(['auto', '', 'something-else'])('shows none for the provider %p', (provider) => {
    expect(badges([mirror(provider, 'm1')])).toEqual([]);
  });

  it('names one transport once, however many nodes it carries the flow to', () => {
    expect(badges([mirror('verbs', 'm1'), mirror('verbs', 'm2')])).toEqual(['RoCEv2']);
  });

  /** Two nodes can resolve differently, and one must not stand for the other. */
  it('names both where a flow is mirrored over two transports', () => {
    expect(badges([mirror('verbs', 'm1'), mirror('tcp', 'm2')])).toEqual(['RoCEv2', 'TCP']);
  });
});

/**
 * The id is what every kubectl and every log line is keyed on, and it is 36
 * characters of hex nobody retypes correctly.
 */
describe('OperatorFlowRow id copy', () => {
  let fixture: ComponentFixture<OperatorFlowRow>;
  let written: string[];

  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    TestBed.configureTestingModule({ imports: [OperatorFlowRow] });
    fixture = TestBed.createComponent(OperatorFlowRow);
    fixture.componentRef.setInput('flow', VIDEO);
    fixture.detectChanges();
  });

  function copyButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.of-meta .cp');
  }

  /** The write and the handler resuming after it are two ticks apart. */
  function settled(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve));
  }

  it('copies the flow id, not the whole meta line', async () => {
    copyButton().click();
    await settled();

    expect(written).toEqual([VIDEO.id]);
  });

  /** Nothing else confirms it: the clipboard cannot be read back. */
  it('marks the button once the id is on the clipboard', async () => {
    expect(copyButton().classList).not.toContain('done');

    copyButton().click();
    await settled();
    fixture.detectChanges();

    expect(copyButton().classList).toContain('done');
  });
});
