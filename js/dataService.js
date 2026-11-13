/* Datos de mercado. Prioridad: 1) precios en vivo/caché 24 h, 2) archivo data/market-data.js (generado en servidor, funciona con doble clic),
   3) estimaciones fijas. También aplica los TER de data/ters.js y calcula rentabilidades anualizadas. */
(function (App) {
  'use strict';
  const { config, storage } = App;
  const YEAR = 31557600, STALE_MS = 14 * 864e5; // segundos / ms
  const series = {}, liveIds = new Set(), customs = {}; // customs: fondos personalizados (ver customFunds.js)
  // Cachés: se vacían cuando cambian las series (touchSeries). Los fondos personalizados tienen su propio contador, para que cambiarlos no invalide lo de los demás.
  const statsMemo = new Map(), customMemo = new Map(), cagrMemo = new Map(), inflMemo = new Map();
  let seriesVer = 0, customVer = 0, boundsMemo = null;
  const touchSeries = () => { seriesVer++; statsMemo.clear(); customMemo.clear(); cagrMemo.clear(); boundsMemo = null; };
  const touchCustom = () => { customVer++; customMemo.clear(); };
  let snapDate = null, terDate = null, snapLabel = null;

  const monthKey = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

  /** Yahoo añade al final un punto "de hoy" dentro del mes en curso (mismo mes y mismo precio que el anterior).
   *  Si se dejara, ese mes contaría como un mes con rentabilidad 0 %. Se conserva solo el ÚLTIMO punto de cada mes. */
  function oneForMonth(pts) {
    const out = [];
    for (const p of pts) {
      if (out.length && monthKey(out[out.length - 1][0]) === monthKey(p[0])) out[out.length - 1] = p;
      else out.push(p);
    }
    return out;
  }

  function applyLocalFiles() {
    const snap = App.snapshot;
    if (snap?.series && Object.keys(snap.series).length) {
      for (const id in snap.series) series[id] = oneForMonth(snap.series[id]);
      snapDate = snap.updated;
      snapLabel = new Date(snapDate).toLocaleDateString('es-ES'); // se formatea una sola vez
    }
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
    return oneForMonth(pts);
  }

  // Varios proxies a la vez; gana el primero que responda bien.
  function download(fund) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${fund.id}?range=max&interval=1mo`;
    return Promise.any(config.PROXIES.map(p => fetchJson(p(url)).then(parse)));
  }

  async function load(fund, force, cache, pending) {
    const stale = !snapDate || Date.now() - Date.parse(snapDate) > STALE_MS; // archivo local con más de 14 días: se intenta internet
    if (!force && !stale && series[fund.id]) return;
    const hit = cache[fund.id];
    if (!force && hit && Date.now() - hit.at < config.SERIES_TTL_MS) { series[fund.id] = oneForMonth(hit.pts); liveIds.add(fund.id); touchSeries(); return; }
    try {
      const pts = await download(fund);
      series[fund.id] = pts; liveIds.add(fund.id); touchSeries();
      pending[fund.id] = { at: Date.now(), pts }; // se guarda todo junto al final (no una vez por fondo)
    } catch { /* se queda lo que hubiera (archivo local o estimación) */ }
  }

  async function loadAll(force = false) {
    const cache = storage.get(config.STORAGE.series, {}), pending = {};
    const res = await Promise.allSettled(config.FUNDS.filter(f => !f.custom).map(f => load(f, force, cache, pending))); // los personalizados no se descargan
    if (Object.keys(pending).length) storage.set(config.STORAGE.series, { ...cache, ...pending });
    return res;
  }

  /** Ruido gaussiano reproducible para cada fondo inventado y cada mes (así el histórico simulado no cambia entre pintados). */
  function noise(seed, key) {
    let a = (seed ^ Math.imul(key, 0x9E3779B1)) >>> 0;
    const next = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  }

  /** Rentabilidades mensuales de un fondo personalizado. Imitado: las del fondo real con tus cambios (rentabilidad desplazada, volatilidad escalada;
   *  sin cambios son idénticas). Inventado: se simula a partir del mercado con su rentabilidad, volatilidad y correlación.
   *  La media aritmética mensual es la geométrica + varianza/2: así la rentabilidad COMPUESTA de la serie es la que pides. */
  function customReturns(id, c, years) {
    const memoKey = id + '|' + years;
    if (customMemo.has(memoKey)) return customMemo.get(memoKey);
    // Referencia de un fondo inventado: el índice con MÁS historia (así no se recorta el histórico de los demás fondos de la cartera)
    const refId = c.base || ['URTH', 'VT', 'ACWI', 'SPY'].filter(r => series[r]?.length > 12).sort((a, b) => series[b].length - series[a].length)[0];
    const m = refId ? monthlyReturns(refId, years) : null;
    let out = null;
    if (m) {
      const v = [...m.values()], mean = v.reduce((a, x) => a + x, 0) / v.length;
      out = new Map();
      if (c.base) { for (const [k, r] of m) out.set(k, Math.max(-0.99, mean + (r - mean) * c.volScale + c.shift)); }
      else {
        const sd = sdOf(v) || 1e-9, sc = c.vol / Math.sqrt(12), mc = Math.pow(1 + c.rate, 1 / 12) - 1 + (sc * sc) / 2, idio = Math.sqrt(Math.max(0, 1 - c.corr * c.corr));
        for (const [k, r] of m) out.set(k, Math.max(-0.99, mc + c.corr * ((r - mean) / sd) * sc + idio * sc * noise(c.seed, k)));
      }
    }
    customMemo.set(memoKey, out);
    return out;
  }

  function monthlyReturns(id, years) {
    if (customs[id]) return customReturns(id, customs[id], years);
    const s = series[id];
    if (!s || s.length < 13) return null;
    const from = s[s.length - 1][0] - years * YEAR, out = new Map(), keys = keysOf(s);
    for (let i = 1; i < s.length; i++) if (s[i][0] >= from) out.set(keys[i], s[i][1] / s[i - 1][1] - 1);
    return out.size >= 12 ? out : null;
  }

  const sdOf = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  function statsOf(values) {
    let v = 1, peak = 1, maxDD = 0;
    values.forEach(x => { v *= 1 + x; peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); });
    return { vol: sdOf(values) * Math.sqrt(12), maxDD };
  }

  /** Datos REALES de la cartera: rentabilidades mensuales (en los meses comunes a todos sus fondos), volatilidad con
   *  correlaciones, caída máxima y ratio de diversificación (media ponderada de volatilidades ÷ volatilidad de la cartera). */
  function portfolioStats(alloc, years) {
    // Clave normalizada: { VT: 100 }, { VT: 50 } y { VT: 100, AGG: 0 } son la misma cartera
    let ids = Object.keys(alloc);
    const used = ids.filter(id => alloc[id] > 0);
    if (used.length) ids = used;
    const total = ids.reduce((a, id) => a + alloc[id], 0);
    const parts = ids.sort().map(id => `${id}:${Math.round((total > 0 ? alloc[id] / total : 1 / ids.length) * 1e6)}`).join(',');
    const key = `${seriesVer}|${ids.some(id => customs[id]) ? customVer : 0}|${years}|${parts}`;
    if (statsMemo.has(key)) return statsMemo.get(key);
    const r = portfolioStatsRaw(alloc, years);
    if (statsMemo.size >= 60) statsMemo.delete(statsMemo.keys().next().value); // sale el más antiguo, no todo de golpe
    statsMemo.set(key, r);
    return r;
  }
  function portfolioStatsRaw(alloc, years) {
    let ids = Object.keys(alloc);
    const used = ids.filter(id => alloc[id] > 0);
    if (used.length) ids = used; // un fondo al 0 % no pesa ni debe recortar el histórico común de los demás
    const total = ids.reduce((a, id) => a + alloc[id], 0);
    const maps = ids.map(id => monthlyReturns(id, years));
    if (!maps.length || maps.some(m => !m)) return null;
    const keys = [...maps[0].keys()].filter(k => maps.every(m => m.has(k))).sort((a, b) => a - b);
    if (keys.length < 12) return null;
    const w = ids.map(id => (total > 0 ? alloc[id] / total : 1 / ids.length)); // todo a 0 %: reparto a partes iguales (igual que portfolio())
    const returns = keys.map(k => maps.reduce((a, m, i) => a + m.get(k) * w[i], 0));
    const st = statsOf(returns);
    const indiv = maps.map(m => sdOf(keys.map(k => m.get(k))) * Math.sqrt(12));
    return { ...st, returns, divRatio: indiv.reduce((a, v, i) => a + v * w[i], 0) / st.vol, months: keys.length, years: keys.length / 12 };
  }

  /** Inflación histórica real (data/market-data.js, Banco Mundial): media y desviación típica anual, en tanto por uno. */
  function inflationStats(years = 30) {
    if (inflMemo.has(years)) return inflMemo.get(years); // la inflación histórica no cambia durante la sesión
    const rows = App.snapshot?.inflation?.series;
    let out = null;
    if (rows && rows.length >= 8) { const v = rows.slice(-years).map(r => r[1] / 100); out = { mean: v.reduce((a, x) => a + x, 0) / v.length, sd: sdOf(v), years: v.length }; }
    inflMemo.set(years, out);
    return out;
  }

  const keyCache = new WeakMap(); // claves de mes de cada serie (se calculan una sola vez)
  const keysOf = pts => { let k = keyCache.get(pts); if (!k) { k = pts.map(p => monthKey(p[0])); keyCache.set(pts, k); } return k; };

  /** Años cubiertos por los datos: min = el índice con más historia, common = desde cuándo hay datos de TODOS los índices,
   *  max = último año con datos, lastKey = último mes con datos (clave año*12+mes). */
  function bounds() {
    if (boundsMemo) return boundsMemo;
    const ids = Object.keys(series).filter(id => series[id]?.length > 12);
    if (!ids.length) { const y = new Date().getFullYear(); return { min: y - 30, common: y - 15, max: y, lastKey: y * 12 + 10 }; } // sin datos: no se guarda, por si llegan después
    const first = ids.map(id => Math.floor(keysOf(series[id])[0] / 12));
    const lastKey = Math.max(...ids.map(id => keysOf(series[id]).at(-1))), max = Math.floor(lastKey / 12);
    return (boundsMemo = { min: Math.min(...first), common: Math.min(Math.max(...first), max - 1), max, lastKey });
  }

  applyLocalFiles();

  App.data = {
    loadAll,
    version: () => seriesVer, // cambia cuando llegan datos nuevos (sirve para cachear lo que depende de ellos)
    /** mode: 'live' (descargado ahora), 'saved' (archivo local, con fecha) o 'none' (estimaciones). */
    status() {
      const mode = liveIds.size ? 'live' : Object.keys(series).length ? 'saved' : 'none';
      return { mode, count: liveIds.size, date: snapLabel };
    },
    terDate: () => terDate,
    setCustom: c => { if (JSON.stringify(c) === JSON.stringify(customs)) return; for (const k in customs) delete customs[k]; Object.assign(customs, c); touchCustom(); },
    portfolioStats, inflationStats, bounds,
    /** Rentabilidad anual compuesta (precio, sin dividendos) entre el cierre de diciembre del año anterior a `range.from`
     *  y el cierre de diciembre de `range.to` (o el último dato si `to` es el año en curso). Si el fondo empieza más tarde,
     *  se parte de su primer dato (`lateBy` = meses de retraso). Sin datos suficientes: estimación fija. */
    cagr(fund, range = {}) {
      const s = series[fund.id];
      if (s && s.length > 12) {
        const memoKey = `${fund.id}|${range.from ?? ''}|${range.to ?? ''}`, hit = cagrMemo.get(memoKey);
        if (hit) return hit;
        const b = bounds(), keys = keysOf(s);
        const wantStart = ((range.from ?? b.common) - 1) * 12 + 11, to = range.to ?? b.max, wantEnd = to >= b.max ? Infinity : to * 12 + 11;
        const i = keys.findIndex(k => k >= wantStart);
        let j = keys.length - 1;
        while (j >= 0 && keys[j] > wantEnd) j--;
        if (i >= 0 && j > i) {
          const span = (keys[j] - keys[i]) / 12;
          if (span >= 1) { const out = { rate: Math.pow(s[j][1] / s[i][1], 1 / span) - 1, live: true, span, startKey: keys[i], endKey: keys[j], lateBy: keys[i] - wantStart }; cagrMemo.set(memoKey, out); return out; }
        }
      }
      return { rate: fund.fallback, live: false, span: 0 };
    },
  };
})(window.App = window.App || {});
