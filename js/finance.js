/* Lógica financiera pura (sin DOM): normalización, cartera, simulación y estrategias.
   Todo se calcula en euros de HOY: las aportaciones y retiradas suben con la inflación y el rendimiento es real. */
(function (App) {
  'use strict';
  const { config } = App;
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  /** Gestor más barato del fondo; con `kind` ('etf' | 'index'), el más barato de ese tipo (si no hay de ese tipo, de cualquiera). */
  const cheapest = (f, kind) => { const l = kind ? f.providers.filter(p => p.kind === kind) : f.providers; return (l.length ? l : f.providers).reduce((a, b) => (b.ter < a.ter ? b : a)); };
  /** Tipo del fondo en este plan: el del gestor elegido; si no hay, el indicado en fundCfg; por defecto ETF. Los personalizados llevan su propio tipo. */
  const kindOf = (s, f) => {
    if (f.custom) return f.kind === 'etf' ? 'etf' : 'index';
    const p = f.providers.find(x => x.id === s.prov?.[f.id]);
    if (p) return p.kind;
    const k = s.fundCfg?.[f.id]?.kind;
    return f.providers.some(x => x.kind === k) ? k : (f.providers.some(x => x.kind === 'etf') ? 'etf' : f.providers[0].kind);
  };
  /** Gestores del tipo elegido (si el índice no tiene de ese tipo, todos). */
  const providersOf = (s, f) => { const k = kindOf(s, f), l = f.providers.filter(p => p.kind === k); return l.length ? l : f.providers; };
  const providerOf = (s, f) => { const l = providersOf(s, f); return l.find(p => p.id === s.prov?.[f.id]) || l[0]; };
  /** Movimientos entre fondos de un fondo: los de un personalizado, o los de fundCfg para uno del catálogo (null = sin movimientos). */
  const movesOf = (s, f) => {
    if (f.moves) return f.moves;
    const c = s.fundCfg?.[f.id];
    return c ? { perYear: c.perYear ?? 0, pct: c.pct ?? 10, taxed: c.taxed ?? kindOf(s, f) === 'etf' } : null;
  };

  /** Mantiene coherentes sueldo/gastos/ocio/inversión (nunca superan el sueldo).
   *  needsWant / leisureWant / investWant guardan lo que el usuario pidió: si el sueldo baja un momento (p. ej. al teclear 2000 cifra a cifra)
   *  los importes se recortan solo mientras haga falta, y vuelven a lo pedido cuando el sueldo sube. */
  function normalize(s) {
    s.net = Math.max(0, s.net);
    if (!s.touched.needs) s.needs = s.net * 0.5;            // estimación por defecto
    else if (s.needsWant != null) s.needs = s.needsWant;
    if (!s.touched.leisure) s.leisure = s.net * 0.15;
    else if (s.leisureWant != null) s.leisure = s.leisureWant;
    s.needs = clamp(s.needs, 0, s.net);
    s.leisure = clamp(s.leisure, 0, s.net - s.needs);
    const free = s.net - s.needs - s.leisure;
    s.invest = s.investAuto ? free : clamp(s.investWant ?? s.invest, 0, free);
    if (s.retLinked) { s.retNeeds = s.needs; s.retLeisure = s.leisure; }
    else { s.retNeeds = Math.max(0, s.retNeeds); s.retLeisure = Math.max(0, s.retLeisure); }
    return s;
  }

  /** Punto de partida estándar (salario medio) para las estrategias; conserva la inflación, comisiones e impuestos del usuario
   *  (los fondos y gestores los fija cada estrategia). */
  function averageProfile(s) {
    const a = config.AVERAGE_PROFILE, n = structuredClone(s);
    Object.assign(n, { net: a.net, initial: a.initial, workYears: a.workYears, retireYears: a.retireYears, investAuto: true, retLinked: true, touched: { needs: false, leisure: false } });
    return normalize(n);
  }

  /** Fondo del que cada año se vende la fracción s pagando `tau` sobre la ganancia (y se reinvierte lo que queda), en régimen estable.
   *  Devuelve cuánto resta al rendimiento anual (drag) y qué parte del valor son ganancias que pasan a ser coste (realize).
   *  Resolución exacta (ecuación de 2º grado en el coste/valor): sustituye a un bucle de 300 iteraciones. */
  function moveDrag(r, s, tau) {
    s = clamp(s, 0, 1);
    if (!(s > 0 && tau > 0 && r > 0)) return { drag: 0, realize: 0 }; // sin ganancias no hay impuesto
    const A = s * tau * (1 + r), Bq = r + s - s * tau * (2 + r), C = -s * (1 - tau), D = Math.sqrt(Bq * Bq - 4 * A * C);
    const b1 = Bq >= 0 ? (-2 * C) / (Bq + D) : (-Bq + D) / (2 * A); // coste ÷ valor tras el crecimiento del año (raíz positiva, en (0,1))
    const g = Math.max(0, 1 - b1);
    return { drag: s * g * tau, realize: s * g };
  }

  /** Rentabilidad nominal neta de comisiones (fondo + bróker), dividendos netos de impuestos y riesgo ponderado. */
  function portfolio(s, rateOf) {
    let rows = Object.entries(s.alloc).map(([id, w]) => [config.FUNDS.find(f => f.id === id), w]).filter(([f]) => f);
    const sum = rows.reduce((a, [, w]) => a + w, 0), def = App.taxes.resolve(s.tax);
    if (sum > 0) rows = rows.filter(([, w]) => w > 0); // un fondo al 0 % no pesa: no hace falta calcularlo
    const tau = App.taxes.moveTau(def), dTax = App.taxes.divTax(def); // tipo de las ganancias al mover dinero y de los dividendos del país elegido
    let price = -s.brokerFee / 100, div = 0, vol = 0, realize = 0;
    rows.forEach(([f, w]) => {
      const k = sum > 0 ? w / sum : 1 / rows.length, r = rateOf(f).rate - providerOf(s, f).ter / 100;
      let drag = 0;
      const mvc = movesOf(s, f);
      if (mvc?.taxed && mvc.perYear > 0 && mvc.pct > 0) { // fondos que pagan impuestos al moverse
        const mv = moveDrag(r, (mvc.perYear * mvc.pct) / 100, tau);
        drag = mv.drag; realize += k * mv.realize * (1 - tau);
      }
      price += k * (r - drag);
      div += k * (f.yield / 100) * (1 - dTax);
      vol += k * f.vol; // aproximación: media ponderada (ignora correlaciones)
    });
    return { price, total: price + div, vol, realize };
  }

  function simulate(s, p) {
    const infl = s.inflation / 100, infM = Math.pow(1 + infl, 1 / 12); // inflación mensual
    const m = r => Math.pow((1 + r) / (1 + infl), 1 / 12) - 1; // tasa mensual real
    const mP = m(p.price), mT = m(p.total), dM = Math.max(0, (p.total - p.price) / 12) + (p.realize || 0) / 12; // dM: dividendos (ya con impuestos) que se reinvierten
    const T = App.taxes, gross = T.grossFn(T.resolve(s.tax)), net = s.retNeeds + s.retLeisure;
    const grossAt = q => (net > 0 ? gross(net * 12, q) / 12 : 0); // bruto mensual que hay que sacar para cobrar `net` tras impuestos
    const gainShare = (t, b) => (t > 0 ? clamp(1 - b / t, 0, 1) : 0);     // parte del capital que es ganancia (coste medio)
    const years = s.workYears + s.retireYears;
    const invested = [s.initial], price = [s.initial], total = [s.initial], decline = [];
    let depleted = null, basis = s.initial, spend = 0, first = 0, q0 = 0; // basis: lo aportado (coste), en € de hoy: la inflación lo va "gastando"
    for (let y = 0; y < years; y++) {
      let i = invested[y], pr = price[y], t = total[y];
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
    let f = 1;
    const nominal = total.map(t => { const v = t * f; f *= 1 + infl; return v; });
    const nominalDecline = decline.map((_, y) => y >= s.workYears && nominal[y + 1] < nominal[y] * 0.9999);
    return { years, work: s.workYears, invested, price, total, decline, nominal, nominalDecline, depleted, capital,
             spend: first, net, q0, // spend = bruto mensual el primer año de jubilación; net = lo que cobras tras impuestos
             withdrawalRate: capital > 0 ? first * 12 / capital : Infinity,
             realReturn: (1 + p.total) / (1 + infl) - 1 };
  }

  /** Menor nº de años trabajando (1-60) para el que la simulación cumple `ok`. Trabajar más años nunca empeora el capital de un plan con
   *  rentabilidad real positiva, así que `ok` es creciente y basta una búsqueda binaria (≈7 simulaciones en vez de hasta 60). */
  function earliest(s, p, ok) {
    const at = w => ok(simulate({ ...s, workYears: w }, p));
    if (at(1)) return 1;
    if (!at(60)) return null;
    let lo = 1, hi = 60; // at(lo) falso, at(hi) cierto
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (at(mid)) hi = mid; else lo = mid; }
    return hi;
  }

  // Niveles según la nota: 50 × probabilidad de quedarte sin dinero + hasta otros 50 según lo pronto que se agota
  const LEVELS = [[5, 'Muy bajo', 'green'], [12, 'Bajo', 'green'], [25, 'Medio', ''], [40, 'Alto', 'orange'], [101, 'Muy alto', 'red']];

  const rng = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = r => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

  /**
   * Monte Carlo (semilla fija → resultado estable). Cada simulación remuestrea por bloques de 12 meses la historia REAL
   * de la cartera (conserva rachas y caídas), recentrada para que su rentabilidad COMPUESTA sea la esperada (la media aritmética
   * mensual debe ser la geométrica + varianza/2; si no, el remuestreo rendiría ≈σ²/2 menos de lo previsto), y sortea la inflación
   * de cada año con su variación histórica real. Devuelve la probabilidad de agotar el dinero y lo pronto que ocurre.
   */
  function monteCarlo(s, exp, market, infl, volEst, divM, runs = 300) {
    const rand = rng(20261107), hist = market?.returns, L = hist?.length || 0, B = Math.min(12, L);
    const target = Math.pow(1 + exp, 1 / 12) - 1, volM = volEst / Math.sqrt(12);
    let adj = null; // rentabilidades mensuales ya recentradas (se calculan una sola vez, no en cada mes de cada pasada)
    if (L) {
      const mean = hist.reduce((a, x) => a + x, 0) / L, varM = L > 1 ? hist.reduce((a, x) => a + (x - mean) ** 2, 0) / (L - 1) : 0;
      adj = Float64Array.from(hist, x => x - mean + target + varM / 2);
    }
    const workM = s.workYears * 12, totalM = workM + s.retireYears * 12;
    const T = App.taxes, gross = T.grossFn(T.resolve(s.tax)), net = s.retNeeds + s.retLeisure;
    let fails = 0, early = 0;
    for (let k = 0; k < runs; k++) {
      let w = s.initial, basis = s.initial, spend = 0, idx = 0, left = 0, invInf = 1; // basis: coste de lo aportado (€ de hoy)
      for (let m = 0; m < totalM; m++) {
        if (m % 12 === 0) invInf = 1 / Math.pow(1 + Math.max(-0.02, s.inflation / 100 + (infl ? infl.sd * gauss(rand) : 0)), 1 / 12);
        let r;
        if (L) { if (left === 0) { idx = Math.floor(rand() * (L - B + 1)); left = B; } r = adj[idx++]; left--; }
        else r = target + (volM * volM) / 2 + volM * gauss(rand);
        const g = Math.max(-0.99, (1 + r) * invInf - 1);
        if (m < workM) { basis = basis * invInf + s.invest + w * divM; w = w * (1 + g) + s.invest; }
        else {
          if ((m - workM) % 12 === 0) spend = net > 0 ? gross(net * 12, w > 0 ? clamp(1 - basis / w, 0, 1) : 0) / 12 : 0; // bruto del año según la ganancia acumulada
          const wb = w * (1 + g); basis = basis * invInf + w * divM; w = wb - spend;
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
   * La rentabilidad esperada se limita a la del mercado global (con su gestor más barato, para no recortar a quien ya lo usa)
   * para no premiar a un fondo solo por su rentabilidad pasada.
   */
  function risk(s, p, rateOf, inputs) {
    const market = inputs?.market || null, infl = inputs?.infl || null, vt = config.FUNDS.find(f => f.id === 'VT');
    const world = portfolio({ ...s, alloc: { VT: 100 }, prov: vt ? { VT: cheapest(vt).id } : {} }, rateOf).total;
    const exp = Math.min(p.total, world), volEst = p.vol / 100;
    const mc = monteCarlo(s, exp, market, infl, volEst, (p.total - p.price) / 12 + (p.realize || 0) / 12);
    const score = Math.round(mc.score);
    const [, level, color] = LEVELS.find(l => score < l[0]);
    return { score, level, color, prob: mc.prob, exp, capped: p.total > world + 1e-9, vol: market ? market.vol : volEst,
             maxDD: market ? market.maxDD : null, divRatio: market ? market.divRatio : null, histYears: market ? market.years : null,
             inflSd: infl ? infl.sd : null, inflYears: infl ? infl.years : null };
  }

  /** Estrategias: planes COMPLETOS (fondos, gestores, reparto, ahorro y retirada) calculados siempre desde `base`. */
  function strategies(base, rateOf, inputsOf) {
    const useFunds = (ns, alloc) => {
      ns.fundCfg = {}; // cada estrategia usa sus fondos sin movimientos ni tipos elegidos por ti
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
        patch(ns) { useFunds(ns, A.growth); ns.leisure *= 0.75; ns.leisureWant = ns.leisure; ns.touched.leisure = true; ns.investAuto = true; ns.retLinked = true; } },
      { id: 'safe', title: '🛡️ Prudente 60/40', desc: '60 % renta variable global y 40 % bonos (gestores más baratos): caídas más suaves, pero rinde menos y puede pedirte más años de trabajo o gastar menos.',
        patch(ns) { useFunds(ns, A.safe); ns.investAuto = true; ns.retLinked = true; } },
    ];
    return defs.map(d => {
      const ns = structuredClone(base);
      const ok = d.patch(ns) !== false;
      normalize(ns);
      if (!ok) return { id: d.id, title: d.title, desc: d.desc, unavailable: true, state: ns, risk: null, res: null }; // inalcanzable: no hace falta simular ni calcular el riesgo
      const p = portfolio(ns, rateOf), res = simulate(ns, p);
      return { id: d.id, title: d.title, desc: d.desc, unavailable: false, state: ns, risk: risk(ns, p, rateOf, inputsOf(ns)), res };
    });
  }

  App.finance = { normalize, averageProfile, risk, portfolio, simulate, strategies, cheapest, providerOf, providersOf, kindOf, movesOf };
})(window.App = window.App || {});
