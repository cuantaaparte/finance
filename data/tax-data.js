/* Impuestos por país para lo que sacas de las inversiones al jubilarte. Edita este archivo cuando cambien los tramos
   (el tipo de cambio se actualiza solo en tools/update-data.mjs).
   - Cada país tiene uno o varios "regímenes" (scales). El primero es el que se usa por defecto.
   - on: 'gain' = solo tributa la parte de lo retirado que es ganancia (plusvalías); 'all' = tributa todo lo retirado como renta.
   - Importes ANUALES, en la moneda del país y con los valores de hoy: la web supone que los tramos se ajustan a la inflación cada año.
   - upTo = límite superior del tramo sobre la base imponible (null = en adelante); rate = tipo marginal (%).
   - allowance = mínimo exento que se resta antes de aplicar los tramos; inclusion = parte de la base que tributa (1 = toda).
   - social = cotizaciones (% sobre la base). Vacío: no cotizan. fx = unidades de moneda por 1 € (solo de reserva).
   - divRate = impuesto sobre los dividendos (%). Si falta, se usa el tipo de las ganancias (primer tramo que ya paga algo).
   Valores de referencia de 2025 para una persona soltera, solo impuesto estatal/federal. Revísalos con tu hacienda. */
(function (App) {
  'use strict';
  const B = (...rows) => rows.map(([upTo, rate]) => ({ upTo, rate }));
  const flat = rate => B([null, rate]);
  App.taxData = {
    updated: '2026-11-11',
    countries: [
      { id: 'ES', name: 'España', currency: 'EUR', fx: 1, year: 2025, note: 'IRPF estatal + autonómico (escalas combinadas); según la comunidad varía algo.',
        scales: [
          { id: 'ahorro', short: 'plusvalías', name: 'Ganancias de fondos (base del ahorro)', on: 'gain', allowance: 0, social: [], brackets: B([6000, 19], [50000, 21], [200000, 23], [300000, 27], [null, 30]) },
          { id: 'general', short: 'renta general', name: 'Como renta general (IRPF)', on: 'all', allowance: 0, social: [], brackets: B([5550, 0], [12450, 19], [20200, 24], [35200, 30], [60000, 37], [300000, 45], [null, 47]), note: 'El mínimo personal (5.550 €) reduce la cuota: se modela como un primer tramo al 0 %, sin mover los demás límites.' }] },
      { id: 'US', name: 'EE. UU.', currency: 'USD', fx: 1.16, year: 2026, note: 'Solo impuesto federal (soltero); faltan los impuestos de cada estado y el 3,8 % adicional para rentas altas.',
        scales: [
          { id: 'ltcg', short: 'plusvalías', name: 'Ganancias a largo plazo (más de 1 año)', on: 'gain', allowance: 16100, social: [], brackets: B([49450, 0], [545500, 15], [null, 20]), note: 'Deducción estándar de 16.100 $.' },
          { id: 'ordinary', short: 'renta ordinaria', name: 'Como renta ordinaria', on: 'all', allowance: 16100, social: [], brackets: B([12400, 10], [50400, 12], [105700, 22], [201775, 24], [256225, 32], [640600, 35], [null, 37]) }] },
      { id: 'CH', name: 'Suiza', currency: 'CHF', fx: 0.93, year: 2025, note: 'Un inversor particular no paga impuesto por las plusvalías de sus fondos. Los cantones y comunas gravan más la renta: usa «Personalizado» para el tuyo.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Ganancias de fondos (exentas)', on: 'gain', allowance: 0, divRate: 0.77, social: [], brackets: flat(0) },
          { id: 'income', short: 'renta', name: 'Como renta (solo federal, aproximado)', on: 'all', allowance: 0, social: [], approx: true, brackets: B([14800, 0], [32200, 0.77], [42200, 0.88], [56000, 2.64], [72700, 2.97], [78100, 5.94], [103600, 6.6], [134600, 8.8], [176000, 11], [755200, 13.2], [null, 11.5]) }] },
      { id: 'DE', name: 'Alemania', currency: 'EUR', fx: 1, year: 2025, note: 'Sin impuesto eclesiástico ni la exención parcial del 30 % de los fondos de renta variable.',
        scales: [
          { id: 'abgeltung', short: 'plusvalías', name: 'Ganancias de fondos (Abgeltungsteuer 25 % + solidaridad)', on: 'gain', allowance: 1000, social: [], brackets: flat(26.375), note: 'Incluye el recargo de solidaridad (5,5 %) y la exención de 1.000 € de ahorro.' },
          { id: 'income', short: 'renta', name: 'Como renta (Einkommensteuer, aproximado)', on: 'all', allowance: 0, social: [], approx: true, brackets: B([12096, 0], [17443, 19], [30202, 26.25], [42961, 30.75], [55719, 35.25], [68480, 39.75], [277825, 42], [null, 45]) }] },
      { id: 'PT', name: 'Portugal', currency: 'EUR', fx: 1, year: 2025, note: 'IRS del continente, sin la tasa adicional de solidaridad.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Ganancias de fondos (28 %)', year: 2026, on: 'gain', allowance: 0, social: [], brackets: flat(28), note: 'Con más de 2 años de tenencia, parte de la ganancia queda exenta (hasta un 30 % con 8 años o más); aquí no se aplica.' },
          { id: 'income', short: 'renta', name: 'Como renta (IRS)', on: 'all', allowance: 0, social: [], brackets: B([8342, 12.5], [12587, 16], [17838, 21.5], [23089, 24.4], [29397, 31.4], [43090, 34.9], [46566, 43.1], [86634, 44.6], [null, 48]) }] },
      { id: 'AD', name: 'Andorra', currency: 'EUR', fx: 1, year: 2025, note: 'Sin cotizaciones a la CASS sobre rentas del capital.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Plusvalías (10 %)', on: 'gain', allowance: 0, social: [], brackets: flat(10) },
          { id: 'income', short: 'renta', name: 'Como renta (IRPF)', on: 'all', allowance: 0, social: [], brackets: B([24000, 0], [40000, 5], [null, 10]) }] },
      { id: 'FR', name: 'Francia', currency: 'EUR', fx: 1, year: 2025, note: 'Impuesto sobre la renta de 1 parte fiscal.',
        scales: [
          { id: 'pfu', short: 'plusvalías', name: 'Flat tax (PFU: 31,4 % en total desde 2026)', year: 2026, on: 'gain', allowance: 0, brackets: flat(12.8), social: [{ name: 'Cargas sociales (CSG, CRDS…)', rate: 18.6 }] },
          { id: 'income', short: 'renta', name: 'Como renta (barème progresivo)', on: 'all', allowance: 0, social: [], brackets: B([11497, 0], [29315, 11], [83823, 30], [180294, 41], [null, 45]) }] },
      { id: 'IT', name: 'Italia', currency: 'EUR', fx: 1, year: 2025, note: 'IRPEF estatal; faltan las adicionales regional y municipal.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Ganancias de fondos (26 %)', on: 'gain', allowance: 0, social: [], brackets: flat(26) },
          { id: 'income', short: 'renta', name: 'Como renta (IRPEF)', year: 2026, on: 'all', allowance: 0, social: [], brackets: B([28000, 23], [50000, 33], [null, 43]) }] },
      { id: 'PL', name: 'Polonia', currency: 'PLN', fx: 4.25, year: 2025, note: 'La cuota libre de 30.000 PLN se modela como un primer tramo al 0 %.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Ganancias de fondos (impuesto Belka, 19 %)', on: 'gain', allowance: 0, social: [], brackets: flat(19) },
          { id: 'income', short: 'renta', name: 'Como renta (PIT)', on: 'all', allowance: 0, social: [], brackets: B([30000, 0], [120000, 12], [null, 32]) }] },
      { id: 'AE', name: 'Dubái (EAU)', currency: 'AED', fx: 4.26, year: 2025, note: 'Sin impuesto sobre la renta ni sobre las plusvalías de las personas físicas.',
        scales: [{ id: 'none', short: 'sin impuestos', name: 'Sin impuestos', on: 'gain', allowance: 0, social: [], brackets: flat(0) }] },
      { id: 'CA', name: 'Canadá', currency: 'CAD', fx: 1.62, year: 2026, note: 'Solo impuesto federal; faltan los provinciales.',
        scales: [
          { id: 'gain', short: 'plusvalías', name: 'Ganancias de capital (tributa el 50 %)', on: 'gain', inclusion: 0.5, allowance: 0, divRate: 14, social: [], brackets: B([16452, 0], [58523, 14], [117045, 20.5], [181440, 26], [258482, 29], [null, 33]), note: 'El importe personal básico (16.452 $) se modela como un primer tramo al 0 % sobre la parte que tributa. Los dividendos de fondos extranjeros tributan como renta ordinaria.' },
          { id: 'income', short: 'renta', name: 'Como renta ordinaria', on: 'all', allowance: 0, social: [], brackets: B([16452, 0], [58523, 14], [117045, 20.5], [181440, 26], [258482, 29], [null, 33]) }] },
      { id: 'GB', name: 'Reino Unido', currency: 'GBP', fx: 0.87, year: 2025, note: 'Inglaterra, Gales e Irlanda del Norte (Escocia tiene otros tramos).',
        scales: [
          { id: 'cgt', short: 'plusvalías', name: 'Ganancias de capital (CGT)', on: 'gain', allowance: 3000, divRate: 8.75, social: [], brackets: B([37700, 18], [null, 24]), note: 'Exención anual de 3.000 £.' },
          { id: 'income', short: 'renta', name: 'Como renta (Income Tax)', on: 'all', allowance: 0, social: [], brackets: B([12570, 0], [50270, 20], [125140, 40], [null, 45]) }] },
    ],
  };
})(window.App = window.App || {});
