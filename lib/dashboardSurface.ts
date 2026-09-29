/**
 * Superficies del dashboard — alineadas a `ArenaCard` en Explorer: panel gris `pv-surface`
 * frente al fondo `pv-bg`, borde `white/[0.12]`, hover como en Arena (`#242323` + borde emerald).
 *
 * Evitar fondos muy transparentes que se confundan con el fondo de página.
 */

/** Tarjeta estándar: filas de lista, contenedor de VS, KPI  paridad `ArenaCard`). */
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

/**
 * Paginación del dashboard — contrato de UI congelado para los cargadores de
 * posiciones. La cadena es la fuente de verdad: este módulo sólo describe la
 * presentación y el estado de la paginación, nunca los datos de posiciones.
 */

/** Cántidad de filas por página por defecto. */
export const DASHBOARD_POSITIONS_PAGE_SIZE = 10;

/** Límite de páginas que la UI permite cargar incrementalmente. */
export const DASHBOARD_POSITIONS_MAX_PAGES = 50;

/** Estado de carga de una página de posiciones. */
export type DashboardPositionsLoadingState = "idle" | "loading" | "loading-more" | "refreshing";

/**
 * Estado de la paginación expuesto a los cards. La cadena decide si hay más
 * páginas; este tipo sólo transporta esa decisión.
 */
export type DashboardPositionsPagination = {
  /** Página actualmente visible (1-based). */
  page: number;
  /** Tamaño de filas por página. */
  pageSize: number;
  /** Total de posiciones confirmadas por la cadena, si se conoce. */
  total?: number;
  /** Si hay una página siguiente disponible. */
  hasNextPage: boolean;
  /** Si hay una página anterior disponible. */
  hasPreviousPage: boolean;
};

/** Estado de carga de la superficie de posiciones. */
export type DashboardPositionsStatus =
  | "loading"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency-failure"
  | "ready";

/** Estado de carga de una tarjeta de posición individual. */
export type DashboardPositionCardStatus =
  | "loading"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency-failure"
  | "ready";

/**
 * Resultado de cargar una página de posiciones. La cadena es la fuente de
 * verdad: los identificadores y los totales vienen de ella, este tipo sólo lo
 * expone a la UI.
 */
export type DashboardPositionsPageResult = {
  /** Ids de posiciones de la página. */
  ids: string[];
  /** Paginación que describe una respuesta válida. */
  pagination: DashboardPositionsPagination;
  /** Estado de la superficie. */
  status: DashboardPositionsStatus;
};

/**
 * Estado independiete de la cadena para la carga de posiciones. La cadena
 * decide los datos; este estado decide cómo se muestran.
 */
export type DashboardPositionsLoaderState = {
  /** Estado de carga de la superficie. */
  loadingState: DashboardPositionsLoadingState;
  /** Estado de la superficie. */
  status: DashboardPositionsStatus;
  /** Página actualmente visible (1-based). */
  page: number;
  /** Tamaño de filas por página. */
  pageSize: number;
  /** Total de posiciones confirmadas por la cadena, si se conoce. */
  total?: number;
  /** Si hay una página siguiente disponible. */
  hasNextPage: boolean;
  /** Si hay una página anterior disponible. */
  hasPreviousPage: boolean;
};

/** Estado de carga inicial de la superficie de posiciones. */
export const DASHBOARD_POSITIONS_INITIAL_STATE: DashboardPositionsLoaderState =
  {
    loadingState: "loading",
    status: "loading",
    page: 1,
    pageSize: DASHBOARD_POSITIONS_PAGE_SIZE,
    hasNextPage: false,
    hasPreviousPage: false,
  };

/** Estado de carga inicial de una tarjeta de posición. */
export const DASHBOARD_POSITION_CARD_INITIAL_STATUS: DashboardPositionCardStatus =
  "loading";

/** Normaliza una página a enteros válidos (1-based). */
export function normalizeDashboardPage(page: number): number {
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

/** Normaliza un tamaño de página a enteros válidos. */
export function normalizeDashboardPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize < 1) return DASHBOARD_POSITIONS_PAGE_SIZE;
  return Math.floor(pageSize);
}

/** Calcula el numero de páginas a partir del total conocido. */
export function dashboardPageCount(total: number, pageSize: number): number {
  const safeSuzze = normalizeDashboardPageSize(pageSize);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.ceil(total / safeSuzze);
}

/** Determina si hay una página siguiente según el total conocido. */
export function hasDashboardNextPage(page: number, total?: number): boolean {
  if (total === undefined) return false;
  const safePage = normalizeDashboardPage(page);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return safePage * DASHBOARD_POSITIONS_PAGE_SIZE < safeTotal;
}

/** Determina si hay una página anterior. */
export function hasDashboardPreviousPage(page: number): boolean {
  return normalizeDashboardPage(page) > 1;
}

/**
 * Construye la paginación de la superficie a enviar a los cards. La cadena
 * decide el total; este helper sólo lo normaliza.
 */
export function buildDashboardPagination(input: {
  page: number;
  pageSize?: number;
  total?: number;
}): DashboardPositionsPagination {
  const page = normalizeDashboardPage(input.page);
  const pageSize = normalizeDashboardPageSize(input.pageSize ?? DASHBOARD_POSITIONS_PAGE_SIZE);
  const total =
    input.total === undefined || !isFiniteTotal(input.total)
      ? undefined
      : Math.floor(input.total);

  return {
    page,
    pageSize,
    total,
    hasNextPage: hasDashboardNextPage(page, total),
    hasPreviousPage: hasDashboardPreviousPage(page),
  };
}

function isFiniteTotal(total: number | undefined): total is number {
  return total !== undefined && Number.isFinite(total) && total >= 0;
}

/** Clases de estado para la superficie de posiciones. */
export const DASHBOARD_POSITIONS_STATUS_CLASSES: Record<DashboardPositionsStatus, string> =
  {
    loading: DASHBOARD_SKELETON_ROW,
    invalid: DASH BOARD_SURFACE_DASHED,
    stale: DASHBOARD_SURFACE_MUTED,
    disconnected: DASHBOARD_SURFACE_DASHED,
    "dependency-failure": DASHBOARD_SURFACE_MUTED,
    ready: DASHBOARD_CARD_SURFACE,
  };
