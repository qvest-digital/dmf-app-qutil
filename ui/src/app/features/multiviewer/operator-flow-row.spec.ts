import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow } from '../../core/api/models';
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
    const badge: HTMLElement = fixture.nativeElement.querySelector('.badge');
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

