/* TER anuales (%) de cada gestor, separados por tipo: ETF y fondo indexado. Se aplican al abrir la web. Edita aquí cuando un gestor cambie su comisión.
   Revisión del 2026-11-14 contra justETF, Finect, Rankia y las webs de las gestoras.
   ETF corregidos: iShares Nasdaq 100 0,33 → 0,30 (el 0,33 era la clase con cobertura), Amundi Nasdaq-100 0,23 → 0,22, Xtrackers MSCI World 0,19 → 0,12,
   Amundi S&P 500 0,15 → 0,05 (Amundi Core), iShares Core MSCI Japan IMI 0,15 → 0,12.
   ETF confirmados: iShares Core MSCI World 0,20, Amundi Core MSCI World 0,12, SPDR MSCI World 0,12, iShares MSCI ACWI 0,20, SPDR MSCI ACWI 0,12, Vanguard/iShares S&P 500 0,07,
   SPDR S&P 500 0,03, Invesco EQQQ 0,30, Xtrackers Nasdaq 100 0,20, iShares Core MSCI EM IMI 0,18, Xtrackers MSCI EM 0,18, Amundi MSCI EM 0,14, Vanguard FTSE EM 0,17,
   iShares Core MSCI Europe 0,12, Amundi MSCI Japan 0,12 y los de utilities/energía limpia/nuclear.
   Fondos indexados confirmados: Fidelity MSCI World 0,12, iShares Developed World (clase D) 0,12 y (clase S) 0,06, Amundi Index MSCI World 0,30, Vanguard Global Stock Index 0,18,
   Vanguard U.S. 500 0,10, Fidelity S&P 500 0,06, iShares US Index 0,12 y (clase S) 0,05, MyInvestor Nasdaq 100 0,41, Fondo Naranja Nasdaq 100 1,07, Vanguard European Stock Index 0,12,
   Vanguard Emerging Markets Stock Index 0,23, iShares Emerging Markets Index (clase S) 0,16, Vanguard Global Bond Index 0,15.
   SIN contrastar esta vez (valores anteriores o de referencia): vt-invesco, acwi-lg-imi (aportado por el usuario), vgk-vanguard, vgk-amundi, eem-fidelity, agg-vanguard, agg-ishares,
   qqq-bnp y los TER de las mezclas de energía (media de los dos ETF). Revísalos en la ficha de cada producto (campo "gastos corrientes"/OCF). */
window.App = window.App || {};
window.App.tersData = {
  "updated": "2026-11-14",
  "ters": {
    "vt-vanguard": 0.14, "vt-invesco": 0.15, "vt-vanguard-allcap": 0.07, "vt-vanguard-index": 0.18,
    "acwi-ishares": 0.2, "acwi-spdr": 0.12, "acwi-lg-imi": 0.16, "acwi-amundi": 0.09,
    "urth-ishares": 0.2, "urth-amundi": 0.12, "urth-xtrackers": 0.12, "urth-spdr": 0.12,
    "urth-fidelity": 0.12, "urth-ishares-index": 0.12, "urth-ishares-s": 0.06, "urth-amundi-index": 0.3,
    "spy-vanguard": 0.07, "spy-ishares": 0.07, "spy-spdr": 0.03, "spy-amundi": 0.05,
    "spy-vanguard-index": 0.1, "spy-fidelity-index": 0.06, "spy-ishares-index": 0.12, "spy-ishares-s": 0.05,
    "qqq-invesco": 0.3, "qqq-ishares": 0.3, "qqq-amundi": 0.22, "qqq-xtrackers": 0.2, "qqq-bnp": 0.14,
    "qqq-myinvestor": 0.41, "qqq-naranja": 1.07,
    "vgk-vanguard": 0.1, "vgk-ishares": 0.12, "vgk-amundi": 0.07, "vgk-vanguard-index": 0.12,
    "ewj-ishares": 0.12, "ewj-amundi": 0.12,
    "vwo-vanguard": 0.17, "vwo-vanguard-index": 0.23,
    "eem-ishares": 0.18, "eem-amundi": 0.14, "eem-xtrackers": 0.18, "eem-fidelity": 0.2, "eem-ishares-s": 0.16,
    "agg-vanguard": 0.08, "agg-ishares": 0.1, "agg-vanguard-index": 0.15,
    "util-xtrackers": 0.25, "util-amundi": 0.18, "util-spdr": 0.3,
    "clean-wisdomtree": 0.45, "clean-invesco-vaneck": 0.575, "clean-ishares-vaneck": 0.6
  }
};
