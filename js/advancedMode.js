/* Modo Avanzado (planificación por tramos temporales + operaciones):
   - Gestión de estado por tramos independientes y operaciones (vender, comprar, mover) para «Invertir» y «Gastar».
   - Proyección bidireccional con el estado raíz (syncToState / syncFromState).
   - Componente visual de los recuadros de línea de tiempo (clases tl-* para evitar falsos positivos de bloqueadores de anuncios). */
(function (App) {
    "use strict";
    const { config, taxes } = App;
    const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
    const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    const num = (v, lo, hi, d) =>
        Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

    const GROUP_META = {
        invest: {
            title: "Invertir",
            prefix: "inv",
            minYears: 1,
            maxYears: 50,
            syncClass: "adv-sync-invest",
        },
        spend: {
            title: "Gastar",
            prefix: "spd",
            minYears: 5,
            maxYears: 60,
            syncClass: "adv-sync-spend",
        },
    };

    const SHORT_NAMES = {
        VT: "FTSE",
        ACWI: "ACWI",
        URTH: "World",
        SPY: "S&P500",
        QQQ: "Nasdaq",
        VGK: "Europa",
        EWJ: "Japón",
        VWO: "Em.FTSE",
        EEM: "Em.MSCI",
        AGG: "Bonos",
        JXI: "Util.",
        CLEAN: "Energía",
    };

    const compactEur = new Intl.NumberFormat("es-ES", {
        notation: "compact",
        maximumFractionDigits: 1,
    });

    function h(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null) continue;
            if (k === "class") e.className = v;
            else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v);
        }
        e.append(...kids.filter((x) => x != null));
        return e;
    }

    /* ---------- Utilidades de tramos y operaciones ---------- */
    const isOp = (item) => item?.itemType === "op";
    const phasesOf = (list) =>
        Array.isArray(list) ? list.filter((x) => !isOp(x)) : [];

    function fundShort(id) {
        if (!id) return "?";
        if (SHORT_NAMES[id]) return SHORT_NAMES[id];
        const f = config.FUNDS.find((x) => x.id === id);
        if (!f) return String(id).slice(0, 10);
        return f.name.length > 11 ? f.name.slice(0, 10).trim() + "…" : f.name;
    }

    function defaultKindOfFund(id) {
        const f = config.FUNDS.find((x) => x.id === id);
        if (!f) return "index";
        if (f.custom) return f.kind === "etf" ? "etf" : "index";
        return f.providers.some((p) => p.kind === "index") ? "index" : "etf";
    }

    function defaultProvOfFund(id, kind) {
        const f = config.FUNDS.find((x) => x.id === id);
        if (!f) return "";
        const k = kind || defaultKindOfFund(id);
        const l = f.providers.filter((p) => p.kind === k);
        const pool = l.length ? l : f.providers;
        return pool.reduce((a, b) => (b.ter < a.ter ? b : a)).id;
    }

    /** Regla fiscal por defecto para una operación:
     *  - Vender: tributa.
     *  - Comprar: no tributa.
     *  - Mover: Fondo → Fondo no tributa (diferimiento fiscal); cualquier movimiento con ETF sí tributa. */
    function opTaxDefault(op) {
        if (!op) return false;
        if (op.op === "buy") return false;
        if (op.op === "sell") return true;
        const fk = op.fromKind || defaultKindOfFund(op.fromFund);
        const tk = op.toKind || defaultKindOfFund(op.toFund);
        return !(fk === "index" && tk === "index");
    }

    function cleanOpName(raw) {
        return String(raw ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
    }

    function fmtOpAmount(op) {
        const a = Number(op.amount) || 0;
        if (op.amountMode === "eur") return `${compactEur.format(a)} €`;
        const r = Math.round(a * 10) / 10;
        return `${String(r).replace(".", ",")} %`;
    }

    /** Nombre automático de una operación (usado en la gráfica y como placeholder si el usuario no pone nombre propio). */
    function opAutoChartLabel(op) {
        const amt = fmtOpAmount(op);
        if (op.op === "sell") return `Vender ${amt} ${fundShort(op.fromFund)}`;
        if (op.op === "buy") return `Comprar ${amt} ${fundShort(op.toFund)}`;
        return `Mover ${amt} ${fundShort(op.fromFund)} → ${fundShort(op.toFund)}`;
    }

    /** Etiqueta compacta para la pastilla amarilla de la línea temporal. */
    function opLabel(op) {
        const icon = op.op === "sell" ? "💵" : op.op === "buy" ? "🛒" : "🔁";
        const custom = cleanOpName(op.name);
        if (custom) return `${icon} ${custom}`;
        const amt = fmtOpAmount(op);
        if (op.op === "sell") return `${icon} -${amt} ${fundShort(op.fromFund)}`;
        if (op.op === "buy") return `${icon} +${amt} ${fundShort(op.toFund)}`;
        const pre =
            op.amountMode === "pct" && Number(op.amount) === 100 ? "" : `${amt} `;
        return `${icon} ${pre}${fundShort(op.fromFund)}→${fundShort(op.toFund)}`;
    }

    /** Texto limpio para mostrar en el recuadro de la gráfica (nombre personalizado si existe, o el automático). */
    function opChartLabel(op) {
        return cleanOpName(op.name) || opAutoChartLabel(op);
    }

    function nextId(group, list, kind = "phase") {
        const pre =
            kind === "op"
                ? `op-${GROUP_META[group].prefix}`
                : GROUP_META[group].prefix;
        const used = new Set((list || []).map((p) => p.id));
        let n = (list || []).length + 1;
        while (used.has(`${pre}-${n}`)) n++;
        return `${pre}-${n}`;
    }

    function nextLabel(list) {
        let maxN = 0;
        for (const p of phasesOf(list)) {
            const m = /^\d+$/.exec(String(p.label ?? "").trim());
            if (m) maxN = Math.max(maxN, Number(m[0]));
        }
        return String(Math.max(maxN + 1, phasesOf(list).length + 1));
    }

    function cleanLabel(raw, fallback = "1") {
        const s = String(raw ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
        return s || String(fallback || "1");
    }

    /** Crea un tramo de «Invertir» a partir de un estado o del tramo anterior. */
    function createInvestPhase(src, label = "1", isFirst = true, id = "inv-1") {
        const D = config.DEFAULT_STATE;
        const s = src || D;
        return {
            id,
            itemType: "phase",
            label: cleanLabel(label, "1"),
            years: Math.round(
                clamp(Number(s.years ?? s.workYears ?? D.workYears), 1, 50),
            ),
            net: Math.max(0, Number(s.net ?? D.net)),
            needs: Math.max(0, Number(s.needs ?? D.needs)),
            leisure: Math.max(0, Number(s.leisure ?? D.leisure)),
            invest: Math.max(0, Number(s.invest ?? D.invest)),
            investAuto:
                typeof s.investAuto === "boolean" ? s.investAuto : D.investAuto,
            touched: {
                needs: !!(s.touched && s.touched.needs),
                leisure: !!(s.touched && s.touched.leisure),
            },
            needsWant: Number.isFinite(s.needsWant) ? s.needsWant : null,
            leisureWant: Number.isFinite(s.leisureWant) ? s.leisureWant : null,
            investWant: Number.isFinite(s.investWant) ? s.investWant : null,
            initial: isFirst ? Math.max(0, Number(s.initial ?? D.initial)) : 0,
            inflation: Number.isFinite(s.inflation) ? s.inflation : D.inflation,
            brokerFee: Math.max(0, Number(s.brokerFee ?? D.brokerFee)),
            alloc: structuredClone(
                isObj(s.alloc) && Object.keys(s.alloc).length ? s.alloc : D.alloc,
            ),
            prov: structuredClone(isObj(s.prov) ? s.prov : {}),
            fundCfg: structuredClone(isObj(s.fundCfg) ? s.fundCfg : {}),
        };
    }

    /** Crea un tramo de «Gastar» a partir de un estado o del tramo anterior. */
    function createSpendPhase(src, label = "1", id = "spd-1") {
        const D = config.DEFAULT_STATE;
        const s = src || D;
        return {
            id,
            itemType: "phase",
            label: cleanLabel(label, "1"),
            years: Math.round(
                clamp(Number(s.years ?? s.retireYears ?? D.retireYears), 5, 60),
            ),
            retLinked: typeof s.retLinked === "boolean" ? s.retLinked : D.retLinked,
            retNeeds: Math.max(0, Number(s.retNeeds ?? D.retNeeds)),
            retLeisure: Math.max(0, Number(s.retLeisure ?? D.retLeisure)),
            retBasis: s.retBasis === "gross" ? "gross" : "net",
            retGross:
                Number.isFinite(s.retGross) && s.retGross >= 0 ? s.retGross : null,
            useCash: typeof s.useCash === "boolean" ? s.useCash : true,
            inflation: Number.isFinite(s.inflation) ? s.inflation : D.inflation,
            brokerFee: Math.max(0, Number(s.brokerFee ?? D.brokerFee)),
            alloc: structuredClone(
                isObj(s.alloc) && Object.keys(s.alloc).length ? s.alloc : D.alloc,
            ),
            prov: structuredClone(isObj(s.prov) ? s.prov : {}),
            fundCfg: structuredClone(isObj(s.fundCfg) ? s.fundCfg : {}),
            tax: structuredClone(isObj(s.tax) ? s.tax : D.tax),
        };
    }

    /** Crea una nueva operación (vender, comprar o mover) con valores por defecto coherentes. */
    function createOp(group, list, src = {}) {
        const f0 = config.FUNDS[0]?.id || "VT";
        const f1 = config.FUNDS[1]?.id || f0;
        const opType =
            src.op === "sell" || src.op === "buy" || src.op === "move"
                ? src.op
                : "move";
        const fromFund = src.fromFund || f0;
        const toFund =
            src.toFund || (opType === "move" && fromFund === f0 ? f1 : f0);
        const fromKind =
            src.fromKind === "etf" || src.fromKind === "index"
                ? src.fromKind
                : defaultKindOfFund(fromFund);
        const toKind =
            src.toKind === "etf" || src.toKind === "index"
                ? src.toKind
                : defaultKindOfFund(toFund);
        const amountMode = src.amountMode === "eur" ? "eur" : "pct";
        const amount = Number.isFinite(src.amount)
            ? amountMode === "pct"
                ? clamp(src.amount, 0, 100)
                : clamp(src.amount, 0, 1e9)
            : amountMode === "pct"
                ? 100
                : 10000;
        const out = {
            id: src.id || nextId(group, list, "op"),
            itemType: "op",
            name: cleanOpName(src.name),
            op: opType,
            fromFund,
            fromKind,
            toFund,
            toKind,
            toProv: src.toProv || defaultProvOfFund(toFund, toKind),
            amountMode,
            amount,
            taxed: typeof src.taxed === "boolean" ? src.taxed : null,
        };
        if (out.taxed === null) out.taxed = opTaxDefault(out);
        return out;
    }

    /** Garantiza que state.advanced tenga al menos 1 tramo temporal en cada grupo y un tramo activo válido. */
    function ensure(state) {
        if (!isObj(state.advanced)) {
            state.advanced = {
                activeGroup: "invest",
                activeId: null,
                invest: [],
                spend: [],
            };
        }
        const adv = state.advanced;
        if (!Array.isArray(adv.invest)) adv.invest = [];
        if (!Array.isArray(adv.spend)) adv.spend = [];
        if (!phasesOf(adv.invest).length) {
            adv.invest.unshift(createInvestPhase(state, "1", true, "inv-1"));
        }
        if (!phasesOf(adv.spend).length) {
            adv.spend.unshift(createSpendPhase(state, "1", "spd-1"));
        }
        if (adv.activeGroup !== "invest" && adv.activeGroup !== "spend") {
            adv.activeGroup = "invest";
        }
        const phases = phasesOf(adv[adv.activeGroup]);
        if (!phases.some((p) => p.id === adv.activeId)) {
            adv.activeId = phases[0].id;
        }
        return adv;
    }

    /** Devuelve el tramo temporal activo actual junto con su grupo, índice entre tramos e índice global. */
    function getActive(state) {
        const adv = ensure(state);
        const group = adv.activeGroup;
        const list = adv[group];
        const phases = phasesOf(list);
        const index = Math.max(
            0,
            phases.findIndex((p) => p.id === adv.activeId),
        );
        const phase = phases[index];
        const itemIndex = list.findIndex((x) => x.id === phase.id);
        return { group, list, phases, index, itemIndex, phase };
    }

    /** Proyecta el tramo activo sobre el estado raíz para que los formularios actuales lo muestren. */
    function syncToState(state) {
        const { group, phase } = getActive(state);
        state.brokerFee = phase.brokerFee;
        state.inflation = phase.inflation;
        state.alloc = structuredClone(phase.alloc);
        state.prov = structuredClone(phase.prov);
        state.fundCfg = structuredClone(phase.fundCfg);
        if (group === "invest") {
            state.workYears = phase.years;
            state.net = phase.net;
            state.needs = phase.needs;
            state.leisure = phase.leisure;
            state.invest = phase.invest;
            state.investAuto = phase.investAuto;
            state.touched = structuredClone(phase.touched);
            state.needsWant = phase.needsWant;
            state.leisureWant = phase.leisureWant;
            state.investWant = phase.investWant;
            state.initial = phase.initial;
        } else {
            state.retireYears = phase.years;
            state.retLinked = phase.retLinked;
            state.retNeeds = phase.retNeeds;
            state.retLeisure = phase.retLeisure;
            state.retBasis = phase.retBasis;
            state.retGross = phase.retGross;
            state.tax = structuredClone(phase.tax);
        }
        return phase;
    }

    /** Guarda los valores editados en el estado raíz dentro del tramo activo. */
    function syncFromState(state) {
        if (!state.advancedMode) return null;
        const { group, phase } = getActive(state);
        phase.brokerFee = state.brokerFee;
        phase.inflation = state.inflation;
        phase.alloc = structuredClone(state.alloc);
        phase.prov = structuredClone(state.prov);
        phase.fundCfg = structuredClone(state.fundCfg);
        if (group === "invest") {
            phase.years = state.workYears;
            phase.net = state.net;
            phase.needs = state.needs;
            phase.leisure = state.leisure;
            phase.invest = state.invest;
            phase.investAuto = state.investAuto;
            phase.touched = structuredClone(state.touched);
            phase.needsWant = state.needsWant ?? null;
            phase.leisureWant = state.leisureWant ?? null;
            phase.investWant = state.investWant ?? null;
            phase.initial = state.initial;
        } else {
            phase.years = state.retireYears;
            phase.retLinked = state.retLinked;
            phase.retNeeds = state.retNeeds;
            phase.retLeisure = state.retLeisure;
            phase.retBasis = state.retBasis;
            phase.retGross = state.retGross;
            phase.tax = structuredClone(state.tax);
        }
        return phase;
    }

    /** Selecciona un tramo temporal concreto (o el primero del grupo si no se pasa id) y carga su configuración en el estado raíz. */
    function selectPhase(state, group, id) {
        const adv = ensure(state);
        if (group !== "invest" && group !== "spend") return null;
        const phases = phasesOf(adv[group]);
        const target = (id ? phases.find((p) => p.id === id) : null) || phases[0];
        if (!target) return null;
        if (state.advancedMode) syncFromState(state);
        adv.activeGroup = group;
        adv.activeId = target.id;
        syncToState(state);
        return target;
    }

    /** Añade un nuevo tramo secuencial al grupo indicado y lo selecciona automáticamente. */
    function addPhase(state, group) {
        const adv = ensure(state);
        if (group !== "invest" && group !== "spend") return null;
        if (state.advancedMode) syncFromState(state);
        const list = adv[group];
        const phases = phasesOf(list);
        const base = phases[phases.length - 1] || state;
        const id = nextId(group, list, "phase");
        const label = nextLabel(list);
        const created =
            group === "invest"
                ? createInvestPhase(base, label, false, id)
                : createSpendPhase(base, label, id);
        list.push(created);
        adv.activeGroup = group;
        adv.activeId = created.id;
        syncToState(state);
        return created;
    }

    /** Elimina el tramo temporal indicado (siempre queda al menos 1 tramo temporal por grupo). */
    function removePhase(state, group, id) {
        const adv = ensure(state);
        const list = adv[group];
        const phases = phasesOf(list);
        if (!list || phases.length <= 1) return false;
        const idx = list.findIndex((p) => p.id === id && !isOp(p));
        if (idx < 0) return false;
        if (state.advancedMode) syncFromState(state);
        list.splice(idx, 1);
        if (adv.activeGroup === group && adv.activeId === id) {
            const remPhases = phasesOf(list);
            adv.activeId =
                remPhases[
                    Math.min(
                        Math.max(
                            0,
                            phases.findIndex((p) => p.id === id),
                        ),
                        remPhases.length - 1,
                    )
                ].id;
            syncToState(state);
        }
        return true;
    }

    /** Añade una operación al final de la lista del grupo indicado (Invertir o Gastar). */
    function addOp(state, group, opData) {
        const adv = ensure(state);
        if (group !== "invest" && group !== "spend") return null;
        if (state.advancedMode) syncFromState(state);
        const list = adv[group];
        const created = createOp(group, list, { ...opData, id: null });
        list.push(created);
        return created;
    }

    /** Actualiza una operación existente en el grupo indicado. */
    function updateOp(state, group, id, patch) {
        const adv = ensure(state);
        const list = adv[group];
        if (!list) return null;
        const idx = list.findIndex((x) => x.id === id && isOp(x));
        if (idx < 0) return null;
        list[idx] = createOp(group, list, { ...list[idx], ...patch, id });
        return list[idx];
    }

    /** Elimina una operación por su id. */
    function removeOp(state, group, id) {
        const adv = ensure(state);
        const list = adv[group];
        if (!list) return false;
        const idx = list.findIndex((x) => x.id === id && isOp(x));
        if (idx < 0) return false;
        list.splice(idx, 1);
        return true;
    }

    /** Cambia el nombre visible de un tramo temporal. */
    function renamePhase(state, group, id, value) {
        const adv = ensure(state);
        const p = adv[group]?.find((x) => x.id === id && !isOp(x));
        if (!p) return null;
        p.label = String(value ?? "").slice(0, 40);
        return p;
    }

    /** Reordena cualquier elemento (tramo u operación) dentro de su grupo (Drag & Drop). */
    function reorderItem(state, group, fromIdx, toIdx) {
        const adv = ensure(state);
        const list = adv[group];
        if (
            !list ||
            fromIdx === toIdx ||
            fromIdx < 0 ||
            toIdx < 0 ||
            fromIdx >= list.length ||
            toIdx >= list.length
        )
            return false;
        if (state.advancedMode) syncFromState(state);
        const [moved] = list.splice(fromIdx, 1);
        list.splice(toIdx, 0, moved);
        return true;
    }

    /** Actualiza la duración del tramo activo y la sincroniza con workYears / retireYears. */
    function setActiveYears(state, years) {
        const { group, phase } = getActive(state);
        const meta = GROUP_META[group];
        const v = Math.round(clamp(Number(years), meta.minYears, meta.maxYears));
        if (!Number.isFinite(v)) return null;
        phase.years = v;
        if (group === "invest") state.workYears = v;
        else state.retireYears = v;
        return v;
    }

    /** Valida y limpia un objeto `advanced` guardado o importado (se trata como NO fiable). */
    function clean(src, fallbackState, validFunds) {
        const fb = fallbackState || config.DEFAULT_STATE;
        const funds = validFunds || config.FUNDS;
        const fundById = new Map(funds.map((f) => [f.id, f]));
        const fallbackFund = funds[0]?.id || "VT";

        const cleanAlloc = (a) => {
            const out = {};
            if (isObj(a)) {
                for (const f of funds) {
                    const w = a[f.id];
                    if (Number.isFinite(w)) out[f.id] = clamp(w, 0, 100);
                }
            }
            return Object.keys(out).length
                ? out
                : structuredClone(fb.alloc || config.DEFAULT_STATE.alloc);
        };
        const cleanProv = (pr) => {
            const out = {};
            if (isObj(pr)) {
                for (const f of funds) {
                    const p = pr[f.id];
                    if (typeof p === "string" && f.providers.some((x) => x.id === p))
                        out[f.id] = p;
                }
            }
            return out;
        };
        const cleanCfg = (fc) => {
            const out = {};
            if (!isObj(fc)) return out;
            for (const f of funds.filter((x) => !x.custom)) {
                const c = fc[f.id];
                if (!isObj(c)) continue;
                const o = {};
                if (f.providers.some((p) => p.kind === c.kind)) o.kind = c.kind;
                if (c.moveMode === "year" || c.moveMode === "total")
                    o.moveMode = c.moveMode;
                if (Number.isFinite(c.perYear))
                    o.perYear = Math.round(clamp(c.perYear, 0, 12));
                if (Number.isFinite(c.totalMoves))
                    o.totalMoves = Math.round(clamp(c.totalMoves, 0, 20));
                if (Number.isFinite(c.pct)) o.pct = clamp(c.pct, 0, 100);
                if (typeof c.taxed === "boolean") o.taxed = c.taxed;
                if (Object.keys(o).length) out[f.id] = o;
            }
            return out;
        };

        const cleanOpItem = (p, prefix, seen) => {
            let id =
                typeof p.id === "string" && /^[a-z0-9_-]{2,24}$/i.test(p.id)
                    ? p.id
                    : `op-${prefix}-${seen.size + 1}`;
            while (seen.has(id)) id = `op-${prefix}-${seen.size + 1}`;
            seen.add(id);
            const opType =
                p.op === "sell" || p.op === "buy" || p.op === "move" ? p.op : "move";
            const fromF = fundById.get(p.fromFund) || fundById.get(fallbackFund);
            const toF = fundById.get(p.toFund) || fundById.get(fallbackFund);
            const validKind = (f, k) => {
                if (!f) return "index";
                if (f.custom) return f.kind === "etf" ? "etf" : "index";
                if (
                    (k === "etf" || k === "index") &&
                    f.providers.some((x) => x.kind === k)
                )
                    return k;
                return f.providers.some((x) => x.kind === "index") ? "index" : "etf";
            };
            const fromKind = validKind(fromF, p.fromKind);
            const toKind = validKind(toF, p.toKind);
            const toProv =
                toF &&
                    typeof p.toProv === "string" &&
                    toF.providers.some((x) => x.id === p.toProv)
                    ? p.toProv
                    : defaultProvOfFund(toF?.id || fallbackFund, toKind);
            const amountMode = p.amountMode === "eur" ? "eur" : "pct";
            const amount =
                amountMode === "pct"
                    ? num(p.amount, 0, 100, 100)
                    : num(p.amount, 0, 1e9, 10000);
            const out = {
                id,
                itemType: "op",
                name: cleanOpName(p.name),
                op: opType,
                fromFund: fromF?.id || fallbackFund,
                fromKind,
                toFund: toF?.id || fallbackFund,
                toKind,
                toProv,
                amountMode,
                amount,
                taxed: typeof p.taxed === "boolean" ? p.taxed : null,
            };
            if (out.taxed === null) out.taxed = opTaxDefault(out);
            return out;
        };

        if (!isObj(src)) {
            return {
                activeGroup: "invest",
                activeId: null,
                invest: [],
                spend: [],
            };
        }

        const seenInv = new Set();
        let invPhaseIdx = 0;
        const invest = (Array.isArray(src.invest) ? src.invest : [])
            .slice(0, 40)
            .filter(isObj)
            .map((p) => {
                if (isOp(p)) return cleanOpItem(p, "inv", seenInv);
                const idx = invPhaseIdx++;
                let id =
                    typeof p.id === "string" && /^[a-z0-9_-]{2,24}$/i.test(p.id)
                        ? p.id
                        : `inv-${idx + 1}`;
                while (seenInv.has(id)) id = `inv-${seenInv.size + 1}`;
                seenInv.add(id);
                return {
                    id,
                    itemType: "phase",
                    label: cleanLabel(p.label, String(idx + 1)),
                    years: Math.round(num(p.years, 1, 50, fb.workYears ?? 20)),
                    net: num(p.net, 0, 1e7, fb.net ?? 1800),
                    needs: num(p.needs, 0, 1e7, fb.needs ?? 900),
                    leisure: num(p.leisure, 0, 1e7, fb.leisure ?? 270),
                    invest: num(p.invest, 0, 1e7, fb.invest ?? 630),
                    investAuto: typeof p.investAuto === "boolean" ? p.investAuto : true,
                    touched: {
                        needs: !!(isObj(p.touched) && p.touched.needs),
                        leisure: !!(isObj(p.touched) && p.touched.leisure),
                    },
                    needsWant: Number.isFinite(p.needsWant)
                        ? clamp(p.needsWant, 0, 1e7)
                        : null,
                    leisureWant: Number.isFinite(p.leisureWant)
                        ? clamp(p.leisureWant, 0, 1e7)
                        : null,
                    investWant: Number.isFinite(p.investWant)
                        ? clamp(p.investWant, 0, 1e7)
                        : null,
                    initial: num(p.initial, 0, 1e9, idx === 0 ? (fb.initial ?? 1000) : 0),
                    inflation: num(p.inflation, -10, 100, fb.inflation ?? 2.5),
                    brokerFee: num(p.brokerFee, 0, 100, fb.brokerFee ?? 0.15),
                    alloc: cleanAlloc(p.alloc),
                    prov: cleanProv(p.prov),
                    fundCfg: cleanCfg(p.fundCfg),
                };
            });

        const seenSpd = new Set();
        let spdPhaseIdx = 0;
        const spend = (Array.isArray(src.spend) ? src.spend : [])
            .slice(0, 40)
            .filter(isObj)
            .map((p) => {
                if (isOp(p)) return cleanOpItem(p, "spd", seenSpd);
                const idx = spdPhaseIdx++;
                let id =
                    typeof p.id === "string" && /^[a-z0-9_-]{2,24}$/i.test(p.id)
                        ? p.id
                        : `spd-${idx + 1}`;
                while (seenSpd.has(id)) id = `spd-${seenSpd.size + 1}`;
                seenSpd.add(id);
                return {
                    id,
                    itemType: "phase",
                    label: cleanLabel(p.label, String(idx + 1)),
                    years: Math.round(num(p.years, 5, 60, fb.retireYears ?? 30)),
                    retLinked: typeof p.retLinked === "boolean" ? p.retLinked : true,
                    retNeeds: num(p.retNeeds, 0, 1e7, fb.retNeeds ?? 900),
                    retLeisure: num(p.retLeisure, 0, 1e7, fb.retLeisure ?? 270),
                    retBasis: p.retBasis === "gross" ? "gross" : "net",
                    retGross:
                        Number.isFinite(p.retGross) && p.retGross >= 0
                            ? Math.min(1e7, p.retGross)
                            : null,
                    useCash: typeof p.useCash === "boolean" ? p.useCash : true,
                    inflation: num(p.inflation, -10, 100, fb.inflation ?? 2.5),
                    brokerFee: num(p.brokerFee, 0, 100, fb.brokerFee ?? 0.15),
                    alloc: cleanAlloc(p.alloc),
                    prov: cleanProv(p.prov),
                    fundCfg: cleanCfg(p.fundCfg),
                    tax: taxes
                        ? taxes.clean(p.tax)
                        : structuredClone(fb.tax || config.DEFAULT_STATE.tax),
                };
            });

        const activeGroup = src.activeGroup === "spend" ? "spend" : "invest";
        const pool = phasesOf(activeGroup === "spend" ? spend : invest);
        const activeId =
            typeof src.activeId === "string" &&
                pool.some((p) => p.id === src.activeId)
                ? src.activeId
                : pool[0]?.id || null;

        return { activeGroup, activeId, invest, spend };
    }

    /* ---------- Componente UI: Paneles de línea de tiempo ---------- */
    function buildGroupBox(group) {
        const meta = GROUP_META[group];
        return h(
            "section",
            { class: `card tl-box tl-${group}`, "data-adv-group": group },
            h(
                "div",
                {
                    class: "tl-head",
                    "data-adv-head": group,
                    title: `Pulsa para ver los tramos de ${meta.title.toLowerCase()}`,
                },
                h(
                    "span",
                    { class: "tl-head-l" },
                    h("strong", { class: "tl-title" }, meta.title),
                    h("span", { class: "tl-time-lbl" }, "Tiempo"),
                    h(
                        "button",
                        {
                            type: "button",
                            class: "tl-add",
                            "data-adv-add": group,
                            title: `Añadir tramo de ${meta.title.toLowerCase()}`,
                            "aria-label": `Añadir tramo de ${meta.title.toLowerCase()}`,
                        },
                        "+",
                    ),
                    h("span", { class: "tl-colon" }, ":"),
                ),
                h("div", { class: "tl-pills", "data-adv-pills": group }),
                h(
                    "button",
                    {
                        type: "button",
                        class: "tl-op-add",
                        "data-adv-op-add": group,
                        title: `Añadir operación en ${meta.title.toLowerCase()} (vender, comprar o mover fondos)`,
                        "aria-label": `Añadir operación en ${meta.title.toLowerCase()}`,
                    },
                    "+",
                ),
            ),
            h(
                "div",
                { class: "tl-controls", "data-adv-controls": group, hidden: "" },
                h("div", {
                    class: "tl-err-banner",
                    "data-adv-err": group,
                    hidden: "",
                }),
                h(
                    "div",
                    { class: `field tl-dur-field ${meta.syncClass}` },
                    h(
                        "label",
                        {},
                        "Años",
                        h("em", { class: "tl-total-lbl", "data-adv-total": group }),
                    ),
                    h(
                        "div",
                        { class: "pair" },
                        h("input", {
                            type: "range",
                            min: meta.minYears,
                            max: meta.maxYears,
                            step: 1,
                            "data-adv-years-range": group,
                            "aria-label": `Años del tramo de ${meta.title.toLowerCase()}`,
                        }),
                        h("input", {
                            type: "number",
                            min: meta.minYears,
                            max: meta.maxYears,
                            step: 1,
                            inputmode: "numeric",
                            "data-adv-years-num": group,
                            "aria-label": `Años del tramo de ${meta.title.toLowerCase()}`,
                        }),
                        h("span", { class: "suf" }, "años"),
                    ),
                ),
                h(
                    "div",
                    { class: "tl-meta" },
                    h(
                        "label",
                        { class: "tl-rename-wrap" },
                        h("span", {}, "Nombre"),
                        h("input", {
                            type: "text",
                            class: "tl-rename",
                            "data-adv-rename": group,
                            "aria-label": "Nombre del tramo",
                            placeholder: "1",
                        }),
                    ),
                    h(
                        "button",
                        {
                            type: "button",
                            class: "tl-del",
                            "data-adv-del": group,
                            title: "Eliminar tramo seleccionado",
                            "aria-label": "Eliminar tramo seleccionado",
                        },
                        "🗑️",
                    ),
                ),
            ),
        );
    }

    /** Construye el contenedor con los dos recuadros punteados (Invertir y Gastar) y conecta sus eventos. */
    function buildPanels(handlers = {}) {
        const root = h(
            "div",
            { id: "tl-panels", class: "tl-panels", hidden: "" },
            buildGroupBox("invest"),
            buildGroupBox("spend"),
        );

        let dragInfo = null;

        // Permite desplazar las pastillas lateralmente con la rueda del ratón cuando hay overflow horizontal
        root.addEventListener(
            "wheel",
            (e) => {
                const pills = e.target.closest(".tl-pills");
                if (
                    pills &&
                    pills.scrollWidth > pills.clientWidth + 1 &&
                    Math.abs(e.deltaY) > Math.abs(e.deltaX)
                ) {
                    pills.scrollLeft += e.deltaY;
                    e.preventDefault();
                }
            },
            { passive: false },
        );

        root.addEventListener("click", (e) => {
            const addOpBtn = e.target.closest("[data-adv-op-add]");
            if (addOpBtn) {
                handlers.onAddOp?.(addOpBtn.dataset.advOpAdd);
                return;
            }
            const addBtn = e.target.closest("[data-adv-add]");
            if (addBtn) {
                handlers.onAdd?.(addBtn.dataset.advAdd);
                return;
            }
            const opPill = e.target.closest("[data-adv-op]");
            if (opPill) {
                handlers.onEditOp?.(opPill.dataset.advGroup, opPill.dataset.advOp);
                return;
            }
            const pill = e.target.closest("[data-adv-pill]");
            if (pill) {
                handlers.onSelect?.(pill.dataset.advGroup, pill.dataset.advPill);
                return;
            }
            const delBtn = e.target.closest("[data-adv-del]");
            if (delBtn && !delBtn.disabled) {
                handlers.onDelete?.(delBtn.dataset.advDel);
                return;
            }
            const head = e.target.closest("[data-adv-head]");
            if (head) {
                handlers.onSelect?.(head.dataset.advHead, null);
            }
        });

        root.addEventListener("input", (e) => {
            const t = e.target;
            if (t.dataset.advYearsRange || t.dataset.advYearsNum) {
                const group = t.dataset.advYearsRange || t.dataset.advYearsNum;
                const v = parseFloat(t.value);
                if (!Number.isFinite(v)) return;
                handlers.onYears?.(group, v);
            } else if (t.dataset.advRename) {
                handlers.onRename?.(t.dataset.advRename, t.value);
            }
        });

        root.addEventListener("focusout", (e) => {
            const t = e.target;
            if (t.dataset.advRename) {
                handlers.onRenameCommit?.(t.dataset.advRename);
            } else if (t.dataset.advYearsNum && t.value.trim() === "") {
                handlers.onYearsCommit?.(t.dataset.advYearsNum);
            }
        });

        /* --- Drag & Drop de tramos y operaciones dentro de cada bloque (sin cruzar entre Invertir y Gastar) --- */
        root.addEventListener("dragstart", (e) => {
            const item = e.target.closest("[data-adv-item]");
            if (!item) return;
            dragInfo = {
                group: item.dataset.advGroup,
                fromIdx: Number(item.dataset.advIdx),
            };
            item.classList.add("is-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", item.dataset.advItem);
            }
        });

        root.addEventListener("dragover", (e) => {
            if (!dragInfo) return;
            const item = e.target.closest("[data-adv-item]");
            if (!item || item.dataset.advGroup !== dragInfo.group) return;
            const toIdx = Number(item.dataset.advIdx);
            if (toIdx === dragInfo.fromIdx) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            root.querySelectorAll("[data-adv-item].is-over").forEach((el) => {
                if (el !== item) el.classList.remove("is-over");
            });
            item.classList.add("is-over");
        });

        root.addEventListener("dragleave", (e) => {
            const item = e.target.closest("[data-adv-item]");
            if (item) item.classList.remove("is-over");
        });

        root.addEventListener("drop", (e) => {
            if (!dragInfo) return;
            const item = e.target.closest("[data-adv-item]");
            if (!item || item.dataset.advGroup !== dragInfo.group) return;
            e.preventDefault();
            item.classList.remove("is-over");
            const toIdx = Number(item.dataset.advIdx);
            const { group, fromIdx } = dragInfo;
            dragInfo = null;
            if (fromIdx !== toIdx) handlers.onReorder?.(group, fromIdx, toIdx);
        });

        root.addEventListener("dragend", () => {
            dragInfo = null;
            root
                .querySelectorAll("[data-adv-item].is-dragging, [data-adv-item].is-over")
                .forEach((el) => el.classList.remove("is-dragging", "is-over"));
        });

        return root;
    }

    /** Actualiza visualmente los dos recuadros de línea de tiempo a partir del estado y del mapa de errores (`issues`). */
    function renderPanels(root, state, issues = null) {
        if (!root) return;
        const on = !!state.advancedMode;
        root.hidden = !on;
        if (on) root.removeAttribute("hidden");
        else root.setAttribute("hidden", "");
        if (!on) return;

        const adv = ensure(state);
        const ae = document.activeElement;

        for (const group of ["invest", "spend"]) {
            const box = root.querySelector(`.tl-box[data-adv-group="${group}"]`);
            const pillsBox = root.querySelector(`[data-adv-pills="${group}"]`);
            const ctrlBox = root.querySelector(`[data-adv-controls="${group}"]`);
            const list = adv[group];
            const phases = phasesOf(list);
            const isGroupActive = adv.activeGroup === group;
            const totalYears = phases.reduce((a, p) => a + (p.years || 0), 0);

            box.classList.toggle("is-active", isGroupActive);
            ctrlBox.hidden = !isGroupActive;
            if (isGroupActive) ctrlBox.removeAttribute("hidden");
            else ctrlBox.setAttribute("hidden", "");

            const prevScroll = pillsBox.scrollLeft;
            let phaseNum = 0;
            pillsBox.replaceChildren(
                ...list.map((item, idx) => {
                    const err = issues?.[item.id] || "";
                    if (isOp(item)) {
                        const lbl = opLabel(item);
                        const autoDesc = opAutoChartLabel(item);
                        const tip =
                            (err ? `⚠ ${err}\n` : "") +
                            `${opChartLabel(item)}${cleanOpName(item.name) ? ` (${autoDesc})` : ""} · pulsa para editar o arrastra para mover`;
                        return h(
                            "button",
                            {
                                type: "button",
                                draggable: "true",
                                class: "tl-pill tl-op-pill" + (err ? " is-error" : ""),
                                "data-adv-item": item.id,
                                "data-adv-op": item.id,
                                "data-adv-group": group,
                                "data-adv-idx": idx,
                                title: tip,
                            },
                            lbl,
                        );
                    }
                    phaseNum++;
                    const isSel = isGroupActive && item.id === adv.activeId;
                    const lbl = String(item.label || "").trim() || String(phaseNum);
                    const tip =
                        (err ? `⚠ ${err}\n` : "") +
                        `Tramo ${lbl} (${item.years} años) · arrastra para reordenar`;
                    return h(
                        "button",
                        {
                            type: "button",
                            draggable: "true",
                            class:
                                "tl-pill" +
                                (isSel ? " is-selected" : "") +
                                (err ? " is-error" : ""),
                            "data-adv-item": item.id,
                            "data-adv-pill": item.id,
                            "data-adv-group": group,
                            "data-adv-idx": idx,
                            title: tip,
                        },
                        lbl,
                    );
                }),
            );
            pillsBox.scrollLeft = prevScroll;

            if (!isGroupActive) continue;

            const cur = phases.find((p) => p.id === adv.activeId) || phases[0];
            const errBanner = root.querySelector(`[data-adv-err="${group}"]`);
            if (errBanner) {
                const curErr = issues?.[cur.id] || "";
                errBanner.hidden = !curErr;
                if (curErr) {
                    errBanner.removeAttribute("hidden");
                    errBanner.textContent = "⚠ " + curErr;
                }
            }

            const totalEl = root.querySelector(`[data-adv-total="${group}"]`);
            if (totalEl) {
                totalEl.textContent =
                    phases.length > 1
                        ? `Total ${GROUP_META[group].title.toLowerCase()}: ${totalYears} años`
                        : "";
            }

            const rInp = root.querySelector(`[data-adv-years-range="${group}"]`);
            const nInp = root.querySelector(`[data-adv-years-num="${group}"]`);
            if (rInp && Number(rInp.value) !== cur.years) rInp.value = cur.years;
            if (
                nInp &&
                (ae !== nInp || Math.abs(Number(nInp.value) - cur.years) > 0.01) &&
                (ae !== nInp || nInp.value !== "")
            ) {
                nInp.value = cur.years;
            }

            const ren = root.querySelector(`[data-adv-rename="${group}"]`);
            if (ren && ae !== ren && ren.value !== cur.label) ren.value = cur.label;

            const del = root.querySelector(`[data-adv-del="${group}"]`);
            if (del) {
                del.disabled = phases.length <= 1;
                del.title =
                    phases.length <= 1
                        ? "Debe existir al menos un tramo"
                        : `Eliminar tramo «${cur.label || "1"}»`;
            }
        }
    }

    App.advanced = {
        GROUP_META,
        isOp,
        phasesOf,
        fundShort,
        defaultKindOfFund,
        defaultProvOfFund,
        opTaxDefault,
        opAutoChartLabel,
        opLabel,
        opChartLabel,
        createInvestPhase,
        createSpendPhase,
        createOp,
        ensure,
        getActive,
        syncToState,
        syncFromState,
        selectPhase,
        addPhase,
        removePhase,
        addOp,
        updateOp,
        removeOp,
        renamePhase,
        reorderItem,
        reorderPhase: reorderItem,
        setActiveYears,
        clean,
        cleanLabel,
        cleanOpName,
        buildPanels,
        renderPanels,
    };
})((window.App = window.App || {}));