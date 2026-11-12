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

  const state = Object.assign(structuredClone(config.DEFAULT_STATE), storage.get(config.STORAGE.settings, {}));
  if (!Object.keys(state.alloc || {}).length) state.alloc = { ...config.DEFAULT_STATE.alloc };
  state.prov = state.prov || {};
  state.tax = taxes.clean(state.tax); // impuestos guardados: se validan al abrir
  state.customFunds = customFunds.clean(state.customFunds); // fondos personalizados guardados
  if (!['net', 'gross'].includes(state.retBasis)) state.retBasis = 'net';
  delete state.histYears; // ajuste antiguo (años hacia atrás), sustituido por histFrom/histTo
  let base = null;          // últimos datos introducidos por el usuario: de aquí salen las estrategias
  let active = null;        // estrategia aplicada actualmente
  let scenarios = storage.get(config.STORAGE.scenarios, []);
  let raf = 0;
  // Ajustes de VISTA que una estrategia no debe pisar (antes, al aplicar una, volvía a "Salario medio" porque la copia guardaba el valor antiguo).
  const VIEW_KEYS = ['stratBase', 'period', 'showInvested', 'showPrice', 'showTotal', 'showNominal', 'showDividends', 'hideCosts', 'retBasis'];
  const applyState = next => { const keep = Object.fromEntries(VIEW_KEYS.map(k => [k, state[k]])); Object.assign(state, structuredClone(next), keep); };
  const factor = () => (state.period === 'year' ? 12 : 1);
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
  /** Periodo de histórico elegido: por defecto, desde que hay datos de TODOS los índices hasta el último dato. `years` = duración real. */
  function histRange(s = state) {
    const b = data.bounds();
    const to = clamp(s.histTo ?? b.max, b.min + 1, b.max), from = clamp(s.histFrom ?? b.common, b.min, to - 1);
    const startKey = (from - 1) * 12 + 11, endKey = to >= b.max ? b.lastKey : to * 12 + 11;
    return { from, to, b, years: (endKey - startKey) / 12 };
  }
  const rateOf = f => data.cagr(f, histRange());
  // Datos del riesgo: todo el histórico disponible (mín. 20 años, para que una ventana corta no oculte las grandes caídas) e inflación de los últimos 30 años
  const inputsOf = s => ({ market: data.portfolioStats(s.alloc, Math.max(Math.ceil(histRange(s).years), 20)), infl: data.inflationStats(30) });
  const mLabel = key => new Date(Date.UTC(Math.floor(key / 12), key % 12, 1)).toLocaleDateString('es-ES', { month: 'short', year: 'numeric', timeZone: 'UTC' });
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
      ...[['net', 'Neto'], ['gross', 'Bruto']].map(([v, l]) => h('button', { type: 'button', 'data-rb': v, onclick: () => { state.retBasis = v; refresh(false); } }, l)));
    return h('div', { class: 'ret-extra' }, seg,
      h('div', { class: 'ret-info' }, h('div', { id: 'ret-desc' }), h('button', { type: 'button', class: 'btn ghost', id: 'tax-open', onclick: openTax }, 'Ajustar impuestos')));
  }

  function buildField(f) {
    if (f.type === 'range2') return buildHistRange(f);
    const link = f.linked ? { 'data-linked': '' } : {};
    if (f.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': f.key }), f.label);
    const isMoney = MONEY.has(f.key);
    const row = h('div', { class: 'pair' },
      h('input', { type: 'range', 'data-key': f.key, min: f.min ?? 0, max: f.max, step: f.step, 'data-max': f.max, 'data-step': f.step, ...link }),
      h('input', { type: 'number', 'data-key': f.key, step: 'any', min: f.min ?? 0, inputmode: 'decimal', ...link }),
      h('span', { class: 'suf' }, isMoney ? '€' : f.suffix || ''));
    if (f.pct) row.append(h('input', { type: 'number', class: 'pct', 'data-key': f.pct, min: 0, max: 100, step: 'any', inputmode: 'decimal', ...link }), h('span', { class: 'suf' }, '%'));
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
        h('button', { type: 'button', class: 'plus', title: 'Añadir un fondo personalizado', 'aria-label': 'Añadir fondo personalizado', onclick: () => openFundDialog() }, '+'),
        h('button', { type: 'button', onclick: () => { config.FUNDS.forEach(f => { state.prov[f.id] = finance.cheapest(f).id; }); refresh(); } }, 'Gestor más barato'))));
    box.append(h('p', { class: 'fnote', id: 'funds-note' }));
    config.FUNDS.forEach(f => box.append(h('div', { class: 'fund', 'data-fund': f.id },
      h('input', { type: 'checkbox', id: 'f-' + f.id, 'data-fcheck': f.id }),
      h('div', { class: 'fmain' }, h('b', {}, f.name),
        h('select', { 'data-fprov': f.id, 'aria-label': 'Gestor' }, ...f.providers.map(p => h('option', { value: p.id })))),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': f.id }),
      h('span', { class: 'suf' }, '%'))));
    box.append(h('div', { id: 'custom-funds' }));
    box.append(h('div', { class: 'total-row' }, h('div', { class: 'total', id: 'alloc-total' }), h('div', { class: 'total', id: 'risk-total' })));
    box.addEventListener('input', e => {
      const c = e.target.dataset.fcheck, w = e.target.dataset.fw, p = e.target.dataset.fprov, cy = e.target.dataset.cperyear, cp = e.target.dataset.cpct;
      if (cy || cp) { // sliders de movimientos de un fondo personalizado
        const d = state.customFunds.find(x => x.id === (cy || cp)); if (!d) return;
        if (cy) d.perYear = Math.round(parseFloat(e.target.value) || 0); else d.pct = parseFloat(e.target.value) || 0;
        refresh(); return;
      }
      if (c) {
        if (e.target.checked) state.alloc[c] = Math.max(0, 100 - sumAlloc());
        else if (Object.keys(state.alloc).length > 1) delete state.alloc[c];
      } else if (w) state.alloc[w] = Math.max(0, parseFloat(e.target.value) || 0);
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
    else if (key === 'retIncome') setRetIncome(state.retBasis === 'gross' ? taxes.netOf(taxes.resolve(state.tax), (v / factor()) * 12, lastRes?.q0 ?? 1) / 12 : v / factor()); // en bruto: se convierte a neto con los impuestos
    else if (MONEY.has(key)) { state[key] = v / factor(); flag(key); }
    else state[key] = v;
    refresh(key !== 'showDividends' && key !== 'hideCosts'); // son solo de vista: no deben reiniciar la base de las estrategias
  }
  /** Cambia el periodo de histórico. Las casillas solo aceptan años de 4 cifras dentro del rango mientras escribes; al salir (commit) se ajusta. */
  function onHist(which, el, commit) {
    const b = data.bounds(), num = which === 'from' || which === 'to', v = Math.round(parseFloat(el.value));
    if (!Number.isFinite(v) || (num && !commit && (v < b.min || v > b.max || String(v).length < 4))) { if (commit) renderHist(); return; }
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
  function setRetIncome(v) {
    const inc = retIncome();
    if (inc > 0) { state.retNeeds *= v / inc; state.retLeisure *= v / inc; }
    else { state.retNeeds = v * 0.7; state.retLeisure = v * 0.3; }
  }
  function setRetShare(key, pctValue) {
    const inc = retIncome(), part = (inc * Math.min(100, Math.max(0, pctValue))) / 100;
    if (key === 'retNeedsPct') { state.retNeeds = part; state.retLeisure = inc - part; }
    else { state.retLeisure = part; state.retNeeds = inc - part; }
  }
  const valueOf = key => (key === 'retIncome' ? retIncome() : state[key]);
  function flag(k) {
    if (k === 'needs' || k === 'leisure') state.touched[k] = true;
    if (k === 'invest') state.investAuto = false;
  }
  function shown(key) {
    if (key in PCT) return state.net ? (state[PCT[key]] / state.net) * 100 : 0;
    if (key in RET_PCT) return retIncome() > 0 ? (state[RET_PCT[key]] / retIncome()) * 100 : 0;
    if (key === 'retIncome' && state.retBasis === 'gross' && lastRes) return lastRes.spend * factor(); // bruto del primer año de jubilación
    return MONEY.has(key) ? valueOf(key) * factor() : state[key];
  }

  /** userEdit = true: el usuario cambió algo → esos datos pasan a ser la base de las estrategias. */
  function refresh(userEdit = true) {
    finance.normalize(state);
    if (userEdit) { base = structuredClone(state); active = null; }
    storage.set(config.STORAGE.settings, state);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  /* ---------- Pintado ---------- */
  function render() {
    customFunds.sync(state.customFunds, rateOf); // los fondos personalizados entran en el catálogo antes de simular
    const port = finance.portfolio(state, rateOf), res = finance.simulate(state, port);
    lastRes = res;
    $$('[data-key]').forEach(el => {
      const key = el.dataset.key;
      if (el.type === 'checkbox') el.checked = key === 'periodYearly' ? state.period === 'year' : !!state[key];
      else {
        if (el.type === 'range' && MONEY.has(key)) { el.max = el.dataset.max * factor(); el.step = el.dataset.step * factor(); }
        const v = round(shown(key));
        if (document.activeElement !== el || Math.abs(Number(el.value) - v) > 0.01) el.value = v;
      }
      if ('linked' in el.dataset) el.disabled = state.retLinked;
    });
    $$('[data-unit]').forEach(e => { const b = e.closest('[data-field="retIncome"]') ? (state.retBasis === 'gross' ? ' bruto' : ' neto') : ''; e.textContent = `(€ / ${state.period === 'year' ? 'año' : 'mes'}${b})`; });
    $('#hint-nominal').hidden = !state.showNominal; $('.legend').classList.toggle('nominal-on', !!state.showNominal);
    renderHist();
    renderFunds();
    renderExtremes();
    renderRetInfo(res);
    $$('#ret-basis button').forEach(b => b.classList.toggle('on', b.dataset.rb === state.retBasis));

    chart.render(res, state);
    renderKpis(res);
    scheduleHeavy(port, res); // riesgo, estrategias y supuestos guardados: se calculan al soltar el slider
    const st = data.status(), badge = $('#data-status');
    badge.textContent = st.mode === 'live' ? `En vivo (${st.count}/${config.FUNDS.filter(f => !f.custom).length})` : st.mode === 'saved' ? `Datos del ${st.date || 'archivo local'}` : 'Sin datos · estimados (reintentar)';
    badge.classList.toggle('live', st.mode !== 'none');
    if ($('#tax-dlg').open) updateTaxPreview();
  }

  /** Aviso (vacío = todo bien) cuando a algún fondo elegido le faltan datos en el periodo seleccionado. */
  function histWarning() {
    if (data.status().mode === 'none') return 'Sin datos reales: la rentabilidad es una estimación fija y no cambia con los años.';
    const selected = Object.keys(state.alloc).map(id => config.FUNDS.find(x => x.id === id)).filter(f => f && !f.custom);
    const partial = selected.map(f => [f, rateOf(f)]).filter(([, r]) => !r.live || r.lateBy > 3);
    return partial.length ? `Sin histórico completo en este periodo: ${partial.map(([f, r]) => r.live ? `${f.name} (datos desde ${Math.floor(r.startKey / 12)})` : `${f.name} (sin datos: estimación fija)`).join(', ')}. Se usa el máximo disponible.` : '';
  }

  function renderHist(force = false) {
    const { from, to, b, years } = histRange(), q = w => $(`[data-hist="${w}"]`), span = b.max - b.min || 1;
    ['lo', 'hi', 'from', 'to'].forEach(w => { q(w).min = b.min; q(w).max = b.max; });
    q('lo').value = from; q('hi').value = to;
    if (force || document.activeElement !== q('from')) q('from').value = from;
    if (force || document.activeElement !== q('to')) q('to').value = to;
    const dual = $('.dual'); dual.style.setProperty('--lo', (from - b.min) / span); dual.style.setProperty('--hi', (to - b.min) / span);
    q('lo').style.zIndex = (from - b.min) / span > 0.5 ? 3 : 1; // si se juntan al final, el de la izquierda queda accesible
    const len = $('#hist-len'); len.textContent = '= ' + fmtYears(years);
    len.title = `Del cierre de ${mLabel((from - 1) * 12 + 11)} al de ${mLabel(to >= b.max ? b.lastKey : to * 12 + 11)}`;
    $('#hist-reset').hidden = state.histFrom == null && state.histTo == null;
    const text = histWarning(), warn = $('#hist-warn');
    warn.textContent = text; warn.hidden = !text;
    $('.field[data-field="histRange"]').classList.toggle('is-warn', !!text); // naranja suave: faltan datos (no es grave)
  }

  function renderFunds() {
    const infl = String(round(state.inflation, 2)).replace('.', ',');
    const divOn = state.showDividends !== false, hideOn = state.hideCosts !== false, tax = Math.round(config.DIV_TAX * 100);
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
      if (sel) { $$('option', sel).forEach((o, i) => { const p = f.providers[i]; o.textContent = `${p.name} · TER ${p.ter} %`; }); sel.value = finance.providerOf(state, f).id; sel.disabled = !on; }
      const w = $('[data-fw]', row); w.disabled = !on;
      if (document.activeElement !== w) w.value = on ? round(state.alloc[f.id]) : '';
      const ret = $('.ret', row); ret.textContent = pct(shownRate); ret.classList.toggle('neg', shownRate < 0);
      const costs = hideOn ? 'sin descontar inflación ni TER' : `descontados el TER (${terTxt}) y la inflación (${infl} %): (1 + rentabilidad − TER) ÷ (1 + inflación) − 1`;
      ret.title = (r.live ? `Rentabilidad anual media del índice entre ${mLabel(r.startKey)} y ${mLabel(r.endKey)} (${fmtYears(r.span)}): precio ${pct(r.rate)}${divOn ? ` + dividendo bruto ${pct(dy)}` : ', sin dividendos'}` : 'Estimación fija (sin datos reales en este periodo)') + '; ' + costs;
      $('.ter', row).textContent = 'TER ' + String(finance.providerOf(state, f).ter).replace('.', ',') + ' %';
      if (f.custom) updateCustomRow(row, f);
    });
    const t = sumAlloc(), el = $('#alloc-total');
    el.textContent = `Reparto: ${round(t, 1)} %` + (Math.abs(t - 100) > 0.1 ? ' (se normaliza a 100 %)' : '');
    el.classList.toggle('warn', Math.abs(t - 100) > 0.1);
    $('#ter-info').textContent = data.terDate() ? `TER actualizados: ${data.terDate()}` : 'TER de referencia';
  }

  /** Lo pesado (riesgo con 300 simulaciones y las 4 estrategias) se calcula cuando se deja de tocar: así sliders y datos responden al instante. */
  let heavyTimer = 0, heavyArgs = null, heavyFirst = true;
  function scheduleHeavy(port, res) {
    heavyArgs = [port, res];
    clearTimeout(heavyTimer);
    if (heavyFirst) { heavyFirst = false; runHeavy(); return; }
    $('#risk-total').classList.add('stale'); $('#strategies').classList.add('stale'); // se atenúan mientras se actualizan
    heavyTimer = setTimeout(runHeavy, 140);
  }
  function runHeavy() {
    const [port, res] = heavyArgs;
    renderRisk(port, res); renderStrategies(); renderScenarios();
    $('#risk-total').classList.remove('stale'); $('#strategies').classList.remove('stale');
  }

  function renderRisk(port, res) {
    const r = finance.risk(state, port, res, rateOf, inputsOf(state)), el = $('#risk-total'), pc = x => (x * 100).toFixed(1).replace('.', ',') + ' %';
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
    $$('.field[data-field]').forEach(el => {
      const key = el.dataset.field, rule = config.EXTREMES[key];
      const v = rule?.pctOfNet ? (state.net > 0 ? (valueOf(key) / state.net) * 100 : NaN) : valueOf(key);
      const hit = !rule || !Number.isFinite(v) ? null : out(rule.bad, v) ? 'bad' : out(rule.good, v) ? 'good' : null;
      el.classList.toggle('is-bad', hit === 'bad'); el.classList.toggle('is-good', hit === 'good');
      const of = rule?.pctOfNet && Number.isFinite(v) ? ` (${Math.round(v)} % de tu sueldo neto actual, en € de hoy)` : '';
      el.title = hit === 'bad' ? 'Valor extremo: muy pesimista' + of : hit === 'good' ? 'Valor extremo: demasiado optimista' + of : '';
    });
  }

  function renderKpis(res) {
    const rate = res.withdrawalRate, risky = res.depleted !== null || rate > 0.04;
    const items = [
      ['Capital al jubilarte', eur.format(res.capital), ''],
      ['Retirada anual', Number.isFinite(rate) ? pct(rate) : '—', risky ? 'bad' : 'ok'],
      ['Rentab. real', pct(res.realReturn), ''],
      ['Estado', res.depleted ? `Se agota año ${res.depleted}` : 'Sostenible', res.depleted ? 'bad' : 'ok'],
    ];
    $('#kpis').replaceChildren(...items.map(([l, v, c]) => h('div', { class: 'kpi ' + c }, h('small', {}, l), h('b', {}, v))));
  }

  let stratCache = null, stratDomKey = null;
  function renderStrategies() {
    $$('#strat-base button').forEach(b => b.classList.toggle('on', b.dataset.sb === state.stratBase));
    const a = config.AVERAGE_PROFILE;
    $('#strat-note').textContent = state.stratBase === 'avg'
      ? `Calculadas con un perfil de salario medio (${eur.format(a.net)}/mes, ${a.workYears} años trabajando y ${a.retireYears} de jubilación); se mantienen tus fondos, inflación y comisiones.`
      : 'Calculadas con los datos que has introducido (tu sueldo, gastos, ahorro inicial y años).';
    const start = base || state, source = state.stratBase === 'avg' ? finance.averageProfile(start) : start;
    const hr = histRange(), key = JSON.stringify([source, hr.from, hr.to, data.status().count, data.status().mode, data.terDate()]); // lo que, si no cambia, deja las estrategias igual
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
          h('button', { type: 'button', onclick: () => { const keep = state.stratBase; Object.assign(state, structuredClone(sc.state)); state.stratBase = keep; refresh(); } }, 'Cargar'),
          h('button', { type: 'button', title: 'Guarda aquí los datos actuales', onclick: () => { sc.state = structuredClone(state); saveScenarios(); renderScenarios(true); } }, 'Actualizar'),
          h('button', { type: 'button', title: 'Cambiar el nombre', onclick: () => startRename(sc) }, 'Renombrar'),
          h('button', { type: 'button', title: 'Copia al portapapeles un código con todos los datos de este supuesto', onclick: () => exportScenario(sc) }, 'Exportar'),
          h('button', { type: 'button', class: 'del', title: 'Borrar', onclick: () => { scenarios = scenarios.filter(x => x.id !== sc.id); saveScenarios(); renderScenarios(true); } }, '✕'))),
      h('small', {}, summary(sc)))));
  }


  /* ---------- Impuestos de la jubilación ---------- */
  let lastRes = null; // última simulación: de aquí salen el bruto del primer año de jubilación y la parte que es ganancia
  const fmtMoney = (v, cur) => { try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v); } catch { return Math.round(v) + ' ' + cur; } };
  const curSym = cur => { try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency').value; } catch { return cur; } };
  const nomFactor = () => Math.pow(1 + state.inflation / 100, state.workYears); // inflación acumulada hasta jubilarte

  /** Descripción bajo "Ingresos de la inversión": neto, bruto e impuestos del primer año de jubilación, y lo mismo sin ajustar a inflación. */
  function renderRetInfo(res) {
    const def = taxes.resolve(state.tax), m = factor(), f = nomFactor(), per = state.period === 'year' ? '/año' : '/mes';
    const v = x => eur.format(x * m) + per, n = x => eur.format(x * m * f) + per, rate = res.spend > 0 ? 1 - res.net / res.spend : 0;
    $('#ret-desc').replaceChildren(
      h('div', { title: 'Primer año de jubilación. Los años siguientes cambia según cuánta ganancia haya en el capital.' }, `Neto ${v(res.net)} · bruto ${v(res.spend)} · impuestos ${pct(rate)} (${def.label})`),
      h('div', { title: 'Mismo importe sin descontar la inflación: lo que verías en tu cuenta el primer año de jubilación.' }, `Sin ajustar a inflación (año ${state.workYears}): neto ${n(res.net)} · bruto ${n(res.spend)}`));
  }

  function openTax() { renderTax(); const d = $('#tax-dlg'); if (!d.open) d.showModal(); }
  /** Pasa los impuestos actuales a «Personalizado» (copia los tramos del país elegido) para poder editarlos. */
  function ensureCustom() {
    if (state.tax.country === 'CUSTOM' && state.tax.custom) return state.tax.custom;
    const d = taxes.resolve(state.tax);
    state.tax.custom = { from: d.label + (d.year ? ' (' + d.year + ')' : ''), currency: d.currency, fx: d.fx, on: d.on, inclusion: d.inclusion, allowance: d.allowance, brackets: structuredClone(d.brackets), social: structuredClone(d.social) };
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
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    body.addEventListener('change', e => {
      const el = e.target, t = el.dataset.t;
      if (el.id === 'tax-country') { if (el.value === 'CUSTOM') ensureCustom(); else { state.tax.country = el.value; state.tax.scale = null; } refresh(); renderTax(); }
      else if (el.id === 'tax-scale') { state.tax.scale = el.value; refresh(); renderTax(); }
      else if (t === 'on') { ensureCustom().on = el.value === 'all' ? 'all' : 'gain'; refresh(); renderTax(); }
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
    const slider = (label, key, max, step) => h('label', { class: 'cslide' }, h('span', {}, label), h('input', { type: 'range', min: 0, max, step, [`data-${key}`]: d.id }), h('em', { 'data-out': key }));
    return h('div', { class: 'fund custom', 'data-fund': d.id, 'data-custom': '1' },
      h('input', { type: 'checkbox', id: 'f-' + d.id, 'data-fcheck': d.id }),
      h('div', { class: 'fmain' },
        h('div', { class: 'cname' }, h('b', {}, d.name), h('span', { class: 'cbadge' }, d.kind === 'etf' ? 'ETF' : 'Fondo indexado')),
        h('small', { class: 'csub' }), h('small', { class: 'cmoves' }),
        h('div', { class: 'cbtns' },
          h('button', { type: 'button', 'data-cact': 'toggle', 'data-cid': d.id, title: 'Mostrar / ocultar movimientos' }, '▾'),
          h('button', { type: 'button', 'data-cact': 'edit', 'data-cid': d.id, title: 'Editar fondo' }, '✎'),
          h('button', { type: 'button', 'data-cact': 'del', 'data-cid': d.id, title: 'Borrar fondo', class: 'cdel' }, '✕'))),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': d.id }),
      h('span', { class: 'suf' }, '%'),
      h('div', { class: 'cpanel', hidden: '' }, slider('Movimientos al año', 'cperyear', 12, 1), slider('% del fondo que mueves cada vez', 'cpct', 100, 1)));
  }

  function updateCustomRow(row, f) {
    const d = state.customFunds.find(x => x.id === f.id); if (!d) return;
    const m = f.moves, bn = baseName(d), open = openCustom.has(d.id);
    $('.csub', row).textContent = bn ? `Personalizado · imita a ${bn}` : 'Personalizado · fondo inventado';
    $('.cmoves', row).textContent = m.perYear > 0 && m.pct > 0 ? `${m.perYear} mov./año · mueve el ${comma(m.pct, 1)} % · ${m.taxed ? 'con impuestos' : 'sin impuestos'}` : 'Sin movimientos';
    $('.cpanel', row).hidden = !open; $('[data-cact="toggle"]', row).textContent = open ? '▴' : '▾';
    [['cperyear', m.perYear, v => `${v} al año`], ['cpct', m.pct, v => `${comma(v, 1)} %`]].forEach(([k, v, fmt]) => {
      const inp = $(`[data-${k}]`, row); if (document.activeElement !== inp) inp.value = v;
      $(`[data-out="${k}"]`, row).textContent = fmt(v);
    });
    $('.ret', row).title = bn ? `Igual que ${bn}${Object.keys(d.vals || {}).length ? ', con tus cambios' : ''}` : 'Rentabilidad que has indicado para este fondo (subida del precio' + (state.showDividends !== false ? ' + dividendo bruto)' : ')');
  }

  /* --- Ventana de añadir / editar --- */
  function openFundDialog(id) {
    const cur = id ? state.customFunds.find(x => x.id === id) : null;
    fundEditId = cur ? cur.id : null;
    draft = cur ? structuredClone(cur) : customFunds.blank(new Set(state.customFunds.map(x => x.id)));
    taxedTouched = !!cur; draftStep = 1;
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
    const provSel = b ? h('select', { 'data-d': 'mimicProv', 'aria-label': 'Gestor' }, ...b.providers.map(p => h('option', { value: p.id }, `${p.name} · TER ${comma(p.ter)} %`))) : null;
    if (b) { baseSel.value = b.id; provSel.value = draft.mimic.prov; }
    return h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Nombre'), h('input', { type: 'text', maxlength: 40, placeholder: 'Fondo personalizado', value: draft.name, 'data-d': 'name' })),
      h('div', { class: 'field' }, h('label', {}, 'Tipo'), segBtns([['index', 'Fondo indexado'], ['etf', 'ETF']], draft.kind, v => { draft.kind = v; if (!taxedTouched) draft.taxed = v === 'etf'; renderFundDlg(); })),
      h('p', { class: 'note' }, 'En España, mover dinero entre fondos indexados no paga impuestos; vender un ETF sí.'),
      dSlider('Movimientos entre fondos al año', 'perYear', 0, 12, 1, FMT.perYear),
      dSlider('% del fondo que mueves de media cada vez', 'pct', 0, 100, 1, FMT.pct),
      h('label', { class: 'check' }, taxed, 'Se pagan impuestos en estos movimientos'),
      h('div', { class: 'field' }, h('label', {}, '¿Imita a un fondo de la aplicación?'),
        segBtns([['no', 'No'], ['yes', 'Sí']], draft.mimic ? 'yes' : 'no', v => {
          if (v === 'yes' && !draft.mimic) { const f0 = bases[0]; draft.mimic = { fund: f0.id, prov: finance.cheapest(f0).id }; draft.vals = {}; }
          else if (v === 'no' && draft.mimic) { draft.mimic = null; draft.vals = { ...customFunds.DEFAULTS }; }
          renderFundDlg();
        })),
      draft.mimic ? h('div', { class: 'tax-row' }, h('label', {}, 'Fondo', baseSel), h('label', {}, 'Gestor', provSel)) : null,
      h('div', { class: 'tax-row dlg-btns' }, h('button', { type: 'button', class: 'btn ghost', 'data-fa': 'cancel' }, 'Cancelar'), h('button', { type: 'button', class: 'btn', 'data-fa': 'next' }, 'Continuar')));
  }

  const FIELDS = [ // datos del fondo (paso 2)
    { k: 'rate', label: 'Rentabilidad anual media', hint: 'Subida del precio, sin dividendos, en € nominales.', min: -5, max: 20, step: 0.1, unit: '%' },
    { k: 'yield', label: 'Dividendo anual bruto', hint: 'Lo que reparte el fondo cada año (o reinvierte, si acumula).', min: 0, max: 8, step: 0.1, unit: '%' },
    { k: 'ter', label: 'TER (comisión anual)', hint: 'Gastos corrientes del fondo.', min: 0, max: 2, step: 0.01, unit: '%' },
    { k: 'vol', label: 'Volatilidad anual', hint: 'Cuánto oscila el valor: la renta variable global ronda el 15 %, los bonos el 5 %.', min: 1, max: 40, step: 0.5, unit: '%' },
    { k: 'corr', label: 'Correlación con la renta variable global', hint: 'Diversificación: cuanto más baja, más se mueve distinto del mercado y menos riesgo añade a la cartera.', min: -0.5, max: 1, step: 0.05, unit: '', mimicHidden: true },
  ];

  function fundStepTwo() {
    const e = customFunds.effective(draft, rateOf), mim = !!draft.mimic;
    const rows = FIELDS.filter(f => !(mim && f.mimicHidden)).map(f => {
      const v = e[f.k], changed = mim && draft.vals[f.k] != null;
      return h('div', { class: 'field fd-field' },
        h('label', {}, f.label, h('span', { class: 'fd-r' }, changed ? h('button', { type: 'button', class: 'link', 'data-fa': 'reset', 'data-k': f.k, title: 'Volver al valor del fondo imitado' }, '↺ restablecer') : null)),
        h('div', { class: 'pair' }, h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: v, 'data-fv': f.k, 'data-r': 1 }),
          h('input', { type: 'number', step: 'any', value: round(v, 3), 'data-fv': f.k }), h('span', { class: 'suf' }, f.unit)),
        h('small', { class: 'muted' }, f.hint));
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
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    body.addEventListener('input', e => {
      const el = e.target, dk = el.dataset.d, fv = el.dataset.fv;
      if (dk === 'name') draft.name = el.value;
      else if (dk === 'perYear' || dk === 'pct') { draft[dk] = parseFloat(el.value) || 0; $(`[data-dout="${dk}"]`, body).textContent = FMT[dk](draft[dk]); }
      else if (dk === 'taxed') { draft.taxed = el.checked; taxedTouched = true; }
      else if (fv) {
        const v = parseFloat(el.value); if (!Number.isFinite(v)) return;
        const lim = customFunds.LIMITS[fv]; draft.vals[fv] = Math.min(lim[1], Math.max(lim[0], v));
        $$(`[data-fv="${fv}"]`, body).forEach(o => { if (o !== el) o.value = el.type === 'range' ? round(draft.vals[fv], 3) : draft.vals[fv]; });
        if (draft.mimic && !$(`[data-fa="reset"][data-k="${fv}"]`, body)) { const lab = el.closest('.fd-field').querySelector('.fd-r'); lab.replaceChildren(h('button', { type: 'button', class: 'link', 'data-fa': 'reset', 'data-k': fv, title: 'Volver al valor del fondo imitado' }, '↺ restablecer')); }
      }
    });
    body.addEventListener('change', e => {
      const el = e.target, dk = el.dataset.d;
      if (dk === 'mimicFund') { const f0 = customFunds.baseFunds().find(f => f.id === el.value); draft.mimic = { fund: f0.id, prov: finance.cheapest(f0).id }; draft.vals = {}; renderFundDlg(); }
      else if (dk === 'mimicProv') draft.mimic.prov = el.value;
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
    document.addEventListener('input', e => { const el = e.target.closest('[data-key]'); if (el) set(el.dataset.key, el); });
    document.addEventListener('input', e => { if (e.target.dataset?.hist) onHist(e.target.dataset.hist, e.target, false); });
    document.addEventListener('change', e => { if (e.target.dataset?.hist) onHist(e.target.dataset.hist, e.target, true); });
    // Si dejas un número vacío y sales del campo, se restaura el valor real (el estado no cambia mientras está vacío).
    document.addEventListener('focusout', e => { if (e.target.matches?.('input[type=number]') && e.target.value.trim() === '') refresh(false); });
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
