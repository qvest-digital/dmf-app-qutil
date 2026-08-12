import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PreviewController } from '../preview/preview-controller';
import { MultiviewerPage } from './multiviewer-page';

const FLOW = 'b2000000-0000-0000-0000-000000000001';

/**
 * The preview column is part of the page rather than an overlay over it, so the
 * layout has to react to what is open: no column at all while nothing is, and a
 * card per open flow once something is.
 */
describe('MultiviewerPage preview column', () => {
  let fixture: ComponentFixture<MultiviewerPage>;
  let controller: PreviewController;
  let http: HttpTestingController;

  function main(): HTMLElement {
    return fixture.nativeElement.querySelector('main');
  }

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

  it('carries no column while nothing is open', () => {
    expect(fixture.nativeElement.querySelector('.previews')).toBeNull();
    expect(main().classList.contains('previewing')).toBe(false);
  });

  it('adds a card and the second column when a preview opens', () => {
    open(FLOW);

    expect(cards()).toHaveLength(1);
    expect(main().classList.contains('previewing')).toBe(true);
    expect(cards()[0].querySelector('.pv-head')?.textContent).toContain(FLOW);
  });

  it('stacks a second flow beside the first', () => {
    open(FLOW);
    open('a0d10000-0000-0000-0000-000000000001');

    expect(cards()).toHaveLength(2);
  });

  it('drops the column again when the last card is closed', () => {
    open(FLOW);
    (cards()[0].querySelector('.pv-head .btn') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cards()).toHaveLength(0);
    expect(main().classList.contains('previewing')).toBe(false);
  });
});
