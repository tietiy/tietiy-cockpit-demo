// app.js — cockpit chart bootstrap.
// Adapted from the legacy tietiy-chart index.html, split into modules.
// Two changes from the legacy version:
//   (1) data via GET /data/ohlcv/<SYM>  (NOT data/<SYM>.json with ISO-date strings)
//       time field is integer epoch seconds — aligns with locked Anchor.t convention.
//   (2) NO silent sample fallback. A failed fetch surfaces a visible error state.

import { fetchUniverse, fetchOhlcv, fetchRunDates, fetchPrimitives } from './data_loader.js';
import { renderPrimitives, clearPrimitives } from './primitive_renderer.js';

// ---- chart setup ----
const chartEl = document.getElementById('chart');
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background:{ type:'solid', color:'#0b0d10' }, textColor:'#6b7280', fontFamily:"'IBM Plex Mono', monospace", fontSize:11 },
  grid:   { vertLines:{ color:'rgba(35,39,46,0.5)' }, horzLines:{ color:'rgba(35,39,46,0.5)' } },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
    vertLine: { color:'#454b54', width:1, style:3, labelBackgroundColor:'#23272e' },
    horzLine: { color:'#454b54', width:1, style:3, labelBackgroundColor:'#23272e' },
  },
  rightPriceScale: { borderColor:'#23272e', scaleMargins:{ top:0.08, bottom:0.26 } },
  timeScale: {
    borderColor:'#23272e',
    rightOffset:5,
    // barSpacing in PIXELS per bar. The PERSISTENT zoom knob — survives setData
    // operations (unlike setVisibleLogicalRange, which LWC Issue #1107 documents
    // as silently reset by subsequent setData calls). With ~1000px chart width
    // and barSpacing=5, ~200 bars fit on screen at default — close to the 250-bar
    // ~1yr target. The post-setData setVisibleLogicalRange call (see
    // _applyDefaultZoom) is a refinement on top of this baseline.
    barSpacing: 14,
    timeVisible:false,
    secondsVisible:false,
    // NOTE: fixLeftEdge intentionally OMITTED. fixLeftEdge:true blocks
    // setVisibleLogicalRange when the requested window would shift the left edge
    // past bar 0 — silently ignores our default-zoom call.
  },
  handleScale: { mouseWheel:true, pinch:true },
});

const candle = chart.addCandlestickSeries({
  upColor:'#3fb27f', downColor:'#e2574c',
  borderUpColor:'#3fb27f', borderDownColor:'#e2574c',
  wickUpColor:'#3fb27f', wickDownColor:'#e2574c',
});

const volume = chart.addHistogramSeries({ priceFormat:{ type:'volume' }, priceScaleId:'' });
volume.priceScale().applyOptions({ scaleMargins:{ top:0.80, bottom:0 } });

