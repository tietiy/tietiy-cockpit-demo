// primitive_renderer.js — dispatch on `kind` from a ProducerOutput's primitives[]
// and draw on the chart via lightweight-charts.
//
// Kinds handled:
//   swing_pivot / pivot_source=lookback_n10  -> gold arrow marker on candle series
//                                                (+ HH/HL text attached if structure_label exists at same t)
//   swing_pivot / pivot_source=zigzag        -> green up-leg / red down-leg line series
//   swing_pivot / pivot_source=zigzag_minor  -> single muted purple polyline (backdrop)
//   structure_label (P3-1)                   -> text label_kind text overlaid on the
//                                                matching lookback marker at the same bar
//   structure_event (P3-1)                   -> BOS = subtle directional marker; CHoCH = bold
//                                                circle with text; color matches trend_after
//   catalyst_marker (P3-1)                   -> small purple tick belowBar
//   other kinds (sr_zone, trendline, fib_level, ...) -> no-op stubs (P3-2+).
//
// All markers anchored on the candle series go through a SINGLE setMarkers call. Markers
// are sorted ascending by time before the call (LWC requirement).
//
// Click handler: app.js looks up clicked-bar -> matching primitives via markersByTime.

const COLORS_BY_PIVOT_SOURCE = {
  lookback_n10: '#d9a94e',  // gold — matches SMA50
  zigzag:       '#e89c47',  // orange — distinct from gold/blue/candle-up/candle-down
};
const DEFAULT_COLOR = '#9aa0a6';
const SIZE_MIN = 0.5;
const SIZE_MAX = 2.0;

// P3-1 palette
const EVENT_COLOR_BULL   = '#3fb27f';   // matches candle-up green
const EVENT_COLOR_BEAR   = '#e2574c';   // matches candle-down red
const EVENT_COLOR_NEUTRAL = '#9aa6b8';  // for TRANSITIONAL trend_before (rare)
const CATALYST_COLOR     = '#a78bfa';   // muted purple — distinct from structure layer
const LABEL_TEXT_COLOR   = '#d9a94e';   // gold (rides on top of the gold arrow markers)

// P3-2 palette — translucent so they sit BEHIND the price-action layers visually.
const SR_SUPPORT_COLOR    = 'rgba(91, 143, 217, 0.55)';   // muted blue
const SR_RESISTANCE_COLOR = 'rgba(226, 87, 76, 0.55)';    // muted red
const SR_MAJOR_WIDTH = 2;
const SR_VALID_WIDTH = 1;

// P3-4 palette — gold/orange family, distinct from SR's blue/red.
const FIB_GOLDEN_COLOR    = 'rgba(217, 169, 78, 0.70)';   // bold gold for 0.618, 0.786
const FIB_REGULAR_COLOR   = 'rgba(217, 169, 78, 0.45)';   // lighter gold for 0.382, 0.5
const FIB_EXTENSION_COLOR = 'rgba(217, 169, 78, 0.45)';   // same alpha, dotted style

function _markerSizeFromImportance(imp) {
  const clamped = Math.max(0, Math.min(100, Number(imp) || 0));
  return SIZE_MIN + (clamped / 100) * (SIZE_MAX - SIZE_MIN);
}

function _lookbackMarker(p) {
  // Gold lookback arrow. No text — the structure_label marker carries text separately
  // (in a different color) so the two don't visually merge.
  const isHigh = !!(p.factors && p.factors.is_high);
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  return {
    time: t,
    position: isHigh ? 'aboveBar' : 'belowBar',
    shape:    isHigh ? 'arrowDown' : 'arrowUp',
    color:    COLORS_BY_PIVOT_SOURCE.lookback_n10,
    size:     _markerSizeFromImportance(p.importance),
  };
}

function _structureLabelMarker(p, showText) {
  // Separate gray marker for HH/HL/LH/LL text. 'H' and 'L' first-of-kind are skipped.
  // showText = true → renders the label text alongside the dot. False → just a small
  // dot at the pivot bar (older structure: visible but textless, per doc §2.4).
  const f = p.factors || {};
  const lk = f.label_kind;
  if (!lk || lk === 'H' || lk === 'L') return null;
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  const isHigh = !!f.is_high;
  const isProvisional = p.certainty === 'provisional';
  return {
    time: t,
    position: isHigh ? 'aboveBar' : 'belowBar',
    shape: 'circle',
    color: isProvisional ? '#7e8a9c' : '#9aa6b8',
    size: showText ? 0.4 : 0.25,
    text: showText ? lk : undefined,
  };
}

