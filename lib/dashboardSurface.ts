/**
 * Paginación del dashboard: tokens de superficie para controles de página.
 * Mantiene la paridad visual con `ArenaCard` y el comportamiento
 * chain-as-source-of-truth (la UI solo refleja datos confirmados).
 */

/**
 * Superficies del dashboard — alineadas a `ArenaCard` en Explorer: panel gris `pv-surface`
 * frente al fondo `pv-bg`, borde `white/[0.12]`, hover como en Arena (`#242323` + borde emerald).
 *
 * Evitar fondos muy transparentes que se confundan con el fondo de página.
 */

/** Tarjeta estándar: filas de lista, contenedor de VS, KPI (paridad `ArenaCard`). */
export const DASHBOARD_CARD_SURFACE =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface";

/** Hover para KPI y bloques planos interactivos (paridad `ArenaCard`). */
export const DASHBOARD_CARD_HOVER =
  "transition-[border-color,background-color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2";

/** Panel con padding (filtros, perfil de riesgo, quick actions). */
export const DASHBOARD_PANEL_SURFACE = `${DASHBOARD_CARD_SURFACE} p-4 sm:p-5`;

/** Estados vacíos / sin coincidencias (mismo relleno gris, borde discontinuo). */
export const DASHBOARD_SURFACE_DASHED =
  "rounded-xl border border-dashed border-pv-ink/[0.12] bg-pv-surface";

/** Barra de resumen, "load more" (tono gris intermedio, misma familia cromática). */
export const DASHBOARD_SURFACE_MUTED =
  "rounded-xl border border-pv-ink/[0.1] bg-pv-surface2/35";

/** Placeholder de carga de filas. */
export const DASHBOARD_SKELETON_ROW =
  "rounded-xl border border-pv-ink/[0.12] bg-pv-surface2/50";

/** Celdas de stats dentro de filas (mismo patrón que `ArenaCard`). */
export const DASHBOARD_STAT_CELL_SURFACE =
  "rounded border border-pv-ink/[0.1] bg-pv-ink/[0.03] px-3 py-2.5 sm:px-3.5 sm:py-3";

/** Contenedor de paginación (barra inferior de posiciones). */
export const DASHBOARD_PAGINATION_SURFACE = `${DASHBOARD_SURFACE_MUTED} flex flex-col gap-3 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between`;

/** Botón de página (prev/next/número) en estado habilitado. */
export const DASHBOARD_PAGINATION_BUTTON =
  "inline-flex min-h-9 items-center justify-center rounded-lg border border-pv-ink/[0.12] bg-pv-surface px-3 text-sm font-medium text-pv-ink transition-[border-color,background-color,color] duration-200 hover:border-pv-emerald/40 hover:bg-pv-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pv-emerald/60 disabled:cursor-not-allowed disabled:opacity-50";

/** Botón de página activo (página actual). */
export const DASHBOARD_PAGINATION_BUTTON_ACTIVE =
  "border-pv-emerald/60 bg-pv-surface2 text-pv-ink";

/** Texto de rango/estado de paginación (contador, "sin resultados"). */
export const DASHBOARD_PAGINATION_STATUS =
  "text-xs text-pv-ink/70 sm:text-sm";

/** Placeholder de carga para el bloque de paginación. */
export const DASHBOARD_PAGINATION_SKELETON =
  "h-9 w-full rounded-lg border border-pv-ink/[0.12] bg-pv-surface2/50 sm:w-40";
