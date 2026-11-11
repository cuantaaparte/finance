/* Impuestos (sin DOM): tramos de data/tax-data.js o personalizados, cálculo bruto ↔ neto y validación de lo importado.
   Todo va en € de HOY: se supone que los tramos se ajustan a la inflación cada año, así que en la simulación (en € de hoy)
   siempre valen lo mismo. Los límites se guardan en la moneda del país y se convierten con el tipo de cambio. */
(function (App) {
  'use strict';
  const DATA = App.taxData || { countries: [] };
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const NONE = { id: 'NONE', name: 'Sin impuestos', label: 'Sin impuestos', currency: 'EUR', fx: 1, allowance: 0, brackets: [{ upTo: null, rate: 0 }], social: [], note: '', approx: false };

  const fxOf = c => { const r = App.snapshot?.fx?.rates?.[c.currency]; return c.currency === 'EUR' ? 1 : r > 0 ? r : c.fx; }; // 1º tipo de cambio actualizado, 2º el de reserva

  /** Definición de impuestos que corresponde a state.tax (país + tipo de renta, o personalizado). */
  function resolve(t) {
    t = t || {};
    if (t.country === 'CUSTOM' && t.custom) return { ...t.custom, id: 'CUSTOM', name: 'Personalizado', label: 'Personalizado', custom: true, scaleId: null, note: '', approx: false };
    const c = DATA.countries.find(x => x.id === t.country) || DATA.countries[0];
    if (!c) return NONE;
    const s = c.scales.find(x => x.id === t.scale) || c.scales[0];
    return { id: c.id, name: c.name, label: c.scales.length > 1 ? `${c.name} · ${s.short}` : c.name, currency: c.currency, fx: fxOf(c), year: c.year,
      scaleId: s.id, scaleName: s.name, allowance: s.allowance || 0, brackets: s.brackets, social: s.social || [], note: [c.note, s.note].filter(Boolean).join(' '), approx: !!(c.approx || s.approx), custom: false };
  }

  /** Impuestos de una retirada bruta ANUAL (en € de hoy). rows = reparto por tramo. */
  function calc(def, gross) {
    gross = Math.max(0, gross);
    const fx = def.fx || 1, local = gross * fx, base = Math.max(0, local - (def.allowance || 0));
    let prev = 0, income = 0;
    const rows = def.brackets.map(b => {
      const hi = b.upTo == null ? Infinity : b.upTo, part = Math.max(0, Math.min(base, hi) - prev), t = (part * b.rate) / 100;
      prev = Math.max(prev, hi); income += t;
      return { part: part / fx, tax: t / fx };
    });
    const socRate = (def.social || []).reduce((a, x) => a + x.rate, 0) / 100, soc = gross * socRate;
    const tax = Math.min(gross, income / fx + soc);
    const mb = def.brackets.find(b => b.upTo == null || base < b.upTo) || def.brackets.at(-1);
    return { gross, income: income / fx, social: soc, tax, net: gross - tax, rate: gross > 0 ? tax / gross : 0,
      marginal: (local <= (def.allowance || 0) ? 0 : mb.rate / 100) + socRate, rows };
  }

  /** Bruto anual necesario para quedarte con `net` anuales tras impuestos (la función es creciente: búsqueda binaria). */
  function grossOf(def, net) {
    if (!(net > 0)) return 0;
    let lo = net, hi = net * 2 + 1, n = 0;
    while (calc(def, hi).net < net && n++ < 50) hi *= 2;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (calc(def, mid).net < net) lo = mid; else hi = mid; }
    return hi;
  }
  const netOf = (def, gross) => calc(def, gross).net;

  /** Ordena los tramos, quita repetidos y deja el último abierto (upTo null). Devuelve null si no hay tramos válidos. */
  function normBrackets(arr) {
    if (!Array.isArray(arr) || !arr.length || arr.length > 60) return null;
    const rows = arr.filter(isObj).map(b => ({ upTo: Number.isFinite(b.upTo) && b.upTo > 0 ? Math.min(b.upTo, 1e12) : null, rate: num(b.rate, 0, 99, 0) }));
    if (!rows.length) return null;
    const open = rows.find(r => r.upTo == null) || rows.at(-1);
    const fin = rows.filter(r => r.upTo != null && r !== open).sort((a, b) => a.upTo - b.upTo).filter((r, i, a) => !i || r.upTo !== a[i - 1].upTo);
    return [...fin, { upTo: null, rate: open.rate }];
  }

  function cleanCustom(c) {
    if (!isObj(c)) return null;
    const brackets = normBrackets(c.brackets);
    if (!brackets) return null;
    const currency = typeof c.currency === 'string' && /^[A-Z]{3}$/.test(c.currency) ? c.currency : 'EUR';
    const social = (Array.isArray(c.social) ? c.social : []).slice(0, 10).filter(isObj).map(x => ({
      name: String(x.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Seguridad social', rate: num(x.rate, 0, 99, 0) }));
    return { from: String(c.from ?? '').slice(0, 80), currency, fx: currency === 'EUR' ? 1 : num(c.fx, 1e-4, 1e6, 1), allowance: num(c.allowance, 0, 1e12, 0), brackets, social };
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

  App.taxes = { countries: () => DATA.countries, resolve, calc, grossOf, netOf, normBrackets, clean,
    label: t => resolve(t).label, fxDate: () => App.snapshot?.fx?.updated || null };
})(window.App = window.App || {});
