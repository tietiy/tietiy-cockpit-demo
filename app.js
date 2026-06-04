// app.js — cockpit chart bootstrap.
// Adapted from the legacy tietiy-chart index.html, split into modules.
// Two changes from the legacy version:
//   (1) data via GET /data/ohlcv/<SYM>  (NOT data/<SYM>.json with ISO-date strings)
//       time field is integer epoch seconds — aligns with locked Anchor.t convention.
//   (2) NO silent sample fallback. A failed fetch surfaces a visible error state.

import { fetchUniverse, fetchOhlcv, fetchRunDates, fetchPrimitives, fetchV2PlotItems } from './data_loader.js';
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
  // Custom autoscale provider — restrict y-axis to the VISIBLE candle range,
  // ignoring price-line chips. Default LWC behaviour expands the y-axis to
  // include ALL price-lines, which on a narrow viewport (phone) gives a
  // 800-1800 range when candles are 1300-1500. Bound to visible bars + 5/10%
  // margins for breathing room. (2026-06-03)
  autoscaleInfoProvider: (_originalDefault) => {
    if (!currentBars || !currentBars.length) return null;
    // Use the same window the time-scale defaults to (last N bars)
    const N = (typeof VISIBLE_BARS_DEFAULT === 'number') ? VISIBLE_BARS_DEFAULT : 90;
    const visible = currentBars.slice(-N);
    let lo =  Infinity, hi = -Infinity;
    for (const b of visible) {
      if (b.low  < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return null;
    return {
      priceRange: { minValue: lo, maxValue: hi },
      margins:    { above: 0.06, below: 0.14 },   // bottom margin makes room for volume pane
    };
  },
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
let _orderBlocksToDraw = [];
let _sweepsToDraw = [];
let _trapsToDraw = [];
let _candlePsychToDraw = [];
let _wyckoffToDraw = null;
// V2 plot items — the cluster-merged ≤7 items from v2/plot/priority.py.
// Fetched per (symbol, date) from data/v2/plot_items/<date>/<sym>.json.
let _v2PlotItems = null;
let _v2PlotMeta = null;
// Phase 1.C Session 8 — current view mode (Execution / Analysis / History).
// Persists in localStorage so the operator's last choice survives reloads.
let _v2ViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('tietiy_view_mode')) || 'execution';
// Decision-panel collapsed state (operator: "info is getting long to block
// the chart"). When true, the canvas-draw routine skips the panel entirely
// — only the chevron toggle stays visible.
let _v2PanelCollapsed = (typeof localStorage !== 'undefined'
                         && localStorage.getItem('tietiy_panel_collapsed') === '1');
if (typeof document !== 'undefined' && _v2PanelCollapsed) {
  document.body.classList.add('panel-collapsed');
}

// Fetch + draw the V2 plot items for the currently-loaded (symbol, date).
async function _loadAndDrawV2() {
  if (!currentSymbol || !CURRENT_DATE) {
    _v2PlotItems = null;
    _v2PlotMeta = null;
    _scheduleOverlayRedraw();
    return;
  }
  try {
    const res = await fetchV2PlotItems(CURRENT_DATE, currentSymbol);
    if (!res.ok) {
      console.warn('[V2] fetch failed:', res.error);
      _v2PlotItems = [];
      _v2PlotMeta = null;
    } else {
      _v2PlotItems = res.items || [];
      _v2PlotMeta  = {
        n_raw_objects: res.n_raw_objects,
        last_close:    res.last_close,
        atr14:         res.atr14,
        trend_state:   res.trend_state,
        pit_date:      res.date,                       // honest label for CHANGED ON
        decision_panel: res.decision_panel || null,    // V3
        recent_events: res.recent_events || [],        // Phase 1.D §3
        recent_history: res.recent_history || [],      // Phase 1.C §8 HISTORY mode
      };
      console.info(`[V2] ${currentSymbol} @ ${CURRENT_DATE}: ${res.n_raw_objects} raw → ${_v2PlotItems.length} chart items`);
    }
  } catch (e) {
    console.error('[V2] load error:', e);
    _v2PlotItems = [];
    _v2PlotMeta = null;
  }
  _scheduleOverlayRedraw();
}
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

// Order-block overlay — semi-transparent rectangles anchored on the OB candle,
// extending forward until mitigated (or to the current bar if still fresh).
// Step-1 Brain Layer 1, 2026-06-03.
function _drawOrderBlocksOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_orderBlocksToDraw.length) return;
  const ts = chart.timeScale();
  const w = overlayCanvas.width / (window.devicePixelRatio || 1);
  const latestT = currentBars.length ? currentBars[currentBars.length - 1].time : null;
  if (latestT === null) return;

  for (const ob of _orderBlocksToDraw) {
    let xStart = ts.timeToCoordinate(ob.start_t);
    const endT = ob.mitigated_at_t || latestT;
    let xEnd   = ts.timeToCoordinate(endT);
    const yTop = candle.priceToCoordinate(ob.price_hi);
    const yBot = candle.priceToCoordinate(ob.price_lo);
    if (yTop === null || yBot === null) continue;
    if (xStart === null) xStart = 0;
    if (xEnd === null)   xEnd = w;
    if (xEnd <= xStart) continue;

    overlayCtx.fillStyle = ob.fill;
    overlayCtx.fillRect(xStart, yTop, xEnd - xStart, yBot - yTop);

    overlayCtx.strokeStyle = ob.border;
    overlayCtx.lineWidth   = ob.fresh ? 1.5 : 1;
    if (ob.tested && !ob.fresh) overlayCtx.setLineDash([4, 3]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(xStart, yTop); overlayCtx.lineTo(xEnd, yTop);
    overlayCtx.moveTo(xStart, yBot); overlayCtx.lineTo(xEnd, yBot);
    overlayCtx.moveTo(xStart, yTop); overlayCtx.lineTo(xStart, yBot);
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);

    // Small "OB" tag at the left edge so the operator can identify it
    overlayCtx.font = 'bold 9px "JetBrains Mono", monospace';
    overlayCtx.fillStyle = ob.border;
    overlayCtx.textBaseline = 'bottom';
    overlayCtx.textAlign = 'left';
    overlayCtx.fillText('OB', xStart + 3, yTop - 2);
  }
}

// Liquidity-sweep markers — small triangles at the swept wick extremum +
// a dashed connector to the swept pivot. Spring (sweep_low + CHoCH_up) and
// UTAD (sweep_high + CHoCH_down) get a bigger marker + a text label so the
// operator can spot Wyckoff transitions at a glance. 2026-06-03.
function _drawLiquiditySweepsOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_sweepsToDraw.length) return;
  const ts = chart.timeScale();

  for (const s of _sweepsToDraw) {
    const x = ts.timeToCoordinate(s.t);
    const y = candle.priceToCoordinate(s.price);
    if (x === null || y === null) continue;

    const big = s.is_spring || s.is_utad;
    const tri = big ? 9 : 6;
    const dir = (s.direction === 'sweep_low');   // true = upward triangle below price
    const fill   = s.is_spring ? 'rgba(34, 197, 94, 0.95)'
                 : s.is_utad   ? 'rgba(239, 68, 68, 0.95)'
                 : dir         ? 'rgba(34, 197, 94, 0.70)'
                 :               'rgba(239, 68, 68, 0.70)';
    const stroke = big ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)';

    // Connector from swept pivot price to sweep wick — light dashed line so
    // the operator visually pairs the sweep with the level it grabbed.
    if (s.swept_pivot_t && s.swept_pivot_price != null) {
      const xp = ts.timeToCoordinate(s.swept_pivot_t);
      const yp = candle.priceToCoordinate(s.swept_pivot_price);
      if (xp !== null && yp !== null) {
        overlayCtx.strokeStyle = big ? fill : 'rgba(124, 134, 158, 0.45)';
        overlayCtx.lineWidth = big ? 1.4 : 1;
        overlayCtx.setLineDash([3, 3]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(xp, yp); overlayCtx.lineTo(x, y);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);
      }
    }

    // Triangle pointing toward the candle body (sweep_low → ▲ below; sweep_high → ▼ above)
    overlayCtx.beginPath();
    if (dir) {
      // ▲ pointing up, placed just BELOW the wick low
      const yt = y + 4;
      overlayCtx.moveTo(x,        yt);
      overlayCtx.lineTo(x - tri,  yt + tri * 1.4);
      overlayCtx.lineTo(x + tri,  yt + tri * 1.4);
    } else {
      // ▼ pointing down, placed just ABOVE the wick high
      const yt = y - 4;
      overlayCtx.moveTo(x,        yt);
      overlayCtx.lineTo(x - tri,  yt - tri * 1.4);
      overlayCtx.lineTo(x + tri,  yt - tri * 1.4);
    }
    overlayCtx.closePath();
    overlayCtx.fillStyle = fill;
    overlayCtx.fill();
    overlayCtx.strokeStyle = stroke;
    overlayCtx.lineWidth = 1;
    overlayCtx.stroke();

    // Spring/UTAD label badge
    if (big) {
      const label = s.is_spring ? 'SPRING' : 'UTAD';
      overlayCtx.font = 'bold 10px "JetBrains Mono", monospace';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = dir ? 'top' : 'bottom';
      const ly = dir ? y + 4 + tri * 1.4 + 4 : y - 4 - tri * 1.4 - 4;
      // shadow for legibility against candles
      overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
      overlayCtx.fillText(label, x + 1, ly + 1);
      overlayCtx.fillStyle = fill;
      overlayCtx.fillText(label, x, ly);
    }
  }
}

// Trap markers — X-mark at the failure bar + dashed line back to the failed
// BOS level. bull_trap = red (failed bullish breakout); bear_trap = green
// (failed bearish breakdown). Qualified traps (RVOL≥1.5) get a TRAP badge.
function _drawTrapsOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_trapsToDraw.length) return;
  const ts = chart.timeScale();

  for (const t of _trapsToDraw) {
    const x = ts.timeToCoordinate(t.failure_bar_t);
    const y = candle.priceToCoordinate(t.failure_close);
    if (x === null || y === null) continue;
    const bull = (t.direction === 'bull_trap');
    const alpha = t.qualified ? 0.95 : 0.55;
    const color = bull ? `rgba(239, 68, 68, ${alpha})` : `rgba(34, 197, 94, ${alpha})`;

    // Dashed connector from BOS bar to failure bar at the BOS level price
    if (t.bos_event_t && t.bos_level != null) {
      const xb = ts.timeToCoordinate(t.bos_event_t);
      const yb = candle.priceToCoordinate(t.bos_level);
      if (xb !== null && yb !== null) {
        overlayCtx.strokeStyle = color;
        overlayCtx.lineWidth = t.qualified ? 1.4 : 1;
        overlayCtx.setLineDash([3, 3]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(xb, yb); overlayCtx.lineTo(x, yb);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);
      }
    }

    // X-mark at the failure bar (color-coded)
    const sz = t.qualified ? 7 : 5;
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = t.qualified ? 2.2 : 1.5;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - sz, y - sz); overlayCtx.lineTo(x + sz, y + sz);
    overlayCtx.moveTo(x - sz, y + sz); overlayCtx.lineTo(x + sz, y - sz);
    overlayCtx.stroke();

    // TRAP badge for qualified ones (RVOL≥1.5)
    if (t.qualified) {
      const label = bull ? 'BULL TRAP' : 'BEAR TRAP';
      overlayCtx.font = 'bold 9.5px "JetBrains Mono", monospace';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = bull ? 'top' : 'bottom';
      const ly = bull ? y + sz + 4 : y - sz - 4;
      overlayCtx.fillStyle = 'rgba(0,0,0,0.7)';
      overlayCtx.fillText(label, x + 1, ly + 1);
      overlayCtx.fillStyle = color;
      overlayCtx.fillText(label, x, ly);
    }
  }
}

// Candle-psychology overlay — small 1-letter badge near each detected pattern.
// Compact by design: 9px mono letter in a colored circle. Letters:
//   H=hammer  S=shooting_star  E=engulfing  D=doji  P=pin_bar
//   I=inside_bar  O=outside_bar  M=marubozu
const _CP_LETTERS = {
  hammer: 'H', shooting_star: 'S', engulfing: 'E', doji: 'D',
  pin_bar: 'P', inside_bar: 'I', outside_bar: 'O', marubozu: 'M',
};
function _drawCandlePsychOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_candlePsychToDraw.length) return;
  const ts = chart.timeScale();

  for (const cp of _candlePsychToDraw) {
    const x = ts.timeToCoordinate(cp.t);
    const yHi = candle.priceToCoordinate(cp.price_hi);
    const yLo = candle.priceToCoordinate(cp.price_lo);
    if (x === null || yHi === null || yLo === null) continue;
    const letter = _CP_LETTERS[cp.pattern] || '·';
    const isBull = cp.direction === 'bullish';
    const isBear = cp.direction === 'bearish';
    const color = isBull ? 'rgba(34, 197, 94, 0.95)'
                : isBear ? 'rgba(239, 68, 68, 0.95)'
                :          'rgba(174, 182, 194, 0.85)';   // neutral
    // Bullish patterns label below the low; bearish above the high; neutral above.
    const cx = x;
    const cy = isBull ? yLo + 12 : yHi - 12;
    // Small filled circle behind the letter for legibility
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, 7, 0, Math.PI * 2);
    overlayCtx.fillStyle = 'rgba(7, 9, 15, 0.78)';
    overlayCtx.fill();
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 1.2;
    overlayCtx.stroke();
    // Letter
    overlayCtx.font = 'bold 9px "JetBrains Mono", monospace';
    overlayCtx.fillStyle = color;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(letter, cx, cy + 0.5);
  }
}