const sma50  = chart.addLineSeries({ color:'#d9a94e', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
// SMA200 default-HIDDEN per Aproova "one MA, not three" — operator toggles via t-sma200.
const sma200 = chart.addLineSeries({ color:'#5b8fd9', lineWidth:1, priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false, visible: false });
// Zigzag — two-layer (MAJOR + MINOR), industry-standard MTF zigzag convention:
//   MAJOR zigzag (5% reversal): green up-legs + red down-legs, lineWidth 3, with
//                                vertex dots. The PRIMARY trend structure.
//   MINOR zigzag (2% reversal): single muted color, lineWidth 1, no vertex dots.
//                                The BACKDROP — every ATR-level swing visible.
//   Visual hierarchy: major = primary signal; minor = fine-structure context.
// Slider filters major + lookback (the "primary" tier); minor always shows since
// it's the structural backdrop already filtered algorithmically at 2%.
const zigzagUpLegSeries = chart.addLineSeries({
  color:'#3fb27f', lineWidth:3, lineStyle:0,
  priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
  pointMarkersVisible:true, pointMarkersRadius:4,
});
const zigzagDownLegSeries = chart.addLineSeries({
  color:'#e2574c', lineWidth:3, lineStyle:0,
  priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
  pointMarkersVisible:true, pointMarkersRadius:4,
});
const zigzagMinorSeries = chart.addLineSeries({
  // Minor zigzag styling — distinct purple, visibly subordinate to major's bold
  // green/red but obvious enough to read as a layer. Purple avoids clashing with
  // every other palette element (gold SMA50, blue SMA200, green/red candles/major).
  color:'#a78bfa', lineWidth:2, lineStyle:0,
  priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
  pointMarkersVisible:false,
});
// P3-3 trendlines — two line series (one green for UP, one red for DOWN). Each emitted
// trendline becomes a 2-point segment with a whitespace gap separator (same pattern as
// zigzag major up/down). Dashed style + thin width keeps them visible-but-subordinate.
const trendlinesUpSeries = chart.addLineSeries({
  color:'rgba(63,178,127,0.65)', lineWidth:1, lineStyle:2,
  priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
});
const trendlinesDownSeries = chart.addLineSeries({
  color:'rgba(226,87,76,0.65)', lineWidth:1, lineStyle:2,
  priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
});
// Prior-fib line series (one per emitted prior-fib level). Cockpit currently emits
// up to 6 prior-fib levels per swing; allocate 6 line series at startup, then setData
// per render (empty arrays for unused slots). Each is a 2-point segment from the
// prior swing's start_t to end_t — does NOT extend across the chart (operator directive).
// Color: muted cool-blue, distinct from current's warm gold.
const PRIOR_FIB_SERIES_COUNT = 6;
const priorFibSeries = [];
for (let i = 0; i < PRIOR_FIB_SERIES_COUNT; i++) {
  priorFibSeries.push(chart.addLineSeries({
    color: 'rgba(140, 160, 200, 0.55)', lineWidth: 1, lineStyle: 2,    // dashed muted blue
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  }));
}

// S/R ZONE CANVAS OVERLAY — true filled rectangles via a <canvas> layered on top of the
// LWC chart. LWC v4 has no native rectangle primitive; AreaSeries.baseValue.type=price
// was broken (silently fell back to baseValue=0 → cloud bug). Canvas overlay is the
// LWC-v4 standard pattern for shaded zones (see joshyattridge/smart-money-concepts,
// AlphaX SMC, every LuxAlgo zone indicator).
//
// Architecture:
//   1. Append a <canvas id="sr-overlay-canvas"> inside #chart's parent (.chart-area)
//   2. Resize canvas to match chart's drawing area on every ResizeObserver tick
//   3. On every render + every visible-range change, clear canvas + draw each zone:
//      x_start = timeScale().timeToCoordinate(zone.start_t)
//      x_end   = timeScale().timeToCoordinate(latest_bar_t)
//      y_top   = candle.priceToCoordinate(zone.price_hi)
//      y_bot   = candle.priceToCoordinate(zone.price_lo)
//      ctx.fillRect(x_start, y_top, x_end - x_start, y_bot - y_top)
//
// Caveats: priceToCoordinate is per-series — we use candle's. timeToCoordinate returns
// null for times outside visible range — handle by clamping to chart edges.

// Canvas-overlay init wrapped in try/catch — if ANY of this throws synchronously, the
// rest of the module (bootstrap IIFE included) must still run. Defensive wrapper.
let _srZonesToDraw = [];
let overlayCanvas = null;
let overlayCtx = null;
let _chartHost = null;
// CHoCH trigger line state (gold dashed horizontal level — in BEAR: nearest unmitigated LH;
// in BULL: nearest unmitigated HL). Distinct from S/R bands. Declared TDZ-safe up top.
let _chochTriggerPrice = null;
let _chochTriggerLabel = null;
let _chochTriggerDir   = null;
let _chochTriggerT     = null;  // timestamp of the LH/HL pivot — used by fib widget anchor
// Trendlines for canvas-overlay rendering — list of {anchors, color, width, dashed, label}.
// Drawn on the same overlay canvas as zones + CHoCH trigger, with tier-based styling
// (HTF bold, internal medium, tactical thin dashed) so the operator can see the
// structural-vs-tactical hierarchy at a glance.
let _trendlinesToDraw = [];
// Fib retracement levels for canvas-overlay rendering — bounded segments anchored on
// the swing range (swing_start_t → swing_end_t + small extend). Renders as a contained
// "fib window" per practitioner-mockup feedback (2026-06-02), not stretched across the
// full chart width like createPriceLine did.
let _fibsToDraw = [];
function _resizeOverlayDimsOnly() {
  if (!overlayCanvas || !_chartHost) return;
  const rect = _chartHost.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.width = rect.width * dpr;
  overlayCanvas.height = rect.height * dpr;
  overlayCanvas.style.width = rect.width + 'px';
  overlayCanvas.style.height = rect.height + 'px';
  if (overlayCtx) overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function _resizeOverlayCanvas() {
  _resizeOverlayDimsOnly();
  _drawSRZoneOverlay();
}
try {
  _chartHost = document.getElementById('chart');
  overlayCanvas = document.createElement('canvas');
  overlayCanvas.id = 'sr-overlay-canvas';
  _chartHost.parentElement.appendChild(overlayCanvas);
  overlayCtx = overlayCanvas.getContext('2d');
  new ResizeObserver(_resizeOverlayCanvas).observe(_chartHost);
  _resizeOverlayDimsOnly();
} catch (e) {
  console.error('SR overlay canvas init failed:', e);
  // Module continues to load — overlay will be a no-op.
}

function _drawFibsOverlay() {
  if (!overlayCanvas || !overlayCtx || !_fibsToDraw.length) return;
  if (typeof candle === 'undefined' || !candle) return;
  const ts = chart.timeScale();
  for (const fib of _fibsToDraw) {
    const x0 = ts.timeToCoordinate(fib.start_t);
    const x1 = ts.timeToCoordinate(fib.end_t);
    const y  = candle.priceToCoordinate(fib.price);
    if (x0 === null || x1 === null || y === null) continue;
    overlayCtx.strokeStyle = fib.color;
    overlayCtx.lineWidth = fib.lineWidth;
    if (fib.dashed) overlayCtx.setLineDash([4, 4]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x0, y);
    overlayCtx.lineTo(x1, y);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
    // Label sits just to the RIGHT of the segment end (outside the swing window),
    // matching the mockup's "fib retracement legend" placement. Bumped to 11px BOLD
    // and white-tinted color for visibility on dark chart background.
    overlayCtx.font = 'bold 11px "IBM Plex Mono", monospace';
    overlayCtx.textAlign = 'left';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillStyle = fib.labelColor || fib.color;
    overlayCtx.fillText(fib.label, x1 + 5, y);
  }
}

function _drawTrendlinesOverlay() {
  if (!overlayCanvas || !overlayCtx || !_trendlinesToDraw.length) return;
  if (typeof candle === 'undefined' || !candle) return;
  const ts = chart.timeScale();
  for (const tl of _trendlinesToDraw) {
    if (!tl.anchors || tl.anchors.length < 2) continue;
    const [a0, a1] = tl.anchors;
    const x0 = ts.timeToCoordinate(a0.t);
    const x1 = ts.timeToCoordinate(a1.t);
    const y0 = candle.priceToCoordinate(a0.price);
    const y1 = candle.priceToCoordinate(a1.price);
    if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
    overlayCtx.strokeStyle = tl.color;
    overlayCtx.lineWidth = tl.width;
    if (tl.dashed) overlayCtx.setLineDash([7, 5]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x0, y0);
    overlayCtx.lineTo(x1, y1);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
    // Tier label at the right end (where the line projects to today)
    if (tl.label) {
      overlayCtx.fillStyle = tl.color;
      overlayCtx.font = 'bold 10px "IBM Plex Mono", monospace';
      overlayCtx.textAlign = 'right';
      overlayCtx.textBaseline = 'bottom';
      overlayCtx.fillText(tl.label, x1 - 6, y1 - 4);
    }
  }
}

function _drawChochTrigger() {
  if (!overlayCanvas || !overlayCtx || _chochTriggerPrice === null) return;
  if (typeof candle === 'undefined' || !candle) return;
  const y = candle.priceToCoordinate(_chochTriggerPrice);
  if (y === null || y === undefined) return;
  const w = overlayCanvas.width / (window.devicePixelRatio || 1);

  // Gold dashed horizontal line — distinct from S/R red/blue.
  overlayCtx.strokeStyle = 'rgba(245, 200, 90, 0.95)';
  overlayCtx.lineWidth = 1.5;
  overlayCtx.setLineDash([10, 5]);
  overlayCtx.beginPath();
  overlayCtx.moveTo(0, y);
  overlayCtx.lineTo(w, y);
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);

  // Label — gold, bold, top-right of the line, with directional arrow
  overlayCtx.font = 'bold 11px "IBM Plex Mono", monospace';
  overlayCtx.textAlign = 'right';
  overlayCtx.textBaseline = 'bottom';
  overlayCtx.fillStyle = 'rgba(255, 220, 130, 1.0)';
  const arrow = _chochTriggerDir === 'above' ? '⇧' : '⇩';
  overlayCtx.fillText(`${arrow} CHoCH TRIGGER ${_chochTriggerPrice.toFixed(2)}`, w - 8, y - 4);
}

function _drawSRZoneOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  const w = overlayCanvas.width / (window.devicePixelRatio || 1);
  const h = overlayCanvas.height / (window.devicePixelRatio || 1);
  overlayCtx.clearRect(0, 0, w, h);
  // Try/catch around let-declared vars — TDZ throws on `typeof`, this is the safe path.
  let bars;
  try { bars = currentBars; } catch (e) { return; }
  if (!bars || !bars.length) return;
  // CHoCH trigger drawn first so SR labels (drawn last) can sit on top if they overlap.
  _drawChochTrigger();
  // Trendlines drawn on overlay — tier-styled (HTF bold, internal medium, tactical thin).
  _drawTrendlinesOverlay();
  // (fib overlay moved to AFTER the zone loop — see end of function — so fib lines
  // and labels render on TOP of zone fillRects instead of being covered by them.)
  if (!_srZonesToDraw.length) { _drawFibsOverlay(); return; }

  const ts = chart.timeScale();
  const latestT = currentBars[currentBars.length - 1].time;

  for (const z of _srZonesToDraw) {
    let xStart = ts.timeToCoordinate(z.start_t);
    let xEnd   = ts.timeToCoordinate(latestT);
    const yTop = candle.priceToCoordinate(z.price_hi);
    const yBot = candle.priceToCoordinate(z.price_lo);

    if (yTop === null || yBot === null) continue;   // band not in visible price range
    // Clamp x to chart bounds. If start is left of visible range, clamp to 0.
    if (xStart === null) xStart = 0;
    if (xEnd === null)   xEnd = w;
    if (xEnd <= xStart) continue;

    // Fill the rectangle
    overlayCtx.fillStyle = z.fill;
    overlayCtx.fillRect(xStart, yTop, xEnd - xStart, yBot - yTop);

    // Border (top + bottom lines for clarity) — heavier line for HTF-confirmed zones
    if (z.border) {
      overlayCtx.strokeStyle = z.border;
      overlayCtx.lineWidth = z.border_width || 1;
      if (z.dashed) overlayCtx.setLineDash([4, 3]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(xStart, yTop);  overlayCtx.lineTo(xEnd, yTop);
      overlayCtx.moveTo(xStart, yBot);  overlayCtx.lineTo(xEnd, yBot);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
    }

    // Zone label — small monospace text inside the band at the right edge
    if (z.label) {
      overlayCtx.font = '11px "IBM Plex Mono", monospace';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.textAlign = 'right';
      const labelY = (yTop + yBot) / 2;
      // Label sits 8px in from the right edge of the band
      overlayCtx.fillStyle = z.label_color || z.border;
      overlayCtx.fillText(z.label, xEnd - 8, labelY);
    }
  }
  // Fibs LAST — paint on top of zone fills so their lines + labels stay visible
  // even where they overlap a zone (e.g. 0.618 retracement inside the SUPPLY band).
  _drawFibsOverlay();
}

// Redraw on time-scale change (pan/zoom) and on logical-range change. Wrap in try
// in case LWC v4 changes API surface.
try {
  chart.timeScale().subscribeVisibleTimeRangeChange(_drawSRZoneOverlay);
  chart.timeScale().subscribeVisibleLogicalRangeChange(_drawSRZoneOverlay);
} catch (e) {
  console.error('SR overlay chart-event subscribe failed:', e);
}
// Also redraw after the chart finishes its next animation frame (post-setData re-fits).
function _scheduleOverlayRedraw() {
  requestAnimationFrame(_drawSRZoneOverlay);
  setTimeout(_drawSRZoneOverlay, 50);
  setTimeout(_drawSRZoneOverlay, 200);
}

new ResizeObserver(() => chart.applyOptions({ width:chartEl.clientWidth, height:chartEl.clientHeight })).observe(chartEl);

// ---- helpers ----
function smaSeries(bars, len){
  const out = []; let sum = 0;
  for (let i = 0; i < bars.length; i++){
    sum += bars[i].close;
    if (i >= len) sum -= bars[i-len].close;
    if (i >= len-1) out.push({ time:bars[i].time, value:+(sum/len).toFixed(2) });
  }
  return out;
}
function fmt(n){ return n>=1e7 ? (n/1e7).toFixed(2)+'Cr' : n>=1e5 ? (n/1e5).toFixed(2)+'L' : n>=1e3 ? (n/1e3).toFixed(1)+'k' : ''+n; }
function epochToISO(t){ return new Date(t*1000).toISOString().slice(0,10); }

// ---- state ----
let currentBars = [];
let currentSymbol = null;
let currentPrimitives = {};   // {producer_name: ProducerOutput}
let currentMarkersByTime = {};
let UNIVERSE = [];
let RUN_DATES = [];           // sorted ascending; latest = RUN_DATES.at(-1)
let CURRENT_DATE = null;

const VISIBLE_BARS_DEFAULT = 90;    // ~4.5 months — focus on current narrative (CHoCH→retracement).
                                     // Reduced from 120 — the active swing for most BEAR/BULL setups
                                     // is < 90 bars, and tighter framing makes fibs/zones legible.
                                     // Operator can scroll back; default avoids cramming
                                     // 2y of bars into the screen.
const IMPORTANCE_THRESHOLD_DEFAULT = 10;   // Default keeps the zigzag polyline INTACT.
                                           //
                                           // Zigzag's base 5% reversal threshold already filtered
                                           // the producer's pivots (146 globally on RELIANCE).
                                           // Setting the SLIDER too high (e.g. 30) drops zigzag to
                                           // just ~3-4 visible nodes per year — the line becomes
                                           // long diagonals across multi-month gaps, not a proper
                                           // structure trace. At 10:
                                           //   - zigzag survives essentially fully (~12/yr visible)
                                           //   - lookback filters out the smallest, ~12/yr visible
                                           //   - chart reads as a structural zigzag, NOT a single
                                           //     mega-segment.
                                           // Operator drags UP for sparser, DOWN to see all.

let currentImportanceThreshold = IMPORTANCE_THRESHOLD_DEFAULT;

// P3-1 layer toggles — structure family ON by default; zigzag layers OFF (visual-review
// recommendation 2026-06-01: zigzag was competing with the structure read).
// `presentMode` (H key) overrides all of these for fresh-eye reading of pure candles.
// Default-state philosophy (per cockpit_brain_v1.md Principle #8 + Aproova / Shade of
// Trades research 2026-06-01): the chart shows MINIMAL right-edge active structure.
// Aproova rule: "render every primitive into JSON, but render only the *active subset*
// onto the default chart." Old history stays clean candles; annotations live only at
// the right edge where price could interact with them in the next few bars.
//
// Default chart = candles + ONE moving average + last-3 pivot arrows (most recent
// structural touches) + last-3 HH/HL labels + last 1-2 events within 40 bars +
// corner badge + context box. Everything else is drill-in via Layers ▾.
// FOCUS MODE (operator instruction 2026-06-01): strip the chart down to candles +
// volume + S/R ZONES only while we get S/R-as-zones working correctly. Everything
// else default-OFF. After S/R is locked, we add layers back one by one.
let showPivots      = false;      // FOCUS: off (re-enable later)
let showLabels      = false;      // FOCUS: off
let showEvents      = true;       // BOS/CHoCH inline markers — on by default per practitioner mockup
let showCatalysts   = false;
let showNews        = true;       // News badges on candles ON by default per practitioner mockup
let showSRZones     = true;       // FOCUS: the ONLY structural layer on the chart
let showFibs        = true;
let showTrendlines  = true;
let showZigzagMajor = false;
let showZigzagMinor = false;
let presentMode     = false;

// LWC price lines created via createPriceLine return refs that LIVE on the series.
// We must explicitly remove them via removePriceLine before each re-render — otherwise
// they accumulate (every render adds another N lines).
// SR zones now use 2 lines each (top + bottom bracket): up to 6 total (3 zones × 2 lines).
let currentSRLineRefs = [];
// Right-edge price-axis chips for key levels (CHoCH, zone bounds). Each is an LWC
// priceLine whose line itself is near-invisible; the axis chip on the right is the
// purpose. Refs tracked separately so we can clear+recreate on each render.
let _priceChipRefs = [];
function _clearPriceChips() {
  for (const ref of _priceChipRefs) {
    try { candle.removePriceLine(ref); } catch (e) { /* ignore */ }
  }
  _priceChipRefs.length = 0;
}
function _addPriceChip(price, chipColor) {
  if (!candle || typeof price !== 'number' || !isFinite(price)) return;
  const ref = candle.createPriceLine({
    price,
    color: 'rgba(255,255,255,0.04)',  // line barely visible — axis chip is the focus
    lineWidth: 1,
    lineStyle: 1,                      // dotted
    axisLabelVisible: true,
    axisLabelColor: chipColor,
    axisLabelTextColor: 'rgba(20,22,28,1.0)',
    title: '',
  });
  _priceChipRefs.push(ref);
}
let currentFibLineRefs = [];

// Z-band colors for the SR zone brackets (top line + bottom line per zone).
const SR_BRACKET_COLOR_RESISTANCE = 'rgba(226, 87, 76, 0.85)';   // red
const SR_BRACKET_COLOR_SUPPORT    = 'rgba(91, 143, 217, 0.85)';  // blue
const SR_BRACKET_COLOR_HISTORICAL = 'rgba(232, 200, 112, 0.80)'; // gold dashed

const statusEl   = document.getElementById('status');
const statusText = document.getElementById('status-text');
const symhead    = document.getElementById('symhead');
const placeholder = document.getElementById('placeholder');
const legend     = document.getElementById('legend');
const settlingNote = document.getElementById('settling-zone-note');
const pitDateSel = document.getElementById('pit-date');
const impSlider  = document.getElementById('importance-min');
const impValue   = document.getElementById('importance-value');
const trendBadge = document.getElementById('trend-badge');
const stateBanner = document.getElementById('state-banner');
const bottomPanels = document.getElementById('bottom-panels');
const bpConfluenceBody = document.getElementById('bp-confluence-body');
const bpTradePlansBody = document.getElementById('bp-trade-plans-body');
const bpVpInterpBody   = document.getElementById('bp-vp-interp-body');

// Populate the bottom news-timeline strip (below the 3-panel row) from news_marker
// primitives. Cards sorted newest-first; each card colour-bordered by category and
// carries category-letter chip + date + truncated headline + impact + sentiment tags.
function _buildNewsTimeline() {
  const tl   = document.getElementById('news-timeline');
  const wrap = document.getElementById('nt-cards');
  if (!tl || !wrap) return;
  if (presentMode) { tl.style.display = 'none'; return; }

  const out = currentPrimitives['news_marker'];
  const news = (out?.primitives || []).filter(p => p.kind === 'news_marker');
  if (!news.length) { tl.style.display = 'none'; return; }

  // Sort newest-first by anchor timestamp
  const sorted = news.slice().sort((a, b) => b.anchors[0].t - a.anchors[0].t);
  const LETTER = {
    company: 'C', earnings: 'E', sector: 'S', macro: 'M', rumor: 'R',
  };
  const html = sorted.map(p => {
    const f = p.factors || {};
    const date = new Date(p.anchors[0].t * 1000).toISOString().slice(5, 10);
    const cat = f.category || 'company';
    const letter = LETTER[cat] || 'C';
    return (
      `<div class="nt-card nt-cat-${_esc(cat)}">`+
        `<div class="nt-card-header">`+
          `<span class="nt-cat-letter">${letter}</span>`+
          `<span class="nt-date">${date}</span>`+
        `</div>`+
        `<div class="nt-headline">${_esc(f.headline || '')}</div>`+
        `<div class="nt-footer">`+
          `<span class="nt-impact-${_esc(f.impact || 'medium')}">${_esc((f.impact || 'medium').toUpperCase())}</span>`+
          `<span>·</span>`+
          `<span class="nt-sent-${_esc(f.sentiment || 'neutral')}">${_esc((f.sentiment || 'neutral').toUpperCase())}</span>`+
          (f.price_confirmation && f.price_confirmation !== 'n/a'
            ? `<span>·</span><span class="nt-conf-${_esc(f.price_confirmation)}">${_esc(f.price_confirmation.toUpperCase())}</span>`
            : '') +
        `</div>`+
      `</div>`
    );
  }).join('');
  wrap.innerHTML = html;
  tl.style.display = 'flex';
}

// Populate the three bottom panels (Confluence Zones / Trade Plans / Volume Profile
// Interpretation) per the TIE TIY ANALYSIS mockup. Everything derives from existing
// producer outputs — no new data needed.
function _buildBottomPanels() {
  if (!bottomPanels) return;
  if (presentMode) { bottomPanels.style.display = 'none'; return; }
  const sl = currentPrimitives['structure_label'];
  const sr = currentPrimitives['sr_zones'];
  if (!sl && !sr) { bottomPanels.style.display = 'none'; return; }
  bottomPanels.style.display = 'flex';

  const zones = (sr?.primitives || []).filter(p => p.kind === 'sr_zone');
  const supplyZone = zones.find(z => (z.factors?.classification || '').includes('resistance'));
  const pivotZone  = zones.find(z => z.factors?.classification === 'minor_support');
  const htfDemand  = zones.find(z => z.factors?.htf_confirmed && (z.factors?.classification || '').includes('support'));
  const chochPrice = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;

  // ── Confluence-zone cards ──
  const confluenceHtml = [];
  function _zoneConfluence(z) {
    const f = z.factors || {};
    const parts = [];
    if (f.lifecycle === 'failed_reclaim')   parts.push('Failed Reclaim');
    if (f.lifecycle === 'failed_breakdown') parts.push('Failed Breakdown');
    if (f.lifecycle === 'reclaimed')        parts.push('Reclaimed');
    if (f.lifecycle === 'key')              parts.push('Key Level');
    if (f.lifecycle === 'tested')           parts.push('Tested');
    if (f.htf_confirmed)                    parts.push('HTF Confirmed');
    if (f.touch_count >= 3)                 parts.push(`${f.touch_count}-Touch`);
    return parts.length ? parts.join(' + ') : 'No additional confluence';
  }
  function _zoneUse(z) {
    const f = z.factors || {};
    if ((f.classification || '').includes('resistance')) return 'Nearest Upside Obstacle';
    if (f.classification === 'minor_support')            return 'Short-term Stabilization';
    if (f.htf_confirmed)                                  return 'Major Support / Invalidation';
    return 'Reference level';
  }
  function _zoneLabel(z) {
    const f = z.factors || {};
    if (f.htf_confirmed) return 'HTF DEMAND ZONE';
    if (f.lifecycle === 'failed_reclaim') return 'HTF SUPPLY / FAILED RECLAIM';
    if (f.classification === 'minor_support') return 'PIVOT / BALANCE ZONE';
    if ((f.classification || '').includes('resistance')) return 'MINOR RESISTANCE';
    return 'REFERENCE ZONE';
  }
  function _zoneCardClass(z) {
    const f = z.factors || {};
    if (f.htf_confirmed) return 'cz-demand';
    if ((f.classification || '').includes('resistance')) return 'cz-supply';
    if (f.classification === 'minor_support') return 'cz-pivot';
    return '';
  }
  // Look up confluence producer's primitives so we can attach scores per zone.
  // Match zone↔confluence by overlapping price band.
  const confOut = currentPrimitives['confluence'];
  const confluencePrims = (confOut?.primitives || []).filter(p => p.kind === 'confluence');
  function _findConfluenceFor(zone) {
    const zlo = zone.price_lo, zhi = zone.price_hi;
    for (const c of confluencePrims) {
      if (c.price_lo === zlo && c.price_hi === zhi) return c;
    }
    return null;
  }
  // Sort zones by confluence score (highest first) when available; fall back to price.
  const sortedZones = zones.slice().sort((a, b) => {
    const ca = _findConfluenceFor(a);
    const cb = _findConfluenceFor(b);
    const sa = ca ? (ca.factors?.confluence_score || 0) : 0;
    const sb = cb ? (cb.factors?.confluence_score || 0) : 0;
    if (sa !== sb) return sb - sa;       // higher score first
    return b.price - a.price;            // tiebreak: higher price first
  });
  for (const z of sortedZones) {
    const f = z.factors || {};
    const conf = _findConfluenceFor(z);
    let confLine, scoreLine;
    if (conf && conf.factors) {
      const cf = conf.factors;
      // Use the score-breakdown KEYS as the human-readable confluence list — this is
      // what actually drove the score (e.g. "fib_0.618, struct_choch, htf_weekly_overlap").
      const breakdownKeys = Object.keys(cf.score_breakdown || {});
      const confluenceList = breakdownKeys.length ? breakdownKeys.join(' · ') : _zoneConfluence(z);
      confLine = `<div class="cz-conf"><span class="dim">Confluence (${cf.n_layers}):</span> ${_esc(confluenceList)}</div>`;
      scoreLine = `<div class="cz-score">Score: <strong>${cf.confluence_score}</strong> / 100 <span class="dim">· ${_esc(cf.use_label || '')}</span></div>`;
    } else {
      confLine = `<div class="cz-conf"><span class="dim">Confluence:</span> ${_esc(_zoneConfluence(z))}</div>`;
      scoreLine = '';
    }
    confluenceHtml.push(
      `<div class="cz-card ${_zoneCardClass(z)}">`+
        `<span class="cz-price">${z.price_lo.toFixed(0)} - ${z.price_hi.toFixed(0)}</span>`+
        `<span class="cz-name">${_esc(_zoneLabel(z))}</span>`+
        scoreLine +
        confLine +
        `<div class="cz-use"><span class="dim">Use:</span> ${_esc(_zoneUse(z))}</div>`+
      `</div>`
    );
  }
  if (chochPrice != null) {
    confluenceHtml.unshift(
      `<div class="cz-card cz-choch">`+
        `<span class="cz-price">${chochPrice.toFixed(2)}</span>`+
        `<span class="cz-name">CHoCH TRIGGER (Structure Flip)</span>`+
        `<div class="cz-use">Close above ⇒ trend flips ${(sl?.facts?.trend_state === 'BEAR' ? 'BULL' : 'BEAR')}</div>`+
      `</div>`
    );
  }
  bpConfluenceBody.innerHTML = confluenceHtml.length
    ? confluenceHtml.join('')
    : `<div class="vp-empty">No confluence zones detected</div>`;

  // ── Conditional Trade Plans — derived from setup producer if available, else
  // fall back to static zone-derived templates.
  const plans = [];
  const setupOut = currentPrimitives['setup'];
  const setupPrims = (setupOut?.primitives || []).filter(p => p.kind === 'setup');
  if (setupPrims.length && setupPrims[0].factors?.family !== 'NO_SETUP') {
    // Use real setup primitives
    setupPrims.forEach((sp, idx) => {
      const f = sp.factors || {};
      const targets = (f.target_levels || []).map(n => `₹${(+n).toFixed(0)}`).join(' ⇒ ') || 'TBD';
      plans.push({
        title: `${String.fromCharCode(65 + idx)}. ${(f.setup_name || 'setup').toUpperCase().replace(/_/g,' ')}`,
        cls: idx === 0 ? 'tp-a' : 'tp-b',
        status: (f.status || 'forming').toUpperCase(),
        score: f.confidence_score || 0,
        rows: [
          ['Family',       f.family || ''],
          ['Trigger',      f.trigger || ''],
          ['Invalidation', f.invalidation || ''],
          ['Targets',      targets],
          ['Conditions',   (f.conditions_met || []).slice(0, 3).join(' · ') || '—'],
        ],
      });
    });
  } else if (supplyZone) {
    // Legacy fallback (setup producer absent / NO_SETUP only)
    const slo = supplyZone.price_lo.toFixed(0);
    const shi = supplyZone.price_hi.toFixed(0);
    plans.push({
      title: 'A. SUPPLY RECLAIM SETUP', cls: 'tp-a', status: 'WAIT', score: 0,
      rows: [
        ['Trigger', `Daily close above ${shi} & retest hold`],
        ['Entry',   `Retest of ${slo}-${shi} zone`],
        ['SL',      `Below retest low / below ${slo} - buffer`],
        ['Targets', chochPrice ? `${chochPrice.toFixed(2)} (CHoCH) ⇒ next` : `Next HTF supply`],
      ],
    });
  }
  bpTradePlansBody.innerHTML = plans.length
    ? plans.map(p => {
        const rowsHtml = p.rows.map(([k, v]) =>
          `<div class="tp-row"><span class="tp-k">${_esc(k)}</span><span class="tp-v">${_esc(v)}</span></div>`).join('');
        const statusTxt = p.status || 'WAIT';
        const scoreTxt = (typeof p.score === 'number' && p.score > 0)
          ? ` · score ${p.score}/100` : '';
        return `<div class="tp-card ${p.cls}"><div class="tp-title">${_esc(p.title)}</div>${rowsHtml}<div class="tp-status">${_esc(statusTxt)}${scoreTxt}</div></div>`;
      }).join('')
    : `<div class="vp-empty">No actionable plans for current state</div>`;

  // ── Volume Profile Interpretation ──
  // We don't have a volume_profile producer yet — bullets describe what's KNOWN
  // from zone lifecycles + position, and flag that VAH/POC/VAL await the new producer.
  const bullets = [];
  if (supplyZone && supplyZone.factors?.lifecycle === 'failed_reclaim') {
    bullets.push('Failed-reclaim supply acts as strong overhead resistance');
  }
  if (htfDemand) {
    bullets.push('HTF demand zone (weekly-confirmed) anchors major support');
  }
  if (pivotZone && pivotZone.factors?.lifecycle === 'failed_breakdown') {
    bullets.push('Pivot band was lost then reclaimed — short-term stabilization');
  }
  if (chochPrice != null) {
    bullets.push(`Close above ${chochPrice.toFixed(2)} = trend reversal (CHoCH fires)`);
  }
  bullets.push('VAH / POC / VAL pending — requires volume_profile producer (next session)');
  bpVpInterpBody.innerHTML = bullets
    .map(b => `<div class="vp-bullet"><span class="vp-dot">▸</span><span>${_esc(b)}</span></div>`).join('');
}

// Build the top-of-chart state banner from current primitives. Pure descriptive
// concat of state-tags + a final discipline verdict (Option B, locked 2026-06-01).
// Format: "BEAR STRUCTURE | MINOR RECLAIM | BELOW LOST SUPPLY | WATCH ONLY"
function _buildStateBanner() {
  if (!stateBanner) return;
  if (presentMode) { stateBanner.style.display = 'none'; return; }

  const slOut = currentPrimitives['structure_label'];
  const srOut = currentPrimitives['sr_zones'];
  if (!slOut && !srOut) { stateBanner.style.display = 'none'; return; }

  const trend = slOut?.facts?.trend_state;
  const segments = [];
  let dirClass = 'sb-warn';

  // Segment 1: trend structure
  if (trend === 'BEAR')      { segments.push({text:'BEAR STRUCTURE',  cls:'sb-bear'}); dirClass = 'sb-bear'; }
  else if (trend === 'BULL') { segments.push({text:'BULL STRUCTURE',  cls:'sb-bull'}); dirClass = 'sb-bull'; }
  else                       { segments.push({text:'RANGE STRUCTURE', cls:'sb-warn'}); }

  // Walk sr_zones primitives for lifecycle states.
  const zones = (srOut?.primitives || []).filter(p => p.kind === 'sr_zone');
  const lostSupply = zones.find(z => {
    const f = z.factors || {};
    return f.lifecycle === 'failed_reclaim' && f.classification?.includes('resistance');
  });
  const minorReclaim = zones.find(z => {
    const f = z.factors || {};
    // 'reclaimed' (state machine explicit) OR 'failed_breakdown' on a minor support
    // (price broke below and closed back above — semantically a reclaim).
    return f.classification === 'minor_support'
      && (f.lifecycle === 'reclaimed' || f.lifecycle === 'failed_breakdown');
  });
  const htfTestedKey = zones.find(z => {
    const f = z.factors || {};
    return f.htf_confirmed && (f.lifecycle === 'tested' || f.lifecycle === 'key');
  });

  // Segment 2: minor reclaim
  if (minorReclaim) segments.push({text:'MINOR RECLAIM', cls:''});

  // Segment 3: position relative to lost supply
  if (lostSupply) segments.push({text:'BELOW LOST SUPPLY', cls:'sb-bear'});
  else if (htfTestedKey && trend === 'BEAR') segments.push({text:'HTF DEMAND IN PLAY', cls:''});

  // Segment 4 (Option B verdict): discipline rule — BEAR + below-lost-supply + no major
  // structural flip ⇒ WATCH ONLY. Plain enum-style label, no composite score.
  let verdict = null;
  if (trend === 'BEAR' && lostSupply) verdict = 'WATCH ONLY';
  else if (trend === 'BULL' && minorReclaim) verdict = 'ACTIONABLE IF CONFIRMS';
  else if (trend === 'RANGE' || !trend) verdict = 'NO EDGE';

  // Render
  const parts = [];
  segments.forEach((s, i) => {
    if (i > 0) parts.push('<span class="sb-sep">|</span>');
    parts.push(s.cls ? `<span class="${s.cls}">${s.text}</span>` : s.text);
  });
  if (verdict) {
    parts.push('<span class="sb-sep">|</span>');
    parts.push(`<span class="sb-verdict">${verdict}</span>`);
  }
  stateBanner.innerHTML = parts.join('');
  stateBanner.style.display = 'block';
}
const ddProducersBody = document.getElementById('dd-producers-body');
const ctxContent = document.getElementById('sp-context-content');
const spSelected = document.getElementById('sp-selected');
const spSelectedContent = document.getElementById('sp-selected-content');

function showStatus(kind, text){
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  statusText.textContent = text;
}

function showError(symbol, msg){
  // Hide chart series, show visible error in the placeholder.
  candle.setData([]); volume.setData([]); sma50.setData([]); sma200.setData([]);
  clearPrimitives({
    candle,
    zigzagUp: zigzagUpLegSeries, zigzagDown: zigzagDownLegSeries, zigzagMinor: zigzagMinorSeries,
    trendlinesUp: trendlinesUpSeries, trendlinesDown: trendlinesDownSeries,
  }, currentSRLineRefs);
  currentMarkersByTime = {};
  settlingNote.style.display = 'none';
  trendBadge.style.display = 'none';
  ctxContent.innerHTML = `<div class="sp-warn">no data — ${_esc(msg)}</div>`;
  _srZonesToDraw.length = 0;
  _drawSRZoneOverlay();
  legend.style.display = 'none';
  placeholder.className = 'placeholder nodata';
  placeholder.innerHTML =
    `<div class="big">no data</div>` +
    `<div class="sub">${symbol} — ${msg}</div>`;
  placeholder.style.display = 'flex';
  symhead.innerHTML = `<span class="ticker">${symbol}</span><span class="err">no data — ${msg}</span>`;
  showStatus('error', `error · ${symbol}`);
  // Side panel: show the producer-load error too
  renderProducersPanel({}, msg);
}

function _esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function _fmtNum(n, key){
  if (typeof n !== 'number') return String(n);
  // Epoch-second fields (e.g. last_pivot_t, computed_at) render as ISO date — much
  // more readable than "1777939200.00" for the operator scanning the side panel.
  if (Number.isInteger(n) && key && (key.endsWith('_t') || key === 'computed_at')) {
    return new Date(n * 1000).toISOString().slice(0, 10);
  }
  // Integer counts render as integers — "180" not "180.0000".
  if (Number.isInteger(n)) return String(n);
  // Floats keep precision proportional to magnitude.
  return Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4);
}

function renderProducersPanel(outputs, loadError){
  // Render into the Producers ▾ dropdown body in the controls bar.
  // Side panel no longer carries producer details — context box owns that real-estate now.
  if (loadError) {
    ddProducersBody.innerHTML = `<div class="sp-warn">load failed: ${_esc(loadError)}</div>`;
    return;
  }
  const keys = Object.keys(outputs || {});
  if (!keys.length){
    ddProducersBody.innerHTML = `<div class="sp-dim">no producer outputs at this run date</div>`;
    return;
  }
  const ordered = keys.slice().sort((a,b) => (a === 'primitives_pivots' ? -1 : b === 'primitives_pivots' ? 1 : a.localeCompare(b)));
  let html = '';
  for (const name of ordered){
    const o = outputs[name] || {};
    const conf = o.confidence || '?';
    const caveats = Array.isArray(o.caveats) ? o.caveats : [];
    const facts = o.facts || {};
    const tags = o.state_tags || {};
    const nPrim = Array.isArray(o.primitives) ? o.primitives.length : 0;
    const confClass = conf === 'deterministic' ? 'det' : (conf === 'provisional' ? 'err' : 'tag');
    html += `<div class="sp-h">${_esc(name)}</div>`;
    html += `<div class="sp-row"><span class="k">confidence</span><span class="v ${confClass}">${_esc(conf)}</span></div>`;
    html += `<div class="sp-row"><span class="k">primitives</span><span class="v">${nPrim}</span></div>`;
    for (const [k, v] of Object.entries(facts)) {
      html += `<div class="sp-row"><span class="k">${_esc(k)}</span><span class="v">${_esc(_fmtNum(v, k))}</span></div>`;
    }
    for (const [k, v] of Object.entries(tags)) {
      html += `<div class="sp-row"><span class="k">${_esc(k)}</span><span class="v tag">${_esc(v)}</span></div>`;
    }
    if (caveats.length){
      html += `<div class="sp-section-divider"></div>`;
      for (const c of caveats) html += `<div class="sp-warn">⚠ ${_esc(c)}</div>`;
    }
    html += `<div class="sp-section-divider"></div>`;
  }
  ddProducersBody.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-box generator — turns producer JSON into a plain-language summary
// of "what's happening right now". Side panel's primary real-estate.
// ─────────────────────────────────────────────────────────────────────────────

function _firstNearestAboveBelow(currentPrice, labels){
  let above = null, below = null;
  // Most recent first
  const ordered = labels.slice().sort((a,b) => b.anchors[0].t - a.anchors[0].t);
  for (const lab of ordered){
    if (above === null && lab.price > currentPrice) above = lab;
    if (below === null && lab.price < currentPrice) below = lab;
    if (above && below) break;
  }
  return { above, below };
}

function buildContextBox(symbol, bars, outputs){
  if (!outputs || !outputs.structure_label){
    return `<div class="sp-dim">no structure data for this run</div>`;
  }
  const sl = outputs.structure_label;
  const cm = outputs.catalyst_marker;

  const f = sl.facts || {};
  const trend = f.trend_state || 'TRANSITIONAL';
  const days = f.days_since_last_choch;

  // Primitive lists
  const allPrims = sl.primitives || [];
  const labels = allPrims.filter(p => p.kind === 'structure_label' && p.certainty === 'deterministic');
  const events = allPrims.filter(p => p.kind === 'structure_event')
                         .sort((a,b) => a.anchors[0].t - b.anchors[0].t);
  const lastEvent = events[events.length - 1];
  const lastChoch = [...events].reverse().find(e => e.factors.event_kind === 'CHoCH');

  // Active levels — most-recent-first, unmitigated only
  const unmitigated = labels.filter(l => !l.factors.mitigated_at_t);
  const unmByKind = (kind) => unmitigated
    .filter(l => l.factors.label_kind === kind)
    .sort((a,b) => b.anchors[0].t - a.anchors[0].t);
  const unmHL = unmByKind('HL');
  const unmLH = unmByKind('LH');

  // Current price = last bar's close
  const lastBar = bars[bars.length - 1];
  const currentPrice = lastBar ? lastBar.close : null;

  const arrow = trend === 'BULL' ? '▲' : trend === 'BEAR' ? '▼' : '◆';
  const trendClass = trend === 'BULL' ? 'bull' : trend === 'BEAR' ? 'bear' : 'trans';
  const chochISO = lastChoch ? new Date(lastChoch.anchors[0].t * 1000).toISOString().slice(0,10) : '—';

  let html = '';

  // ── Headline
  html += `<div class="ctx-headline ${trendClass}">`;
  html += `<span class="arr">${arrow}</span><span class="word">${_esc(trend)}</span>`;
  html += `<span class="since">${days != null ? days + 'd' : '—'} since ${_esc(chochISO)}</span>`;
  html += `</div>`;

  // ── Trend start (the CHoCH that established current trend)
  if (lastChoch){
    const ch = lastChoch.factors;
    const dir = ch.trend_after === 'BULL' ? 'above' : 'below';
    const lvlKind = (ch.broke === 'prior_HL' || ch.broke === 'prior_LL') ? 'pivot low' : 'pivot high';
    html += `<div class="ctx-section"><div class="label">Trend start</div>`;
    html += `<div class="body">Close <span class="num">${ch.close.toFixed(2)}</span> broke ${dir} prior ${lvlKind} at <span class="lvl">${ch.level.toFixed(2)}</span>.</div></div>`;
  }

  // ── Last move (could be a BOS in current trend, or the same CHoCH if no BOS after)
  if (lastEvent && lastEvent !== lastChoch){
    const ev = lastEvent.factors;
    const evISO = new Date(lastEvent.anchors[0].t * 1000).toISOString().slice(0,10);
    let dir;
    if (ev.event_kind === 'BOS') dir = ev.trend_before === 'BULL' ? 'bull continuation' : 'bear continuation';
    else dir = 'trend reversal';
    html += `<div class="ctx-section"><div class="label">Last move</div>`;
    html += `<div class="body"><span class="num">${ev.event_kind}</span> on ${evISO} — close <span class="num">${ev.close.toFixed(2)}</span> broke ${ev.broke.replace('_',' ')} at <span class="lvl">${ev.level.toFixed(2)}</span> <span class="dim">(${dir})</span>.</div></div>`;
  }

  // ── Current price + nearest levels
  if (currentPrice !== null){
    const lastISO = new Date(lastBar.time * 1000).toISOString().slice(0,10);
    html += `<div class="ctx-section"><div class="label">Current price <span class="dim">(${lastISO})</span></div>`;
    html += `<div class="body"><span class="num">₹${currentPrice.toFixed(2)}</span>`;
    const { above, below } = _firstNearestAboveBelow(currentPrice, unmitigated);
    if (below){
      const pct = ((currentPrice - below.price) / below.price * 100);
      html += `<br/><span class="dim">▼</span> <span class="num">${pct.toFixed(1)}%</span> above last <span class="dim">${_esc(below.factors.label_kind)}</span> <span class="lvl">${below.price.toFixed(2)}</span>`;
    }
    if (above){
      const pct = ((above.price - currentPrice) / currentPrice * 100);
      html += `<br/><span class="dim">▲</span> <span class="num">${pct.toFixed(1)}%</span> below next <span class="dim">${_esc(above.factors.label_kind)}</span> <span class="lvl">${above.price.toFixed(2)}</span>`;
    }
    html += `</div></div>`;
  }

  // ── Catalyst activity
  if (cm && cm.primitives && cm.primitives.length){
    const cats = cm.primitives.slice().sort((a,b) => a.anchors[0].t - b.anchors[0].t);
    const ninetyDayCut = lastBar ? lastBar.time - (90 * 86400) : 0;
    const recent = cats.filter(c => c.anchors[0].t >= ninetyDayCut);
    const latest = cats[cats.length - 1];
    html += `<div class="ctx-section"><div class="label">Activity</div>`;
    html += `<div class="body"><span class="num">${recent.length}</span> catalyst${recent.length===1?'':'s'} in last 90 days.`;
    if (latest){
      const cf = latest.factors;
      const cISO = new Date(latest.anchors[0].t * 1000).toISOString().slice(0,10);
      html += ` Latest <span class="num">${_esc(cf.direction)}</span> on ${cISO} <span class="dim">(${cf.volume_avg_mult.toFixed(1)}× vol, ${cf.range_atr_mult.toFixed(1)}× ATR)</span>.`;
    }
    html += `</div></div>`;
  }

  // ── Watch — what to look for next (the most actionable line)
  let watch = '';
  if (trend === 'BULL' && unmHL.length){
    const lvl = unmHL[0];
    watch = `Close <b>below <span class="lvl">${lvl.price.toFixed(2)}</span></b> (last HL) would fire CHoCH→BEAR — trend reversal trigger.`;
  } else if (trend === 'BEAR' && unmLH.length){
    const lvl = unmLH[0];
    watch = `Close <b>above <span class="lvl">${lvl.price.toFixed(2)}</span></b> (last LH) would fire CHoCH→BULL — trend reversal trigger.`;
  } else if (trend === 'TRANSITIONAL'){
    if (unmLH[0] && unmHL[0]){
      watch = `Close <b>above <span class="lvl">${unmLH[0].price.toFixed(2)}</span></b> (last LH) commits to BULL, or <b>below <span class="lvl">${unmHL[0].price.toFixed(2)}</span></b> (last HL) commits to BEAR.`;
    } else if (unmLH[0]){
      watch = `Close <b>above <span class="lvl">${unmLH[0].price.toFixed(2)}</span></b> (last LH) commits to BULL.`;
    } else if (unmHL[0]){
      watch = `Close <b>below <span class="lvl">${unmHL[0].price.toFixed(2)}</span></b> (last HL) commits to BEAR.`;
    }
  }
  if (watch){
    html += `<div class="ctx-watch"><span class="label">Watch</span><div>${watch}</div></div>`;
  }

  return html;
}

function updateContextBox(outputs){
  if (!currentSymbol || !currentBars.length){
    ctxContent.innerHTML = `<div class="sp-dim">load a symbol to see the read</div>`;
    return;
  }
  ctxContent.innerHTML = buildDashboardPanel(currentSymbol, currentBars, outputs || {});
  // Reset side-panel scroll so STRUCTURE STATE row is visible — operators land at top.
  const sidePanel = document.getElementById('side-panel');
  if (sidePanel) sidePanel.scrollTop = 0;
  // Populate the fib mini-chart canvas (HTML placeholder was emitted by the dashboard).
  _drawFibMiniChart(outputs);
  // Volume profile mini-widget — computed on-the-fly from active swing bars.
  _drawVolProfileMini(outputs);
}

// Mini fib-retracement chart — scaled candles for the active swing + fib levels overlaid.
// Self-contained canvas rendering. Independent of the main chart's LWC instance so it
// can't be clobbered by zoom/pan/re-fit races.
function _drawFibMiniChart(outputs) {
  const canvas = document.getElementById('fib-mini-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  // Scale canvas for DPR (sharp on retina)
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 240;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
  }
  ctx.clearRect(0, 0, cssW, cssH);

  if (_chochTriggerPrice === null || _chochTriggerT === null) return;
  if (!currentBars.length) return;

  const sl = outputs?.structure_label;
  const trend = (sl?.facts?.trend_state) || 'BEAR';

  // Slice bars to the active swing window (CHoCH → today, plus 5 bars context before).
  // Cap to last 60 bars so candles stay wide enough to read on a 320px canvas.
  const startT = _chochTriggerT - 5 * 86400;
  let after = currentBars.filter(b => b.time >= startT);
  if (after.length > 60) after = after.slice(after.length - 60);
  if (after.length < 5) return;

  // Determine swing high/low
  let swingHigh, swingLow;
  if (trend === 'BEAR') {
    const lowBar = after.reduce((m, b) => b.low < m.low ? b : m, after[0]);
    swingHigh = _chochTriggerPrice;
    swingLow  = lowBar.low;
  } else {
    const highBar = after.reduce((m, b) => b.high > m.high ? b : m, after[0]);
    swingHigh = highBar.high;
    swingLow  = _chochTriggerPrice;
  }
  const range = swingHigh - swingLow;
  if (range <= 0) return;

  // Layout: reserve right column for fib labels
  const padL = 6, padR = 70, padT = 8, padB = 8;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const priceMin = swingLow  - 0.04 * range;
  const priceMax = swingHigh + 0.04 * range;
  const yOfPrice = (p) => padT + ((priceMax - p) / (priceMax - priceMin)) * plotH;
  const n = after.length;
  const xOfIdx = (i) => padL + ((i + 0.5) / n) * plotW;
  const barW = Math.max(1.5, (plotW / n) - 1);

  // Draw fib lines FIRST (so candles overlay)
  const FIB_RATIOS = [
    { r: 0.000, label: '0%',    kind: 'endpoint' },
    { r: 0.236, label: '23.6%', kind: 'mid'      },
    { r: 0.382, label: '38.2%', kind: 'mid'      },
    { r: 0.500, label: '50%',   kind: 'mid'      },
    { r: 0.618, label: '61.8%', kind: 'golden'   },
    { r: 0.786, label: '78.6%', kind: 'golden'   },
    { r: 1.000, label: '100%',  kind: 'endpoint' },
  ];
  // Read SR zones from outputs to detect confluence (fib level lands inside a zone).
  const zones = ((outputs?.sr_zones?.primitives) || []).filter(z => z.kind === 'sr_zone');
  const supplyZ = zones.find(z => (z.factors?.classification || '').includes('resistance'));
  const demandZ = zones.find(z => z.factors?.htf_confirmed && (z.factors?.classification || '').includes('support'));

  for (const fr of FIB_RATIOS) {
    const price = trend === 'BEAR'
      ? (swingLow + (1 - fr.r) * range)
      : (swingLow + fr.r * range);
    const y = yOfPrice(price);
    let strokeColor, labelColor, lw;
    if (fr.kind === 'endpoint')      { strokeColor = 'rgba(255,255,255,0.85)'; labelColor = 'rgba(255,255,255,1.0)'; lw = 1.3; }
    else if (fr.kind === 'golden')   { strokeColor = 'rgba(200,160,255,0.85)'; labelColor = 'rgba(210,170,255,1.0)'; lw = 1.2; }
    else                              { strokeColor = 'rgba(160,170,190,0.6)';  labelColor = 'rgba(180,190,210,0.95)'; lw = 1.0; }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW + 4, y);
    ctx.stroke();
    // Confluence detection: does this fib level land inside a zone?
    let conf = '';
    if (supplyZ && price >= supplyZ.price_lo && price <= supplyZ.price_hi) conf = 'SUP';
    else if (demandZ && price >= demandZ.price_lo && price <= demandZ.price_hi) conf = 'DEM';
    // Label to the right of the line, with optional confluence flag.
    ctx.fillStyle = labelColor;
    ctx.font = 'bold 9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${fr.label} ₹${price.toFixed(1)}`, padL + plotW + 8, y);
    if (conf) {
      ctx.fillStyle = conf === 'SUP' ? 'rgba(255,120,120,1.0)' : 'rgba(120,220,160,1.0)';
      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      ctx.fillText(`◆${conf}`, padL + plotW + 8, y + 8);
    }
  }

  // Draw candles
  for (let i = 0; i < n; i++) {
    const b = after[i];
    const cx = xOfIdx(i);
    const yH = yOfPrice(b.high);
    const yL = yOfPrice(b.low);
    const yO = yOfPrice(b.open);
    const yC = yOfPrice(b.close);
    const isUp = b.close >= b.open;
    const stroke = isUp ? 'rgba(80,200,140,0.95)' : 'rgba(220,90,80,0.95)';
    const fill   = isUp ? 'rgba(80,200,140,0.85)' : 'rgba(220,90,80,0.85)';
    // wick
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(cx, yH);
    ctx.lineTo(cx, yL);
    ctx.stroke();
    // body
    ctx.fillStyle = fill;
    const bodyTop = Math.min(yO, yC);
    const bodyBot = Math.max(yO, yC);
    ctx.fillRect(cx - barW/2, bodyTop, barW, Math.max(1, bodyBot - bodyTop));
  }

  // Mark current price with a small triangle on the right edge
  const lastBar = after[after.length - 1];
  const yCur = yOfPrice(lastBar.close);
  ctx.fillStyle = 'rgba(245,200,90,1.0)';
  ctx.beginPath();
  ctx.moveTo(padL + plotW + 2, yCur);
  ctx.lineTo(padL + plotW - 4, yCur - 4);
  ctx.lineTo(padL + plotW - 4, yCur + 4);
  ctx.closePath();
  ctx.fill();
}

// ── Volume Profile mini-widget — fixed range across the active swing bars.
// Bins price into N buckets (~20 wide), sums each bar's volume into the bucket(s) it
// touched, finds POC (highest-volume bucket), VAH/VAL (top/bottom of value-area = 70%
// of total volume around POC). Renders as a horizontal histogram with POC/VAH/VAL lines.
function _drawVolProfileMini(outputs) {
  const canvas = document.getElementById('vp-mini-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 200;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
  }
  ctx.clearRect(0, 0, cssW, cssH);

  if (_chochTriggerT === null || !currentBars.length) return;
  const startT = _chochTriggerT - 5 * 86400;
  const swingBars = currentBars.filter(b => b.time >= startT);
  if (swingBars.length < 5) return;

  // Price range across swing
  const lows  = swingBars.map(b => b.low);
  const highs = swingBars.map(b => b.high);
  const pMin = Math.min(...lows);
  const pMax = Math.max(...highs);
  const range = pMax - pMin;
  if (range <= 0) return;

  // Bin: 24 price buckets
  const N_BINS = 24;
  const bins = new Array(N_BINS).fill(0);
  const binSize = range / N_BINS;
  for (const b of swingBars) {
    // Approximate: distribute the bar's volume across the buckets it spans.
    const lo = Math.max(0, Math.floor((b.low  - pMin) / binSize));
    const hi = Math.min(N_BINS - 1, Math.floor((b.high - pMin) / binSize));
    const span = Math.max(1, hi - lo + 1);
    const v = b.volume / span;
    for (let i = lo; i <= hi; i++) bins[i] += v;
  }

  // POC = max-volume bin
  let pocIdx = 0;
  let maxV = 0;
  let totalV = 0;
  for (let i = 0; i < N_BINS; i++) {
    if (bins[i] > maxV) { maxV = bins[i]; pocIdx = i; }
    totalV += bins[i];
  }
  // Value area: expand from POC outward until cumulative >= 70% of total.
  const targetV = totalV * 0.70;
  let vaTop = pocIdx, vaBot = pocIdx;
  let accumV = bins[pocIdx];
  while (accumV < targetV && (vaTop < N_BINS - 1 || vaBot > 0)) {
    const upV = vaTop < N_BINS - 1 ? bins[vaTop + 1] : -1;
    const dnV = vaBot > 0 ? bins[vaBot - 1] : -1;
    if (upV >= dnV) { vaTop += 1; accumV += upV; }
    else            { vaBot -= 1; accumV += dnV; }
  }
  const pocPrice = pMin + (pocIdx + 0.5) * binSize;
  const vahPrice = pMin + (vaTop + 1) * binSize;
  const valPrice = pMin + vaBot * binSize;

  // Layout
  const padL = 6, padR = 78, padT = 8, padB = 8;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const yOfBin = (i) => padT + ((N_BINS - 1 - i) / N_BINS) * plotH + (plotH / N_BINS / 2);
  const barHeight = Math.max(2, plotH / N_BINS - 1);

  // Histogram bars
  for (let i = 0; i < N_BINS; i++) {
    const w = (bins[i] / maxV) * plotW;
    const y = yOfBin(i) - barHeight / 2;
    if (i === pocIdx) {
      ctx.fillStyle = 'rgba(245,200,90,0.90)';
    } else if (i >= vaBot && i <= vaTop) {
      ctx.fillStyle = 'rgba(140,180,230,0.65)';
    } else {
      ctx.fillStyle = 'rgba(110,130,160,0.45)';
    }
    ctx.fillRect(padL, y, w, barHeight);
  }

  // POC / VAH / VAL labels on the right
  const labels = [
    { y: yOfBin(pocIdx), label: `POC ₹${pocPrice.toFixed(1)}`, color: 'rgba(255,210,110,1.0)' },
    { y: yOfBin(vaTop),  label: `VAH ₹${vahPrice.toFixed(1)}`, color: 'rgba(200,225,255,1.0)' },
    { y: yOfBin(vaBot),  label: `VAL ₹${valPrice.toFixed(1)}`, color: 'rgba(200,225,255,1.0)' },
  ];
  ctx.font = 'bold 9px "IBM Plex Mono", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const l of labels) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, l.y);
    ctx.lineTo(padL + plotW + 4, l.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = l.color;
    ctx.fillText(l.label, padL + plotW + 8, l.y);
  }
}

// Dashboard panel — replaces the prose buildContextBox with a structured row layout
// matching the TIE TIY ANALYSIS mockup (30 May 2025 reference image).
// Trade Readiness + Decision Confidence are composite scores per CLAUDE.md §5.3
// (Option B, 2026-06-01) — they carry an in-DOM breakdown showing each contributor.
function buildDashboardPanel(symbol, bars, outputs) {
  if (!outputs || !outputs.structure_label) {
    return `<div class="sp-dim">no structure data for this run</div>`;
  }
  const sl = outputs.structure_label;
  const sr = outputs.sr_zones;
  const lastBar = bars[bars.length - 1];
  const currentPrice = lastBar ? lastBar.close : null;

  const trendState = (sl.facts || {}).trend_state || 'TRANSITIONAL';
  const zones = (sr?.primitives || []).filter(p => p.kind === 'sr_zone');

  const hasMinorReclaim = zones.some(z => {
    const f = z.factors || {};
    return f.classification === 'minor_support'
      && (f.lifecycle === 'reclaimed' || f.lifecycle === 'failed_breakdown');
  });
  const hasLostSupply = zones.some(z => {
    const f = z.factors || {};
    return f.lifecycle === 'failed_reclaim'
      && (f.classification || '').includes('resistance');
  });
  const htfDemand = zones.find(z => {
    const f = z.factors || {};
    return f.htf_confirmed && (f.classification || '').includes('support');
  });
  const supplyZone = zones.find(z => (z.factors?.classification || '').includes('resistance'));
  const pivotZone  = zones.find(z => z.factors?.classification === 'minor_support');

  // ── Structure state (composed enum)
  let structureStateText;
  if (trendState === 'BEAR' && hasMinorReclaim) structureStateText = 'Bearish Recovery';
  else if (trendState === 'BEAR') structureStateText = 'Bearish';
  else if (trendState === 'BULL') structureStateText = 'Bullish';
  else structureStateText = 'Range';

  // ── Decision (discipline-rule enum)
  let decision, decisionClass;
  if (trendState === 'BEAR' && hasLostSupply)         { decision = 'Watch Only';            decisionClass = 'val-warn'; }
  else if (trendState === 'BULL' && hasMinorReclaim)  { decision = 'Actionable If Confirms'; decisionClass = 'val-bull'; }
  else                                                 { decision = 'No Edge';                decisionClass = 'val-dim'; }

  // ── TRADE READINESS composite (0-100) + score_breakdown per §5.3 ──
  // Inputs (each 0-25): location_quality, structure_alignment, risk_definable, confirmation_present.
  // Heuristic weights — calibration is a Phase-8 Validation Gate task.
  let loc_quality, struct_align, risk_def, confirmation;
  if (hasLostSupply) {
    loc_quality   = 8;   // below failed supply = poor entry zone
    struct_align  = 10;  // recovery in bear = counter-trend, modest
    risk_def      = 15;  // SL placeable below HTF demand
    confirmation  = 5;   // no fresh bullish reversal candle confirmed
  } else if (htfDemand && currentPrice && Math.abs(currentPrice - htfDemand.price) / htfDemand.price < 0.015) {
    loc_quality   = 22;  // price at HTF demand — high-quality entry zone
    struct_align  = 18;
    risk_def      = 20;
    confirmation  = 12;
  } else {
    loc_quality   = 12;  // mid-zone or unclear
    struct_align  = 12;
    risk_def      = 12;
    confirmation  = 8;
  }
  const trade_readiness = loc_quality + struct_align + risk_def + confirmation;

  // ── DECISION CONFIDENCE composite (0-100) + score_breakdown per §5.3 ──
  // Inputs (each 0-25): structure_clarity, level_quality, location_clarity, evidence_alignment, data_trust.
  // Note: 5×25=125 max — caps to 100. Penalties subtract from raw.
  const sc_structure_clarity = (trendState !== 'TRANSITIONAL') ? 22 : 12;
  const sc_level_quality     = (htfDemand && supplyZone) ? 22 : (htfDemand || supplyZone) ? 15 : 8;
  const sc_location_clarity  = (hasLostSupply || hasMinorReclaim) ? 20 : 10;
  let   sc_evidence_alignment = 18;
  if (trendState === 'BEAR' && hasMinorReclaim) sc_evidence_alignment -= 4;  // mild contradiction
  const sc_data_trust        = 18;  // settling-zone caveat means not 25
  let decision_confidence = sc_structure_clarity + sc_level_quality + sc_location_clarity + sc_evidence_alignment + sc_data_trust;
  decision_confidence = Math.max(0, Math.min(100, decision_confidence));

  // ── Active structure narrative (CHoCH trigger price) ──
  const chochPrice = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;
  const activeStructure = chochPrice != null
    ? `${trendState === 'BEAR' ? 'Bearish' : 'Bullish'} until close ${trendState === 'BEAR' ? 'above' : 'below'} ₹${chochPrice.toFixed(2)}`
    : 'No CHoCH trigger derived';

  // ── Price location narrative ──
  const locParts = [];
  if (hasLostSupply)                                              locParts.push('Below Failed Supply');
  if (pivotZone && currentPrice && currentPrice > pivotZone.price_hi) locParts.push('Above Pivot Band');
  if (htfDemand && currentPrice && currentPrice > htfDemand.price_hi) locParts.push('Above HTF Demand');
  const priceLocation = locParts.length ? locParts.join(' / ') : 'Mid-zone';

  // ── Key Levels Summary table ──
  const levels = [];
  if (chochPrice != null) levels.push({ name:'CHoCH LEVEL (FLIP)', price: chochPrice.toFixed(2),                                    cls:'lv-choch'  });
  if (supplyZone)         levels.push({ name:'HTF SUPPLY ZONE',     price: `${supplyZone.price_lo.toFixed(0)} - ${supplyZone.price_hi.toFixed(0)}`, cls:'lv-supply' });
  if (pivotZone)          levels.push({ name:'PIVOT ZONE',          price: `${pivotZone.price_lo.toFixed(0)} - ${pivotZone.price_hi.toFixed(0)}`,   cls:'lv-pivot'  });
  if (htfDemand)          levels.push({ name:'HTF DEMAND ZONE',     price: `${htfDemand.price_lo.toFixed(0)} - ${htfDemand.price_hi.toFixed(0)}`,   cls:'lv-demand' });

  let html = '';
  html += `<div class="dash-row"><div class="dash-key">STRUCTURE STATE</div><div class="dash-val val-warn">${_esc(structureStateText)}</div></div>`;
  html += `<div class="dash-row"><div class="dash-key">DECISION</div><div class="dash-val ${decisionClass}">${_esc(decision)}</div></div>`;

  html += `<div class="dash-row"><div class="dash-key">TRADE READINESS</div>`;
  html += `<div class="dash-score">${trade_readiness} <span class="dim">/ 100</span></div>`;
  html += `<div class="dash-breakdown">`;
  html += `<div>location_quality &nbsp; ${loc_quality}/25</div>`;
  html += `<div>structure_alignment &nbsp; ${struct_align}/25</div>`;
  html += `<div>risk_definable &nbsp; ${risk_def}/25</div>`;
  html += `<div>confirmation_present &nbsp; ${confirmation}/25</div>`;
  html += `</div></div>`;

  html += `<div class="dash-row"><div class="dash-key">DECISION CONFIDENCE</div>`;
  html += `<div class="dash-val">${decision_confidence}% <span class="dim">in ${_esc(decision)}</span></div>`;
  html += `<div class="dash-breakdown">`;
  html += `<div>structure_clarity &nbsp; ${sc_structure_clarity}/25</div>`;
  html += `<div>level_quality &nbsp; ${sc_level_quality}/25</div>`;
  html += `<div>location_clarity &nbsp; ${sc_location_clarity}/25</div>`;
  html += `<div>evidence_alignment &nbsp; ${sc_evidence_alignment}/25</div>`;
  html += `<div>data_trust &nbsp; ${sc_data_trust}/25</div>`;
  html += `</div></div>`;

  html += `<div class="dash-row"><div class="dash-key">ACTIVE STRUCTURE</div><div class="dash-text">${_esc(activeStructure)}</div></div>`;
  html += `<div class="dash-row"><div class="dash-key">PRICE LOCATION</div><div class="dash-text">${_esc(priceLocation)}</div></div>`;

  // RELATIVE STRENGTH row — stock vs NIFTY500 over 10/20/50 days (doc PART 15).
  const rsFacts = outputs.relative_strength?.facts || null;
  if (rsFacts && rsFacts.rs_classification) {
    const cls = rsFacts.rs_classification;
    const score = rsFacts.rs_score ?? '—';
    const r20 = rsFacts.rs_20d_pct;
    const r50 = rsFacts.rs_50d_pct;
    const corr = rsFacts.correlation_60d;
    const fmt = (n) => typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
    const cssClass = (cls === 'strong_leader' || cls === 'leader' || cls === 'divergent_strength') ? 'val-bull'
                   : (cls === 'laggard' || cls === 'divergent_weakness')                            ? 'val-bear'
                   :                                                                                  'val-warn';
    const corrStr = (typeof corr === 'number') ? corr.toFixed(2) : '—';
    const txt = `${cls.replace(/_/g,' ').toUpperCase()} · 20d ${fmt(r20)} · 50d ${fmt(r50)} · corr ${corrStr} · ${score}/10`;
    html += `<div class="dash-row"><div class="dash-key">RELATIVE STRENGTH</div><div class="dash-text ${cssClass}">${_esc(txt)}</div></div>`;
  }

  // STOCK REGIME row — per-symbol regime (price vs SMA50/200 + momentum).
  const stkFacts = outputs.stock_regime?.facts || null;
  if (stkFacts && stkFacts.stock_regime_color) {
    const color = stkFacts.stock_regime_color;
    const state = stkFacts.stock_regime_state_v1 || '—';
    const cell  = stkFacts.stock_regime_cell || '—';
    const qs    = stkFacts.stock_regime_quality_score ?? '—';
    const mom   = stkFacts.stock_momentum_10d_pct;
    const cls   = color === 'GREEN'    ? 'val-bull'
                : color === 'RED'      ? 'val-bear'
                : color === 'DEEP_RED' ? 'val-bear'
                :                        'val-warn';
    const momStr = (typeof mom === 'number') ? `${mom >= 0 ? '+' : ''}${mom.toFixed(2)}` : '0.00';
    const txt = `${color} · ${state} (${cell}) · 10d ${momStr}% · quality ${qs}/100`;
    html += `<div class="dash-row"><div class="dash-key">STOCK REGIME</div><div class="dash-text ${cls}">${_esc(txt)}</div></div>`;
  }

  // MARKET REGIME row — universe-scope regime classification (NIFTY500-driven).
  // The server merges universe-scope outputs into the per-symbol primitives response,
  // so we read it from the same `outputs` dict (key = 'regime').
  const regimeFacts = outputs.regime?.facts || null;
  if (regimeFacts && regimeFacts.regime_color) {
    const color = regimeFacts.regime_color;
    const state = regimeFacts.regime_state_v1 || '—';
    const cell  = regimeFacts.regime_cell || '—';
    const qs    = regimeFacts.regime_quality_score ?? '—';
    const mom   = regimeFacts.momentum_10d_pct;
    const cls   = color === 'GREEN'      ? 'val-bull'
                : color === 'RED'        ? 'val-bear'
                : color === 'DEEP_RED'   ? 'val-bear'
                :                           'val-warn';
    const momStr = (typeof mom === 'number') ? `${mom >= 0 ? '+' : ''}${mom.toFixed(2)}` : '0.00';
    const txt = `${color} · ${state} (${cell}) · 10d ${momStr}% · quality ${qs}/100`;
    html += `<div class="dash-row"><div class="dash-key">MARKET REGIME</div><div class="dash-text ${cls}">${_esc(txt)}</div></div>`;
  }

  // EVENT RISK row — surfaces the nearest upcoming corp-event + blocking status.
  const erOut = outputs['event_risk'];
  if (erOut && erOut.facts) {
    const erF = erOut.facts;
    const blocking = erF.blocking_active === true;
    let evText, evClass;
    if (blocking) {
      evText = `BLOCKING: ${_esc(erF.next_event_type || erF.last_event_type || 'event')} on ${_esc(erF.next_event_date || erF.last_event_date || '?')} (${_esc(erF.next_event_t_window || 'in window')})`;
      evClass = 'val-bear';
    } else if (typeof erF.next_event_days === 'number') {
      evText = `Next: ${_esc(erF.next_event_type)} in ${erF.next_event_days}d (${_esc(erF.next_event_date)})`;
      evClass = 'val-warn';
    } else if (typeof erF.last_event_days_ago === 'number') {
      evText = `Last: ${_esc(erF.last_event_type)} ${erF.last_event_days_ago}d ago (${_esc(erF.last_event_date)})`;
      evClass = '';
    } else {
      evText = 'No scheduled events';
      evClass = 'val-dim';
    }
    html += `<div class="dash-row"><div class="dash-key">EVENT RISK</div><div class="dash-text ${evClass}">${evText}</div></div>`;
  }

  if (levels.length) {
    html += `<div class="dash-row"><div class="dash-key">KEY LEVELS SUMMARY</div><div class="dash-levels">`;
    for (const lv of levels) {
      html += `<div class="dl-row"><span class="dl-name ${lv.cls}">${_esc(lv.name)}</span><span class="dl-price">${_esc(lv.price)}</span></div>`;
    }
    html += `</div></div>`;
  }

  // ── FIB RETRACEMENT mini-chart widget — self-contained canvas with anchor labels,
  // confluence detection, and bar-window trim. Per user-feedback 2026-06-02 "do all".
  const chochP = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;
  const chochT = (typeof _chochTriggerT === 'number') ? _chochTriggerT : null;
  if (chochP !== null && chochT !== null && bars && bars.length) {
    // Compute swing anchors here (the canvas drawer also computes them, but we need them
    // for the textual header above the canvas).
    const after = bars.filter(b => b.time >= chochT);
    let swingHigh, swingLow, swingHighT, swingLowT;
    if (trendState === 'BEAR') {
      const lowBar = after.reduce((m, b) => b.low < m.low ? b : m, after[0]);
      swingHigh = chochP; swingHighT = chochT;
      swingLow  = lowBar.low; swingLowT = lowBar.time;
    } else {
      const highBar = after.reduce((m, b) => b.high > m.high ? b : m, after[0]);
      swingHigh = highBar.high; swingHighT = highBar.time;
      swingLow  = chochP;       swingLowT  = chochT;
    }
    const dt = (t) => new Date(t * 1000).toISOString().slice(5, 10);
    html += `<div class="dash-row"><div class="dash-key">FIB RETRACEMENT · ACTIVE SWING</div>`;
    html += `<div class="fmc-anchors">`;
    html += `<div class="fmc-anchor"><span class="fmc-lbl">SWING HIGH</span><span class="fmc-val">₹${swingHigh.toFixed(2)}</span><span class="fmc-date">${dt(swingHighT)}</span></div>`;
    html += `<div class="fmc-anchor"><span class="fmc-lbl">SWING LOW</span><span class="fmc-val">₹${swingLow.toFixed(2)}</span><span class="fmc-date">${dt(swingLowT)}</span></div>`;
    html += `</div>`;
    html += `<canvas id="fib-mini-canvas" class="fib-mini-canvas" width="320" height="240"></canvas>`;
    html += `</div>`;

    // ── VOLUME PROFILE mini-widget — computed on-the-fly from swing bars.
    // Bins price into N buckets, sums volume per bucket, marks POC/VAH/VAL.
    // No new producer needed — we have OHLCV.
    html += `<div class="dash-row"><div class="dash-key">VOLUME PROFILE · ACTIVE SWING</div>`;
    html += `<canvas id="vp-mini-canvas" class="vp-mini-canvas" width="320" height="200"></canvas>`;
    html += `</div>`;
  }

  html += `<div class="dash-disclaimer">DECISION SUPPORT TOOL. NOT FINANCIAL ADVICE. TRADE AT YOUR OWN RISK.</div>`;
  return html;
}

function showSelectedPrimitive(entries){
  // entries : [{producer, primitive}, ...]
  if (!entries || !entries.length){
    spSelected.style.display = 'none';
    return;
  }
  spSelected.style.display = 'block';
  let html = '';
  for (const { producer, primitive: p } of entries){
    const f = p.factors || {};
    const t = p.anchors && p.anchors[0] ? p.anchors[0].t : null;
    const date = t ? new Date(t * 1000).toISOString().slice(0,10) : '?';
    html += `<div class="sp-row"><span class="k">producer</span><span class="v">${_esc(producer)}</span></div>`;
    html += `<div class="sp-row"><span class="k">kind</span><span class="v tag">${_esc(p.kind)}</span></div>`;
    html += `<div class="sp-row"><span class="k">date</span><span class="v">${_esc(date)}</span></div>`;
    html += `<div class="sp-row"><span class="k">price</span><span class="v">${_esc(_fmtNum(p.price))}</span></div>`;
    html += `<div class="sp-row"><span class="k">tag</span><span class="v">${_esc((p.tags||[])[0] || '')}</span></div>`;
    html += `<div class="sp-row"><span class="k">importance</span><span class="v">${_esc(p.importance)}</span></div>`;
    html += `<div class="sp-row"><span class="k">certainty</span><span class="v">${_esc(p.certainty)}</span></div>`;
    for (const [k, v] of Object.entries(f)){
      html += `<div class="sp-row"><span class="k">factors.${_esc(k)}</span><span class="v">${_esc(_fmtNum(v, k))}</span></div>`;
    }
    html += `<div class="sp-section-divider"></div>`;
  }
  spSelectedContent.innerHTML = html;
}

// ---- load + render ----
async function loadSymbol(sym){
  currentSymbol = sym;
  showStatus('', `loading ${sym}…`);
  const res = await fetchOhlcv(sym);
  if (!res.ok){ showError(sym, res.error); return; }

  const bars = res.bars;
  currentBars = bars;
  candle.setData(bars.map(b => ({ time:b.time, open:b.open, high:b.high, low:b.low, close:b.close })));
  volume.setData(bars.map(b => ({ time:b.time, value:b.volume,
                                  color: b.close >= b.open ? 'rgba(63,178,127,0.30)' : 'rgba(226,87,76,0.30)' })));
  sma50.setData(smaSeries(bars, 50));
  sma200.setData(smaSeries(bars, 200));

  // (default zoom is applied AFTER primitives load, as the final step — see _applyDefaultZoom below)

  showStatus('live', `live · ${bars.length} bars`);

  // header
  const last = bars[bars.length-1], prev = bars[bars.length-2] || last;
  const chg = last.close - prev.close, chgPct = (chg/prev.close*100);
  const hi52 = Math.max(...bars.map(b=>b.high)), lo52 = Math.min(...bars.map(b=>b.low));
  const up = chg >= 0;
  symhead.innerHTML =
    `<span class="ticker">${sym}</span>` +
    `<span class="last">${last.close.toFixed(2)}</span>` +
    `<span class="chg ${up?'up':'down'}">${up?'▲':'▼'} ${chg.toFixed(2)} (${chgPct.toFixed(2)}%)</span>` +
    `<span class="stat">Last bar <b>${epochToISO(last.time)}</b></span>` +
    `<span class="stat">Period H <b>${hi52.toFixed(2)}</b></span>` +
    `<span class="stat">Period L <b>${lo52.toFixed(2)}</b></span>` +
    `<span class="stat">Vol <b>${fmt(last.volume)}</b></span>` +
    `<span class="stat">Bars <b>${bars.length}</b></span>`;

  placeholder.style.display = 'none';
  placeholder.className = 'placeholder';
  legend.style.display = 'block';

  await loadPrimitivesForCurrent();
  // Final step: apply default zoom AFTER all series (candle/vol/SMA/zigzag) are populated.
  // zigzagSeries.setData() can re-fit the time scale; setting visible range here pins it.
  _applyDefaultZoom();
}

function _applyDefaultZoom(){
  const n = currentBars.length;
  if (n === 0) return;
  if (n <= VISIBLE_BARS_DEFAULT){
    chart.timeScale().fitContent();
    return;
  }
  // Per LWC GitHub Issue #1107, setVisibleLogicalRange can be RESET by subsequent
  // setData calls (including LWC's own internal re-fits triggered after setData
  // on multiple series). Defense: barSpacing in chart options handles the BASELINE
  // zoom (persistent — survives setData), AND we additionally pin the precise
  // range via multiple deferred attempts to outrun any async re-fit.
  const apply = () => {
    chart.timeScale().setVisibleLogicalRange({
      from: n - VISIBLE_BARS_DEFAULT,
      to:   n - 1,
    });
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 50);
  setTimeout(apply, 150);
  setTimeout(apply, 400);
  setTimeout(apply, 900);   // extra-late safety net — beats most LWC internal re-fits
}

// Pivot sources EXEMPT from the importance-slider filter — these are pre-filtered
// algorithmically at the producer level (the minor zigzag's 2% threshold IS the
// "backdrop" filter; the slider is for the primary tier on top of it).
const FILTER_EXEMPT_SOURCES = new Set(['zigzag_minor']);

function _filterOutputsByImportance(outputs, threshold){
  // Display-only filter: drop primitives with importance < threshold. Producer JSON
  // is unchanged on disk. The threshold operates on the existing `importance` field
  // in the schema — no recompute. Pivot sources in FILTER_EXEMPT_SOURCES (currently
  // zigzag_minor) pass through unfiltered as the backdrop layer.
  const out = {};
  for (const [name, o] of Object.entries(outputs || {})){
    const prims = (o.primitives || []).filter(p => {
      const src = p.factors && p.factors.pivot_source;
      if (src && FILTER_EXEMPT_SOURCES.has(src)) return true;
      return (Number(p.importance) || 0) >= threshold;
    });
    out[name] = { ...o, primitives: prims };
  }
  return out;
}

async function loadPrimitivesForCurrent(){
  const series = {
    candle,
    zigzagUp: zigzagUpLegSeries,
    zigzagDown: zigzagDownLegSeries,
    zigzagMinor: zigzagMinorSeries,
  };
  if (!currentSymbol || !CURRENT_DATE){
    clearPrimitives(series);
    currentMarkersByTime = {};
    settlingNote.style.display = 'none';
    renderProducersPanel({}, null);
    return;
  }
  const res = await fetchPrimitives(CURRENT_DATE, currentSymbol);
  if (!res.ok){
    clearPrimitives(series);
    currentMarkersByTime = {};
    settlingNote.style.display = 'none';
    currentPrimitives = {};
    renderProducersPanel({}, res.error);
    return;
  }
  currentPrimitives = res.outputs || {};
  applyImportanceFilterAndRender();
  renderProducersPanel(currentPrimitives, null);
}

function applyImportanceFilterAndRender(){
  // Re-render the chart from `currentPrimitives` after applying the importance slider.
  // Called from: initial load (via loadPrimitivesForCurrent), slider input, PIT-date change.
  // Does NOT change the time scale — preserves the operator's current zoom.
  const series = {
    candle,
    zigzagUp:        zigzagUpLegSeries,
    zigzagDown:      zigzagDownLegSeries,
    zigzagMinor:     zigzagMinorSeries,
    trendlinesUp:    trendlinesUpSeries,
    trendlinesDown:  trendlinesDownSeries,
  };

  // Clear ALL S/R + fib price lines from the previous render before recreating.
  for (const ref of currentSRLineRefs) {
    try { candle.removePriceLine(ref); } catch (e) { /* ignore */ }
  }
  for (const ref of currentFibLineRefs) {
    try { candle.removePriceLine(ref); } catch (e) { /* ignore */ }
  }
  currentSRLineRefs = [];
  currentFibLineRefs = [];

  if (!currentPrimitives || !Object.keys(currentPrimitives).length){
    clearPrimitives(series);
    currentMarkersByTime = {};
    settlingNote.style.display = 'none';
    trendBadge.style.display = 'none';
    if (stateBanner) stateBanner.style.display = 'none';
    if (bottomPanels) bottomPanels.style.display = 'none';
    const _tl = document.getElementById('news-timeline');
    if (_tl) _tl.style.display = 'none';
    updateContextBox({});
    _srZonesToDraw.length = 0;
    _drawSRZoneOverlay();
    return;
  }
  const filtered = _filterOutputsByImportance(currentPrimitives, currentImportanceThreshold);

  // Totals (full set) vs shown (post-filter) — for the status pill
  const totals = { lookback_n10: 0, zigzag: 0, zigzag_minor: 0 };
  for (const out of Object.values(currentPrimitives)){
    for (const p of out.primitives || []){
      const s = p.factors && p.factors.pivot_source;
      if (s && totals[s] !== undefined) totals[s]++;
    }
  }
  // status pill keys

  const renderOpts = {
    showPivots:      showPivots      && !presentMode,
    showLabels:      showLabels      && !presentMode,
    showEvents:      showEvents      && !presentMode,
    showCatalysts:   showCatalysts   && !presentMode,
    showNews:        showNews        && !presentMode,
    showSRZones:     showSRZones     && !presentMode,
    showFibs:        showFibs        && !presentMode,
    showTrendlines:  showTrendlines  && !presentMode,
    showZigzagMajor: showZigzagMajor && !presentMode,
    showZigzagMinor: showZigzagMinor && !presentMode,
  };
  const res = renderPrimitives(series, filtered, renderOpts);
  const { markersByTime, totalZigzagSegments, perSource,
          eventCount, catalystCount, srZoneCount, renderedSRZoneCount,
          actionableResistance, minorSupport, majorSupport, majorResistance,
          trendlineCount, fibLevelCount,
          trendState, daysSinceLastChoch,
          fibLineRefs, priorFibSegments } = res;
  currentFibLineRefs = fibLineRefs || [];

  // ─── S/R zone rendering: TRUE FILLED RECTANGLES via canvas overlay (Phase A) ───
  // The overlay canvas draws shaded boxes anchored on the zone's earliest touch
  // (anchors[0].t) extending to the latest bar. price_hi → top, price_lo → bottom.
  _srZonesToDraw.length = 0;   // clear in-place, don't re-bind (preserves closure refs)
  function _zoneStartT(z) {
    // earliest anchor = oldest touch = where the zone was first established
    if (!z || !z.anchors || !z.anchors.length) return null;
    return Math.min(...z.anchors.map(a => a.t));
  }

  // ── CHoCH trigger derivation (from structure_label primitives) ──
  // In BEAR: nearest unmitigated LH — close above = CHoCH→BULL trigger.
  // In BULL: nearest unmitigated HL — close below = CHoCH→BEAR trigger.
  _chochTriggerPrice = null;
  _chochTriggerLabel = null;
  _chochTriggerDir   = null;
  if (showSRZones && !presentMode) {
    const slOut = currentPrimitives['structure_label'];
    const trend = slOut?.facts?.trend_state;
    const slPrims = slOut?.primitives || [];
    const confirmedLabels = slPrims.filter(p =>
      p.kind === 'structure_label' && p.certainty === 'deterministic'
      && !(p.factors && p.factors.mitigated_at_t)
    );
    if (trend === 'BEAR') {
      const lhs = confirmedLabels
        .filter(p => p.factors.label_kind === 'LH')
        .sort((a, b) => b.anchors[0].t - a.anchors[0].t);
      if (lhs.length) {
        _chochTriggerPrice = lhs[0].price;
        _chochTriggerT     = lhs[0].anchors[0].t;
        _chochTriggerDir   = 'above';
      }
    } else if (trend === 'BULL') {
      const hls = confirmedLabels
        .filter(p => p.factors.label_kind === 'HL')
        .sort((a, b) => b.anchors[0].t - a.anchors[0].t);
      if (hls.length) {
        _chochTriggerPrice = hls[0].price;
        _chochTriggerT     = hls[0].anchors[0].t;
        _chochTriggerDir   = 'below';
      }
    }
  }

  // ── Trendlines → canvas-overlay list (tier-styled) ─────────────────────
  // HTF tier: BOLD WHITE, lineWidth 2.2 — the structural lines a swing trader cares about
  // Internal: medium gray, lineWidth 1.6
  // Tactical: thin dashed, lineWidth 1.1
  // Direction colours: down-lines warm gold, up-lines cool teal — keeps trend-bias readable.
  _trendlinesToDraw.length = 0;
  if (showTrendlines && !presentMode) {
    const tlOut = currentPrimitives['trendlines'];
    for (const p of (tlOut?.primitives || [])) {
      if (p.kind !== 'trendline') continue;
      const tier = (p.factors && p.factors.tier) || 'tactical';
      const dir  = (p.factors && p.factors.direction) || 'down';
      // Age-differentiation within a tier (clever move): even within HTF, a 20-day-old
      // line is the *current* resistance; a 200-day-old one is structural-historical.
      // The operator's eye should land on the recent one first.
      const ageDays = (p.factors && p.factors.bars_since_last_touch) || 0;
      const recent  = ageDays <= 30;
      let color, width, dashed, tierLabel;
      // Palette discipline (2026-06-02): no two layers share the same hue family.
      //   CHoCH trigger  → GOLD
      //   Fibs           → VIOLET / WHITE endpoints
      //   HTF down-line  → ICY CYAN  (fresh) / muted blue-grey (stale)
      //   HTF up-line    → SEA GREEN (fresh) / muted green-grey (stale)
      if (tier === 'htf') {
        if (recent) {
          color  = dir === 'down' ? 'rgba(140,210,255,1.0)' : 'rgba(140,235,180,1.0)';
          width  = 2.6;  dashed = false;
          tierLabel = `HTF TL · fresh`;
        } else {
          color  = dir === 'down' ? 'rgba(120,150,180,0.55)' : 'rgba(110,170,150,0.55)';
          width  = 1.6;  dashed = true;
          tierLabel = `HTF TL · ${ageDays}d old`;
        }
      } else if (tier === 'internal') {
        color  = dir === 'down' ? 'rgba(150,190,230,0.85)' : 'rgba(130,210,180,0.85)';
        width  = 1.6;  dashed = false;
        tierLabel = `Internal TL`;
      } else {
        color  = dir === 'down' ? 'rgba(150,180,210,0.65)' : 'rgba(130,200,170,0.65)';
        width  = 1.1;  dashed = true;
        tierLabel = `Tactical TL`;
      }
      _trendlinesToDraw.push({
        anchors: p.anchors,
        color, width, dashed, label: tierLabel,
      });
    }
  }
  // ── Suppress legacy LWC trendline line-series (canvas overlay takes over) ──
  // Empty arrays clear the old dashed lines so they don't double-render under the
  // tier-styled canvas trendlines.
  if (trendlinesUpSeries)   trendlinesUpSeries.setData([]);
  if (trendlinesDownSeries) trendlinesDownSeries.setData([]);

  // ── Build fib bounded-segment list — RENDERER-DERIVED from current narrative ──
  // (2026-06-02 clever rewrite: the producer's static swings often miss the swing
  // the trader's eye is actually retracing. Use the most-recent CHoCH event high/low
  // as one anchor and the post-CHoCH price extremum as the other. This is what
  // "fib drawn from last swing points" means in practitioner-speak.)
  _fibsToDraw.length = 0;
  if (showFibs && !presentMode && _chochTriggerPrice !== null) {
    const sl = currentPrimitives['structure_label'];
    const trend = (sl?.facts?.trend_state) || 'TRANSITIONAL';
    const slPrims = sl?.primitives || [];
    // The CHoCH trigger price we already derived is the most recent unmitigated LH (BEAR)
    // or HL (BULL). We need its TIMESTAMP too — find it from the unmitigated label list.
    const unmLabels = slPrims.filter(p =>
      p.kind === 'structure_label' && p.certainty === 'deterministic'
      && !(p.factors && p.factors.mitigated_at_t)
    );
    const wantKind = trend === 'BEAR' ? 'LH' : (trend === 'BULL' ? 'HL' : null);
    let anchorT = null;
    if (wantKind) {
      const matches = unmLabels
        .filter(p => p.factors.label_kind === wantKind && Math.abs(p.price - _chochTriggerPrice) < 0.01)
        .sort((a,b) => b.anchors[0].t - a.anchors[0].t);
      if (matches.length) anchorT = matches[0].anchors[0].t;
    }
    if (anchorT !== null && currentBars.length) {
      // Find the post-anchor price extremum (lowest low for BEAR, highest high for BULL).
      // This is the OTHER swing anchor.
      const after = currentBars.filter(b => b.time >= anchorT);
      if (after.length >= 5) {
        let swingHigh, swingLow, swingHighT, swingLowT;
        if (trend === 'BEAR') {
          const lowBar = after.reduce((m, b) => b.low < m.low ? b : m, after[0]);
          swingHigh = _chochTriggerPrice; swingHighT = anchorT;
          swingLow  = lowBar.low;          swingLowT  = lowBar.time;
        } else {
          const highBar = after.reduce((m, b) => b.high > m.high ? b : m, after[0]);
          swingHigh = highBar.high;        swingHighT = highBar.time;
          swingLow  = _chochTriggerPrice;  swingLowT  = anchorT;
        }
        const range = swingHigh - swingLow;
        const lastBarT = currentBars[currentBars.length - 1].time;
        // Color palette for fibs — VIOLET family to avoid clashing with CHoCH gold +
        // HTF-trendline gold. Each layer gets its own hue.
        //   endpoints (0% / 100%) — bright white, solid
        //   golden ratios (0.618, 0.786) — violet, solid, slightly thicker
        //   intermediate (23.6, 38.2, 50) — muted lilac, solid
        const FIB_RATIOS = [
          { r: 0.000, label: '0%',    color: 'rgba(255,255,255,1.0)',  lw: 1.6, golden: false, endpoint: true  },
          { r: 0.236, label: '23.6%', color: 'rgba(190,170,230,0.78)', lw: 1.0, golden: false, endpoint: false },
          { r: 0.382, label: '38.2%', color: 'rgba(190,170,230,0.85)', lw: 1.1, golden: false, endpoint: false },
          { r: 0.500, label: '50%',   color: 'rgba(190,170,230,0.85)', lw: 1.1, golden: false, endpoint: false },
          { r: 0.618, label: '61.8%', color: 'rgba(200,160,255,1.0)',  lw: 1.7, golden: true,  endpoint: false },
          { r: 0.786, label: '78.6%', color: 'rgba(200,160,255,1.0)',  lw: 1.6, golden: true,  endpoint: false },
          { r: 1.000, label: '100%',  color: 'rgba(255,255,255,1.0)',  lw: 1.6, golden: false, endpoint: true  },
        ];
        const startT = Math.min(swingHighT, swingLowT);
        for (const fr of FIB_RATIOS) {
          // For a BEAR swing high→low, retracement % is measured from the LOW back UP.
          // For BULL swing low→high, % is measured from the HIGH back DOWN.
          const price = trend === 'BEAR'
            ? (swingLow + (1 - fr.r) * range)        // 0% at high, 100% at low
            : (swingLow + fr.r * range);
          _fibsToDraw.push({
            start_t: startT,
            end_t:   lastBarT + 3 * 86400,           // small forward extend so labels sit clear
            price,
            color:     fr.color,
            lineWidth: fr.lw,
            dashed:    false,
            labelColor: fr.endpoint ? 'rgba(255,255,255,1.0)'
                       : fr.golden ? 'rgba(220,190,255,1.0)'
                       : 'rgba(200,180,230,1.0)',
            label: `${fr.label} · ${price.toFixed(2)}`,
          });
        }
      }
    }
  }
  // FOUR-TIER hierarchy rendering per practitioner-doc 2026-06-01:
  //   RES (red)              = nearest resistance above price
  //   MAJOR RES (deep red)   = structural resistance further above
  //   MIN SUP (light blue)   = nearest near-term support below price
  //   MAJOR SUP (deep blue)  = structural support — the "break of this = trend invalidation" level
  function _zoneBand(z) {
    const f = (z && z.factors) || {};
    const lo = (typeof f.render_band_lo === 'number') ? f.render_band_lo : z.price_lo;
    const hi = (typeof f.render_band_hi === 'number') ? f.render_band_hi : z.price_hi;
    return { lo, hi };
  }
  // State-aware visual styling (Phase B Step 2). The zone's current state from the
  // state machine (untested/approaching/testing/held/broken/confirmed_broken/
  // reclaimed/mitigated) modifies BOTH color and label tag:
  //   active (untested/approaching/testing/held) → normal colors, no tag
  //   broken / confirmed_broken                  → faded + [BROKEN] tag
  //   reclaimed                                  → green-tinted + [RECLAIMED] tag
  //   mitigated                                  → grey + [MITIGATED] tag
  function _stateStyle(baseFill, baseBorder, baseLabelColor, state) {
    const isBroken    = state === 'broken' || state === 'confirmed_broken';
    const isReclaimed = state === 'reclaimed';
    const isMitigated = state === 'mitigated';
    let fill = baseFill, border = baseBorder, labelColor = baseLabelColor;
    let tag = '';
    if (isMitigated) {
      // Greyed out — still rendered as historical reference, but visually inactive.
      fill        = 'rgba(140, 140, 140, 0.10)';
      border      = 'rgba(160, 160, 160, 0.45)';
      labelColor  = 'rgba(170, 170, 170, 0.85)';
      tag         = ' [MITIGATED]';
    } else if (isBroken) {
      // Faded original color + caution tag — operator sees it WAS resistance/support.
      fill        = baseFill.replace(/[\d.]+\)$/,  '0.10)');
      border      = baseBorder.replace(/[\d.]+\)$/, '0.45)');
      labelColor  = baseLabelColor.replace(/[\d.]+\)$/, '0.70)');
      tag         = state === 'confirmed_broken' ? ' [BROKEN]' : ' [BREAKING]';
    } else if (isReclaimed) {
      // Green tint — recent recovery. Adds a hint of vitality back to the band.
      fill        = 'rgba(80, 180, 110, 0.20)';
      border      = 'rgba(110, 200, 140, 0.85)';
      labelColor  = 'rgba(180, 230, 200, 1.0)';
      tag         = ' [RECLAIMED]';
    }
    return { fill, border, labelColor, tag };
  }
  if (showSRZones && !presentMode) {
    // Trader-grade label per (classification, lifecycle, htf_confirmed).
    // Per practitioner verdict 2026-06-01: replace ambiguous [BROKEN]/[MITIGATED] with
    // SUPPLY [FAILED RECLAIM], PIVOT BAND [BALANCE], HTF DEMAND [TESTED] [KEY], etc.
    function _traderLabel(classification, lifecycle, htfConfirmed) {
      // HTF-confirmed always gets STRUCTURAL nameplate
      if (htfConfirmed) {
        if (classification === 'major_support' || classification === 'minor_support') {
          const tag = (lifecycle === 'tested' || lifecycle === 'tested_recovery') ? '[TESTED] [KEY]'
                    : lifecycle === 'weakened' ? '[WEAKENED] [KEY]'
                    : '[KEY]';
          return { base: 'HTF DEMAND', tag };
        }
        if (classification === 'major_resistance' || classification === 'actionable_resistance') {
          const tag = (lifecycle === 'tested' || lifecycle === 'tested_recovery') ? '[TESTED] [KEY]'
                    : lifecycle === 'weakened' ? '[WEAKENED] [KEY]'
                    : '[KEY]';
          return { base: 'HTF SUPPLY', tag };
        }
      }
      // Non-HTF: lifecycle drives nameplate
      if (classification === 'actionable_resistance' || classification === 'major_resistance') {
        if (lifecycle === 'failed_reclaim')   return { base: 'SUPPLY',     tag: '[FAILED RECLAIM]' };
        if (lifecycle === 'pivot_band')       return { base: 'PIVOT BAND', tag: '[BALANCE]' };
        if (lifecycle === 'lost')             return { base: 'SUPPLY',     tag: '[LOST]' };
        if (lifecycle === 'active_test')      return { base: 'RES',        tag: '[TESTING]' };
        if (lifecycle === 'active_reclaim')   return { base: 'RES',        tag: '[RECLAIMED]' };
        if (lifecycle === 'mitigated')        return { base: 'RES',        tag: '[WEAKENED]' };
        return { base: 'RES', tag: '' };
      }
      if (classification === 'minor_support' || classification === 'major_support') {
        if (lifecycle === 'pivot_band')       return { base: 'PIVOT BAND', tag: '[BALANCE]' };
        if (lifecycle === 'failed_breakdown') return { base: 'DEMAND',     tag: '[DEFENDED]' };
        if (lifecycle === 'lost')             return { base: 'SUP',        tag: '[LOST]' };
        if (lifecycle === 'active_test')      return { base: 'SUP',        tag: '[TESTING]' };
        if (lifecycle === 'active_reclaim')   return { base: 'SUP',        tag: '[RECLAIMED]' };
        if (lifecycle === 'mitigated')        return { base: 'SUP',        tag: '[WEAKENED]' };
        return { base: 'SUP', tag: '' };
      }
      return { base: 'ZONE', tag: '' };
    }

    function _push(z, baseFill, baseBorder, baseLabelColor, _ignoredBaseLabel, dashed) {
      const b = _zoneBand(z);
      const f = z.factors || {};
      const state = f.state || 'untested';
      const lifecycle = f.lifecycle || 'active';
      const htfConfirmed = !!f.htf_confirmed;
      const classification = f.classification || 'minor';
      const s = _stateStyle(baseFill, baseBorder, baseLabelColor, state);
      // HTF upgrade — thicker border, brighter alpha
      let finalBorder = s.border;
      let borderWidth = 1;
      if (htfConfirmed) {
        finalBorder = s.border.replace(/[\d.]+\)$/, '1.0)');
        borderWidth = 2;
      }
      const lbl = _traderLabel(classification, lifecycle, htfConfirmed);
      const labelText = `${lbl.base} ${b.lo.toFixed(0)}-${b.hi.toFixed(0)}${lbl.tag ? ' ' + lbl.tag : ''}`;
      _srZonesToDraw.push({
        start_t: _zoneStartT(z),
        price_lo: b.lo, price_hi: b.hi,
        fill: s.fill, border: finalBorder, border_width: borderWidth, dashed,
        label: labelText,
        label_color: s.labelColor,
      });
    }
    if (actionableResistance)
      _push(actionableResistance, 'rgba(226, 87, 76, 0.22)', 'rgba(226, 87, 76, 0.70)',
            'rgba(255, 180, 175, 0.95)', 'RES', false);
    if (majorResistance)
      _push(majorResistance,      'rgba(180, 50, 50, 0.18)', 'rgba(220, 70, 70, 0.85)',
            'rgba(255, 200, 195, 0.95)', 'MAJ RES', false);
    if (minorSupport)
      _push(minorSupport,         'rgba(91, 143, 217, 0.22)', 'rgba(91, 143, 217, 0.70)',
            'rgba(180, 210, 255, 0.95)', 'MIN SUP', false);
    if (majorSupport)
      _push(majorSupport,         'rgba(45, 95, 200, 0.28)', 'rgba(70, 130, 240, 0.95)',
            'rgba(170, 200, 255, 1.0)', 'MAJ SUP', false);
  }
  _scheduleOverlayRedraw();

  // Update prior-fib line series. Sort by price asc so series index order is stable.
  const priorSegs = (priorFibSegments || []).slice().sort((a, b) => a.level_price - b.level_price);
  for (let i = 0; i < PRIOR_FIB_SERIES_COUNT; i++) {
    if (i < priorSegs.length) {
      const s = priorSegs[i];
      priorFibSeries[i].setData([
        { time: s.start_t, value: s.level_price },
        { time: s.end_t,   value: s.level_price },
      ]);
    } else {
      priorFibSeries[i].setData([]);
    }
  }
  // totalMarkers from renderer counts ALL markers on candle (lookback + events + catalysts);
  // for the status pill we want JUST the lookback count → derive from perSource.
  const lookbackShown = (perSource && perSource.lookback_n10) || 0;
  currentMarkersByTime = markersByTime;

  // Settling-zone note: suppressed by default (2026-06-02 — noise per practitioner mockup).
  // The provisional/deterministic certainty is already encoded per-primitive; operators
  // don't need a chart banner to remind them every 10 bars. Re-enable if needed by removing
  // the constant-false override.
  settlingNote.style.display = 'none';

  // P3-1 corner trend badge — color saturation by freshness (doc §5.8).
  _updateTrendBadge(trendState, daysSinceLastChoch);

  // Status pill: shown/total per source + P3-1 counts.
  const parts = [];
  if (totals.lookback_n10 > 0) parts.push(`lookback=${lookbackShown}/${totals.lookback_n10}`);
  if (totals.zigzag > 0)       parts.push(`major=${totalZigzagSegments}/${totals.zigzag}`);
  if (totals.zigzag_minor > 0) parts.push(`minor=${totals.zigzag_minor}`);
  if (eventCount > 0)          parts.push(`events=${eventCount}`);
  if (catalystCount > 0)       parts.push(`catalysts=${catalystCount}`);
  if (srZoneCount > 0)         parts.push(`sr=${renderedSRZoneCount}/${srZoneCount}`);
  if (trendlineCount > 0)      parts.push(`tl=${trendlineCount}`);
  if (fibLevelCount > 0)       parts.push(`fib=${fibLevelCount}`);
  const bars = currentBars.length;
  if (parts.length){
    showStatus('live', `live · ${bars} bars · ${parts.join(' ')}`);
  } else {
    showStatus('live', `live · ${bars} bars`);
  }

  // Context box — dynamic prose summary from producer outputs (P3-1 doc §6)
  updateContextBox(currentPrimitives);
  // State banner — top-of-chart concat of structure + lifecycle + position + verdict
  _buildStateBanner();
  // Bottom 3 panels — Confluence Zones / Trade Plans / Volume Profile Interpretation
  _buildBottomPanels();
  // News timeline row — chronological card list of news_marker primitives
  _buildNewsTimeline();
  // Right-edge axis chips for the key levels (CHoCH + zone hi/lo). Distinct color per
  // level type so operator can read the price axis at a glance per mockup.
  _clearPriceChips();
  if (showSRZones && !presentMode) {
    if (typeof _chochTriggerPrice === 'number') {
      _addPriceChip(_chochTriggerPrice, 'rgba(245,200,90,1.0)');                       // gold CHoCH
    }
    const srOut = currentPrimitives['sr_zones'];
    for (const z of (srOut?.primitives || [])) {
      if (z.kind !== 'sr_zone') continue;
      const f = z.factors || {};
      let chipColor;
      if (f.htf_confirmed && (f.classification || '').includes('support'))      chipColor = 'rgba(120,220,160,1.0)';  // HTF demand — green
      else if ((f.classification || '').includes('resistance'))                  chipColor = 'rgba(255,120,120,1.0)';  // supply — red
      else if (f.classification === 'minor_support')                              chipColor = 'rgba(170,150,230,1.0)';  // pivot band — purple
      else                                                                        chipColor = 'rgba(150,170,200,0.9)';
      _addPriceChip(z.price_hi, chipColor);
      _addPriceChip(z.price_lo, chipColor);
    }
  }
}

