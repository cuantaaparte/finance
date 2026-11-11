/* Impuestos por país para lo que sacas de las inversiones al jubilarte. Edita este archivo cuando cambien los tramos
   (no existe una API pública fiable de tramos fiscales; el tipo de cambio sí se actualiza solo en tools/update-data.mjs).
   - Importes ANUALES, en la moneda del país, con los valores de hoy: la web supone que los tramos se ajustan a la inflación cada año.
   - upTo = límite superior del tramo sobre la base imponible (null = en adelante); rate = tipo marginal (%).
   - allowance = mínimo exento que se resta antes de aplicar los tramos. fx = unidades de moneda por 1 € (solo de reserva).
   - social = cotizaciones (% sobre lo retirado). Vacío: las retiradas de inversiones no cotizan a la Seguridad Social.
   Valores de referencia de 2025 (impuesto estatal/federal sobre la renta de una persona soltera, sin deducciones personales). Revísalos con tu hacienda. */
(function (App) {
  'use strict';
  const B = (...rows) => rows.map(([upTo, rate]) => ({ upTo, rate }));
  App.taxData = {
    updated: '2026-11-11',
    countries: [
      { id: 'ES', name: 'España', currency: 'EUR', fx: 1, year: 2025, note: 'IRPF estatal + autonómico (escala combinada); según la comunidad varía algo.',
        scales: [
          { id: 'general', short: 'general', name: 'IRPF general (como un sueldo)', allowance: 5550, social: [], brackets: B([12450, 19], [20200, 24], [35200, 30], [60000, 37], [300000, 45], [null, 47]),
            note: 'El mínimo personal (5.550 €) se aproxima como una deducción de la base.' },
          { id: 'ahorro', short: 'ahorro', name: 'Base del ahorro (plusvalías y dividendos)', allowance: 0, social: [], brackets: B([6000, 19], [50000, 21], [200000, 23], [300000, 27], [null, 30]),
            note: 'Es como tributa vender fondos, pero solo sobre la ganancia.' }] },
      { id: 'US', name: 'EE. UU.', currency: 'USD', fx: 1.16, year: 2025, note: 'Solo impuesto federal (soltero); faltan los impuestos de cada estado.',
        scales: [{ id: 'federal', short: 'federal', name: 'Federal', allowance: 15750, social: [], brackets: B([11925, 10], [48475, 12], [103350, 22], [197300, 24], [250525, 32], [626350, 35], [null, 37]), note: 'Deducción estándar de 15.750 $.' }] },
      { id: 'CH', name: 'Suiza', currency: 'CHF', fx: 0.93, year: 2025, approx: true, note: 'Solo impuesto federal directo, aproximado. Cantones y comunas añaden bastante más: usa «Personalizado» para el tuyo.',
        scales: [{ id: 'federal', short: 'federal', name: 'Federal', allowance: 0, social: [], brackets: B([14800, 0], [32200, 0.77], [42200, 0.88], [56000, 2.64], [72700, 2.97], [78100, 5.94], [103600, 6.6], [134600, 8.8], [176000, 11], [755200, 13.2], [null, 11.5]) }] },
      { id: 'DE', name: 'Alemania', currency: 'EUR', fx: 1, year: 2025, approx: true, note: 'La escala alemana es una fórmula progresiva continua; aquí se aproxima por tramos. Sin recargo de solidaridad ni impuesto eclesiástico.',
        scales: [{ id: 'general', short: 'general', name: 'Einkommensteuer (soltero)', allowance: 0, social: [], brackets: B([12096, 0], [17443, 19], [30202, 26.25], [42961, 30.75], [55719, 35.25], [68480, 39.75], [277825, 42], [null, 45]) }] },
      { id: 'PT', name: 'Portugal', currency: 'EUR', fx: 1, year: 2025, note: 'IRS del continente, sin la tasa adicional de solidaridad.',
        scales: [{ id: 'general', short: 'general', name: 'IRS', allowance: 0, social: [], brackets: B([8342, 12.5], [12587, 16], [17838, 21.5], [23089, 24.4], [29397, 31.4], [43090, 34.9], [46566, 43.1], [86634, 44.6], [null, 48]) }] },
      { id: 'AD', name: 'Andorra', currency: 'EUR', fx: 1, year: 2025, note: 'IRPF andorrano (tramo exento hasta 24.000 €).',
        scales: [{ id: 'general', short: 'general', name: 'IRPF', allowance: 0, social: [], brackets: B([24000, 0], [40000, 5], [null, 10]) }] },
      { id: 'FR', name: 'Francia', currency: 'EUR', fx: 1, year: 2025, note: 'Impuesto sobre la renta (1 parte fiscal); sin cargas sociales sobre el capital.',
        scales: [{ id: 'general', short: 'general', name: 'Barème IR', allowance: 0, social: [], brackets: B([11497, 0], [29315, 11], [83823, 30], [180294, 41], [null, 45]) }] },
      { id: 'IT', name: 'Italia', currency: 'EUR', fx: 1, year: 2025, note: 'IRPEF estatal; faltan las adicionales regional y municipal.',
        scales: [{ id: 'general', short: 'general', name: 'IRPEF', allowance: 0, social: [], brackets: B([28000, 23], [50000, 35], [null, 43]) }] },
      { id: 'PL', name: 'Polonia', currency: 'PLN', fx: 4.25, year: 2025, note: 'La cuota libre de 30.000 PLN se modela como un primer tramo al 0 %.',
        scales: [{ id: 'general', short: 'general', name: 'PIT (escala)', allowance: 0, social: [], brackets: B([30000, 0], [120000, 12], [null, 32]) }] },
      { id: 'AE', name: 'Dubái (EAU)', currency: 'AED', fx: 4.26, year: 2025, note: 'Sin impuesto sobre la renta de las personas físicas.',
        scales: [{ id: 'general', short: 'general', name: 'Sin IRPF', allowance: 0, social: [], brackets: B([null, 0]) }] },
      { id: 'CA', name: 'Canadá', currency: 'CAD', fx: 1.62, year: 2025, note: 'Solo impuesto federal; faltan los provinciales.',
        scales: [{ id: 'federal', short: 'federal', name: 'Federal', allowance: 16129, social: [], brackets: B([57375, 14.5], [114750, 20.5], [177882, 26], [253414, 29], [null, 33]), note: 'Importe personal básico de 16.129 $ como deducción; el tipo más bajo de 2025 es 14,5 % (media del año).' }] },
      { id: 'GB', name: 'Reino Unido', currency: 'GBP', fx: 0.87, year: 2025, note: 'Inglaterra, Gales e Irlanda del Norte (Escocia tiene otros tramos). Sin recorte del mínimo personal a partir de 100.000 £.',
        scales: [{ id: 'general', short: 'general', name: 'Income Tax', allowance: 0, social: [], brackets: B([12570, 0], [50270, 20], [125140, 40], [null, 45]) }] },
    ],
  };
})(window.App = window.App || {});