function _eventRiskMarker(p) {
  // Corporate-event marker — dividend / bonus / split / AGM / board / earnings.
  // Sits aboveBar (news is belowBar; events are calendar context above).
  // Color tier by t_window_status:
  //   blocking (T-N..T+N) = bright red — DO NOT TRADE
  //   future (within ~30 days but past blackout) = orange — heads-up
  //   cleared (just past blackout) = cyan
  //   historical (>30 days past) = muted grey — context only
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  const f = p.factors || {};
  const evType = f.event_type || 'event';
  const window = f.t_window_status || 'historical';
  const blocking = f.blocking === true;
  const CODE = { dividend: 'DIV', bonus: 'BON', split: 'SPL', agm: 'AGM', board: 'BRD', earnings: 'ERN' };
  const color = blocking                      ? 'rgba(255,90,90,1.0)'
              : window === 'future'           ? 'rgba(240,160,67,0.95)'
              : window === 'cleared'          ? 'rgba(140,210,255,0.90)'
              :                                  'rgba(150,150,160,0.55)';  // historical
  const size = blocking ? 1.5 : window === 'future' ? 1.3 : window === 'cleared' ? 1.0 : 0.7;
  return {
    time:     t,
    position: 'aboveBar',
    shape:    'square',
    color,
    size,
    text:     CODE[evType] || 'EVT',
  };
}

function _newsMarker(p) {
  // News-event marker — single-letter category badge on the candle.
  // C=company, E=earnings, S=sector, M=macro, R=rumor.
  // Colour by sentiment (green/red/grey), size by impact tier.
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  const f = p.factors || {};
  const category  = f.category  || 'company';
  const sentiment = f.sentiment || 'neutral';
  const impact    = f.impact    || 'medium';
  const LETTER = {
    company: 'C', earnings: 'E', sector: 'S', macro: 'M', rumor: 'R',
  };
  // Confirmation modulates color alpha — confirmed news pops, contradicted/unconfirmed
  // dims to mute. The doc PART 13 insight: "news without price confirmation is noise."
  const confirmation = f.price_confirmation || 'n/a';
  const baseColor = sentiment === 'positive' ? '80,200,140'
                  : sentiment === 'negative' ? '220,90,80'
                  :                              '180,180,180';
  const alpha = confirmation === 'confirmed'    ? 1.0
              : confirmation === 'contradicted' ? 0.5   // visible but reduced
              : confirmation === 'unconfirmed'  ? 0.55
              : confirmation === 'pending'      ? 0.85
              :                                    0.85;  // n/a (neutral news)
  const color = `rgba(${baseColor},${alpha})`;
  const size  = impact === 'high' ? 1.5 : impact === 'medium' ? 1.2 : 0.9;
  return {
    time:     t,
    position: 'belowBar',   // sit below candles so they don't fight BOS/CHoCH (aboveBar)
    shape:    'circle',
    color,
    size,
    text:     LETTER[category] || 'C',
  };
}

function _eventMarker(p) {
  // BOS / CHoCH event from structure_label producer.
  // CHoCH = regime change → bold, prominent, text-labelled.
  // BOS    = continuation  → minimal, no text, half the visual weight.
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  const f = p.factors || {};
  const kind = f.event_kind;
  const trendAfter = f.trend_after;
  const color = trendAfter === 'BULL' ? EVENT_COLOR_BULL
              : trendAfter === 'BEAR' ? EVENT_COLOR_BEAR
              : EVENT_COLOR_NEUTRAL;
  if (kind === 'CHoCH') {
    return {
      time: t,
      position: trendAfter === 'BULL' ? 'belowBar' : 'aboveBar',
      shape: 'circle',
      color,
      size: 2.0,                    // largest available — pre-attentive
      text: 'CHoCH',
    };
  }
  // BOS — continuation marker. Bumped from 0.7 → 1.6 per practitioner feedback
  // 2026-06-02: 0.7 was invisibly subordinate. CHoCH stays at 2.0 (regime change is
  // the bigger event), but BOS at 1.6 is now clearly legible without overwhelming.
  return {
    time: t,
    position: trendAfter === 'BULL' ? 'belowBar' : 'aboveBar',
    shape:    trendAfter === 'BULL' ? 'arrowUp' : 'arrowDown',
    color,
    size: 1.6,
    text: 'BOS',
  };
}