function _updateTrendBadge(trendState, daysSinceLastChoch){
  // doc §5.8 — corner tile, color saturation fades with freshness.
  // <10 bars = saturated bright; 10-40 = mid; >40 = pale.
  if (presentMode || !trendState){
    trendBadge.style.display = 'none';
    return;
  }
  trendBadge.style.display = 'flex';
  const d = (typeof daysSinceLastChoch === 'number') ? daysSinceLastChoch : null;
  const bucket = (d === null || d > 40) ? 'stale' : (d > 10 ? 'mid' : 'fresh');
  const dirClass = trendState === 'BULL' ? 'bull' : (trendState === 'BEAR' ? 'bear' : 'trans');
  trendBadge.className = `trend-badge ${dirClass}-${bucket}`;
  trendBadge.querySelector('.tb-trend').textContent = trendState;
  trendBadge.querySelector('.tb-days').textContent = (d === null) ? '— d' : `${d}d`;
}

// ---- crosshair legend ----
chart.subscribeCrosshairMove(param => {
  if (!param.time || !currentBars.length){
    updateLegend(currentBars[currentBars.length-1]); return;
  }
  const b = currentBars.find(x => x.time === param.time);
  updateLegend(b || currentBars[currentBars.length-1]);
});

// ---- click handler: show primitive(s) at the clicked bar in the side panel ----
chart.subscribeClick(param => {
  if (!param.time) return;
  const entries = currentMarkersByTime[param.time] || [];
  showSelectedPrimitive(entries);
});
function updateLegend(b){
  if (!b){ legend.innerHTML = ''; return; }
  const up = b.close >= b.open;
  legend.innerHTML =
    `<div class="row"><span>${epochToISO(b.time)}</span></div>` +
    `<div class="row"><span>O</span><b>${b.open.toFixed(2)}</b>  <span>H</span><b>${b.high.toFixed(2)}</b></div>` +
    `<div class="row"><span>L</span><b>${b.low.toFixed(2)}</b>  <span>C</span><b style="color:${up?'#3fb27f':'#e2574c'}">${b.close.toFixed(2)}</b></div>`;
}

