// Descarga los históricos de precios (en el servidor no hay CORS) y genera data/market-data.js.
// Uso local:  node tools/update-data.mjs   (Node 18+).  En GitHub se ejecuta solo (ver .github/workflows).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = file => { const w = { App: {} }; new Function('window', readFileSync(join(root, file), 'utf8'))(w); return w.App; };
const { config } = load('js/config.js');
let old = {}, oldInflation = null, oldFx = null;
try { const snap = load('data/market-data.js').snapshot; old = snap?.series || {}; oldInflation = snap?.inflation || null; oldFx = snap?.fx || null; } catch { /* primera vez */ }

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; fondos-indexados-updater)' };
const get = url => fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) }); // sin timeout, un servidor colgado bloquearía la Action

// Yahoo añade un punto "de hoy" dentro del mes en curso (mismo mes que el anterior): se conserva solo el último de cada mes.
const monthOf = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const oneForMonth = pts => pts.reduce((out, p) => { if (out.length && monthOf(out.at(-1)[0]) === monthOf(p[0])) out[out.length - 1] = p; else out.push(p); return out; }, []);

async function yahoo(id) {
  const res = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${id}?range=max&interval=1mo`);
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const r = (await res.json()).chart.result[0], close = r.indicators.quote[0].close;
  return r.timestamp.map((t, i) => [t, close[i]]);
}
async function stooq(id) { // alternativa si Yahoo falla
  const res = await get(`https://stooq.com/q/d/l/?s=${id.toLowerCase()}.us&i=m`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const rows = (await res.text()).trim().split('\n').slice(1).map(l => l.split(','));
  return rows.map(c => [Math.round(Date.parse(c[0]) / 1000), Number(c[4])]);
}

const series = {}; let ok = 0;
for (const f of config.FUNDS) {
  let pts = null;
  for (const source of [yahoo, stooq]) {
    try { pts = (await source(f.id)).filter(p => p[1] > 0).map(([t, p]) => [t, Math.round(p * 1e4) / 1e4]); pts = oneForMonth(pts); if (pts.length > 12) break; pts = null; }
    catch (e) { console.warn(`${f.id}: ${source.name} falló (${e.message})`); }
  }
  if (pts) { series[f.id] = pts; ok++; console.log(`${f.id}: ${pts.length} puntos`); }
  else if (old[f.id]) { series[f.id] = old[f.id]; console.warn(`${f.id}: se mantienen los datos anteriores`); }
  await new Promise(r => setTimeout(r, 400));
}
if (!ok) { console.error('No se pudo descargar ningún fondo.'); process.exit(1); }

// Inflación anual del país configurado (Banco Mundial, índice de precios al consumidor). Hasta 3 intentos y avisos claros:
// antes, una respuesta de error de la API dejaba la inflación sin guardar y sin ningún mensaje.
let inflation = oldInflation;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const res = await get(`https://api.worldbank.org/v2/country/${config.INFLATION_COUNTRY}/indicator/FP.CPI.TOTL.ZG?format=json&per_page=100`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = ((await res.json())[1] || []).filter(r => r.value != null).map(r => [Number(r.date), Math.round(r.value * 100) / 100]).sort((a, b) => a[0] - b[0]);
    if (rows.length <= 10) throw new Error(`respuesta sin datos suficientes (${rows.length} años)`);
    inflation = { country: config.INFLATION_COUNTRY, series: rows };
    console.log(`Inflación ${config.INFLATION_COUNTRY}: ${rows.length} años (${rows[0][0]}-${rows.at(-1)[0]})`);
    break;
  } catch (e) {
    console.warn(`Inflación: intento ${attempt}/3 fallido (${e.message})`);
    if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
  }
}
if (!inflation) console.warn('⚠ No hay datos de inflación: la app supondrá una inflación constante.');
else if (inflation === oldInflation) console.warn('Inflación: se mantienen los datos anteriores.');

// Tipos de cambio (unidades de cada moneda por 1 €) para convertir los tramos de data/tax-data.js. Si falla, se mantienen los anteriores.
const currencies = [...new Set(((() => { try { return load('data/tax-data.js').taxData?.countries; } catch { return []; } })() || []).map(c => c.currency))].filter(c => c !== 'EUR');
let fx = oldFx;
const fxSources = [
  async () => (await (await get('https://open.er-api.com/v6/latest/EUR')).json()).rates,
  async () => (await (await get('https://api.frankfurter.app/latest?from=EUR&to=' + currencies.join(','))).json()).rates,
];
for (const source of fxSources) {
  try {
    const r = await source(), got = Object.fromEntries(currencies.filter(c => r?.[c] > 0).map(c => [c, r[c]]));
    if (Object.keys(got).length) fx = { updated: new Date().toISOString(), rates: { ...fx?.rates, ...got } };
    if (currencies.every(c => fx?.rates?.[c] > 0)) { console.log('Tipos de cambio:', JSON.stringify(fx.rates)); break; }
  } catch (e) { console.warn('Tipos de cambio: fuente fallida (' + e.message + ')'); }
}
if (!fx) console.warn('⚠ Sin tipos de cambio: la web usará los de reserva de data/tax-data.js.');

const snapshot = { updated: new Date().toISOString(), series, inflation, fx };
writeFileSync(join(root, 'data/market-data.js'),
  `/* Generado por tools/update-data.mjs. No editar a mano. */\nwindow.App = window.App || {};\nwindow.App.snapshot = ${JSON.stringify(snapshot)};\n`);
console.log(`Listo: ${ok}/${config.FUNDS.length} fondos actualizados.`);
