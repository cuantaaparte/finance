/* Interfaz: genera formularios desde el esquema, enlaza eventos y pinta resultados. */
(function (App) {
  'use strict';
  const { config, storage, finance, data, chart, scenarioCode } = App;
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
  delete state.histYears; // ajuste antiguo (años hacia atrás), sustituido por histFrom/histTo
  let base = null;          // últimos datos introducidos por el usuario: de aquí salen las estrategias
  let active = null;        // estrategia aplicada actualmente
  let scenarios = storage.get(config.STORAGE.scenarios, []);
  let raf = 0;
  // Ajustes de VISTA que una estrategia no debe pisar (antes, al aplicar una, volvía a "Salario medio" porque la copia guardaba el valor antiguo).
  const VIEW_KEYS = ['stratBase', 'period', 'showInvested', 'showPrice', 'showTotal', 'showNominal'];
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
    return h('div', { class: 'field', 'data-field': f.key }, h('label', {}, f.label, f.unit ? h('em', { 'data-unit': '' }) : null), row);
  }

  function buildFunds() {
    const box = h('div', { id: 'funds' });
    box.append(h('div', { class: 'tools' }, h('small', { id: 'ter-info' }),
      h('button', { type: 'button', onclick: () => { config.FUNDS.forEach(f => { state.prov[f.id] = finance.cheapest(f).id; }); refresh(); } }, 'Gestor más barato')));
    box.append(h('p', { class: 'fnote', id: 'funds-note' }));
    config.FUNDS.forEach(f => box.append(h('div', { class: 'fund', 'data-fund': f.id },
      h('input', { type: 'checkbox', id: 'f-' + f.id, 'data-fcheck': f.id }),
      h('div', { class: 'fmain' }, h('b', {}, f.name),
        h('select', { 'data-fprov': f.id, 'aria-label': 'Gestor' }, ...f.providers.map(p => h('option', { value: p.id })))),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': f.id }),
      h('span', { class: 'suf' }, '%'))));
    box.append(h('div', { class: 'total-row' }, h('div', { class: 'total', id: 'alloc-total' }), h('div', { class: 'total', id: 'risk-total' })));
    box.addEventListener('input', e => {
      const c = e.target.dataset.fcheck, w = e.target.dataset.fw, p = e.target.dataset.fprov;
      if (c) {
        if (e.target.checked) state.alloc[c] = Math.max(0, 100 - sumAlloc());
        else if (Object.keys(state.alloc).length > 1) delete state.alloc[c];
      } else if (w) state.alloc[w] = Math.max(0, parseFloat(e.target.value) || 0);
      else if (p) state.prov[p] = e.target.value;
      else return;
      refresh();
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
    else if (key === 'retIncome') setRetIncome(v / factor());
    else if (MONEY.has(key)) { state[key] = v / factor(); flag(key); }
    else state[key] = v;
    refresh();
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
    $$('[data-unit]').forEach(e => (e.textContent = state.period === 'year' ? '(€ / año)' : '(€ / mes)'));
    $('#hint-nominal').hidden = !state.showNominal; $('.legend').classList.toggle('nominal-on', !!state.showNominal);
    renderHist();
    renderFunds();
    renderExtremes();

    const port = finance.portfolio(state, rateOf), res = finance.simulate(state, port);
    chart.render(res, state);
    renderKpis(res);
    renderRisk(port, res);
    renderStrategies();
    renderScenarios();
    const st = data.status(), badge = $('#data-status');
    badge.textContent = st.mode === 'live' ? `En vivo (${st.count}/${config.FUNDS.length})` : st.mode === 'saved' ? `Datos del ${st.date || 'archivo local'}` : 'Sin datos · estimados (reintentar)';
    badge.classList.toggle('live', st.mode !== 'none');
  }

  /** Aviso (vacío = todo bien) cuando a algún fondo elegido le faltan datos en el periodo seleccionado. */
  function histWarning() {
    if (data.status().mode === 'none') return 'Sin datos reales: la rentabilidad es una estimación fija y no cambia con los años.';
    const selected = Object.keys(state.alloc).map(id => config.FUNDS.find(x => x.id === id)).filter(Boolean);
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
    $('#funds-note').textContent = `Cifra de cada fondo: rentabilidad anual media del índice en el periodo elegido, en € nominales y sin dividendos. En la simulación se le resta a cada fondo la inflación que has elegido (${infl} %), además del TER y la comisión del bróker, y se le suma su dividendo.`;
    $$('.fund').forEach(row => {
      const f = config.FUNDS.find(x => x.id === row.dataset.fund), on = f.id in state.alloc, r = rateOf(f);
      $('[data-fcheck]', row).checked = on;
      const sel = $('select', row);
      $$('option', sel).forEach((o, i) => { const p = f.providers[i]; o.textContent = `${p.name} · TER ${p.ter} %`; });
      sel.value = finance.providerOf(state, f).id; sel.disabled = !on;
      const w = $('[data-fw]', row); w.disabled = !on;
      if (document.activeElement !== w) w.value = on ? round(state.alloc[f.id]) : '';
      const ret = $('.ret', row); ret.textContent = pct(r.rate); ret.classList.toggle('neg', r.rate < 0);
      ret.title = r.live ? `Rentabilidad anual media del índice entre ${mLabel(r.startKey)} y ${mLabel(r.endKey)} (${fmtYears(r.span)}), sin dividendos ni inflación` : 'Estimación fija (sin datos reales en este periodo)';
      $('.ter', row).textContent = 'TER ' + String(finance.providerOf(state, f).ter).replace('.', ',') + ' %';
    });
    const t = sumAlloc(), el = $('#alloc-total');
    el.textContent = `Reparto: ${round(t, 1)} %` + (Math.abs(t - 100) > 0.1 ? ' (se normaliza a 100 %)' : '');
    el.classList.toggle('warn', Math.abs(t - 100) > 0.1);
    $('#ter-info').textContent = data.terDate() ? `TER actualizados: ${data.terDate()}` : 'TER de referencia';
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

  function renderStrategies() {
    $$('#strat-base button').forEach(b => b.classList.toggle('on', b.dataset.sb === state.stratBase));
    const a = config.AVERAGE_PROFILE;
    $('#strat-note').textContent = state.stratBase === 'avg'
      ? `Calculadas con un perfil de salario medio (${eur.format(a.net)}/mes, ${a.workYears} años trabajando y ${a.retireYears} de jubilación); se mantienen tus fondos, inflación y comisiones.`
      : 'Calculadas con los datos que has introducido (tu sueldo, gastos, ahorro inicial y años).';
    const start = base || state, source = state.stratBase === 'avg' ? finance.averageProfile(start) : start;
    $('#strategies').replaceChildren(...finance.strategies(source, rateOf, inputsOf).map(st =>
      h('button', { type: 'button', class: 'strategy' + (st.id === active ? ' active' : ''), disabled: st.unavailable ? '' : null,
        onclick: () => { applyState(st.state); active = st.id; refresh(false); } },
        h('b', {}, st.title), h('p', {}, st.unavailable ? 'No es alcanzable con tus datos actuales.' : st.desc),
        st.unavailable ? null : h('div', { class: 'tags' },
          h('span', {}, `Trabajas ${st.state.workYears} años`), h('span', {}, `Capital ${eur.format(st.res.capital)}`),
          h('span', {}, `Retiras ${eur.format(st.res.spend)}/mes`), h('span', { class: st.risk.color ? 'risk-' + st.risk.color : '' }, `Riesgo ${st.risk.level} (${st.risk.score}/100)`)))));
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

  function renderScenarios(force = false) {
    if (editingId !== null && !force) return; // no pisar el campo mientras se escribe el nombre
    const summary = sc => {
      const s = sc.state, m = s.period === 'year' ? 12 : 1, u = s.period === 'year' ? '/año' : '/mes';
      return `Neto ${eur.format(s.net * m)}${u} · invierte ${eur.format(s.invest * m)}${u} · inicial ${eur.format(s.initial)} · ${s.workYears} años · inflación ${s.inflation} % · histórico ${s.histFrom || s.histTo ? `${s.histFrom ?? '…'}–${s.histTo ?? 'hoy'}` : 'por defecto'} · bróker ${s.brokerFee} % · `
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

  function init() {
    buildInputs();
    $('#app-version').textContent = config.VERSION ? 'Versión ' + config.VERSION : '';
    [['avg', `Salario medio (${eur.format(config.AVERAGE_PROFILE.net)})`, 'Estrategias calculadas con un perfil estándar de salario medio'], ['mine', 'Mis datos', 'Estrategias calculadas con lo que has introducido tú']].forEach(([v, label, tip]) =>
      $('#strat-base').append(h('button', { type: 'button', 'data-sb': v, title: tip, onclick: () => { state.stratBase = v; refresh(false); } }, label)));
    const head = $('.top'), syncHead = () => document.documentElement.style.setProperty('--head-h', head.offsetHeight + 'px');
    new ResizeObserver(syncHead).observe(head); syncHead();
    chart.init($('#chart'), $('#tip'));
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
