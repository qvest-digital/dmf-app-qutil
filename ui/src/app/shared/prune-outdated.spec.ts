import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PruneResult } from '../core/api/models';
import { PruneOutdated } from './prune-outdated';

@Component({
  imports: [PruneOutdated],
  template: `<mv-prune-outdated [count]="count()" (pruned)="results.push($event)" />`,
})
class Host {
  readonly count = signal(0);
  readonly results: PruneResult[] = [];
}

/**
 * One press releases every outdated claim, where it took one Delete per row.
 * Pruning answers in seconds, so the button shows it is working, refuses a
 * second press meanwhile, and a failure stays on screen.
 */
describe('PruneOutdated', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;

  function button(): HTMLButtonElement {
    return (fixture.nativeElement as HTMLElement).querySelector('button')!;
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function render(count: number): void {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.count.set(count);
    fixture.detectChanges();
  }

  function press(): void {
    button().click();
    fixture.detectChanges();
  }

  afterEach(() => http.verify());

  it('names how many outdated claims the page lists', () => {
    render(28);
    expect(button().textContent).toContain('Prune 28 outdated');
    expect(button().disabled).toBe(false);
  });

  it('cannot be pressed with nothing outdated', () => {
    render(0);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toContain('Nothing outdated');
    press();
    http.expectNone('/api/prune');
  });

  it('is busy and refuses a second press until the server answers', () => {
    render(2);
    press();
    const req = http.expectOne('/api/prune');
    expect(req.request.method).toBe('POST');
    expect(button().disabled).toBe(true);
    expect(button().textContent).toContain('Pruning...');
    press();
    http.expectNone('/api/prune');
    req.flush({ removed: ['a', 'b'], failed: [] });
    fixture.detectChanges();
    expect(button().disabled).toBe(false);
  });

  it('reports what it released and tells the page to refresh', () => {
    render(2);
    press();
    const result = { removed: ['a', 'b'], failed: [] };
    http.expectOne('/api/prune').flush(result);
    fixture.detectChanges();
    expect(text()).toContain('released 2 claims');
    expect(fixture.componentInstance.results).toEqual([result]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.gen-errors')).toBeNull();
  });

  it('lists every claim it could not release', () => {
    render(3);
    press();
    http.expectOne('/api/prune').flush({
      removed: ['a'],
      failed: [
        { name: 'generator-b-0001', error: 'forbidden' },
        { name: 'booked-c-0001', error: 'timed out' },
      ],
    });
    fixture.detectChanges();
    const errors = (fixture.nativeElement as HTMLElement).querySelector('.gen-errors');
    expect(errors?.textContent).toContain('generator-b-0001: forbidden');
    expect(errors?.textContent).toContain('booked-c-0001: timed out');
    expect(text()).toContain('released 1 claim');
  });

  it('shows the error when the prune itself fails', () => {
    render(2);
    press();
    http
      .expectOne('/api/prune')
      .flush({ error: 'cannot list claims' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.gen-errors')?.textContent,
    ).toContain('cannot list claims');
    expect(button().disabled).toBe(false);
    expect(fixture.componentInstance.results).toEqual([]);
  });
});
