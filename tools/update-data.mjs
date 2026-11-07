// Descarga los históricos de precios (en el servidor no hay CORS) y genera data/market-data.js.
// Uso local:  node tools/update-data.mjs   (Node 18+).  En GitHub se ejecuta solo (ver .github/workflows).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = file => { const w = { App: {} }; new Function('window', readFileSync(join(root, file), 'utf8'))(w); return w.App; };
const { config } = load('js/config.js');
let old = {}, oldInflation = null;
try { const snap = load('data/market-data.js').snapshot; old = snap?.series || {}; oldInflation = snap?.inflation || null; } catch { /* primera vez */ }

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; fondos-indexados-updater)' };

async function yahoo(id) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${id}?range=max&interval=1mo`, { headers: HEADERS });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const r = (await res.json()).chart.result[0], close = r.indicators.quote[0].close;
  return r.timestamp.map((t, i) => [t, close[i]]);
}
async function stooq(id) { // alternativa si Yahoo falla
  const res = await fetch(`https://stooq.com/q/d/l/?s=${id.toLowerCase()}.us&i=m`, { headers: HEADERS });
  const rows = (await res.text()).trim().split('\n').slice(1).map(l => l.split(','));
  return rows.map(c => [Math.round(Date.parse(c[0]) / 1000), Number(c[4])]);
}

const series = {}; let ok = 0;
for (const f of config.FUNDS) {
  let pts = null;
  for (const source of [yahoo, stooq]) {
    try { pts = (await source(f.id)).filter(p => p[1] > 0).map(([t, p]) => [t, Math.round(p * 1e4) / 1e4]); if (pts.length > 12) break; pts = null; }
    catch (e) { console.warn(`${f.id}: ${source.name} falló (${e.message})`); }
  }
  if (pts) { series[f.id] = pts; ok++; console.log(`${f.id}: ${pts.length} puntos`); }
  else if (old[f.id]) { series[f.id] = old[f.id]; console.warn(`${f.id}: se mantienen los datos anteriores`); }
  await new Promise(r => setTimeout(r, 400));
}
if (!ok) { console.error('No se pudo descargar ningún fondo.'); process.exit(1); }

// Inflación anual del país configurado (Banco Mundial, índice de precios al consumidor)
let inflation = oldInflation;
try {
  const res = await fetch(`https://api.worldbank.org/v2/country/${config.INFLATION_COUNTRY}/indicator/FP.CPI.TOTL.ZG?format=json&per_page=100`, { headers: HEADERS });
  const rows = ((await res.json())[1] || []).filter(r => r.value != null).map(r => [Number(r.date), Math.round(r.value * 100) / 100]).sort((a, b) => a[0] - b[0]);
  if (rows.length > 10) { inflation = { country: config.INFLATION_COUNTRY, series: rows }; console.log(`Inflación ${config.INFLATION_COUNTRY}: ${rows.length} años`); }
} catch (e) { console.warn('Inflación: no se pudo descargar (' + e.message + ')'); }

const snapshot = { updated: new Date().toISOString(), series, inflation };
writeFileSync(join(root, 'data/market-data.js'),
  `/* Generado por tools/update-data.mjs. No editar a mano. */\nwindow.App = window.App || {};\nwindow.App.snapshot = ${JSON.stringify(snapshot)};\n`);
console.log(`Listo: ${ok}/${config.FUNDS.length} fondos actualizados.`);
