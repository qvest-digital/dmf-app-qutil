import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FlowPreviewModal } from './flow-preview-modal';
import { PreviewController } from './preview-controller';

const FLOW = 'd4d00000-0000-0000-0000-00000000a002';

/**
 * A browser is served two channels of an audio flow whatever its width, so a
 * 12-channel flow is only fully reachable if every pair can be asked for. These
 * cover the asking: that the buttons span the flow and that pressing one names
 * the pair on the wire in the form the aggregator validates.
 */
describe('FlowPreviewModal channel pairs', () => {
  let fixture: ComponentFixture<FlowPreviewModal>;
  let controller: PreviewController;
  let http: HttpTestingController;

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.pv-chan'));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FlowPreviewModal],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(FlowPreviewModal);
    controller = TestBed.inject(PreviewController);
    http = TestBed.inject(HttpTestingController);
    // First change detection with no request open: resolves the view children the
    // overlay touches before anything asks it to play.
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.close();
    fixture.detectChanges();
    // The close issues a DELETE, and any /start left unflushed is not the
    // assertion under test.
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  function openAudio(channels: number): void {
    controller.open({ id: FLOW, label: 'telos-upmax-out', format: 'audio', channels });
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
    expect(decodeURIComponent(req.request.url)).toContain('owner=overlay');
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