// Wyckoff phase overlay: Creek/Ice horizontal channel during accumulation/
// distribution + per-event labels at SC/AR/ST/Spring/SOS/LPS/BC/UTAD/SOW/LPSY.
function _drawWyckoffOverlay() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_wyckoffToDraw) return;
  const ts = chart.timeScale();
  const w = overlayCanvas.width / (window.devicePixelRatio || 1);
  const wk = _wyckoffToDraw;

  // Creek/Ice channel (rendered only when channel valid + in accumulation/distribution-context)
  if (wk.channel && wk.channel.valid
      && wk.channel.creek_price != null && wk.channel.ice_price != null) {
    let xs = ts.timeToCoordinate(wk.channel.range_start_t);
    let xe = ts.timeToCoordinate(wk.channel.range_end_t);
    const yC = candle.priceToCoordinate(wk.channel.creek_price);
    const yI = candle.priceToCoordinate(wk.channel.ice_price);
    if (xs === null) xs = 0;
    if (xe === null) xe = w;
    if (yC !== null && yI !== null && xe > xs) {
      // Channel fill (very faint)
      overlayCtx.fillStyle = 'rgba(167, 139, 250, 0.05)';
      overlayCtx.fillRect(xs, yC, xe - xs, yI - yC);
      // Creek (top) — solid violet
      overlayCtx.strokeStyle = 'rgba(167, 139, 250, 0.85)';
      overlayCtx.lineWidth = 1.3;
      overlayCtx.beginPath();
      overlayCtx.moveTo(xs, yC); overlayCtx.lineTo(xe, yC);
      overlayCtx.stroke();
      // Ice (bottom) — dashed violet
      overlayCtx.setLineDash([5, 4]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(xs, yI); overlayCtx.lineTo(xe, yI);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
      // Labels at the right edge
      overlayCtx.font = 'bold 10px "JetBrains Mono", monospace';
      overlayCtx.fillStyle = 'rgba(167, 139, 250, 0.95)';
      overlayCtx.textAlign = 'right';
      overlayCtx.textBaseline = 'bottom';
      overlayCtx.fillText('CREEK', xe - 6, yC - 2);
      overlayCtx.textBaseline = 'top';
      overlayCtx.fillText('ICE',   xe - 6, yI + 2);
    }
  }

  // Event labels at each Wyckoff event
  for (const e of (wk.events || [])) {
    const x = ts.timeToCoordinate(e.t);
    const y = candle.priceToCoordinate(e.price);
    if (x === null || y === null) continue;
    // Color by event kind
    const isBull = ['Spring', 'AR', 'SOS', 'LPS'].includes(e.kind);
    const isBear = ['UTAD', 'DR', 'SOW', 'LPSY'].includes(e.kind);
    const color = isBull ? 'rgba(34, 197, 94, 0.95)'
                : isBear ? 'rgba(239, 68, 68, 0.95)'
                :          'rgba(245, 158, 11, 0.95)';   // climaxes (SC/BC/ST) = amber
    // Place label above the high for tops (BC/UTAD/SOW/LPSY) and below the low for bottoms
    const placeAbove = !isBull;
    const ly = placeAbove ? y - 16 : y + 16;
    // Small filled rounded label
    overlayCtx.font = 'bold 10px "JetBrains Mono", monospace';
    const w_text = overlayCtx.measureText(e.kind).width + 8;
    const h_text = 14;
    overlayCtx.fillStyle = 'rgba(7, 9, 15, 0.92)';
    overlayCtx.fillRect(x - w_text / 2, ly - h_text / 2, w_text, h_text);
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 1;
    overlayCtx.strokeRect(x - w_text / 2, ly - h_text / 2, w_text, h_text);
    overlayCtx.fillStyle = color;
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(e.kind, x, ly + 0.5);
    // Tick line connecting label to bar
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = 0.8;
    overlayCtx.setLineDash([2, 2]);
    overlayCtx.beginPath();
    if (placeAbove) {
      overlayCtx.moveTo(x, ly + h_text / 2); overlayCtx.lineTo(x, y - 2);
    } else {
      overlayCtx.moveTo(x, ly - h_text / 2); overlayCtx.lineTo(x, y + 2);
    }
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  }

  // Phase badge — top-right of chart
  if (wk.phase && wk.phase !== 'undefined') {
    const badge = wk.phase.replace('_', ' ').toUpperCase();
    overlayCtx.font = 'bold 11px "JetBrains Mono", monospace';
    const tw = overlayCtx.measureText(badge).width + 14;
    overlayCtx.fillStyle = 'rgba(167, 139, 250, 0.92)';
    overlayCtx.fillRect(w - tw - 12, 8, tw, 20);
    overlayCtx.fillStyle = '#07090f';
    overlayCtx.textAlign = 'center';
    overlayCtx.textBaseline = 'middle';
    overlayCtx.fillText(badge, w - 12 - tw / 2, 18);
  }
}

