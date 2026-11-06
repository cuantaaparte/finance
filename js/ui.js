/* Interfaz: genera formularios desde el esquema, enlaza eventos y pinta resultados. */
(function (App) {
  'use strict';
  const { config, storage, finance, data, chart } = App;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const pct = (x, d = 1) => (x * 100).toFixed(d).replace('.', ',') + ' %';
  const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  const PCT = { needsPct: 'needs', leisurePct: 'leisure', investPct: 'invest' };
  const MONEY = new Set(['net', 'needs', 'leisure', 'invest', 'retNeeds', 'retLeisure']);

  const state = Object.assign(structuredClone(config.DEFAULT_STATE), storage.get(config.STORAGE.settings, {}));
  if (!Object.keys(state.alloc || {}).length) state.alloc = { ...config.DEFAULT_STATE.alloc };
  state.prov = state.prov || {};
  let base = null;          // últimos datos introducidos por el usuario: de aquí salen las estrategias
  let active = null;        // estrategia aplicada actualmente
  let scenarios = storage.get(config.STORAGE.scenarios, []);
  let raf = 0;
  const factor = () => (state.period === 'year' ? 12 : 1);
  const rateOf = f => data.cagr(f, state.histYears);
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
  function buildField(f) {
    const link = f.linked ? { 'data-linked': '' } : {};
    if (f.type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': f.key }), f.label);
    const isMoney = MONEY.has(f.key);
    const row = h('div', { class: 'pair' },
      h('input', { type: 'range', 'data-key': f.key, min: f.min ?? 0, max: f.max, step: f.step, 'data-max': f.max, 'data-step': f.step, ...link }),
      h('input', { type: 'number', 'data-key': f.key, step: 'any', min: f.min ?? 0, inputmode: 'decimal', ...link }),
      h('span', { class: 'suf' }, isMoney ? '€' : f.suffix || ''));
    if (f.pct) row.append(h('input', { type: 'number', class: 'pct', 'data-key': f.pct, min: 0, max: 100, step: 'any', inputmode: 'decimal' }), h('span', { class: 'suf' }, '%'));
    return h('div', { class: 'field' }, h('label', {}, f.label, f.unit ? h('em', { 'data-unit': '' }) : null), row);
  }

  function buildFunds() {
    const box = h('div', { id: 'funds' });
    box.append(h('div', { class: 'tools' }, h('small', { id: 'ter-info' }),
      h('button', { type: 'button', onclick: () => { config.FUNDS.forEach(f => { state.prov[f.id] = finance.cheapest(f).id; }); refresh(); } }, 'Gestor más barato')));
    config.FUNDS.forEach(f => box.append(h('div', { class: 'fund', 'data-fund': f.id },
      h('input', { type: 'checkbox', id: 'f-' + f.id, 'data-fcheck': f.id }),
      h('div', { class: 'fmain' }, h('b', {}, f.name),
        h('select', { 'data-fprov': f.id, 'aria-label': 'Gestor' }, ...f.providers.map(p => h('option', { value: p.id })))),
      h('div', { class: 'rcell' }, h('span', { class: 'ret' }), h('small', { class: 'ter' })),
      h('input', { type: 'number', min: 0, max: 100, step: 'any', 'data-fw': f.id }),
      h('span', { class: 'suf' }, '%'))));
    box.append(h('div', { class: 'total', id: 'alloc-total' }), h('div', { class: 'total warn', id: 'hist-warn', hidden: '' }));
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
      const card = h('div', { class: 'card' }, h('h2', {}, sec.title), ...sec.fields.map(buildField));
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
    else if (MONEY.has(key)) { state[key] = v / factor(); flag(key); }
    else state[key] = v;
    refresh();
  }
  function flag(k) {
    if (k === 'needs' || k === 'leisure') state.touched[k] = true;
    if (k === 'invest') state.investAuto = false;
  }
  function shown(key) {
    if (key in PCT) return state.net ? (state[PCT[key]] / state.net) * 100 : 0;
    return MONEY.has(key) ? state[key] * factor() : state[key];
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
    renderFunds();

    const port = finance.portfolio(state, rateOf), res = finance.simulate(state, port);
    chart.render(res, state);
    renderKpis(res);
    renderStrategies();
    renderScenarios();
    const st = data.status(), badge = $('#data-status');
    badge.textContent = st.mode === 'live' ? `En vivo (${st.count}/${config.FUNDS.length})` : st.mode === 'saved' ? `Datos del ${st.date || 'archivo local'}` : 'Sin datos · estimados (reintentar)';
    badge.classList.toggle('live', st.mode !== 'none');
  }

  function renderFunds() {
    $$('.fund').forEach(row => {
      const f = config.FUNDS.find(x => x.id === row.dataset.fund), on = f.id in state.alloc, r = rateOf(f);
      $('[data-fcheck]', row).checked = on;
      const sel = $('select', row);
      $$('option', sel).forEach((o, i) => { const p = f.providers[i]; o.textContent = `${p.name} · TER ${p.ter} %`; });
      sel.value = finance.providerOf(state, f).id; sel.disabled = !on;
      const w = $('[data-fw]', row); w.disabled = !on;
      if (document.activeElement !== w) w.value = on ? round(state.alloc[f.id]) : '';
      const ret = $('.ret', row); ret.textContent = pct(r.rate); ret.classList.toggle('neg', r.rate < 0);
      ret.title = r.live ? `Rentabilidad anual real de los últimos ${Math.round(r.span)} años` : 'Estimada (sin datos reales)';
      $('.ter', row).textContent = 'TER ' + String(finance.providerOf(state, f).ter).replace('.', ',') + ' %';
    });
    const t = sumAlloc(), el = $('#alloc-total');
    el.textContent = `Reparto: ${round(t, 1)} %` + (Math.abs(t - 100) > 0.1 ? ' (se normaliza a 100 %)' : '');
    el.classList.toggle('warn', Math.abs(t - 100) > 0.1);
    const warn = $('#hist-warn'), selected = Object.keys(state.alloc).map(id => config.FUNDS.find(x => x.id === id)).filter(Boolean);
    const short = selected.filter(f => { const r = rateOf(f); return r.live && r.span < state.histYears - 0.5; });
    warn.textContent = data.status().mode === 'none'
      ? 'Sin datos reales: la rentabilidad es una estimación fija y no cambia con los años.'
      : short.length ? `${short.map(f => f.name).join(', ')}: solo hay ${Math.round(Math.min(...short.map(f => rateOf(f).span)))} años de histórico; se usa el máximo disponible.` : '';
    warn.hidden = !warn.textContent;
    $('#ter-info').textContent = data.terDate() ? `TER actualizados: ${data.terDate()}` : 'TER de referencia';
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
    $('#strategies').replaceChildren(...finance.strategies(base || state, rateOf).map(st =>
      h('button', { type: 'button', class: 'strategy' + (st.id === active ? ' active' : ''), disabled: st.unavailable ? '' : null,
        onclick: () => { Object.assign(state, structuredClone(st.state)); active = st.id; refresh(false); } },
        h('b', {}, st.title), h('p', {}, st.unavailable ? 'No es alcanzable con tus datos actuales.' : st.desc),
        st.unavailable ? null : h('div', { class: 'tags' },
          h('span', {}, `Trabajas ${st.state.workYears} años`), h('span', {}, `Capital ${eur.format(st.res.capital)}`),
          h('span', {}, `Retiras ${eur.format(st.res.spend)}/mes`), h('span', {}, `Riesgo ~${Math.round(st.risk)} %`)))));
  }

  function renderScenarios() {
    const save = () => storage.set(config.STORAGE.scenarios, scenarios);
    const summary = sc => {
      const s = sc.state, m = s.period === 'year' ? 12 : 1, u = s.period === 'year' ? '/año' : '/mes';
      return `Neto ${eur.format(s.net * m)}${u} · invierte ${eur.format(s.invest * m)}${u} · inicial ${eur.format(s.initial)} · ${s.workYears} años · inflación ${s.inflation} % · histórico ${s.histYears} a. · bróker ${s.brokerFee} % · `
        + Object.entries(s.alloc).map(([id, w]) => `${id} ${round(w, 1)} %`).join(', ');
    };
    $('#scenarios').replaceChildren(...scenarios.map(sc => h('li', {},
      h('div', { class: 'sc-head' }, h('b', {}, sc.name),
        h('button', { type: 'button', onclick: () => { Object.assign(state, structuredClone(sc.state)); refresh(); } }, 'Cargar'),
        h('button', { type: 'button', title: 'Guarda aquí los datos actuales', onclick: () => { sc.state = structuredClone(state); save(); renderScenarios(); } }, 'Actualizar'),
        h('button', { type: 'button', class: 'del', onclick: () => { scenarios = scenarios.filter(x => x.id !== sc.id); save(); renderScenarios(); } }, '✕')),
      h('small', {}, summary(sc)))));
  }

  function init() {
    buildInputs();
    chart.init($('#chart'), $('#tip'));
    document.addEventListener('input', e => { const el = e.target.closest('[data-key]'); if (el) set(el.dataset.key, el); });
    $('#data-status').addEventListener('click', async () => { $('#data-status').textContent = 'Conectando…'; await data.loadAll(true); refresh(false); });
    $('#save-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#scenario-name');
      scenarios.push({ id: Date.now(), name: input.value.trim() || `Supuesto ${scenarios.length + 1}`, state: structuredClone(state) });
      storage.set(config.STORAGE.scenarios, scenarios); input.value = ''; renderScenarios();
    });
    refresh();
  }

  // Tras cargar datos externos, se repinta sin tocar la base de estrategias.
  App.ui = { init, refresh: () => refresh(false) };
})(window.App = window.App || {});
