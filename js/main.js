/* Punto de entrada: pinta la UI con datos estimados y la actualiza cuando llegan precios y TER reales. */
(async function (App) {
  'use strict';
  App.ui.init();
  await App.data.loadAll();
  App.ui.refresh();
})(window.App);
