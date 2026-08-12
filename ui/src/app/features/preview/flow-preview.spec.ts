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
    http.expectOne((req) => req.method === 'POST' && req.url.startsWith(`/api/preview/${FLOW}`));
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

  it('names the requested pair on the wire', () => {
    openAudio(12);
    buttons()[2].click();
    fixture.detectChanges();

    const req = http.expectOne(
      (r) => r.method === 'POST' && decodeURIComponent(r.url).includes('channels=5,6'),
    );
    expect(decodeURIComponent(req.request.url)).toContain('owner=preview');
    req.flush({ path: 'p', hls: 'h', whep: 'w', format: 'audio' });
  });

  it('marks a pair on the press rather than waiting for the next poll', () => {
    openAudio(12);
    expect(buttons().some((b) => b.classList.contains('on'))).toBe(false);

    buttons()[2].click();
    fixture.detectChanges();
    expect(buttons().filter((b) => b.classList.contains('on'))).toHaveLength(1);
    expect(buttons()[2].classList.contains('on')).toBe(true);
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
