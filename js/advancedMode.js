/* Modo Avanzado (planificación por tramos temporales):
   - Gestión de estado por tramos independientes para «Invertir» y «Gastar».
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

    /* ---------- Utilidades de tramos ---------- */
    function nextId(group, list) {
        const pre = GROUP_META[group].prefix;
        const used = new Set((list || []).map((p) => p.id));
        let n = (list || []).length + 1;
        while (used.has(`${pre}-${n}`)) n++;
        return `${pre}-${n}`;
    }

    function nextLabel(list) {
        let maxN = 0;
        for (const p of list || []) {
            const m = /^\d+$/.exec(String(p.label ?? "").trim());
            if (m) maxN = Math.max(maxN, Number(m[0]));
        }
        return String(Math.max(maxN + 1, (list || []).length + 1));
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

    /** Garantiza que state.advanced tenga al menos 1 tramo en cada grupo y un tramo activo válido. */
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
        if (!Array.isArray(adv.invest) || !adv.invest.length) {
            adv.invest = [createInvestPhase(state, "1", true, "inv-1")];
        }
        if (!Array.isArray(adv.spend) || !adv.spend.length) {
            adv.spend = [createSpendPhase(state, "1", "spd-1")];
        }
        if (adv.activeGroup !== "invest" && adv.activeGroup !== "spend") {
            adv.activeGroup = "invest";
        }
        const list = adv[adv.activeGroup];
        if (!list.some((p) => p.id === adv.activeId)) {
            adv.activeId = list[0].id;
        }
        return adv;
    }

    /** Devuelve el tramo activo actual junto con su grupo e índice. */
    function getActive(state) {
        const adv = ensure(state);
        const group = adv.activeGroup;
        const list = adv[group];
        const index = Math.max(
            0,
            list.findIndex((p) => p.id === adv.activeId),
        );
        return { group, list, index, phase: list[index] };
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

    /** Selecciona un tramo concreto (o el primero del grupo si no se pasa id) y carga su configuración en el estado raíz. */
    function selectPhase(state, group, id) {
        const adv = ensure(state);
        if (group !== "invest" && group !== "spend") return null;
        const target =
            (id ? adv[group].find((p) => p.id === id) : null) || adv[group][0];
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
        const base = list[list.length - 1] || state;
        const id = nextId(group, list);
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

    /** Elimina el tramo indicado (siempre queda al menos 1 tramo por grupo). */
    function removePhase(state, group, id) {
        const adv = ensure(state);
        const list = adv[group];
        if (!list || list.length <= 1) return false;
        const idx = list.findIndex((p) => p.id === id);
        if (idx < 0) return false;
        if (state.advancedMode) syncFromState(state);
        list.splice(idx, 1);
        if (adv.activeGroup === group && adv.activeId === id) {
            const next = list[Math.min(idx, list.length - 1)];
            adv.activeId = next.id;
            syncToState(state);
        }
        return true;
    }

    /** Cambia el nombre visible de un tramo (sin límite de 2 caracteres). */
    function renamePhase(state, group, id, value) {
        const adv = ensure(state);
        const p = adv[group]?.find((x) => x.id === id);
        if (!p) return null;
        p.label = String(value ?? "").slice(0, 40);
        return p;
    }

    /** Reordena un tramo dentro de su grupo (Drag & Drop). */
    function reorderPhase(state, group, fromIdx, toIdx) {
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

        if (!isObj(src)) {
            return {
                activeGroup: "invest",
                activeId: null,
                invest: [],
                spend: [],
            };
        }

        const seenInv = new Set();
        const invest = (Array.isArray(src.invest) ? src.invest : [])
            .slice(0, 20)
            .filter(isObj)
            .map((p, idx) => {
                let id =
                    typeof p.id === "string" && /^[a-z0-9_-]{2,20}$/i.test(p.id)
                        ? p.id
                        : `inv-${idx + 1}`;
                while (seenInv.has(id)) id = `inv-${seenInv.size + 1}`;
                seenInv.add(id);
                return {
                    id,
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
        const spend = (Array.isArray(src.spend) ? src.spend : [])
            .slice(0, 20)
            .filter(isObj)
            .map((p, idx) => {
                let id =
                    typeof p.id === "string" && /^[a-z0-9_-]{2,20}$/i.test(p.id)
                        ? p.id
                        : `spd-${idx + 1}`;
                while (seenSpd.has(id)) id = `spd-${seenSpd.size + 1}`;
                seenSpd.add(id);
                return {
                    id,
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
        const pool = activeGroup === "spend" ? spend : invest;
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
                h("div", { class: "tl-pills", "data-adv-pills": group }),
            ),
            h(
                "div",
                { class: "tl-controls", "data-adv-controls": group, hidden: "" },
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

        root.addEventListener("click", (e) => {
            const addBtn = e.target.closest("[data-adv-add]");
            if (addBtn) {
                handlers.onAdd?.(addBtn.dataset.advAdd);
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

        /* --- Drag & Drop de tramos dentro de cada línea de tiempo --- */
        root.addEventListener("dragstart", (e) => {
            const pill = e.target.closest("[data-adv-pill]");
            if (!pill) return;
            dragInfo = {
                group: pill.dataset.advGroup,
                fromIdx: Number(pill.dataset.advIdx),
            };
            pill.classList.add("is-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", pill.dataset.advPill);
            }
        });

        root.addEventListener("dragover", (e) => {
            if (!dragInfo) return;
            const pill = e.target.closest("[data-adv-pill]");
            if (!pill || pill.dataset.advGroup !== dragInfo.group) return;
            const toIdx = Number(pill.dataset.advIdx);
            if (toIdx === dragInfo.fromIdx) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            root.querySelectorAll(".tl-pill.is-over").forEach((el) => {
                if (el !== pill) el.classList.remove("is-over");
            });
            pill.classList.add("is-over");
        });

        root.addEventListener("dragleave", (e) => {
            const pill = e.target.closest("[data-adv-pill]");
            if (pill) pill.classList.remove("is-over");
        });

        root.addEventListener("drop", (e) => {
            if (!dragInfo) return;
            const pill = e.target.closest("[data-adv-pill]");
            if (!pill || pill.dataset.advGroup !== dragInfo.group) return;
            e.preventDefault();
            pill.classList.remove("is-over");
            const toIdx = Number(pill.dataset.advIdx);
            const { group, fromIdx } = dragInfo;
            dragInfo = null;
            if (fromIdx !== toIdx) handlers.onReorder?.(group, fromIdx, toIdx);
        });

        root.addEventListener("dragend", () => {
            dragInfo = null;
            root
                .querySelectorAll(".tl-pill.is-dragging, .tl-pill.is-over")
                .forEach((el) => el.classList.remove("is-dragging", "is-over"));
        });

        return root;
    }

    /** Actualiza visualmente los dos recuadros de línea de tiempo a partir del estado. */
    function renderPanels(root, state) {
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
            const isGroupActive = adv.activeGroup === group;
            const totalYears = list.reduce((a, p) => a + (p.years || 0), 0);

            box.classList.toggle("is-active", isGroupActive);
            ctrlBox.hidden = !isGroupActive;
            if (isGroupActive) ctrlBox.removeAttribute("hidden");
            else ctrlBox.setAttribute("hidden", "");

            pillsBox.replaceChildren(
                ...list.map((p, idx) => {
                    const isSel = isGroupActive && p.id === adv.activeId;
                    const lbl = String(p.label || "").trim() || String(idx + 1);
                    return h(
                        "button",
                        {
                            type: "button",
                            draggable: "true",
                            class: "tl-pill" + (isSel ? " is-selected" : ""),
                            "data-adv-pill": p.id,
                            "data-adv-group": group,
                            "data-adv-idx": idx,
                            title: `Tramo ${lbl} (${p.years} años) · arrastra para reordenar`,
                        },
                        lbl,
                    );
                }),
            );

            if (!isGroupActive) continue;

            const cur = list.find((p) => p.id === adv.activeId) || list[0];
            const totalEl = root.querySelector(`[data-adv-total="${group}"]`);
            if (totalEl) {
                totalEl.textContent =
                    list.length > 1
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
                del.disabled = list.length <= 1;
                del.title =
                    list.length <= 1
                        ? "Debe existir al menos un tramo"
                        : `Eliminar tramo «${cur.label || "1"}»`;
            }
        }
    }

    App.advanced = {
        GROUP_META,
        createInvestPhase,
        createSpendPhase,
        ensure,
        getActive,
        syncToState,
        syncFromState,
        selectPhase,
        addPhase,
        removePhase,
        renamePhase,
        reorderPhase,
        setActiveYears,
        clean,
        cleanLabel,
        buildPanels,
        renderPanels,
    };
})((window.App = window.App || {}));