// V2 plot items renderer — V2 §14 §30 §41 strict allocation.
// Renders:
//   item_kind "band"               demand/supply/target — colored rectangle
//   item_kind "trigger_line"       gold dashed horizontal line
//   item_kind "invalidation_line"  red dashed horizontal line
//   item_kind "decision_badge"     top-right corner pill, label = decision verb
// Plus a soft regime tint over the whole chart background.
function _drawV2PlotItems() {
  if (!overlayCanvas || !overlayCtx) return;
  if (!_v2PlotItems || !_v2PlotItems.length) return;
  if (!currentBars || !currentBars.length) return;
  const ts = chart.timeScale();
  const w  = overlayCanvas.width / (window.devicePixelRatio || 1);
  const h  = overlayCanvas.height / (window.devicePixelRatio || 1);
  const latestT = currentBars[currentBars.length - 1].time;
  const startT = currentBars[Math.max(0, currentBars.length - 60)].time;

  // ── V2 §15 step 1 — background regime tint ────────────────────────────────
  // BEAR / MARKDOWN     → dark red wash
  // BULL / MARKUP       → dark green wash
  // TRANSITIONAL/CHOPPY → no tint (neutral)
  const trend = _v2PlotMeta?.trend_state;
  if (trend === 'BEAR') {
    overlayCtx.fillStyle = 'rgba(239, 68, 68, 0.045)';
    overlayCtx.fillRect(0, 0, w, h);
  } else if (trend === 'BULL') {
    overlayCtx.fillStyle = 'rgba(34, 197, 94, 0.045)';
    overlayCtx.fillRect(0, 0, w, h);
  }

  // Layer-role color palette
  const COL = {
    demand:        { fill: '34, 197, 94',   stroke: '34, 197, 94',  text: '34, 197, 94'  },
    supply:        { fill: '239, 68, 68',   stroke: '239, 68, 68',  text: '239, 68, 68'  },
    target:        { fill: '174, 182, 194', stroke: '174, 182, 194', text: '174, 182, 194' },
    trigger:       { fill: '245, 200, 90',  stroke: '245, 200, 90', text: '245, 200, 90' },
    invalidation:  { fill: '239, 68, 68',   stroke: '239, 68, 68',  text: '239, 68, 68'  },
    trendline:     { fill: '167, 139, 250', stroke: '167, 139, 250', text: '167, 139, 250' },  // violet (V2 §41 #7)
    level:         { fill: '92, 225, 230',  stroke: '92, 225, 230', text: '92, 225, 230' },
  };

  for (const it of _v2PlotItems) {
    const c = COL[it.layer_role] || COL.level;
    const op = Math.max(0.25, Math.min(1.0, it.opacity || 1.0));
    let xStart = ts.timeToCoordinate(startT);
    let xEnd   = ts.timeToCoordinate(latestT);
    if (xStart === null) xStart = 0;
    if (xEnd === null)   xEnd = w;

    if (it.item_kind === 'decision_badge') {
      // Phase 1.C Session 8 — operator can collapse the panel so it stops
      // blocking the candles. Skip the entire draw block when collapsed;
      // the HTML chevron button stays as the reopener affordance.
      if (_v2PanelCollapsed) continue;
      // V3.5 — decision PANEL: bordered rectangle, top-LEFT, WITH DIRECTION.
      // Operator: "move it to other side of chart" + "add direction of stock,
      // explaining potential rr to which direction and trigger 1.98%."
      //
      //   ┌────────────────────────────────────┐
      //   │ STAND DOWN                         │  ← verb (colored band)
      //   │ BIAS  LONG ↑  (counter-trend)      │  ← NEW: direction line
      //   │ Conf 95%  ·  Potential RR ↑ 2.91   │  ← ↑ on RR (direction)
      //   │ Trigger ↑ 1340.60  ·  +26pts +1.98%│  ← ↑ on trigger (direction)
      //   │ ─────────────────                  │
      //   │ WHY                                │
      //   │ [TRIGGER]   Need close above 1341  │
      //   │ [LEVEL]     At active demand 1285-…│
      //   │ [STRUCTURE] Structure bearish      │
      //   └────────────────────────────────────┘
      const panel = _v2PlotMeta?.decision_panel || {};
      const verb  = (it.label || 'WAIT').toUpperCase();
      let verbCol = '34, 197, 94';
      if (verb === 'STAND DOWN')   verbCol = '239, 68, 68';
      else if (verb === 'WATCH')   verbCol = '245, 200, 90';
      else if (verb === 'WAIT')    verbCol = '174, 182, 194';
      else if (verb === 'ARM')     verbCol = '92, 225, 230';

      // Direction derivation. Phase 1.C: Decision Engine puts bias directly
      // in the payload (panel.bias). If absent (legacy bake), fall back to
      // deriving bias from trigger.pts sign so the UI still works.
      //   trigger.pts > 0  → conditional LONG (need upside reclaim)
      //   trigger.pts < 0  → conditional SHORT (need downside break)
      const trig = panel.trigger;
      let bias = panel.bias || null, biasCol = '174, 182, 194', biasArrow = '', biasNote = '';
      if (bias === 'LONG')  { biasArrow = '↑'; biasCol = '34, 197, 94';  }
      else if (bias === 'SHORT') { biasArrow = '↓'; biasCol = '239, 68, 68'; }
      else if (trig && typeof trig.pts === 'number') {
        if (trig.pts > 0) {
          bias = 'LONG'; biasArrow = '↑'; biasCol = '34, 197, 94';
        } else if (trig.pts < 0) {
          bias = 'SHORT'; biasArrow = '↓'; biasCol = '239, 68, 68';
        }
      }
      const trendState = _v2PlotMeta?.trend_state;
      if (bias === 'LONG'  && trendState === 'BEAR') biasNote = '(counter-trend)';
      else if (bias === 'SHORT' && trendState === 'BULL') biasNote = '(counter-trend)';
      else if (bias === 'LONG'  && trendState === 'BULL') biasNote = '(with trend)';
      else if (bias === 'SHORT' && trendState === 'BEAR') biasNote = '(with trend)';

      // ── Build all text lines first so we can compute the box height ──
      const lines = [];
      lines.push({kind: 'verb', text: verb, color: verbCol});
      if (bias) {
        lines.push({kind: 'bias',
                    text: `BIAS  ${bias} ${biasArrow}  ${biasNote}`.trim(),
                    color: biasCol});
      }
      const conf = panel.confidence;
      const rr   = panel.rr_preview;
      const stat = [];
      if (typeof conf === 'number') stat.push(`Conf ${conf}%`);
      if (typeof rr === 'number')   stat.push(`Potential RR ${biasArrow} ${rr}`.trim());
      if (stat.length) lines.push({kind: 'stat', text: stat.join('  ·  '), color: verbCol});
      if (trig && typeof trig.price === 'number') {
        const sign = trig.pts >= 0 ? '+' : '';
        lines.push({kind: 'trig',
                    text: `Trigger ${biasArrow} ${trig.price.toFixed(2)}  ·  ${sign}${trig.pts.toFixed(0)}pts (${sign}${trig.percent.toFixed(2)}%)`.trim(),
                    color: '245, 200, 90'});
      }
      // Phase 1.C Session 8 — per-view-mode panel content.
      // EXECUTION: WHY + 3 reasons + CHANGED panel (the default we've shipped).
      // ANALYSIS:  + decision_rule + confidence_factors + conflict bull/bear.
      // HISTORY:   replaces WHY with recent_history list of past PIT verbs.
      const mode = _v2ViewMode || 'execution';
      const reasons = (panel.reasons || []).slice(0, 3);
      if (mode !== 'history' && reasons.length) {
        lines.push({kind: 'sep'});
        lines.push({kind: 'hdr', text: 'WHY', color: '174, 182, 194'});
        for (const r of reasons) {
          const cat = (r.category || '').toUpperCase();
          const txt = (r.text || '').trim();
          lines.push({kind: 'reason', text: `${cat ? '['+cat+'] ' : ''}${txt}`, color: '230, 233, 240'});
        }
      }

      // ANALYSIS mode — decision rule + confidence breakdown + conflict weights
      if (mode === 'analysis') {
        if (panel.decision_rule) {
          lines.push({kind: 'sep'});
          lines.push({kind: 'hdr', text: 'RULE', color: '174, 182, 194'});
          lines.push({kind: 'reason',
                      text: panel.decision_rule.slice(0, 60),
                      color: '230, 233, 240'});
        }
        if (panel.confidence_factors && typeof panel.confidence_factors === 'object') {
          lines.push({kind: 'hdr', text: 'CONFIDENCE', color: '174, 182, 194'});
          for (const [k, v] of Object.entries(panel.confidence_factors)) {
            lines.push({kind: 'reason',
                        text: `${k.replace(/_/g, ' ')}: ${v}`,
                        color: '230, 233, 240'});
          }
        }
        if (panel.conflict_breakdown
            && (panel.conflict_breakdown.bull_weight || panel.conflict_breakdown.bear_weight)) {
          const cb = panel.conflict_breakdown;
          lines.push({kind: 'hdr', text: 'CONFLICT', color: '174, 182, 194'});
          lines.push({kind: 'reason',
                      text: `bull ${Math.round(cb.bull_weight)} · bear ${Math.round(cb.bear_weight)} · score ${panel.conflict_score}%`,
                      color: '230, 233, 240'});
        }
      }

      // HISTORY mode — recent_history list of past PIT dates + verbs
      if (mode === 'history') {
        const hist = (_v2PlotMeta?.recent_history || []).slice(0, 5);
        if (hist.length) {
          lines.push({kind: 'sep'});
          lines.push({kind: 'hdr', text: 'RECENT VERDICTS', color: '174, 182, 194'});
          const VERB_COLOR = {
            'STAND DOWN': '239, 68, 68',
            'WATCH':      '245, 200, 90',
            'WAIT':       '174, 182, 194',
            'ARM':        '92, 225, 230',
          };
          for (const h of hist) {
            const v = (h.verb || '—').toString();
            const mm = (h.date && h.date.length >= 10) ? h.date.slice(5) : h.date;
            const tx = h.transitions ? `  ${h.transitions} chg` : '';
            lines.push({kind: 'reason',
                        text: `${mm}  ${v}${tx}`,
                        color: VERB_COLOR[v] || '230, 233, 240'});
          }
        }
      }

      // Phase 1.D Session 3 — state-engine transition surface.
      // Header is honest about WHICH date the transitions are from — PIT
      // dates often lag today by 1 day because EOD data is published after
      // close. Format: "CHANGED MM-DD" — month-day only since the full
      // year is visible in the PIT-date selector at the top of the page.
      const recents = (_v2PlotMeta?.recent_events || []).slice(0, 4);
      if (recents.length) {
        const pitDate = _v2PlotMeta?.pit_date || '';
        const mmdd = pitDate.length >= 10 ? pitDate.slice(5) : '';  // "MM-DD"
        const headerText = mmdd ? `CHANGED ${mmdd}` : 'CHANGED';
        lines.push({kind: 'sep'});
        lines.push({kind: 'hdr', text: headerText, color: '174, 182, 194'});
        // Severity → color so BROKEN reads red, CONFIRMED reads green, etc.
        const SEV_COLOR = {
          broken: '239, 68, 68', dead: '239, 68, 68', failed: '239, 68, 68',
          flipped_to_supply: '245, 200, 90', flipped_to_demand: '245, 200, 90',
          violated: '245, 200, 90', weakened: '245, 200, 90',
          under_attack: '245, 200, 90',
          revived: '92, 225, 230', retesting: '92, 225, 230',
          confirmed: '34, 197, 94', active_context: '34, 197, 94',
          reaction_confirmed: '34, 197, 94', respected: '34, 197, 94',
          tested: '174, 182, 194',
        };
        for (const ev of recents) {
          const sa = (ev.state_after || '').toUpperCase().replace(/_/g, ' ');
          const ts = ev.type_short || ev.type || '?';
          const px = (typeof ev.price === 'number')
            ? ` ${ev.price < 100 ? ev.price.toFixed(2) : ev.price.toFixed(0)}` : '';
          const text = `• ${ts}${px} ${sa}`;
          lines.push({kind: 'reason',
                      text: text,
                      color: SEV_COLOR[ev.state_after] || '230, 233, 240'});
        }
      }

      const boxW       = 280;          // wider — direction line needs room
      const padX       = 10;
      const padTop     = 8;
      const padBottom  = 8;
      const lineH      = 16;
      const sepH       = 6;
      const verbH      = 22;
      let bodyH = padTop;
      for (const ln of lines) {
        if (ln.kind === 'sep')        bodyH += sepH;
        else if (ln.kind === 'verb')  bodyH += verbH + 4;
        else                          bodyH += lineH;
      }
      bodyH += padBottom;

      const boxX = 12;                 // V3.5 — moved to LEFT side
      const boxY = 10;

      // ── Box background + border ──
      overlayCtx.fillStyle = 'rgba(7, 9, 15, 0.92)';
      overlayCtx.fillRect(boxX, boxY, boxW, bodyH);
      overlayCtx.strokeStyle = `rgba(${verbCol}, 0.55)`;
      overlayCtx.lineWidth = 1.2;
      overlayCtx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, bodyH - 1);

      // ── Render lines ──
      let y = boxY + padTop;
      for (const ln of lines) {
        if (ln.kind === 'sep') {
          overlayCtx.strokeStyle = 'rgba(174, 182, 194, 0.25)';
          overlayCtx.lineWidth = 1;
          overlayCtx.beginPath();
          overlayCtx.moveTo(boxX + padX, y + 3);
          overlayCtx.lineTo(boxX + boxW - padX, y + 3);
          overlayCtx.stroke();
          y += sepH;
          continue;
        }
        if (ln.kind === 'verb') {
          // Verb gets its own colored band across the box top
          overlayCtx.fillStyle = `rgba(${ln.color}, 0.96)`;
          overlayCtx.fillRect(boxX + 1, y - 2, boxW - 2, verbH);
          overlayCtx.fillStyle = '#07090f';
          overlayCtx.font = 'bold 13px "JetBrains Mono", monospace';
          overlayCtx.textAlign = 'center';
          overlayCtx.textBaseline = 'middle';
          overlayCtx.fillText(ln.text, boxX + boxW / 2, y + verbH / 2 - 2);
          y += verbH + 4;
          continue;
        }
        if (ln.kind === 'hdr') {
          overlayCtx.font = 'bold 9.5px "JetBrains Mono", monospace';
          overlayCtx.fillStyle = `rgba(${ln.color}, 0.85)`;
          overlayCtx.textAlign = 'left';
          overlayCtx.textBaseline = 'middle';
          overlayCtx.fillText(ln.text, boxX + padX, y + lineH / 2);
          y += lineH;
          continue;
        }
        // stat / trig / reason / bias — plain text line
        const fontSize = (ln.kind === 'stat' || ln.kind === 'trig' || ln.kind === 'bias') ? 11 : 10.5;
        const fontWeight = (ln.kind === 'stat' || ln.kind === 'trig' || ln.kind === 'bias') ? 'bold ' : '';
        overlayCtx.font = `${fontWeight}${fontSize}px "JetBrains Mono", monospace`;
        let toRender = ln.text;
        while (overlayCtx.measureText(toRender).width > boxW - padX * 2 - 4) {
          toRender = toRender.slice(0, -1);
        }
        if (toRender !== ln.text) toRender = toRender.slice(0, -1) + '…';
        overlayCtx.fillStyle = `rgba(${ln.color}, 0.95)`;
        overlayCtx.textAlign = 'left';
        overlayCtx.textBaseline = 'middle';
        overlayCtx.fillText(toRender, boxX + padX, y + lineH / 2);
        y += lineH;
      }
      continue;
    }

    if (it.item_kind === 'band' && it.price_low !== null && it.price_high !== null) {
      const yTop = candle.priceToCoordinate(it.price_high);
      const yBot = candle.priceToCoordinate(it.price_low);
      if (yTop === null || yBot === null) continue;

      overlayCtx.fillStyle = `rgba(${c.fill}, ${0.13 * op})`;
      overlayCtx.fillRect(xStart, yTop, xEnd - xStart, yBot - yTop);

      overlayCtx.strokeStyle = `rgba(${c.stroke}, ${0.90 * op})`;
      overlayCtx.lineWidth = it.plot_priority <= 2 ? 2 : 1.4;
      overlayCtx.beginPath();
      overlayCtx.moveTo(xStart, yTop); overlayCtx.lineTo(xEnd, yTop);
      overlayCtx.moveTo(xStart, yBot); overlayCtx.lineTo(xEnd, yBot);
      overlayCtx.stroke();

      const labelY = (yTop + yBot) / 2;
      const label = it.label || '';
      overlayCtx.font = `bold ${it.plot_priority <= 2 ? 12 : 11}px "JetBrains Mono", monospace`;
      const labelW = overlayCtx.measureText(label).width + 12;
      overlayCtx.fillStyle = `rgba(7, 9, 15, ${0.93 * op})`;
      overlayCtx.fillRect(xEnd - labelW - 4, labelY - 10, labelW, 20);
      overlayCtx.strokeStyle = `rgba(${c.stroke}, ${op})`;
      overlayCtx.lineWidth = 1;
      overlayCtx.strokeRect(xEnd - labelW - 4, labelY - 10, labelW, 20);
      overlayCtx.fillStyle = `rgba(${c.text}, ${op})`;
      overlayCtx.textAlign = 'left';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.fillText(label, xEnd - labelW + 2, labelY + 0.5);

      // V3.1 — state badge INSIDE the band (operator: "must belong to an
      // object"), at the band's top-LEFT corner. Reads "ACTIVE DEMAND (12d)"
      // / "WEAKENED SUPPLY (23d)" / "FRESH SUPPLY (3d)" etc.
      // V3.2 — append Object Strength: "ACTIVE DEMAND (58d) · 82"
      // (decision_score 0-100; lets operator differentiate two same-state objects)
      if (it.state_label) {
        const strength = (typeof it.decision_score === 'number')
          ? Math.round(it.decision_score) : null;
        const badge = strength !== null
          ? `${it.state_label}  ·  ${strength}` : it.state_label;
        overlayCtx.font = 'bold 9.5px "JetBrains Mono", monospace';
        const sw = overlayCtx.measureText(badge).width + 10;
        const sx = xStart + 6;
        const sy = yTop + 4;   // INSIDE the band, just below top edge
        // Only render if there's vertical room (band > 16px tall)
        if (yBot - yTop > 16) {
          overlayCtx.fillStyle = `rgba(${c.fill}, ${0.92 * op})`;
          overlayCtx.fillRect(sx, sy, sw, 14);
          overlayCtx.fillStyle = '#07090f';
          overlayCtx.textAlign = 'center';
          overlayCtx.textBaseline = 'middle';
          overlayCtx.fillText(badge, sx + sw / 2, sy + 7);
        }
      }

      if (it.sub_label) {
        overlayCtx.font = `10px "JetBrains Mono", monospace`;
        overlayCtx.fillStyle = `rgba(${c.text}, ${0.62 * op})`;
        overlayCtx.fillText(it.sub_label, xEnd - labelW + 2, labelY + 14);
      }
      continue;
    }

    if (it.item_kind === 'trendline' && Array.isArray(it.anchor_pairs)
        && it.anchor_pairs.length >= 2) {
      // V2 §14 + §41 #7 — render the trendline as a DIAGONAL line connecting
      // its two anchor pivots, projected forward to the current bar.
      const pairs = it.anchor_pairs.slice().sort((a, b) => a.t - b.t);
      const a0 = pairs[0], a1 = pairs[pairs.length - 1];
      const x0 = ts.timeToCoordinate(a0.t);
      const x1 = ts.timeToCoordinate(a1.t);
      const y0 = candle.priceToCoordinate(a0.price);
      const y1 = candle.priceToCoordinate(a1.price);
      if (x0 !== null && x1 !== null && y0 !== null && y1 !== null && x1 > x0) {
        // Project the line forward to the right edge of the visible chart
        const dx = x1 - x0;
        const dy = y1 - y0;
        const xForward = w - 8;
        const yForward = y1 + (dy / dx) * (xForward - x1);
        overlayCtx.strokeStyle = `rgba(${c.stroke}, ${0.85 * op})`;
        overlayCtx.lineWidth = 1.6;
        overlayCtx.setLineDash([]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(x0, y0);
        overlayCtx.lineTo(x1, y1);
        overlayCtx.lineTo(xForward, yForward);
        overlayCtx.stroke();

        // Label at the projected right-edge point
        const label = it.label || 'Trendline';
        overlayCtx.font = `bold 11px "JetBrains Mono", monospace`;
        const labelW = overlayCtx.measureText(label).width + 12;
        const labelY = Math.max(12, Math.min(h - 12, yForward));
        overlayCtx.fillStyle = `rgba(7, 9, 15, ${0.93 * op})`;
        overlayCtx.fillRect(xForward - labelW - 4, labelY - 9, labelW, 18);
        overlayCtx.strokeStyle = `rgba(${c.stroke}, ${op})`;
        overlayCtx.lineWidth = 1;
        overlayCtx.strokeRect(xForward - labelW - 4, labelY - 9, labelW, 18);
        overlayCtx.fillStyle = `rgba(${c.text}, ${op})`;
        overlayCtx.textAlign = 'left';
        overlayCtx.textBaseline = 'middle';
        overlayCtx.fillText(label, xForward - labelW + 2, labelY + 0.5);
        if (it.sub_label) {
          overlayCtx.font = `10px "JetBrains Mono", monospace`;
          overlayCtx.fillStyle = `rgba(${c.text}, ${0.62 * op})`;
          overlayCtx.fillText(it.sub_label, xForward - labelW + 2, labelY + 14);
        }
      }
      continue;
    }

    if ((it.item_kind === 'trigger_line' || it.item_kind === 'invalidation_line')
        && it.price !== null) {
      const y = candle.priceToCoordinate(it.price);
      if (y === null) continue;
      overlayCtx.strokeStyle = `rgba(${c.stroke}, ${op})`;
      overlayCtx.lineWidth = 1.6;
      overlayCtx.setLineDash([7, 5]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(xStart, y); overlayCtx.lineTo(xEnd, y);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);

      const label = it.label || `${it.price.toFixed(2)}`;
      overlayCtx.font = 'bold 11px "JetBrains Mono", monospace';
      const labelW = overlayCtx.measureText(label).width + 12;

      // Label collision avoidance: if this line sits within 0.5 ATR of a
      // band item's edge (e.g., trigger 1341 vs supply 1336-1341), the
      // line's label would draw OVER the band's label at the right edge.
      // In that case, draw the line label at the LEFT edge instead.
      const atr = _v2PlotMeta?.atr14 || 1;
      const collides = _v2PlotItems.some(other =>
        other !== it && other.item_kind === 'band' &&
        other.price_low !== null && other.price_high !== null &&
        (Math.abs(it.price - other.price_high) / atr < 0.5 ||
         Math.abs(it.price - other.price_low)  / atr < 0.5)
      );
      const labelX = collides ? (xStart + 4) : (xEnd - labelW - 4);

      overlayCtx.fillStyle = `rgba(7, 9, 15, ${0.93 * op})`;
      overlayCtx.fillRect(labelX, y - 9, labelW, 18);
      overlayCtx.strokeStyle = `rgba(${c.stroke}, ${op})`;
      overlayCtx.strokeRect(labelX, y - 9, labelW, 18);
      overlayCtx.fillStyle = `rgba(${c.text}, ${op})`;
      overlayCtx.textAlign = 'left';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.fillText(label, labelX + 6, y + 0.5);
      continue;
    }
  }

  // Small "V2 · N raw" stat pill — bottom-left so it doesn't fight the
  // decision badge top-right.
  overlayCtx.font = '10px "JetBrains Mono", monospace';
  const stat = `V2 · ${_v2PlotMeta?.n_raw_objects || '?'} → ${_v2PlotItems.length}`;
  const sw = overlayCtx.measureText(stat).width + 12;
  overlayCtx.fillStyle = 'rgba(92, 225, 230, 0.20)';
  overlayCtx.fillRect(12, h - 22, sw, 16);
  overlayCtx.fillStyle = 'rgba(92, 225, 230, 0.95)';
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.fillText(stat, 12 + sw / 2, h - 14);
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

  // ── V2 mode: hide all legacy overlays, render only the cluster-merged ≤7
  //    PlotItems from v2/plot/priority.py. The V2 chart-cleanup demo.
  if (showV2Mode && !presentMode) {
    // Clear non-canvas legacy artifacts so the chart is genuinely clean:
    //   - LWC candle markers (E/S/M/C letter badges, BOS/CHoCH dots, DIV box)
    //   - LWC price-line chips on the right edge (1489.50 / 1336.83 / ...)
    //   - Legacy trend badge top-left (BEAR 148d — collides with V2 badge)
    if (candle && candle.setMarkers) candle.setMarkers([]);
    _clearPriceChips();
    if (trendBadge) trendBadge.style.display = 'none';
    _drawV2PlotItems();
    return;
  }

  // CHoCH trigger drawn first so SR labels (drawn last) can sit on top if they overlap.
  _drawChochTrigger();
  // Trendlines drawn on overlay — tier-styled (HTF bold, internal medium, tactical thin).
  _drawTrendlinesOverlay();
  // Order blocks — drawn BEFORE the SR zone fills so SR labels still render on top.
  _drawOrderBlocksOverlay();
  // Liquidity sweeps — triangle markers at wick tips; Spring/UTAD get badge labels.
  _drawLiquiditySweepsOverlay();
  // Traps — X-mark at the failure bar + dashed connector to the failed BOS level.
  _drawTrapsOverlay();
  // Candle psychology — small letter badges (off by default to keep chart clean).
  _drawCandlePsychOverlay();
  // Wyckoff: Creek/Ice channel + event labels (SC/AR/ST/Spring/SOS/LPS).
  _drawWyckoffOverlay();
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

// Nexus-style metadata bar — company name + price + sector + market cap chips.
// Called twice per symbol load: first with empty metadata (right after OHLCV
// arrives, before primitives), then re-rendered from buildSymheadFromMetadata
// once the stock_metadata producer's output is fetched.
function _renderSymhead(m) {
  if (!symhead) return;
  const up = (m.change || 0) >= 0;
  const sign = up ? '▲' : '▼';
  const sCls = up ? 'up' : 'down';
  const mcap = (typeof m.market_cap_cr === 'number')
    ? (m.market_cap_cr >= 100000
        ? `₹${(m.market_cap_cr / 100000).toFixed(2)}L Cr`
        : `₹${m.market_cap_cr.toLocaleString('en-IN', {maximumFractionDigits: 0})} Cr`)
    : null;
  const avgVol = (typeof m.avg_volume_10d === 'number')
    ? (m.avg_volume_10d >= 100 ? `${m.avg_volume_10d.toFixed(0)} L` : `${m.avg_volume_10d.toFixed(1)} L`)
    : null;

  // Tier-1 redesign: vertical hero column. Title → big price → 2-col chip grid
  // → regime pill → RS sparkline block. CSS lays children out via flex column.
  let html = '';
  html += `<div class="sym-title">`;
  if (m.company_name) html += `<div class="sym-company">${_esc(m.company_name)}</div>`;
  html += `<div class="sym-ticker">${_esc(m.symbol)}<span class="sym-ex">NSE</span></div>`;
  html += `</div>`;

  html += `<div class="sym-price-block">`;
  html += `<div class="sym-last">${(m.last_close || 0).toFixed(2)}</div>`;
  html += `<div class="sym-chg ${sCls}">${sign} ${Math.abs(m.change || 0).toFixed(2)} <span>(${(m.change_pct || 0).toFixed(2)}%)</span></div>`;
  html += `</div>`;

  html += '<div class="sym-chips">';
  if (m.industry) html += `<div class="sym-chip full"><span class="chip-k">Industry</span><span class="chip-v">${_esc(m.industry)}</span></div>`;
  if (m.sector)   html += `<div class="sym-chip full"><span class="chip-k">Sector</span><span class="chip-v">${_esc(m.sector)}</span></div>`;
  if (mcap)       html += `<div class="sym-chip"><span class="chip-k">M-Cap</span><span class="chip-v">${mcap}</span></div>`;
  if (avgVol)     html += `<div class="sym-chip"><span class="chip-k">Avg Vol</span><span class="chip-v">${avgVol}</span></div>`;
  if (typeof m.beta === 'number')
                   html += `<div class="sym-chip"><span class="chip-k">β</span><span class="chip-v">${m.beta.toFixed(2)}</span></div>`;
  if (m.last_bar_iso) html += `<div class="sym-chip"><span class="chip-k">As of</span><span class="chip-v">${m.last_bar_iso}</span></div>`;
  html += '</div>';

  // Regime pill (per-stock — color-coded GREEN/AMBER/RED)
  if (m.regime_color) {
    const colorTok = m.regime_color === 'GREEN' ? 'GREEN'
                   : m.regime_color === 'AMBER' ? 'AMBER'
                   : 'RED';
    html += `<div class="hero-regime">`;
    html += `<span class="hr-k">Regime</span>`;
    html += `<span class="hr-pill ${colorTok}">${_esc(m.regime_color)}</span>`;
    html += `</div>`;
  }

  // Relative strength block (vs NIFTY500 — 10/20/50d %)
  if (m.rs_class) {
    const fmt = (n) => typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
    const sgn = (n) => typeof n === 'number' ? (n >= 0 ? 'up' : 'down') : '';
    html += `<div class="hero-rs">`;
    html += `<div class="hrs-k">Relative vs NIFTY500</div>`;
    html += `<div class="hrs-row"><span class="lbl">10d</span><span class="val ${sgn(m.rs_10d)}">${fmt(m.rs_10d)}</span></div>`;
    html += `<div class="hrs-row"><span class="lbl">20d</span><span class="val ${sgn(m.rs_20d)}">${fmt(m.rs_20d)}</span></div>`;
    html += `<div class="hrs-row"><span class="lbl">50d</span><span class="val ${sgn(m.rs_50d)}">${fmt(m.rs_50d)}</span></div>`;
    html += `<div class="hrs-class">${_esc(m.rs_class.replace(/_/g, ' '))}</div>`;
    html += `</div>`;
  }

  symhead.innerHTML = html;
}

// Re-render the symhead once primitives are loaded (stock_metadata may be there).
function _refreshSymheadFromMetadata(outputs) {
  if (!currentBars || !currentBars.length) return;
  const last = currentBars[currentBars.length - 1];
  const prev = currentBars[currentBars.length - 2] || last;
  const chg = last.close - prev.close;
  const chgPct = (chg / (prev.close || 1)) * 100;
  const hi52 = Math.max(...currentBars.map(b => b.high));
  const lo52 = Math.min(...currentBars.map(b => b.low));
  const mFacts  = outputs?.stock_metadata?.facts   || {};
  const stkF    = outputs?.stock_regime?.facts     || {};
  const rsF     = outputs?.relative_strength?.facts || {};
  _renderSymhead({
    symbol: currentSymbol || '',
    company_name:    mFacts.company_name || '',
    industry:        mFacts.industry || '',
    sector:          mFacts.sector || '',
    market_cap_cr:   mFacts.market_cap_cr,
    avg_volume_10d:  mFacts.avg_volume_10d,
    beta:            mFacts.beta,
    last_close:      last.close,
    change:          chg,
    change_pct:      chgPct,
    period_high:     hi52,
    period_low:      lo52,
    last_bar_iso:    epochToISO(last.time),
    volume:          last.volume,
    bars_count:      currentBars.length,
    // Tier-1 redesign — surface regime + RS into hero column
    regime_color:    stkF.stock_regime_color || null,
    rs_class:        rsF.rs_classification || null,
    rs_10d:          rsF.rs_10d_pct,
    rs_20d:          rsF.rs_20d_pct,
    rs_50d:          rsF.rs_50d_pct,
  });
}

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
let showOrderBlocks = true;       // OB rectangles — bullish_ob/bearish_ob (Step-1 brain L1)
let showLiquiditySweeps = true;   // Sweep markers — sweep_low/sweep_high + Spring/UTAD (Step-1)
let showTraps = true;             // Trap markers — bull_trap/bear_trap (failed BOS, Step-1)
let showCandlePsych = false;      // Candle-psychology badges — DEFAULT OFF (can be noisy)
let showWyckoff = true;           // Wyckoff Creek/Ice channel + event labels (Step-1 integrator)
let showV2Mode  = false;          // V2 view: hide ALL legacy overlays + render ≤7 cluster items
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
// Tier-1 fix-pass-2: switched to mockup green/red/cyan tokens so brackets stay
// readable on the cyan+violet radial bg.
const SR_BRACKET_COLOR_RESISTANCE = 'rgba(239, 68, 68, 0.92)';   // red
const SR_BRACKET_COLOR_SUPPORT    = 'rgba(34, 197, 94, 0.92)';   // green
const SR_BRACKET_COLOR_HISTORICAL = 'rgba(92, 225, 230, 0.90)';  // cyan (was gold) — dashed

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

// ═════════════════════════════════════════════════════════════════════════════
//                          TIER-1 REDESIGN  (2026-06-03)
//
// The 3-zone bento grid replaces the previous side-panel + bottom-panels +
// news-strip stack. Three new render entrypoints fed by the same producer
// outputs the previous code used:
//
//   _renderCmdbarIndices()  → NIFTY / BANKNIFTY / VIX live PIT chips
//   _renderRail()           → Decision Verb hero + HTF/Regime + Key Levels
//   _renderDock()           → tabbed: Levels · Plans · News · Volume · …
//
// No producer schema changes — pure presentation-layer refactor.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Cmdbar index chips ────────────────────────────────────────────────────
async function _renderCmdbarIndices() {
  const CHIPS = [
    { id: 'idx-nifty50',   sym: 'NIFTY50'   },
    { id: 'idx-banknifty', sym: 'BANKNIFTY' },
    { id: 'idx-vix',       sym: 'INDIAVIX'  },
  ];
  for (const c of CHIPS) {
    const el = document.getElementById(c.id);
    if (!el) continue;
    try {
      const res = await fetchOhlcv(c.sym);
      if (!res.ok) { el.querySelector('.idx-v').textContent = '—'; continue; }
      const bars = res.bars;
      if (!bars.length) { el.querySelector('.idx-v').textContent = '—'; continue; }
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2] || last;
      const chg = last.close - prev.close;
      const chgPct = (chg / (prev.close || 1)) * 100;
      const up = chg >= 0;
      const fmt = (p) => p >= 10000 ? p.toFixed(0) : p.toFixed(2);
      el.querySelector('.idx-v').textContent = fmt(last.close);
      const d = el.querySelector('.idx-d');
      d.textContent = `${up ? '▲' : '▼'} ${Math.abs(chgPct).toFixed(2)}%`;
      d.classList.toggle('up',   up);
      d.classList.toggle('down', !up);
    } catch (_) { /* fail-silent — chip stays "—" */ }
  }
}