function _catalystMarker(p) {
  // Purple tick belowBar — distinct visual layer from structure (doc §5.9).
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  return {
    time: t,
    position: 'belowBar',
    shape: 'square',
    color: CATALYST_COLOR,
    size: 0.6,
  };
}


function _zigzagPoint(p) {
  const t = p.anchors && p.anchors[0] && p.anchors[0].t;
  if (typeof t !== 'number') return null;
  return { time: t, value: p.price };
}

/**
 * Collapse same-direction runs in a list of zigzag pivots to their extremum,
 * restoring strict H/L/H/L alternation. Needed because the producer emits
 * alternating pivots, but a client-side importance filter may drop pivots
 * independently — leaving consecutive same-direction survivors. Connecting
 * those with a line yields visual sawtooths, not the intended ZigZag structure.
 *
 * Input  : array of swing_pivot primitives (any subset of one family), assumed
 *          already sorted ascending by anchors[0].t
 * Output : a subset where every consecutive pair alternates is_high. Each
 *          collapsed run is represented by its most-extreme member
 *          (highest price in an all-high run; lowest in an all-low run).
 *
 * Example (high/low/high/high/low → high/high/low):
 *   in   H1=110, L1=95,  H2=115, H3=118, L2=100
 *   out  H1=110, L1=95,  H3=118, L2=100        (H2 was dominated by H3)
 */
function _alternatingExtrema(prims) {
  if (!prims.length) return [];
  const out = [];
  let cur = prims[0];
  let curIsHigh = !!(cur.factors && cur.factors.is_high);
  for (let i = 1; i < prims.length; i++) {
    const p = prims[i];
    const isHigh = !!(p.factors && p.factors.is_high);
    if (isHigh === curIsHigh) {
      // Same-direction run — keep the more extreme one
      const swap = isHigh ? (p.price > cur.price) : (p.price < cur.price);
      if (swap) cur = p;
    } else {
      out.push(cur);
      cur = p;
      curIsHigh = isHigh;
    }
  }
  out.push(cur);
  return out;
}

/**
 * renderPrimitives(series, outputs, opts)
 *   series  : { candle, zigzagUp, zigzagDown, zigzagMinor }
 *   outputs : map {producer_name -> ProducerOutput dict}
 *   opts    : { showPivots, showLabels, showEvents, showCatalysts,
 *               showZigzagMajor, showZigzagMinor, showSRZones }
 *
 * Returns: { markersByTime, kindsRendered, totalMarkers,
 *            totalZigzagSegments, perSource,
 *            eventCount, catalystCount, structureLabelCount, srZoneCount,
 *            srLineRefs (array of LWC price-line refs — caller is responsible for
 *                       removing them via candle.removePriceLine before next render),
 *            trendState, lastChochT, daysSinceLastChoch }
 */
