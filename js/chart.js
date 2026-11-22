/* Gráfica en <canvas> sin librerías: dos fases (trabajo / jubilación), tramos del Modo Avanzado, operaciones en recuadros sobre línea amarilla, línea vertical y tooltip. */
(function (App) {
  "use strict";
  const C = {
    invested: "#94a3b8",
    price: "#38bdf8",
    total: "#a78bfa",
    ok: "#34d399",
    bad: "#f87171",
    nomUp: "#a78bfa",
    nomDown: "#fb923c",
    grid: "rgba(255,255,255,.08)",
    text: "#8b97a9",
    advInvest: "#2dd4bf",
    advInvestFill: "rgba(45, 212, 191, 0.08)",
    advInvestLine: "rgba(45, 212, 191, 0.5)",
    advSpend: "#fb923c",
    advSpendFill: "rgba(251, 146, 60, 0.08)",
    advSpendLine: "rgba(251, 146, 60, 0.5)",
    op: "#fbbf24",
    opLine: "rgba(251, 191, 36, 0.9)",
    opBg: "rgba(11, 15, 23, 0.92)",
    opErrBg: "rgba(38, 14, 18, 0.94)",
  };
  const PAD = { l: 58, r: 14, t: 18, b: 28 },
    BASE = { ...PAD };
  const compact = new Intl.NumberFormat("es-ES", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const eur = new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  let canvas,
    tip,
    last,
    hover = null,
    W = 0,
    H = 0,
    K = 1; // W, H, K: tamaño del lienzo y escala de la interfaz, medidos solo al cambiar de tamaño

  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return ([1, 2, 2.5, 5, 10].find((x) => v / p <= x - 1e-9) || 10) * p; // el margen evita que 10,000000000000002 deje la escala sin valor (NaN)
  }

  /** Devuelve el tramo del Modo Avanzado al que corresponde el año `y` (null en modo estándar). */
  function phaseAt(res, y) {
    const trs = res.transitions;
    if (!trs?.length) return null;
    if (y <= 0) return trs[0];
    const grp = y <= res.work ? "invest" : "spend";
    let found = null;
    for (const tr of trs) {
      if (tr.group === grp && tr.year < y) found = tr;
    }
    return found || trs.find((tr) => tr.group === grp) || null;
  }

  /** Agrupa los marcadores de operaciones por año. */
  function groupOps(res, s) {
    const map = new Map();
    if (!s.advancedMode || !res.opMarkers?.length) return map;
    for (const op of res.opMarkers) {
      const arr = map.get(op.year);
      if (arr) arr.push(op);
      else map.set(op.year, [op]);
    }
    return map;
  }

  /** Dibuja un rectángulo redondeado compatible con cualquier navegador. */
  function roundBoxPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Recorta una cadena con `…` para que quepa en `maxW`. */
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) {
      s = s.slice(0, -1);
    }
    return s.trimEnd() + "…";
  }

  /** Divide un texto en como máximo `maxLines` líneas dentro de `maxW`, truncando la última con `…` si sobra. */
  function wrapLines(ctx, text, maxW, maxLines = 2) {
    const words = String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let cur = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const cand = cur ? cur + " " + w : w;
      if (ctx.measureText(cand).width <= maxW) {
        cur = cand;
        continue;
      }
      if (cur) {
        if (lines.length === maxLines - 1) {
          lines.push(fitText(ctx, cand + " " + words.slice(i + 1).join(" "), maxW));
          return lines;
        }
        lines.push(cur);
        cur = "";
        i--; // reintenta la palabra en la siguiente línea
      } else {
        // Palabra única más ancha que la caja
        if (lines.length === maxLines - 1) {
          lines.push(fitText(ctx, words.slice(i).join(" "), maxW));
          return lines;
        }
        let cut = w.length;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxW) cut--;
        lines.push(w.slice(0, cut));
        const rem = w.slice(cut);
        if (rem) words.splice(i + 1, 0, rem);
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  function init(c, t) {
    canvas = c;
    tip = t;
    measure();
    new ResizeObserver(() => {
      measure();
      draw();
    }).observe(c.parentElement);
    window.addEventListener("resize", () => {
      measure();
      draw();
    });
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerleave", () => {
      hover = null;
      tip.hidden = true;
      draw();
    });
  }

  /** Lee el tamaño y la fuente raíz una vez (leerlos en cada pintado obligaba al navegador a recalcular la página entera). */
  function measure() {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    K =
      (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) /
      16;
  }

  function render(res, s) {
    last = { res, s };
    draw();
  }

  function draw() {
    if (!last) return;
    const { res, s } = last;
    if (!W) measure();
    const w = W,
      h = H,
      k = K; // k: escala con el tamaño de la interfaz
    if (!w) return;

    const opsByYear = groupOps(res, s);
    for (const key in BASE) PAD[key] = BASE[key] * k;

    const iw = w - PAD.l - PAD.r,
      ih = Math.max(20, h - PAD.t - PAD.b),
      dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr),
      bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    } // solo si cambia el tamaño
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const vals = [...res.total];
    if (s.showInvested) vals.push(...res.invested);
    if (s.showPrice) vals.push(...res.price.filter((v) => v != null));
    if (s.showNominal) vals.push(...res.nominal.slice(res.work));
    const top = niceMax(Math.max(...vals, 1));
    const spanY = Math.max(1, res.years);
    const X = (y) => PAD.l + (y / spanY) * iw,
      Y = (v) => PAD.t + ih - (v / top) * ih;

    // Banda sombreada del tramo activo en Modo Avanzado (detrás de la rejilla y las líneas)
    const trs =
      s.advancedMode && res.transitions?.length ? res.transitions : null;
    const activeId = s.advancedMode ? s.advanced?.activeId : null;
    if (trs && activeId) {
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i];
        if (tr.id !== activeId) continue;
        const x1 = X(tr.year),
          x2 = X(i + 1 < trs.length ? trs[i + 1].year : res.years);
        ctx.fillStyle =
          tr.group === "spend" ? C.advSpendFill : C.advInvestFill;
        ctx.fillRect(x1, PAD.t, Math.max(0, x2 - x1), ih);
      }
    }

    ctx.font = `${11 * k}px system-ui`;
    ctx.fillStyle = C.text;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = (top / 4) * i;
      ctx.beginPath();
      ctx.moveTo(PAD.l, Y(v));
      ctx.lineTo(w - PAD.r, Y(v));
      ctx.stroke();
      ctx.fillText(compact.format(v) + " €", PAD.l - 6, Y(v));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const step = res.years > 40 ? 10 : res.years > 20 ? 5 : 2;
    for (let y = 0; y <= res.years; y += step)
      ctx.fillText(y, X(y), h - PAD.b + 8);

    // Líneas punteadas y etiquetas de cada tramo en Modo Avanzado
    if (trs) {
      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i],
          isSpend = tr.group === "spend",
          isAct = tr.id === activeId;
        const nextY = i + 1 < trs.length ? trs[i + 1].year : res.years;
        if (
          tr.year > 0 &&
          tr.year < res.years &&
          tr.year !== res.work &&
          !opsByYear.has(tr.year)
        ) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = isSpend ? C.advSpendLine : C.advInvestLine;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(X(tr.year), PAD.t);
          ctx.lineTo(X(tr.year), PAD.t + ih);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const x1 = X(tr.year),
          x2 = X(nextY);
        if (x2 - x1 >= 18 * k) {
          ctx.save();
          ctx.font = `${isAct ? "700 " : "600 "}${10 * k}px system-ui`;
          ctx.fillStyle = isSpend ? C.advSpend : C.advInvest;
          ctx.globalAlpha = isAct ? 0.95 : 0.55;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const maxW = Math.max(12, x2 - x1 - 6 * k);
          ctx.fillText(fitText(ctx, tr.label, maxW), (x1 + x2) / 2, PAD.t + 4 * k);
          ctx.restore();
        }
      }
      ctx.font = `${11 * k}px system-ui`;
    }

    const line = (arr, a, b, color) => {
      ctx.beginPath();
      for (let y = a; y <= b; y++)
        y === a ? ctx.moveTo(X(y), Y(arr[y])) : ctx.lineTo(X(y), Y(arr[y]));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    };
    // Una línea cuyo color cambia por tramos: los años seguidos del mismo color se dibujan de un solo trazo (antes, un trazo por año)
    const multi = (arr, a, b, colorOf) => {
      for (let y = a; y < b; ) {
        const c = colorOf(y);
        let e = y + 1;
        while (e < b && colorOf(e) === c) e++;
        line(arr, y, e, c);
        y = e;
      }
    };
    if (s.showInvested) line(res.invested, 0, res.work, C.invested);
    if (s.showPrice) line(res.price, 0, res.work, C.price);
    if (s.showTotal) line(res.total, 0, res.work, C.total);
    // Jubilación sin ajustar a inflación (euros nominales): lila si sube, naranja si baja. Se pinta debajo de la línea en € de hoy.
    if (s.showNominal)
      multi(res.nominal, res.work, res.years, (y) =>
        res.nominalDecline[y] ? C.nomDown : C.nomUp,
      );
    multi(res.total, res.work, res.years, (y) =>
      res.decline[y] ? C.bad : C.ok,
    );

    // Utilidad para colocar texto centrado en `x` sin salirse del lienzo
    const drawClampedText = (txt, x, yPos) => {
      const tw = ctx.measureText(txt).width;
      const cx = Math.min(w - PAD.r - tw / 2, Math.max(PAD.l + tw / 2, x));
      ctx.fillText(txt, cx, yPos);
    };

    // Línea vertical de «Dejas de trabajar» (si coincide con una operación, la línea será amarilla abajo)
    const workHasOps = opsByYear.has(res.work);
    if (!workHasOps) {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "#e6eaf2";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(res.work), PAD.t);
      ctx.lineTo(X(res.work), PAD.t + ih);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#e6eaf2";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    drawClampedText("Dejas de trabajar", X(res.work), PAD.t - 2 * k);

    // Líneas discontinuas amarillas de las operaciones
    if (opsByYear.size) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = C.opLine;
      ctx.lineWidth = 1.6;
      for (const [oy] of opsByYear) {
        const x = X(oy);
        ctx.beginPath();
        ctx.moveTo(x, PAD.t);
        ctx.lineTo(x, PAD.t + ih);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (hover != null) {
      ctx.strokeStyle = "rgba(255,255,255,.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(hover), PAD.t);
      ctx.lineTo(X(hover), PAD.t + ih);
      ctx.stroke();
    }

    // Recuadros de operaciones sobre la línea discontinua, dentro del gráfico, con tamaño máximo y apilado antisolapamiento
    if (opsByYear.size) {
      ctx.save();
      const fontSize = 9.5 * k;
      ctx.font = `600 ${fontSize}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const maxBoxW = Math.min(126 * k, Math.max(70 * k, iw * 0.28));
      const padX = 6 * k;
      const padY = 3.5 * k;
      const lineH = 11.5 * k;
      const maxLines = 2;
      const maxBoxH = maxLines * lineH + padY * 2;
      const maxTextW = Math.max(24 * k, maxBoxW - padX * 2);
      const gapX = 4 * k;
      const gapY = 4 * k;
      const startY = PAD.t + (trs ? 18 * k : 6 * k);
      const placed = [];

      const orderedYears = [...opsByYear.keys()].sort((a, b) => a - b);
      for (const oy of orderedYears) {
        const x = X(oy);
        const list = opsByYear.get(oy);
        for (const op of list) {
          const txt = (op.err ? "⚠ " : "") + op.label;
          const lines = wrapLines(ctx, txt, maxTextW, maxLines);
          let textW = 0;
          for (const ln of lines) {
            const lw = ctx.measureText(ln).width;
            if (lw > textW) textW = lw;
          }
          const boxW = Math.min(maxBoxW, textW + padX * 2);
          const boxH = Math.min(maxBoxH, lines.length * lineH + padY * 2);
          const bx = Math.min(
            w - PAD.r - boxW - 2,
            Math.max(PAD.l + 2, x - boxW / 2),
          );

          // Busca el nivel vertical más alto libre (si solapa con otro recuadro, baja debajo)
          let by = startY;
          let moved = true;
          while (moved) {
            moved = false;
            for (const b of placed) {
              const overlapX = bx < b.x + b.w + gapX && bx + boxW + gapX > b.x;
              const overlapY = by < b.y + b.h + gapY && by + boxH + gapY > b.y;
              if (overlapX && overlapY) {
                by = b.y + b.h + gapY;
                moved = true;
                break;
              }
            }
          }
          const maxY = PAD.t + ih - boxH - 3 * k;
          if (by > maxY) by = Math.max(PAD.t + 2 * k, maxY);
          placed.push({ x: bx, y: by, w: boxW, h: boxH });

          // Dibuja el recuadro encima de la línea discontinua
          roundBoxPath(ctx, bx, by, boxW, boxH, 5 * k);
          ctx.fillStyle = op.err ? C.opErrBg : C.opBg;
          ctx.fill();
          ctx.strokeStyle = op.err ? C.bad : C.op;
          ctx.lineWidth = 1.25;
          ctx.stroke();

          ctx.fillStyle = op.err ? "#fecaca" : "#fde68a";
          const totalTextH = lines.length * lineH;
          const firstLineY = by + (boxH - totalTextH) / 2 + lineH / 2;
          for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], bx + boxW / 2, firstLineY + li * lineH);
          }
        }
      }
      ctx.restore();
    }
  }

  function onMove(e) {
    if (!last) return;
    const { res, s } = last,
      rect = canvas.getBoundingClientRect(),
      iw = rect.width - PAD.l - PAD.r;
    const y = Math.min(
      res.years,
      Math.max(
        0,
        Math.round(((e.clientX - rect.left - PAD.l) / iw) * res.years),
      ),
    );
    const moveTip = () => {
      tip.style.left =
        Math.max(
          4,
          Math.min(
            e.clientX - rect.left + 12,
            rect.width - (tip.offsetWidth || 240) - 4,
          ),
        ) + "px";
    };
    if (y === hover && !tip.hidden) {
      moveTip();
      return;
    } // mismo año: solo se mueve el cuadro, sin repintar ni recomponer el texto
    hover = y;
    const ph = s.advancedMode ? phaseAt(res, y) : null;
    const phaseTag = ph ? ` · tramo ${ph.label}` : "";
    const lines = [
      `Año ${y} · ${y <= res.work ? "trabajando" : "jubilado"}${phaseTag}`,
    ];
    if (y <= res.work)
      lines.push(
        `Invertido: ${eur.format(res.invested[y])}`,
        `Con rentab.: ${eur.format(res.price[y])}`,
      );
    lines.push(
      `${y <= res.work ? "+ dividendos" : "Capital (€ de hoy)"}: ${eur.format(res.total[y])}`,
    );
    if (res.cash && res.cash[y] > 0.5)
      lines.push(`Efectivo: ${eur.format(res.cash[y])}`);
    if (s.advancedMode && res.opMarkers?.length) {
      const opsHere = res.opMarkers.filter((o) => o.year === y);
      for (const op of opsHere) {
        lines.push(`${op.err ? "⚠ " : "⚡ "}${op.label}`);
      }
    }
    if (s.showNominal && y >= res.work)
      lines.push(`Sin ajustar (€ nominales): ${eur.format(res.nominal[y])}`);
    tip.textContent = lines.join("\n");
    tip.hidden = false;
    moveTip();
    draw();
  }

  App.chart = { init, render };
})((window.App = window.App || {}));