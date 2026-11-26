import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { MxlGraph } from '../../core/api/models';
import { Card, CARD_W, layoutFlows, PAD, shortNode, Wire } from './flow-layout';

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const STEP = 1.25;
/** How far a press may travel and still count as a click rather than a pan. */
const CLICK_SLOP_PX = 4;

/** Unit vectors for the arrow keys, in drawing coordinates. */
const ARROWS: Readonly<Record<string, { x: number; y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The card an arrow key leads to: ahead of `from` in that direction, with
 * sideways distance counting double so a card straight ahead wins over a
 * closer one off to the side.
 */
function nearest(
  from: Card,
  cards: readonly Card[],
  direction: { x: number; y: number },
): Card | undefined {
  const centre = (c: Card) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
  const origin = centre(from);
  let best: Card | undefined;
  let bestScore = Infinity;
  for (const c of cards) {
    const p = centre(c);
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const ahead = dx * direction.x + dy * direction.y;
    if (ahead <= 0) continue;
    const score = ahead + 2 * Math.abs(dx * direction.y - dy * direction.x);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Roughly how wide a character is at the sizes the cards use. SVG text
 *  neither wraps nor clips, so a name longer than its card runs out through
 *  the node box and across the diagram; something has to decide where to stop
 *  it, and measuring every string against a DOM that has not been laid out yet
 *  is not available here. Deliberately a hair wide, so the estimate errs on
 *  cutting a character early rather than one too late. */
const NAME_CHAR_PX = 7.1;
const CLASS_CHAR_PX = 6.4;

/** Line and dot colours by what they say, as attributes: SVG presentation
 *  attributes take a colour, and the legend draws with the same values. The
 *  surfaces and pale borders name properties the styles below set. */
const STROKE = { local: '#9aa0a6', remote: '#f05012', broken: '#c5221f' };
const DOT = { ok: '#c8f169', pending: '#77757c', degraded: '#f05012', broken: '#c5221f' };
const TEAL = 'var(--diagram-teal)';
const WRITER_BORDER = '#f05012';
const READER_BORDER = 'var(--diagram-reader)';
type CardBorder = typeof TEAL | typeof WRITER_BORDER | typeof READER_BORDER;
/** The card a highlight is traced from, tinted in its own border's colour
 *  apart from the cards it reaches. A reader's border is too pale to tint
 *  from, so its tint is a darker grey than the border itself. */
const SOURCE_FILL: Record<CardBorder, string> = {
  [TEAL]: 'var(--diagram-teal-tint)',
  [WRITER_BORDER]: 'var(--diagram-writer-tint)',
  [READER_BORDER]: 'var(--diagram-reader-tint)',
};

/** Drawing units between two grains of a flow at one grain per second. The
 *  spacing is this over the rate, so the number of dots on a line is in
 *  proportion to the frame rate: 60 units apart at 24 fps, 6 at 240. */
const GRAIN_SPAN = 1440;
/** Closer than this and the dots run into one line. */
const MIN_GRAIN_GAP = 5;
/** How fast every flow's dots travel, in drawing units per second. One speed
 *  for all, so the spacing alone tells one rate from another. */
const GRAIN_SPEED = 48;

/** Audio has no frames to count, so a served audio line carries bursts of
 *  bars instead, drawn across it like a waveform: one bar per channel. Each
 *  bar is a dash this long along the line, the next starts this far on. */
const BAR = 1.5;
const BAR_PITCH = 3;
/** Line between two bursts. A burst takes more room than a frame's dot, so
 *  the bursts are spaced well apart to stay countable. */
const BURST_GAP = 120;
/** Bursts in one repeat of a line's pattern, each with its own heights. */
const BURSTS = 4;
/** How far the pipe around a served line reaches beyond the line itself. */
const PIPE = 5;
/** How tall a bar is, as a share of the pipe: short, middle and tall. A short
 *  bar stands well clear of the line, and a tall one fills the pipe without
 *  leaving it. */
const BAR_HEIGHT = [0.6, 0.8, 1];
const SHORT = 0;
const TALL = BAR_HEIGHT.length - 1;

/** A generator of numbers in [0, 1) seeded by a string, so a line keeps its
 *  bursts from one refresh to the next instead of flickering. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 2 ** 32;
  };
}

/** The height tier of each channel's bar in one burst. Every burst has a tall
 *  bar and starts and ends short like a waveform where it has the bars for
 *  it: mono is one tall bar, stereo a tall and a short one in either order. */
export function burstTiers(channels: number, random: () => number): number[] {
  const pick = (n: number) => Math.floor(random() * n);
  if (channels === 1) return [TALL];
  if (channels === 2) return pick(2) ? [SHORT, TALL] : [TALL, SHORT];
  const tiers = Array.from({ length: channels }, () => pick(BAR_HEIGHT.length));
  tiers[0] = SHORT;
  tiers[channels - 1] = SHORT;
  if (!tiers.includes(TALL)) tiers[1 + pick(channels - 2)] = TALL;
  return tiers;
}

/** The bars of one height across a served audio line. */
interface AudioTier {
  readonly width: number;
  readonly dash: string;
}

/** What decides how a line is drawn. */
type LineStyle = Pick<Wire, 'local' | 'state'>;

interface LegendEntry extends LineStyle {
  readonly label: string;
}

/** Text cut to fit a width, with the cut marked. The full value rides along in
 *  a title, so nothing is actually lost. */
function fit(text: string, widthPx: number, charPx: number): string {
  const max = Math.floor(widthPx / charPx);
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 3)) + '...';
}

/** The same, cut in the middle: the members and outputs of two sets share a
 *  prefix and differ at the end, so an end cut drew them identical. */
function fitMiddle(text: string, widthPx: number, charPx: number): string {
  const max = Math.floor(widthPx / charPx);
  if (text.length <= max) return text;
  const keep = Math.max(2, max - 3);
  const head = Math.ceil(keep / 2);
  return text.slice(0, head) + '...' + text.slice(text.length - (keep - head));
}

/**
 * The cluster's flows drawn as a picture: every node a box, every function a
 * card inside the node it runs on, and every read an edge from the writer.
 *
 * The node boundary is the whole point. An edge that stays inside a box is a
 * read out of shared memory and costs nothing; an edge that leaves one box for
 * another is a flow the gateway has to carry across the fabric first. A list
 * of flows shows neither, and a row of cards shows the ends without the
 * boundary between them.
 *
 * A redundancy set is one output read from several members written on
 * different nodes, so it is drawn the same way: each member at its origin,
 * the output on each node it is merged on, and a leg from every member into
 * every output, inside the box where the member is written beside it.
 *
 * Where everything goes is worked out by layoutFlows; this draws it and moves
 * it about.
 */
@Component({
  selector: 'mv-flow-diagram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  host: {
    '(document:fullscreenchange)': 'syncFullscreen()',
    '(document:keydown.escape)': 'unselectUnlessFullscreen()',
    '(document:keydown)': 'moveSelection($event)',
  },
  template: `<figure #container [class.fullscreen]="fullscreen()">
    <div class="toolbar">
      <button type="button" class="tool" (click)="zoomBy(1 / STEP)" aria-label="Zoom out">-</button>
      <button type="button" class="tool" (click)="zoomBy(STEP)" aria-label="Zoom in">+</button>
      <button type="button" class="tool" (click)="reset()">Fit</button>
      <span class="small">{{ percent() }}%</span>
      <span
        class="small hint"
        data-testid="selection-hint"
        [title]="selectedCard() ? SELECTION_HINT : ''"
        >{{ selectedCard() ? SELECTION_HINT : '' }}</span
      >
      <button
        type="button"
        class="tool"
        [disabled]="!document.fullscreenEnabled"
        [attr.aria-pressed]="fullscreen()"
        (click)="toggleFullscreen()"
      >
        {{ fullscreen() ? 'Exit fullscreen' : 'Show fullscreen' }}
      </button>
    </div>
    @if (fullscreenError()) {
      <p role="alert" class="alert">{{ fullscreenError() }}</p>
    }

    <svg
      #frame
      [attr.viewBox]="'0 0 ' + size().w + ' ' + size().h"
      [style.aspect-ratio]="fullscreen() ? 'auto' : size().w + ' / ' + size().h"
      [style.max-width.px]="fullscreen() ? null : size().w"
      class="frame"
      [class.grabbing]="panning()"
      role="group"
      [attr.aria-label]="summary()"
      (pointerdown)="grab($event)"
      (pointermove)="drag($event)"
      (pointerup)="release($event)"
      (pointercancel)="release($event)"
      (lostpointercapture)="release($event)"
      (pointerleave)="hoveredCard.set(null)"
      (wheel)="wheel($event)"
    >
      <g [attr.transform]="view()">
        <!-- The nodes, under everything else. -->
        @for (n of layout().nodes; track n.name) {
          <g>
            <rect
              [attr.x]="n.x"
              [attr.y]="n.y"
              [attr.width]="n.w"
              [attr.height]="n.h"
              rx="14"
              fill="var(--diagram-node)"
              stroke="var(--diagram-reader)"
            />
            <text
              [attr.x]="n.x + PAD"
              [attr.y]="n.y + 21"
              class="grey"
              style="font-size:11px;font-weight:700;letter-spacing:0.14em"
            >
              {{ short(n.name).toUpperCase() }}
            </text>
          </g>
        }

        <!-- The reads and a set's legs. A line that leaves its node is the one
             that costs. Arrowheads are drawn rather than markers: a marker is
             looked up by a document-wide id, and its tip sits off the end of
             the line by whatever the marker's own geometry says. -->
        @for (w of orderedWires(); track w.key) {
          <g
            class="wire"
            [class.highlighted]="highlightedWires().has(w.key)"
            [class.dimmed]="activeCard() && !highlightedWires().has(w.key)"
            [attr.data-from]="w.from"
            [attr.data-to]="w.to"
            [attr.data-kind]="w.kind"
          >
            <title>{{ w.title }} - {{ how(w) }}</title>
            <path
              [attr.d]="w.d"
              fill="none"
              [attr.stroke]="stroke(w)"
              [attr.stroke-width]="width(w)"
              [attr.stroke-dasharray]="dash(w)"
            />
            <polygon [attr.points]="w.head" [attr.fill]="stroke(w)" />
            <!-- A served flow with a frame rate is drawn as a pipe with its
                 frames moving through it, a served audio flow as a pipe with
                 a burst of one bar per channel. -->
            @if (grainGap(w) || audioPeriod(w)) {
              <path
                class="pipe"
                [attr.d]="w.d"
                fill="none"
                [attr.stroke]="stroke(w)"
                [attr.stroke-width]="width(w) + PIPE"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-opacity="0.18"
              />
            }
            @if (grainGap(w); as gap) {
              <path
                class="grains"
                [attr.d]="w.d"
                fill="none"
                [attr.stroke]="stroke(w)"
                [attr.stroke-width]="width(w) + 1.5"
                stroke-linecap="round"
                [attr.stroke-dasharray]="'0 ' + gap"
                [style.--grain-gap.px]="gap"
                [style.animation-duration.s]="gap / GRAIN_SPEED"
              />
            } @else if (audioPeriod(w); as period) {
              @for (t of audioTiers(w); track $index) {
                <path
                  class="grains bars"
                  [attr.d]="w.d"
                  fill="none"
                  [attr.stroke]="stroke(w)"
                  [attr.stroke-width]="t.width"
                  stroke-linecap="butt"
                  [attr.stroke-dasharray]="t.dash"
                  [style.--grain-gap.px]="period"
                  [style.animation-duration.s]="period / GRAIN_SPEED"
                />
              }
            }
          </g>
        }

        <!-- The functions, a set's members and its outputs. -->
        @for (c of layout().cards; track c.key) {
          <g
            class="card"
            [class.highlighted]="highlightedCards().has(c.key)"
            [class.source]="activeCard() === c.key"
            [class.dimmed]="activeCard() && !highlightedCards().has(c.key)"
            [style.cursor]="panning() ? null : 'pointer'"
            [attr.data-key]="c.key"
            [attr.data-kind]="c.kind"
            tabindex="0"
            role="button"
            [attr.aria-pressed]="selectedCard() === c.key"
            (pointerenter)="!panning() && hoveredCard.set(c.key)"
            (pointerleave)="!panning() && hoveredCard.set(null)"
            (focus)="focusedCard.set(c.key)"
            (blur)="focusedCard.set(null)"
            (keydown.enter)="toggleSelected(c.key)"
            (keydown.space)="$event.preventDefault(); toggleSelected(c.key)"
          >
            <title>{{ c.tooltip }}</title>
            <rect
              [attr.x]="c.x"
              [attr.y]="c.y"
              [attr.width]="c.w"
              [attr.height]="c.h"
              rx="10"
              [attr.fill]="fill(c)"
              [attr.stroke]="border(c)"
              [attr.stroke-width]="
                (c.kind === 'function' && !c.writes ? 1 : 1.5) + (activeCard() === c.key ? 0.75 : 0)
              "
              [attr.stroke-dasharray]="c.kind === 'member' ? '4 3' : null"
            />
            @if (c.state) {
              <circle
                [attr.cx]="c.x + c.w - 12"
                [attr.cy]="c.y + 12"
                r="4"
                [attr.fill]="dot(c)"
                stroke="#0b090d"
                stroke-width="0.5"
              />
            }
            <text [attr.x]="c.x + 12" [attr.y]="c.y + 20" style="font-size:12.5px;font-weight:700">
              {{ fitName(c) }}
            </text>
            <text
              [attr.x]="c.x + 12"
              [attr.y]="c.y + 35"
              class="grey"
              style="font-size:10.5px;font-family:ui-monospace,monospace"
            >
              {{ fitClass(c.sub) }}
            </text>
          </g>
        }
      </g>
    </svg>

    <figcaption class="small">
      <!-- Every line entry is drawn by the same stroke, width and dash as the
           lines it explains, so the legend cannot show a colour the diagram
           does not draw. -->
      @for (e of legend(); track e.label) {
        <span>
          <svg width="26" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              [attr.stroke]="stroke(e)"
              [attr.stroke-width]="width(e)"
              [attr.stroke-dasharray]="dash(e)"
            />
          </svg>
          {{ e.label }}
        </span>
      }
      @if (hasGrains()) {
        <span>
          <svg width="26" height="10" aria-hidden="true">
            <line
              x1="3"
              y1="5"
              x2="23"
              y2="5"
              [attr.stroke]="STROKE.local"
              stroke-width="6.5"
              stroke-linecap="round"
              stroke-opacity="0.18"
            />
            <line
              x1="5"
              y1="5"
              x2="21"
              y2="5"
              [attr.stroke]="STROKE.local"
              stroke-width="3"
              stroke-linecap="round"
              stroke-dasharray="0 8"
            />
          </svg>
          one dot per frame: the more dots, the higher the frame rate
        </span>
      }
      @if (hasAudio()) {
        <span>
          <svg width="26" height="12" aria-hidden="true">
            @for (h of [6, 10, 4, 10, 6]; track $index) {
              <line
                [attr.x1]="5 + $index * 4"
                [attr.x2]="5 + $index * 4"
                [attr.y1]="6 - h / 2"
                [attr.y2]="6 + h / 2"
                [attr.stroke]="STROKE.local"
                stroke-width="1.5"
              />
            }
          </svg>
          one bar per audio channel
        </span>
      }
      @if (hasSets()) {
        <span>
          <svg width="26" height="12" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="24"
              height="10"
              rx="3"
              fill="var(--diagram-card)"
              [attr.stroke]="TEAL"
              stroke-dasharray="4 3"
            />
          </svg>
          redundancy set member, at its origin
        </span>
        <span>
          <svg width="26" height="12" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="24"
              height="10"
              rx="3"
              fill="var(--diagram-output)"
              [attr.stroke]="TEAL"
            />
          </svg>
          set output, merged on the node
        </span>
      }
    </figcaption>
  </figure>`,
  styles: `
    /* The diagram draws on a light surface of its own: the panel around it is
       teal, and the line colours are chosen against white. grey and line are
       the team's secondary type and rule colours, which the global styles do
       not name. */
    :host {
      display: block;
      --diagram-grey: #77757c;
      --diagram-line: #eceae4;
      --diagram-node: #faf9f7;
      --diagram-card: #ffffff;
      --diagram-output: #eef4f3;
      --diagram-teal: var(--qv-teal);
      --diagram-reader: #e5e2dd;
      --diagram-teal-tint: #cfe2e0;
      --diagram-writer-tint: #fde4d8;
      --diagram-reader-tint: #e3e0db;
    }
    figure {
      background: var(--qv-white);
      color: var(--qv-ink);
      border-radius: 14px;
      padding: 12px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .tool {
      height: 28px;
      min-width: 28px;
      padding: 0 8px;
      border: 1px solid var(--diagram-line);
      border-radius: 8px;
      background: transparent;
      color: var(--diagram-grey);
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition:
        color 150ms ease-out,
        border-color 150ms ease-out;
    }
    .tool:hover:not(:disabled) {
      border-color: var(--qv-orange);
      color: var(--qv-orange);
    }
    .tool:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .small {
      font-size: 11px;
      color: var(--diagram-grey);
    }
    /* Cut off rather than wrapping or pushing the toolbar wider. */
    .hint {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .alert {
      margin-bottom: 8px;
      font-size: 14px;
      color: var(--qv-orange);
    }
    .frame {
      display: block;
      width: 100%;
      touch-action: none;
      border: 1px solid var(--diagram-line);
      border-radius: 14px;
      background: var(--diagram-card);
      fill: var(--qv-ink);
      cursor: grab;
    }
    .frame.grabbing {
      cursor: grabbing;
    }
    .grey {
      fill: var(--diagram-grey);
    }
    figcaption {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      margin-top: 8px;
    }
    figcaption > span {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dimmed {
      opacity: 0.25;
    }
    /* Sweeping the pointer across the graph passes over a card and the gap
       after it in a few frames; a fade keeps that from flashing. */
    .card,
    .wire {
      transition: opacity 150ms ease-out;
    }
    .card rect {
      transition:
        fill 150ms ease-out,
        stroke-width 150ms ease-out;
    }
    /* The dash pattern is one dot per gap; shifting it by one gap a period
       moves every dot forward onto the next one's place. */
    .grains {
      animation: grains linear infinite;
    }
    @keyframes grains {
      from {
        stroke-dashoffset: var(--grain-gap);
      }
      to {
        stroke-dashoffset: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card,
      .wire,
      .card rect {
        transition: none;
      }
      .grains {
        animation: none;
      }
    }
    .card:focus {
      outline: none;
    }
    figure.fullscreen {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      padding: 1.25rem;
    }
    figure.fullscreen > svg {
      flex: 1;
      min-height: 0;
    }
  `,
})
export class FlowDiagram {
  readonly graph = input.required<MxlGraph>();
  protected readonly hoveredCard = signal<string | null>(null);
  protected readonly focusedCard = signal<string | null>(null);
  /**
   * A clicked card keeps its highlight while the pointer goes elsewhere. A
   * refresh that drops the card drops the selection with it, rather than
   * leaving a key behind that outranks every hover.
   */
  protected readonly selectedCard = linkedSignal<readonly Card[], string | null>({
    source: () => this.layout().cards,
    computation: (cards, previous) =>
      previous && cards.some((card) => card.key === previous.value) ? previous.value : null,
  });
  protected readonly activeCard = computed(() => {
    const cards = this.layout().cards;
    return (
      [this.selectedCard(), this.hoveredCard(), this.focusedCard()].find(
        (key) => key && cards.some((card) => card.key === key),
      ) ?? null
    );
  });
  protected readonly highlightedWires = computed(() => {
    const key = this.activeCard();
    return new Set(
      this.layout()
        .wires.filter((w) => w.from === key || w.to === key)
        .map((w) => w.key),
    );
  });
  protected readonly highlightedCards = computed(() => {
    const key = this.activeCard();
    return new Set(
      key
        ? [
            key,
            ...this.layout()
              .wires.filter((w) => this.highlightedWires().has(w.key))
              .flatMap((w) => [w.from, w.to]),
          ]
        : [],
    );
  });
  protected readonly orderedWires = computed(() => {
    const selected = this.highlightedWires();
    return [...this.layout().wires].sort(
      (a, b) => Number(selected.has(a.key)) - Number(selected.has(b.key)),
    );
  });
  protected readonly document = inject(DOCUMENT);
  protected readonly fullscreen = signal(false);
  protected readonly fullscreenError = signal('');
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');