export function renderPrimitives(series, outputs, opts) {
  const showPivots       = opts ? opts.showPivots       !== false : true;
  const showLabels       = opts ? opts.showLabels       !== false : true;
  const showEvents       = opts ? opts.showEvents       !== false : true;
  const showCatalysts    = opts ? opts.showCatalysts    !== false : true;
  const showNews         = opts ? opts.showNews         !== false : true;
  const showSRZones      = opts ? opts.showSRZones      !== false : true;
  const showFibs         = opts ? opts.showFibs         !== false : true;
  const showTrendlines   = opts ? opts.showTrendlines   !== false : true;
  const showZigzagMajor  = opts ? opts.showZigzagMajor  === true  : false;   // default OFF
  const showZigzagMinor  = opts ? opts.showZigzagMinor  === true  : false;   // default OFF

  // Two marker arrays so we can control stacking: lookback gold arrows go FIRST
  // (closer to bar), structure-label gray markers go SECOND (further out). LWC
  // stacks markers in array order.
  // Pre-pass: collect anchor times of the LAST-3 confirmed structure_labels (Aproova-
  // tightened from §2.4's 6). Older labels keep their dot, drop text. Right-edge focus.
  const _allConfirmedLabels = [];
  for (const out of Object.values(outputs || {})) {
    for (const p of (out && out.primitives) || []) {
      if (p.kind === 'structure_label' && p.certainty === 'deterministic') {
        _allConfirmedLabels.push(p);
      }
    }
  }
  _allConfirmedLabels.sort((a, b) => a.anchors[0].t - b.anchors[0].t);
  const _recentHighs = _allConfirmedLabels.filter(p => p.factors && p.factors.is_high).slice(-2);
  const _recentLows  = _allConfirmedLabels.filter(p => p.factors && !p.factors.is_high).slice(-2);
  const labelTextTimes = new Set([
    ..._recentHighs.map(p => p.anchors[0].t),
    ..._recentLows.map(p => p.anchors[0].t),
  ]);

  // Right-edge focus: pivot arrows + event markers are heavily filtered to ONLY the
  // most recent. Aproova rule: don't render annotations across 2 years of history;
  // render the active structure at the right edge. Historical context stays in the
  // context box prose; chart shows what's IN PLAY.
  const RECENT_PIVOT_LOOKBACK_BARS = 80;     // ~4 months of recent pivots get arrows
  const RECENT_EVENT_LOOKBACK_BARS = 40;     // events older than this drop off the chart
  // Compute the "latest" t observed across primitives (any kind, any producer) so we
  // can filter relative to it without needing the bar series here.
  let _latestT = 0;
  for (const out of Object.values(outputs || {})) {
    for (const p of (out && out.primitives) || []) {
      const t = p.anchors && p.anchors[0] && p.anchors[0].t;
      if (typeof t === 'number' && t > _latestT) _latestT = t;
    }
  }
  const _recentPivotCutoffT = _latestT > 0 ? _latestT - RECENT_PIVOT_LOOKBACK_BARS * 86400 : 0;
  const _recentEventCutoffT = _latestT > 0 ? _latestT - RECENT_EVENT_LOOKBACK_BARS * 86400 : 0;

  const lookbackMarkers = [];
  const structLabelMarkers = [];
  const eventMarkers = [];
  const catalystMarkers = [];
  const newsMarkers = [];
  const eventRiskMarkers = [];
  const srZones = [];
  const trendlines = [];
  const fibLevels = [];

  const zigzagPrimsRaw = [];
  const zigzagMinorPrimsRaw = [];
  const markersByTime = {};
  const kindsRendered = {};
  const perSource = {};
  let eventCount = 0, catalystCount = 0, newsCount = 0, eventRiskCount = 0, structureLabelCount = 0;
  let srZoneCount = 0, trendlineCount = 0, fibLevelCount = 0;

  for (const [name, out] of Object.entries(outputs || {})) {
    const prims = (out && out.primitives) || [];
    for (const p of prims) {
      const kind = p.kind;
      kindsRendered[kind] = (kindsRendered[kind] || 0) + 1;
      const t = p.anchors && p.anchors[0] && p.anchors[0].t;
      if (typeof t === 'number') {
        (markersByTime[t] = markersByTime[t] || []).push({ producer: name, primitive: p });
      }

      if (kind === 'swing_pivot') {
        const source = (p.factors && p.factors.pivot_source) || 'unknown';
        perSource[source] = (perSource[source] || 0) + 1;
        if (source === 'lookback_n10') {
          // Right-edge filter: only emit arrows for pivots within last 80 bars.
          // Older pivots stay as raw bars, no overlay — Aproova "left-edge clean."
          const pt = p.anchors && p.anchors[0] && p.anchors[0].t;
          if (showPivots && typeof pt === 'number' && pt >= _recentPivotCutoffT) {
            const m = _lookbackMarker(p);
            if (m) lookbackMarkers.push(m);
          }
        } else if (source === 'zigzag') {
          if (showZigzagMajor) zigzagPrimsRaw.push(p);
        } else if (source === 'zigzag_minor') {
          if (showZigzagMinor) zigzagMinorPrimsRaw.push(p);
        }
      } else if (kind === 'structure_label') {
        structureLabelCount++;
        if (showLabels) {
          // Show text only if this label is one of the LAST 6 (per doc §2.4)
          // OR if it's the provisional last pivot (operator always wants to see what's tentative).
          const isProvisional = p.certainty === 'provisional';
          const showText = labelTextTimes.has(p.anchors[0].t) || isProvisional;
          const m = _structureLabelMarker(p, showText);
          if (m) structLabelMarkers.push(m);
        }
      } else if (kind === 'structure_event') {
        // Right-edge filter: only render events within the last 40 bars. Older
        // BOS/CHoCH events stay in the JSON for replay; the chart shows the recent
        // active regime change, not a 2-year archaeology of every event.
        const et = p.anchors && p.anchors[0] && p.anchors[0].t;
        if (showEvents && typeof et === 'number' && et >= _recentEventCutoffT) {
          const m = _eventMarker(p);
          if (m) { eventMarkers.push(m); eventCount++; }
        }
      } else if (kind === 'catalyst_marker') {
        if (showCatalysts) {
          const m = _catalystMarker(p);
          if (m) { catalystMarkers.push(m); catalystCount++; }
        }
      } else if (kind === 'news_marker') {
        if (showNews) {
          const m = _newsMarker(p);
          if (m) { newsMarkers.push(m); newsCount++; }
        }
      } else if (kind === 'event_marker') {
        if (showEvents) {
          const m = _eventRiskMarker(p);
          if (m) { eventRiskMarkers.push(m); eventRiskCount++; }
        }
      } else if (kind === 'sr_zone') {
        srZoneCount++;
        if (showSRZones) srZones.push(p);
      } else if (kind === 'trendline') {
        trendlineCount++;
        if (showTrendlines) trendlines.push(p);
      } else if (kind === 'fib_level') {
        fibLevelCount++;
        if (showFibs) fibLevels.push(p);
      } else if (kind === 'fib_grid') {
        // Anchor primitive — no direct visual; the fib_level lines define the swing.
      }
    }
  }

  // Single merged marker array, ordered: lookback first (closest to bar) →
  // structure labels (text above arrows) → events → catalysts. LWC requires
  // global sort by time after that, which preserves intra-time order.
  const markers = [...lookbackMarkers, ...structLabelMarkers, ...eventMarkers, ...catalystMarkers, ...newsMarkers, ...eventRiskMarkers];
  markers.sort((a, b) => a.time - b.time);

  // Pull trend-state metadata from structure_label producer for the corner badge.
  const sl = outputs && outputs.structure_label;
  const trendState         = (sl && sl.facts && sl.facts.trend_state) || null;
  const lastChochT         = (sl && sl.facts && sl.facts.last_choch_t) || null;
  const daysSinceLastChoch = (sl && sl.facts && sl.facts.days_since_last_choch);

  // ── zigzag: alternation-collapse then split into up-leg + down-leg series ──
  // After collapse the pivots strictly alternate H/L. Each consecutive pair forms
  // ONE leg — if (p[i].is_high == false && p[i+1].is_high == true) it's an up-leg
  // (low -> high), goes GREEN. Otherwise a down-leg (high -> low), goes RED.
  //
  // Each LWC line series uses `whitespace` data points (just {time}, no value) to
  // BREAK the line between non-adjacent legs of the same color.
  zigzagPrimsRaw.sort((a, b) => a.anchors[0].t - b.anchors[0].t);
  const zigzagPrims = _alternatingExtrema(zigzagPrimsRaw);

  const upLegData   = [];   // points for green up-leg series
  const downLegData = [];   // points for red down-leg series
  let upSegments = 0, downSegments = 0;

  for (let i = 0; i + 1 < zigzagPrims.length; i++) {
    const a = zigzagPrims[i];
    const b = zigzagPrims[i+1];
    const ta = a.anchors[0].t, tb = b.anchors[0].t;
    const va = a.price,        vb = b.price;
    const aIsHigh = !!(a.factors && a.factors.is_high);
    const bIsHigh = !!(b.factors && b.factors.is_high);

    if (!aIsHigh && bIsHigh) {
      // up-leg (low -> high)
      upLegData.push({ time: ta, value: va }, { time: tb, value: vb });
      upSegments++;
    } else if (aIsHigh && !bIsHigh) {
      // down-leg (high -> low)
      downLegData.push({ time: ta, value: va }, { time: tb, value: vb });
      downSegments++;
    }
    // (same-direction shouldn't happen after _alternatingExtrema, but if it did, skip)
  }

  // Each leg in the flat arrays is a [start, end] pair at positions [i, i+1].
  // LWC's line series connects consecutive points by default — so if I just push
  // all pairs sequentially the line will bridge across non-adjacent pairs
  // (pair-N.end -> pair-(N+1).start, which is visually wrong since that segment
  // would BE a down-leg drawn as up-color). Fix: insert a whitespace data point
  // ({time, no value}) BETWEEN consecutive pairs to break the line.
  function _segmentsWithGaps(flat) {
    if (flat.length === 0) return [];
    const out = [flat[0], flat[1]];                   // first segment
    for (let i = 2; i < flat.length; i += 2) {
      out.push({ time: flat[i-1].time + 1 });         // gap after prev segment
      out.push(flat[i], flat[i+1]);
    }
    return out;
  }

  const upData   = _segmentsWithGaps(upLegData);
  const downData = _segmentsWithGaps(downLegData);

  // ── Minor zigzag: single continuous polyline, unfiltered (the backdrop tier).
  // The 2% base threshold has already filtered noise; slider does NOT apply here.
  // Producer emits strictly alternating H/L; no collapse needed (no filter to break
  // alternation). Just sort by time and feed as a continuous line series.
  zigzagMinorPrimsRaw.sort((a, b) => a.anchors[0].t - b.anchors[0].t);
  const minorData = zigzagMinorPrimsRaw.map(_zigzagPoint).filter(Boolean);

  if (series.candle)      series.candle.setMarkers(markers);
  if (series.zigzagUp)    series.zigzagUp.setData(upData);
  if (series.zigzagDown)  series.zigzagDown.setData(downData);
  if (series.zigzagMinor) series.zigzagMinor.setData(minorData);

  // P3-3 trendlines — each is a 2-point segment. Same whitespace-gap pattern as zigzag
  // so multiple segments coexist on one series without LWC bridging them visually.
  if (series.trendlinesUp || series.trendlinesDown) {
    const tlUpData = [], tlDownData = [];
    for (const t of trendlines) {
      const a0 = t.anchors && t.anchors[0];
      const a1 = t.anchors && t.anchors[1];
      if (!a0 || !a1) continue;
      const direction = (t.factors && t.factors.direction) || 'up';
      const target = direction === 'up' ? tlUpData : tlDownData;
      if (target.length) target.push({ time: target[target.length - 1].time + 1 });   // gap
      target.push({ time: a0.t, value: a0.price });
      target.push({ time: a1.t, value: a1.price });
    }
    // LWC requires strictly ascending time across the series data — sort segments.
    function _sortSegments(arr) {
      // arr is [seg1.start, seg1.end, gap, seg2.start, seg2.end, gap, ...]
      // Each segment (2 points) is contiguous; gaps may be anywhere. Easier:
      // collect segments, sort by start time, rebuild with gaps between.
      if (!arr.length) return [];
      const segs = [];
      let i = 0;
      while (i < arr.length) {
        if ('value' in arr[i] && i + 1 < arr.length && 'value' in arr[i+1]) {
          segs.push([arr[i], arr[i+1]]);
          i += 2;
        } else {
          i += 1;   // skip gaps
        }
      }
      segs.sort((a, b) => a[0].time - b[0].time);
      const out = [];
      for (let j = 0; j < segs.length; j++) {
        if (j > 0) out.push({ time: out[out.length - 1].time + 1 });
        out.push(segs[j][0], segs[j][1]);
      }
      return out;
    }
    if (series.trendlinesUp)   series.trendlinesUp.setData(_sortSegments(tlUpData));
    if (series.trendlinesDown) series.trendlinesDown.setData(_sortSegments(tlDownData));
  }

  // P3-2 — S/R zones rendered as FILLED BANDS not single lines (Aproova/trader-doc).
  // Producer classifies each zone: current_actionable (nearest above + nearest below)
  // and strong_historical (3+ touch zone in extended range). Renderer drives 3 dedicated
  // AreaSeries via setData + applyOptions(baseValue). Max 3 zones drawn — Section 14
  // step 3 of the doc: "Must draw: 1) nearest support, 2) nearest resistance, 3) relevant".
  // Four-tier classification per practitioner-doc 2026-06-01:
  //   actionable_resistance | minor_support | major_support | major_resistance
  // Hierarchy preserves "minor = short-term reaction" vs "major = structural" semantic.
  let actionableResistance = null, minorSupport = null;
  let majorSupport = null, majorResistance = null;
  if (showSRZones) {
    for (const z of srZones) {
      const c = (z.factors || {}).classification;
      if (c === 'actionable_resistance')          actionableResistance = z;
      else if (c === 'minor_support')             minorSupport = z;
      else if (c === 'major_support')             majorSupport = z;
      else if (c === 'major_resistance')          majorResistance = z;
      // Legacy classifications (pre-2026-06-01 JSON) — defensive fallback
      else if (c === 'current_actionable_resistance') actionableResistance = z;
      else if (c === 'current_actionable_support')    minorSupport = z;
      else if (c === 'strong_historical')         {
        // Older "strong_historical" zones: classify by position now
        if (z.price < (z.factors?.distance_from_price_atr !== undefined ? z.price + 1 : z.price)) {
          // Can't determine position from this side reliably; use price comparison
          // with the actionable zones if available (rough heuristic for legacy data).
        }
        majorSupport = z;   // assume support for legacy (most common)
      }
    }
  }

  // P3-4 — Fibs. Split by swing_idx:
  //   current (0): createPriceLine on candle series, extends to right edge.
  //   prior   (1): SEPARATE line-series segments truncated to the prior swing's own
  //                 time window (per operator directive 2026-06-01 — prior fib must
  //                 NOT extend across the chart). Different color so it's visibly
  //                 historical context, not active.
  const fibLineRefs = [];
  const priorFibSegments = [];   // [{level_price, start_t, end_t, is_golden, is_extension}]
  const currentFibs = fibLevels.filter(fl => ((fl.factors || {}).swing_idx || 0) === 0);
  const priorFibsList = fibLevels.filter(fl => ((fl.factors || {}).swing_idx) === 1);

  // NOTE (2026-06-02): current-swing fibs were previously rendered via createPriceLine,
  // which stretches lines across the FULL chart width. Per practitioner-mockup feedback,
  // fibs should be a *bounded swing-window* visualization. The current-swing fibs are
  // now drawn on the canvas overlay (see app.js `_fibsToDraw` / `_drawFibsOverlay`).
  // This branch is intentionally suppressed; we still process priorFibs below.
  if (showFibs && series.candle) {
    // (current-swing fib lines rendered on overlay — no createPriceLine here)
    // Prior fibs: pass them through to caller via the return so app.js can manage
    // the prior-fib line series state (which are persistent series, not price lines).
    for (const fl of priorFibsList) {
      const f = fl.factors || {};
      const startT = f.swing_start_t;
      const endT   = f.swing_end_t;
      if (typeof startT !== 'number' || typeof endT !== 'number') continue;
      const ratio = Number(f.ratio);
      const isGolden = ratio === 0.618 || ratio === 0.786;
      const isExtension = f.level_type === 'extension';
      priorFibSegments.push({
        level_price: fl.price, start_t: startT, end_t: endT,
        ratio, is_golden: isGolden, is_extension: isExtension,
      });
    }
  }

  return {
    markersByTime,
    kindsRendered,
    totalMarkers: markers.length,
    totalZigzagSegments: upSegments + downSegments,
    totalZigzagMinorPoints: minorData.length,
    upSegments,
    downSegments,
    perSource,
    // P3-1 additions
    eventCount,
    catalystCount,
    structureLabelCount,
    trendState,
    lastChochT,
    daysSinceLastChoch,
    // P3-2 additions
    srZoneCount,
    actionableResistance,   // four-tier hierarchy per practitioner doc
    minorSupport,
    majorSupport,
    majorResistance,
    renderedSRZoneCount: (actionableResistance ? 1 : 0) + (minorSupport ? 1 : 0) +
                         (majorSupport ? 1 : 0) + (majorResistance ? 1 : 0),
    // P3-3 additions
    trendlineCount,
    // P3-4 additions
    fibLevelCount,
    fibLineRefs,
    priorFibSegments,   // [{level_price, start_t, end_t, ratio, is_golden, is_extension}]
  };
}

export function clearPrimitives(series, srLineRefs) {
  if (series.candle)         series.candle.setMarkers([]);
  if (series.zigzagUp)       series.zigzagUp.setData([]);
  if (series.zigzagDown)     series.zigzagDown.setData([]);
  if (series.zigzagMinor)    series.zigzagMinor.setData([]);
  if (series.trendlinesUp)   series.trendlinesUp.setData([]);
  if (series.trendlinesDown) series.trendlinesDown.setData([]);
  if (srLineRefs && series.candle) {
    for (const ref of srLineRefs) {
      try { series.candle.removePriceLine(ref); } catch (e) { /* already removed */ }
    }
  }
}
