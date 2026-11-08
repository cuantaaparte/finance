/* Exportar / importar supuestos como un código de texto (sin DOM).
   Formato: FI1:<huella>:<longitud>:<datos>  → datos = JSON {v, name, state} en UTF-8 y base64 seguro para URL.
   La huella detecta códigos cortados o alterados; la longitud permite ignorar texto pegado después del código.
   Lo importado se trata como NO fiable: solo se aceptan claves conocidas, con su tipo y dentro de rangos razonables. */
(function (App) {
  'use strict';
  const { config, finance } = App;
  const PREFIX = 'FI1', VERSION = 1, MAX_LEN = 200000;
  const LIMITS = { // [mín, máx] de los campos numéricos
    net: [0, 1e7], needs: [0, 1e7], leisure: [0, 1e7], invest: [0, 1e7], initial: [0, 1e9],
    workYears: [1, 100], retireYears: [1, 100], inflation: [-10, 100], brokerFee: [0, 100], retNeeds: [0, 1e7], retLeisure: [0, 1e7],
  };
  const ENUMS = { period: ['month', 'year'], stratBase: ['avg', 'mine'] };

  const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
  const toB64 = bytes => { let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const fail = msg => { throw new Error(msg); };
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

  /** Convierte un supuesto {name, state} en un código de una sola línea. */
  function encode(sc) {
    const data = toB64(new TextEncoder().encode(JSON.stringify({ v: VERSION, name: sc.name, state: sc.state })));
    return `${PREFIX}:${hash(data)}:${data.length}:${data}`;
  }

  /** Valida y limpia un estado importado: parte de los valores por defecto y solo acepta lo que reconoce. */
  function cleanState(src) {
    const D = config.DEFAULT_STATE, out = structuredClone(D);
    if (!isObj(src)) fail('El código no contiene datos de un supuesto.');
    for (const k of Object.keys(D)) {
      const v = src[k], d = D[k];
      if (k in ENUMS) out[k] = ENUMS[k].includes(v) ? v : d;
      else if (k === 'histFrom' || k === 'histTo') out[k] = Number.isInteger(v) && v >= 1900 && v <= 2100 ? v : null;
      else if (k === 'touched') out[k] = { needs: !!(isObj(v) && v.needs), leisure: !!(isObj(v) && v.leisure) };
      else if (k === 'alloc' || k === 'prov') continue; // se tratan después
      else if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
      else if (typeof d === 'number') { const [lo, hi] = LIMITS[k] || [-1e9, 1e9]; out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
    }
    // Reparto: solo fondos que existen, con pesos entre 0 y 100; si no queda ninguno, el reparto por defecto.
    const alloc = {};
    if (isObj(src.alloc)) config.FUNDS.forEach(f => { const w = src.alloc[f.id]; if (Number.isFinite(w)) alloc[f.id] = Math.min(100, Math.max(0, w)); });
    out.alloc = Object.keys(alloc).length ? alloc : structuredClone(D.alloc);
    // Gestor de cada fondo: solo uno de los gestores reales de ese fondo.
    out.prov = {};
    if (isObj(src.prov)) config.FUNDS.forEach(f => { const p = src.prov[f.id]; if (typeof p === 'string' && f.providers.some(x => x.id === p)) out.prov[f.id] = p; });
    return finance.normalize(out);
  }

  /** Lee un código (aunque venga con espacios, saltos de línea o texto alrededor) y devuelve {name, state}. Lanza Error con un mensaje en español. */
  function decode(text) {
    const t = String(text ?? '').replace(/\s+/g, ''), i = t.indexOf(PREFIX + ':');
    if (i < 0) fail('No encuentro ningún código de supuesto en lo que has pegado.');
    const head = /^FI1:([0-9a-f]{8}):(\d{1,6}):/.exec(t.slice(i));
    if (!head) fail('El código no tiene el formato correcto.');
    const len = Number(head[2]);
    if (len > MAX_LEN) fail('El código es demasiado grande.');
    const start = i + head[0].length, data = t.slice(start, start + len);
    if (data.length < len) fail('El código está incompleto (¿se cortó al copiarlo?).');
    if (!/^[A-Za-z0-9_-]+$/.test(data) || hash(data) !== head[1]) fail('El código está dañado o se ha modificado.');
    let raw;
    try { raw = JSON.parse(new TextDecoder().decode(fromB64(data))); } catch { fail('No se puede leer el contenido del código.'); }
    if (!isObj(raw) || !Number.isInteger(raw.v)) fail('El código no contiene un supuesto válido.');
    if (raw.v > VERSION) fail('Este código viene de una versión más nueva de la web; actualízala para importarlo.');
    const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return { name: name || 'Supuesto importado', state: cleanState(raw.state) };
  }

  App.scenarioCode = { encode, decode };
})(window.App = window.App || {});
