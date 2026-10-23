import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PreviewController } from '../preview/preview-controller';
import { MultiviewerPage } from './multiviewer-page';

const FLOW = 'b2000000-0000-4000-8000-000000000001';

/**
 * The preview column is part of the page rather than an overlay over it, so the
 * layout has to react to what is open: no column at all while nothing is, and a
 * card per open flow once something is.
 */
describe('MultiviewerPage preview column', () => {
  let fixture: ComponentFixture<MultiviewerPage>;
  let controller: PreviewController;
  let http: HttpTestingController;

  function cards(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.pv-card'));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MultiviewerPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    controller = TestBed.inject(PreviewController);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MultiviewerPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    // The page polls two endpoints and a card releases its path; none of that is
    // the assertion under test.
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  function open(id: string): void {
    controller.open({ id, label: id, format: 'video', channels: 0 });
    fixture.detectChanges();
  }

  it('keeps all diagnostics inside the inset scrolling area', () => {
    const panel: HTMLElement = fixture.nativeElement.querySelector('.panel');
    const scroll = panel.querySelector(':scope > .panel-scroll');

    expect(scroll).not.toBeNull();
    expect(panel.children).toHaveLength(1);
    expect(scroll?.querySelector('h2')?.textContent).toContain('RDMA delivery');
    for (const selector of [
      '.agg',
      'mv-gateway-grid',
      'mv-service-links',
      'mv-operator-flow-list',
    ]) {
      expect(scroll?.querySelector(selector)).not.toBeNull();
    }
  });

  // The column is held open whether or not it holds a card. A column that
  // arrives with the first preview re-lays the page out under the pointer
  // that opened it, which is what this reserves against.
  it('holds the column open with nothing in it', () => {
    expect(fixture.nativeElement.querySelector('.previews')).not.toBeNull();
    expect(cards()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.pv-idle')).not.toBeNull();
  });

  it('adds a card to the column when a preview opens', () => {
    open(FLOW);

    expect(cards()).toHaveLength(1);
    // The hint gives way to the card it was standing in for.
    expect(fixture.nativeElement.querySelector('.pv-idle')).toBeNull();
    expect(cards()[0].querySelector('.pv-head')?.textContent).toContain(FLOW);
  });

  it('stacks a second flow beside the first', () => {
    open(FLOW);
    open('a0d10000-0000-4000-8000-000000000001');

    expect(cards()).toHaveLength(2);
  });

  it('keeps the column when the last card is closed', () => {
    open(FLOW);
    (cards()[0].querySelector('.pv-head .btn') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cards()).toHaveLength(0);
    // Closing the last card must not take the column with it, or the panel
    // moves again on the way back.
    expect(fixture.nativeElement.querySelector('.previews')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.pv-idle')).not.toBeNull();
  });
});