// ---- search / autocomplete ----
const search   = document.getElementById('search');
const dropdown = document.getElementById('dropdown');
let activeIdx = -1, filtered = [];

function renderDropdown(q){
  q = q.trim().toUpperCase();
  filtered = q ? UNIVERSE.filter(s => s.includes(q)).slice(0,50) : UNIVERSE.slice(0,50);
  activeIdx = -1;
  if (!filtered.length){
    dropdown.innerHTML = `<div class="dd-empty">No match in universe</div>`;
    dropdown.classList.add('open'); return;
  }
  dropdown.innerHTML = filtered.map((s,i) =>
    `<div class="dd-item" data-i="${i}" data-sym="${s}"><span class="sym">${s}</span><span class="tag">chart →</span></div>`
  ).join('');
  dropdown.classList.add('open');
}
function pick(sym){ search.value = sym; dropdown.classList.remove('open'); loadSymbol(sym); search.blur(); }

search.addEventListener('input', () => renderDropdown(search.value));
search.addEventListener('focus', () => renderDropdown(search.value));
search.addEventListener('keydown', e => {
  const items = [...dropdown.querySelectorAll('.dd-item')];
  if      (e.key === 'ArrowDown'){ e.preventDefault(); activeIdx = Math.min(activeIdx+1, items.length-1); }
  else if (e.key === 'ArrowUp')  { e.preventDefault(); activeIdx = Math.max(activeIdx-1, 0); }
  else if (e.key === 'Enter')    { e.preventDefault();
    if (activeIdx >= 0 && filtered[activeIdx]) pick(filtered[activeIdx]);
    else if (filtered.length) pick(filtered[0]);
    return;
  }
  else if (e.key === 'Escape')   { dropdown.classList.remove('open'); return; }
  else return;
  items.forEach((it,i) => it.classList.toggle('active', i === activeIdx));
  if (activeIdx >= 0) items[activeIdx].scrollIntoView({ block:'nearest' });
});
dropdown.addEventListener('mousedown', e => { const it = e.target.closest('.dd-item'); if (it) pick(it.dataset.sym); });
document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) dropdown.classList.remove('open'); });

