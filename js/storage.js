/* Acceso seguro a localStorage (falla en silencio si no está disponible). */
(function (App) {
  'use strict';
  App.storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* cuota o modo privado */ }
    },
  };
})(window.App = window.App || {});
