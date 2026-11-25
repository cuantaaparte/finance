# Simulador de Inversiones y Planificación Financiera

Ver aquí: https://nestor-dev-dev.github.io/finance/

Aplicación web para la simulación de carteras de inversión a largo plazo, planificación de jubilación (FIRE) y modelado fiscal multi-etapa. Desarrollada íntegramente en HTML5, CSS3 y JavaScript vanilla sin dependencias externas, diseñada para ejecutarse tanto en servidor web como de forma local (`file://`).

---

## Descripción general

El simulador proyecta la evolución del patrimonio en euros reales (ajustados a inflación) y nominales, integrando datos históricos de mercado, comisiones de gestión (TER y bróker), fiscalidad progresiva por tramos y análisis de riesgo mediante simulación de Monte Carlo.

Su motor soporta desde planes estándar de acumulación y retirada hasta estrategias complejas por fases temporales independientes con seguimiento individualizado por activo y liquidez.

---

## Características principales

### Motor financiero y simulación por activos
- **Cálculo en términos reales y nominales:** proyección mensual ajustada a inflación con opción de visualizar la curva nominal sin descontar.
- **Carteras independientes por activo:** cada fondo o ETF acumula rendimiento de forma aislada según su rentabilidad histórica (CAGR), TER, dividendo neto y coste fiscal medio.
- **Estrategias sugeridas:** cálculo automático de escenarios de referencia (jubilación anticipada, capital perpetuo, optimización de ahorro y cartera 60/40) mediante búsqueda binaria sobre el motor de simulación.
- **Fondos personalizados:** creación y edición de activos propios (inventados o derivados de índices del catálogo) con parámetros configurables de rentabilidad, dividendos, volatilidad y correlación.

### Modo Avanzado (línea temporal multi-etapa)
- **Tramos secuenciales:** división independiente de la etapa de acumulación (`Invertir`) y la etapa de retirada (`Gastar`) con reordenación mediante *Drag & Drop*.
- **Operaciones puntuales:** inserción de eventos de venta (a efectivo con cálculo fiscal de plusvalías), compra (limitada al efectivo disponible) y traspaso entre activos.
- **Diferimiento fiscal:** distinción automática entre traspasos exentos (`Fondo -> Fondo`, conservando el coste fiscal original) y operaciones sujetas a tributación (ventas o movimientos que involucren ETFs).
- **Validación estricta:** verificación en tiempo real de liquidez y saldo por fondo; detección y señalización visual de operaciones imposibles o tramos de retirada sin fondos suficientes.

### Modelado fiscal
- **Fiscalidad progresiva configurable:** soporte para múltiples países y tramos personalizados (base imponible, tipo marginal, mínimo exento, porcentaje de inclusión y cotizaciones sociales).
- **Cálculo por coste medio:** estimación dinámica de la proporción de plusvalía en cada retirada y conversión bidireccional entre ingresos netos deseados y retirada bruta necesaria.
- **Independencia por tramo:** permite configurar distintos regímenes fiscales en cada fase de retirada.

### Análisis de riesgo (Monte Carlo)
- **Remuestreo histórico por bloques:** ejecución de 300 simulaciones con bloques de 12 meses sobre series históricas reales para preservar rachas, volatilidad y caídas máximas (*drawdowns*).
- **Variabilidad de inflación:** incorporación de la desviación estándar histórica de la inflación en cada iteración anual.
- **Puntuación de riesgo (0-100):** métrica compuesta a partir de la probabilidad de agotamiento del capital y el momento en que ocurre.

### Visualización y portabilidad
- **Gráfica nativa en `<canvas>`:** renderizado de alto rendimiento sin librerías externas, con soporte HiDPI, bandas de fase, marcadores de operaciones con antisolapamiento automático y *tooltip* interactivo.
- **Persistencia y exportación:** guardado automático en `localStorage` y sistema de exportación/importación de supuestos mediante códigos compactos en Base64 con verificación de integridad (`FI1:<hash>:<len>:<payload>`).

---

## Arquitectura del proyecto

El proyecto sigue una arquitectura modular clásica basada en el patrón IIFE sobre un espacio de nombres único (`window.App`), separando estrictamente la lógica matemática, la gestión de datos y la capa de interfaz.

```text
.
├── index.html                  # Estructura principal y diálogos modales
├── css/
│   └── styles.css              # Diseño responsive (escritorio y móvil) y variables CSS
├── data/
│   ├── market-data.js          # Series históricas de mercado
│   ├── ters.js                 # Comisiones (TER) por proveedor y tipo de producto
│   ├── tax-data.js             # Tablas fiscales de referencia por país
│   └── fund-distributions.js   # Composición orientativa (empresas y países) por fondo
└── js/
    ├── config.js               # Esquema de formularios, catálogo de fondos y valores por defecto
    ├── storage.js              # Abstracción de persistencia en localStorage
    ├── dataService.js          # Carga de datos históricos, cálculo de CAGR y estadísticas de cartera
    ├── taxes.js                # Motor fiscal progresivo e inversión bruto/neto
    ├── customFunds.js          # Gestión y validación de fondos personalizados
    ├── advancedMode.js         # Estado y componentes UI de la línea temporal y operaciones
    ├── finance.js              # Motor de simulación estándar, multi-hucha y Monte Carlo
    ├── scenarioCode.js         # Codificación, validación y sanitización de supuestos importados
    ├── chart.js                # Renderizado de la gráfica interactiva en Canvas 2D
    ├── ui.js                   # Orquestación del DOM, eventos y modales
    └── main.js                 # Punto de entrada e inicialización de la aplicación
