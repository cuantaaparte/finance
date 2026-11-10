/* Configuración: catálogo de fondos (con varios gestores y su TER), valores por defecto y esquema del formulario. */
(function (App) {
  'use strict';
  const P = (id, name, ter) => ({ id, name, ter });
  // id = ticker de Yahoo Finance usado como PROXY del índice. vol = volatilidad anual (%), yield = dividendo bruto (%),
  // fallback = rentabilidad anual si no hay conexión. Los TER son ORIENTATIVOS: se sobrescriben con data/ters.js.
  const FUNDS = [
    { id: 'VT', name: 'Global All-World (FTSE)', vol: 15, yield: 1.9, fallback: 0.080, providers: [
      P('vt-vanguard', 'Vanguard FTSE All-World', 0.14), P('vt-invesco', 'Invesco FTSE All-World', 0.15),
      P('vt-vanguard-allcap', 'Vanguard FTSE Global All-Cap', 0.07)] }, // lanzado en ago-2026; mismo índice que el VT estadounidense (todas las capitalizaciones)
    { id: 'ACWI', name: 'Global All-World (MSCI ACWI)', vol: 15, yield: 1.8, fallback: 0.080, providers: [
      P('acwi-ishares', 'iShares MSCI ACWI', 0.20), P('acwi-spdr', 'SPDR MSCI ACWI', 0.12),
      P('acwi-lg-imi', 'L&G MSCI ACWI IMI', 0.16)] }, // sigue el MSCI ACWI IMI (incluye small caps); como referencia de precios se usa el ACWI, muy parecido
    { id: 'URTH', name: 'MSCI World', vol: 14, yield: 1.8, fallback: 0.085, providers: [
      P('urth-ishares', 'iShares Core MSCI World', 0.20), P('urth-amundi', 'Amundi MSCI World', 0.12),
      P('urth-fidelity', 'Fidelity Index World', 0.12), P('urth-xtrackers', 'Xtrackers MSCI World', 0.19)] },
    { id: 'SPY', name: 'S&P 500 (EE. UU.)', vol: 16, yield: 1.3, fallback: 0.100, providers: [
      P('spy-vanguard', 'Vanguard S&P 500', 0.07), P('spy-ishares', 'iShares Core S&P 500', 0.07),
      P('spy-spdr', 'SPDR S&P 500', 0.03), P('spy-amundi', 'Amundi S&P 500', 0.15)] },
    { id: 'QQQ', name: 'Nasdaq 100', vol: 21, yield: 0.6, fallback: 0.140, providers: [
      P('qqq-invesco', 'Invesco EQQQ Nasdaq-100', 0.30), P('qqq-ishares', 'iShares Nasdaq 100', 0.33),
      P('qqq-amundi', 'Amundi Nasdaq-100', 0.23), P('qqq-xtrackers', 'Xtrackers Nasdaq 100', 0.20)] },
    { id: 'VGK', name: 'Europa', vol: 17, yield: 3.0, fallback: 0.060, providers: [
      P('vgk-vanguard', 'Vanguard FTSE Developed Europe', 0.10), P('vgk-ishares', 'iShares Core MSCI Europe', 0.12),
      P('vgk-amundi', 'Amundi Stoxx Europe 600', 0.07)] },
    { id: 'EWJ', name: 'Japón', vol: 17, yield: 2.0, fallback: 0.050, providers: [
      P('ewj-ishares', 'iShares Core MSCI Japan IMI', 0.15), P('ewj-amundi', 'Amundi MSCI Japan', 0.12)] },
    { id: 'VWO', name: 'Emergentes (FTSE)', vol: 19, yield: 2.8, fallback: 0.040, providers: [
      P('vwo-vanguard', 'Vanguard FTSE Emerging Markets', 0.17)] },
    { id: 'EEM', name: 'Emergentes (MSCI EM)', vol: 19, yield: 2.7, fallback: 0.040, providers: [
      P('eem-ishares', 'iShares Core MSCI EM IMI', 0.18), P('eem-amundi', 'Amundi MSCI Emerging Markets', 0.14),
      P('eem-fidelity', 'Fidelity Index Emerging Markets', 0.20), P('eem-xtrackers', 'Xtrackers MSCI Emerging Markets', 0.18)] },
    { id: 'AGG', name: 'Bonos agregados (RF)', vol: 5, yield: 3.2, fallback: 0.020, providers: [
      P('agg-vanguard', 'Vanguard Global Aggregate Bond', 0.08), P('agg-ishares', 'iShares Global Aggregate Bond', 0.10)] },
  ];

  const DEFAULT_STATE = {
    period: 'month',
    net: 1800, needs: 900, leisure: 270, invest: 630,   // importes SIEMPRE guardados en € / mes
    investAuto: true, touched: { needs: false, leisure: false },
    initial: 1000, workYears: 20, retireYears: 30, inflation: 2.5,
    histFrom: null, histTo: null, brokerFee: 0.15,   // histFrom/histTo: años del histórico (null = por defecto: desde que hay datos de todos los índices hasta hoy)
    alloc: { VT: 100 }, prov: {},
    retLinked: true, retNeeds: 900, retLeisure: 270,
    showInvested: true, showPrice: true, showTotal: true, showNominal: false,
    showDividends: true, // ver la rentabilidad de cada fondo con dividendos (solo cambia lo que se muestra; la simulación ya los incluye)
    hideCosts: true,     // true: la cifra de cada fondo NO descuenta inflación ni TER; false: se muestra ya descontada (solo cambia lo que se muestra)
    stratBase: 'avg', // punto de partida de las estrategias: 'avg' (salario medio) | 'mine' (tus datos)
  };

  // Esquema declarativo: añadir un campo = añadir una línea. col = columna de escritorio ('a' | 'b').
  const SECTIONS = [
    { id: 'income', title: 'Ingresos y gastos', col: 'a', fields: [
      { key: 'net', label: 'Sueldo neto', max: 8000, step: 50, unit: true },
      { key: 'needs', label: 'Necesidades básicas', max: 8000, step: 25, unit: true, pct: 'needsPct' },
      { key: 'leisure', label: 'Ocio y ahorros', max: 4000, step: 25, unit: true, pct: 'leisurePct' },
    ]},
    { id: 'invest', title: 'Inversión', col: 'a', fields: [
      { key: 'investAuto', label: 'Invertir todo lo que sobra', type: 'check' },
      { key: 'invest', label: 'Cantidad a invertir', max: 8000, step: 25, unit: true, pct: 'investPct' },
    ]},
    { id: 'plan', title: 'Plan de inversión', col: 'a', fields: [
      { key: 'initial', label: 'Inversión inicial', max: 200000, step: 500, suffix: '€' },
      { key: 'workYears', label: 'Años invirtiendo mientras cobras', min: 1, max: 50, step: 1, suffix: 'años' },
      { key: 'inflation', label: 'Inflación media', max: 10, step: 0.1, suffix: '%' },
    ]},
    { id: 'retire', title: 'Vivir de las inversiones', col: 'a', note: 'Importes en € de hoy: el gráfico ya los ajusta a la inflación año a año.', fields: [
      { key: 'retireYears', label: 'Años de jubilación a cubrir', min: 5, max: 60, step: 1, suffix: 'años' },
      { key: 'retLinked', label: 'Mismos gastos que ahora', type: 'check' },
      // Lo que retiras cada mes = necesidades + ocio. Los % de abajo son sobre estos ingresos (suman 100 %).
      { key: 'retIncome', label: 'Ingresos de la inversión', max: 8000, step: 50, unit: true, linked: true },
      { key: 'retNeeds', label: 'Necesidades básicas', max: 8000, step: 25, unit: true, pct: 'retNeedsPct', linked: true },
      { key: 'retLeisure', label: 'Ocio y ahorros', max: 4000, step: 25, unit: true, pct: 'retLeisurePct', linked: true },
    ]},
    { id: 'funds', title: 'Fondos y comisiones', col: 'b', custom: 'funds', fields: [
      { key: 'histRange', label: 'Periodo de histórico para la rentabilidad', type: 'range2' },
      { key: 'brokerFee', label: 'Comisión anual del bróker', max: 1.5, step: 0.01, suffix: '%' },
    ]},
  ];

  const VERSION = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch { return ''; } })(); // sale de index.html (?v=...)
  App.config = {
    VERSION,
    STORAGE: { settings: 'fi.settings.v1', scenarios: 'fi.scenarios.v1', series: 'fi.series.v1' },
    DIV_TAX: 0.19, SERIES_TTL_MS: 24 * 3600 * 1000, FOREVER_SPEND: 2000, // € / mes que retira la estrategia "capital eterno"
    PROXIES: [
      u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
      u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
    ],
    AVERAGE_PROFILE: { net: 1800, initial: 1000, workYears: 20, retireYears: 30 }, // salario neto medio orientativo (€/mes); cámbialo a tu país
    INFLATION_COUNTRY: 'ESP', // código ISO3 del país cuya inflación histórica descarga tools/update-data.mjs (Banco Mundial)
    // Reparto que fijan las estrategias (se eligen siempre los gestores más baratos de cada fondo)
    STRATEGY_ALLOC: { growth: { VT: 100 }, safe: { VT: 60, AGG: 40 } },
    // Umbrales orientativos para marcar valores extremos en los campos: 'bad' = pesimista (rojo), 'good' = demasiado optimista (verde).
    // pctOfNet: el valor se compara como % del sueldo neto. gt = mayor que, lt = menor que.
    EXTREMES: {
      net: { bad: { lt: 900 }, good: { gt: 5000 } },
      needs: { pctOfNet: true, bad: { gt: 85 }, good: { lt: 5 } },
      leisure: { pctOfNet: true, bad: { gt: 50 }, good: { lt: 5 } },
      invest: { pctOfNet: true, good: { gt: 60 } },
      initial: { good: { gt: 50000 } },
      workYears: { bad: { gt: 45 }, good: { lt: 5 } },
      inflation: { bad: { gt: 6 }, good: { lt: 1 } },
      brokerFee: { bad: { gt: 1 } },
      retireYears: { bad: { gt: 50 }, good: { lt: 10 } },
      retIncome: { pctOfNet: true, bad: { gt: 120 }, good: { lt: 10 } }, // retiras más de 1,2 veces tu sueldo actual / menos del 10 %
      retNeeds: { pctOfNet: true, bad: { gt: 85 }, good: { lt: 5 } },
      retLeisure: { pctOfNet: true, bad: { gt: 50 }, good: { lt: 5 } },
    },
    FUNDS, DEFAULT_STATE, SECTIONS,
  };
})(window.App = window.App || {});
