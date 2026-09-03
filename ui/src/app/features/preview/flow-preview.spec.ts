import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FlowPreview } from './flow-preview';
import { PreviewController } from './preview-controller';

const FLOW = 'd4d00000-0000-0000-0000-00000000a002';

/**
 * A browser is served two channels of an audio flow whatever its width, so a
 * 12-channel flow is only fully reachable if every pair can be asked for. These
 * cover the asking: that the buttons span the flow and that pressing one names
 * the pair on the wire in the form the aggregator validates.
 */
describe('FlowPreview channel pairs', () => {
  let fixture: ComponentFixture<FlowPreview>;
  let http: HttpTestingController;

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.pv-chan'));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FlowPreview],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Destroying the card releases its path, and any /start left unflushed is not
    // the assertion under test.
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  function openAudio(channels: number): void {
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', {
      id: FLOW,
      label: 'telos-upmax-out',
      format: 'audio',
      channels,
    });
    fixture.detectChanges();
  }

  function pendingPreviewPosts(): ReturnType<HttpTestingController['match']> {
    return http.match((r) => r.method === 'POST' && r.url.startsWith(`/api/preview/${FLOW}`));
  }

  it('offers one button per pair of a 12-channel flow', () => {
    openAudio(12);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      '1/2',
      '3/4',
      '5/6',
      '7/8',
      '9/10',
      '11/12',
    ]);
  });

  it('keeps a lone trailing channel selectable on its own', () => {
    openAudio(5);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['1/2', '3/4', '5']);
  });

  it('offers no choice when the flow is a single pair', () => {
    openAudio(2);
    expect(buttons()).toHaveLength(0);
  });

  it('caps a flow wider than twelve channels at six pairs', () => {
    openAudio(16);
    expect(buttons().map((b) => b.textContent?.trim())).toEqual([
      '1/2',
      '3/4',
      '5/6',
      '7/8',
      '9/10',
      '11/12',
    ]);
  });

  it('opens one connection per pair at once, each naming its pair on the wire', () => {
    openAudio(12);
    const requests = pendingPreviewPosts();
    expect(requests.map((r) => decodeURIComponent(r.request.urlWithParams))).toEqual([
      `/api/preview/${FLOW}?owner=preview&channels=1,2`,
      `/api/preview/${FLOW}?owner=preview&channels=3,4`,
      `/api/preview/${FLOW}?owner=preview&channels=5,6`,
      `/api/preview/${FLOW}?owner=preview&channels=7,8`,
      `/api/preview/${FLOW}?owner=preview&channels=9,10`,
      `/api/preview/${FLOW}?owner=preview&channels=11,12`,
    ]);
    requests.forEach((r, i) => r.flush({ path: `p${i}`, hls: '', whep: '', format: 'audio' }));
  });

  it('opens exactly one connection for a flow no wider than a pair', () => {
    openAudio(2);
    const requests = pendingPreviewPosts();
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0].request.urlWithParams)).not.toContain('channels=');
    requests[0].flush({ path: 'p', hls: 'h', whep: 'w', format: 'audio' });
  });

  it('marks a pair on the press rather than waiting for the next poll', () => {
    openAudio(12);
    // The first pair is heard as soon as the card opens, before any pair has
    // actually connected, so it starts marked on its own.
    expect(buttons().filter((b) => b.classList.contains('on'))).toHaveLength(1);
    expect(buttons()[0].classList.contains('on')).toBe(true);

    buttons()[2].click();
    fixture.detectChanges();
    expect(buttons().filter((b) => b.classList.contains('on'))).toHaveLength(1);
    expect(buttons()[2].classList.contains('on')).toBe(true);
  });

  it('makes no server call when picking a different pair of a wide flow', () => {
    openAudio(12);
    pendingPreviewPosts().forEach((r) =>
      r.flush({ path: 'p', hls: '', whep: '', format: 'audio' }),
    );

    buttons()[2].click();
    fixture.detectChanges();

    http.expectNone(() => true);
  });
});

/**
 * A data card holds no player at all: ANC has no transport to a browser, so the
 * card polls decoded grains and shows the packets. What matters is that it asks
 * the right endpoint and renders what comes back, including the sender's
 * ANC_Count disagreeing with the packets actually present.
 */
describe('FlowPreview ANC data', () => {
  let fixture: ComponentFixture<FlowPreview>;
  let http: HttpTestingController;

  const ANC = 'a0d30000-0000-0000-0000-000000000001';

  const GRAIN = {
    flow: ANC,
    index: 53595736482,
    rfc8331Length: 96,
    validSlices: 4096,
    totalSlices: 4096,
    declaredCount: 0,
    ancCount: 1,
    elements: [
      {
        line: 9,
        did: 0x60,
        sdid: 0x60,
        dataCount: 16,
        description: 'SMPTE ST 12-2 Ancillary Time Code',
        udw: [1, 33, 66, 2],
      },
    ],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FlowPreview],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FlowPreview);
    fixture.componentRef.setInput('request', {
      id: ANC,
      label: 'ST2110 ANC 30/1',
      format: 'data',
      channels: 0,
    });
    fixture.detectChanges();

    http
      .expectOne((req) => req.method === 'POST' && req.url.startsWith(`/api/preview/${ANC}`))
      .flush({ format: 'data', anc: `/api/anc/${ANC}` });
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  function flushGrain(): void {
    http.expectOne(`/api/anc/${ANC}`).flush(GRAIN);
    fixture.detectChanges();
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('carries no video element', () => {
    flushGrain();
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
  });

  it('names the packet by its DID/SDID and registration', () => {
    flushGrain();
    expect(text()).toContain('0x60/0x60');
    expect(text()).toContain('SMPTE ST 12-2 Ancillary Time Code');
    expect(text()).toContain('line 9');
    expect(text()).toContain('DC 16');
  });

  it('shows the UDW as hex', () => {
    flushGrain();
    expect(text()).toContain('0x01 0x21 0x42 0x02');
  });

  it('says so when the header count disagrees with the packets', () => {
    flushGrain();
    expect(text()).toContain('header declares ANC_Count 0');
  });
});

/**
 * The column is one card per flow. A second Preview on a flow already open would
 * resolve to the same mediamtx path, and closing either card would release it
 * under the other.
 */
describe('PreviewController', () => {
  let controller: PreviewController;

  const request = (id: string) => ({ id, label: id, format: 'video' as const, channels: 0 });

  beforeEach(() => {
    TestBed.configureTestingModule({});
    controller = TestBed.inject(PreviewController);
  });

  it('keeps the order previews were opened in', () => {
    controller.open(request('a'));
    controller.open(request('b'));
    expect(controller.requests().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('ignores a second open of the same flow', () => {
    controller.open(request('a'));
    controller.open(request('a'));
    expect(controller.requests()).toHaveLength(1);
  });

  it('closes one preview without touching the rest', () => {
    controller.open(request('a'));
    controller.open(request('b'));
    controller.close('a');
    expect(controller.requests().map((r) => r.id)).toEqual(['b']);
  });
});
