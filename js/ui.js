/* Interfaz: genera formularios desde el esquema, enlaza eventos y pinta resultados. */
(function (App) {
  'use strict';
  const { config, storage, finance, data, chart, scenarioCode, taxes, customFunds } = App;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const pct = (x, d = 1) => (x * 100).toFixed(d).replace('.', ',') + ' %';
  const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  const PCT = { needsPct: 'needs', leisurePct: 'leisure', investPct: 'invest' };
  const RET_PCT = { retNeedsPct: 'retNeeds', retLeisurePct: 'retLeisure' }; // % sobre los ingresos de la inversión (suman 100 %)
  const MONEY = new Set(['net', 'needs', 'leisure', 'invest', 'retIncome', 'retNeeds', 'retLeisure']);

  const state = scenarioCode.clean(storage.get(config.STORAGE.settings, {})); // lo guardado pasa por la misma validación que un supuesto importado (valores por defecto, rangos, fondos, impuestos…)
  let base = null;          // últimos datos introducidos por el usuario: de aquí salen las estrategias
  let active = null;        // estrategia aplicada actualmente
  let scenarios = storage.get(config.STORAGE.scenarios, []);
  let raf = 0;
  let baseStale = false;    // los datos cambiaron desde la última vez que se tomó la base de las estrategias (se toma al calcular lo pesado, no en cada evento)
  let dirty = false, saveTimer = 0; // guardado en localStorage con retraso
  let dragging = false, heavyPending = false; // slider pulsado / lo pesado está pendiente
  let lastRes = null;       // última simulación: de aquí salen el bruto del primer año de jubilación y la parte que es ganancia
  // Ajustes de VISTA que una estrategia no debe pisar (antes, al aplicar una, volvía a "Salario medio" porque la copia guardaba el valor antiguo).
  const VIEW_KEYS = ['stratBase', 'period', 'showInvested', 'showPrice', 'showTotal', 'showNominal', 'showDividends', 'hideCosts', 'retBasis'];
  const applyState = next => { const keep = Object.fromEntries([...VIEW_KEYS, 'customFunds'].map(k => [k, state[k]])); Object.assign(state, structuredClone(next), keep); state.retGross = null; };
  const factor = () => (state.period === 'year' ? 12 : 1);
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  /** Periodo de histórico elegido: por defecto, desde que hay datos de TODOS los índices hasta el último dato. `years` = duración real. */
  let hrMemo = null; // se llama decenas de veces por pintado con los mismos datos
  function histRange(s = state) {
    const key = data.version() + '|' + s.histFrom + '|' + s.histTo;
    if (hrMemo && hrMemo.key === key) return hrMemo.val;
    const b = data.bounds();
    const to = clamp(s.histTo ?? b.max, b.min + 1, b.max), from = clamp(s.histFrom ?? b.common, b.min, to - 1);
    const startKey = (from - 1) * 12 + 11, endKey = to >= b.max ? b.lastKey : to * 12 + 11;
    const val = { from, to, b, years: (endKey - startKey) / 12 };
    hrMemo = { key, val };
    return val;
  }
  const rateOf = f => data.cagr(f, histRange());
  // Datos del riesgo: todo el histórico disponible (mín. 20 años, para que una ventana corta no oculte las grandes caídas) e inflación de los últimos 30 años
  const inputsOf = s => ({ market: data.portfolioStats(s.alloc, Math.max(Math.ceil(histRange(s).years), 20)), infl: data.inflationStats(30) });
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']; // sin crear un formateador de fechas en cada llamada
  const mLabel = key => `${MESES[key % 12]} ${Math.floor(key / 12)}`;
  const fmtYears = y => { const r = round(y, 1); return (Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',')) + ' años'; };
  const sumAlloc = () => Object.values(state.alloc).reduce((a, b) => a + b, 0);

  function h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    e.append(...kids.filter(x => x != null));
    return e;
  }

  /* ---------- Construcción ---------- */
  /** Slider doble (año inicial y final) + casillas de teclado; la duración es solo una descripción. */
  function buildHistRange(f) {
    const rng = w => h('input', { type: 'range', 'data-hist': w, step: 1, 'aria-label': w === 'lo' ? 'Año inicial' : 'Año final' });
    const num = w => h('input', { type: 'number', class: 'yr', 'data-hist': w, step: 1, inputmode: 'numeric', 'aria-label': w === 'from' ? 'Año inicial' : 'Año final' });
    return h('div', { class: 'field', 'data-field': f.key },
      h('label', {}, f.label, h('em', { id: 'hist-len' })),
      h('div', { class: 'pair' }, h('div', { class: 'dual' }, h('div', { class: 'track' }), h('div', { class: 'fill' }), rng('lo'), rng('hi')),
        num('from'), h('span', { class: 'suf' }, '–'), num('to')),
      h('div', { class: 'hist-warn', id: 'hist-warn', hidden: '' }),
      h('button', { type: 'button', class: 'link', id: 'hist-reset', hidden: '', onclick: () => { state.histFrom = state.histTo = null; refresh(); } },
        '↺ Volver al periodo por defecto (desde que hay datos de todos los índices hasta hoy)'));
  }

  /** Debajo de "Ingresos de la inversión": elegir neto/bruto, descripción (con el importe sin ajustar a inflación) y botón de impuestos. */
  function buildRetExtras() {
    const seg = h('div', { class: 'seg seg-s', id: 'ret-basis', title: 'Neto: lo que quieres cobrar tras impuestos. Bruto: lo que sacas de las inversiones antes de impuestos.' },
      ...[['net', 'Neto'], ['gross', 'Bruto']].map(([v, l]) => h('button', { type: 'button', 'data-rb': v, onclick: () => { state.retBasis = v; state.retGross = v === 'gross' && lastRes ? lastRes.spend : null; refresh(false); } }, l)));
    return h('div', { class: 'ret-extra' }, seg,
      h('div', { class: 'ret-info' }, h('div', { id: 'ret-desc' },
        h('div', { id: 'ret-l1', title: 'Primer año de jubilación. Los años siguientes cambia según cuánta ganancia haya en el capital.' }),
        h('div', { id: 'ret-l2', title: 'Mismo importe sin descontar la inflación: lo que verías en tu cuenta el primer año de jubilación.' })), h('button', { type: 'button', class: 'btn ghost', id: 'tax-open', onclick: openTax }, 'Ajustar impuestos')));
  }

  function buildField(f) {
    if (f.type === 'range2') return buildHistRange(f);
    const link = f.linked ? { 'data-linked': '' } : {};
    if (f.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': f.key }), f.label);
    const isMoney = MONEY.has(f.key);
    const row = h('div', { class: 'pair' },
      h('input', { type: 'range', 'aria-label': f.label, 'data-key': f.key, min: f.min ?? 0, max: f.max, step: f.step, 'data-max': f.max, 'data-step': f.step, ...link }),
      h('input', { type: 'number', 'aria-label': f.label, 'data-key': f.key, step: 'any', min: f.min ?? 0, inputmode: 'decimal', ...link }),
      h('span', { class: 'suf' }, isMoney ? '€' : f.suffix || ''));
    if (f.pct) row.append(h('input', { type: 'number', class: 'pct', 'aria-label': f.label + ' (%)', 'data-key': f.pct, min: 0, max: 100, step: 'any', inputmode: 'decimal', ...link }), h('span', { class: 'suf' }, '%'));
    const field = h('div', { class: 'field', 'data-field': f.key }, h('label', {}, f.label, f.unit ? h('em', { 'data-unit': '' }) : null), row);
    if (f.key === 'retIncome') field.append(buildRetExtras());
    return field;
  }

  function buildFunds() {
    const box = h('div', { id: 'funds' });
    box.append(h('div', { class: 'fswitches' },
      h('label', { class: 'switch fswitch', title: 'Muestra la rentabilidad de cada fondo con el dividendo que reparte (bruto). La simulación siempre incluye los dividendos, tras impuestos.' },
        h('input', { type: 'checkbox', 'data-key': 'showDividends' }), h('i'), h('span', {}, 'Ver dividendos')),
      h('label', { class: 'switch fswitch', title: 'Activado: la cifra no descuenta ni la inflación ni el TER. Desactivado: se le resta la inflación que has elegido y el TER de cada fondo (cifra real, en € de hoy).' },
        h('input', { type: 'checkbox', 'data-key': 'hideCosts' }), h('i'), h('span', {}, 'Ocultar inflación y TER'))));
    box.append(h('div', { class: 'tools' }, h('small', { id: 'ter-info' }),
      h('span', { class: 'tools-btns' },
        h('button', { type: 'button', class: 'plus', title: 'Añadir un fondo personalizado', 'aria-label': 'Añadir fondo personalizado', onclick: () => openFundDialog() }),
        h('button', { type: 'button', onclick: () => { config.FUNDS.forEach(f => { state.prov[f.id] = finance.cheapest(f, finance.kindOf(state, f)).id; }); refresh(); } }, 'Gestor más barato'))));
    box.append(h('p', { class: 'fnote', id: 'funds-note' }));
    config.FUNDS.forEach(f => box.append(h('div', { class: 'fund', 'data-fund': f.id },
      h('input', { type: 'checkbox', id: 'f-' + f.id, 'data-fcheck': f.id }),
      h('div', { class: 'fmain' },
        h('div', { class: 'cname' }, h('label', { for: 'f-' + f.id }, h('b', {}, f.name)), h('span', { class: 'kbadge' }),
          h('button', { type: 'button', class: 'ctoggle', 'data-cact': 'toggle', 'data-cid': f.id, title: 'Tipo (ETF o fondo indexado), movimientos entre fondos e impuestos' }, '▾')),
        h('select', { 'data-fprov': f.id, 'aria-label': 'Gestor' }),
        h('small', { class: 'cmoves' })),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': f.id }),
      h('span', { class: 'suf' }, '%'),
      fundPanel(f))));
    box.append(h('div', { id: 'custom-funds' }));
    box.append(h('div', { class: 'total-row' }, h('div', { class: 'total', id: 'alloc-total' }), h('div', { class: 'total', id: 'risk-total' })));
    box.addEventListener('input', e => {
      const c = e.target.dataset.fcheck, w = e.target.dataset.fw, p = e.target.dataset.fprov, cy = e.target.dataset.cperyear, cp = e.target.dataset.cpct, ct = e.target.dataset.ctaxed, ck = e.target.dataset.ckind;
      const fid = ck || ct || cy || cp;
      if (fid) { // panel de un fondo (del catálogo o personalizado): tipo, movimientos al año, % que se mueve e impuestos
        const f = config.FUNDS.find(x => x.id === fid); if (!f) return;
        if (ck) { changeKind(f, e.target.checked ? 'etf' : 'index'); refresh(); return; }
        if (ct) { setOpts(f, { taxed: e.target.checked }); refresh(); return; }
        const v = parseFloat(e.target.value) || 0;
        setOpts(f, cy ? { perYear: Math.round(v) } : { pct: v });
        if (!optsOf(f).taxed) { updateFundPanel(e.target.closest('.fund'), f, false); scheduleSave(); return; } // sin impuestos no cambia ningún resultado: no se recalcula
        refresh(); return;
      }
      if (c) {
        if (e.target.checked) state.alloc[c] = Math.max(0, 100 - sumAlloc());
        else if (Object.keys(state.alloc).length > 1) delete state.alloc[c];
      } else if (w) { const v = parseFloat(e.target.value); if (!Number.isFinite(v)) return; state.alloc[w] = Math.max(0, v); } // vacío = todavía escribiendo
      else if (p) state.prov[p] = e.target.value;
      else return;
      refresh();
    });
    box.addEventListener('click', e => { // botones de las filas personalizadas
      const b = e.target.closest('[data-cact]'); if (!b) return;
      const id = b.dataset.cid, a = b.dataset.cact;
      if (a === 'toggle') { if (openCustom.has(id)) openCustom.delete(id); else openCustom.add(id); refresh(false); }
      else if (a === 'edit') openFundDialog(id);
      else if (a === 'del') deleteFund(id);
    });
    return box;
  }

  function buildInputs() {
    config.SECTIONS.forEach(sec => {
      const card = h('div', { class: 'card sec-' + sec.id }, h('h2', {}, sec.title), sec.note ? h('p', { class: 'note' }, sec.note) : null, ...sec.fields.map(buildField));
      if (sec.custom === 'funds') card.append(buildFunds());
      $('#col-' + sec.col).append(card);
    });
  }

  /* ---------- Estado ← eventos ---------- */
  function set(key, el) {
    const isCheck = el.type === 'checkbox', v = isCheck ? el.checked : parseFloat(el.value);
    if (!isCheck && !Number.isFinite(v)) return;
    if (key === 'periodYearly') state.period = v ? 'year' : 'month';
    else if (key in PCT) { state[PCT[key]] = (state.net * v) / 100; flag(PCT[key]); }
    else if (key in RET_PCT) setRetShare(key, v);
    else if (key === 'retIncome') { // en bruto: el importe pedido se guarda y se convierte a neto con los impuestos
      const m = v / factor();
      if (state.retBasis === 'gross') { state.retGross = m; setRetIncome(netFromGross(m, lastRes?.q0 ?? 1)); } else setRetIncome(m);
    }
    else if (MONEY.has(key)) { state[key] = v / factor(); flag(key); if (key === 'retNeeds' || key === 'retLeisure') state.retGross = null; } // cambiar el neto a mano: el bruto se vuelve a leer
    else if (key === 'retLinked') { state.retLinked = v; state.retGross = !v && state.retBasis === 'gross' && lastRes ? lastRes.spend : null; }
    else state[key] = v;
    refresh(key !== 'showDividends' && key !== 'hideCosts'); // son solo de vista: no deben reiniciar la base de las estrategias
  }
  /** Cambia el periodo de histórico. Las casillas solo aceptan años de 4 cifras dentro del rango mientras escribes; al salir (commit) se ajusta. */
  function onHist(which, el, commit) {
    const b = data.bounds(), num = which === 'from' || which === 'to', v = Math.round(parseFloat(el.value));
    if (!Number.isFinite(v) || (num && !commit && (v < b.min || v > b.max || String(v).length < 4))) { if (commit) renderHist(true); return; }
    let { from, to } = histRange();
    if (which === 'lo' || which === 'from') from = clamp(v, b.min, to - 1);
    else to = clamp(v, from + 1, b.max);
    state.histTo = to >= b.max ? null : to;
    state.histFrom = from === b.common && state.histTo === null ? null : from;
    refresh();
    if (commit) renderHist(true);
  }
  /* Jubilación: ingresos de la inversión = necesidades + ocio. Cambiar el total reescala ambos; cambiar un % reparte el resto al otro. */
  const retIncome = () => state.retNeeds + state.retLeisure;
  let retShare = 0.7; // parte de necesidades: se recuerda para no perder el reparto al pasar por 0
  const netFromGross = (gross, q0) => taxes.netOf(taxes.resolve(state.tax), gross * 12, q0) / 12;
  function setRetIncome(v) {
    const inc = retIncome();
    if (inc > 0) { retShare = state.retNeeds / inc; state.retNeeds *= v / inc; state.retLeisure *= v / inc; }
    else { state.retNeeds = v * retShare; state.retLeisure = v * (1 - retShare); }
  }
  function setRetShare(key, pctValue) {
    const inc = retIncome(), part = (inc * Math.min(100, Math.max(0, pctValue))) / 100;
    if (key === 'retNeedsPct') { state.retNeeds = part; state.retLeisure = inc - part; }
    else { state.retLeisure = part; state.retNeeds = inc - part; }
  }
  const valueOf = key => (key === 'retIncome' ? retIncome() : state[key]);
  function flag(k) { // lo que el usuario pide se recuerda (…Want): si el sueldo baja un instante al teclear, no se pierde (ver finance.normalize)
    if (k === 'needs' || k === 'leisure') state.touched[k] = true;
    if (k === 'invest') state.investAuto = false;
    if (k === 'needs') state.needsWant = state.needs; else if (k === 'leisure') state.leisureWant = state.leisure; else if (k === 'invest') state.investWant = state.invest;
  }
  function shown(key) {
    if (key in PCT) return state.net ? (state[PCT[key]] / state.net) * 100 : 0;
    if (key in RET_PCT) return retIncome() > 0 ? (state[RET_PCT[key]] / retIncome()) * 100 : 0;
    if (key === 'retIncome' && state.retBasis === 'gross' && lastRes) return lastRes.spend * factor(); // bruto del primer año de jubilación
    return MONEY.has(key) ? valueOf(key) * factor() : state[key];
  }

  /** Guardar en localStorage es síncrono: se hace una vez, cuando se deja de tocar (y al cerrar o salir de la pestaña). */
  function scheduleSave() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400); }
  function flushSave() { if (!dirty) return; dirty = false; clearTimeout(saveTimer); storage.set(config.STORAGE.settings, state); }

  /** userEdit = true: el usuario cambió algo → esos datos pasan a ser la base de las estrategias. */
  function refresh(userEdit = true) {
    finance.normalize(state);
    if (userEdit) { baseStale = true; active = null; } // la copia para las estrategias se hace al calcular lo pesado, no en cada evento
    scheduleSave();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  /* ---------- Pintado ---------- */
  const dom = {}; // listas de elementos que no cambian (se buscan una sola vez, no en cada pintado)
  const cached = (k, sel) => (dom[k] ||= $$(sel));
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; }; // escribir en el DOM solo si el texto cambió
  let syncKey = null, histSig = null, fundsSig = null;

  /** Los fondos personalizados solo se vuelven a poner en el catálogo cuando cambian ellos, el periodo de histórico o los datos. */
  function syncCustom() {
    const st = data.status(), hr = histRange();
    const key = state.customFunds.length ? JSON.stringify([state.customFunds, hr.from, hr.to, st.mode, st.count, data.version()]) : '';
    if (key === syncKey) return;
    syncKey = key;
    customFunds.sync(state.customFunds, rateOf);
  }

  function render() {
    syncCustom();
    const port = finance.portfolio(state, rateOf);
    let res = finance.simulate(state, port);
    if (state.retBasis === 'gross' && !state.retLinked) { // modo bruto: el bruto pedido manda y el neto se recalcula si cambia otro dato (la parte de ganancia no depende de lo que retiras)
      if (state.retGross == null) state.retGross = res.spend;
      else { const net = netFromGross(state.retGross, res.q0); if (Math.abs(net - retIncome()) > 1e-6) { setRetIncome(net); res = finance.simulate(state, port); } }
    }
    lastRes = res;
    const f = factor(), yearly = state.period === 'year', ae = document.activeElement;
    cached('keys', '[data-key]').forEach(el => {
      const key = el.dataset.key;
      if (el.type === 'checkbox') { const on = key === 'periodYearly' ? yearly : !!state[key]; if (el.checked !== on) el.checked = on; }
      else {
        if (el.type === 'range' && MONEY.has(key)) { const mx = el.dataset.max * f; if (el._mx !== mx) { el._mx = mx; el.max = mx; el.step = el.dataset.step * f; } }
        const v = round(shown(key));
        if (Math.abs(Number(el.value) - v) > (ae === el ? 0.01 : 0.004) || (ae !== el && el.value === '')) el.value = v; // solo si el valor cambió
      }
      if ('linked' in el.dataset && el.disabled !== state.retLinked) el.disabled = state.retLinked;
    });
    cached('units', '[data-unit]').forEach(e => { e._ret ??= !!e.closest('[data-field="retIncome"]'); setText(e, `(€ / ${yearly ? 'año' : 'mes'}${e._ret ? (state.retBasis === 'gross' ? ' bruto' : ' neto') : ''})`); });
    $('#hint-nominal').hidden = !state.showNominal; $('.legend').classList.toggle('nominal-on', !!state.showNominal);
    renderHist();
    renderFunds();
    renderExtremes();
    renderRetInfo(res);
    cached('basis', '#ret-basis button').forEach(b => b.classList.toggle('on', b.dataset.rb === state.retBasis));

    chart.render(res, state);
    renderKpis(res);
    scheduleHeavy(port); // riesgo, estrategias y supuestos guardados: se calculan al soltar el slider
    const st = data.status(), badge = $('#data-status');
    setText(badge, st.mode === 'live' ? `En vivo (${st.count}/${config.FUNDS.filter(f => !f.custom).length})` : st.mode === 'saved' ? `Datos del ${st.date || 'archivo local'}` : 'Sin datos · estimados (reintentar)');
    badge.classList.toggle('live', st.mode !== 'none');
    if ($('#tax-dlg').open) updateTaxPreview();
  }

  /** Aviso (vacío = todo bien) cuando a algún fondo elegido le faltan datos en el periodo seleccionado. */
  function histWarning() {
    if (data.status().mode === 'none') return 'Sin datos reales: la rentabilidad es una estimación fija y no cambia con los años.';
    const selected = Object.keys(state.alloc).map(id => config.FUNDS.find(x => x.id === id)).filter(f => f && (!f.custom || f.mimic)); // un personalizado que imita a otro hereda su histórico
    const partial = selected.map(f => [f, rateOf(f.custom ? config.FUNDS.find(x => x.id === f.mimic.fund) : f)]).filter(([, r]) => !r.live || r.lateBy > 3);
    return partial.length ? `Sin histórico completo en este periodo: ${partial.map(([f, r]) => r.live ? `${f.name} (datos desde ${Math.floor(r.startKey / 12)})` : `${f.name} (sin datos: estimación fija)`).join(', ')}. Se usa el máximo disponible.` : '';
  }

  function renderHist(force = false) {
    const st = data.status(), sig = JSON.stringify([state.histFrom, state.histTo, Object.keys(state.alloc), state.customFunds.map(d => d.mimic?.fund || ''), st.mode, st.count, data.version()]);
    if (!force && sig === histSig) return; // nada de lo que usa el slider de histórico ha cambiado
    histSig = sig;
    const { from, to, b, years } = histRange(), span = b.max - b.min || 1;
    const q = (dom.hist ||= Object.fromEntries(['lo', 'hi', 'from', 'to'].map(w => [w, $(`[data-hist="${w}"]`)])));
    ['lo', 'hi', 'from', 'to'].forEach(w => { q[w].min = b.min; q[w].max = b.max; });
    q.lo.value = from; q.hi.value = to;
    if (force || document.activeElement !== q.from) q.from.value = from;
    if (force || document.activeElement !== q.to) q.to.value = to;
    const dual = $('.dual'); dual.style.setProperty('--lo', (from - b.min) / span); dual.style.setProperty('--hi', (to - b.min) / span);
    q.lo.style.zIndex = (from - b.min) / span > 0.5 ? 3 : 1; // si se juntan al final, el de la izquierda queda accesible (si no, el derecho: ver CSS)
    const len = $('#hist-len'); len.textContent = '= ' + fmtYears(years);
    len.title = `Del cierre de ${mLabel((from - 1) * 12 + 11)} al de ${mLabel(to >= b.max ? b.lastKey : to * 12 + 11)}`;
    $('#hist-reset').hidden = state.histFrom == null && state.histTo == null;
    const text = histWarning(), warn = $('#hist-warn');
    warn.textContent = text; warn.hidden = !text;
    $('.field[data-field="histRange"]').classList.toggle('is-warn', !!text); // naranja suave: faltan datos (no es grave)
  }

  function renderFunds() {
    // Solo se repinta si cambió algo que afecta a los fondos (mover el sueldo o los años no los toca)
    const st = data.status(), sig = JSON.stringify([state.alloc, state.prov, state.customFunds, state.fundCfg, state.histFrom, state.histTo, state.inflation, state.brokerFee, state.showDividends, state.hideCosts, state.tax, st.mode, st.count, data.terDate(), data.version(), [...openCustom]]);
    if (sig === fundsSig) return;
    fundsSig = sig;
    const infl = String(round(state.inflation, 2)).replace('.', ',');
    const divOn = state.showDividends !== false, hideOn = state.hideCosts !== false, tax = String(round(taxes.divTax(taxes.resolve(state.tax)) * 100, 1)).replace('.', ',');
    const brk = String(round(state.brokerFee, 2)).replace('.', ','), inflRate = state.inflation / 100;
    let note;
    if (hideOn) note = divOn
      ? `Cifra de cada fondo: rentabilidad anual media del índice en el periodo elegido, en € nominales y con dividendos (subida del precio más el dividendo bruto del fondo). En la simulación se le resta a cada fondo la inflación que has elegido (${infl} %), además del TER y la comisión del bróker; el dividendo se cuenta una sola vez, después de impuestos (${tax} %).`
      : `Cifra de cada fondo: rentabilidad anual media del índice en el periodo elegido, en € nominales y sin dividendos. En la simulación se le resta a cada fondo la inflación que has elegido (${infl} %), además del TER y la comisión del bróker, y se le suma su dividendo.`;
    else note = `Cifra de cada fondo: rentabilidad anual media del índice en el periodo elegido, ${divOn ? 'con dividendos (subida del precio más el dividendo bruto del fondo)' : 'sin dividendos'}, ya descontados el TER de su gestor y la inflación que has elegido (${infl} %), es decir, en € de hoy. La simulación además resta la comisión del bróker (${brk} %)${divOn ? `; el dividendo se cuenta una sola vez, después de impuestos (${tax} %)` : ' y le suma su dividendo'}.`;
    $('#funds-note').textContent = note;
    renderCustomRows();
    $$('.fund').forEach(row => {
      const f = config.FUNDS.find(x => x.id === row.dataset.fund), on = f.id in state.alloc, r = rateOf(f);
      const dy = divOn ? f.yield / 100 : 0, terPct = finance.providerOf(state, f).ter, terTxt = String(terPct).replace('.', ',') + ' %';
      let shownRate = r.rate + dy; // con "Ver dividendos" se suma el dividendo
      if (!hideOn) shownRate = (1 + shownRate - terPct / 100) / (1 + inflRate) - 1; // sin ocultar: misma cuenta que la simulación (TER del gestor y luego inflación)
      $('[data-fcheck]', row).checked = on;
      const sel = $('select', row);
      if (sel) { sel.replaceChildren(...finance.providersOf(state, f).map(p => h('option', { value: p.id }, `${p.name} · TER ${p.ter} %`))); sel.value = finance.providerOf(state, f).id; sel.disabled = !on; } // solo los gestores del tipo elegido
      const w = $('[data-fw]', row); w.disabled = !on;
      if (document.activeElement !== w) w.value = on ? round(state.alloc[f.id]) : '';
      const ret = $('.ret', row); ret.textContent = pct(shownRate); ret.classList.toggle('neg', shownRate < 0);
      const costs = hideOn ? 'sin descontar inflación ni TER' : `descontados el TER (${terTxt}) y la inflación (${infl} %): (1 + rentabilidad − TER) ÷ (1 + inflación) − 1`;
      ret.title = (r.live ? `Rentabilidad anual media del índice entre ${mLabel(r.startKey)} y ${mLabel(r.endKey)} (${fmtYears(r.span)}): precio ${pct(r.rate)}${divOn ? ` + dividendo bruto ${pct(dy)}` : ', sin dividendos'}` : 'Estimación fija (sin datos reales en este periodo)') + '; ' + costs;
      $('.ter', row).textContent = 'TER ' + String(finance.providerOf(state, f).ter).replace('.', ',') + ' %';
      updateFundPanel(row, f, !!f.custom);
    });
    const t = sumAlloc(), el = $('#alloc-total');
    el.textContent = `Reparto: ${round(t, 1)} %` + (Math.abs(t - 100) > 0.1 ? ' (se normaliza a 100 %)' : '');
    el.classList.toggle('warn', Math.abs(t - 100) > 0.1);
    $('#ter-info').textContent = data.terDate() ? `TER actualizados: ${data.terDate()}` : 'TER de referencia';
  }

  /** Lo pesado (riesgo con 300 simulaciones y las 4 estrategias) se calcula cuando se deja de tocar: así sliders y datos responden al instante.
   *  Con un slider pulsado no se calcula nada aunque pares un momento: se espera a soltarlo. */
  let heavyTimer = 0, heavyArgs = null, heavyFirst = true;
  function scheduleHeavy(port) {
    heavyArgs = port;
    clearTimeout(heavyTimer);
    if (heavyFirst) { heavyFirst = false; runHeavy(); return; }
    heavyPending = true;
    $('#risk-total').classList.add('stale'); $('#strategies').classList.add('stale'); // se atenúan mientras se actualizan
    if (!dragging) heavyTimer = setTimeout(runHeavy, 140);
  }
  function runHeavy() {
    heavyPending = false;
    if (baseStale) { base = structuredClone(state); baseStale = false; }
    renderRisk(heavyArgs); renderStrategies();
    $('#risk-total').classList.remove('stale'); $('#strategies').classList.remove('stale');
  }
  function endDrag() { // al soltar el slider se calcula lo pendiente
    if (!dragging) return;
    dragging = false;
    if (heavyPending) { clearTimeout(heavyTimer); heavyTimer = setTimeout(runHeavy, 30); }
  }

  function renderRisk(port) {
    const r = finance.risk(state, port, rateOf, inputsOf(state)), el = $('#risk-total'), pc = x => (x * 100).toFixed(1).replace('.', ',') + ' %';
    el.textContent = `Riesgo: ${r.level} (${r.score}/100)`;
    el.className = 'total' + (r.color ? ' risk-' + r.color : '');
    el.title = `Nota de riesgo ${r.score}/100: hasta 50 es la probabilidad de quedarte sin dinero antes de acabar la jubilación (300 simulaciones); por encima, cuánto antes se agota\n`
      + `Probabilidad de quedarte sin dinero: ${Math.round(r.prob * 100)} %\n`
      + `Fondos: volatilidad ${pc(r.vol)}` + (r.maxDD != null ? `, caída máxima ${pc(r.maxDD)} (histórico real de ${r.histYears.toFixed(1).replace('.', ',')} años)` : ' (estimada, sin histórico)') + '\n'
      + (r.divRatio != null ? `Diversificación: ${r.divRatio.toFixed(2).replace('.', ',')} (1 = ninguna; más alto = mejor)\n` : '')
      + (r.inflSd != null ? `Inflación: varía ±${(r.inflSd * 100).toFixed(1).replace('.', ',')} pts al año (últimos ${r.inflYears} años)\n` : 'Inflación: sin datos históricos, se supone constante\n')
      + `Rentabilidad esperada usada: ${pc(r.exp)}` + (r.capped ? ' (limitada a la del mercado global)' : '');
  }

  /** Marca en rojo (pesimista) o verde (demasiado optimista) los campos con valores extremos. */
  function renderExtremes() {
    const out = (r, v) => r && ((r.gt != null && v > r.gt) || (r.lt != null && v < r.lt));
    cached('fields', '.field[data-field]').forEach(el => {
      const key = el.dataset.field, rule = config.EXTREMES[key];
      const v = rule?.pctOfNet ? (state.net > 0 ? (valueOf(key) / state.net) * 100 : NaN) : valueOf(key);
      let hit = !rule || !Number.isFinite(v) ? null : out(rule.bad, v) ? 'bad' : out(rule.good, v) ? 'good' : null, warn = false, own = '';
      if (key === 'retIncome' && lastRes) { // lo que retiras se colorea según el % anual sobre el capital, igual que el indicador de arriba
        const w = wrState(lastRes), r = lastRes.withdrawalRate, p = Number.isFinite(r) ? ` (${pct(r)} del capital al año)` : '';
        hit = w === 'bad' ? 'bad' : w === 'ok' && hit === 'good' ? 'good' : null; warn = w === 'warn';
        own = w === 'bad' ? 'Retirada muy alta' + p + (lastRes.depleted !== null ? ': el dinero se agota' : '') : warn ? 'Retirada alta' + p + ': por encima del 4 % empieza a ser arriesgado' : '';
      }
      el.classList.toggle('is-bad', hit === 'bad'); el.classList.toggle('is-good', hit === 'good'); el.classList.toggle('is-orange', warn);
      const of = rule?.pctOfNet && Number.isFinite(v) ? ` (${Math.round(v)} % de tu sueldo neto actual, en € de hoy)` : '';
      const title = own || (hit === 'bad' ? 'Valor extremo: muy pesimista' + of : hit === 'good' ? 'Valor extremo: demasiado optimista' + of : '');
      if (el.title !== title) el.title = title;
    });
  }

  const wrState = res => (res.depleted !== null || res.withdrawalRate > 0.06 ? 'bad' : res.withdrawalRate > 0.04 ? 'warn' : 'ok'); // naranja desde el 4 %, rojo desde el 6 % o si el dinero se agota
  let kpiEls = null; // las 4 tarjetas se crean una vez; luego solo cambian sus textos
  function renderKpis(res) {
    const rate = res.withdrawalRate, wr = wrState(res);
    const items = [
      ['Capital al jubilarte', eur.format(res.capital), ''],
      ['Retirada anual', Number.isFinite(rate) ? pct(rate) : '—', wr],
      ['Rentab. real', pct(res.realReturn), ''],
      ['Estado', res.depleted ? `Se agota año ${res.depleted}` : 'Sostenible', res.depleted ? 'bad' : 'ok'],
    ];
    if (!kpiEls) { kpiEls = items.map(([l]) => h('div', { class: 'kpi' }, h('small', {}, l), h('b'))); $('#kpis').replaceChildren(...kpiEls); }
    items.forEach(([, v, c], i) => { const d = kpiEls[i], cls = 'kpi ' + c; setText(d.lastChild, v); if (d.className !== cls) d.className = cls; });
  }

  const STRAT_KEYS = ['net', 'needs', 'leisure', 'invest', 'investAuto', 'touched', 'initial', 'workYears', 'retireYears', 'inflation', 'brokerFee', 'retLinked', 'retNeeds', 'retLeisure', 'tax'];
  let stratCache = null, stratDomKey = null;
  function renderStrategies() {
    $$('#strat-base button').forEach(b => b.classList.toggle('on', b.dataset.sb === state.stratBase));
    const a = config.AVERAGE_PROFILE;
    $('#strat-note').textContent = state.stratBase === 'avg'
      ? `Calculadas con un perfil de salario medio (${eur.format(a.net)}/mes, ${a.workYears} años trabajando y ${a.retireYears} de jubilación); se mantienen tu inflación, comisión del bróker e impuestos. Cada estrategia elige sus propios fondos.`
      : 'Calculadas con los datos que has introducido (tu sueldo, gastos, ahorro inicial y años).';
    const start = base || state, source = state.stratBase === 'avg' ? finance.averageProfile(start) : start;
    // Las estrategias ignoran tus fondos (cada una fija los suyos): solo dependen de estos datos, del histórico y de los datos de mercado
    const hr = histRange(), key = JSON.stringify([STRAT_KEYS.map(k => source[k]), hr.from, hr.to, data.status().count, data.status().mode, data.terDate(), data.version()]);
    if (!stratCache || stratCache.key !== key) stratCache = { key, list: finance.strategies(source, rateOf, inputsOf) };
    if (stratDomKey === key + '|' + active) return;
    stratDomKey = key + '|' + active;
    $('#strategies').replaceChildren(...stratCache.list.map(st =>
      h('button', { type: 'button', class: 'strategy' + (st.id === active ? ' active' : ''), disabled: st.unavailable ? '' : null,
        onclick: () => { applyState(st.state); active = st.id; refresh(false); } },
        h('b', {}, st.title), h('p', {}, st.unavailable ? 'No es alcanzable con tus datos actuales.' : st.desc),
        st.unavailable ? null : h('div', { class: 'tags' },
          h('span', {}, `Trabajas ${st.state.workYears} años`), h('span', {}, `Capital ${eur.format(st.res.capital)}`),
          h('span', { title: `Bruto que sale de las inversiones el primer año: ${eur.format(st.res.spend)}/mes` }, `Retiras ${eur.format(st.res.net)}/mes netos`), h('span', { class: st.risk.color ? 'risk-' + st.risk.color : '' }, `Riesgo ${st.risk.level} (${st.risk.score}/100)`)))));
  }

  /* ---------- Mis supuestos: guardar, renombrar, exportar e importar ---------- */
  let editingId = null, msgTimer = 0;
  const saveScenarios = () => storage.set(config.STORAGE.scenarios, scenarios);
  const nextId = () => Math.max(Date.now(), ...scenarios.map(s => s.id + 1));
  const uniqueName = name => { const used = new Set(scenarios.map(s => s.name)); let n = name, i = 2; while (used.has(n)) n = `${name.slice(0, 34)} (${i++})`; return n; };
  function say(text, kind = 'ok') {
    const m = $('#sc-msg'); m.textContent = text; m.className = 'sc-msg ' + kind; m.hidden = !text;
    clearTimeout(msgTimer); if (text && kind === 'ok') msgTimer = setTimeout(() => { m.hidden = true; }, 7000);
  }

  async function copyText(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* se prueba el método antiguo */ }
    try {
      const ta = h('textarea', { readonly: '', style: 'position:fixed;top:0;left:0;opacity:0' }); ta.value = text;
      document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
  async function exportScenario(sc) {
    const code = scenarioCode.encode(sc);
    if (await copyText(code)) say(`Código de «${sc.name}» copiado. Pégalo donde quieras guardarlo o enviarlo.`);
    else { say('No se pudo copiar automáticamente: copia el código del cuadro que se abre.', 'err'); window.prompt('Copia este código (Ctrl+C):', code); }
  }
  function importCode(text) {
    try {
      const { name, state: st } = scenarioCode.decode(text);
      const sc = { id: nextId(), name: uniqueName(name), state: st };
      scenarios.push(sc); saveScenarios();
      $('#sc-code').value = ''; $('#sc-io').hidden = true;
      renderScenarios(true); say(`Supuesto «${sc.name}» importado. Pulsa «Cargar» para usarlo.`);
    } catch (e) { say(e.message, 'err'); }
  }

  function startRename(sc) {
    editingId = sc.id; renderScenarios(true);
    const input = $('.sc-name'); if (input) { input.focus(); input.select(); }
  }
  function finishRename(sc, value) {
    if (editingId !== sc.id) return; // ya terminado (Enter/Escape): el blur posterior no hace nada
    editingId = null;
    const name = value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name) sc.name = name;
    saveScenarios(); renderScenarios(true);
  }

  let scenarioSig = null;
  function renderScenarios(force = false) {
    if (editingId !== null && !force) return; // no pisar el campo mientras se escribe el nombre
    const sig = JSON.stringify(scenarios);
    if (!force && sig === scenarioSig) return; // la lista no cambió: no se reconstruye
    scenarioSig = sig;
    const summary = sc => {
      const s = sc.state, m = s.period === 'year' ? 12 : 1, u = s.period === 'year' ? '/año' : '/mes';
      return `Neto ${eur.format(s.net * m)}${u} · invierte ${eur.format(s.invest * m)}${u} · inicial ${eur.format(s.initial)} · ${s.workYears} años · inflación ${s.inflation} % · histórico ${s.histFrom || s.histTo ? `${s.histFrom ?? '…'}–${s.histTo ?? 'hoy'}` : 'por defecto'} · bróker ${s.brokerFee} % · impuestos ${taxes.label(s.tax)} · `
        + Object.entries(s.alloc).map(([id, w]) => `${id} ${round(w, 1)} %`).join(', ');
    };
    const nameCell = sc => {
      if (editingId !== sc.id) return h('b', { title: 'Doble clic para renombrar', ondblclick: () => startRename(sc) }, sc.name);
      const input = h('input', { type: 'text', class: 'sc-name', maxlength: 40, value: sc.name, 'aria-label': 'Nuevo nombre del supuesto',
        onkeydown: e => { if (e.key === 'Enter') finishRename(sc, input.value); else if (e.key === 'Escape') { editingId = null; renderScenarios(true); } },
        onblur: () => finishRename(sc, input.value) });
      return input;
    };
    $('#scenarios').replaceChildren(...scenarios.map(sc => h('li', {},
      h('div', { class: 'sc-head' }, nameCell(sc),
        h('div', { class: 'sc-btns' },
          h('button', { type: 'button', onclick: () => loadScenario(sc) }, 'Cargar'),
          h('button', { type: 'button', title: 'Guarda aquí los datos actuales', onclick: () => { sc.state = structuredClone(state); saveScenarios(); renderScenarios(true); } }, 'Actualizar'),
          h('button', { type: 'button', title: 'Cambiar el nombre', onclick: () => startRename(sc) }, 'Renombrar'),
          h('button', { type: 'button', title: 'Copia al portapapeles un código con todos los datos de este supuesto', onclick: () => exportScenario(sc) }, 'Exportar'),
          h('button', { type: 'button', class: 'del', title: 'Borrar', onclick: () => { scenarios = scenarios.filter(x => x.id !== sc.id); saveScenarios(); renderScenarios(true); } }, '✕'))),
      h('small', {}, summary(sc)))));
  }


  /* ---------- Impuestos de la jubilación ---------- */
  const nfs = new Map(), syms = new Map(); // los formateadores de números se crean una vez por moneda
  const fmtMoney = (v, cur) => {
    let nf = nfs.get(cur);
    if (!nf) { try { nf = new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur, maximumFractionDigits: 0 }); } catch { nf = { format: x => Math.round(x) + ' ' + cur }; } nfs.set(cur, nf); }
    return nf.format(v);
  };
  const curSym = cur => {
    if (!syms.has(cur)) { let s; try { s = new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency').value; } catch { s = cur; } syms.set(cur, s); }
    return syms.get(cur);
  };
  const nomFactor = () => Math.pow(1 + state.inflation / 100, state.workYears); // inflación acumulada hasta jubilarte

  /** Descripción bajo "Ingresos de la inversión": neto, bruto e impuestos del primer año de jubilación, y lo mismo sin ajustar a inflación. */
  function renderRetInfo(res) {
    const def = taxes.resolve(state.tax), m = factor(), f = nomFactor(), per = state.period === 'year' ? '/año' : '/mes';
    const v = x => eur.format(x * m) + per, n = x => eur.format(x * m * f) + per, rate = res.spend > 0 ? 1 - res.net / res.spend : 0;
    setText(dom.l1 ||= $('#ret-l1'), `Neto ${v(res.net)} · bruto ${v(res.spend)} · impuestos ${pct(rate)} (${def.label})`);
    setText(dom.l2 ||= $('#ret-l2'), `Sin ajustar a inflación (año ${state.workYears}): neto ${n(res.net)} · bruto ${n(res.spend)}`);
  }

  function openTax() { renderTax(); const d = $('#tax-dlg'); if (!d.open) d.showModal(); }
  /** Pasa los impuestos actuales a «Personalizado» (copia los tramos del país elegido) para poder editarlos. */
  function ensureCustom() {
    if (state.tax.country === 'CUSTOM' && state.tax.custom) return state.tax.custom;
    const d = taxes.resolve(state.tax);
    state.tax.custom = { from: d.label + (d.year ? ' (' + d.year + ')' : ''), currency: d.currency, fx: d.fx, on: d.on, inclusion: d.inclusion, allowance: d.allowance, divRate: d.divRate ?? null, brackets: structuredClone(d.brackets), social: structuredClone(d.social) };
    state.tax.country = 'CUSTOM';
    return state.tax.custom;
  }
  function syncTaxHead() {
    const isC = state.tax.country === 'CUSTOM', sel = $('#tax-country'), from = $('#tax-from');
    if (sel) sel.value = state.tax.country;
    $('#tax-scale-wrap')?.remove();
    if (from) { from.hidden = !isC; from.textContent = isC ? `Basado en: ${state.tax.custom?.from || 'tus datos'}. Cualquier cambio queda como «Personalizado»; elige un país para volver a sus valores.` : ''; }
  }

  function renderTax() {
    const def = taxes.resolve(state.tax), cur = def.currency, sym = curSym(cur), country = def.custom ? null : taxes.countries().find(x => x.id === def.id);
    const infl = String(round(state.inflation, 2)).replace('.', ',');
    const sel = h('select', { id: 'tax-country', 'aria-label': 'País' }, ...taxes.countries().map(x => h('option', { value: x.id }, x.name)), h('option', { value: 'CUSTOM' }, '✏️ Personalizado'));
    sel.value = state.tax.country;
    const scaleSel = country && country.scales.length > 1 ? h('select', { id: 'tax-scale', 'aria-label': 'Tributa como' }, ...country.scales.map(s => h('option', { value: s.id }, s.name))) : null;
    if (scaleSel) scaleSel.value = def.scaleId;
    const last = def.brackets.length - 1;
    const rows = def.brackets.map((b, i) => h('tr', {},
      h('td', {}, i === last ? h('span', { class: 'muted' }, 'en adelante') : h('input', { type: 'number', min: 0, step: 'any', 'data-t': 'up', 'data-i': i, value: round(b.upTo), 'aria-label': 'Base imponible hasta' })),
      h('td', {}, h('input', { type: 'number', class: 'rate', min: 0, max: 99, step: 'any', 'data-t': 'rate', 'data-i': i, value: round(b.rate), 'aria-label': 'Tipo' }), ' %'),
      h('td', { class: 'num t-paid', 'data-i': i }),
      h('td', { class: 'num t-nom', 'data-i': i }),
      h('td', {}, def.brackets.length > 1 ? h('button', { type: 'button', class: 'del-x', 'data-t': 'del', 'data-i': i, title: 'Quitar tramo' }, '✕') : null)));
    const social = def.social.map((x, i) => h('div', { class: 'soc-row' },
      h('input', { type: 'text', 'data-t': 'soc-name', 'data-i': i, value: x.name, maxlength: 40, 'aria-label': 'Nombre' }),
      h('input', { type: 'number', class: 'rate', min: 0, max: 99, step: 'any', 'data-t': 'soc-rate', 'data-i': i, value: round(x.rate), 'aria-label': 'Porcentaje' }), h('span', { class: 'suf' }, '%'),
      h('button', { type: 'button', class: 'del-x', 'data-t': 'soc-del', 'data-i': i, title: 'Quitar' }, '✕')));
    const onSel = h('select', { 'data-t': 'on', 'aria-label': 'Qué tributa' }, h('option', { value: 'gain' }, 'Solo la ganancia'), h('option', { value: 'all' }, 'Toda la retirada'));
    onSel.value = def.on;
    const curSel = h('select', { 'data-t': 'cur', 'aria-label': 'Moneda de los importes' }, ...['EUR', ...taxes.currencies()].map(c => h('option', { value: c }, c)));
    curSel.value = def.currency;
    const fxTxt = cur !== 'EUR' ? ` Tipo de cambio: ${String(round(def.fx, 4)).replace('.', ',')} ${cur} por €${taxes.fxDate() && !def.custom ? ' (' + new Date(taxes.fxDate()).toLocaleDateString('es-ES') + ')' : ''}.` : '';
    $('#tax-body').replaceChildren(
      h('div', { class: 'tax-row' },
        h('label', {}, 'País', sel), scaleSel ? h('label', { id: 'tax-scale-wrap' }, 'Tributa como', scaleSel) : null),
      h('p', { class: 'note', id: 'tax-from', hidden: '' }),
      h('p', { class: 'note' }, def.on === 'gain'
        ? 'Solo paga impuestos la parte de lo que retiras que es ganancia; el resto es dinero que ya habías aportado. Se calcula con el coste medio de tus aportaciones.'
        : 'Se aplican a toda la retirada, como si fuera un sueldo o una pensión.'),
      h('p', { class: 'note' }, `Importes en € de hoy. Los tramos son los de hoy y se supone que se ajustan a la inflación cada año (${infl} %), por eso en la simulación siempre valen lo mismo. La columna «nominal» muestra cuánto valdría cada límite sin ajustar a inflación el primer año de jubilación (año ${state.workYears}).`),
      !def.custom && def.note ? h('p', { class: 'note' }, def.note + (def.approx ? ' (Valores aproximados.)' : '')) : null,
      h('h3', { class: 'tax-h' }, `Tramos (${sym} al año)`),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tax-tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Base imponible hasta'), h('th', {}, 'Tipo'), h('th', {}, 'Pagas al año (€ de hoy)'), h('th', {}, `Límite nominal, año ${state.workYears}`), h('th', {}))),
        h('tbody', {}, ...rows))),
      h('div', { class: 'tax-row' },
        h('button', { type: 'button', class: 'btn ghost', 'data-t': 'add' }, '+ Añadir tramo'),
        h('label', {}, `Mínimo exento (${sym}/año)`, h('input', { type: 'number', min: 0, step: 'any', 'data-t': 'allow', value: round(def.allowance) }))),
      h('div', { class: 'tax-row' },
        h('label', {}, 'Tributa', onSel),
        h('label', {}, 'Parte de la base que tributa', h('input', { type: 'number', class: 'rate', min: 0, max: 100, step: 'any', 'data-t': 'incl', value: round((def.inclusion ?? 1) * 100) }), ' %')),
      h('div', { class: 'tax-row' },
        h('label', {}, 'Impuesto sobre dividendos', h('input', { type: 'number', class: 'rate', min: 0, max: 99, step: 'any', 'data-t': 'div', value: round(taxes.divTax(def) * 100, 2) }), ' %'),
        h('label', {}, 'Moneda de los importes', curSel),
        def.currency !== 'EUR' ? h('label', {}, '1 € =', h('input', { type: 'number', class: 'rate', min: 0, step: 'any', 'data-t': 'fx', value: round(def.fx, 4) }), ` ${def.currency}`) : null),
      h('h3', { class: 'tax-h' }, 'Seguridad social'),
      social.length ? h('div', {}, ...social) : h('p', { class: 'note' }, 'No se aplica: vender fondos de inversión no cotiza a la Seguridad Social. Si en tu caso sí, añádela aquí.'),
      h('button', { type: 'button', class: 'btn ghost', 'data-t': 'soc-add' }, '+ Añadir cotización'),
      h('h3', { class: 'tax-h' }, 'Resultado con tu plan (primer año de jubilación)'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tax-tbl', id: 'tax-sum' })),
      h('p', { class: 'note' }, (def.custom ? 'Tramos personalizados.' : `Datos de referencia ${def.year}${def.approx ? ' (aproximados)' : ''}.`) + fxTxt));
    syncTaxHead();
    updateTaxPreview();
  }

  /** Rellena lo que depende del plan (lo que pagas por tramo y el resumen) sin tocar los campos que se están editando. */
  function updateTaxPreview() {
    if (!$('#tax-sum') || !lastRes) return;
    const def = taxes.resolve(state.tax), f = nomFactor(), gross = lastRes.spend * 12, q = lastRes.q0, base = taxes.taxable(def, gross, q), c = taxes.calc(def, base);
    $$('#tax-body .t-paid').forEach(td => { td.textContent = eur.format(c.rows[td.dataset.i]?.tax ?? 0); });
    $$('#tax-body .t-nom').forEach(td => { const b = def.brackets[td.dataset.i]; td.textContent = b?.upTo == null ? '—' : fmtMoney(b.upTo * f, def.currency); });
    const line = (label, y, cls) => h('tr', { class: cls || null }, h('th', {}, label), h('td', { class: 'num' }, eur.format(y)), h('td', { class: 'num' }, eur.format(y / 12)), h('td', { class: 'num' }, eur.format((y / 12) * f)));
    $('#tax-sum').replaceChildren(
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '€ de hoy / año'), h('th', {}, '€ de hoy / mes'), h('th', {}, `€ nominales / mes (año ${state.workYears})`))),
      h('tbody', {},
        line('Bruto retirado de las inversiones', gross),
        def.on === 'gain' ? line(`   de los que ganancia (${pct(q)})`, base, 'sub') : null,
        c.social > 0 || def.social.length ? line('− Seguridad social', c.social) : null,
        line(c.social > 0 || def.social.length ? '− Impuesto sobre la renta' : '− Impuestos', c.income),
        line('= Neto que cobras', gross - c.tax, 'tot')),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 4, class: 'muted' }, `Tipo medio sobre lo retirado ${pct(gross > 0 ? c.tax / gross : 0)} · tipo marginal ${pct(c.marginal)}`))));
  }

  function initTax() {
    const dlg = $('#tax-dlg'), body = $('#tax-body');
    $('#tax-close').addEventListener('click', () => dlg.close());
    body.addEventListener('focusout', e => { if (e.target.matches?.('input[type=number]') && e.target.value.trim() === '') renderTax(); }); // un campo vacío vuelve a su valor
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    body.addEventListener('change', e => {
      const el = e.target, t = el.dataset.t;
      if (el.id === 'tax-country') { if (el.value === 'CUSTOM') ensureCustom(); else { state.tax.country = el.value; state.tax.scale = null; } refresh(); renderTax(); }
      else if (el.id === 'tax-scale') { state.tax.scale = el.value; refresh(); renderTax(); }
      else if (t === 'on') { ensureCustom().on = el.value === 'all' ? 'all' : 'gain'; refresh(); renderTax(); }
      else if (t === 'cur') { const c = ensureCustom(); c.currency = el.value; c.fx = taxes.fxFor(el.value); refresh(); renderTax(); }
      else if (t === 'up' && state.tax.custom) { // al salir del campo se reordenan los tramos
        const c = state.tax.custom, before = JSON.stringify(c.brackets.map(b => b.upTo));
        c.brackets = taxes.normBrackets(c.brackets); refresh();
        if (before !== JSON.stringify(c.brackets.map(b => b.upTo))) renderTax();
      }
    });
    body.addEventListener('input', e => {
      const el = e.target, t = el.dataset.t, i = Number(el.dataset.i), v = parseFloat(el.value);
      if (!t || el.tagName !== 'INPUT' || (t !== 'soc-name' && !Number.isFinite(v))) return;
      const c = ensureCustom();
      if (t === 'up') { if (v > 0) c.brackets[i].upTo = v; }
      else if (t === 'rate') c.brackets[i].rate = clamp(v, 0, 99);
      else if (t === 'allow') c.allowance = Math.max(0, v);
      else if (t === 'incl') c.inclusion = clamp(v, 0, 100) / 100;
      else if (t === 'div') c.divRate = clamp(v, 0, 99);
      else if (t === 'fx') c.fx = Math.max(1e-4, v);
      else if (t === 'soc-rate') c.social[i].rate = clamp(v, 0, 99);
      else if (t === 'soc-name') c.social[i].name = el.value.slice(0, 40);
      else return;
      syncTaxHead(); refresh(); // el resumen se repinta en render()
    });
    body.addEventListener('click', e => {
      const b = e.target.closest('button[data-t]'); if (!b) return;
      const t = b.dataset.t, i = Number(b.dataset.i), c = ensureCustom();
      if (t === 'add') {
        if (c.brackets.length >= 60) return;
        const fin = c.brackets.filter(x => x.upTo != null), lastUp = fin.length ? fin[fin.length - 1].upTo : 0;
        c.brackets.splice(c.brackets.length - 1, 0, { upTo: Math.round(lastUp ? lastUp * 1.5 : 10000), rate: c.brackets.at(-1).rate });
      } else if (t === 'del') { c.brackets.splice(i, 1); c.brackets = taxes.normBrackets(c.brackets); }
      else if (t === 'soc-add') { if (c.social.length < 10) c.social.push({ name: 'Seguridad social', rate: 0 }); }
      else if (t === 'soc-del') c.social.splice(i, 1);
      else return;
      refresh(); renderTax();
    });
  }

  /** Cargar un supuesto: sus datos sustituyen a los actuales, pero tus fondos personalizados se quedan y se añaden los del supuesto (solo los borras tú). */
  function loadScenario(sc) {
    const next = scenarioCode.clean(sc.state), mine = state.customFunds, used = new Set(mine.map(d => d.id)), add = [], remap = {};
    for (const d of next.customFunds) {
      const same = mine.find(x => x.id === d.id);
      if (same && JSON.stringify(same) === JSON.stringify(d)) continue; // ya lo tienes igual
      let nd = d;
      if (same) { nd = { ...d, id: customFunds.newId(used) }; remap[d.id] = nd.id; } // mismo identificador pero otros datos: entra como un fondo más
      used.add(nd.id); add.push(nd);
    }
    const rename = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [remap[k] || k, v]));
    next.alloc = rename(next.alloc); next.prov = rename(next.prov);
    next.customFunds = [...mine, ...add];
    const keep = state.stratBase; Object.assign(state, next); state.stratBase = keep;
    refresh();
  }

  /* ---------- Fondos personalizados ---------- */
  const openCustom = new Set(); // filas desplegadas
  let customSig = null, draft = null, draftStep = 1, fundEditId = null, taxedTouched = false;
  const comma = (v, d = 2) => String(round(v, d)).replace('.', ',');
  const baseName = d => d.mimic && config.FUNDS.find(x => x.id === d.mimic.fund)?.name;

  /** Filas de los fondos personalizados (se reconstruyen solo cuando cambia la lista, el nombre o a quién imitan). */
  function renderCustomRows() {
    const sig = JSON.stringify(state.customFunds.map(d => [d.id, d.name, d.kind, d.mimic?.fund || '']));
    if (sig === customSig) return;
    customSig = sig;
    $('#custom-funds').replaceChildren(...state.customFunds.map(customRow));
  }

  function customRow(d) {
    return h('div', { class: 'fund custom', 'data-fund': d.id, 'data-custom': '1' },
      h('input', { type: 'checkbox', id: 'f-' + d.id, 'data-fcheck': d.id }),
      h('div', { class: 'fmain' },
        h('div', { class: 'cname' }, h('label', { for: 'f-' + d.id }, h('b', {}, d.name)), h('span', { class: 'cbadge' }, d.kind === 'etf' ? 'ETF' : 'Fondo indexado')),
        h('small', { class: 'csub' }), h('small', { class: 'cmoves' }),
        h('div', { class: 'cbtns' },
          h('button', { type: 'button', 'data-cact': 'toggle', 'data-cid': d.id, title: 'Tipo, movimientos entre fondos e impuestos' }, '▾'),
          h('button', { type: 'button', 'data-cact': 'edit', 'data-cid': d.id, title: 'Editar fondo' }, '✎'),
          h('button', { type: 'button', 'data-cact': 'del', 'data-cid': d.id, title: 'Borrar fondo', class: 'cdel' }, '✕'))),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': d.id }),
      h('span', { class: 'suf' }, '%'),
      fundPanel({ id: d.id }));
  }

  /** Panel desplegable de cualquier fondo: tipo (ETF o fondo indexado), movimientos al año, % que se mueve e impuestos de esos movimientos. */
  function fundPanel(f) {
    const slider = (label, key, max) => h('label', { class: 'cslide' }, h('span', {}, label), h('input', { type: 'range', min: 0, max, step: 1, [`data-${key}`]: f.id }), h('em', { 'data-out': key }));
    return h('div', { class: 'cpanel', hidden: '' },
      h('label', { class: 'switch kswitch', title: 'Tipo de producto: cambia la lista de gestores y su TER' }, h('span', {}, 'Fondo indexado'), h('input', { type: 'checkbox', 'data-ckind': f.id }), h('i'), h('span', {}, 'ETF')),
      h('small', { class: 'chint khint' }),
      slider('Movimientos al año', 'cperyear', 12), slider('% del fondo que mueves cada vez', 'cpct', 100),
      h('label', { class: 'check cchk' }, h('input', { type: 'checkbox', 'data-ctaxed': f.id }), 'Se pagan impuestos en estos movimientos'),
      h('small', { class: 'chint tnote' }, 'Sin impuestos, mover dinero no cambia el resultado.'));
  }

  /** Tipo y movimientos de un fondo: los del catálogo viven en state.fundCfg; los personalizados, en su definición. */
  function optsOf(f) {
    if (f.custom) { const d = state.customFunds.find(x => x.id === f.id) || {}; return { kind: d.kind === 'etf' ? 'etf' : 'index', perYear: d.perYear ?? 0, pct: d.pct ?? 0, taxed: !!d.taxed }; }
    const c = state.fundCfg[f.id] || {}, kind = finance.kindOf(state, f);
    return { kind, perYear: c.perYear ?? 0, pct: c.pct ?? 10, taxed: c.taxed ?? kind === 'etf' };
  }
  function setOpts(f, patch) {
    if (f.custom) { const d = state.customFunds.find(x => x.id === f.id); if (d) Object.assign(d, patch); }
    else state.fundCfg[f.id] = { ...(state.fundCfg[f.id] || {}), ...patch };
  }
  /** Cambiar entre ETF y fondo indexado: el gestor pasa a ser el más barato de ese tipo y los impuestos de los movimientos vuelven a su valor por defecto (ETF: sí; indexado: no). */
  function changeKind(f, kind) {
    if (f.custom) {
      const d = state.customFunds.find(x => x.id === f.id); if (!d) return;
      d.kind = kind; d.taxed = kind === 'etf';
      const b = d.mimic && config.FUNDS.find(x => x.id === d.mimic.fund);
      if (b && b.providers.some(p => p.kind === kind)) d.mimic.prov = finance.cheapest(b, kind).id;
    } else {
      state.fundCfg[f.id] = { ...(state.fundCfg[f.id] || {}), kind, taxed: kind === 'etf' };
      state.prov[f.id] = finance.cheapest(f, kind).id;
    }
  }

  function updateFundPanel(row, f, withTitle = true) {
    const o = optsOf(f), open = openCustom.has(f.id), d = f.custom ? state.customFunds.find(x => x.id === f.id) : null;
    if (f.custom && !d) return;
    const both = f.custom || (f.providers.some(p => p.kind === 'etf') && f.providers.some(p => p.kind === 'index'));
    $('.cpanel', row).hidden = !open; setText($('[data-cact="toggle"]', row), open ? '▴' : '▾');
    [['cperyear', o.perYear, v => `${v} al año`], ['cpct', o.pct, v => `${comma(v, 1)} %`]].forEach(([k, v, fmt]) => {
      const inp = $(`[data-${k}]`, row); if (document.activeElement !== inp && Number(inp.value) !== v) inp.value = v;
      setText($(`[data-out="${k}"]`, row), fmt(v));
    });
    const ck = $('[data-ckind]', row); if (ck.checked !== (o.kind === 'etf')) ck.checked = o.kind === 'etf'; ck.disabled = !both;
    const kh = $('.khint', row); kh.hidden = both; setText(kh, both ? '' : `En esta lista, este índice solo tiene ${f.providers[0].kind === 'etf' ? 'ETF' : 'fondos indexados'}.`);
    const tx = $('[data-ctaxed]', row); if (tx.checked !== o.taxed) tx.checked = o.taxed;
    $('.tnote', row).hidden = o.taxed; // sin impuestos los movimientos no cambian el resultado
    setText($('.cmoves', row), o.perYear > 0 && o.pct > 0 ? `${o.perYear} mov./año · mueve el ${comma(o.pct, 1)} % · ${o.taxed ? 'con impuestos' : 'sin impuestos'}` : (f.custom ? 'Sin movimientos' : ''));
    if (!f.custom) { setText($('.kbadge', row), o.kind === 'etf' ? 'ETF' : 'Fondo indexado'); return; }
    const bn = baseName(d);
    setText($('.csub', row), bn ? `Personalizado · imita a ${bn}` : 'Personalizado · fondo inventado');
    if (withTitle) { // se añade a la explicación de TER e inflación que ya puso renderFunds, sin borrarla
      const ret = $('.ret', row), pre = bn ? `Igual que ${bn}${Object.keys(d.vals || {}).length ? ', con tus cambios' : ''}` : 'Rentabilidad que has indicado para este fondo';
      ret.title = pre + ' · ' + ret.title;
    }
  }

  /* --- Ventana de añadir / editar --- */
  function openFundDialog(id) {
    const cur = id ? state.customFunds.find(x => x.id === id) : null;
    fundEditId = cur ? cur.id : null;
    draft = cur ? structuredClone(cur) : customFunds.blank(new Set(state.customFunds.map(x => x.id)));
    taxedTouched = !!cur; draftStep = 1;
    rateBasis = { div: state.showDividends !== false, ter: state.hideCosts === false, infl: state.hideCosts === false }; // empieza igual que la vista de la lista
    renderFundDlg();
    const dlg = $('#fund-dlg'); if (!dlg.open) dlg.showModal();
  }

  function renderFundDlg() {
    $('#fund-title').textContent = (fundEditId ? 'Editar fondo personalizado' : 'Añadir fondo personalizado') + ` · paso ${draftStep} de 2`;
    $('#fund-body').replaceChildren(draftStep === 1 ? fundStepOne() : fundStepTwo());
  }

  const segBtns = (opts, cur, pick) => h('div', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { type: 'button', class: v === cur ? 'on' : '', onclick: () => pick(v) }, l)));
  const dSlider = (label, key, min, max, step, fmt) => h('div', { class: 'field' },
    h('label', {}, label, h('em', { 'data-dout': key }, fmt(draft[key]))), h('input', { type: 'range', min, max, step, value: draft[key], 'data-d': key }));
  const FMT = { perYear: v => (v === 0 ? 'ninguno' : `${v} al año`), pct: v => `${comma(v, 1)} %` };

  function fundStepOne() {
    const bases = customFunds.baseFunds(), b = draft.mimic ? bases.find(f => f.id === draft.mimic.fund) : null;
    const taxed = h('input', { type: 'checkbox', 'data-d': 'taxed', checked: draft.taxed ? '' : null });
    const baseSel = h('select', { 'data-d': 'mimicFund', 'aria-label': 'Fondo al que imita' }, ...bases.map(f => h('option', { value: f.id }, f.name)));
    const ofKind = b ? b.providers.filter(p => p.kind === draft.kind) : [], provList = b ? (ofKind.length ? ofKind : b.providers) : []; // si el índice no tiene de este tipo, se muestran todos
    const provSel = b ? h('select', { 'data-d': 'mimicProv', 'aria-label': 'Gestor' }, ...provList.map(p => h('option', { value: p.id }, `${p.name}${provList === b.providers ? (p.kind === 'etf' ? ' · ETF' : ' · fondo indexado') : ''} · TER ${comma(p.ter)} %`))) : null;
    if (b) { baseSel.value = b.id; if (provList.some(p => p.id === draft.mimic.prov)) provSel.value = draft.mimic.prov; else draft.mimic.prov = provSel.value; }
    return h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Nombre'), h('input', { type: 'text', maxlength: 40, placeholder: 'Fondo personalizado', value: draft.name, 'data-d': 'name' })),
      h('div', { class: 'field' }, h('label', {}, 'Tipo'), segBtns([['index', 'Fondo indexado'], ['etf', 'ETF']], draft.kind, v => { draft.kind = v; if (!taxedTouched) draft.taxed = v === 'etf'; const bf = draft.mimic && customFunds.baseFunds().find(f => f.id === draft.mimic.fund); if (bf && bf.providers.some(p => p.kind === v)) draft.mimic.prov = finance.cheapest(bf, v).id; renderFundDlg(); })),
      h('p', { class: 'note' }, 'En España, mover dinero entre fondos indexados no paga impuestos; vender un ETF sí.'),
      dSlider('Movimientos entre fondos al año', 'perYear', 0, 12, 1, FMT.perYear),
      dSlider('% del fondo que mueves de media cada vez', 'pct', 0, 100, 1, FMT.pct),
      h('label', { class: 'check' }, taxed, 'Se pagan impuestos en estos movimientos'),
      h('div', { class: 'field' }, h('label', {}, '¿Imita a un fondo de la aplicación?'),
        segBtns([['no', 'No'], ['yes', 'Sí']], draft.mimic ? 'yes' : 'no', v => {
          if (v === 'yes' && !draft.mimic) { const f0 = bases[0]; draft.mimic = { fund: f0.id, prov: finance.cheapest(f0, draft.kind).id }; draft.vals = {}; }
          else if (v === 'no' && draft.mimic) { draft.mimic = null; draft.vals = { ...customFunds.DEFAULTS }; }
          renderFundDlg();
        })),
      draft.mimic ? h('div', { class: 'tax-row' }, h('label', {}, 'Fondo', baseSel), h('label', {}, 'Gestor', provSel)) : null,
      h('div', { class: 'tax-row dlg-btns' }, h('button', { type: 'button', class: 'btn ghost', 'data-fa': 'cancel' }, 'Cancelar'), h('button', { type: 'button', class: 'btn', 'data-fa': 'next' }, 'Continuar')));
  }

  /** En qué términos se escribe la rentabilidad en el paso 2 (con/sin dividendos, TER e inflación). No se guarda: es solo para comparar con la lista.
   *  Lo que se guarda siempre es la subida del precio, nominal y sin TER. Mismas cuentas que la cifra de cada fondo de la lista. */
  let rateBasis = { div: true, ter: false, infl: false };
  const inflF = () => (rateBasis.infl ? 1 + state.inflation / 100 : 1);
  const rateShown = (p, e) => ((1 + p / 100 + (rateBasis.div ? e.yield / 100 : 0) - (rateBasis.ter ? e.ter / 100 : 0)) / inflF() - 1) * 100;
  const rateStored = (v, e) => ((1 + v / 100) * inflF() - 1 - (rateBasis.div ? e.yield / 100 : 0) + (rateBasis.ter ? e.ter / 100 : 0)) * 100;
  const rateHint = () => `La escribes ${rateBasis.div ? 'con' : 'sin'} dividendos, ${rateBasis.ter ? 'descontando' : 'sin descontar'} el TER y ${rateBasis.infl ? `descontando la inflación (${comma(state.inflation)} %)` : 'sin descontar la inflación'}. Cambia estas opciones para compararla con la lista de fondos.`;
  const rateBasisRow = () => h('div', { class: 'fd-basis' }, ...[['div', 'Con dividendos'], ['ter', 'Descontando el TER'], ['infl', 'Descontando la inflación']].map(([k, l]) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-rb2': k, checked: rateBasis[k] ? '' : null }), l)));

  const FIELDS = [ // datos del fondo (paso 2)
    { k: 'rate', label: 'Rentabilidad anual media', hint: '', min: -8, max: 22, step: 0.1, unit: '%' },
    { k: 'yield', label: 'Dividendo anual bruto', hint: 'Lo que reparte el fondo cada año (o reinvierte, si acumula).', min: 0, max: 8, step: 0.1, unit: '%' },
    { k: 'ter', label: 'TER (comisión anual)', hint: 'Gastos corrientes del fondo.', min: 0, max: 2, step: 0.01, unit: '%' },
    { k: 'vol', label: 'Volatilidad anual', hint: 'Cuánto oscila el valor: la renta variable global ronda el 15 %, los bonos el 5 %.', min: 1, max: 40, step: 0.5, unit: '%' },
    { k: 'corr', label: 'Correlación con la renta variable global', hint: 'Diversificación: cuanto más baja, más se mueve distinto del mercado y menos riesgo añade a la cartera.', min: -0.5, max: 1, step: 0.05, unit: '', mimicHidden: true },
  ];

  function fundStepTwo() {
    const e = customFunds.effective(draft, rateOf), mim = !!draft.mimic;
    const rows = FIELDS.filter(f => !(mim && f.mimicHidden)).map(f => {
      const v = f.k === 'rate' ? rateShown(e.rate, e) : e[f.k], changed = mim && draft.vals[f.k] != null;
      return h('div', { class: 'field fd-field' },
        h('label', {}, f.label, h('span', { class: 'fd-r' }, changed ? h('button', { type: 'button', class: 'link', 'data-fa': 'reset', 'data-k': f.k, title: 'Volver al valor del fondo imitado' }, '↺ restablecer') : null)),
        h('div', { class: 'pair' }, h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: v, 'data-fv': f.k }),
          h('input', { type: 'number', step: 'any', value: round(v, 3), 'data-fv': f.k }), h('span', { class: 'suf' }, f.unit)),
        f.k === 'rate' ? rateBasisRow() : null,
        h('small', { class: 'muted', 'data-hint': f.k }, f.k === 'rate' ? rateHint() : f.hint));
    });
    const b = e.base;
    return h('div', {},
      h('p', { class: 'note' }, mim ? `Parte de ${b.name} (${e.provider.name}). Cambia solo lo que quieras: lo demás sigue igual que el fondo original${b ? ', incluida su rentabilidad del periodo de histórico elegido' : ''}.` : 'Valores típicos de un fondo de renta variable global. Ajústalos como quieras: con ellos se calculan el gráfico y el riesgo.'),
      ...rows,
      h('div', { class: 'tax-row dlg-btns' }, h('button', { type: 'button', class: 'btn ghost', 'data-fa': 'back' }, 'Atrás'), h('button', { type: 'button', class: 'btn', 'data-fa': 'save' }, 'Guardar')));
  }

  function saveFund() {
    const n = fundEditId ? state.customFunds.findIndex(x => x.id === fundEditId) + 1 : state.customFunds.length + 1;
    const d = customFunds.clean([{ ...draft, name: (draft.name || '').trim() || `Fondo personalizado ${n}` }])[0];
    if (!d) return;
    if (fundEditId) state.customFunds = state.customFunds.map(x => (x.id === fundEditId ? d : x));
    else state.customFunds.push(d);
    $('#fund-dlg').close(); refresh();
  }

  function deleteFund(id) {
    const d = state.customFunds.find(x => x.id === id); if (!d || !confirm(`¿Borrar «${d.name}»?`)) return;
    state.customFunds = state.customFunds.filter(x => x.id !== id);
    delete state.alloc[id]; delete state.prov[id]; openCustom.delete(id);
    if (!Object.keys(state.alloc).length) state.alloc = { ...config.DEFAULT_STATE.alloc };
    refresh();
  }

  function initFundDlg() {
    const dlg = $('#fund-dlg'), body = $('#fund-body');
    $('#fund-close').addEventListener('click', () => dlg.close());
    body.addEventListener('focusout', e => { if (e.target.matches?.('input[type=number]') && e.target.value.trim() === '') renderFundDlg(); }); // un campo vacío vuelve a su valor
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    body.addEventListener('input', e => {
      const el = e.target, dk = el.dataset.d, fv = el.dataset.fv;
      if (dk === 'name') draft.name = el.value;
      else if (dk === 'perYear' || dk === 'pct') { draft[dk] = parseFloat(el.value) || 0; $(`[data-dout="${dk}"]`, body).textContent = FMT[dk](draft[dk]); }
      else if (dk === 'taxed') { draft.taxed = el.checked; taxedTouched = true; }
      else if (fv) {
        const v = parseFloat(el.value); if (!Number.isFinite(v)) return;
        const lim = customFunds.LIMITS[fv];
        draft.vals[fv] = Math.min(lim[1], Math.max(lim[0], fv === 'rate' ? rateStored(v, customFunds.effective(draft, rateOf)) : v)); // la rentabilidad se guarda siempre como subida del precio
        $$(`[data-fv="${fv}"]`, body).forEach(o => { if (o !== el) o.value = fv === 'rate' ? el.value : el.type === 'range' ? round(draft.vals[fv], 3) : draft.vals[fv]; });
        if (fv === 'yield' || fv === 'ter') { // la cifra de rentabilidad que se ve depende de ellos: se actualiza
          const e2 = customFunds.effective(draft, rateOf), shown = round(rateShown(e2.rate, e2), 3);
          $$('[data-fv="rate"]', body).forEach(o => { if (document.activeElement !== o) o.value = shown; });
        }
        if (draft.mimic && !$(`[data-fa="reset"][data-k="${fv}"]`, body)) { const lab = el.closest('.fd-field').querySelector('.fd-r'); lab.replaceChildren(h('button', { type: 'button', class: 'link', 'data-fa': 'reset', 'data-k': fv, title: 'Volver al valor del fondo imitado' }, '↺ restablecer')); }
      }
    });
    body.addEventListener('change', e => {
      const el = e.target, dk = el.dataset.d;
      if (el.dataset.rb2) { rateBasis[el.dataset.rb2] = el.checked; renderFundDlg(); return; } // otros términos: se vuelve a calcular la cifra mostrada
      if (dk === 'mimicFund') { const f0 = customFunds.baseFunds().find(f => f.id === el.value); draft.mimic = { fund: f0.id, prov: finance.cheapest(f0, draft.kind).id }; draft.vals = {}; renderFundDlg(); }
      else if (dk === 'mimicProv') { draft.mimic.prov = el.value; delete draft.vals.ter; } // el TER vuelve a ser el del nuevo gestor
    });
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-fa]'); if (!b) return;
      const a = b.dataset.fa;
      if (a === 'cancel') dlg.close();
      else if (a === 'next') { if (!draft.name.trim()) draft.name = ''; draftStep = 2; renderFundDlg(); }
      else if (a === 'back') { draftStep = 1; renderFundDlg(); }
      else if (a === 'save') saveFund();
      else if (a === 'reset') { delete draft.vals[b.dataset.k]; renderFundDlg(); }
    });
  }

  function init() {
    buildInputs();
    $('#app-version').textContent = config.VERSION ? 'Versión ' + config.VERSION : '';
    [['avg', `Salario medio (${eur.format(config.AVERAGE_PROFILE.net)})`, 'Estrategias calculadas con un perfil estándar de salario medio'], ['mine', 'Mis datos', 'Estrategias calculadas con lo que has introducido tú']].forEach(([v, label, tip]) =>
      $('#strat-base').append(h('button', { type: 'button', 'data-sb': v, title: tip, onclick: () => { state.stratBase = v; refresh(false); } }, label)));
    const head = $('.top'), syncHead = () => document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px');
    new ResizeObserver(syncHead).observe(head); syncHead();
    chart.init($('#chart'), $('#tip'));
    initTax();
    initFundDlg();
    // Mientras un slider está pulsado no se calcula lo pesado (riesgo y estrategias), aunque pares un momento: se hace al soltarlo
    document.addEventListener('pointerdown', e => { if (e.target.matches?.('input[type=range]')) dragging = true; }, true);
    document.addEventListener('pointerup', endDrag, true); document.addEventListener('pointercancel', endDrag, true);
    document.addEventListener('change', e => { if (e.target.matches?.('input[type=range]')) endDrag(); }, true);
    document.addEventListener('pointermove', e => { if (dragging && e.buttons === 0) endDrag(); }, true);
    window.addEventListener('pagehide', flushSave); document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
    renderScenarios(true);
    document.addEventListener('input', e => { const t = e.target, el = t.closest?.('[data-key]'); if (el) set(el.dataset.key, el); else if (t.dataset?.hist) onHist(t.dataset.hist, t, false); });
    document.addEventListener('change', e => { if (e.target.dataset?.hist) onHist(e.target.dataset.hist, e.target, true); });
    // Si dejas un número vacío y sales del campo, se restaura el valor real (el estado no cambia mientras está vacío).
    document.addEventListener('focusout', e => { if (!e.target.closest?.('dialog') && e.target.matches?.('input[type=number]') && e.target.value.trim() === '') refresh(false); });
    $('#data-status').addEventListener('click', async () => { $('#data-status').textContent = 'Conectando…'; await data.loadAll(true); refresh(false); });
    // Importar un supuesto: cuadro donde pegar el código (o botón que lo lee del portapapeles)
    $('#sc-import-btn').addEventListener('click', () => { const io = $('#sc-io'); io.hidden = !io.hidden; say(''); if (!io.hidden) $('#sc-code').focus(); });
    $('#sc-close').addEventListener('click', () => { $('#sc-io').hidden = true; say(''); });
    $('#sc-do-import').addEventListener('click', () => importCode($('#sc-code').value));
    $('#sc-code').addEventListener('paste', () => setTimeout(() => importCode($('#sc-code').value), 0)); // al pegar se importa directamente
    $('#sc-paste').addEventListener('click', async () => {
      try { const text = await navigator.clipboard.readText(); $('#sc-code').value = text; importCode(text); }
      catch { say('Tu navegador no deja leer el portapapeles desde aquí: pega el código en el cuadro (Ctrl+V o mantén pulsado).', 'err'); $('#sc-code').focus(); }
    });
    $('#save-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#scenario-name');
      scenarios.push({ id: nextId(), name: uniqueName(input.value.trim() || `Supuesto ${scenarios.length + 1}`), state: structuredClone(state) });
      saveScenarios(); input.value = ''; renderScenarios(true);
    });
    refresh();
  }

  // Tras cargar datos externos, se repinta sin tocar la base de estrategias.
  App.ui = { init, refresh: () => refresh(false) };
})(window.App = window.App || {});
