/* Configuración: catálogo de fondos (con varios gestores y su TER), valores por defecto y esquema del formulario. */
(function (App) {
  'use strict';
  // Cada gestor es un ETF (E) o un fondo indexado (I): el TER de cada uno es distinto. Hay índices que solo tienen ETF en esta lista.
  const E = (id, name, ter) => ({ id, name, ter, kind: 'etf' });
  const I = (id, name, ter) => ({ id, name, ter, kind: 'index' });
  // id = ticker de Yahoo Finance usado como PROXY del índice (o, si hay `proxy`, varios tickers que se mezclan a partes iguales). vol = volatilidad anual (%),
  // yield = dividendo bruto (%), fallback = rentabilidad anual si no hay datos. Los TER de aquí son los de referencia: data/ters.js los sobrescribe.
  const FUNDS = [
    { id: 'VT', name: 'Global All-World (FTSE)', vol: 15, yield: 1.9, fallback: 0.080, providers: [
      E('vt-vanguard', 'Vanguard FTSE All-World', 0.14), E('vt-invesco', 'Invesco FTSE All-World', 0.15), E('vt-vanguard-allcap', 'Vanguard FTSE Global All-Cap', 0.07),
      I('vt-vanguard-index', 'Vanguard Global Stock Index', 0.18)] },
    { id: 'ACWI', name: 'Global All-World (MSCI ACWI)', vol: 15, yield: 1.8, fallback: 0.080, providers: [
      E('acwi-ishares', 'iShares MSCI ACWI', 0.20), E('acwi-spdr', 'SPDR MSCI ACWI', 0.12), E('acwi-lg-imi', 'L&G MSCI ACWI IMI', 0.16),
      E('acwi-amundi', 'Amundi Core MSCI ACWI (swap)', 0.09)] },
    { id: 'URTH', name: 'MSCI World', vol: 14, yield: 1.8, fallback: 0.085, providers: [
      E('urth-ishares', 'iShares Core MSCI World', 0.20), E('urth-amundi', 'Amundi Core MSCI World', 0.12), E('urth-xtrackers', 'Xtrackers MSCI World', 0.12), E('urth-spdr', 'SPDR MSCI World', 0.12),
      I('urth-fidelity', 'Fidelity MSCI World Index', 0.12), I('urth-ishares-index', 'iShares Developed World Index', 0.12), I('urth-ishares-s', 'iShares Developed World Index (clase S, MyInvestor)', 0.06),
      I('urth-amundi-index', 'Amundi Index MSCI World', 0.30)] },
    { id: 'SPY', name: 'S&P 500 (EE. UU.)', vol: 16, yield: 1.3, fallback: 0.100, providers: [
      E('spy-vanguard', 'Vanguard S&P 500', 0.07), E('spy-ishares', 'iShares Core S&P 500', 0.07), E('spy-spdr', 'SPDR S&P 500', 0.03), E('spy-amundi', 'Amundi Core S&P 500 (swap)', 0.05),
      I('spy-vanguard-index', 'Vanguard U.S. 500 Stock Index', 0.10), I('spy-fidelity-index', 'Fidelity S&P 500 Index', 0.06), I('spy-ishares-index', 'iShares US Index', 0.12),
      I('spy-ishares-s', 'iShares US Equity Index (clase S, MyInvestor)', 0.05)] },
    { id: 'QQQ', name: 'Nasdaq 100', vol: 21, yield: 0.6, fallback: 0.140, providers: [
      E('qqq-invesco', 'Invesco EQQQ Nasdaq-100', 0.30), E('qqq-ishares', 'iShares Nasdaq 100', 0.30), E('qqq-amundi', 'Amundi Nasdaq-100 (swap)', 0.22), E('qqq-xtrackers', 'Xtrackers Nasdaq 100', 0.20),
      E('qqq-bnp', 'BNP Paribas Easy Nasdaq 100', 0.14),
      I('qqq-myinvestor', 'MyInvestor Nasdaq 100', 0.41), I('qqq-naranja', 'Fondo Naranja Nasdaq 100 (ING)', 1.07)] },
    { id: 'VGK', name: 'Europa', vol: 17, yield: 3.0, fallback: 0.060, providers: [
      E('vgk-vanguard', 'Vanguard FTSE Developed Europe', 0.10), E('vgk-ishares', 'iShares Core MSCI Europe', 0.12), E('vgk-amundi', 'Amundi Stoxx Europe 600', 0.07),
      I('vgk-vanguard-index', 'Vanguard European Stock Index', 0.12)] },
    { id: 'EWJ', name: 'Japón', vol: 17, yield: 2.0, fallback: 0.050, providers: [
      E('ewj-ishares', 'iShares Core MSCI Japan IMI', 0.12), E('ewj-amundi', 'Amundi MSCI Japan', 0.12)] },
    { id: 'VWO', name: 'Emergentes (FTSE)', vol: 19, yield: 2.8, fallback: 0.040, providers: [
      E('vwo-vanguard', 'Vanguard FTSE Emerging Markets', 0.17),
      I('vwo-vanguard-index', 'Vanguard Emerging Markets Stock Index', 0.23)] },
    { id: 'EEM', name: 'Emergentes (MSCI EM)', vol: 19, yield: 2.7, fallback: 0.040, providers: [
      E('eem-ishares', 'iShares Core MSCI EM IMI', 0.18), E('eem-amundi', 'Amundi MSCI Emerging Markets', 0.14), E('eem-xtrackers', 'Xtrackers MSCI Emerging Markets', 0.18),
      I('eem-fidelity', 'Fidelity MSCI Emerging Markets Index', 0.20), I('eem-ishares-s', 'iShares Emerging Markets Index (clase S, MyInvestor)', 0.16)] },
    { id: 'AGG', name: 'Bonos agregados (RF)', vol: 5, yield: 3.2, fallback: 0.020, providers: [
      E('agg-vanguard', 'Vanguard Global Aggregate Bond', 0.08), E('agg-ishares', 'iShares Global Aggregate Bond', 0.10),
      I('agg-vanguard-index', 'Vanguard Global Bond Index (cubierto a EUR)', 0.15)] },
    // Utilities = empresas de servicios públicos (electricidad, gas y agua). Proxy: iShares Global Utilities (JXI). Solo hay ETF de este sector.
    { id: 'JXI', name: 'Utilities globales (electricidad, gas y agua)', vol: 15, yield: 3.3, fallback: 0.050, providers: [
      E('util-xtrackers', 'Xtrackers MSCI World Utilities', 0.25), E('util-amundi', 'Amundi S&P Global Utilities ESG', 0.18), E('util-spdr', 'SPDR MSCI World Utilities', 0.30)] },
    // No existe ningún ETF que junte energía limpia y nuclear (son índices distintos): se modela como una mezcla 50/50 de un ETF de cada tipo
    // (proxy = iShares Global Clean Energy ICLN + VanEck Uranium & Nuclear NLR) y el TER es la media de los dos.
    { id: 'CLEAN', proxy: ['ICLN', 'NLR'], name: 'Energía limpia + nuclear (mezcla 50/50)', vol: 26, yield: 2.0, fallback: 0.030, providers: [
      E('clean-wisdomtree', 'WisdomTree Renewable Energy + WisdomTree Uranium & Nuclear', 0.45), E('clean-invesco-vaneck', 'Invesco Global Clean Energy + VanEck Uranium & Nuclear', 0.575),
      E('clean-ishares-vaneck', 'iShares Global Clean Energy Transition + VanEck Uranium & Nuclear', 0.60)] },
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
    retGross: null,   // en modo bruto: el importe bruto mensual que el usuario quiere cobrar (el neto se recalcula si cambia otro dato)
    retBasis: 'net',  // el importe "Ingresos de la inversión" se introduce en 'net' (tras impuestos) o 'gross' (bruto)
    customFunds: [],  // fondos personalizados (ver customFunds.js)
    fundCfg: {},      // por fondo del catálogo: { kind: 'etf'|'index', perYear, pct, taxed } (tipo y movimientos entre fondos)
    tax: { country: 'ES', scale: null, custom: null }, // impuestos de la jubilación: país (data/tax-data.js) o 'CUSTOM' con tramos propios
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
    { id: 'retire', title: 'Vivir de las inversiones', col: 'a', note: 'Importes en € de hoy: el gráfico ya los ajusta a la inflación año a año. Los tramos de impuestos también son los de hoy y se supone que se ajustan a la inflación cada año.', fields: [
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
    SERIES_TTL_MS: 24 * 3600 * 1000, FOREVER_SPEND: 2000, // € / mes que retira la estrategia "capital eterno"
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
