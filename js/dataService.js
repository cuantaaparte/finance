/* Datos de mercado. Prioridad: 1) precios en vivo/caché 24 h, 2) archivo data/market-data.js (generado en servidor, funciona con doble clic),
   3) estimaciones fijas. También aplica los TER de data/ters.js y calcula rentabilidades anualizadas. */
(function (App) {
  'use strict';
  const { config, storage } = App;
  const YEAR = 31557600, STALE_MS = 14 * 864e5; // segundos / ms
  const series = {}, liveIds = new Set();
  let snapDate = null, terDate = null;

  function applyLocalFiles() {
    const snap = App.snapshot;
    if (snap?.series && Object.keys(snap.series).length) { Object.assign(series, snap.series); snapDate = snap.updated; }
    const t = App.tersData;
    if (t?.ters) {
      config.FUNDS.forEach(f => f.providers.forEach(p => { if (typeof t.ters[p.id] === 'number') p.ter = t.ters[p.id]; }));
      terDate = t.updated;
    }
  }

  async function fetchJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  function parse(json) {
    const r = json.chart.result[0], closes = r.indicators.quote[0].close; // precio sin dividendos (éstos se añaden aparte)
    const pts = r.timestamp.map((t, i) => [t, closes[i]]).filter(p => p[1] > 0);
    if (pts.length < 13) throw new Error('histórico corto');
    return pts;
  }

  // Varios proxies a la vez; gana el primero que responda bien.
  function download(fund) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${fund.id}?range=max&interval=1mo`;
    return Promise.any(config.PROXIES.map(p => fetchJson(p(url)).then(parse)));
  }

  async function load(fund, force) {
    const stale = !snapDate || Date.now() - Date.parse(snapDate) > STALE_MS; // archivo local con más de 14 días: se intenta internet
    if (!force && !stale && series[fund.id]) return;
    const hit = storage.get(config.STORAGE.series, {})[fund.id];
    if (!force && hit && Date.now() - hit.at < config.SERIES_TTL_MS) { series[fund.id] = hit.pts; liveIds.add(fund.id); return; }
    try {
      const pts = await download(fund);
      series[fund.id] = pts; liveIds.add(fund.id);
      const cache = storage.get(config.STORAGE.series, {});
      cache[fund.id] = { at: Date.now(), pts };
      storage.set(config.STORAGE.series, cache);
    } catch { /* se queda lo que hubiera (archivo local o estimación) */ }
  }

  const monthKey = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  function monthlyReturns(id, years) {
    const s = series[id];
    if (!s || s.length < 13) return null;
    const from = s[s.length - 1][0] - years * YEAR, out = new Map();
    for (let i = 1; i < s.length; i++) if (s[i][0] >= from) out.set(monthKey(s[i][0]), s[i][1] / s[i - 1][1] - 1);
    return out.size >= 12 ? out : null;
  }

  /** Volatilidad anual y caída máxima REALES de la cartera (con correlaciones), o null si falta histórico de algún fondo. */
  function portfolioStats(alloc, years) {
    const ids = Object.keys(alloc), total = ids.reduce((a, id) => a + alloc[id], 0) || 1;
    const maps = ids.map(id => monthlyReturns(id, years));
    if (!maps.length || maps.some(m => !m)) return null;
    const keys = [...maps[0].keys()].filter(k => maps.every(m => m.has(k))).sort((a, b) => a - b);
    if (keys.length < 12) return null;
    const r = keys.map(k => maps.reduce((a, m, i) => a + m.get(k) * alloc[ids[i]] / total, 0));
    const mean = r.reduce((a, x) => a + x, 0) / r.length;
    const vol = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (r.length - 1)) * Math.sqrt(12);
    let v = 1, peak = 1, maxDD = 0;
    r.forEach(x => { v *= 1 + x; peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); });
    return { vol, maxDD, months: r.length };
  }

  applyLocalFiles();

  App.data = {
    loadAll: (force = false) => Promise.allSettled(config.FUNDS.map(f => load(f, force))),
    /** mode: 'live' (descargado ahora), 'saved' (archivo local, con fecha) o 'none' (estimaciones). */
    status() {
      const mode = liveIds.size ? 'live' : Object.keys(series).length ? 'saved' : 'none';
      return { mode, count: liveIds.size, date: snapDate ? new Date(snapDate).toLocaleDateString('es-ES') : null };
    },
    terDate: () => terDate,
    portfolioStats,
    /** Rentabilidad anual compuesta de los últimos `years` años (o estimación fija si no hay datos). */
    cagr(fund, years) {
      const s = series[fund.id];
      if (s && s.length > 12) {
        const last = s[s.length - 1];
        const first = s.find(p => p[0] >= last[0] - years * YEAR) || s[0];
        const span = (last[0] - first[0]) / YEAR;
        if (span >= 1) return { rate: Math.pow(last[1] / first[1], 1 / span) - 1, live: true, span };
      }
      return { rate: fund.fallback, live: false, span: 0 };
    },
  };
})(window.App = window.App || {});
