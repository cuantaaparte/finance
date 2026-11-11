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
    else { s.retNeeds = Math.max(0, s.retNeeds); s.retLeisure = Math.max(0, s.retLeisure); }
    return s;
  }

  /** Punto de partida estándar (salario medio) para las estrategias; conserva fondos, inflación y comisiones del usuario. */
  function averageProfile(s) {
    const a = config.AVERAGE_PROFILE, n = structuredClone(s);
    Object.assign(n, { net: a.net, initial: a.initial, workYears: a.workYears, retireYears: a.retireYears, investAuto: true, retLinked: true, touched: { needs: false, leisure: false } });
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

  function simulate(s, p, opts = {}) { // opts.crash: caída (0-1) del capital justo al jubilarte
    const infl = s.inflation / 100, infM = Math.pow(1 + infl, 1 / 12); // inflación mensual
    const m = r => Math.pow((1 + r) / (1 + infl), 1 / 12) - 1; // tasa mensual real
    const mP = m(p.price), mT = m(p.total), dM = Math.max(0, (p.total - p.price) / 12); // dM: dividendos (ya con impuestos) que se reinvierten
    const T = App.taxes, def = T.resolve(s.tax), net = s.retNeeds + s.retLeisure;
    const grossAt = q => (net > 0 ? T.grossOf(def, net * 12, q) / 12 : 0); // bruto mensual que hay que sacar para cobrar `net` tras impuestos
    const gainShare = (t, b) => (t > 0 ? clamp(1 - b / t, 0, 1) : 0);     // parte del capital que es ganancia (coste medio)
    const years = s.workYears + s.retireYears;
    const invested = [s.initial], price = [s.initial], total = [s.initial], decline = [];
    let depleted = null, basis = s.initial, spend = 0, first = 0, q0 = 0; // basis: lo aportado (coste), en € de hoy: la inflación lo va "gastando"
    for (let y = 0; y < years; y++) {
      let i = invested[y], pr = price[y], t = total[y];
      if (opts.crash && y === s.workYears) t *= 1 - opts.crash;
      const start = t, working = y < s.workYears;
      if (!working) { // cada año se recalcula el bruto según cuánta ganancia haya en el capital
        const q = gainShare(t, basis); spend = grossAt(q);
        if (y === s.workYears) { first = spend; q0 = q; }
      }
      for (let k = 0; k < 12; k++) {
        if (working) { basis = basis / infM + s.invest + t * dM; pr = pr * (1 + mP) + s.invest; t = t * (1 + mT) + s.invest; i += s.invest; }
        else { const tb = t * (1 + mT); basis = basis / infM + t * dM; t = Math.max(0, tb - spend); basis = tb > 0 ? basis * (t / tb) : 0; }
      }
      invested.push(i); price.push(working ? pr : null); total.push(t);
      decline.push(!working && t < start * 0.9999);
      if (!working && t === 0 && depleted === null) depleted = y + 1;
    }
    const capital = total[s.workYears];
    // Mismo plan sin descontar la inflación: lo que marcaría la cuenta en euros "de cada año" (nominales).
    const nominal = total.map((t, y) => t * Math.pow(1 + infl, y));
    const nominalDecline = decline.map((_, y) => y >= s.workYears && nominal[y + 1] < nominal[y] * 0.9999);
    return { years, work: s.workYears, invested, price, total, decline, nominal, nominalDecline, depleted, capital,
             spend: first, net, q0, // spend = bruto mensual el primer año de jubilación; net = lo que cobras tras impuestos
             withdrawalRate: capital > 0 ? first * 12 / capital : Infinity,
             realReturn: (1 + p.total) / (1 + infl) - 1 };
  }

  /** Menor nº de años trabajando para el que la simulación cumple `ok`. */
  function earliest(s, p, ok) {
    for (let w = 1; w <= 60; w++) if (ok(simulate({ ...s, workYears: w }, p))) return w;
    return null;
  }

  // Niveles según la nota: 50 × probabilidad de quedarte sin dinero + hasta otros 50 según lo pronto que se agota
  const LEVELS = [[5, 'Muy bajo', 'green'], [12, 'Bajo', 'green'], [25, 'Medio', ''], [40, 'Alto', 'orange'], [101, 'Muy alto', 'red']];

  const rng = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

  /**
   * Monte Carlo (semilla fija → resultado estable). Cada simulación remuestrea por bloques de 12 meses la historia REAL
   * de la cartera (conserva rachas y caídas), recentrada en la rentabilidad esperada, y sortea la inflación de cada año
   * con su variación histórica real. Devuelve la probabilidad de agotar el dinero y lo pronto que ocurre.
   */
  function monteCarlo(s, exp, market, infl, volEst, divM, runs = 300) {
    const rand = rng(20261107), hist = market?.returns, L = hist?.length || 0, B = Math.min(12, L);
    const mean = L ? hist.reduce((a, x) => a + x, 0) / L : 0, target = Math.pow(1 + exp, 1 / 12) - 1;
    const workM = s.workYears * 12, totalM = workM + s.retireYears * 12;
    const T = App.taxes, def = T.resolve(s.tax), net = s.retNeeds + s.retLeisure;
    let fails = 0, early = 0;
    for (let k = 0; k < runs; k++) {
      let w = s.initial, basis = s.initial, spend = 0, idx = 0, left = 0, inf = 1; // basis: coste de lo aportado (€ de hoy)
      for (let m = 0; m < totalM; m++) {
        if (m % 12 === 0) inf = Math.pow(1 + Math.max(-0.02, s.inflation / 100 + (infl ? infl.sd * gauss(rand) : 0)), 1 / 12);
        let r;
        if (L) { if (left === 0) { idx = Math.floor(rand() * (L - B + 1)); left = B; } r = hist[idx++] - mean + target; left--; }
        else r = target + (volEst / Math.sqrt(12)) * gauss(rand);
        const g = Math.max(-0.99, (1 + r) / inf - 1);
        if (m < workM) { basis = basis / inf + s.invest + w * divM; w = w * (1 + g) + s.invest; }
        else {
          if ((m - workM) % 12 === 0) spend = net > 0 ? T.grossOf(def, net * 12, w > 0 ? clamp(1 - basis / w, 0, 1) : 0) / 12 : 0; // bruto del año según la ganancia acumulada
          const wb = w * (1 + g); basis = basis / inf + w * divM; w = wb - spend;
          if (w <= 0) { fails++; early += 1 - (m - workM) / (totalM - workM); break; }
          basis *= w / wb;
        }
      }
    }
    const prob = fails / runs;
    return { prob, score: 50 * prob + 50 * prob * (fails ? early / fails : 0) };
  }

  /**
   * Riesgo del plan (0-100) con datos calculados: histórico real de tus fondos (volatilidad, caídas, correlaciones),
   * variación histórica de la inflación y tus entradas/salidas de dinero antes y después de jubilarte.
   * La rentabilidad esperada se limita a la del mercado global para no premiar a un fondo solo por su rentabilidad pasada.
   */
  function risk(s, p, res, rateOf, inputs) {
    const market = inputs?.market || null, infl = inputs?.infl || null;
    const world = portfolio({ ...s, alloc: { VT: 100 }, prov: {} }, rateOf).total;
    const exp = Math.min(p.total, world), volEst = p.vol / 100;
    const mc = monteCarlo(s, exp, market, infl, volEst, (p.total - p.price) / 12);
    const score = Math.round(mc.score);
    const [, level, color] = LEVELS.find(l => score < l[0]);
    return { score, level, color, prob: mc.prob, exp, capped: p.total > world, vol: market ? market.vol : volEst,
             maxDD: market ? market.maxDD : null, divRatio: market ? market.divRatio : null, histYears: market ? market.years : null,
             inflSd: infl ? infl.sd : null, inflYears: infl ? infl.years : null };
  }

  /** Estrategias: planes COMPLETOS (fondos, gestores, reparto, ahorro y retirada) calculados siempre desde `base`. */
  function strategies(base, rateOf, inputsOf) {
    const useFunds = (ns, alloc) => {
      ns.alloc = structuredClone(alloc);
      ns.prov = Object.fromEntries(Object.keys(alloc).map(id => [id, cheapest(config.FUNDS.find(f => f.id === id)).id]));
    };
    const A = config.STRATEGY_ALLOC;
    const defs = [
      { id: 'early', title: '🏖️ Jubilarte cuanto antes', desc: '100 % renta variable global (gestor más barato); dejas de trabajar en cuanto el capital aguanta toda la jubilación.',
        patch(ns) {
          useFunds(ns, A.growth); ns.investAuto = true; ns.retLinked = true; normalize(ns);
          const w = earliest(ns, portfolio(ns, rateOf), r => r.depleted === null); if (!w) return false; ns.workYears = w;
        } },
      { id: 'forever', title: '♾️ Capital que nunca baja', desc: `Retiras ${config.FOREVER_SPEND} €/mes netos y aun así el capital crece cada año (con inflación).`,
        patch(ns) {
          useFunds(ns, A.growth); ns.investAuto = true; normalize(ns);
          const spend = Math.max(config.FOREVER_SPEND, ns.needs + ns.leisure), share = ns.needs + ns.leisure ? ns.needs / (ns.needs + ns.leisure) : 0.7;
          ns.retLinked = false; ns.retNeeds = spend * share; ns.retLeisure = spend - ns.retNeeds;
          const w = earliest(ns, portfolio(ns, rateOf), r => r.depleted === null && !r.decline.some(Boolean)); if (!w) return false; ns.workYears = w;
        } },
      { id: 'grow', title: '🚀 Ahorrar más', desc: 'Recortas un 25 % el ocio y ahorros, lo inviertes todo, 100 % renta variable global y el gestor más barato.',
        patch(ns) { useFunds(ns, A.growth); ns.leisure *= 0.75; ns.touched.leisure = true; ns.investAuto = true; ns.retLinked = true; } },
      { id: 'safe', title: '🛡️ Prudente 60/40', desc: '60 % renta variable global y 40 % bonos (gestores más baratos): caídas más suaves, pero rinde menos y puede pedirte más años de trabajo o gastar menos.',
        patch(ns) { useFunds(ns, A.safe); ns.investAuto = true; ns.retLinked = true; } },
    ];
    return defs.map(d => {
      const ns = structuredClone(base);
      const ok = d.patch(ns) !== false;
      normalize(ns);
      const p = portfolio(ns, rateOf), res = simulate(ns, p);
      return { id: d.id, title: d.title, desc: d.desc, unavailable: !ok, state: ns, risk: risk(ns, p, res, rateOf, inputsOf(ns)), res };
    });
  }

  App.finance = { normalize, averageProfile, risk, portfolio, simulate, strategies, cheapest, providerOf };
})(window.App = window.App || {});