// ---- overlay toggles ----
function bindToggle(id, onFn, offFn){
  const el = document.getElementById(id);
  el.addEventListener('click', () => { const isOn = el.classList.toggle('on'); isOn ? onFn() : offFn(); });
}
bindToggle('t-sma50',  () => sma50.applyOptions({ visible:true }),  () => sma50.applyOptions({ visible:false }));
bindToggle('t-sma200', () => sma200.applyOptions({ visible:true }), () => sma200.applyOptions({ visible:false }));
bindToggle('t-vol',    () => volume.applyOptions({ visible:true }), () => volume.applyOptions({ visible:false }));
// P3-1 layer toggles — flip state then re-render
// Backward-compat: t-pivots toggle (existing wiring in legacy paths) clears all primitives.
// New code path uses bindToggle below to flip individual state vars.
bindToggle('t-pivots',
  () => { showPivots      = true;  applyImportanceFilterAndRender(); },
  () => { showPivots      = false; applyImportanceFilterAndRender(); });
bindToggle('t-labels',
  () => { showLabels      = true;  applyImportanceFilterAndRender(); },
  () => { showLabels      = false; applyImportanceFilterAndRender(); });
bindToggle('t-events',
  () => { showEvents      = true;  applyImportanceFilterAndRender(); },
  () => { showEvents      = false; applyImportanceFilterAndRender(); });
