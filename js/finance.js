/* Lógica financiera pura (sin DOM): normalización, cartera, simulación (estándar y multi-tramo con fondos independientes, efectivo y operaciones) y estrategias.
   Todo se calcula en euros de HOY: las aportaciones y retiradas suben con la inflación y el rendimiento es real. */
(function (App) {
  "use strict";
  const { config } = App;
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  const eurFmt = new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  const isOpItem = (x) => x?.itemType === "op";
  const onlyPhases = (list) =>
    Array.isArray(list) ? list.filter((x) => !isOpItem(x)) : [];
  const kindLabel = (k) => (k === "etf" ? "ETF" : "Fondo");

  /** Gestor más barato del fondo; con `kind` ('etf' | 'index'), el más barato de ese tipo (si no hay de ese tipo, de cualquiera). */
  const cheapest = (f, kind) => {
    const l = kind ? f.providers.filter((p) => p.kind === kind) : f.providers;
    return (l.length ? l : f.providers).reduce((a, b) =>
      b.ter < a.ter ? b : a,
    );
  };
  /** Tipo por defecto: fondo indexado si el índice tiene alguno; si no, ETF. */
  const defaultKind = (f) =>
    f.providers.some((p) => p.kind === "index") ? "index" : "etf";
  /** Tipo del fondo en este plan: el del gestor elegido; si no hay, el indicado en fundCfg; por defecto ETF. Los personalizados llevan su propio tipo. */
  const kindOf = (s, f) => {
    if (f.custom) return f.kind === "etf" ? "etf" : "index";
    const p = f.providers.find((x) => x.id === s.prov?.[f.id]);
    if (p) return p.kind;
    const k = s.fundCfg?.[f.id]?.kind;
    return f.providers.some((x) => x.kind === k) ? k : defaultKind(f);
  };
  /** Gestores del tipo elegido (si el índice no tiene de ese tipo, todos). */
  const providersOf = (s, f) => {
    const k = kindOf(s, f),
      l = f.providers.filter((p) => p.kind === k);
    return l.length ? l : f.providers;
  };
  const providerOf = (s, f) => {
    const l = providersOf(s, f);
    return l.find((p) => p.id === s.prov?.[f.id]) || l[0];
  };
  /** Movimientos entre fondos de un fondo: los de un personalizado, o los de fundCfg para uno del catálogo (null = sin movimientos). */
  const movesOf = (s, f) => {
    if (f.moves) return f.moves;
    const c = s.fundCfg?.[f.id];
    return c
      ? {
          mode: c.moveMode === "total" ? "total" : "year",
          perYear: c.perYear ?? 0,
          total: c.totalMoves ?? 0,
          pct: c.pct ?? 10,
          taxed: c.taxed ?? kindOf(s, f) === "etf",
        }
      : null;
  };

  /** Calcula los importes normalizados de un tramo de inversión sin mutarlo. */
  function normInvestValues(ph) {
    const net = Math.max(0, Number(ph.net) || 0);
    const needsRaw = !ph.touched?.needs
      ? net * 0.5
      : ph.needsWant != null
        ? ph.needsWant
        : ph.needs;
    const needs = clamp(Number(needsRaw) || 0, 0, net);
    const leisureRaw = !ph.touched?.leisure
      ? net * 0.15
      : ph.leisureWant != null
        ? ph.leisureWant
        : ph.leisure;
    const leisure = clamp(Number(leisureRaw) || 0, 0, net - needs);
    const free = net - needs - leisure;
    const invest = ph.investAuto
      ? free
      : clamp(Number(ph.investWant ?? ph.invest) || 0, 0, free);
    return { net, needs, leisure, invest };
  }

  /** Mantiene coherentes sueldo/gastos/ocio/inversión (nunca superan el sueldo).
   *  needsWant / leisureWant / investWant guardan lo que el usuario pidió: si el sueldo baja un momento (p. ej. al teclear 2000 cifra a cifra)
   *  los importes se recortan solo mientras haga falta, y vuelven a lo pedido cuando el sueldo sube. */
  function normalize(s) {
    s.net = Math.max(0, s.net);
    if (!s.touched.needs)
      s.needs = s.net * 0.5; // estimación por defecto
    else if (s.needsWant != null) s.needs = s.needsWant;
    if (!s.touched.leisure) s.leisure = s.net * 0.15;
    else if (s.leisureWant != null) s.leisure = s.leisureWant;
    s.needs = clamp(s.needs, 0, s.net);
    s.leisure = clamp(s.leisure, 0, s.net - s.needs);
    const free = s.net - s.needs - s.leisure;
    s.invest = s.investAuto ? free : clamp(s.investWant ?? s.invest, 0, free);
    if (s.retLinked) {
      const invPhases = onlyPhases(s.advanced?.invest);
      if (
        s.advancedMode &&
        s.advanced?.activeGroup === "spend" &&
        invPhases.length
      ) {
        // En Modo Avanzado, "Mismos gastos que ahora" toma los gastos del último tramo de inversión
        const lastInv = normInvestValues(invPhases[invPhases.length - 1]);
        s.retNeeds = lastInv.needs;
        s.retLeisure = lastInv.leisure;
      } else {
        s.retNeeds = s.needs;
        s.retLeisure = s.leisure;
      }
    } else {
      s.retNeeds = Math.max(0, s.retNeeds);
      s.retLeisure = Math.max(0, s.retLeisure);
    }
    return s;
  }

  /** Punto de partida estándar (salario medio) para las estrategias; conserva la inflación, comisiones e impuestos del usuario
   *  (los fondos y gestores los fija cada estrategia). */
  function averageProfile(s) {
    const a = config.AVERAGE_PROFILE,
      n = structuredClone(s);
    Object.assign(n, {
      advancedMode: false,
      net: a.net,
      initial: a.initial,
      workYears: a.workYears,
      retireYears: a.retireYears,
      investAuto: true,
      retLinked: true,
      touched: { needs: false, leisure: false },
    });
    return normalize(n);
  }

  /** Fondo del que cada año se vende la fracción s pagando `tau` sobre la ganancia (y se reinvierte lo que queda), en régimen estable.
   *  Devuelve cuánto resta al rendimiento anual (drag) y qué parte del valor son ganancias que pasan a ser coste (realize).
   *  Resolución exacta (ecuación de 2º grado en el coste/valor): sustituye a un bucle de 300 iteraciones. */
  function moveDrag(r, s, tau) {
    s = clamp(s, 0, 1);
    if (!(s > 0 && tau > 0 && r > 0)) return { drag: 0, realize: 0 }; // sin ganancias no hay impuesto
    const A = s * tau * (1 + r),
      Bq = r + s - s * tau * (2 + r),
      C = -s * (1 - tau),
      D = Math.sqrt(Bq * Bq - 4 * A * C);
    const b1 = Bq >= 0 ? (-2 * C) / (Bq + D) : (-Bq + D) / (2 * A); // coste ÷ valor tras el crecimiento del año (raíz positiva, en (0,1))
    const g = Math.max(0, 1 - b1);
    return { drag: s * g * tau, realize: s * g };
  }

  /** Reparte los movimientos totales de cada fondo en meses concretos (0 .. spanM-1), cayendo siempre el último al final de la etapa. */
  function buildMoveSchedule(events, spanM) {
    if (!events?.length || spanM <= 0) return null;
    const byMonth = Object.create(null);
    for (const ev of events) {
      const n = Math.max(0, Math.round(ev.n));
      if (!n || !(ev.frac > 0)) continue;
      for (let j = 1; j <= n; j++) {
        const m = clamp(Math.round((j * spanM) / n) - 1, 0, spanM - 1);
        byMonth[m] = Math.min(1, (byMonth[m] || 0) + ev.frac);
      }
    }
    return Object.keys(byMonth).length ? byMonth : null;
  }

  /** Normaliza el reparto `alloc` de un tramo devolviendo [{ fund, prov, kind, weight }]. */
  function phaseTargets(ph) {
    let rows = Object.entries(ph.alloc || {})
      .map(([id, w]) => [config.FUNDS.find((f) => f.id === id), w])
      .filter(([f]) => f);
    if (!rows.length && config.FUNDS[0]) rows = [[config.FUNDS[0], 100]];
    const sum = rows.reduce((a, [, w]) => a + w, 0);
    if (sum > 0) rows = rows.filter(([, w]) => w > 0);
    return rows.map(([fund, w]) => {
      const prov = providerOf(ph, fund);
      return {
        fund,
        prov,
        kind: kindOf(ph, fund),
        weight: sum > 0 ? w / sum : 1 / rows.length,
      };
    });
  }

  /** Programa los movimientos totales (`mode === 'total'`) por mes para cada fondo configurado en un tramo. */
  function buildPhaseBucketMoves(ph, spanM) {
    if (spanM <= 0) return null;
    const byMonth = Object.create(null);
    for (const t of phaseTargets(ph)) {
      const mvc = movesOf(ph, t.fund);
      if (
        !mvc ||
        !mvc.taxed ||
        mvc.mode !== "total" ||
        !(mvc.total > 0) ||
        !(mvc.pct > 0)
      )
        continue;
      const n = Math.max(1, Math.round(mvc.total));
      const frac = clamp(mvc.pct / 100, 0, 1);
      for (let j = 1; j <= n; j++) {
        const m = clamp(Math.round((j * spanM) / n) - 1, 0, spanM - 1);
        (byMonth[m] ||= []).push({
          fundId: t.fund.id,
          provId: t.prov.id,
          kind: t.kind,
          frac,
        });
      }
    }
    return Object.keys(byMonth).length ? byMonth : null;
  }

  /** Rentabilidad nominal neta de comisiones (fondo + bróker), dividendos netos de impuestos y riesgo ponderado de una cartera única. */
  function evalPortfolio(s, rateOf) {
    let rows = Object.entries(s.alloc || {})
      .map(([id, w]) => [config.FUNDS.find((f) => f.id === id), w])
      .filter(([f]) => f);
    if (!rows.length) {
      const fb = config.FUNDS[0];
      if (fb) rows = [[fb, 100]];
    }
    const sum = rows.reduce((a, [, w]) => a + w, 0),
      def = App.taxes.resolve(s.tax);
    if (sum > 0) rows = rows.filter(([, w]) => w > 0); // un fondo al 0 % no pesa: no hace falta calcularlo
    const tau = App.taxes.moveTau(def),
      dTax = App.taxes.divTax(def); // tipo de las ganancias al mover dinero y de los dividendos del país elegido
    let price = -(Number(s.brokerFee) || 0) / 100,
      div = 0,
      vol = 0,
      realize = 0;
    const events = [];
    rows.forEach(([f, w]) => {
      const k = sum > 0 ? w / sum : 1 / rows.length,
        r = rateOf(f).rate - providerOf(s, f).ter / 100;
      let drag = 0;
      const mvc = movesOf(s, f);
      if (mvc?.taxed && mvc.pct > 0) {
        if (mvc.mode === "total") {
          if (mvc.total > 0)
            events.push({ n: mvc.total, frac: k * (mvc.pct / 100) });
        } else if (mvc.perYear > 0) {
          // fondos que pagan impuestos al moverse
          const mv = moveDrag(r, (mvc.perYear * mvc.pct) / 100, tau);
          drag = mv.drag;
          realize += k * mv.realize * (1 - tau);
        }
      }
      price += k * (r - drag);
      div += k * (f.yield / 100) * (1 - dTax);
      vol += k * f.vol; // aproximación: media ponderada (ignora correlaciones)
    });
    return { price, total: price + div, vol, realize, events };
  }

  /** Cartera del estado actual. En Modo Avanzado prepara las listas ordenadas de tramos+operaciones y las rentabilidades de todos los fondos usados. */
  function portfolio(s, rateOf) {
    const invPhases = onlyPhases(s.advanced?.invest);
    const spdPhases = onlyPhases(s.advanced?.spend);
    if (s.advancedMode && invPhases.length && spdPhases.length) {
      const baseTax = spdPhases[0]?.tax || s.tax;
      const rates = Object.create(null);
      const recordFund = (id) => {
        if (!id || id in rates) return;
        const f = config.FUNDS.find((x) => x.id === id);
        if (f) rates[id] = rateOf(f).rate;
      };
      const evalPhase = (ph, tax) => {
        for (const t of phaseTargets(ph)) recordFund(t.fund.id);
        return evalPortfolio(
          {
            ...s,
            alloc: ph.alloc,
            prov: ph.prov,
            fundCfg: ph.fundCfg,
            brokerFee: ph.brokerFee,
            tax: tax || baseTax,
          },
          rateOf,
        );
      };
      const wrapList = (list, isSpend) =>
        list.map((item) => {
          if (isOpItem(item)) {
            recordFund(item.fromFund);
            recordFund(item.toFund);
            return { isOp: true, op: item };
          }
          return {
            isOp: false,
            phase: item,
            port: evalPhase(item, isSpend ? item.tax : baseTax),
          };
        });
      const invest = wrapList(s.advanced.invest, false);
      const spend = wrapList(s.advanced.spend, true);
      const curGroup = (s.advanced.activeGroup === "spend" ? spend : invest).filter(
        (x) => !x.isOp,
      );
      const cur =
        curGroup.find((x) => x.phase.id === s.advanced.activeId) || curGroup[0];
      return { ...cur.port, adv: { invest, spend, rates } };
    }
    return evalPortfolio(s, rateOf);
  }

  /** Retirada ESTRICTA: solo saca dinero de los fondos (y tipo Fondo/ETF) seleccionados en el tramo de gasto.
   *  Si un fondo objetivo se agota, puede cubrirse con OTROS fondos también seleccionados en el mismo tramo,
   *  pero NUNCA recurre a fondos que no estén seleccionados en ese tramo. */
  function withdrawBucketsStrict(buckets, targets, amount, dryRun) {
    const n = buckets.length;
    const taken = new Float64Array(n);
    if (!(amount > 1e-12) || !n)
      return { taken, totalTaken: 0, shortfall: Math.max(0, amount) };
    let totalTaken = 0;

    const takeIndices = (indices, need) => {
      if (!(need > 1e-12) || !indices.length) return 0;
      let avail = 0;
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        avail += Math.max(0, buckets[idx].val - taken[idx]);
      }
      if (!(avail > 1e-12)) return 0;
      const grab = Math.min(need, avail);
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        const rem = Math.max(0, buckets[idx].val - taken[idx]);
        if (rem > 0) taken[idx] += grab * (rem / avail);
      }
      totalTaken += grab;
      return grab;
    };

    const allowedKeys = new Set();
    // Pasada 1: cada fondo+tipo objetivo en su proporción configurada
    for (const t of targets) {
      allowedKeys.add(`${t.fund.id}|${t.kind}`);
      let need = amount * t.weight;
      const exact = [],
        sameKind = [];
      for (let i = 0; i < n; i++) {
        const b = buckets[i];
        if (b.fundId !== t.fund.id || b.kind !== t.kind || b.val - taken[i] <= 1e-12)
          continue;
        if (b.provId === t.prov.id) exact.push(i);
        else sameKind.push(i);
      }
      need -= takeIndices(exact, need);
      if (need > 1e-12) takeIndices(sameKind, need);
    }

    // Pasada 2: si algún fondo objetivo se agotó, cubre el resto SOLO con los otros fondos seleccionados en este mismo tramo
    let shortfall = Math.max(0, amount - totalTaken);
    if (shortfall > 1e-12) {
      const pool = [];
      for (let i = 0; i < n; i++) {
        const b = buckets[i];
        if (
          allowedKeys.has(`${b.fundId}|${b.kind}`) &&
          b.val - taken[i] > 1e-12
        ) {
          pool.push(i);
        }
      }
      shortfall = Math.max(0, shortfall - takeIndices(pool, shortfall));
    }

    if (!dryRun) {
      for (let i = 0; i < n; i++) {
        const amt = taken[i];
        if (!(amt > 0)) continue;
        const b = buckets[i],
          before = b.val;
        b.val = Math.max(0, before - amt);
        b.basis = before > 0 ? b.basis * (b.val / before) : 0;
      }
    }
    return { taken, totalTaken, shortfall };
  }

  /** Aplica impuestos sobre ganancias en los movimientos puntuales (`mode === 'total'`) programados para un mes concreto. */
  function applyScheduledMoves(buckets, moveList, taxDef, T) {
    if (!moveList?.length || !buckets.length) return;
    const moves = [];
    let totalGain = 0;
    for (const ev of moveList) {
      const exact = buckets.filter(
        (b) => b.fundId === ev.fundId && b.provId === ev.provId && b.val > 1e-9,
      );
      const list = exact.length
        ? exact
        : buckets.filter(
            (b) =>
              b.fundId === ev.fundId && b.kind === ev.kind && b.val > 1e-9,
          );
      for (const b of list) {
        const gain = Math.max(0, b.val - b.basis) * ev.frac;
        moves.push({ b, frac: ev.frac, gain });
        totalGain += gain;
      }
    }
    if (!moves.length) return;
    const totalTax = totalGain > 0 ? T.calc(taxDef, totalGain).tax : 0;
    for (const m of moves) {
      const b = m.b;
      const tax = totalGain > 0 ? totalTax * (m.gain / totalGain) : 0;
      const ratio = b.val > 0 ? Math.max(0, (b.val - tax) / b.val) : 0;
      b.priceVal *= ratio;
      b.basis = b.basis * (1 - m.frac) + Math.max(0, b.val * m.frac - tax);
      b.val = Math.max(0, b.val - tax);
    }
  }

  /** Resuelve el proveedor de destino de una operación (comprar o mover). */
  function opDestProvider(op) {
    const f = config.FUNDS.find((x) => x.id === op.toFund);
    if (!f) return null;
    const k = op.toKind === "etf" ? "etf" : "index";
    const byId = f.providers.find((p) => p.id === op.toProv && p.kind === k);
    if (byId) return { fund: f, prov: byId };
    return { fund: f, prov: cheapest(f, k) };
  }

  /** Ejecuta una operación puntual (vender, comprar o mover) sobre el estado { buckets, cash }.
   *  Devuelve un mensaje de error si la operación es imposible o parcialmente imposible ("" si todo fue bien). */
  function runOperation(op, ctx, taxDef, T) {
    const fundName = (id) =>
      config.FUNDS.find((x) => x.id === id)?.name || id || "fondo";
    const amount = Math.max(0, Number(op.amount) || 0);
    if (!(amount > 0)) return "La cantidad de la operación debe ser mayor que 0.";

    if (op.op === "buy") {
      const dest = opDestProvider(op);
      if (!dest) return "Fondo de destino no encontrado.";
      const availCash = Math.max(0, ctx.cash);
      const req =
        op.amountMode === "eur" ? amount : availCash * (clamp(amount, 0, 100) / 100);
      let err = "";
      if (availCash <= 1e-3) {
        return `No tienes efectivo disponible para comprar ${dest.fund.name} (${kindLabel(dest.prov.kind)}).`;
      }
      if (op.amountMode === "eur" && availCash + 1 < req) {
        err = `Efectivo insuficiente: tienes ${eurFmt.format(availCash)} y quieres comprar ${eurFmt.format(req)}.`;
      }
      const spendCash = Math.min(availCash, req);
      if (spendCash > 1e-6) {
        ctx.cash = Math.max(0, ctx.cash - spendCash);
        const b = ctx.getBucket(dest.fund, dest.prov);
        b.val += spendCash;
        b.priceVal += spendCash;
        b.basis += spendCash;
      }
      return err;
    }

    // Vender o Mover: requieren saldo en el fondo + tipo de origen
    const fk = op.fromKind === "etf" ? "etf" : "index";
    const match = ctx.buckets.filter(
      (b) => b.fundId === op.fromFund && b.kind === fk && b.val > 1e-6,
    );
    const avail = match.reduce((a, b) => a + b.val, 0);
    if (avail <= 1e-3) {
      const otherKind = fk === "etf" ? "index" : "etf";
      const hasOther = ctx.buckets.some(
        (b) => b.fundId === op.fromFund && b.kind === otherKind && b.val > 1e-3,
      );
      const verb = op.op === "sell" ? "vender" : "mover";
      return hasOther
        ? `No tienes saldo en ${fundName(op.fromFund)} (${kindLabel(fk)}) para ${verb}; lo tienes como ${kindLabel(otherKind)}.`
        : `No tienes saldo en ${fundName(op.fromFund)} (${kindLabel(fk)}) en este punto para ${verb}.`;
    }

    const req =
      op.amountMode === "eur" ? amount : avail * (clamp(amount, 0, 100) / 100);
    let err = "";
    if (op.amountMode === "eur" && avail + 1 < req) {
      err = `Saldo insuficiente en ${fundName(op.fromFund)} (${kindLabel(fk)}): tienes ${eurFmt.format(avail)} y quieres ${op.op === "sell" ? "vender" : "mover"} ${eurFmt.format(req)}.`;
    }
    const takeTotal = Math.min(avail, req);
    const ratioTaken = avail > 0 ? takeTotal / avail : 0;

    if (op.op === "sell") {
      let soldVal = 0,
        soldBasis = 0;
      for (const b of match) {
        const dv = b.val * ratioTaken;
        const db = b.basis * ratioTaken;
        const dp = b.priceVal * ratioTaken;
        b.val = Math.max(0, b.val - dv);
        b.basis = Math.max(0, b.basis - db);
        b.priceVal = Math.max(0, b.priceVal - dp);
        soldVal += dv;
        soldBasis += db;
      }
      const gain = Math.max(0, soldVal - soldBasis);
      const tax = op.taxed && gain > 0 ? T.calc(taxDef, gain).tax : 0;
      ctx.cash += Math.max(0, soldVal - tax);
      return err;
    }

    // Mover (traspasar)
    const dest = opDestProvider(op);
    if (!dest) return "Fondo de destino no encontrado.";
    if (
      op.fromFund === dest.fund.id &&
      fk === dest.prov.kind &&
      match.length === 1 &&
      match[0].provId === dest.prov.id
    ) {
      return "El origen y el destino de la operación son exactamente el mismo fondo y gestor.";
    }
    let movedVal = 0,
      movedBasis = 0,
      movedPrice = 0;
    for (const b of match) {
      const dv = b.val * ratioTaken;
      const db = b.basis * ratioTaken;
      const dp = b.priceVal * ratioTaken;
      b.val = Math.max(0, b.val - dv);
      b.basis = Math.max(0, b.basis - db);
      b.priceVal = Math.max(0, b.priceVal - dp);
      movedVal += dv;
      movedBasis += db;
      movedPrice += dp;
    }
    const gain = Math.max(0, movedVal - movedBasis);
    const destB = ctx.getBucket(dest.fund, dest.prov);
    if (op.taxed) {
      const tax = gain > 0 ? T.calc(taxDef, gain).tax : 0;
      const netIn = Math.max(0, movedVal - tax);
      const pRatio = movedVal > 0 ? netIn / movedVal : 1;
      destB.val += netIn;
      destB.priceVal += movedPrice * pRatio;
      destB.basis += netIn; // tributó: su nuevo coste fiscal es el importe reinvertido
    } else {
      // Traspaso exento (Fondo → Fondo): conserva el coste fiscal original
      destB.val += movedVal;
      destB.priceVal += movedPrice;
      destB.basis += movedBasis;
    }
    return err;
  }

  /** Simulación secuencial multi-tramo con huchas independientes, efectivo, operaciones y retirada estricta. */
  function simulateAdvanced(s, p) {
    const T = App.taxes;
    const invItems = p.adv.invest;
    const spdItems = p.adv.spend;
    const rates = p.adv.rates || {};
    const firstSpendPhase = spdItems.find((x) => !x.isOp)?.phase;
    const baseTaxDef = T.resolve(firstSpendPhase?.tax || s.tax);

    // Huchas independientes keyed por `${fundId}|${provId}`
    const buckets = [];
    const bucketMap = new Map();
    const getBucket = (fund, prov) => {
      const key = `${fund.id}|${prov.id}`;
      let b = bucketMap.get(key);
      if (!b) {
        b = {
          key,
          fundId: fund.id,
          provId: prov.id,
          kind: prov.kind,
          fund,
          ter: prov.ter,
          val: 0,
          priceVal: 0,
          basis: 0,
        };
        bucketMap.set(key, b);
        buckets.push(b);
      }
      return b;
    };

    const ctx = { buckets, cash: 0, getBucket };
    const sumFunds = () => buckets.reduce((a, b) => a + b.val, 0);
    const sumVal = () => sumFunds() + ctx.cash;
    const sumPrice = () => buckets.reduce((a, b) => a + b.priceVal, 0) + ctx.cash;

    const snapshotNow = (yr) => {
      // Agrupa por fundId|kind para el resumen del modal
      const byKey = new Map();
      for (const b of buckets) {
        if (!(b.val > 0.5)) continue;
        const k = `${b.fundId}|${b.kind}`;
        const prev = byKey.get(k);
        if (prev) prev.val += b.val;
        else
          byKey.set(k, {
            fundId: b.fundId,
            name: b.fund.name,
            kind: b.kind,
            provId: b.provId,
            val: b.val,
          });
      }
      return {
        year: yr,
        cash: ctx.cash,
        total: sumVal(),
        holdings: [...byKey.values()].sort((a, b) => b.val - a.val),
      };
    };

    const bucketParams = (b, ph, infl, brk, tau, dTax) => {
      const baseR = (rates[b.fundId] ?? b.fund.fallback) - b.ter / 100;
      let drag = 0,
        realize = 0;
      if (ph.alloc && b.fundId in ph.alloc) {
        const mvc = movesOf(ph, b.fund);
        if (
          mvc?.taxed &&
          mvc.mode !== "total" &&
          mvc.perYear > 0 &&
          mvc.pct > 0
        ) {
          const mv = moveDrag(baseR, (mvc.perYear * mvc.pct) / 100, tau);
          drag = mv.drag;
          realize = mv.realize * (1 - tau);
        }
      }
      const priceR = baseR - drag - brk;
      const divR = (b.fund.yield / 100) * (1 - dTax);
      const totalR = priceR + divR;
      return {
        mP: Math.pow(Math.max(1e-6, (1 + priceR) / (1 + infl)), 1 / 12) - 1,
        mT: Math.pow(Math.max(1e-6, (1 + totalR) / (1 + infl)), 1 / 12) - 1,
        dM: Math.max(0, divR / 12) + realize / 12,
      };
    };

    const firstInvPhase = invItems.find((x) => !x.isOp)?.phase;
    const init0 = Math.max(0, Number(firstInvPhase?.initial) || 0);
    let initApplied = false;

    const invested = [init0],
      price = [init0],
      total = [init0],
      cashSeries = [0],
      nominal = [init0],
      decline = [],
      nominalDecline = [],
      transitions = [],
      opMarkers = [],
      issues = Object.create(null),
      opSnapshots = Object.create(null);

    let inv = init0,
      cumInfl = 1,
      y = 0,
      depleted = null,
      unfundedYear = null,
      realProd = 1,
      realMonths = 0,
      lastInvNeeds = 0,
      lastInvLeisure = 0,
      invPhaseCount = 0;

    // 1) Fase de acumulación: recorre en orden tramos y operaciones de «Invertir»
    for (const entry of invItems) {
      if (entry.isOp) {
        const op = entry.op;
        opSnapshots[op.id] = snapshotNow(y);
        const err = runOperation(op, ctx, baseTaxDef, T);
        if (err) issues[op.id] = err;
        opMarkers.push({
          year: y,
          id: op.id,
          group: "invest",
          op: op.op,
          label: App.advanced?.opChartLabel
            ? App.advanced.opChartLabel(op)
            : op.op,
          err,
        });
        // Refleja el impacto fiscal de la operación en el punto actual de la curva
        const curTot = sumVal();
        total[y] = curTot;
        price[y] = sumPrice();
        cashSeries[y] = ctx.cash;
        nominal[y] = curTot * cumInfl;
        continue;
      }

      const ph = entry.phase;
      const idx = invPhaseCount++;
      const phYears = Math.max(1, Math.round(Number(ph.years) || 1));
      transitions.push({
        year: y,
        group: "invest",
        id: ph.id,
        label: ph.label || String(idx + 1),
      });

      const nv = normInvestValues(ph);
      lastInvNeeds = nv.needs;
      lastInvLeisure = nv.leisure;
      const phInvest = nv.invest;
      const targets = phaseTargets(ph).map((t) => ({
        ...t,
        bucket: getBucket(t.fund, t.prov),
      }));

      // Capital inicial en el primer tramo o aportación puntual al inicio de tramos 2+
      if (!initApplied) {
        initApplied = true;
        if (init0 > 0) {
          for (const t of targets) {
            const amt = init0 * t.weight;
            t.bucket.val += amt;
            t.bucket.priceVal += amt;
            t.bucket.basis += amt;
          }
        }
      } else if (Number(ph.initial) > 0) {
        const extra = Number(ph.initial);
        inv += extra;
        for (const t of targets) {
          const amt = extra * t.weight;
          t.bucket.val += amt;
          t.bucket.priceVal += amt;
          t.bucket.basis += amt;
        }
      }

      const infl = (Number(ph.inflation) || 0) / 100;
      const infM = Math.pow(1 + infl, 1 / 12);
      const brk = (Number(ph.brokerFee) || 0) / 100;
      const tau = T.moveTau(baseTaxDef),
        dTax = T.divTax(baseTaxDef);
      const bParams = buckets.map((b) =>
        bucketParams(b, ph, infl, brk, tau, dTax),
      );
      const evAt = buildPhaseBucketMoves(ph, phYears * 12);

      for (let py = 0; py < phYears; py++) {
        for (let k = 0; k < 12; k++) {
          let wSum = ctx.cash,
            wRet = ctx.cash * (1 / infM - 1);
          if (ctx.cash > 0) ctx.cash = ctx.cash / infM;
          for (let bi = 0; bi < buckets.length; bi++) {
            const b = buckets[bi],
              bp = bParams[bi];
            if (b.val > 0) {
              wSum += b.val;
              wRet += b.val * bp.mT;
              b.basis = b.basis / infM + b.val * bp.dM;
              b.priceVal = b.priceVal * (1 + bp.mP);
              b.val = b.val * (1 + bp.mT);
            }
          }
          if (phInvest > 0) {
            inv += phInvest;
            for (const t of targets) {
              const amt = phInvest * t.weight;
              t.bucket.val += amt;
              t.bucket.priceVal += amt;
              t.bucket.basis += amt;
            }
          }
          if (wSum > 0) {
            realProd *= Math.max(1e-6, 1 + wRet / wSum);
            realMonths++;
          }
          const mvList = evAt?.[py * 12 + k];
          if (mvList) applyScheduledMoves(buckets, mvList, baseTaxDef, T);
        }
        cumInfl *= 1 + infl;
        const tot = sumVal();
        invested.push(inv);
        price.push(sumPrice());
        total.push(tot);
        cashSeries.push(ctx.cash);
        nominal.push(tot * cumInfl);
        decline.push(false);
        nominalDecline.push(false);
        y++;
      }
    }

    opSnapshots["end:invest"] = snapshotNow(y);

    const work = y;
    const capital = sumVal();
    const retireStartInfl = cumInfl;
    let firstSpend = 0,
      firstNet = 0,
      firstQ0 = 0,
      activeInfo = null,
      spdPhaseCount = 0;

    // Calcula la fracción real de ganancia de los fondos concretos seleccionados en el tramo de gasto
    const estimateGainShare = (phTargets, estGross) => {
      const { taken, totalTaken } = withdrawBucketsStrict(
        buckets,
        phTargets,
        Math.max(1, estGross),
        true,
      );
      if (!(totalTaken > 1e-12)) return 0;
      let gainWeighted = 0;
      for (let i = 0; i < buckets.length; i++) {
        if (!(taken[i] > 0)) continue;
        const b = buckets[i];
        const qB = b.val > 0 ? clamp(1 - b.basis / b.val, 0, 1) : 0;
        gainWeighted += taken[i] * qB;
      }
      return clamp(gainWeighted / totalTaken, 0, 1);
    };

    // 2) Fase de retirada: recorre en orden tramos y operaciones de «Gastar»
    let lastSpendTaxDef = baseTaxDef;
    for (let si = 0; si < spdItems.length; si++) {
      const entry = spdItems[si];
      if (entry.isOp) {
        const op = entry.op;
        const nextPhase = spdItems.slice(si + 1).find((x) => !x.isOp)?.phase;
        const opTaxDef = nextPhase ? T.resolve(nextPhase.tax) : lastSpendTaxDef;
        opSnapshots[op.id] = snapshotNow(y);
        const err = runOperation(op, ctx, opTaxDef, T);
        if (err) issues[op.id] = err;
        opMarkers.push({
          year: y,
          id: op.id,
          group: "spend",
          op: op.op,
          label: App.advanced?.opChartLabel
            ? App.advanced.opChartLabel(op)
            : op.op,
          err,
        });
        const curTot = sumVal();
        total[y] = curTot;
        cashSeries[y] = ctx.cash;
        nominal[y] = curTot * cumInfl;
        continue;
      }

      const ph = entry.phase;
      const idx = spdPhaseCount++;
      const phYears = Math.max(1, Math.round(Number(ph.years) || 1));
      transitions.push({
        year: y,
        group: "spend",
        id: ph.id,
        label: ph.label || String(idx + 1),
      });

      const targets = phaseTargets(ph);
      const infl = (Number(ph.inflation) || 0) / 100;
      const infM = Math.pow(1 + infl, 1 / 12);
      const brk = (Number(ph.brokerFee) || 0) / 100;
      const taxDef = T.resolve(ph.tax);
      lastSpendTaxDef = taxDef;
      const tau = T.moveTau(taxDef),
        dTax = T.divTax(taxDef);
      const gross = T.grossFn(taxDef);
      const useCash = ph.useCash !== false;
      const bParams = buckets.map((b) =>
        bucketParams(b, ph, infl, brk, tau, dTax),
      );
      const evAt = buildPhaseBucketMoves(ph, phYears * 12);

      let phNet;
      if (ph.retLinked) {
        phNet = lastInvNeeds + lastInvLeisure;
      } else if (ph.retBasis === "gross" && ph.retGross != null) {
        const annCashEst = useCash ? Math.min(ctx.cash, ph.retGross * 12) : 0;
        const annFundGross = Math.max(0, ph.retGross * 12 - annCashEst);
        const qStart = estimateGainShare(targets, annFundGross);
        phNet =
          (annCashEst +
            (annFundGross > 0 ? T.netOf(taxDef, annFundGross, qStart) : 0)) /
          12;
      } else {
        phNet =
          Math.max(0, Number(ph.retNeeds) || 0) +
          Math.max(0, Number(ph.retLeisure) || 0);
      }

      // Validación estricta al inicio del tramo: comprueba si los fondos elegidos tienen saldo
      if (phNet > 0) {
        const missing = [];
        for (const t of targets) {
          const hasExact = buckets.some(
            (b) => b.fundId === t.fund.id && b.kind === t.kind && b.val > 1e-3,
          );
          if (!hasExact) {
            const otherKind = t.kind === "etf" ? "index" : "etf";
            const hasOther = buckets.some(
              (b) =>
                b.fundId === t.fund.id && b.kind === otherKind && b.val > 1e-3,
            );
            missing.push(
              hasOther
                ? `${t.fund.name} (${kindLabel(t.kind)}; lo tienes como ${kindLabel(otherKind)})`
                : `${t.fund.name} (${kindLabel(t.kind)})`,
            );
          }
        }
        // Si todos los fondos elegidos faltan (y el efectivo no cubre el tramo entero) o falta alguno explícitamente pedido
        if (missing.length) {
          const totalNeeded = phNet * 12 * phYears;
          if (!(useCash && ctx.cash >= totalNeeded * 0.999)) {
            issues[ph.id] = `No tienes saldo en ${missing.join(", ")} en este punto de la línea temporal.`;
          }
        }
      }

      const startYear = y;
      const startInfl = cumInfl;

      for (let py = 0; py < phYears; py++) {
        const startT = sumVal(),
          startNom = nominal[y];
        const annCashAvail = useCash ? Math.min(ctx.cash, phNet * 12) : 0;
        const annFundNet = Math.max(0, phNet * 12 - annCashAvail);
        let q = estimateGainShare(targets, annFundNet);
        let annFundGross = annFundNet > 0 ? gross(annFundNet, q) : 0;
        if (Math.abs(annFundGross - annFundNet) > 1) {
          q = estimateGainShare(targets, annFundGross);
          annFundGross = annFundNet > 0 ? gross(annFundNet, q) : 0;
        }
        const grossRatio = annFundNet > 0 ? annFundGross / annFundNet : 1;
        const spend = (annCashAvail + annFundGross) / 12;

        if (py === 0) {
          if (idx === 0) {
            firstSpend = spend;
            firstNet = phNet;
            firstQ0 = q;
          }
          if (
            s.advanced.activeGroup === "spend" &&
            s.advanced.activeId === ph.id
          ) {
            activeInfo = {
              spend,
              net: phNet,
              q0: q,
              startYear,
              startInfl,
            };
          }
        }

        let yearShortfall = 0;
        for (let k = 0; k < 12; k++) {
          let wSum = ctx.cash,
            wRet = ctx.cash * (1 / infM - 1);
          if (ctx.cash > 0) ctx.cash = ctx.cash / infM;
          for (let bi = 0; bi < buckets.length; bi++) {
            const b = buckets[bi],
              bp = bParams[bi];
            if (b.val > 0) {
              wSum += b.val;
              wRet += b.val * bp.mT;
              b.basis = b.basis / infM + b.val * bp.dM;
              b.val = b.val * (1 + bp.mT);
            }
          }
          if (wSum > 0) {
            realProd *= Math.max(1e-6, 1 + wRet / wSum);
            realMonths++;
          }
          if (phNet > 0) {
            let remNet = phNet;
            if (useCash && ctx.cash > 1e-6) {
              const fromCash = Math.min(ctx.cash, remNet);
              ctx.cash = Math.max(0, ctx.cash - fromCash);
              remNet -= fromCash;
            }
            if (remNet > 1e-6) {
              const reqGross = remNet * grossRatio;
              const wr = withdrawBucketsStrict(buckets, targets, reqGross, false);
              if (wr.shortfall > 0.5) yearShortfall += wr.shortfall;
            }
          }
          const mvList = evAt?.[py * 12 + k];
          if (mvList) applyScheduledMoves(buckets, mvList, taxDef, T);
        }

        if (yearShortfall > 1) {
          if (unfundedYear === null) unfundedYear = y + 1;
          if (!issues[ph.id]) {
            const names = targets
              .map((t) => `${t.fund.name} (${kindLabel(t.kind)})`)
              .join(", ");
            issues[ph.id] = `Los fondos seleccionados (${names}) se agotan en el año ${y + 1}. Añade una operación para mover capital o selecciona otros fondos.`;
          }
        }

        cumInfl *= 1 + infl;
        const tot = sumVal();
        const nom = tot * cumInfl;
        invested.push(inv);
        price.push(null);
        total.push(tot);
        cashSeries.push(ctx.cash);
        nominal.push(nom);
        decline.push(tot < startT * 0.9999);
        nominalDecline.push(nom < startNom * 0.9999);
        if (tot <= 1e-6 && depleted === null) depleted = y + 1;
        y++;
      }
    }

    opSnapshots["end:spend"] = snapshotNow(y);

    const years = y;
    const shown = activeInfo || {
      spend: firstSpend,
      net: firstNet,
      q0: firstQ0,
      startYear: work,
      startInfl: retireStartInfl,
    };
    return {
      years,
      work,
      invested,
      price,
      total,
      cash: cashSeries,
      decline,
      nominal,
      nominalDecline,
      depleted,
      unfundedYear,
      capital,
      spend: shown.spend,
      net: shown.net,
      q0: shown.q0,
      activeStartYear: shown.startYear,
      activeStartInfl: shown.startInfl,
      transitions,
      opMarkers,
      issues,
      opSnapshots,
      withdrawalRate: capital > 0 ? (firstSpend * 12) / capital : Infinity,
      realReturn:
        realMonths > 0 ? Math.pow(realProd, 12 / realMonths) - 1 : 0,
    };
  }

  function simulate(s, p) {
    if (s.advancedMode && p?.adv) return simulateAdvanced(s, p);
    const infl = s.inflation / 100,
      infM = Math.pow(1 + infl, 1 / 12); // inflación mensual
    const m = (r) => Math.pow((1 + r) / (1 + infl), 1 / 12) - 1; // tasa mensual real
    const mP = m(p.price),
      mT = m(p.total),
      dM = Math.max(0, (p.total - p.price) / 12) + (p.realize || 0) / 12; // dM: dividendos (ya con impuestos) que se reinvierten
    const T = App.taxes,
      def = T.resolve(s.tax),
      gross = T.grossFn(def),
      net = s.retNeeds + s.retLeisure;
    const evAt = buildMoveSchedule(p.events, s.workYears * 12);
    const grossAt = (q) => (net > 0 ? gross(net * 12, q) / 12 : 0); // bruto mensual que hay que sacar para cobrar `net` tras impuestos
    const gainShare = (t, b) => (t > 0 ? clamp(1 - b / t, 0, 1) : 0); // parte del capital que es ganancia (coste medio)
    const years = s.workYears + s.retireYears;
    const invested = [s.initial],
      price = [s.initial],
      total = [s.initial],
      decline = [];
    let depleted = null,
      basis = s.initial,
      spend = 0,
      first = 0,
      q0 = 0; // basis: lo aportado (coste), en € de hoy: la inflación lo va "gastando"
    for (let y = 0; y < years; y++) {
      let i = invested[y],
        pr = price[y],
        t = total[y];
      const start = t,
        working = y < s.workYears;
      if (!working) {
        // cada año se recalcula el bruto según cuánta ganancia haya en el capital
        const q = gainShare(t, basis);
        spend = grossAt(q);
        if (y === s.workYears) {
          first = spend;
          q0 = q;
        }
      }
      for (let k = 0; k < 12; k++) {
        if (working) {
          basis = basis / infM + s.invest + t * dM;
          pr = pr * (1 + mP) + s.invest;
          t = t * (1 + mT) + s.invest;
          i += s.invest;
          const frac = evAt?.[y * 12 + k];
          if (frac > 0 && t > 0) {
            const gain = Math.max(0, t - basis) * frac;
            const tax = gain > 0 ? T.calc(def, gain).tax : 0;
            const ratio = Math.max(0, (t - tax) / t);
            pr *= ratio;
            basis = basis * (1 - frac) + Math.max(0, t * frac - tax);
            t = Math.max(0, t - tax);
          }
        } else {
          const tb = t * (1 + mT);
          basis = basis / infM + t * dM;
          t = Math.max(0, tb - spend);
          basis = tb > 0 ? basis * (t / tb) : 0;
        }
      }
      invested.push(i);
      price.push(working ? pr : null);
      total.push(t);
      decline.push(!working && t < start * 0.9999);
      if (!working && t === 0 && depleted === null) depleted = y + 1;
    }
    const capital = total[s.workYears];
    // Mismo plan sin descontar la inflación: lo que marcaría la cuenta en euros "de cada año" (nominales).
    let f = 1;
    const nominal = total.map((t) => {
      const v = t * f;
      f *= 1 + infl;
      return v;
    });
    const nominalDecline = decline.map(
      (_, y) => y >= s.workYears && nominal[y + 1] < nominal[y] * 0.9999,
    );
    return {
      years,
      work: s.workYears,
      invested,
      price,
      total,
      decline,
      nominal,
      nominalDecline,
      depleted,
      capital,
      spend: first,
      net,
      q0, // spend = bruto mensual el primer año de jubilación; net = lo que cobras tras impuestos
      withdrawalRate: capital > 0 ? (first * 12) / capital : Infinity,
      realReturn: (1 + p.total) / (1 + infl) - 1,
    };
  }

  /** Menor nº de años trabajando (1-60) para el que la simulación cumple `ok`. Trabajar más años nunca empeora el capital de un plan con
   *  rentabilidad real positiva, así que `ok` es creciente y basta una búsqueda binaria (≈7 simulaciones en vez de hasta 60). */
  function earliest(s, p, ok) {
    const at = (w) => ok(simulate({ ...s, workYears: w }, p));
    if (at(1)) return 1;
    if (!at(60)) return null;
    let lo = 1,
      hi = 60; // at(lo) falso, at(hi) cierto
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  // Niveles según la nota: 50 × probabilidad de quedarte sin dinero + hasta otros 50 según lo pronto que se agota
  const LEVELS = [
    [5, "Muy bajo", "green"],
    [12, "Bajo", "green"],
    [25, "Medio", ""],
    [40, "Alto", "orange"],
    [101, "Muy alto", "red"],
  ];

  const rng = (a) => () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (r) => {
    let u = 0;
    while (!u) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };

  /** Prepara la serie mensual recentrada de una cartera o fondo para Monte Carlo. */
  function prepMarket(exp, market, volEst, tailLen = 0) {
    const raw = market?.returns;
    const hist =
      raw && tailLen > 0 && raw.length > tailLen
        ? raw.slice(raw.length - tailLen)
        : raw;
    const L = hist?.length || 0,
      B = Math.min(12, L);
    const target = Math.pow(1 + exp, 1 / 12) - 1,
      volM = volEst / Math.sqrt(12);
    let adj = null;
    if (L) {
      const mean = hist.reduce((a, x) => a + x, 0) / L,
        varM =
          L > 1 ? hist.reduce((a, x) => a + (x - mean) ** 2, 0) / (L - 1) : 0;
      adj = Float64Array.from(hist, (x) => x - mean + target + varM / 2);
    }
    return { L, B, adj, target, volM };
  }

  /**
   * Monte Carlo (semilla fija → resultado estable). Cada simulación remuestrea por bloques de 12 meses la historia REAL
   * de la cartera (conserva rachas y caídas), recentrada para que su rentabilidad COMPUESTA sea la esperada (la media aritmética
   * mensual debe ser la geométrica + varianza/2; si no, el remuestreo rendiría ≈σ²/2 menos de lo previsto), y sortea la inflación
   * de cada año con su variación histórica real. Devuelve la probabilidad de agotar el dinero y lo pronto que ocurre.
   */
  function monteCarlo(
    s,
    exp,
    market,
    infl,
    volEst,
    divM,
    runs = 300,
    events = null,
  ) {
    const rand = rng(20261107);
    const { L, B, adj, target, volM } = prepMarket(exp, market, volEst);
    const workM = s.workYears * 12,
      totalM = workM + s.retireYears * 12;
    const T = App.taxes,
      def = T.resolve(s.tax),
      gross = T.grossFn(def),
      net = s.retNeeds + s.retLeisure;
    const evAt = buildMoveSchedule(events, workM);
    let fails = 0,
      early = 0;
    for (let k = 0; k < runs; k++) {
      let w = s.initial,
        basis = s.initial,
        spend = 0,
        idx = 0,
        left = 0,
        invInf = 1; // basis: coste de lo aportado (€ de hoy)
      for (let m = 0; m < totalM; m++) {
        if (m % 12 === 0)
          invInf =
            1 /
            Math.pow(
              1 +
                Math.max(
                  -0.02,
                  s.inflation / 100 + (infl ? infl.sd * gauss(rand) : 0),
                ),
              1 / 12,
            );
        let r;
        if (L) {
          if (left === 0) {
            idx = Math.floor(rand() * (L - B + 1));
            left = B;
          }
          r = adj[idx++];
          left--;
        } else r = target + (volM * volM) / 2 + volM * gauss(rand);
        const g = Math.max(-0.99, (1 + r) * invInf - 1);
        if (m < workM) {
          basis = basis * invInf + s.invest + w * divM;
          w = w * (1 + g) + s.invest;
          const frac = evAt?.[m];
          if (frac > 0 && w > 0) {
            const gain = Math.max(0, w - basis) * frac;
            const tax = gain > 0 ? T.calc(def, gain).tax : 0;
            basis = basis * (1 - frac) + Math.max(0, w * frac - tax);
            w = Math.max(0, w - tax);
          }
        } else {
          if ((m - workM) % 12 === 0)
            spend =
              net > 0
                ? gross(net * 12, w > 0 ? clamp(1 - basis / w, 0, 1) : 0) / 12
                : 0; // bruto del año según la ganancia acumulada
          const wb = w * (1 + g);
          basis = basis * invInf + w * divM;
          w = wb - spend;
          if (w <= 0) {
            fails++;
            early += 1 - (m - workM) / (totalM - workM);
            break;
          }
          basis *= w / wb;
        }
      }
    }
    const prob = fails / runs;
    return { prob, score: 50 * prob + 50 * prob * (fails ? early / fails : 0) };
  }

  /** Riesgo multi-tramo por huchas + operaciones + retirada estricta para Modo Avanzado. */
  function riskAdvanced(s, p, rateOf, inputs, runs = 300) {
    const T = App.taxes,
      infl = inputs?.infl || null,
      fm = inputs?.fundMarkets || {},
      pm = inputs?.phaseMarkets || {},
      rates = p.adv.rates || {},
      vt = config.FUNDS.find((f) => f.id === "VT"),
      firstSpd = p.adv.spend.find((x) => !x.isOp)?.phase,
      baseTax = firstSpd?.tax || s.tax,
      baseTaxDef = T.resolve(baseTax);

    // Recolecta todas las huchas (fundId|provId) posibles: de fases de inversión y de operaciones comprar/mover
    const specs = [];
    const specIdx = new Map();
    const ensureSpec = (fund, prov) => {
      const key = `${fund.id}|${prov.id}`;
      let i = specIdx.get(key);
      if (i == null) {
        i = specs.length;
        specIdx.set(key, i);
        specs.push({
          key,
          fundId: fund.id,
          provId: prov.id,
          kind: prov.kind,
          fund,
          ter: prov.ter,
        });
      }
      return i;
    };
    for (const entry of [...p.adv.invest, ...p.adv.spend]) {
      if (entry.isOp) {
        if (entry.op.op === "buy" || entry.op.op === "move") {
          const d = opDestProvider(entry.op);
          if (d) ensureSpec(d.fund, d.prov);
        }
      } else if (p.adv.invest.includes(entry)) {
        phaseTargets(entry.phase).forEach((t) => ensureSpec(t.fund, t.prov));
      }
    }

    const lengths = specs
      .map((sp) => fm[sp.fundId]?.returns?.length || 0)
      .filter((l) => l > 0);
    const commonL = lengths.length ? Math.min(...lengths) : 0;
    const B = Math.min(12, commonL);

    const worldOf = (brokerFee, tax) =>
      evalPortfolio(
        {
          ...s,
          brokerFee,
          tax,
          alloc: { VT: 100 },
          prov: vt ? { VT: cheapest(vt).id } : {},
          fundCfg: {},
        },
        rateOf,
      ).total;

    const buildPhaseSeries = (ph, taxDef) => {
      const brk = (Number(ph.brokerFee) || 0) / 100;
      const tau = T.moveTau(taxDef),
        dTax = T.divTax(taxDef);
      const world = worldOf(ph.brokerFee, ph.tax || baseTax);
      let anyCapped = false;
      const list = specs.map((sp) => {
        const baseR = (rates[sp.fundId] ?? sp.fund.fallback) - sp.ter / 100;
        let drag = 0,
          realize = 0;
        if (ph.alloc && sp.fundId in ph.alloc) {
          const mvc = movesOf(ph, sp.fund);
          if (
            mvc?.taxed &&
            mvc.mode !== "total" &&
            mvc.perYear > 0 &&
            mvc.pct > 0
          ) {
            const mv = moveDrag(baseR, (mvc.perYear * mvc.pct) / 100, tau);
            drag = mv.drag;
            realize = mv.realize * (1 - tau);
          }
        }
        const divR = (sp.fund.yield / 100) * (1 - dTax);
        const rawTotal = baseR - drag - brk + divR;
        if (rawTotal > world + 1e-9) anyCapped = true;
        const exp = Math.min(rawTotal, world);
        const mkt = fm[sp.fundId] || null;
        return {
          mc: prepMarket(exp, mkt, sp.fund.vol / 100, commonL),
          divM: Math.max(0, divR / 12) + realize / 12,
        };
      });
      return { list, anyCapped };
    };

    let lastInvNeeds = 0,
      lastInvLeisure = 0,
      anyCapped = false,
      invPhaseIdx = 0;

    const invSteps = p.adv.invest.map((entry) => {
      if (entry.isOp) return { isOp: true, op: entry.op, taxDef: baseTaxDef };
      const ph = entry.phase,
        port = entry.port,
        idx = invPhaseIdx++;
      const years = Math.max(1, Math.round(Number(ph.years) || 1));
      const months = years * 12;
      const nv = normInvestValues(ph);
      lastInvNeeds = nv.needs;
      lastInvLeisure = nv.leisure;
      const targets = phaseTargets(ph).map((t) => ({
        idx: ensureSpec(t.fund, t.prov),
        weight: t.weight,
      }));
      const ps = buildPhaseSeries(ph, baseTaxDef);
      if (ps.anyCapped) anyCapped = true;
      return {
        isOp: false,
        years,
        months,
        isFirst: idx === 0,
        initial: Math.max(0, Number(ph.initial) || 0),
        invest: nv.invest,
        targets,
        inflBase: (Number(ph.inflation) || 0) / 100,
        series: ps.list,
        evAt: buildPhaseBucketMoves(ph, months),
        taxDef: baseTaxDef,
        exp: Math.min(port.total, worldOf(ph.brokerFee, baseTax)),
        market: pm[ph.id] || null,
        volEst: port.vol / 100,
      };
    });

    let lastSpdTaxDef = baseTaxDef;
    const spdSteps = p.adv.spend.map((entry, si) => {
      if (entry.isOp) {
        const nextP = p.adv.spend.slice(si + 1).find((x) => !x.isOp)?.phase;
        return {
          isOp: true,
          op: entry.op,
          taxDef: nextP ? T.resolve(nextP.tax) : lastSpdTaxDef,
        };
      }
      const ph = entry.phase,
        port = entry.port;
      const years = Math.max(1, Math.round(Number(ph.years) || 1));
      const months = years * 12;
      const taxDef = T.resolve(ph.tax);
      lastSpdTaxDef = taxDef;
      const targets = phaseTargets(ph);
      const ps = buildPhaseSeries(ph, taxDef);
      if (ps.anyCapped) anyCapped = true;
      return {
        isOp: false,
        years,
        months,
        phase: ph,
        targets,
        useCash: ph.useCash !== false,
        inflBase: (Number(ph.inflation) || 0) / 100,
        series: ps.list,
        evAt: buildPhaseBucketMoves(ph, months),
        taxDef,
        gross: T.grossFn(taxDef),
        linkedNet: lastInvNeeds + lastInvLeisure,
        exp: Math.min(port.total, worldOf(ph.brokerFee, ph.tax)),
        market: pm[ph.id] || null,
        volEst: port.vol / 100,
      };
    });

    const totalSpendM =
      spdSteps.reduce((a, x) => a + (x.isOp ? 0 : x.months), 0) || 1;
    const rand = rng(20261107);
    let fails = 0,
      early = 0;

    // Contenedores reutilizados en cada pasada del Monte Carlo
    const simBuckets = specs.map((sp) => ({
      fundId: sp.fundId,
      provId: sp.provId,
      kind: sp.kind,
      val: 0,
      priceVal: 0,
      basis: 0,
    }));
    const simCtx = {
      buckets: simBuckets,
      cash: 0,
      getBucket(fund, prov) {
        const key = `${fund.id}|${prov.id}`;
        const idx = specIdx.get(key);
        return simBuckets[idx];
      },
    };

    const simGainShare = (targets, estGross) => {
      const { taken, totalTaken } = withdrawBucketsStrict(
        simBuckets,
        targets,
        Math.max(1, estGross),
        true,
      );
      if (!(totalTaken > 1e-12)) return 0;
      let gw = 0;
      for (let i = 0; i < simBuckets.length; i++) {
        if (!(taken[i] > 0)) continue;
        const b = simBuckets[i];
        gw += taken[i] * (b.val > 0 ? clamp(1 - b.basis / b.val, 0, 1) : 0);
      }
      return clamp(gw / totalTaken, 0, 1);
    };

    for (let k = 0; k < runs; k++) {
      for (let i = 0; i < simBuckets.length; i++) {
        simBuckets[i].val = 0;
        simBuckets[i].priceVal = 0;
        simBuckets[i].basis = 0;
      }
      simCtx.cash = 0;

      let failed = false,
        spendElapsed = 0,
        idx = 0,
        left = 0;

      const nextBlockIdx = () => {
        if (!commonL) return -1;
        if (left === 0) {
          idx = Math.floor(rand() * (commonL - B + 1));
          left = B;
        }
        left--;
        return idx++;
      };

      for (const st of invSteps) {
        if (st.isOp) {
          runOperation(st.op, simCtx, st.taxDef, T);
          continue;
        }
        if (st.initial > 0) {
          for (const t of st.targets) {
            const amt = st.initial * t.weight;
            simBuckets[t.idx].val += amt;
            simBuckets[t.idx].basis += amt;
          }
        }
        let invInf = 1;
        for (let m = 0; m < st.months; m++) {
          if (m % 12 === 0)
            invInf =
              1 /
              Math.pow(
                1 +
                  Math.max(
                    -0.02,
                    st.inflBase + (infl ? infl.sd * gauss(rand) : 0),
                  ),
                1 / 12,
              );
          if (simCtx.cash > 0) simCtx.cash *= invInf;
          const mi = nextBlockIdx();
          for (let bi = 0; bi < simBuckets.length; bi++) {
            const b = simBuckets[bi];
            if (!(b.val > 0)) continue;
            const sr = st.series[bi],
              mc = sr.mc;
            const r =
              mc.adj && mi >= 0
                ? mc.adj[mi]
                : mc.target + (mc.volM * mc.volM) / 2 + mc.volM * gauss(rand);
            const g = Math.max(-0.99, (1 + r) * invInf - 1);
            b.basis = b.basis * invInf + b.val * sr.divM;
            b.val = b.val * (1 + g);
          }
          if (st.invest > 0) {
            for (const t of st.targets) {
              const amt = st.invest * t.weight;
              simBuckets[t.idx].val += amt;
              simBuckets[t.idx].basis += amt;
            }
          }
          const mvList = st.evAt?.[m];
          if (mvList) applyScheduledMoves(simBuckets, mvList, st.taxDef, T);
        }
      }

      for (const st of spdSteps) {
        if (failed) break;
        if (st.isOp) {
          runOperation(st.op, simCtx, st.taxDef, T);
          continue;
        }
        const ph = st.phase;
        let phNet;
        if (ph.retLinked) phNet = st.linkedNet;
        else if (ph.retBasis === "gross" && ph.retGross != null) {
          const annC = st.useCash ? Math.min(simCtx.cash, ph.retGross * 12) : 0;
          const annFG = Math.max(0, ph.retGross * 12 - annC);
          const q0 = simGainShare(st.targets, annFG);
          phNet = (annC + (annFG > 0 ? T.netOf(st.taxDef, annFG, q0) : 0)) / 12;
        } else {
          phNet =
            Math.max(0, Number(ph.retNeeds) || 0) +
            Math.max(0, Number(ph.retLeisure) || 0);
        }
        let invInf = 1,
          grossRatio = 1;
        for (let m = 0; m < st.months; m++) {
          if (m % 12 === 0) {
            invInf =
              1 /
              Math.pow(
                1 +
                  Math.max(
                    -0.02,
                    st.inflBase + (infl ? infl.sd * gauss(rand) : 0),
                  ),
                1 / 12,
              );
            const annC = st.useCash ? Math.min(simCtx.cash, phNet * 12) : 0;
            const annFN = Math.max(0, phNet * 12 - annC);
            const q = simGainShare(st.targets, annFN);
            const annFG = annFN > 0 ? st.gross(annFN, q) : 0;
            grossRatio = annFN > 0 ? annFG / annFN : 1;
          }
          if (simCtx.cash > 0) simCtx.cash *= invInf;
          const mi = nextBlockIdx();
          for (let bi = 0; bi < simBuckets.length; bi++) {
            const b = simBuckets[bi];
            if (!(b.val > 0)) continue;
            const sr = st.series[bi],
              mc = sr.mc;
            const r =
              mc.adj && mi >= 0
                ? mc.adj[mi]
                : mc.target + (mc.volM * mc.volM) / 2 + mc.volM * gauss(rand);
            const g = Math.max(-0.99, (1 + r) * invInf - 1);
            b.basis = b.basis * invInf + b.val * sr.divM;
            b.val = b.val * (1 + g);
          }
          if (phNet > 0) {
            let remNet = phNet;
            if (st.useCash && simCtx.cash > 1e-6) {
              const fromCash = Math.min(simCtx.cash, remNet);
              simCtx.cash = Math.max(0, simCtx.cash - fromCash);
              remNet -= fromCash;
            }
            if (remNet > 1e-6) {
              const wr = withdrawBucketsStrict(
                simBuckets,
                st.targets,
                remNet * grossRatio,
                false,
              );
              if (wr.shortfall > 0.5) {
                fails++;
                early += 1 - spendElapsed / totalSpendM;
                failed = true;
                break;
              }
            }
          }
          const mvList = st.evAt?.[m];
          if (mvList) applyScheduledMoves(simBuckets, mvList, st.taxDef, T);
          spendElapsed++;
        }
      }
    }

    const prob = fails / runs;
    const score = Math.round(
      50 * prob + 50 * prob * (fails ? early / fails : 0),
    );
    const [, level, color] = LEVELS.find((l) => score < l[0]);
    const all = [...invSteps, ...spdSteps].filter((x) => !x.isOp);
    const totalY = all.reduce((a, x) => a + x.years, 0) || 1;
    const withM = all.filter((x) => x.market);
    return {
      score,
      level,
      color,
      prob,
      exp: all.reduce((a, x) => a + x.exp * x.years, 0) / totalY,
      capped: anyCapped,
      vol:
        all.reduce(
          (a, x) => a + (x.market ? x.market.vol : x.volEst) * x.years,
          0,
        ) / totalY,
      maxDD: withM.length
        ? Math.max(...withM.map((x) => x.market.maxDD))
        : null,
      divRatio: withM.length
        ? withM.reduce((a, x) => a + x.market.divRatio * x.years, 0) /
          withM.reduce((a, x) => a + x.years, 0)
        : null,
      histYears: commonL
        ? commonL / 12
        : withM.length
          ? Math.min(...withM.map((x) => x.market.years))
          : null,
      inflSd: infl ? infl.sd : null,
      inflYears: infl ? infl.years : null,
    };
  }

  /**
   * Riesgo del plan (0-100) con datos calculados: histórico real de tus fondos (volatilidad, caídas, correlaciones),
   * variación histórica de la inflación y tus entradas/salidas de dinero antes y después de jubilarte.
   * La rentabilidad esperada se limita a la del mercado global (con su gestor más barato, para no recortar a quien ya lo usa)
   * para no premiar a un fondo solo por su rentabilidad pasada.
   */
  function risk(s, p, rateOf, inputs) {
    if (s.advancedMode && p?.adv) return riskAdvanced(s, p, rateOf, inputs);
    const market = inputs?.market || null,
      infl = inputs?.infl || null,
      vt = config.FUNDS.find((f) => f.id === "VT");
    const world = evalPortfolio(
      {
        ...s,
        alloc: { VT: 100 },
        prov: vt ? { VT: cheapest(vt).id } : {},
        fundCfg: {},
      },
      rateOf,
    ).total;
    const exp = Math.min(p.total, world),
      volEst = p.vol / 100;
    const mc = monteCarlo(
      s,
      exp,
      market,
      infl,
      volEst,
      (p.total - p.price) / 12 + (p.realize || 0) / 12,
      300,
      p.events,
    );
    const score = Math.round(mc.score);
    const [, level, color] = LEVELS.find((l) => score < l[0]);
    return {
      score,
      level,
      color,
      prob: mc.prob,
      exp,
      capped: p.total > world + 1e-9,
      vol: market ? market.vol : volEst,
      maxDD: market ? market.maxDD : null,
      divRatio: market ? market.divRatio : null,
      histYears: market ? market.years : null,
      inflSd: infl ? infl.sd : null,
      inflYears: infl ? infl.years : null,
    };
  }

  /** Estrategias: planes COMPLETOS (fondos, gestores, reparto, ahorro y retirada) calculados siempre desde `base`. */
  function strategies(base, rateOf, inputsOf) {
    const useFunds = (ns, alloc) => {
      ns.advancedMode = false; // cada estrategia es un plan estándar completo
      ns.fundCfg = {}; // cada estrategia usa sus fondos sin movimientos ni tipos elegidos por ti
      ns.alloc = structuredClone(alloc);
      ns.prov = Object.fromEntries(
        Object.keys(alloc).map((id) => {
          const f = config.FUNDS.find((x) => x.id === id);
          return [id, cheapest(f, defaultKind(f)).id];
        }),
      ); // gestor más barato del tipo por defecto
    };
    const A = config.STRATEGY_ALLOC;
    const defs = [
      {
        id: "early",
        title: "🏖️ Jubilarte cuanto antes",
        desc: "100 % renta variable global (gestor más barato); dejas de trabajar en cuanto el capital aguanta toda la jubilación.",
        patch(ns) {
          useFunds(ns, A.growth);
          ns.investAuto = true;
          ns.retLinked = true;
          normalize(ns);
          const w = earliest(
            ns,
            portfolio(ns, rateOf),
            (r) => r.depleted === null,
          );
          if (!w) return false;
          ns.workYears = w;
        },
      },
      {
        id: "forever",
        title: "♾️ Capital que nunca baja",
        desc: `Retiras ${config.FOREVER_SPEND} €/mes netos y aun así el capital crece cada año (con inflación).`,
        patch(ns) {
          useFunds(ns, A.growth);
          ns.investAuto = true;
          normalize(ns);
          const spend = Math.max(config.FOREVER_SPEND, ns.needs + ns.leisure),
            share =
              ns.needs + ns.leisure ? ns.needs / (ns.needs + ns.leisure) : 0.7;
          ns.retLinked = false;
          ns.retNeeds = spend * share;
          ns.retLeisure = spend - ns.retNeeds;
          const w = earliest(
            ns,
            portfolio(ns, rateOf),
            (r) => r.depleted === null && !r.decline.some(Boolean),
          );
          if (!w) return false;
          ns.workYears = w;
        },
      },
      {
        id: "grow",
        title: "🚀 Ahorrar más",
        desc: "Recortas un 25 % el ocio y ahorros, lo inviertes todo, 100 % renta variable global y el gestor más barato.",
        patch(ns) {
          useFunds(ns, A.growth);
          ns.leisure *= 0.75;
          ns.leisureWant = ns.leisure;
          ns.touched.leisure = true;
          ns.investAuto = true;
          ns.retLinked = true;
        },
      },
      {
        id: "safe",
        title: "🛡️ Prudente 60/40",
        desc: "60 % renta variable global y 40 % bonos (gestores más baratos): caídas más suaves, pero rinde menos y puede pedirte más años de trabajo o gastar menos.",
        patch(ns) {
          useFunds(ns, A.safe);
          ns.investAuto = true;
          ns.retLinked = true;
        },
      },
    ];
    return defs.map((d) => {
      const ns = structuredClone(base);
      const invPhases = onlyPhases(ns.advanced?.invest);
      const spdPhases = onlyPhases(ns.advanced?.spend);
      if (ns.advancedMode && invPhases.length && spdPhases.length) {
        const lastInv = normInvestValues(invPhases[invPhases.length - 1]);
        ns.net = lastInv.net;
        ns.needs = lastInv.needs;
        ns.leisure = lastInv.leisure;
        ns.initial = invPhases[0].initial;
        ns.workYears = invPhases.reduce((a, x) => a + (x.years || 1), 0);
        ns.retireYears = spdPhases.reduce((a, x) => a + (x.years || 1), 0);
        ns.advancedMode = false;
      }
      const ok = d.patch(ns) !== false;
      normalize(ns);
      if (!ok)
        return {
          id: d.id,
          title: d.title,
          desc: d.desc,
          unavailable: true,
          state: ns,
          risk: null,
          res: null,
        }; // inalcanzable: no hace falta simular ni calcular el riesgo
      const p = portfolio(ns, rateOf),
        res = simulate(ns, p);
      return {
        id: d.id,
        title: d.title,
        desc: d.desc,
        unavailable: false,
        state: ns,
        risk: risk(ns, p, rateOf, inputsOf(ns)),
        res,
      };
    });
  }

  App.finance = {
    normalize,
    averageProfile,
    risk,
    portfolio,
    simulate,
    strategies,
    cheapest,
    providerOf,
    providersOf,
    kindOf,
    defaultKind,
    movesOf,
  };
})((window.App = window.App || {}));