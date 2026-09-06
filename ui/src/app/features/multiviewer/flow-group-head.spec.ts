import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow } from '../../core/api/models';
import { FlowGroup } from '../preview/flow-groups';
import { PreviewController } from '../preview/preview-controller';
import { FlowGroupHead } from './flow-group-head';

const VIDEO: OperatorFlow = {
  id: 'b2000000-0000-0000-0000-000000000001',
  label: 'srt-ingest-1-video',
  format: 'video',
  grouphint: 'srt-ingest-1:Video',
};

const AUDIO: OperatorFlow = {
  id: 'aea7b9e9-1e5b-4333-9ac4-8689053a77de',
  label: 'srt-ingest-1-audio',
  format: 'audio',
  grouphint: 'srt-ingest-1:Audio',
  detail: { media: { channels: 8 } },
};

const DATA: OperatorFlow = {
  id: 'c3000000-0000-0000-0000-000000000001',
  label: 'srt-ingest-1-anc',
  format: 'data',
  grouphint: 'srt-ingest-1:Ancillary Data',
};

/**
 * The head is the only place that can see a group's picture and its sound at
 * once, so it is where the combined preview is offered.
 */
describe('FlowGroupHead', () => {
  let fixture: ComponentFixture<FlowGroupHead>;
  let controller: PreviewController;

  function mount(group: FlowGroup): void {
    fixture = TestBed.createComponent(FlowGroupHead);
    fixture.componentRef.setInput('group', group);
    fixture.detectChanges();
  }

  function button(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.fg-prev');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [FlowGroupHead] });
    controller = TestBed.inject(PreviewController);
  });

  afterEach(() => {
    for (const request of controller.requests()) controller.close(request.id);
  });

  it('names the group its producer tagged the flows into', () => {
    mount({ name: 'srt-ingest-1', video: VIDEO, audio: AUDIO });

    expect(fixture.nativeElement.querySelector('.fg-name').textContent.trim()).toBe('srt-ingest-1');
  });

  /**
   * One path on the media server carries both, so the picture is decoded and
   * encoded once. The width comes from the audio flow, whatever the picture
   * states, because it is what decides how many pairs the card connects to.
   */
  it('opens the picture and the sound as one card', () => {
    mount({ name: 'srt-ingest-1', video: VIDEO, audio: AUDIO, data: DATA });
    button().click();

    expect(controller.requests()).toEqual([
      {
        id: VIDEO.id,
        label: 'srt-ingest-1-video + srt-ingest-1-audio',
        format: 'video',
        channels: 8,
        audioId: AUDIO.id,
      },
    ]);
  });

  it('leaves the column alone when the same pair is asked for twice', () => {
    mount({ name: 'srt-ingest-1', video: VIDEO, audio: AUDIO });
    button().click();
    button().click();

    expect(controller.requests()).toHaveLength(1);
  });

  /** There is nothing to combine, and a button that opened the picture alone
   *  would duplicate the row's own. */
  it.each([
    ['no sound', { name: 'lone', video: VIDEO } as FlowGroup],
    ['no picture', { name: 'lone', audio: AUDIO } as FlowGroup],
    ['neither', { name: 'lone', data: DATA } as FlowGroup],
  ])('disables the preview for a group with %s', (_name, group) => {
    mount(group);
    button().click();

    expect(button().disabled).toBe(true);
    expect(controller.requests()).toEqual([]);
  });
});
