import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoisyResponse } from '../../core/api/models';
import { NoisyPage } from './noisy-page';

function response(over: Partial<NoisyResponse> = {}): NoisyResponse {
  return {
    namespace: 'production-demo-app',
    className: 'noisy-neighbour',
    enabled: true,
    max: 4,
    roles: ['aggressor', 'sender', 'sink'],
    optIns: ['rdma-lossless', 'multicast', 'line-rate'],
    ttls: ['1h', '8h', '24h', 'none'],
    nodes: ['worker-1', 'worker-2'],
    victims: ['writer-mxl-1'],
    noisy: [],
    ...over,
  };
}

/**
 * The page books, links and releases. The load itself is set in the function's
 * own UI, so the link to it is what a booking is for.
 */
describe('NoisyPage', () => {
  let fixture: ComponentFixture<NoisyPage>;
  let http: HttpTestingController;

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return el().textContent ?? '';
  }

  function set(name: string, value: string): void {
    const input = el().querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
    fixture.detectChanges();
  }

  function submit(): void {
    el()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  }

  async function load(body: NoisyResponse): Promise<void> {
    TestBed.configureTestingModule({
      imports: [NoisyPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(NoisyPage);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.match((req) => req.url === '/api/noisy').forEach((req) => req.flush(body));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  afterEach(() => http?.verify({ ignoreCancelled: true }));

  it('books an aggressor beside a victim', async () => {
    await load(response());
    set('one-mode', 'victim');
    set('one-victim', 'writer-mxl-1');
    set('one-cpu', '2');
    submit();

    const req = http.expectOne('/api/noisy');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.role).toBe('aggressor');
    expect(req.request.body.placement).toEqual({ victim: 'writer-mxl-1' });
    expect(req.request.body.resources).toEqual({ requests: { cpu: '2' } });
    // On unless unticked: without the route the page has nothing to link.
    expect(req.request.body.ingress).toEqual({ httproute: { enabled: true } });
    req.flush({ name: 'noisy-aggressor-1a2b', role: 'aggressor', phase: 'Pending' });
    fixture.detectChanges();
    expect(text()).toContain('noisy-aggressor-1a2b');
  });

  it('books a pair with one placement per side', async () => {
    await load(response());
    set('role', 'pair');
    set('sink-mode', 'node');
    set('sink-node', 'worker-1');
    set('sender-mode', 'node');
    set('sender-node', 'worker-2');
    submit();

    const req = http.expectOne('/api/noisy/pair');
    expect(req.request.body.sink).toEqual({ placement: { nodeName: 'worker-1' } });
    expect(req.request.body.sender).toEqual({ placement: { nodeName: 'worker-2' } });
    expect(req.request.body.role).toBeUndefined();
    req.flush({ noisy: [{ name: 'noisy-sink-1' }, { name: 'noisy-sender-2' }] });
  });

  it('stops a bad request at the form', async () => {
    await load(response());
    set('maxDuration', '3h');
    submit();
    http.expectNone('/api/noisy');
    expect(text()).toContain('at most 2h');
  });

  it("links the function's own UI in a new tab once it is up", async () => {
    await load(
      response({
        noisy: [
          {
            name: 'noisy-a-0001',
            role: 'aggressor',
            node: 'worker-2',
            placement: 'beside writer-mxl-1',
            ready: true,
            uiUrl: 'https://noisy-a-0001.example/',
          },
          { name: 'noisy-b-0002', role: 'sink', ready: false, placement: 'any node' },
        ],
      }),
    );
    const links = [...el().querySelectorAll('a.ring-link')] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://noisy-a-0001.example/']);
    expect(links[0].target).toBe('_blank');
    expect(text()).toContain('on worker-2');
    expect(text()).toContain('not scheduled');
  });

  it('releases one', async () => {
    await load(response({ noisy: [{ name: 'noisy-a-0001', role: 'aggressor' }] }));
    (el().querySelector('.gen-drop') as HTMLButtonElement).click();
    const req = http.expectOne('/api/noisy/noisy-a-0001');
    expect(req.request.method).toBe('DELETE');
    req.flush({ deleted: 'noisy-a-0001' });
  });

  it('says so rather than offering a form when the page is off', async () => {
    await load(response({ enabled: false }));
    expect(text()).toContain('switched off');
    expect(el().querySelector('form')).toBeNull();
  });

  it('stops booking a pair that would pass the install ceiling', async () => {
    await load(
      response({
        max: 2,
        noisy: [{ name: 'noisy-a-0001', role: 'aggressor' }],
      }),
    );
    set('role', 'pair');
    const button = el().querySelector('.gen-book') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(text()).toContain('Release one first');
  });
});
