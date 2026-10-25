import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow, RedundancySet } from '../../core/api/models';
import { OperatorFlowList } from './operator-flow-list';

const VIDEO: OperatorFlow = {
  id: 'b2000000-0000-4000-8000-000000000001',
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

  it('renders the flows of one group inside one group box', () => {
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

  /**
   * The head names the group and carries its combined preview, so it belongs to
   * a box that came from a group and to no other.
   */
  it('heads a group box with the group name', () => {
    mount([VIDEO, AUDIO]);

    expect(groups()[0].querySelector('.fg-name')?.textContent?.trim()).toBe('srt-ingest-1');
  });

  it('gives an ungrouped flow no head', () => {
    mount([LONE]);

    expect(groups()[0].querySelector('.fg-head')).toBeNull();
  });

  describe('with a redundancy set', () => {
    const MEMBER_A: OperatorFlow = {
      id: '5fd00000-0000-4000-8000-0000000000a1',
      label: 'program-a',
      format: 'video',
      grouphint: 'prog:Video',
    };
    const MEMBER_B: OperatorFlow = {
      id: '5fd00000-0000-4000-8000-0000000000b1',
      label: 'program-b',
      format: 'video',
      grouphint: 'prog-b:Video',
    };
    const SET: RedundancySet = {
      name: 'p-show.prog-video',
      members: [MEMBER_A.id, MEMBER_B.id],
      output: { id: '5fd00000-0000-4000-8000-0000000000c1', label: 'program', format: 'video' },
    };

    function mountWithSet(flows: OperatorFlow[]): void {
      fixture = TestBed.createComponent(OperatorFlowList);
      fixture.componentRef.setInput('flows', flows);
      fixture.componentRef.setInput('sets', [SET]);
      fixture.detectChanges();
    }

    function allLabels(): string[] {
      return Array.from(fixture.nativeElement.querySelectorAll('mv-operator-flow-row')).map((row) =>
        ((row as HTMLElement).querySelector('.name')?.textContent ?? '').trim(),
      );
    }

    /**
     * Not the members and the output as three more entries: one box for the
     * set, holding them, and the group-hint boxes as they were.
     */
    it('lists the set as one box holding its output and its members', () => {
      mountWithSet([VIDEO, MEMBER_B, AUDIO, MEMBER_A, LONE]);

      expect(groups()).toHaveLength(3);
      expect(groups()[0].classList).toContain('rs-bundle');
      expect(groups()[0].querySelector('.rs-name')?.textContent?.trim()).toBe(SET.name);
      expect(labelsIn(groups()[1])).toEqual([VIDEO.label, AUDIO.label]);
      expect(labelsIn(groups()[2])).toEqual([LONE.label]);
    });

    it('shows a member inside its set and outside none', () => {
      mountWithSet([MEMBER_A, MEMBER_B, LONE]);

      const labels = allLabels();
      expect(labels.filter((l) => l.includes('program-a'))).toHaveLength(1);
      expect(labels.filter((l) => l.includes('program-b'))).toHaveLength(1);
      expect(labels.filter((l) => l.startsWith('output'))).toHaveLength(1);
    });

    it('says so when the sets could not be listed', () => {
      fixture = TestBed.createComponent(OperatorFlowList);
      fixture.componentRef.setInput('flows', [LONE]);
      fixture.componentRef.setInput('setsError', 'cannot list MxlFlowRedundancySets: 403');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.gen-errors').textContent).toContain(
        'cannot list MxlFlowRedundancySets: 403',
      );
      expect(labelsIn(groups()[0])).toEqual([LONE.label]);
    });

    it('counts the sets beside the flows', () => {
      mountWithSet([MEMBER_A, MEMBER_B]);

      expect(fixture.nativeElement.querySelector('.of-count').textContent).toBe(
        '(2, 1 redundancy set)',
      );
    });
  });

  it('says so when the operator knows no flow at all', () => {
    mount([]);

    expect(groups()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.flow.empty')).not.toBeNull();
  });
});
