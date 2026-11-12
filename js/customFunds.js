/* Fondos personalizados (sin DOM): definición, validación de lo importado y conversión a fondos del catálogo.
   Definición (se guarda en state.customFunds):
     { id, name, kind: 'index'|'etf', perYear: movimientos al año, pct: % del fondo que se mueve cada vez, taxed: ¿tributan esos movimientos?,
       mimic: null | { fund, prov }  → imita a un fondo del catálogo y a su gestor,
       vals: { rate, ter, vol, yield, corr } → fondo inventado: todos; imitado: solo lo que el usuario ha cambiado (lo demás se hereda) }
   Unidades: rate, ter, vol, yield en % anual; corr entre -1 y 1 (correlación con la renta variable global: cuanto más baja, más diversifica). */
(function (App) {
  'use strict';
  const { config } = App;
  const DEFAULTS = { rate: 7, ter: 0.2, vol: 15, yield: 1.5, corr: 0.9 }; // valores típicos de un fondo global de renta variable
  const LIMITS = { rate: [-50, 100], ter: [0, 10], vol: [0.1, 100], yield: [0, 30], corr: [-1, 1] };
  const KEYS = Object.keys(LIMITS);
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const baseFunds = () => config.FUNDS.filter(f => !f.custom);
  const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

  function newId(used) {
    let id;
    do { id = 'cf-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0'); } while (used.has(id));
    return id;
  }

  /** Fondo nuevo con los valores por defecto (fondo indexado: sin impuestos al mover; ETF: con impuestos). */
  function blank(used = new Set()) {
    return { id: newId(used), name: '', kind: 'index', perYear: 2, pct: 10, taxed: false, mimic: null, vals: { ...DEFAULTS } };
  }

  /** Valores finales del fondo: lo que haya cambiado el usuario y, si imita a otro, lo demás del fondo imitado. */
  function effective(d, rateOf) {
    const v = d.vals || {};
    const base = d.mimic ? baseFunds().find(f => f.id === d.mimic.fund) : null;
    if (base) {
      const prov = base.providers.find(p => p.id === d.mimic.prov) || base.providers[0], baseRate = rateOf(base).rate * 100;
      return { rate: v.rate ?? baseRate, baseRate, ter: v.ter ?? prov.ter, vol: v.vol ?? base.vol, yield: v.yield ?? base.yield, corr: 1, base, provider: prov };
    }
    return { rate: v.rate ?? DEFAULTS.rate, baseRate: null, ter: v.ter ?? DEFAULTS.ter, vol: v.vol ?? DEFAULTS.vol, yield: v.yield ?? DEFAULTS.yield, corr: v.corr ?? DEFAULTS.corr, base: null, provider: null };
  }

  /** Convierte la definición en un fondo del catálogo (misma forma que los de config.js). */
  function build(d, e = effective(d, () => ({ rate: 0 }))) {
    return { id: d.id, custom: true, kind: d.kind, name: d.name, vol: e.vol, yield: e.yield, fallback: e.rate / 100, mimic: d.mimic,
      moves: { perYear: d.perYear, pct: d.pct, taxed: !!d.taxed }, providers: [{ id: d.id, name: 'Personalizado', ter: e.ter }] };
  }

  /** Valida unos fondos importados o guardados (se tratan como NO fiables). */
  function clean(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set(), out = [];
    for (const d of arr.slice(0, 20)) {
      if (!isObj(d) || typeof d.id !== 'string' || !/^cf-[a-z0-9]{3,12}$/.test(d.id) || seen.has(d.id)) continue;
      seen.add(d.id);
      const kind = d.kind === 'etf' ? 'etf' : 'index';
      const bf = isObj(d.mimic) ? baseFunds().find(f => f.id === d.mimic.fund) : null;
      const mimic = bf ? { fund: bf.id, prov: bf.providers.some(p => p.id === d.mimic.prov) ? d.mimic.prov : bf.providers[0].id } : null;
      const src = isObj(d.vals) ? d.vals : {}, vals = {};
      for (const k of KEYS) {
        const v = src[k];
        if (Number.isFinite(v)) vals[k] = num(v, ...LIMITS[k], DEFAULTS[k]);
        else if (!mimic) vals[k] = DEFAULTS[k]; // inventado: siempre completo; imitado: solo lo cambiado
      }
      out.push({ id: d.id, name: String(d.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Fondo personalizado', kind,
        perYear: Math.round(num(d.perYear, 0, 12, 0)), pct: num(d.pct, 0, 100, 0), taxed: typeof d.taxed === 'boolean' ? d.taxed : kind === 'etf', mimic, vals });
    }
    return out;
  }

  /** Pone los fondos personalizados en el catálogo y avisa al servicio de datos de cómo simular su histórico mensual. */
  function sync(defs, rateOf) {
    const F = config.FUNDS;
    for (let i = F.length - 1; i >= 0; i--) if (F[i].custom) F.splice(i, 1);
    const series = {};
    for (const d of defs) {
      const e = effective(d, rateOf);
      F.push(build(d, e));
      series[d.id] = d.mimic
        ? { base: e.base.id, shift: Math.pow(1 + e.rate / 100, 1 / 12) - Math.pow(1 + e.baseRate / 100, 1 / 12), volScale: e.vol / e.base.vol }
        : { base: null, rate: e.rate / 100, vol: e.vol / 100, corr: e.corr, seed: hash(d.id) };
    }
    App.data.setCustom(series);
  }

  App.customFunds = { DEFAULTS, LIMITS, KEYS, baseFunds, blank, effective, build, clean, sync };
})(window.App = window.App || {});
