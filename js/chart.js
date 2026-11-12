/* Gráfica en <canvas> sin librerías: dos fases (trabajo / jubilación), línea vertical y tooltip. */
(function (App) {
  'use strict';
  const C = { invested: '#94a3b8', price: '#38bdf8', total: '#a78bfa', ok: '#34d399', bad: '#f87171', nomUp: '#a78bfa', nomDown: '#fb923c', grid: 'rgba(255,255,255,.08)', text: '#8b97a9' };
  const PAD = { l: 58, r: 14, t: 18, b: 28 }, BASE = { ...PAD };
  const compact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  let canvas, tip, last, hover = null;

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 2.5, 5, 10].find(x => v / p <= x) * p;
  }

  function init(c, t) {
    canvas = c; tip = t;
    new ResizeObserver(draw).observe(c.parentElement);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; draw(); });
  }

  function render(res, s) { last = { res, s }; draw(); }

  function draw() {
    if (!last) return;
    const { res, s } = last, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    const k = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16; // escala con el tamaño de la interfaz
    for (const key in BASE) PAD[key] = BASE[key] * k;
    const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b, dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; } // solo si cambia el tamaño
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const vals = [...res.total];
    if (s.showInvested) vals.push(...res.invested);
    if (s.showPrice) vals.push(...res.price.filter(v => v != null));
    if (s.showNominal) vals.push(...res.nominal.slice(res.work));
    const top = niceMax(Math.max(...vals, 1));
    const X = y => PAD.l + (y / res.years) * iw, Y = v => PAD.t + ih - (v / top) * ih;

    ctx.font = `${11 * k}px system-ui`; ctx.fillStyle = C.text; ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      ctx.beginPath(); ctx.moveTo(PAD.l, Y(v)); ctx.lineTo(w - PAD.r, Y(v)); ctx.stroke();
      ctx.fillText(compact.format(v) + ' €', PAD.l - 6, Y(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = res.years > 40 ? 10 : res.years > 20 ? 5 : 2;
    for (let y = 0; y <= res.years; y += step) ctx.fillText(y, X(y), h - PAD.b + 8);

    const line = (arr, a, b, color) => {
      ctx.beginPath();
      for (let y = a; y <= b; y++) y === a ? ctx.moveTo(X(y), Y(arr[y])) : ctx.lineTo(X(y), Y(arr[y]));
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    };
    if (s.showInvested) line(res.invested, 0, res.work, C.invested);
    if (s.showPrice) line(res.price, 0, res.work, C.price);
    if (s.showTotal) line(res.total, 0, res.work, C.total);
    // Jubilación sin ajustar a inflación (euros nominales): lila si sube, naranja si baja. Se pinta debajo de la línea en € de hoy.
    if (s.showNominal) for (let y = res.work; y < res.years; y++) line(res.nominal, y, y + 1, res.nominalDecline[y] ? C.nomDown : C.nomUp);
    for (let y = res.work; y < res.years; y++) line(res.total, y, y + 1, res.decline[y] ? C.bad : C.ok);

    ctx.setLineDash([6, 5]); ctx.strokeStyle = '#e6eaf2'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(res.work), PAD.t); ctx.lineTo(X(res.work), PAD.t + ih); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#e6eaf2'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('Dejas de trabajar', X(res.work), PAD.t - 2);

    if (hover != null) {
      ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.moveTo(X(hover), PAD.t); ctx.lineTo(X(hover), PAD.t + ih); ctx.stroke();
    }
  }

  function onMove(e) {
    const { res, s } = last, rect = canvas.getBoundingClientRect(), iw = rect.width - PAD.l - PAD.r;
    const y = Math.min(res.years, Math.max(0, Math.round(((e.clientX - rect.left - PAD.l) / iw) * res.years)));
    hover = y;
    const lines = [`Año ${y} · ${y <= res.work ? 'trabajando' : 'jubilado'}`];
    if (y <= res.work) lines.push(`Invertido: ${eur.format(res.invested[y])}`, `Con rentab.: ${eur.format(res.price[y])}`);
    lines.push(`${y <= res.work ? '+ dividendos' : 'Capital (€ de hoy)'}: ${eur.format(res.total[y])}`);
    if (s.showNominal && y >= res.work) lines.push(`Sin ajustar (€ nominales): ${eur.format(res.nominal[y])}`);
    tip.textContent = lines.join('\n'); tip.hidden = false;
    tip.style.left = Math.min(e.clientX - rect.left + 12, rect.width - 240) + 'px';
    draw();
  }

  App.chart = { init, render };
})(window.App = window.App || {});
