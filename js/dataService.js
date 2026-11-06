/* Precios (Yahoo Finance, probando varias rutas en paralelo), TER actualizados (data/ters.json) y rentabilidades anualizadas. */
(function (App) {
  'use strict';
  const { config, storage } = App;
  const YEAR = 31557600; // segundos
  const series = {};
  let terDate = null;

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
    const r = json.chart.result[0];
    const closes = r.indicators.quote[0].close; // precio sin dividendos: éstos se añaden aparte
    const pts = r.timestamp.map((t, i) => [t, closes[i]]).filter(p => p[1] > 0);
    if (pts.length < 13) throw new Error('histórico corto');
    return pts;
  }

  // Lanza directo + proxies a la vez y se queda con el primero que responda bien.
  function download(fund) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${fund.id}?range=max&interval=1mo`;
    return Promise.any(config.PROXIES.map(p => fetchJson(p(url)).then(parse)));
  }

  async function load(fund, force) {
    const hit = storage.get(config.STORAGE.series, {})[fund.id];
    if (!force && hit && Date.now() - hit.at < config.SERIES_TTL_MS) { series[fund.id] = hit.pts; return; }
    try {
      const pts = await download(fund);
      series[fund.id] = pts;
      const cache = storage.get(config.STORAGE.series, {});
      cache[fund.id] = { at: Date.now(), pts };
      storage.set(config.STORAGE.series, cache);
    } catch { if (hit) series[fund.id] = hit.pts; }
  }

  /** Lee data/ters.json en cada visita (sin caché) y actualiza el TER de cada gestor. Falla en silencio (p. ej. con file://). */
  async function loadTers() {
    try {
      const res = await fetch(config.TERS_URL, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      config.FUNDS.forEach(f => f.providers.forEach(p => { if (typeof json.ters?.[p.id] === 'number') p.ter = json.ters[p.id]; }));
      terDate = json.updated || null;
    } catch { /* se usan los TER de config.js */ }
  }

  App.data = {
    loadAll: (force = false) => Promise.allSettled([loadTers(), ...config.FUNDS.map(f => load(f, force))]),
    liveCount: () => Object.keys(series).length,
    terDate: () => terDate,
    /** Rentabilidad anual compuesta de los últimos `years` años (o estimada si no hay datos). */
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
