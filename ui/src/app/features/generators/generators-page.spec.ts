import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Generator, GeneratorsResponse, OperatorFlowsResponse } from '../../core/api/models';
import { GeneratorsPage } from './generators-page';

function generator(over: Partial<Generator> = {}): Generator {
  return {
    name: 'generator-bars-1-7f3a',
    namespace: 'production-demo-app',
    className: 'mxl-writer',
    phase: 'Bound',
    ready: true,
    video: {
      id: '3f2c8a1e-1111-4222-8333-444455556666',
      pattern: 'smpte',
      frameWidth: 1296,
      frameHeight: 720,
      grainRate: '30000/1001',
    },
    audio: null,
    ...over,
  };
}

function response(over: Partial<GeneratorsResponse> = {}): GeneratorsResponse {
  return {
    namespace: 'production-demo-app',
    className: 'mxl-writer',
    enabled: true,
    maxCopies: 16,
    providers: ['auto', 'tcp'],
    ttls: ['1h', 'none'],
    patterns: ['smpte'],
    animated: [],
    frameSizes: [{ width: 1296, height: 720 }],
    grainRates: [{ numerator: 30000, denominator: 1001 }],
    sampleRates: [48000],
    generators: [],
    ...over,
  };
}

/**
 * The page lists only what it booked -- the aggregator selects by its own label,
 * so the chart's writer claims are never here and cannot be deleted from here.
 */