bindToggle('t-catalyst',
  () => { showCatalysts   = true;  applyImportanceFilterAndRender(); },
  () => { showCatalysts   = false; applyImportanceFilterAndRender(); });
bindToggle('t-sr-zones',
  () => { showSRZones     = true;  applyImportanceFilterAndRender(); },
  () => { showSRZones     = false; applyImportanceFilterAndRender(); });
bindToggle('t-trendlines',
  () => { showTrendlines  = true;  applyImportanceFilterAndRender(); },
  () => { showTrendlines  = false; applyImportanceFilterAndRender(); });
bindToggle('t-fibs',
  () => { showFibs        = true;  applyImportanceFilterAndRender(); },
  () => { showFibs        = false; applyImportanceFilterAndRender(); });
bindToggle('t-zigzag-major',
  () => { showZigzagMajor = true;  applyImportanceFilterAndRender(); },
  () => { showZigzagMajor = false; applyImportanceFilterAndRender(); });
bindToggle('t-zigzag-minor',
  () => { showZigzagMinor = true;  applyImportanceFilterAndRender(); },
  () => { showZigzagMinor = false; applyImportanceFilterAndRender(); });

// Present-mode keyboard toggle (H) — hides ALL P3-1 annotations + badge for fresh-eye reads (doc §6).
document.addEventListener('keydown', e => {
  // Ignore keys typed into form inputs (search field, date selector, slider focus).
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable)) return;
  if (e.key === 'h' || e.key === 'H'){
    presentMode = !presentMode;
    applyImportanceFilterAndRender();
  }
});