  protected syncFullscreen(): void {
    this.fullscreen.set(this.document.fullscreenElement === this.container().nativeElement);
  }

  /**
   * Escape in fullscreen belongs to leaving fullscreen, and the selection
   * survives it; a second Escape clears it. Browsers mostly keep that key to
   * themselves, but one that passes it on must not clear the selection too.
   */
  protected unselectUnlessFullscreen(): void {
    if (this.document.fullscreenElement) return;
    this.selectedCard.set(null);
    // The keys stay in the diagram while a card has focus, so Escape is also
    // the way out of it for the keyboard.
    this.focusedCard.set(null);
    const active = this.document.activeElement;
    if (active instanceof SVGElement && this.frame()?.nativeElement.contains(active)) {
      active.blur();
    }
  }

  protected async toggleFullscreen(): Promise<void> {
    this.fullscreenError.set('');
    try {
      if (this.document.fullscreenElement === this.container().nativeElement) {
        await this.document.exitFullscreen();
      } else {
        await this.container().nativeElement.requestFullscreen();
      }
    } catch (error) {
      console.error('Could not change graph fullscreen mode', error);
      this.fullscreenError.set('Could not change fullscreen mode. Please try again.');
    }
  }

  protected readonly STEP = STEP;

  private readonly frame = viewChild<ElementRef<SVGSVGElement>>('frame');

