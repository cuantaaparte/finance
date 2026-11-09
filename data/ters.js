/* TER anuales (%) por gestor. Se aplican al abrir la web. Edita aquí cuando un gestor cambie su comisión.
   Revisión del 2026-11-09 (contra Vanguard, factsheets y webs de datos). Corregidos: vt-vanguard 0,19 → 0,14 (rebaja de Vanguard desde el
   28-07-2026), agg-vanguard 0,10 → 0,08 (rebaja de 2025) y vwo-vanguard 0,22 → 0,17 (confirmado en 2 webs de datos). Añadido: vt-vanguard-allcap (Vanguard FTSE Global All-Cap, VGLA/VALL, lanzado en agosto de 2026) a 0,07. Confirmados sin cambios:
   spy-vanguard 0,07 y spy-spdr 0,03. El RESTO no se ha vuelto a comprobar: revísalos en la ficha de cada producto (campo "gastos corrientes"/OCF). */
window.App = window.App || {};
window.App.tersData = {
  "updated": "2026-11-09",
  "ters": {
    "vt-vanguard": 0.14,
    "vt-invesco": 0.15,
    "vt-vanguard-allcap": 0.07,
    "acwi-ishares": 0.2,
    "acwi-spdr": 0.12,
    "urth-ishares": 0.2,
    "urth-amundi": 0.12,
    "urth-fidelity": 0.12,
    "urth-xtrackers": 0.19,
    "spy-vanguard": 0.07,
    "spy-ishares": 0.07,
    "spy-spdr": 0.03,
    "spy-amundi": 0.15,
    "qqq-invesco": 0.3,
    "qqq-ishares": 0.33,
    "qqq-amundi": 0.23,
    "qqq-xtrackers": 0.2,
    "vgk-vanguard": 0.1,
    "vgk-ishares": 0.12,
    "vgk-amundi": 0.07,
    "ewj-ishares": 0.15,
    "ewj-amundi": 0.12,
    "vwo-vanguard": 0.17,
    "eem-ishares": 0.18,
    "eem-amundi": 0.14,
    "eem-fidelity": 0.2,
    "eem-xtrackers": 0.18,
    "agg-vanguard": 0.08,
    "agg-ishares": 0.1
  }
};
