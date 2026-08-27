import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow } from '../../core/api/models';
import { OperatorFlowList } from './operator-flow-list';

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
};

const LONE: OperatorFlow = {
  id: 'deadbeef-0000-0000-0000-000000000001',
  label: 'writer-mxl-1',
  format: 'video',
};

/**
 * The stylesheet joins a group's boxes with the position of each row inside its
 * `.flow-group`. That only holds while the group's rows are the group element's
 * own children, which is what these assert.
 */
describe('OperatorFlowList grouping', () => {
  let fixture: ComponentFixture<OperatorFlowList>;

  function mount(flows: OperatorFlow[]): void {
    fixture = TestBed.createComponent(OperatorFlowList);
    fixture.componentRef.setInput('flows', flows);
    fixture.detectChanges();
  }

  function groups(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.flow-group'));
  }

  function labelsIn(group: HTMLElement): string[] {
    return Array.from(group.querySelectorAll(':scope > mv-operator-flow-row .name')).map(
      (n) => (n.textContent ?? '').trim().split(/\s+/)[0],
    );
  }

  it('renders the flows of one source inside one group', () => {
    mount([AUDIO, LONE, VIDEO]);

    expect(groups()).toHaveLength(2);
    expect(labelsIn(groups()[0])).toEqual([VIDEO.label, AUDIO.label]);
    expect(labelsIn(groups()[1])).toEqual([LONE.label]);
  });

  it('gives an ungrouped flow a group of its own, so its box keeps every corner', () => {
    mount([LONE]);

    expect(groups()).toHaveLength(1);
    expect(groups()[0].querySelectorAll('.flow')).toHaveLength(1);
  });

  it('says so when the operator knows no flow at all', () => {
    mount([]);

    expect(groups()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.flow.empty')).not.toBeNull();
  });
});