  /** The drawing is laid out once at its own size and moved inside a frame
   *  as wide as the page, rather than the frame growing to fit it: a cluster
   *  with a dozen nodes draws wider than any screen, and scrolling a picture
   *  sideways loses the boundary the picture is about. The frame keeps the
   *  drawing's proportions; one as tall as the drawing in its own units left
   *  a wide cluster scaled down into a band of white. */
  protected readonly scale = signal(1);
  protected readonly tx = signal(0);
  protected readonly ty = signal(0);
  protected readonly panning = signal(false);

  private from: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;

  protected readonly view = computed(
    () => `translate(${this.tx()},${this.ty()}) scale(${this.scale()})`,
  );
  protected readonly percent = computed(() => Math.round(this.scale() * 100));
  protected readonly SELECTION_HINT =
    'To unselect, click it again. Use the arrow keys or Tab to move to a neighbour.';

  protected reset(): void {
    this.scale.set(1);
    this.tx.set(0);
    this.ty.set(0);
  }

  /** Zoom about the middle of the frame, which is what a button press means. */
  protected zoomBy(factor: number): void {
    const box = this.size();
    this.zoomAbout(factor, box.w / 2, box.h / 2);
  }

  /**
   * Zoom while holding one point still.
   *
   * A point p of the drawing sits at t + k*p in the frame. Keeping it under
   * the same place as k becomes k' means t' = t + (k - k')*p, and p itself is
   * read back out of where the pointer is now.
   */
  private zoomAbout(factor: number, atX: number, atY: number): void {
    const k = this.scale();
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k * factor));
    if (next === k) return;
    const px = (atX - this.tx()) / k;
    const py = (atY - this.ty()) / k;
    this.tx.set(this.tx() + (k - next) * px);
    this.ty.set(this.ty() + (k - next) * py);
    this.scale.set(next);
  }

  /**
   * Wheel zoom, but only while a modifier is held.
   *
   * The diagram sits in a page that scrolls, and a wheel that zoomed on its
   * own would trap the scroll of anybody who happened to pass over it.
   */
  protected wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const at = this.toDrawing(event);
    this.zoomAbout(event.deltaY < 0 ? STEP : 1 / STEP, at.x, at.y);
  }

  protected grab(event: PointerEvent): void {
    // Panning must not leave a clicked card's keyboard-focus highlight behind.
    event.preventDefault();
    this.focusedCard.set(null);
    this.panning.set(true);
    this.from = { x: event.clientX, y: event.clientY, tx: this.tx(), ty: this.ty(), moved: false };
    this.frame()?.nativeElement.setPointerCapture?.(event.pointerId);
    this.updateHover(event);
  }

  protected toggleSelected(key: string | null): void {
    this.selectedCard.set(key === this.selectedCard() ? null : key);
  }

  /**
   * Arrow keys move to the nearest card in that direction, Tab and Shift+Tab
   * step through the cards column by column. A selection moves along; a card
   * that only has keyboard focus passes the focus on. Without either the keys
   * scroll and tab through the page.
   */
  protected moveSelection(event: KeyboardEvent): void {
    const selected = this.selectedCard();
    const key = selected ?? this.focusedCard();
    if (!key || event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable]')
    ) {
      return;
    }
    const cards = this.layout().cards;
    const from = cards.find((c) => c.key === key);
    if (!from) return;
    let next: Card | undefined;
    if (event.key === 'Tab') {
      const order = [...cards].sort((a, b) => a.x - b.x || a.y - b.y);
      const step = event.shiftKey ? -1 : 1;
      next = order[(order.indexOf(from) + step + order.length) % order.length];
    } else {
      const direction = ARROWS[event.key];
      if (!direction) return;
      next = nearest(from, cards, direction);
    }
    event.preventDefault();
    if (!next) return;
    if (selected) this.selectedCard.set(next.key);
    // Focus follows, so Enter and a screen reader act on the selected card.
    const cardEls = this.frame()?.nativeElement.querySelectorAll<SVGGElement>('.card') ?? [];
    [...cardEls].find((el) => el.dataset['key'] === next.key)?.focus({ preventScroll: true });
  }

  protected drag(event: PointerEvent): void {
    if (this.from) {
      if (Math.hypot(event.clientX - this.from.x, event.clientY - this.from.y) >= CLICK_SLOP_PX) {
        this.from.moved = true;
      }
      const per = this.perPixel();
      this.tx.set(this.from.tx + (event.clientX - this.from.x) * per);
      this.ty.set(this.from.ty + (event.clientY - this.from.y) * per);
    }
    this.updateHover(event);
  }

  private updateHover(event: PointerEvent): void {
    this.hoveredCard.set(this.cardAt(event));
  }

  private cardAt(event: PointerEvent): string | null {
    const rect = this.frame()?.nativeElement.getBoundingClientRect();
    if (
      !rect ||
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return null;
    }
    // Pointer capture hides normal enter/leave events while the drawing moves.
    const point = this.toDrawing(event);
    const x = (point.x - this.tx()) / this.scale();
    const y = (point.y - this.ty()) / this.scale();
    const card = this.layout().cards.find(
      (c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h,
    );
    return card?.key ?? null;
  }

  protected release(event: PointerEvent): void {
    // A press that never moved far is a click, not a pan: it selects what it
    // hit. A pan that comes back to where it started is still a pan.
    const from = this.from;
    if (
      from &&
      !from.moved &&
      event.type === 'pointerup' &&
      Math.hypot(event.clientX - from.x, event.clientY - from.y) < CLICK_SLOP_PX
    ) {
      this.toggleSelected(this.cardAt(event));
    }
    this.panning.set(false);
    this.from = null;
    if (event.type === 'pointercancel') this.hoveredCard.set(null);
    else this.updateHover(event);
    const frame = this.frame()?.nativeElement;
    if (frame?.hasPointerCapture?.(event.pointerId)) {
      frame.releasePointerCapture(event.pointerId);
    }
  }

  /** Drawing units per screen pixel: the frame is scaled to its box by the
   *  viewBox, so a drag of one pixel is not a drag of one unit. */
  private perPixel(): number {
    const el = this.frame()?.nativeElement;
    const rect = el?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0
      ? Math.max(this.size().w / rect.width, this.size().h / rect.height)
      : 1;
  }

  /** Where the pointer is, in the drawing's own coordinates. */
  private toDrawing(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const el = this.frame()?.nativeElement;
    const rect = el?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    const per = this.perPixel();
    return {
      x: (event.clientX - rect.left - rect.width / 2) * per + this.size().w / 2,
      y: (event.clientY - rect.top - rect.height / 2) * per + this.size().h / 2,
    };
  }

  protected readonly PAD = PAD;
  protected readonly TEAL = TEAL;
  protected readonly STROKE = STROKE;
  protected readonly GRAIN_SPEED = GRAIN_SPEED;
  protected readonly PIPE = PIPE;

  protected readonly layout = computed(() => layoutFlows(this.graph()));
  protected readonly size = computed(() => ({ w: this.layout().w, h: this.layout().h }));
  protected readonly hasGrains = computed(() => this.layout().wires.some((w) => this.grainGap(w)));
  protected readonly hasAudio = computed(() =>
    this.layout().wires.some((w) => this.audioPeriod(w)),
  );
  protected readonly hasSets = computed(() => (this.graph().sets ?? []).length > 0);

  /** One entry per kind of line: the two served kinds always, since they are
   *  what the picture is about, and the rest where a line of that kind is
   *  drawn. */
  protected readonly legend = computed((): LegendEntry[] => {
    const drawn = this.layout().wires;
    const has = (local: boolean, state: Wire['state']) =>
      drawn.some((w) => w.local === local && w.state === state);
    return [
      { local: true, state: 'ok' as const, label: "read out of the node's shared memory" },
      { local: false, state: 'ok' as const, label: 'carried across the fabric by the gateway' },
      {
        local: true,
        state: 'pending' as const,
        label: 'on the same node, output not merged here yet',
        show: has(true, 'pending'),
      },
      {
        local: false,
        state: 'pending' as const,
        label: 'waiting on a mirror',
        show: has(false, 'pending'),
      },
      {
        local: false,
        state: 'broken' as const,
        label: 'leg broken or missing',
        show: drawn.some((w) => w.state === 'broken'),
      },
    ].filter((e) => e.show !== false);
  });

  protected short(node: string): string {
    return shortNode(node);
  }

  /** A set's card gives its state dot the end of the first line. */
  protected fitName(c: Card): string {
    return c.kind === 'function'
      ? fit(c.title, CARD_W - 24, NAME_CHAR_PX)
      : fitMiddle(c.title, CARD_W - 40, NAME_CHAR_PX);
  }

  protected fitClass(cls: string): string {
    return fit(cls, CARD_W - 24, CLASS_CHAR_PX);
  }

  /** What the line's tooltip says carries it, and at what rate. */
  protected how(w: Wire): string {
    const rate = w.rate
      ? ` at ${Number(w.rate.toFixed(2))} fps`
      : w.channels
        ? `, ${w.channels} ${w.channels === 1 ? 'channel' : 'channels'}`
        : '';
    if (w.state === 'broken') return 'not delivered';
    if (w.local) {
      return w.state === 'ok' ? `shared memory${rate}` : 'shared memory, not merged here yet';
    }
    return w.state === 'ok'
      ? `mirrored across the fabric${rate}`
      : 'waiting on a mirror across the fabric';
  }

  /** How far apart a served line's frames are drawn, or 0 where it draws
   *  none: nothing moves through a line still waiting or broken, and a flow
   *  without a grain rate has no frames to count. */
  protected grainGap(w: Wire): number {
    if (w.state !== 'ok' || !w.rate || w.rate <= 0) return 0;
    return Math.max(MIN_GRAIN_GAP, Math.round((GRAIN_SPAN / w.rate) * 10) / 10);
  }

  /** How long one burst and the gap after it are on a served audio line, or
   *  0 where it draws none: as for frames, nothing moves through a line still
   *  waiting or broken, and a line with a frame rate draws its frames. */
  protected audioPeriod(w: Wire): number {
    if (w.state !== 'ok' || w.rate || !w.channels || w.channels <= 0) return 0;
    return BURSTS * (w.channels * BAR_PITCH + BURST_GAP);
  }

  /** Two dash patterns per bar height, each drawing only its own bars and
   *  leaving a zero-length dash where another height's bar goes, so the
   *  patterns stay aligned and move as one run of bursts. A bar is drawn in
   *  thirds, the middle one full height and the outer two shorter, so its
   *  ends read as rounded rather than square. */
  protected audioTiers(w: Wire): AudioTier[] {
    const random = seeded(w.key);
    const bursts = Array.from({ length: BURSTS }, () => burstTiers(w.channels ?? 0, random));
    const third = BAR / 3;
    const dash = (tier: number, bar: number[]) =>
      bursts
        .flatMap((burst) =>
          burst.map((t, i) => {
            const slot = t === tier ? [...bar] : [0, BAR_PITCH];
            slot[slot.length - 1] += i === burst.length - 1 ? BURST_GAP : 0;
            return slot;
          }),
        )
        .flat()
        .join(' ');
    return BAR_HEIGHT.flatMap((height, tier) => {
      const full = (this.width(w) + PIPE) * height;
      return [
        { width: full, dash: dash(tier, [0, third, third, BAR_PITCH - 2 * third]) },
        { width: full - BAR / 2, dash: dash(tier, [third, third, third, BAR_PITCH - BAR]) },
      ];
    });
  }

  protected stroke(w: LineStyle): string {
    if (w.state === 'broken') return STROKE.broken;
    return w.local ? STROKE.local : STROKE.remote;
  }

  /** Solid while the read is served, dashed while it waits on a mirror,
   *  dotted where a leg is broken or has nothing to carry. */
  protected dash(w: LineStyle): string | null {
    if (w.state === 'broken') return '2 3';
    return w.state === 'pending' ? '5 4' : null;
  }

  /** A read out of shared memory costs nothing and is drawn thin. */
  protected width(w: LineStyle): number {
    return w.local ? 1.5 : 2.5;
  }

  protected fill(c: Card): string {
    if (this.activeCard() === c.key) return SOURCE_FILL[this.border(c)];
    return c.kind === 'output' ? 'var(--diagram-output)' : 'var(--diagram-card)';
  }

  protected border(c: Card): CardBorder {
    if (c.kind !== 'function') return TEAL;
    return c.writes ? WRITER_BORDER : READER_BORDER;
  }

  protected dot(c: Card): string {
    return DOT[c.state ?? 'pending'];
  }

  protected readonly summary = computed(() => {
    const { cards, nodes, wires } = this.layout();
    const functions = cards.filter((c) => c.kind === 'function').length;
    const crossings = wires.filter((w) => !w.local && w.kind === 'read').length;
    const real = nodes.filter((n) => n.name).length;
    const sets = (this.graph().sets ?? []).length;
    return (
      `${functions} functions on ${real} nodes, ${crossings} reads carried across the fabric` +
      (sets ? `, ${sets} redundancy ${sets === 1 ? 'set' : 'sets'}` : '')
    );
  });
}