// ─── Right rail — Decision Verb hero + HTF/Regime + Key Levels ─────────────
function _renderRail() {
  const rail = document.getElementById('rail');
  if (!rail) return;
  if (!currentSymbol || !currentBars.length) {
    rail.innerHTML = `<div class="empty">load a symbol to see the read</div>`;
    return;
  }
  const outputs = currentPrimitives || {};
  const ds = outputs.dashboard_state?.primitives?.[0]?.factors || null;

  let html = '';

  if (ds) {
    // Decision Verb — prefer producer-supplied field (Tier-1 dashboard_state);
    // fall back to derivation for older PIT dates baked before the producer was bumped.
    let verb      = ds.decision_verb;
    let verbClass = ds.decision_verb_class;
    if (!verb) {
      const dec = ds.decision || 'No Edge';
      const ts  = ds.trend_state || '';
      const lostSupply = (ds.price_location_text || '').includes('Below Failed Supply');
      if (lostSupply && ts === 'BEAR')              { verb = 'STAND DOWN';  verbClass = 'err';  }
      else if (dec === 'Actionable If Confirms')    { verb = 'ARM';         verbClass = 'up';   }
      else if (dec === 'Watch Only')                { verb = 'WATCH';       verbClass = 'warn'; }
      else                                          { verb = 'WAIT';        verbClass = 'dim';  }
    }
    const decision   = ds.decision            || 'No Edge';
    const readiness  = Math.max(0, Math.min(100, ds.trade_readiness_score   ?? 0));
    const confidence = Math.max(0, Math.min(100, ds.decision_confidence_score ?? 0));

    // Decision Hero tile
    html += `<div class="r-hero ${verbClass}">`;
    html += `  <div class="r-verb-k">Decision</div>`;
    html += `  <div class="r-verb ${verbClass}">${_esc(verb)}</div>`;
    html += `  <div class="r-verb-sub">${_esc(decision)}</div>`;
    html += `  <div class="r-scores">`;
    html += `    <div class="r-score-row">
                    <div class="r-score-k"><span>Trade Readiness</span><span class="r-score-v">${readiness}/100</span></div>
                    <div class="r-score-bar ${verbClass}"><i style="width:${readiness}%"></i></div>
                  </div>`;
    html += `    <div class="r-score-row">
                    <div class="r-score-k"><span>Confidence</span><span class="r-score-v">${confidence}/100</span></div>
                    <div class="r-score-bar"><i style="width:${confidence}%"></i></div>
                  </div>`;
    html += `  </div>`;
    html += `</div>`;
  } else {
    html += `<div class="r-hero">`;
    html += `  <div class="r-verb-k">Decision</div>`;
    html += `  <div class="r-verb">—</div>`;
    html += `  <div class="r-verb-sub">dashboard_state not yet computed for this date</div>`;
    html += `</div>`;
  }

  // HTF + Regime row
  const htfF = outputs.htf_context?.facts     || {};
  const rgF  = outputs.regime?.facts          || {};
  const stkF = outputs.stock_regime?.facts    || {};
  const htfTrend     = htfF.weekly_trend_state || htfF.weekly_trend || (outputs.structure_label?.facts?.trend_state) || '—';
  const marketRegime = rgF.regime_color || '—';
  const stockRegime  = stkF.stock_regime_color || '—';
  const trendCls = htfTrend === 'BULL' ? 'up' : htfTrend === 'BEAR' ? 'down' : 'warn';
  const mRegCls  = marketRegime === 'GREEN' ? 'up' : (marketRegime === 'RED' || marketRegime === 'DEEP_RED') ? 'down' : 'warn';
  const sRegCls  = stockRegime  === 'GREEN' ? 'up' : (stockRegime  === 'RED' || stockRegime  === 'DEEP_RED') ? 'down' : 'warn';

  html += `<div class="r-head">Context</div>`;
  html += `<div class="r-htf">`;
  html += `  <div class="r-htf-cell"><div class="k">Weekly</div><div class="v ${trendCls}">${_esc(htfTrend)}</div></div>`;
  html += `  <div class="r-htf-cell"><div class="k">Market</div><div class="v ${mRegCls}">${_esc(marketRegime)}</div></div>`;
  html += `</div>`;
  html += `<div class="r-htf">`;
  html += `  <div class="r-htf-cell"><div class="k">Stock Reg.</div><div class="v ${sRegCls}">${_esc(stockRegime)}</div></div>`;
  // Event-risk pill (next corp event)
  const erF = outputs.event_risk?.facts || {};
  let evText = '—', evCls = 'warn';
  if (erF.blocking_active) {
    evText = 'BLOCKED'; evCls = 'down';
  } else if (typeof erF.next_event_days === 'number') {
    evText = `${erF.next_event_days}d`; evCls = erF.next_event_days <= 2 ? 'warn' : 'up';
  } else if (typeof erF.last_event_days_ago === 'number') {
    evText = `${erF.last_event_days_ago}d ago`; evCls = '';
  }
  html += `  <div class="r-htf-cell"><div class="k">Event Risk</div><div class="v ${evCls}">${_esc(evText)}</div></div>`;
  html += `</div>`;

  // Key Levels list (from dashboard_state)
  const keyLevels = ds?.key_levels || [];
  if (keyLevels.length) {
    html += `<div class="r-head" style="margin-top:8px">Key Levels</div>`;
    html += `<div class="r-levels">`;
    for (const lv of keyLevels) {
      const icon = lv.kind === 'choch'  ? '◆'
                 : lv.kind === 'supply' ? '▼'
                 : lv.kind === 'demand' ? '▲'
                 : lv.kind === 'pivot'  ? '◦'
                 : '·';
      html += `<div class="r-level ${_esc(lv.kind || '')}">
                 <span class="lv-icon">${icon}</span>
                 <span class="lv-name">${_esc(lv.name)}</span>
                 <span class="lv-val">${_esc(lv.value)}</span>
               </div>`;
    }
    html += `</div>`;
  }

  rail.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════════════════
//  TILE-GARDEN DOCK  (2026-06-03, fix-pass-2)
//
//  Operator complaint: "tabs hide info. Show everything, nothing left behind."
//  Solution: bottom dock becomes 8 ALWAYS-VISIBLE summary tiles. Click any
//  tile → opens a full-screen modal with the producer's complete view
//  (re-using the existing per-tab renderers).
//
//  Tiles: Confluence · Plans · News · Relative · Regime · Fibs · Volume · Setup
//
//  No tabs. No hidden state. Information density wins over chrome.
// ═════════════════════════════════════════════════════════════════════════════

const _DOCK_TILE_DEFS = [
  { key: 'narrative',  title: 'READ',        render: _tileNarrative,   modal: _renderNarrativeTab },
  { key: 'confluence', title: 'CONFLUENCE',  render: _tileConfluence,  modal: _renderLevelsTab   },
  { key: 'plans',      title: 'TRADE PLANS', render: _tilePlans,       modal: _renderPlansTab    },
  { key: 'news',       title: 'NEWS',        render: _tileNews,        modal: _renderNewsTab     },
  { key: 'relative',   title: 'RELATIVE',    render: _tileRelative,    modal: _renderRelativeTab },
  { key: 'regime',     title: 'REGIME',      render: _tileRegime,      modal: _renderRegimeFullTab },
  { key: 'fibs',       title: 'FIBS',        render: _tileFibs,        modal: _renderFibsTab     },
  { key: 'volume',     title: 'VOLUME',      render: _tileVolume,      modal: _renderVolumeTab   },
];

function _renderDock() {
  const tiles = document.getElementById('dock-tiles');
  if (!tiles) return;
  if (!currentSymbol || !currentBars.length) {
    tiles.innerHTML = `<div class="dock-empty">load a symbol to populate</div>`;
    return;
  }
  const outputs = currentPrimitives || {};
  tiles.innerHTML = _DOCK_TILE_DEFS.map(def => {
    const body = def.render(outputs, currentBars);
    return `<div class="dock-tile" data-tile="${def.key}">
              <div class="dt-head">${def.title}<span class="dt-arrow">›</span></div>
              <div class="dt-body">${body}</div>
            </div>`;
  }).join('');
}

// ─── Per-tile summary renderers (~3-4 lines each) ──────────────────────────

// ─── Brain Layer 2: NarrativeRow tile + modal ─────────────────────────────
// Top-of-stack trader-natural rows, each grounded in evidence primitives.
function _tileNarrative(outputs, bars) {
  const rows = (outputs.narrative_row?.primitives || [])
    .filter(p => p.kind === 'narrative_row')
    .map(p => p.factors || {})
    .filter(f => f.tier === 1);
  if (!rows.length) return `<div class="dt-dim">no narrative — observing</div>`;
  return rows.slice(0, 3).map(r => {
    const cat = (r.category || '').toLowerCase();
    return `<div class="dt-narr-row">
              <span class="dt-narr-cat ${_esc(cat)}">${_esc(r.category || '')}</span>
              <span class="dt-narr-head dt-clip">${_esc((r.headline || '').slice(0, 70))}</span>
            </div>`;
  }).join('');
}

function _renderNarrativeTab(outputs, bars) {
  const allRows = (outputs.narrative_row?.primitives || [])
    .filter(p => p.kind === 'narrative_row')
    .map(p => p.factors || {});
  if (!allRows.length) {
    return `<div class="dock-empty">narrative_row producer not available for this run</div>`;
  }
  const tier1 = allRows.filter(r => r.tier === 1);
  const tier2 = allRows.filter(r => r.tier === 2);
  const tier3 = allRows.filter(r => r.tier === 3);

  const renderRow = (r) => {
    const cat = (r.category || '').toLowerCase();
    const cond = r.conditional ? `<div class="nm-row-cond"><strong>If:</strong> ${_esc(r.conditional)}</div>` : '';
    const refs = (r.evidence_refs || []).map(ref => `<span class="nm-row-ref">${_esc(ref)}</span>`).join('');
    return `<div class="nm-row ${_esc(cat)}">
              <div class="nm-row-head">
                <span class="nm-row-cat">${_esc(r.category || '')}</span>
                <span class="nm-row-cert">${_esc(r.certainty || '')}</span>
                <span class="nm-row-state">${_esc(r.state || 'fresh')}</span>
              </div>
              <div class="nm-row-text">${_esc(r.headline || '')}</div>
              ${cond}
              <div class="nm-row-refs"><span class="nm-refs-k">Evidence</span>${refs}</div>
            </div>`;
  };

  let html = `<div class="r-head">Tier 1 — top-of-stack</div>`;
  html += `<div class="nm-rows">${tier1.map(renderRow).join('') || '<div class="dock-empty">none</div>'}</div>`;
  if (tier2.length) {
    html += `<div class="r-head" style="margin-top:14px">Tier 2 — context</div>`;
    html += `<div class="nm-rows">${tier2.map(renderRow).join('')}</div>`;
  }
  if (tier3.length) {
    html += `<div class="r-head" style="margin-top:14px">Tier 3 — raw</div>`;
    html += `<div class="nm-rows">${tier3.map(renderRow).join('')}</div>`;
  }
  return html;
}

function _tileConfluence(outputs, bars) {
  const zones = (outputs.sr_zones?.primitives || []).filter(p => p.kind === 'sr_zone');
  if (!zones.length) return `<div class="dt-dim">No zones</div>`;
  const confPrims = (outputs.confluence?.primitives || []).filter(p => p.kind === 'confluence');
  const findConf = z => confPrims.find(c => c.price_lo === z.price_lo && c.price_hi === z.price_hi);
  const sorted = zones.slice().sort((a, b) => {
    const sa = findConf(a)?.factors?.confluence_score || 0;
    const sb = findConf(b)?.factors?.confluence_score || 0;
    return sb - sa;
  });
  const labelOf = z => {
    const f = z.factors || {};
    if (f.htf_confirmed) return 'HTF DEMAND';
    if (f.lifecycle === 'failed_reclaim') return 'HTF SUPPLY';
    if (f.classification === 'minor_support') return 'PIVOT';
    if ((f.classification || '').includes('resistance')) return 'RESISTANCE';
    return 'ZONE';
  };
  return sorted.slice(0, 3).map(z => {
    const cf = findConf(z);
    const score = cf ? `<span class="dt-pill">${cf.factors.confluence_score}</span>` : '';
    return `<div class="dt-row">
              <span class="dt-k">${_esc(labelOf(z))}</span>
              <span class="dt-v">${z.price_lo.toFixed(0)}–${z.price_hi.toFixed(0)}</span>
              ${score}
            </div>`;
  }).join('') + (zones.length > 3 ? `<div class="dt-more">+${zones.length - 3} more →</div>` : '');
}

function _tilePlans(outputs, bars) {
  const setupPrims = (outputs.setup?.primitives || []).filter(p => p.kind === 'setup');
  if (!setupPrims.length || setupPrims[0].factors?.family === 'NO_SETUP') {
    return `<div class="dt-dim">No active setup — waiting for formation</div>`;
  }
  const sp = setupPrims[0];
  const f = sp.factors || {};
  return `<div class="dt-row dt-title">${_esc((f.setup_name || 'setup').replace(/_/g,' ').toUpperCase())}</div>
          <div class="dt-row"><span class="dt-k">Status</span><span class="dt-v">${_esc(f.status || 'forming')}</span></div>
          <div class="dt-row"><span class="dt-k">Score</span><span class="dt-v">${f.confidence_score ?? 0}/100</span></div>
          <div class="dt-row dt-clip"><span class="dt-k">Trigger</span><span class="dt-v">${_esc(f.trigger || '—')}</span></div>`;
}

function _tileNews(outputs, bars) {
  const news = (outputs.news_marker?.primitives || []).filter(p => p.kind === 'news_marker');
  if (!news.length) return `<div class="dt-dim">No news</div>`;
  const sorted = news.slice().sort((a, b) => b.anchors[0].t - a.anchors[0].t);
  const head = `<div class="dt-row dt-count">${news.length} items · click for all</div>`;
  return head + sorted.slice(0, 2).map(p => {
    const f = p.factors || {};
    const date = _fmtNewsDate(p.anchors[0].t);
    const sent = (f.sentiment || 'neutral').toLowerCase();
    return `<div class="dt-news-row">
              <span class="dt-news-date">${_esc(date)}</span>
              <span class="dt-news-head dt-clip">${_esc(f.headline || '')}</span>
              <span class="nc-sent ${_esc(sent)}">${sent === 'positive' ? '▲' : sent === 'negative' ? '▼' : '◦'}</span>
            </div>`;
  }).join('');
}

function _tileRelative(outputs, bars) {
  const rsF = outputs.relative_strength?.facts || {};
  if (!rsF.rs_classification) return `<div class="dt-dim">no RS data</div>`;
  const fmt = (n) => typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
  const cls = (n) => typeof n === 'number' ? (n >= 0 ? 'up' : 'down') : '';
  return `<div class="dt-row dt-title up-or-dn-${rsF.rs_score >= 6 ? 'up' : 'down'}">${_esc(rsF.rs_classification.replace(/_/g,' ').toUpperCase())}</div>
          <div class="dt-row"><span class="dt-k">10d</span><span class="dt-v ${cls(rsF.rs_10d_pct)}">${fmt(rsF.rs_10d_pct)}</span></div>
          <div class="dt-row"><span class="dt-k">20d</span><span class="dt-v ${cls(rsF.rs_20d_pct)}">${fmt(rsF.rs_20d_pct)}</span></div>
          <div class="dt-row"><span class="dt-k">50d</span><span class="dt-v ${cls(rsF.rs_50d_pct)}">${fmt(rsF.rs_50d_pct)}</span></div>`;
}

function _tileRegime(outputs, bars) {
  const stk = outputs.stock_regime?.facts || {};
  const mkt = outputs.regime?.facts || {};
  const htf = outputs.structure_label?.facts?.trend_state || '—';
  const pill = (k, v, color) => {
    const colCls = color === 'GREEN' ? 'up' : (color === 'RED' || color === 'DEEP_RED') ? 'down' : 'warn';
    return `<div class="dt-row"><span class="dt-k">${k}</span><span class="dt-v ${colCls}">${_esc(v)}</span></div>`;
  };
  return pill('Stock', stk.stock_regime_color || '—', stk.stock_regime_color)
       + pill('Market', mkt.regime_color || '—', mkt.regime_color)
       + pill('HTF', htf, htf === 'BULL' ? 'GREEN' : (htf === 'BEAR' ? 'RED' : 'AMBER'));
}

function _tileFibs(outputs, bars) {
  const chochP = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;
  const chochT = (typeof _chochTriggerT === 'number') ? _chochTriggerT : null;
  if (chochP === null || !bars.length) return `<div class="dt-dim">No active swing</div>`;
  const trend = outputs.structure_label?.facts?.trend_state || 'TRANSITIONAL';
  const after = bars.filter(b => b.time >= chochT);
  if (!after.length) return `<div class="dt-dim">No bars after CHoCH</div>`;
  let hi, lo;
  if (trend === 'BEAR') { hi = chochP; lo = Math.min(...after.map(b => b.low)); }
  else                  { lo = chochP; hi = Math.max(...after.map(b => b.high)); }
  const range = hi - lo;
  const rangePct = (range / lo) * 100;
  return `<div class="dt-row"><span class="dt-k">Swing Hi</span><span class="dt-v">₹${hi.toFixed(2)}</span></div>
          <div class="dt-row"><span class="dt-k">Swing Lo</span><span class="dt-v">₹${lo.toFixed(2)}</span></div>
          <div class="dt-row"><span class="dt-k">Range</span><span class="dt-v">${range.toFixed(2)} (${rangePct.toFixed(1)}%)</span></div>
          <div class="dt-row dt-dim">${trend === 'BEAR' ? 'down→retrace up' : 'up→retrace down'}</div>`;
}

function _tileVolume(outputs, bars) {
  const vs = outputs.volume_state?.facts || {};
  if (!vs.rvol_regime) return `<div class="dt-dim">volume_state not available</div>`;
  const regime = vs.rvol_regime;
  // Map RVOL regime → semantic color: SPIKE/CLIMAX up, DRY down, NORMAL/ELEVATED neutral.
  const regCls = (regime === 'SPIKE' || regime === 'CLIMAX') ? 'up'
               : regime === 'DRY' ? 'down'
               : regime === 'ELEVATED' ? 'warn'
               : '';
  const rvol = vs.rvol_current ?? 0;
  const atv = vs.atv20_crores;
  const atvCls = vs.atv20_meets_min === false ? 'down' : '';
  return `<div class="dt-row dt-title up-or-dn-${regCls}">${_esc(regime)} · RVOL ${rvol.toFixed(2)}</div>
          <div class="dt-row"><span class="dt-k">ATV20</span><span class="dt-v ${atvCls}">₹${(atv ?? 0).toFixed(0)}Cr</span></div>
          <div class="dt-row"><span class="dt-k">POC</span><span class="dt-v">₹${(vs.vp_poc ?? 0).toFixed(2)}</span></div>
          <div class="dt-row"><span class="dt-k">VAH/VAL</span><span class="dt-v">${(vs.vp_vah ?? 0).toFixed(0)}–${(vs.vp_val ?? 0).toFixed(0)}</span></div>`;
}

function _tileSetup(outputs, bars) {
  const setupPrims = (outputs.setup?.primitives || []).filter(p => p.kind === 'setup');
  if (!setupPrims.length || setupPrims[0].factors?.family === 'NO_SETUP') {
    return `<div class="dt-dim">State: idle</div>`;
  }
  const sp = setupPrims[0];
  const f = sp.factors || {};
  const conds = (f.conditions_met || []).slice(0, 2).join(' · ') || '—';
  return `<div class="dt-row"><span class="dt-k">Family</span><span class="dt-v">${_esc(f.family || '—')}</span></div>
          <div class="dt-row"><span class="dt-k">Status</span><span class="dt-v">${_esc(f.status || 'forming')}</span></div>
          <div class="dt-row dt-clip"><span class="dt-k">Met</span><span class="dt-v">${_esc(conds)}</span></div>`;
}

// Full regime tab (used by modal — more detail than tile)
function _renderRegimeFullTab(outputs, bars) {
  const stk = outputs.stock_regime?.facts || {};
  const mkt = outputs.regime?.facts || {};
  const fmtPct = n => typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
  return `<table class="rs-table"><thead><tr><th>Scope</th><th>Color</th><th>State</th><th>Cell</th><th>10d Mom</th><th>Quality</th></tr></thead>
    <tbody>
      <tr><td>Stock</td><td>${_esc(stk.stock_regime_color || '—')}</td><td>${_esc(stk.stock_regime_state_v1 || '—')}</td><td>${_esc(stk.stock_regime_cell || '—')}</td><td>${fmtPct(stk.stock_momentum_10d_pct)}</td><td>${_esc(String(stk.stock_regime_quality_score ?? '—'))}/100</td></tr>
      <tr><td>Market</td><td>${_esc(mkt.regime_color || '—')}</td><td>${_esc(mkt.regime_state_v1 || '—')}</td><td>${_esc(mkt.regime_cell || '—')}</td><td>${fmtPct(mkt.momentum_10d_pct)}</td><td>${_esc(String(mkt.regime_quality_score ?? '—'))}/100</td></tr>
    </tbody></table>`;
}

// ─── Tile click → full modal (re-uses the per-tab renderers) ──────────────
function _openDockTileModal(tileKey) {
  const def = _DOCK_TILE_DEFS.find(d => d.key === tileKey);
  if (!def) return;
  const overlay = document.createElement('div');
  overlay.className = 'dock-modal-overlay';
  overlay.innerHTML = `
    <div class="dock-modal" role="dialog" aria-modal="true">
      <button class="dm-close" aria-label="Close">×</button>
      <div class="dm-head">${_esc(def.title)}</div>
      <div class="dm-body" id="dm-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('#dm-body');
  body.innerHTML = def.modal(currentPrimitives || {}, currentBars);
  // Wire close
  const close = () => overlay.remove();
  overlay.querySelector('.dm-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  // Special: Fibs modal needs canvas redraw after injection
  if (tileKey === 'fibs') requestAnimationFrame(() => _drawFibMiniChart(currentPrimitives || {}));
}

// Delegate clicks on dock tiles → open modal
document.addEventListener('click', e => {
  const tile = e.target.closest && e.target.closest('.dock-tile');
  if (tile && tile.dataset && tile.dataset.tile) _openDockTileModal(tile.dataset.tile);
});

// ─── Tab renderers ──────────────────────────────────────────────────────────

function _renderLevelsTab(outputs, bars) {
  const sr  = outputs.sr_zones;
  const zones = (sr?.primitives || []).filter(p => p.kind === 'sr_zone');
  const confOut = outputs.confluence;
  const confluencePrims = (confOut?.primitives || []).filter(p => p.kind === 'confluence');
  const chochP = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;

  const findConf = (z) => confluencePrims.find(c => c.price_lo === z.price_lo && c.price_hi === z.price_hi);
  const labelOf = (z) => {
    const f = z.factors || {};
    if (f.htf_confirmed) return 'HTF DEMAND ZONE';
    if (f.lifecycle === 'failed_reclaim') return 'HTF SUPPLY / FAILED RECLAIM';
    if (f.classification === 'minor_support') return 'PIVOT / BALANCE ZONE';
    if ((f.classification || '').includes('resistance')) return 'MINOR RESISTANCE';
    return 'REFERENCE ZONE';
  };
  const klassOf = (z) => {
    const f = z.factors || {};
    if (f.htf_confirmed) return 'demand';
    if ((f.classification || '').includes('resistance')) return 'supply';
    if (f.classification === 'minor_support') return 'pivot';
    return '';
  };

  const sorted = zones.slice().sort((a, b) => {
    const ca = findConf(a), cb = findConf(b);
    const sa = ca?.factors?.confluence_score || 0;
    const sb = cb?.factors?.confluence_score || 0;
    if (sa !== sb) return sb - sa;
    return b.price - a.price;
  });

  let cards = '';
  if (chochP != null) {
    cards += `<div class="lv-card choch">
                <div class="lvc-title">CHoCH Trigger · Structure Flip</div>
                <div class="lvc-price">₹${chochP.toFixed(2)}</div>
                <div class="lvc-meta">Close ${(outputs.structure_label?.facts?.trend_state || '') === 'BEAR' ? 'above' : 'below'} → trend reverses</div>
              </div>`;
  }
  for (const z of sorted) {
    const cf = findConf(z);
    const meta = cf
      ? `score ${cf.factors.confluence_score}/100 · ${(Object.keys(cf.factors.score_breakdown || {})).join(' · ')}`
      : (z.factors?.lifecycle || '');
    cards += `<div class="lv-card ${klassOf(z)}">
                <div class="lvc-title">${_esc(labelOf(z))}</div>
                <div class="lvc-price">${z.price_lo.toFixed(0)} – ${z.price_hi.toFixed(0)}</div>
                <div class="lvc-meta">${_esc(meta)}</div>
              </div>`;
  }
  if (!cards) return `<div class="dock-empty">No confluence zones detected</div>`;
  return `<div class="dock-grid">${cards}</div>`;
}

function _renderPlansTab(outputs, bars) {
  const setupOut = outputs.setup;
  const setupPrims = (setupOut?.primitives || []).filter(p => p.kind === 'setup');
  const sr = outputs.sr_zones;
  const zones = (sr?.primitives || []).filter(p => p.kind === 'sr_zone');
  const supplyZone = zones.find(z => (z.factors?.classification || '').includes('resistance'));
  const chochP = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;

  const plans = [];
  if (setupPrims.length && setupPrims[0].factors?.family !== 'NO_SETUP') {
    setupPrims.forEach((sp, idx) => {
      const f = sp.factors || {};
      const targets = (f.target_levels || []).map(n => `₹${(+n).toFixed(0)}`).join(' → ') || 'TBD';
      plans.push({
        title: `${String.fromCharCode(65 + idx)}. ${(f.setup_name || 'setup').toUpperCase().replace(/_/g,' ')}`,
        rows: [
          ['Family',       f.family || ''],
          ['Trigger',      f.trigger || ''],
          ['Invalidation', f.invalidation || ''],
          ['Targets',      targets],
          ['Status',       (f.status || 'forming').toUpperCase() + (typeof f.confidence_score === 'number' ? ` · score ${f.confidence_score}/100` : '')],
        ],
      });
    });
  } else if (supplyZone) {
    const slo = supplyZone.price_lo.toFixed(0);
    const shi = supplyZone.price_hi.toFixed(0);
    plans.push({
      title: 'A. SUPPLY RECLAIM SETUP',
      rows: [
        ['Trigger', `Daily close above ${shi} & retest hold`],
        ['Entry',   `Retest of ${slo}–${shi}`],
        ['SL',      `Below retest low / below ${slo}`],
        ['Targets', chochP != null ? `${chochP.toFixed(2)} (CHoCH)` : 'Next HTF supply'],
        ['Status',  'WAIT'],
      ],
    });
  }

  if (!plans.length) {
    return `<div class="dock-empty">No actionable plans for current state — wait for setup formation</div>`;
  }
  return `<div class="dock-grid">${
    plans.map(p =>
      `<div class="plan-card">
        <div class="pc-title">${_esc(p.title)}</div>
        ${p.rows.map(([k,v]) => `<div class="pc-line"><span class="k">${_esc(k)}</span><span class="v">${_esc(v)}</span></div>`).join('')}
      </div>`
    ).join('')
  }</div>`;
}

const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _fmtNewsDate(t) {
  const d = new Date(t * 1000);
  return `${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Currently displayed news items keyed by epoch — used by the modal to look back
// to the full body when a card is clicked.
const _newsItemsByT = new Map();

function _renderNewsTab(outputs, bars) {
  const news = (outputs.news_marker?.primitives || []).filter(p => p.kind === 'news_marker');
  if (!news.length) {
    return `<div class="dock-empty">No news for this symbol on this PIT date.</div>`;
  }
  const sorted = news.slice().sort((a, b) => b.anchors[0].t - a.anchors[0].t);
  _newsItemsByT.clear();
  const cards = sorted.map(p => {
    const f = p.factors || {};
    _newsItemsByT.set(String(p.anchors[0].t), p);
    const date = _fmtNewsDate(p.anchors[0].t);
    const cat = (f.category || 'company').toLowerCase();
    const impact = (f.impact || 'medium').toLowerCase();
    const sent = (f.sentiment || 'neutral').toLowerCase();
    const conf = f.price_confirmation && f.price_confirmation !== 'n/a' ? f.price_confirmation : null;
    return `<div class="news-card" data-t="${p.anchors[0].t}">
              <div class="nc-meta">
                <span class="nc-cat-dot ${_esc(cat)}"></span>
                <span class="nc-cat">${_esc(cat)}</span>
                <span class="nc-date">${_esc(date)}</span>
                ${impact === 'high' ? `<span class="nc-impact-high">HIGH</span>` : ''}
              </div>
              <div class="nc-headline">${_esc(f.headline || '')}</div>
              <div class="nc-footer">
                <span class="nc-sent ${_esc(sent)}">${_esc(sent.toUpperCase())}</span>
                ${conf ? `<span>·</span><span class="nc-conf ${_esc(conf)}">${_esc(conf.toUpperCase())}</span>` : ''}
                <span class="nc-read-cta">Read →</span>
              </div>
            </div>`;
  }).join('');
  return `<div class="news-grid">${cards}</div>`;
}

// Resolve a (possibly relative) news URL into an absolute one. The producer emits
// "/market/stock-market-news/…" and "source"="indianapi/livemint" — we map the
// known sources to their hostname so the operator can actually click through.
const _NEWS_HOSTS = {
  livemint:        'https://www.livemint.com',
  moneycontrol:    'https://www.moneycontrol.com',
  economictimes:   'https://economictimes.indiatimes.com',
  businessstandard:'https://www.business-standard.com',
  ndtv:            'https://www.ndtv.com',
  hindubusinessline:'https://www.thehindubusinessline.com',
  cnbctv18:        'https://www.cnbctv18.com',
  yfinance:        null,   // yfinance URLs are already absolute
};
function _resolveNewsUrl(rawUrl, source) {
  if (!rawUrl) return null;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (!rawUrl.startsWith('/')) return null;
  const src = String(source || '').toLowerCase();
  for (const key in _NEWS_HOSTS) {
    if (_NEWS_HOSTS[key] && src.includes(key)) return _NEWS_HOSTS[key] + rawUrl;
  }
  return null;
}

// ─── News modal — click a card to expand the full body ────────────────────
function _openNewsModal(t) {
  const p = _newsItemsByT.get(String(t));
  if (!p) return;
  const f = p.factors || {};
  const date = _fmtNewsDate(p.anchors[0].t);
  const cat = (f.category || 'company').toLowerCase();
  const impact = (f.impact || 'medium').toLowerCase();
  const sent = (f.sentiment || 'neutral').toLowerCase();
  const conf = f.price_confirmation && f.price_confirmation !== 'n/a' ? f.price_confirmation : null;
  // Producer often only emits headline (no body); fall back so the modal
  // never appears empty.
  const body = f.body || f.summary || f.description || f.headline || '(no body — source link below)';
  const link = _resolveNewsUrl(f.url || f.link, f.source);
  const overlay = document.createElement('div');
  overlay.className = 'news-modal-overlay';
  overlay.innerHTML = `
    <div class="news-modal" role="dialog" aria-modal="true">
      <button class="nm-close" aria-label="Close">×</button>
      <div class="nm-meta">
        <span class="nc-cat-dot ${_esc(cat)}"></span>
        <span class="nm-cat">${_esc(cat.toUpperCase())}</span>
        <span class="nm-sep">·</span>
        <span class="nm-date">${_esc(date)}</span>
        ${impact === 'high' ? `<span class="nm-impact">HIGH IMPACT</span>` : ''}
      </div>
      <h2 class="nm-headline">${_esc(f.headline || '')}</h2>
      <div class="nm-body">${_esc(body)}</div>
      <div class="nm-footer">
        <span class="nc-sent ${_esc(sent)}">${_esc(sent.toUpperCase())}</span>
        ${conf ? `<span class="nm-sep">·</span><span class="nc-conf ${_esc(conf)}">${_esc(conf.toUpperCase())}</span>` : ''}
        ${link ? `<a class="nm-link" href="${_esc(link)}" target="_blank" rel="noopener">Open source ↗</a>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.nm-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

// Delegate clicks on news cards → open modal
document.addEventListener('click', e => {
  const card = e.target.closest && e.target.closest('.news-card');
  if (card && card.dataset && card.dataset.t) _openNewsModal(card.dataset.t);
});

function _renderFibsTab(outputs, bars) {
  const chochP = (typeof _chochTriggerPrice === 'number') ? _chochTriggerPrice : null;
  const chochT = (typeof _chochTriggerT === 'number') ? _chochTriggerT : null;
  if (chochP === null || chochT === null || !bars || !bars.length) {
    return `<div class="dock-empty">No active fib swing — needs a CHoCH trigger + bars</div>`;
  }
  const trendState = outputs.structure_label?.facts?.trend_state || 'TRANSITIONAL';
  const after = bars.filter(b => b.time >= chochT);
  if (!after.length) return `<div class="dock-empty">No bars after CHoCH yet</div>`;
  let swingHigh, swingLow, swingHighT, swingLowT;
  if (trendState === 'BEAR') {
    const lowBar = after.reduce((m, b) => b.low < m.low ? b : m, after[0]);
    swingHigh = chochP;     swingHighT = chochT;
    swingLow  = lowBar.low; swingLowT  = lowBar.time;
  } else {
    const highBar = after.reduce((m, b) => b.high > m.high ? b : m, after[0]);
    swingHigh = highBar.high; swingHighT = highBar.time;
    swingLow  = chochP;       swingLowT  = chochT;
  }
  const dt = (t) => {
    const d = new Date(t * 1000);
    return `${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
  return `
    <div class="fibs-tab">
      <div class="fmc-anchors">
        <div class="fmc-anchor">
          <div class="fmc-lbl">Swing High</div>
          <div class="fmc-val">₹${swingHigh.toFixed(2)}</div>
          <div class="fmc-date">${dt(swingHighT)}</div>
        </div>
        <div class="fmc-anchor">
          <div class="fmc-lbl">Swing Low</div>
          <div class="fmc-val">₹${swingLow.toFixed(2)}</div>
          <div class="fmc-date">${dt(swingLowT)}</div>
        </div>
        <div class="fmc-anchor">
          <div class="fmc-lbl">Range</div>
          <div class="fmc-val">${(swingHigh - swingLow).toFixed(2)}</div>
          <div class="fmc-date">${((swingHigh - swingLow) / swingLow * 100).toFixed(1)}%</div>
        </div>
        <div class="fmc-anchor">
          <div class="fmc-lbl">Direction</div>
          <div class="fmc-val">${trendState === 'BEAR' ? '↓ retrace ↑' : '↑ retrace ↓'}</div>
          <div class="fmc-date">${_esc(trendState)}</div>
        </div>
      </div>
      <canvas id="fib-mini-canvas" class="fib-mini-canvas-large"></canvas>
    </div>
  `;
}

function _renderVolumeTab(outputs, bars) {
  const vs = outputs.volume_state?.facts || {};
  const fullVs = outputs.volume_state?.primitives?.[0]?.factors || {};
  if (!vs.rvol_regime) {
    return `<div class="dock-empty">volume_state producer not available for this run</div>`;
  }
  const fmtPct = n => typeof n === 'number' ? `${n.toFixed(2)}` : '—';
  const sparkRows = (fullVs.rvol_history || []).map(r => {
    const w = Math.min(100, Math.max(8, r * 40));   // 1.0 → 40%, 2.5 → 100%
    const cls = r >= 2.0 ? 'up' : r >= 1.4 ? 'warn' : r < 0.6 ? 'down' : '';
    return `<div class="vs-spark-bar"><span class="vs-spark-fill ${cls}" style="width:${w}%"></span><span class="vs-spark-val">${r.toFixed(2)}</span></div>`;
  }).join('');

  const climaxRow = fullVs.climax_bar_t
    ? `<tr><td>Climax bar</td><td class="up">${new Date(fullVs.climax_bar_t * 1000).toISOString().slice(0,10)} · RVOL ${fullVs.climax_bar_rvol}</td></tr>`
    : `<tr><td>Climax bar</td><td>none in 20d</td></tr>`;
  const nakedRow = (fullVs.vp_naked_poc_age_d != null)
    ? `<tr><td>Naked POC age</td><td class="warn">${fullVs.vp_naked_poc_age_d}d untouched</td></tr>`
    : `<tr><td>Naked POC age</td><td>—</td></tr>`;
  const expiryRow = fullVs.expiry_week_caveat
    ? `<tr><td>Expiry week</td><td class="warn">YES · rollover distortion likely</td></tr>`
    : `<tr><td>Expiry week</td><td>no</td></tr>`;
  const deliveryRow = (fullVs.delivery_pct != null)
    ? `<tr><td>Delivery %</td><td>${fmtPct(fullVs.delivery_pct)}%</td></tr>`
    : `<tr><td>Delivery %</td><td class="dim">— (F&O data not wired yet)</td></tr>`;

  return `
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:18px;">
      <div>
        <div class="r-head">RVOL · last 5 bars</div>
        <div class="vs-spark">${sparkRows || '<div class="dock-empty">—</div>'}</div>
        <div style="margin-top:12px; font-size:12px; color:var(--text-2);">
          <strong style="color:var(--text); font-size:14px;">${_esc(vs.rvol_regime)}</strong> · current RVOL <strong>${vs.rvol_current.toFixed(2)}</strong>
        </div>
      </div>
      <div>
        <div class="r-head">Volume Profile (recent ${fullVs.vp_window_bars || 60} bars)</div>
        <table class="rs-table"><tbody>
          <tr><td>POC</td><td>₹${(vs.vp_poc ?? 0).toFixed(2)}</td></tr>
          <tr><td>VAH</td><td>₹${(vs.vp_vah ?? 0).toFixed(2)}</td></tr>
          <tr><td>VAL</td><td>₹${(vs.vp_val ?? 0).toFixed(2)}</td></tr>
        </tbody></table>
      </div>
      <div style="grid-column: span 2;">
        <div class="r-head">Microstructure</div>
        <table class="rs-table"><tbody>
          <tr><td>ATV20</td><td class="${vs.atv20_meets_min ? 'up' : 'down'}">₹${(vs.atv20_crores ?? 0).toFixed(0)}Cr ${vs.atv20_meets_min ? '· meets 20Cr min' : '· below 20Cr F&O min'}</td></tr>
          ${climaxRow}
          ${nakedRow}
          ${expiryRow}
          ${deliveryRow}
        </tbody></table>
      </div>
    </div>
  `;
}

function _renderRelativeTab(outputs, bars) {
  const rsF = outputs.relative_strength?.facts || {};
  if (!rsF.rs_classification) {
    return `<div class="dock-empty">relative_strength producer not available for this run</div>`;
  }
  const fmt = (n) => typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
  const cls = (n) => typeof n === 'number' ? (n >= 0 ? 'up' : 'down') : '';
  const corr = (typeof rsF.correlation_60d === 'number') ? rsF.correlation_60d.toFixed(2) : '—';
  return `<table class="rs-table">
    <thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Classification</td><td>${_esc(rsF.rs_classification.replace(/_/g,' ').toUpperCase())}</td></tr>
      <tr><td>RS Score</td>      <td>${_esc(String(rsF.rs_score ?? '—'))}/10</td></tr>
      <tr><td>10d vs NIFTY500</td><td class="${cls(rsF.rs_10d_pct)}">${fmt(rsF.rs_10d_pct)}</td></tr>
      <tr><td>20d vs NIFTY500</td><td class="${cls(rsF.rs_20d_pct)}">${fmt(rsF.rs_20d_pct)}</td></tr>
      <tr><td>50d vs NIFTY500</td><td class="${cls(rsF.rs_50d_pct)}">${fmt(rsF.rs_50d_pct)}</td></tr>
      <tr><td>Correlation (60d)</td><td>${_esc(corr)}</td></tr>
    </tbody>
  </table>`;
}

function _renderSetupTab(outputs, bars) {
  const setupPrims = (outputs.setup?.primitives || []).filter(p => p.kind === 'setup');
  if (!setupPrims.length || setupPrims[0].factors?.family === 'NO_SETUP') {
    return `<div class="dock-empty">No setup detected — state machine in idle</div>`;
  }
  return setupPrims.map(sp => {
    const f = sp.factors || {};
    const conds = (f.conditions_met || []).join(' · ') || '—';
    const targets = (f.target_levels || []).map(n => `₹${(+n).toFixed(0)}`).join(' → ') || 'TBD';
    return `<div class="setup-card">
      <div class="sc-title">${_esc((f.setup_name || 'setup').replace(/_/g,' '))}</div>
      <div class="sc-line"><span class="k">Family</span><span class="v">${_esc(f.family || '')}</span></div>
      <div class="sc-line"><span class="k">Status</span><span class="v">${_esc(f.status || 'forming')} · score ${_esc(String(f.confidence_score ?? 0))}/100</span></div>
      <div class="sc-line"><span class="k">Trigger</span><span class="v">${_esc(f.trigger || '')}</span></div>
      <div class="sc-line"><span class="k">Invalidation</span><span class="v">${_esc(f.invalidation || '')}</span></div>
      <div class="sc-line"><span class="k">Targets</span><span class="v">${_esc(targets)}</span></div>
      <div class="sc-line"><span class="k">Conditions met</span><span class="v">${_esc(conds)}</span></div>
    </div>`;
  }).join('');
}

function _renderJournalTab(outputs, bars) {
  return `<div class="ph-card">
    <div class="ph-title">Trade Journal</div>
    <div class="ph-desc">Per-trade outcome logging + cockpit-state snapshot replay. Drives the Phase-8 Validation Gate — does cockpit improve operator edge?</div>
    <div class="ph-badge">PHASE 8</div>
  </div>`;
}

// (Tier-1 fix-pass-2: tabs replaced by tile-garden — no tab click handler needed)

// ─── Click-outside closes Layers / Producers <details> dropdowns ──────────
// Native <details> only toggles when its <summary> is clicked. Operators
// expect a popover-style "click outside to dismiss" — wire that here.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.dd-menu[open]').forEach(d => {
    if (!d.contains(e.target)) d.open = false;
  });
});

// ─── Position the chart-toolbar dropdowns when they open ──────────────────
// CSS sets position:fixed on .chart-toolbar .dd-body so the dropdown escapes
// the chart cell's overflow:hidden clip. JS computes the fixed coordinates
// from the toggle summary's location each time the menu opens.
function _positionToolbarDropdown(detailsEl) {
  const body = detailsEl.querySelector('.dd-body');
  if (!body) return;
  const summary = detailsEl.querySelector('summary');
  const rect = summary.getBoundingClientRect();
  // Open UPWARD from the summary — there's space ABOVE (chart area).
  // Below the toolbar is the dock cell which has limited room.
  // Anchor the dropdown's BOTTOM edge 6px above the summary's TOP edge;
  // the dropdown's own height makes it grow upward naturally.
  body.style.left   = rect.left + 'px';
  body.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  body.style.top    = 'auto';
}
// Toggle handler — re-positions every time a chart-toolbar dropdown opens.
document.querySelectorAll('.chart-toolbar .dd-menu').forEach(d => {
  d.addEventListener('toggle', () => {
    if (d.open) _positionToolbarDropdown(d);
  });
});
// Re-position on window resize while open
// Phase 1.C Session 8 — wire the view-mode pills.
(function initViewModePills() {
  const container = document.getElementById('view-mode-pills');
  if (!container) return;
  // Reflect persisted state in the mode pills (exit pill has no data-mode)
  for (const btn of container.querySelectorAll('.vm-pill[data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === _v2ViewMode);
    btn.addEventListener('click', () => {
      _v2ViewMode = btn.dataset.mode;
      try { localStorage.setItem('tietiy_view_mode', _v2ViewMode); } catch {}
      for (const b2 of container.querySelectorAll('.vm-pill[data-mode]')) {
        b2.classList.toggle('active', b2.dataset.mode === _v2ViewMode);
      }
      _scheduleOverlayRedraw();
    });
  }
})();

// Phase 1.C Session 8 — wire the decision-panel collapse chevron.
(function initPanelCollapse() {
  const btn = document.getElementById('btn-panel-collapse');
  if (!btn) return;
  btn.addEventListener('click', () => {
    _v2PanelCollapsed = !_v2PanelCollapsed;
    document.body.classList.toggle('panel-collapsed', _v2PanelCollapsed);
    try { localStorage.setItem('tietiy_panel_collapsed',
                                _v2PanelCollapsed ? '1' : '0'); } catch {}
    _scheduleOverlayRedraw();
  });
})();

window.addEventListener('resize', () => {
  document.querySelectorAll('.chart-toolbar .dd-menu[open]').forEach(_positionToolbarDropdown);
});
// ESC also closes them.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.dd-menu[open]').forEach(d => { d.open = false; });
  }
});

// ─── Wire cmdbar top-tabs (chart/scanner/etc) — all but chart are stubs ────
document.querySelectorAll('.cmd-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('dim')) return;
    document.querySelectorAll('.cmd-tab').forEach(t => t.classList.toggle('active', t === tab));
  });
});

const ddProducersBody = document.getElementById('dd-producers-body');
const ctxContent = document.getElementById('sp-context-content');
const spSelected = document.getElementById('sp-selected');
const spSelectedContent = document.getElementById('sp-selected-content');

// Status pill — short label in the chip + full detail string in title tooltip.
// Operator complaint 2026-06-03: "live · 2977 bars · lookback=169/357 …" was
// ugly and overflowed the corner. Now collapses to "LIVE 2977b" or similar.
function showStatus(kind, text){
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  // Keep the full detail string accessible via tooltip
  statusEl.title = text || '';
  let short;
  if (kind === 'live') {
    // "live · 2977 bars · lookback=…" → "LIVE · 2977b"
    const m = /(\d{2,5})\s*bars?/i.exec(text || '');
    short = m ? `LIVE · ${m[1]}b` : 'LIVE';
  } else if (kind === 'error') {
    short = 'ERROR';
  } else if (/loading/i.test(text || '')) {
    short = 'LOADING';
  } else if (/universe loaded/i.test(text || '')) {
    short = 'READY';
  } else if (!text || /no symbol|idle/i.test(text)) {
    short = 'IDLE';
  } else {
    short = (text || '').slice(0, 14);
  }
  statusText.textContent = short;
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
  if (ctxContent) ctxContent.innerHTML = `<div class="sp-warn">no data — ${_esc(msg)}</div>`;
  // Tier-1 redesign: rail/dock take over from side-panel for error rendering
  const _rail = document.getElementById('rail');
  if (_rail) _rail.innerHTML = `<div class="err">no data — ${_esc(msg)}</div>`;
  const _dockBody = document.getElementById('dock-body');
  if (_dockBody) _dockBody.innerHTML = `<div class="dock-empty">no data — ${_esc(msg)}</div>`;
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
  // Tier-1 redesign: side-panel is replaced by the right rail + bottom dock.
  // The rail renders the Decision Verb hero, HTF/regime context, key levels.
  // The dock renders the tabbed intelligence panels (Levels/Plans/News/…).
  // Legacy ctxContent (if it still exists for some reason) gets a minimal stub.
  if (ctxContent) ctxContent.innerHTML = '';
  _renderRail();
  _renderDock();
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

  // ── Read pre-computed dashboard_state primitive (§5.1 compliance — composite
  // math lives in producers/dashboard_state.py, not here). Falls back gracefully
  // when the producer's output isn't present (e.g. older PIT dates).
  const dsPrim = outputs.dashboard_state?.primitives?.[0];
  const ds = dsPrim?.factors || null;

  const trendState = ds?.trend_state || (sl.facts || {}).trend_state || 'TRANSITIONAL';
  const zones = (sr?.primitives || []).filter(p => p.kind === 'sr_zone');
  const supplyZone = zones.find(z => (z.factors?.classification || '').includes('resistance'));
  const pivotZone  = zones.find(z => z.factors?.classification === 'minor_support');
  const htfDemand  = zones.find(z => (z.factors?.htf_confirmed && (z.factors?.classification || '').includes('support')));

  const structureStateText = ds?.structure_state_text || 'Range';
  const decision           = ds?.decision || 'No Edge';
  const decisionClassRaw   = ds?.decision_class || 'dim';
  const decisionClass      = ({ warn: 'val-warn', bull: 'val-bull', bear: 'val-bear', dim: 'val-dim' })[decisionClassRaw] || 'val-dim';

  // Composites read from producer (§5.3 — score_breakdown sibling visible)
  const trade_readiness = ds?.trade_readiness_score ?? 0;
  const trBreakdown     = ds?.trade_readiness_breakdown || {};
  const decision_confidence = ds?.decision_confidence_score ?? 0;
  const dcBreakdown     = ds?.decision_confidence_breakdown || {};

  const activeStructure = ds?.active_structure_text || 'No CHoCH trigger derived';
  const priceLocation   = ds?.price_location_text   || 'Mid-zone';
  const chochPrice      = (typeof ds?.choch_trigger_price === 'number') ? ds.choch_trigger_price : null;

  // Key levels from the producer (already formatted)
  const dsLevels = ds?.key_levels || [];
  const levels = dsLevels.map(l => ({
    name:  l.name,
    price: l.value,
    cls:   `lv-${l.kind}`,
  }));

  // Helper: a colored 0-100 bar — replaces verbose text breakdowns. Hover shows the math.
  // Compact, scannable. The label is rendered next to the bar.
  function _scoreBar(score, max, cls) {
    const pct = Math.max(0, Math.min(100, Math.round((score / max) * 100)));
    return `<div class="score-bar ${cls || ''}"><div class="score-bar-fill" style="width:${pct}%"></div></div>`;
  }
  function _breakdownChips(breakdown, max) {
    if (!breakdown || !Object.keys(breakdown).length) return '';
    const parts = Object.entries(breakdown).map(([k, v]) => {
      const pct = Math.round((v / max) * 100);
      const label = k.replace(/_/g, ' ');
      return `<span class="bk-chip" title="${label}: ${v}/${max}"><span class="bk-chip-bar" style="--w:${pct}%"></span><span class="bk-chip-lbl">${_esc(label)}</span><span class="bk-chip-val">${v}</span></span>`;
    });
    return `<div class="bk-chips">${parts.join('')}</div>`;
  }

  let html = '';
  // ── CORE READ — first-glance state + decision ──
  html += `<div class="dash-section-head">Core Read</div>`;
  html += `<div class="dash-row"><div class="dash-key">STRUCTURE STATE</div><div class="dash-val val-warn">${_esc(structureStateText)}</div></div>`;
  html += `<div class="dash-row"><div class="dash-key">DECISION</div><div class="dash-val ${decisionClass}">${_esc(decision)}</div></div>`;

  html += `<div class="dash-row"><div class="dash-key">TRADE READINESS</div>`;
  html += `<div class="dash-score-row"><span class="dash-score-num">${trade_readiness}</span><span class="dash-score-max">/100</span></div>`;
  html += _scoreBar(trade_readiness, 100, 'sb-warn');
  html += _breakdownChips(trBreakdown, 25);
  html += `</div>`;

  html += `<div class="dash-row"><div class="dash-key">DECISION CONFIDENCE</div>`;
  html += `<div class="dash-score-row"><span class="dash-score-num">${decision_confidence}</span><span class="dash-score-max">%</span><span class="dash-score-in">in ${_esc(decision)}</span></div>`;
  html += _scoreBar(decision_confidence, 100, 'sb-bull');
  html += _breakdownChips(dcBreakdown, 25);
  html += `</div>`;

  // ── STRUCTURE & LOCATION ──
  html += `<div class="dash-section-head">Structure & Location</div>`;
  html += `<div class="dash-row"><div class="dash-key">ACTIVE STRUCTURE</div><div class="dash-text">${_esc(activeStructure)}</div></div>`;
  html += `<div class="dash-row"><div class="dash-key">PRICE LOCATION</div><div class="dash-text">${_esc(priceLocation)}</div></div>`;

  // ── CONTEXT — RS / regime / event-risk ──
  html += `<div class="dash-section-head">Context</div>`;
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

  // ── Placeholder cards for upcoming phases (user request 2026-06-03) ──
  // Surfaces where Phase-2/Phase-8 work will land so the layout doesn't feel
  // empty + signals intent. Each card grays-out + carries a "soon" badge.
  html += `<div class="dash-row dash-placeholder-row"><div class="dash-key">UPCOMING — PHASE 2</div>`;
  html += `<div class="placeholder-grid">`;
  html += _placeholderCard('Sentiment Gauge',  'Aggregate news + social sentiment trajectory', 'Phase 2');
  html += _placeholderCard('News Impact Map',  'Per-category impact score (earnings / macro / sector)', 'Phase 2');
  html += _placeholderCard('Correlation Panel', 'Rolling correlation vs sector + market indices', 'Phase 2');
  html += _placeholderCard('Earnings Calendar', 'Next results dates + analyst expectations', 'Phase 2');
  html += `</div></div>`;

  html += `<div class="dash-row dash-placeholder-row"><div class="dash-key">UPCOMING — PHASE 8 (VALIDATION GATE)</div>`;
  html += `<div class="placeholder-grid">`;
  html += _placeholderCard('Setup Calibration', 'Per-setup historical hit rate from journal', 'Phase 8');
  html += _placeholderCard('Confidence Calibration', 'Predicted vs actual outcome buckets', 'Phase 8');
  html += `</div></div>`;

  html += `<div class="dash-disclaimer">DECISION SUPPORT TOOL. NOT FINANCIAL ADVICE. TRADE AT YOUR OWN RISK.</div>`;
  return html;
}

function _placeholderCard(title, desc, phase) {
  return `<div class="ph-card">
    <div class="ph-title">${_esc(title)}<span class="ph-badge">${_esc(phase)}</span></div>
    <div class="ph-desc">${_esc(desc)}</div>
  </div>`;
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

  // header — initial render before primitives load (re-rendered later with metadata
  // once stock_metadata producer's output is fetched in loadPrimitivesForCurrent).
  const last = bars[bars.length-1], prev = bars[bars.length-2] || last;
  const chg = last.close - prev.close, chgPct = (chg/prev.close*100);
  const hi52 = Math.max(...bars.map(b=>b.high)), lo52 = Math.min(...bars.map(b=>b.low));
  const up = chg >= 0;
  _renderSymhead({
    symbol: sym,
    company_name: '',   // metadata not loaded yet
    industry: '',
    sector: '',
    market_cap_cr: null,
    avg_volume_10d: null,
    beta: null,
    last_close: last.close,
    change: chg,
    change_pct: chgPct,
    period_high: hi52,
    period_low: lo52,
    last_bar_iso: epochToISO(last.time),
    volume: last.volume,
    bars_count: bars.length,
  });

  placeholder.style.display = 'none';
  placeholder.className = 'placeholder';
  // Suppress LWC's crosshair OHLC overlay (#legend) — was overlapping the state
  // banner at the top of the chart, and we already surface current OHLC in the
  // metadata header (2026-06-03 fix).
  legend.style.display = 'none';

  await loadPrimitivesForCurrent();
  // Fetch V2 plot items for the (symbol, date) if V2 mode is on.
  // We fetch lazily — only when the toggle is on. Avoids the network round-trip
  // for operators who never enable V2 view.
  if (showV2Mode) {
    _loadAndDrawV2();
  }
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

  // ── Wyckoff phase + Creek/Ice channel ───────────────────────────────────
  _wyckoffToDraw = null;
  if (showWyckoff && !presentMode) {
    const wkOut = currentPrimitives['wyckoff_phase'];
    const wkPrim = (wkOut?.primitives || []).find(p => p.kind === 'wyckoff_phase');
    if (wkPrim) {
      const f = wkPrim.factors || {};
      _wyckoffToDraw = {
        phase:   f.phase,
        context: f.context,
        events:  f.events || [],
        channel: f.channel || null,
      };
    }
  }

  // ── Candle psychology → canvas-overlay list ─────────────────────────────
  _candlePsychToDraw.length = 0;
  if (showCandlePsych && !presentMode) {
    const cpOut = currentPrimitives['candle_psychology'];
    const cpPrims = (cpOut?.primitives || []).filter(p => p.kind === 'candle_psychology');
    for (const p of cpPrims) {
      const f = p.factors || {};
      _candlePsychToDraw.push({
        t:        p.anchors[0].t,
        price_hi: p.price_hi,
        price_lo: p.price_lo,
        pattern:  f.pattern,
        direction: f.direction,
        psychology: f.psychology,
      });
    }
  }

  // ── Traps → canvas-overlay list ─────────────────────────────────────────
  _trapsToDraw.length = 0;
  if (showTraps && !presentMode) {
    const trOut = currentPrimitives['trap'];
    const trPrims = (trOut?.primitives || []).filter(p => p.kind === 'trap');
    for (const p of trPrims) {
      const f = p.factors || {};
      _trapsToDraw.push({
        failure_bar_t:  f.failure_bar_t,
        failure_close:  f.failure_close,
        bos_event_t:    f.bos_event_t,
        bos_level:      f.bos_level,
        direction:      f.direction,
        qualified:      !!f.meets_rvol_gate,
      });
    }
  }

  // ── Liquidity sweeps → canvas-overlay list ──────────────────────────────
  // Recent sweeps with reclaim. Spring/UTAD get bigger markers + labels.
  _sweepsToDraw.length = 0;
  if (showLiquiditySweeps && !presentMode) {
    const lsOut = currentPrimitives['liquidity_sweep'];
    const lsPrims = (lsOut?.primitives || []).filter(p => p.kind === 'liquidity_sweep');
    for (const p of lsPrims) {
      const f = p.factors || {};
      _sweepsToDraw.push({
        t:                 p.anchors[0].t,
        price:             p.price,
        direction:         f.direction,
        swept_pivot_t:     f.swept_pivot_t,
        swept_pivot_price: f.swept_pivot_price,
        is_spring:         !!f.is_spring,
        is_utad:           !!f.is_utad,
      });
    }
  }

  // ── Order blocks → canvas-overlay list ──────────────────────────────────
  // Bullish OB (green) = down candle before strong up impulse.
  // Bearish OB (red)   = up candle before strong down impulse.
  // Lifecycle states tint the alpha: fresh > tested > mitigated.
  _orderBlocksToDraw.length = 0;
  if (showOrderBlocks && !presentMode) {
    const obOut = currentPrimitives['order_block'];
    const obPrims = (obOut?.primitives || []).filter(p => p.kind === 'order_block');
    for (const p of obPrims) {
      const f = p.factors || {};
      const isBull = f.direction === 'bullish_ob';
      const fresh = !!f.fresh;
      const tested = !!f.tested;
      const mitigated = !!f.mitigated;
      // Alpha gradient by lifecycle state — fresh is loudest.
      const alphaFill   = mitigated ? 0.05 : (fresh ? 0.18 : 0.10);
      const alphaBorder = mitigated ? 0.30 : (fresh ? 0.90 : 0.55);
      const fill   = isBull
        ? `rgba(34, 197, 94, ${alphaFill})`
        : `rgba(239, 68, 68, ${alphaFill})`;
      const border = isBull
        ? `rgba(34, 197, 94, ${alphaBorder})`
        : `rgba(239, 68, 68, ${alphaBorder})`;
      _orderBlocksToDraw.push({
        start_t:        p.anchors[0].t,
        mitigated_at_t: f.mitigated_at_t || null,
        price_hi: p.price_hi,
        price_lo: p.price_lo,
        fill, border,
        fresh, tested, mitigated,
        direction: f.direction,
      });
    }
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

  // Refresh hero column (company name + price + chips + regime pill + RS block)
  _refreshSymheadFromMetadata(currentPrimitives);
  // Banner — top-of-chart concat of structure + lifecycle + position + verdict
  _buildStateBanner();
  // Tier-1 redesign: rail + dock replace the old side-panel + bottom-strip + news-strip.
  // updateContextBox is now a thin shim that invokes both.
  updateContextBox(currentPrimitives);
  // No-op call paths kept for compatibility with any external code reading these globals;
  // their DOM targets (bottomPanels, news-timeline) no longer exist so they early-return.
  _buildBottomPanels();
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
bindToggle('t-order-blocks',
  () => { showOrderBlocks = true;  applyImportanceFilterAndRender(); },
  () => { showOrderBlocks = false; applyImportanceFilterAndRender(); });
bindToggle('t-liquidity-sweeps',
  () => { showLiquiditySweeps = true;  applyImportanceFilterAndRender(); },
  () => { showLiquiditySweeps = false; applyImportanceFilterAndRender(); });
bindToggle('t-traps',
  () => { showTraps = true;  applyImportanceFilterAndRender(); },
  () => { showTraps = false; applyImportanceFilterAndRender(); });
bindToggle('t-candle-psych',
  () => { showCandlePsych = true;  applyImportanceFilterAndRender(); },
  () => { showCandlePsych = false; applyImportanceFilterAndRender(); });
bindToggle('t-wyckoff',
  () => { showWyckoff = true;  applyImportanceFilterAndRender(); },
  () => { showWyckoff = false; applyImportanceFilterAndRender(); });
bindToggle('t-v2-mode',
  () => { showV2Mode = true;  _loadAndDrawV2(); },
  // OFF path: re-render the full primitive set so LWC markers + price-line
  // chips + trend badge come back. Just clearing the canvas isn't enough —
  // those legacy artifacts live on the LWC chart, not the canvas overlay.
  () => { showV2Mode = false; applyImportanceFilterAndRender(); });

// ─── Fullscreen-chart anchors: real <a target="_blank"> with a dynamic
//     href. Browsers handle this as native link nav — no popup blockers
//     in play. We just keep the href in sync with the loaded symbol.
function _updateFullchartHref() {
  const sym = currentSymbol || (new URLSearchParams(location.search)).get('sym') || '';
  // Always keep the link valid (operator can still click before loading a
  // symbol; in that case open the landing page in a new tab — harmless).
  const u = new URL(location.href);
  if (sym) u.searchParams.set('sym', sym);
  u.searchParams.set('fullchart', '1');
  const href = u.toString();
  for (const id of ['btn-fullchart', 'btn-fullchart-top']) {
    const a = document.getElementById(id);
    if (a) a.setAttribute('href', href);
  }
}
// Wire initial state + an update on every loadSymbol completion. We override
// loadSymbol so the href always reflects what the operator just opened.
_updateFullchartHref();
const _origLoadSymbol = loadSymbol;
loadSymbol = async function (sym) {
  const r = await _origLoadSymbol(sym);
  _updateFullchartHref();
  return r;
};

// Apply fullchart-mode class to body when ?fullchart=1 is present.
// CSS hides hero/banner/rail/dock and expands .chart to fill the viewport.
if ((new URLSearchParams(location.search)).get('fullchart') === '1') {
  document.body.classList.add('fullchart-mode');
}

// Exit-fullchart button — strip ?fullchart from the URL and reload so the
// dock/hero/rail come back. Using history.replaceState + reload (instead of
// just removing the class) ensures any layout-dependent listeners that ran
// at fullchart-load time get re-initialized cleanly with the full layout.
(function wireExitFullchart() {
  const btn = document.getElementById('btn-exit-fullchart');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.delete('fullchart');
    location.assign(u.toString());
  });
})();
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
  // Date change → invalidate V2 cache so we re-fetch for the new PIT date.
  _v2PlotItems = null;
  _v2PlotMeta = null;
  CURRENT_DATE = pitDateSel.value;
  await loadPrimitivesForCurrent();
  if (showV2Mode) _loadAndDrawV2();
});

// ---- Importance filter slider (display-only; no recompute) ----
impSlider.addEventListener('input', () => {
  currentImportanceThreshold = Number(impSlider.value) || 0;
  impValue.textContent = String(currentImportanceThreshold);
  applyImportanceFilterAndRender();
});

// Populate the landing placeholder's chip cloud with every symbol in the
// universe — click any chip to load it. Re-rendered whenever the universe
// changes (only at bootstrap currently, but cheap enough).
function _renderLandingChips() {
  const wrap = document.getElementById('ph-chips');
  if (!wrap) return;
  if (!UNIVERSE.length) {
    wrap.innerHTML = `<span class="ph-chip-dim">universe failed to load</span>`;
    return;
  }
  wrap.innerHTML = UNIVERSE.map(s => `<span class="ph-chip" data-sym="${_esc(s)}">${_esc(s)}</span>`).join('');
}
// Click delegation for landing chips
document.addEventListener('click', e => {
  const chip = e.target.closest && e.target.closest('.ph-chip');
  if (chip && chip.dataset && chip.dataset.sym) {
    const sym = chip.dataset.sym;
    const searchEl = document.getElementById('search');
    if (searchEl) searchEl.value = sym;
    loadSymbol(sym);
  }
});

// ---- bootstrap: load universe + run-dates, then optionally auto-load ?sym= ----
(async () => {
  // Tier-1 redesign: fire cmdbar index chips in parallel (NIFTY / BANKNIFTY / VIX)
  _renderCmdbarIndices();   // fire-and-forget; safe to await later if needed
  const [u, rd] = await Promise.all([fetchUniverse(), fetchRunDates()]);
  if (u.ok){
    UNIVERSE = u.symbols;
    showStatus('', `universe loaded · ${UNIVERSE.length} symbols`);
  } else {
    UNIVERSE = [];
    showStatus('error', `universe unavailable: ${u.error}`);
    dropdown.innerHTML = `<div class="dd-empty">universe load failed: ${u.error}</div>`;
  }
  // Landing-page chip cloud now that we know what's in the universe
  _renderLandingChips();
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
  if (sym){
    search.value = sym.toUpperCase();
    loadSymbol(sym.toUpperCase());
  } else {
    // No deep link → focus the search input so the operator can start typing
    // immediately. Defer to next tick so the input is laid out first.
    requestAnimationFrame(() => { if (search) search.focus(); });
  }
})();
