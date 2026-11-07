/* Lógica financiera pura (sin DOM): normalización, cartera, simulación y estrategias.
   Todo se calcula en euros de HOY: las aportaciones y retiradas suben con la inflación y el rendimiento es real. */
(function (App) {
  'use strict';
  const { config } = App;
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  const cheapest = f => f.providers.reduce((a, b) => (b.ter < a.ter ? b : a));
  const providerOf = (s, f) => f.providers.find(p => p.id === s.prov?.[f.id]) || f.providers[0];

  /** Mantiene coherentes sueldo/gastos/ocio/inversión (nunca superan el sueldo). */
  function normalize(s) {
    s.net = Math.max(0, s.net);
    if (!s.touched.needs) s.needs = s.net * 0.5;     // estimación por defecto
    if (!s.touched.leisure) s.leisure = s.net * 0.15;
    s.needs = clamp(s.needs, 0, s.net);
    s.leisure = clamp(s.leisure, 0, s.net - s.needs);
    const free = s.net - s.needs - s.leisure;
    s.invest = s.investAuto ? free : clamp(s.invest, 0, free);
    if (s.retLinked) { s.retNeeds = s.needs; s.retLeisure = s.leisure; }
    return s;
  }

  /** Punto de partida estándar (salario medio) para las estrategias; conserva fondos, inflación y comisiones del usuario. */
  function averageProfile(s) {
    const a = config.AVERAGE_PROFILE, n = structuredClone(s);
    Object.assign(n, { net: a.net, initial: a.initial, workYears: a.workYears, investAuto: true, retLinked: true, touched: { needs: false, leisure: false } });
    return normalize(n);
  }

  /** Rentabilidad nominal neta de comisiones (fondo + bróker), dividendos netos de impuestos y riesgo ponderado. */
  function portfolio(s, rateOf) {
    const rows = Object.entries(s.alloc).map(([id, w]) => [config.FUNDS.find(f => f.id === id), w]).filter(([f]) => f);
    const sum = rows.reduce((a, [, w]) => a + w, 0);
    let price = -s.brokerFee / 100, div = 0, vol = 0;
    rows.forEach(([f, w]) => {
      const k = sum > 0 ? w / sum : 1 / rows.length;
      price += k * (rateOf(f).rate - providerOf(s, f).ter / 100);
      div += k * (f.yield / 100) * (1 - config.DIV_TAX);
      vol += k * f.vol; // aproximación: media ponderada (ignora correlaciones)
    });
    return { price, total: price + div, vol };
  }

  function simulate(s, p) {
    const infl = s.inflation / 100;
    const m = r => Math.pow((1 + r) / (1 + infl), 1 / 12) - 1; // tasa mensual real
    const mP = m(p.price), mT = m(p.total);
    const spend = s.retNeeds + s.retLeisure;
    const years = s.workYears + s.retireYears;
    const invested = [s.initial], price = [s.initial], total = [s.initial], decline = [];
    let depleted = null;
    for (let y = 0; y < years; y++) {
      let i = invested[y], pr = price[y], t = total[y];
      const start = t, working = y < s.workYears;
      for (let k = 0; k < 12; k++) {
        if (working) { pr = pr * (1 + mP) + s.invest; t = t * (1 + mT) + s.invest; i += s.invest; }
        else t = Math.max(0, t * (1 + mT) - spend);
      }
      invested.push(i); price.push(working ? pr : null); total.push(t);
      decline.push(!working && t < start * 0.9999);
      if (!working && t === 0 && depleted === null) depleted = y + 1;
    }
    const capital = total[s.workYears];
    return { years, work: s.workYears, invested, price, total, decline, depleted, capital, spend,
             withdrawalRate: capital > 0 ? spend * 12 / capital : Infinity,
             realReturn: (1 + p.total) / (1 + infl) - 1 };
  }

  /** Menor nº de años trabajando para el que la simulación cumple `ok`. */
  function earliest(s, p, ok) {
    for (let w = 1; w <= 60; w++) if (ok(simulate({ ...s, workYears: w }, p))) return w;
    return null;
  }

  const LEVELS = [[20, 'Muy bajo', 'green'], [38, 'Bajo', 'green'], [58, 'Medio', ''], [75, 'Alto', 'orange'], [101, 'Muy alto', 'red']];

  /** Riesgo global del plan (0-100) a partir de 4 bloques: mercado, retirada, inflación y horizonte/esfuerzo. */
  function risk(s, p, res, statsOf) {
    const scale = (x, a, b) => clamp((x - a) / (b - a), 0, 1) * 100;
    const st = statsOf ? statsOf(s) : null;
    const vol = st ? st.vol : p.vol / 100, dd = st ? st.maxDD : vol * 3; // sin histórico: caída máx. ≈ 3× la volatilidad
    // 1) Mercado: cuánto se mueven y cuánto han llegado a caer los fondos elegidos
    const market = 0.5 * scale(vol, 0.04, 0.22) + 0.5 * scale(dd, 0.05, 0.5);
    // 2) Retirada: tasa de retirada al jubilarte (4 % ≈ referencia) y duración de la jubilación; 100 si el dinero se acaba
    const sustain = res.depleted !== null ? 100 : 0.8 * scale(res.withdrawalRate, 0.025, 0.06) + 0.2 * scale(s.retireYears, 25, 50);
    // 3) Inflación: ¿aguantaría el plan si fuera 2 puntos mayor de lo supuesto? (tasa de retirada resultante) y lo alta que ya es la supuesta
    const stress = simulate({ ...s, inflation: s.inflation + 2 }, p);
    const wrS = stress.capital > 0 ? stress.spend * 12 / stress.capital : Infinity;
    const shock = res.depleted !== null ? 100 : stress.depleted !== null ? 90 : scale(wrS, 0.03, 0.07);
    const inflation = 0.6 * shock + 0.4 * scale(s.inflation, 2, 8);
    // 4) Horizonte y esfuerzo: pocos años invirtiendo dejan poco margen; ahorrar casi nada o más del 30 % del sueldo es frágil
    const save = s.net > 0 ? s.invest / s.net : 0;
    const horizon = 0.6 * scale(s.workYears, 25, 8) + 0.4 * (save < 0.05 ? 80 : scale(save, 0.3, 0.6));
    const score = Math.round(0.35 * market + 0.30 * sustain + 0.15 * inflation + 0.20 * horizon);
    const [, level, color] = LEVELS.find(l => score < l[0]);
    return { score, level, color, live: !!st, vol, maxDD: dd,
             parts: { market: Math.round(market), sustain: Math.round(sustain), inflation: Math.round(inflation), horizon: Math.round(horizon) } };
  }

  /** Estrategias calculadas SIEMPRE desde `base` (los datos del usuario), así no cambian al pulsar una y otra. */
  function strategies(base, rateOf, statsOf) {
    const defs = [
      { id: 'early', title: '🏖️ Jubilarte cuanto antes', desc: 'Mismo ahorro; dejas de trabajar en cuanto el capital aguanta toda la jubilación.',
        patch(ns, p) { const w = earliest(ns, p, r => r.depleted === null); if (!w) return false; ns.workYears = w; } },
      { id: 'forever', title: '♾️ Capital que nunca baja', desc: `Retiras ${config.FOREVER_SPEND} €/mes y aun así el capital crece cada año (con inflación).`,
        patch(ns, p) {
          const spend = Math.max(config.FOREVER_SPEND, ns.retNeeds + ns.retLeisure), share = ns.needs + ns.leisure ? ns.needs / (ns.needs + ns.leisure) : 0.7;
          ns.retLinked = false; ns.retNeeds = spend * share; ns.retLeisure = spend - ns.retNeeds;
          const w = earliest(ns, p, r => r.depleted === null && !r.decline.some(Boolean)); if (!w) return false; ns.workYears = w;
        } },
      { id: 'grow', title: '🚀 Ahorrar más', desc: 'Recortas un 25 % el ocio, lo inviertes, 100 % renta variable global y el gestor más barato.',
        patch(ns) {
          ns.invest += ns.leisure * 0.25; ns.leisure *= 0.75; ns.touched.leisure = true; ns.investAuto = false;
          ns.alloc = { VT: 100 }; ns.prov = { VT: cheapest(config.FUNDS.find(f => f.id === 'VT')).id };
        } },
      { id: 'safe', title: '🛡️ Prudente 60/40', desc: '60 % renta variable global y 40 % bonos: menos subidas, menos sustos.',
        patch(ns) { ns.alloc = { VT: 60, AGG: 40 }; } },
    ];
    return defs.map(d => {
      const ns = structuredClone(base);
      const ok = d.patch(ns, portfolio(ns, rateOf)) !== false;
      normalize(ns);
      const p = portfolio(ns, rateOf);
      const res = simulate(ns, p);
      return { id: d.id, title: d.title, desc: d.desc, unavailable: !ok, state: ns, risk: risk(ns, p, res, statsOf), res };
    });
  }

  App.finance = { normalize, averageProfile, risk, portfolio, simulate, strategies, cheapest, providerOf };
})(window.App = window.App || {});