describe('GeneratorsPage', () => {
  let fixture: ComponentFixture<GeneratorsPage>;
  let http: HttpTestingController;

  function rows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.flow:not(.empty)'));
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  const FLOWS: OperatorFlowsResponse = {
    flows: [
      { id: 'd4d00000-0000-4000-8000-000000000001', label: 'MXL-1', format: 'video' },
      { id: 'aea7b9e9-1e5b-4333-9ac4-8689053a77de', label: 'SRT audio', format: 'audio' },
    ],
  };

  async function load(body: GeneratorsResponse): Promise<void> {
    TestBed.configureTestingModule({
      imports: [GeneratorsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GeneratorsPage);
    fixture.detectChanges();
    // Both polls start on a timer(0), so the first request is a macrotask away.
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.match((req) => req.url === '/api/generators').forEach((req) => req.flush(body));
    // The form asks for ids as soon as it mounts.
    http
      .match((req) => req.url === '/api/generators/flow-ids')
      .forEach((req) =>
        req.flush({ videoFlowId: 'aaaaaaaa-1111-4222-8333-444455556666', audioFlowId: 'b' }),
      );
    // The reader form's flow picker.
    http.match((req) => req.url === '/api/operator-flows').forEach((req) => req.flush(FLOWS));
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((req) => req.cancelled || req.flush({}));
    http.verify();
  });

  it('says so when nothing is booked, and why the demo writers are absent', async () => {
    await load(response());
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('The four demo writers come from the chart');
  });

  it('shows a booked generator with what it produces', async () => {
    await load(response({ generators: [generator()] }));

    expect(rows()).toHaveLength(1);
    expect(text()).toContain('generator-bars-1-7f3a');
    expect(text()).toContain('smpte');
    expect(text()).toContain('1296x720');
    expect(text()).toContain('3f2c8a1e-1111-4222-8333-444455556666');
    expect(fixture.nativeElement.querySelector('.dot.live')).toBeTruthy();
  });

  it('reports why a claim has not gone ready rather than calling it pending', async () => {
    await load(
      response({
        generators: [
          generator({
            phase: 'Pending',
            ready: false,
            reachable: { type: 'Reachable', status: 'False', reason: 'WaitingForProvisioner' },
          }),
        ],
      }),
    );
    expect(text()).toContain('WaitingForProvisioner');
    expect(fixture.nativeElement.querySelector('.dot.live')).toBeNull();
  });

  it('marks a failed claim bad', async () => {
    await load(
      response({
        generators: [
          generator({
            phase: 'Failed',
            ready: false,
            reachable: { type: 'Reachable', status: 'False', reason: 'ProvisionFailed' },
          }),
        ],
      }),
    );
    expect(fixture.nativeElement.querySelector('.dot.bad')).toBeTruthy();
  });

  it('deletes the generator whose button was pressed', async () => {
    await load(response({ generators: [generator()] }));
    (rows()[0].querySelector('.btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();

    const req = http.expectOne(
      (r) => r.method === 'DELETE' && r.url === '/api/generators/generator-bars-1-7f3a',
    );
    req.flush({ deleted: 'generator-bars-1-7f3a' });
  });

  it('surfaces a refused delete', async () => {
    await load(response({ generators: [generator()] }));
    (rows()[0].querySelector('.btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE')
      .flush(
        { error: 'generator-bars-1-7f3a was not booked from this page' },
        { status: 403, statusText: 'Forbidden' },
      );
    fixture.detectChanges();

    expect(text()).toContain('was not booked from this page');
  });

  it('cannot delete a claim already on its way out', async () => {
    await load(response({ generators: [generator({ deleting: true })] }));
    expect(text()).toContain('deleting');
    expect((rows()[0].querySelector('.btn.kill') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the node a generator was pinned to', async () => {
    await load(response({ generators: [generator({ node: 'worker-3' })] }));
    expect(text()).toContain('on worker-3');
  });

  it('lists the readers of a generator under it, with where they read', async () => {
    await load(
      response({
        generators: [
          generator({
            readers: [
              {
                name: 'generator-bars-1-7f3a-r0001',
                node: 'worker-7',
                provider: 'tcp',
                phase: 'Bound',
                ready: false,
                reachable: { type: 'Reachable', status: 'False', reason: 'WorkloadProgressing' },
              },
            ],
          }),
        ],
      }),
    );
    expect(text()).toContain('generator-bars-1-7f3a-r0001');
    expect(text()).toContain('on worker-7');
    expect(text()).toContain('tcp');
    // Not ready means a flow is not delivering, and the reason says so.
    expect(text()).toContain('WorkloadProgressing');
  });

  it('adds readers to a booked generator and shows them before the next poll', async () => {
    await load(response({ generators: [generator()] }));
    const addButton = () =>
      [...rows()[0].querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Add readers'),
      ) as HTMLButtonElement;
    addButton().click();
    fixture.detectChanges();
    const node = rows()[0].querySelector('input[aria-label="Reader node"]') as HTMLInputElement;
    node.value = 'worker-7';
    node.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (
      [...rows()[0].querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Add',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const req = http.expectOne(
      (r) => r.method === 'POST' && r.url === '/api/generators/generator-bars-1-7f3a/readers',
    );
    expect(req.request.body).toEqual({ count: 1, node: 'worker-7', provider: 'auto' });
    req.flush({
      readers: [{ name: 'generator-bars-1-7f3a-r00aa', node: 'worker-7', provider: 'auto' }],
      error: null,
    });
    fixture.detectChanges();
    expect(text()).toContain('generator-bars-1-7f3a-r00aa');
  });

  it('deletes the reader whose button was pressed, not its generator', async () => {
    await load(
      response({
        generators: [generator({ readers: [{ name: 'generator-bars-1-7f3a-r0001' }] })],
      }),
    );
    (rows()[0].querySelector('.gen-reader .btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne(
        (r) => r.method === 'DELETE' && r.url === '/api/readers/generator-bars-1-7f3a-r0001',
      )
      .flush({ deleted: 'generator-bars-1-7f3a-r0001' });
  });

  it('calls a serving reader delivering only on its own word', async () => {
    const reader = { name: 'generator-bars-1-7f3a-r0001', phase: 'Bound', ready: true };
    await load(
      response({
        generators: [
          generator({
            readers: [
              { ...reader, delivering: true },
              { ...reader, name: 'generator-bars-1-7f3a-r0002', delivering: false },
              { ...reader, name: 'generator-bars-1-7f3a-r0003', delivering: null },
            ],
          }),
        ],
      }),
    );
    const states = Array.from(
      fixture.nativeElement.querySelectorAll('.gen-reader .gen-reader-meta'),
    ).map((el) => (el as HTMLElement).textContent ?? '');
    expect(states[0]).toContain('delivering');
    expect(states[1]).toContain('not delivering');
    // Ready means serving; without an answer from the reader it is not called delivering.
    expect(states[2]).toContain('serving');
    expect(fixture.nativeElement.querySelectorAll('.gen-reader .dot.bad')).toHaveLength(1);
  });

  it('lists readers whose generator is gone, so they can still be released', async () => {
    await load(response({ orphanReaders: [{ name: 'generator-gone-0001-r0001' }] }));
    expect(text()).toContain('Readers without a generator');
    (fixture.nativeElement.querySelector('.gen-reader .btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === '/api/readers/generator-gone-0001-r0001')
      .flush({ deleted: 'generator-gone-0001-r0001' });
  });

  it('says which readers a generator delete left behind', async () => {
    await load(response({ generators: [generator()] }));
    (rows()[0].querySelector('.row .btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === '/api/generators/generator-bars-1-7f3a')
      .flush({
        deleted: 'generator-bars-1-7f3a',
        error: 'readers left behind: generator-bars-1-7f3a-r0001: apiserver said no',
      });
    fixture.detectChanges();
    expect(text()).toContain('readers left behind');
  });

  it('books a reader of the flows chosen in the picker', async () => {
    await load(response());
    const picker = () =>
      Array.from(fixture.nativeElement.querySelectorAll('.rd-flow')) as HTMLElement[];
    expect(picker().map((el) => el.textContent)).toEqual([
      expect.stringContaining('MXL-1'),
      expect.stringContaining('SRT audio'),
    ]);
    const book = () =>
      [...fixture.nativeElement.querySelectorAll('mv-reader-form button')].find((b) =>
        (b as HTMLButtonElement).textContent?.includes('Book reader'),
      ) as HTMLButtonElement;
    // Nothing chosen yet: nothing to read.
    expect(book().disabled).toBe(true);

    const box = picker()[1].querySelector('input') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const node = fixture.nativeElement.querySelector('#rd-node') as HTMLInputElement;
    node.value = 'worker-9';
    node.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    book().click();

    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/readers');
    expect(req.request.body).toEqual({
      label: '',
      flows: ['aea7b9e9-1e5b-4333-9ac4-8689053a77de'],
      count: 1,
      node: 'worker-9',
      provider: 'auto',
      ttl: '1h',
    });
    req.flush({
      readers: [{ name: 'generator-r-flow-00aa', flows: ['aea7b9e9-1e5b-4333-9ac4-8689053a77de'] }],
    });
    fixture.detectChanges();
    // Shown before the next poll, with the flows it reads.
    expect(text()).toContain('Readers of chosen flows');
    expect(text()).toContain('generator-r-flow-00aa');
  });

  /**
   * A set's output has no MxlFlow, so it is not among the inventory's flows,
   * and it is still what a reader of the set opens.
   */
  it("offers a redundancy set's output and says what each flow is to the set", async () => {
    const output = 'c0000000-0000-4000-8000-0000000000c1';
    FLOWS.sets = [
      {
        name: 'p-show.program',
        members: ['d4d00000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1'],
        output: { id: output, label: 'p-show.program', format: 'video' },
      },
      // A member may be in several sets.
      {
        name: 'p-show.backup',
        members: ['d4d00000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b2'],
        output: {
          id: 'c0000000-0000-4000-8000-0000000000c3',
          label: 'p-show.backup',
          format: 'video',
        },
      },
      // A reader reads the primary domain only.
      {
        name: 'p-show.studio',
        domain: 'studio',
        members: ['studio.b0000000-0000-4000-8000-0000000000b4'],
        output: { id: 'studio.c0000000-0000-4000-8000-0000000000c4', label: 'p-show.studio' },
      },
    ];
    try {
      await load(response());
    } finally {
      delete FLOWS.sets;
    }
    const picker = () =>
      Array.from(fixture.nativeElement.querySelectorAll('.rd-flow')) as HTMLElement[];
    expect(picker().map((el) => el.textContent)).toEqual([
      expect.stringContaining('member 1 of p-show.program, member 1 of p-show.backup'),
      expect.stringContaining('output of p-show.backup'),
      expect.stringContaining('output of p-show.program'),
      expect.stringContaining('SRT audio'),
    ]);

    const box = picker()[2].querySelector('input') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (
      [...fixture.nativeElement.querySelectorAll('mv-reader-form button')].find((b) =>
        (b as HTMLButtonElement).textContent?.includes('Book reader'),
      ) as HTMLButtonElement
    ).click();

    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/readers');
    expect(req.request.body.flows).toEqual([output]);
    req.flush({ readers: [] });
  });

  it('narrows the picker by label, group or id', async () => {
    await load(response());
    const filter = fixture.nativeElement.querySelector('#rd-filter') as HTMLInputElement;
    filter.value = 'srt';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const shown = fixture.nativeElement.querySelectorAll('.rd-flow');
    expect(shown).toHaveLength(1);
    expect((shown[0] as HTMLElement).textContent).toContain('SRT audio');
  });

  it('lists readers of chosen flows apart and releases them one by one', async () => {
    await load(
      response({
        readers: [
          { name: 'generator-r-replica-0001', flows: ['d4d00000-0000-4000-8000-000000000001'] },
        ],
      }),
    );
    expect(text()).toContain('d4d00000-0000-4000-8000-000000000001');
    (fixture.nativeElement.querySelector('.gen-reader .btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === '/api/readers/generator-r-replica-0001')
      .flush({ deleted: 'generator-r-replica-0001' });
  });

  it('drops a booked reader once the poll has reported it, so it cannot come back stale', async () => {
    await load(response());
    const component = fixture.componentInstance as unknown as {
      onReadersCreated(r: { name: string }[]): void;
    };
    component.onReadersCreated([{ name: 'generator-r-flow-00aa' }]);
    fixture.detectChanges();
    expect(text()).toContain('generator-r-flow-00aa');

    // The poll reports it, then later no longer does: expired or deleted elsewhere.
    await new Promise((resolve) => setTimeout(resolve, 3100));
    http
      .match((req) => req.url === '/api/generators')
      .forEach((req) => req.flush(response({ readers: [{ name: 'generator-r-flow-00aa' }] })));
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 3100));
    http.match((req) => req.url === '/api/generators').forEach((req) => req.flush(response()));
    fixture.detectChanges();
    expect(text()).not.toContain('generator-r-flow-00aa');
  }, 10000);

  it('forgets a reader whose delete finds it gone already', async () => {
    await load(response({ readers: [{ name: 'generator-r-flow-00aa' }] }));
    (fixture.nativeElement.querySelector('.gen-reader .btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE')
      .flush(
        { error: 'no reader named generator-r-flow-00aa' },
        { status: 404, statusText: 'Not Found' },
      );
    fixture.detectChanges();
    expect(text()).not.toContain('no reader named');
  });

  describe('ring page links', () => {
    const RING = 'https://ring-generator-bars-1-7f3a.example.test/';
    const READER_RING = 'https://ring-generator-r-flow-00aa.example.test/';

    function links(): HTMLAnchorElement[] {
      return Array.from(fixture.nativeElement.querySelectorAll('a.ring-link'));
    }

    it('links each name to its ring page in a new tab while the server says it is up', async () => {
      await load(
        response({
          generators: [
            generator({
              ringUrl: RING,
              readers: [{ name: 'generator-bars-1-7f3a-r0001', ringUrl: READER_RING }],
            }),
          ],
          readers: [{ name: 'generator-r-flow-00aa', ringUrl: READER_RING }],
        }),
      );
      expect(links().map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
        ['generator-bars-1-7f3a', RING],
        ['generator-bars-1-7f3a-r0001', READER_RING],
        ['generator-r-flow-00aa', READER_RING],
      ]);
      for (const a of links()) {
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      }
    });

    it('shows a plain name where no ring page is up', async () => {
      await load(
        response({
          generators: [
            generator({ ringUrl: null, readers: [{ name: 'generator-bars-1-7f3a-r0001' }] }),
          ],
          readers: [{ name: 'generator-r-flow-00aa' }],
          orphanReaders: [{ name: 'generator-gone-0001-r0001' }],
        }),
      );
      expect(links()).toHaveLength(0);
      expect(text()).toContain('generator-bars-1-7f3a-r0001');
      expect(text()).toContain('generator-r-flow-00aa');
    });

    it('drops the link once a poll no longer reports the page up', async () => {
      await load(
        response({
          generators: [generator({ ringUrl: RING })],
          readers: [{ name: 'generator-r-flow-00aa', ringUrl: READER_RING }],
        }),
      );
      expect(links()).toHaveLength(2);

      // Expired: the server stops setting ringUrl, then stops listing the reader.
      await new Promise((resolve) => setTimeout(resolve, 3100));
      http
        .match((req) => req.url === '/api/generators')
        .forEach((req) =>
          req.flush(
            response({
              generators: [generator({ phase: 'Expired', ringUrl: null })],
            }),
          ),
        );
      fixture.detectChanges();
      expect(links()).toHaveLength(0);
      expect(text()).not.toContain('generator-r-flow-00aa');
    }, 10000);
  });

  it('offers no form where booking is switched off', async () => {
    await load(response({ enabled: false }));
    expect(fixture.nativeElement.querySelector('#gen-label')).toBeNull();
    expect(text()).toContain('Booking is switched off on this install');
  });
});
