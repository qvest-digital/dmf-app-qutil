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

  it('offers no preview for a format with no route to a browser', () => {
    mount(UNKNOWN);

    expect(previewButton()).toBeNull();
    expect(controller.requests()).toHaveLength(0);
  });
});
