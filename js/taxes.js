/* Impuestos (sin DOM): regímenes de data/tax-data.js o personalizados, cálculo bruto ↔ neto y validación de lo importado.
   Todo va en € de HOY: se supone que los tramos se ajustan a la inflación cada año, así que en la simulación (en € de hoy)
   siempre valen lo mismo. Los límites se guardan en la moneda del país y se convierten con el tipo de cambio.
   Régimen 'gain': solo tributa la parte de lo retirado que es ganancia (q = fracción de ganancia). Régimen 'all': tributa todo. */
(function (App) {
  'use strict';
  const DATA = App.taxData || { countries: [] };
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const NONE = { id: 'NONE', name: 'Sin impuestos', label: 'Sin impuestos', currency: 'EUR', fx: 1, on: 'gain', inclusion: 1, allowance: 0, brackets: [{ upTo: null, rate: 0 }], social: [], note: '', approx: false };

  const fxOf = c => { const r = App.snapshot?.fx?.rates?.[c.currency]; return c.currency === 'EUR' ? 1 : r > 0 ? r : c.fx; }; // 1º tipo de cambio actualizado, 2º el de reserva
  /** Monedas de los países de la lista (para elegir la de unos impuestos personalizados) y su tipo de cambio actual (unidades por 1 €). */
  const currencies = () => [...new Set(DATA.countries.map(c => c.currency))].filter(c => c !== 'EUR');
  const fxFor = code => (code === 'EUR' ? 1 : fxOf(DATA.countries.find(c => c.currency === code) || { currency: code, fx: 1 }));

  /** Definición de impuestos que corresponde a state.tax (país + régimen, o personalizado). */
  function resolve(t) {
    t = t || {};
    if (t.country === 'CUSTOM' && t.custom) return { ...t.custom, id: 'CUSTOM', name: 'Personalizado', label: 'Personalizado', custom: true, scaleId: null, note: '', approx: false };
    const c = DATA.countries.find(x => x.id === t.country) || DATA.countries[0];
    if (!c) return NONE;
    const s = c.scales.find(x => x.id === t.scale) || c.scales[0];
    return { id: c.id, name: c.name, label: c.scales.length > 1 ? `${c.name} · ${s.short}` : c.name, currency: c.currency, fx: fxOf(c), year: s.year ?? c.year,
      scaleId: s.id, scaleName: s.name, on: s.on === 'all' ? 'all' : 'gain', inclusion: s.inclusion ?? 1, allowance: s.allowance || 0, brackets: s.brackets, social: s.social || [],
      divRate: s.divRate ?? c.divRate ?? null, note: [c.note, s.note].filter(Boolean).join(' '), approx: !!(c.approx || s.approx), custom: false };
  }

  const socialRate = def => (def.social || []).reduce((a, x) => a + x.rate, 0) / 100;
  /** Tipo con el que tributa lo que se gana al mover dinero entre fondos: el primer tramo que ya paga algo (el 0 % del mínimo exento no cuenta). */
  function moveTau(def) {
    const b = def.brackets.find(x => x.rate > 0);
    return (b ? (b.rate / 100) * (def.inclusion ?? 1) : 0) + socialRate(def);
  }
  /** Impuesto sobre los dividendos (0-1): el indicado en el régimen o, si no lo hay, el mismo tipo que las ganancias. */
  const divTax = def => (def.divRate != null ? def.divRate / 100 : moveTau(def));

  /** Parte de una retirada bruta G que paga impuestos: la ganancia (q = fracción de ganancia, 0-1) o toda la retirada. */
  const taxable = (def, G, q) => (def.on === 'all' ? G : G * Math.min(1, Math.max(0, q ?? 1)));

  /** Impuestos de una base ANUAL (en € de hoy). rows = reparto por tramo. */
  function calc(def, base) {
    base = Math.max(0, base);
    const fx = def.fx || 1, local = base * fx * (def.inclusion ?? 1), over = Math.max(0, local - (def.allowance || 0));
    let prev = 0, income = 0;
    const rows = def.brackets.map(b => {
      const hi = b.upTo == null ? Infinity : b.upTo, part = Math.max(0, Math.min(over, hi) - prev), t = (part * b.rate) / 100;
      prev = Math.max(prev, hi); income += t;
      return { part: part / fx, tax: t / fx };
    });
    const socRate = socialRate(def), soc = base * socRate;
    const mb = def.brackets.find(b => b.upTo == null || over < b.upTo) || def.brackets.at(-1);
    return { base, income: income / fx, social: soc, tax: Math.min(base, income / fx + soc), rows,
      marginal: (local < (def.allowance || 0) ? 0 : (mb.rate / 100) * (def.inclusion ?? 1)) + socRate };
  }

  /** Neto anual de una retirada bruta anual G (con fracción de ganancia q). */
  const netOf = (def, G, q) => G - calc(def, taxable(def, G, q)).tax;

  /** Búsqueda binaria (solo para tipos de 100 % o más, donde el cálculo directo no sirve). */
  function bisectGross(def, net, q) {
    let lo = net, hi = net * 2 + 1, n = 0;
    while (netOf(def, hi, q) < net && n++ < 50) hi *= 2;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (netOf(def, mid, q) < net) lo = mid; else hi = mid; }
    return hi;
  }

  /**
   * Devuelve (net, q) → bruto anual necesario para quedarte con `net` anuales tras impuestos. Los tramos se preparan UNA vez
   * (así no se crean arrays en cada llamada: el Monte Carlo la usa decenas de miles de veces). El neto es una función por
   * tramos lineales del bruto, así que se recorren los tramos y se despeja, sin iterar.
   */
  function grossFn(def) {
    const inc = def.inclusion ?? 1, scale = (def.fx || 1) * inc, allow = def.allowance || 0, soc = socialRate(def);
    const ends = [allow / scale], slopes = [soc]; // base imponible donde acaba cada tramo y cuánto impuesto cuesta cada € de base dentro de él
    for (const b of def.brackets) { ends.push(b.upTo == null ? Infinity : (allow + b.upTo) / scale); slopes.push((b.rate / 100) * inc + soc); }
    const direct = scale > 0 && slopes.every(s => s <= 1);
    return (net, q) => {
      if (!(net > 0)) return 0;
      const m = def.on === 'all' ? 1 : Math.min(1, Math.max(0, q ?? 1));
      if (m === 0) return net;
      if (direct) {
        let baseStart = 0, netStart = 0;
        for (let i = 0; i < ends.length; i++) {
          const end = Math.max(ends[i], baseStart), k = 1 - m * slopes[i]; // k = neto que te queda por cada € bruto extra dentro del tramo
          if (k <= 0) break; // tipo del 100 %: no hay solución directa
          const netEnd = end === Infinity ? Infinity : netStart + ((end - baseStart) / m) * k;
          if (net <= netEnd) return baseStart / m + (net - netStart) / k;
          baseStart = end; netStart = netEnd;
        }
      }
      return bisectGross(def, net, q);
    };
  }
  const grossOf = (def, net, q) => grossFn(def)(net, q);

  /** Ordena los tramos y deja el último abierto (upTo null). Devuelve null si no hay tramos válidos. Dos límites iguales se respetan (un tramo de ancho cero no cuesta nada). */
  function normBrackets(arr) {
    if (!Array.isArray(arr) || !arr.length || arr.length > 60) return null;
    const rows = arr.filter(isObj).map(b => ({ upTo: Number.isFinite(b.upTo) && b.upTo > 0 ? Math.min(b.upTo, 1e12) : null, rate: num(b.rate, 0, 99, 0) }));
    if (!rows.length) return null;
    const open = rows.find(r => r.upTo == null) || rows.at(-1);
    const fin = rows.filter(r => r.upTo != null && r !== open).sort((a, b) => a.upTo - b.upTo);
    return [...fin, { upTo: null, rate: open.rate }];
  }

  function cleanCustom(c) {
    if (!isObj(c)) return null;
    const brackets = normBrackets(c.brackets);
    if (!brackets) return null;
    const currency = typeof c.currency === 'string' && /^[A-Z]{3}$/.test(c.currency) ? c.currency : 'EUR';
    const social = (Array.isArray(c.social) ? c.social : []).slice(0, 10).filter(isObj).map(x => ({
      name: String(x.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Seguridad social', rate: num(x.rate, 0, 99, 0) }));
    return { from: String(c.from ?? '').slice(0, 80), currency, fx: currency === 'EUR' ? 1 : num(c.fx, 1e-4, 1e6, 1), on: c.on === 'all' ? 'all' : 'gain',
      inclusion: num(c.inclusion, 0, 1, 1), allowance: num(c.allowance, 0, 1e12, 0), divRate: Number.isFinite(c.divRate) ? num(c.divRate, 0, 99, 0) : null, brackets, social };
  }

  /** Valida unos impuestos importados o guardados (se tratan como NO fiables). */
  function clean(src) {
    const out = { country: 'ES', scale: null, custom: null };
    if (!isObj(src)) return out;
    out.custom = cleanCustom(src.custom);
    const c = DATA.countries.find(x => x.id === src.country);
    if (src.country === 'CUSTOM' && out.custom) out.country = 'CUSTOM';
    else if (c) { out.country = c.id; out.scale = c.scales.some(s => s.id === src.scale) ? src.scale : null; }
    return out;
  }

  App.taxes = { countries: () => DATA.countries, currencies, fxFor, resolve, taxable, calc, netOf, grossFn, grossOf, moveTau, divTax, normBrackets, clean,
    label: t => resolve(t).label, fxDate: () => App.snapshot?.fx?.updated || null };
})(window.App = window.App || {});
