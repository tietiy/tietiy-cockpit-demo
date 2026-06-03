// data_loader.js — STATIC-DEPLOY variant. All endpoints resolve to relative
// JSON files baked under ./data/ by scripts/bake_static_site.py.

export async function fetchUniverse() {
  try {
    const r = await fetch('data/universe.json', { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j.symbols) || j.symbols.length === 0) {
      return { ok: false, error: 'universe payload empty' };
    }
    return { ok: true, symbols: j.symbols };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || e}` };
  }
}

export async function fetchOhlcv(symbol) {
  try {
    const r = await fetch('data/ohlcv/' + encodeURIComponent(symbol) + '.json', { cache: 'no-store' });
    if (r.status === 404) return { ok: false, error: '404 — symbol not baked', symbol };
    if (!r.ok)            return { ok: false, error: `HTTP ${r.status}`, symbol };
    const j = await r.json();
    if (!j.bars || !j.bars.length) return { ok: false, error: 'empty bars', symbol };
    return { ok: true, symbol: j.symbol, bars: j.bars };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || e}`, symbol };
  }
}

export async function fetchRunDates() {
  try {
    const r = await fetch('data/run-dates.json', { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, dates: [] };
    const j = await r.json();
    return { ok: true, dates: Array.isArray(j.dates) ? j.dates : [] };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || e}`, dates: [] };
  }
}

export async function fetchPrimitives(date, symbol) {
  try {
    const url = 'data/primitives/' + encodeURIComponent(date) + '/' + encodeURIComponent(symbol) + '.json';
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return { ok: false, error: '404 — primitives not baked', date, symbol, outputs: {} };
    if (!r.ok)            return { ok: false, error: `HTTP ${r.status}`, date, symbol, outputs: {} };
    const j = await r.json();
    return { ok: true, date: j.date, symbol: j.symbol, outputs: j.outputs || {} };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || e}`, date, symbol, outputs: {} };
  }
}

export async function fetchV2PlotItems(date, symbol) {
  try {
    const url = 'data/v2/plot_items/' + encodeURIComponent(date) + '/' + encodeURIComponent(symbol) + '.json';
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) return { ok: false, error: '404 — V2 plot items not baked' };
    if (!r.ok)            return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message || e}` };
  }
}