// ---- PIT date selector ----
pitDateSel.addEventListener('change', async () => {
  CURRENT_DATE = pitDateSel.value;
  await loadPrimitivesForCurrent();
});

// ---- Importance filter slider (display-only; no recompute) ----
impSlider.addEventListener('input', () => {
  currentImportanceThreshold = Number(impSlider.value) || 0;
  impValue.textContent = String(currentImportanceThreshold);
  applyImportanceFilterAndRender();
});

// ---- bootstrap: load universe + run-dates, then optionally auto-load ?sym= ----
(async () => {
  const [u, rd] = await Promise.all([fetchUniverse(), fetchRunDates()]);
  if (u.ok){
    UNIVERSE = u.symbols;
    showStatus('', `universe loaded · ${UNIVERSE.length} symbols`);
  } else {
    UNIVERSE = [];
    showStatus('error', `universe unavailable: ${u.error}`);
    dropdown.innerHTML = `<div class="dd-empty">universe load failed: ${u.error}</div>`;
  }
  // PIT date selector population
  RUN_DATES = rd.ok ? rd.dates : [];
  pitDateSel.innerHTML = '';
  if (RUN_DATES.length){
    for (const d of RUN_DATES.slice().reverse()){          // newest first in dropdown
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      pitDateSel.appendChild(opt);
    }
    CURRENT_DATE = RUN_DATES[RUN_DATES.length - 1];        // default = latest
    pitDateSel.value = CURRENT_DATE;
  } else {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no runs yet)'; opt.disabled = true;
    pitDateSel.appendChild(opt);
    CURRENT_DATE = null;
  }
  // Deep-link: /?sym=RELIANCE.NS auto-loads on page open (useful for sharing).
  const params = new URLSearchParams(window.location.search);
  const sym = params.get('sym');
  if (sym){ search.value = sym.toUpperCase(); loadSymbol(sym.toUpperCase()); }
})();
