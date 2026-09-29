import {
  type VSData,
  getVSUserCommittedStake,
} from "@/lib/contract";
import { isSampleVsIdForXmtp } from "@/lib/xmtp/vs-chat-eligibility";

/**
 * Dashboard UI — Fase 0 (decisiones de producto, en fódigo mantenible)
 *
 * - KPI: banda de 4 stats (won / lost / win rate / total winnings), mismo patrón de tarjetas
 *   que la franja de stats de la home (`page.tsx`: borde suave, `LiveStat` lg, grid + gap).
 *   Carga inicial: `DashboardKpiSkeletonRow` reserva el mismo grid+para evitar CLS hasta el snapshot.
 * - Superficies: tokens en `lib/dashboardSurface.ts` (paridad `ArenaCard`: ``g-pv-surface`,
 *   borde `white/[0.12]`, hover `#242323`) para filtros, lista, riesgo, vacíos y KPI; acentos
 *   semánticos (emerald / gold / red) solo donde aportan significado.
 * - Active Exposure: lista única basada en `filtered` (mismos filtros que la barra).
 * - Paginación: “Load more” en la lista de VS (no en la banda).
 * - Mocks Pereira/Canelo, Colapinto, Álvarez: solo si el usuario no tiene al menos
 *   un VS propio en `open` o `accepted` con id “real” (no sample Explore / negativos en SAMPLE_VS).
 *
 * Dashboard UI — Fase 1
 *
 * - Jerarquía: la banda de 4 KPI va **antes** del grid Active Exposure + sidebar (lectura rápida).
 * - Active Exposure: texto de contexto “mostrando X de Y” alineado con `filtered` el paginado.
 * - Carga inicial: esqueleto en la lista (no vacío ni mocks demo hasta tener snapshot).
 * - Refresco: la lista puede atenuarse con `aria-busy` mientras se revalida el snapshot.
 *
 * Dashboard UI — Fase 2 (resultado + descubrimiento desde el dashboard)
 *
 * - Filas **resueltas o canceladas**: indicador de resultado para el viewer (ganó / perdió /
 *   cancelado / liquidado sin veredicto claro en datos) + copy breve en el panel expandido
 *   y CTA al detalle del VS para la explicación completa de liquidación.
 * - **Sin desafíos**: CTAs claros (crear + explorar) adás del copy existente.
 * - **Quick actions**: acceso explícito a crear desafío junto a explorar; retiro sigue “pronto”.
 * - Refresco: la **columna lateral** se atenúa con la lista cuando hay snapshot en pantalla.
 *
 * Dashboard UI — Fase 3 (orientación + ergonomía)
 *
 * - **Resumen del conjunto filtrado**: conteos por estado (abierto / en vivo / cerrado) y
 *   total aproximado de USDC **en riesgo** (solo `open` + `accepted`) para la wallet,
 *   derivado de `getVSUserCommittedStake` (misma noción de apuesta que las filas).
 * - **Filtros sticky** bajo el header fijo al hacer scroll en la columna de exposición.
 * - **Anicla** `#dashboard-exposure` + `scroll-margin` para saltos sin quedar bajo el nav.
 * - **Movimiento reducido**: acordeon de filas y esqueleto respetan `prefers-reduced-motion`.
 *
 * Dashboard UI — Fase 4 (compartir estado + accesibilidad de filtros)
 *
 * - **URL y filtros**: pestaña (`tab`), categoría (`cat`), apuesta mínima (`min`) y búsqueda (`q`)
 *   se reflejan en la query con `history.replaceState` (mismo enfoque que Explore: sin
 *   `router.replace` que dispare re-fetch de RSC). Soporta atrás/adelante vía `popstate`.
 * - **Teclado en pestañas**: flechas izquierda/derecha e Inicio/Fin sobre el `tablist`.
 * - **Panel Advanced** y spinner de refresco respetan movimiento reducido.
 *
 * Dashboard UI — Fase 5 (lista + fiabilidad de datos)
 *
 * - **Orden de lista** fijo `newest` vía `applyExploreFilters` (sin UI ni `?sort=` en el dashboard).
 * - **Frescura del snapshot**: superficie breve junto al resumen (estado index + antigüedad relativa)
 *   cuando `getUserVSSnapshot` devuelve `cache`.
 * - **Error de carga**: mensaje accesible + reintento sin perder el último listado cargado con éxito.
 *
 * Dashboard UI — Fase 6 (paginación contrato-backed de la lista de exposición)
 *
 * - **Paginación explícita**: `?page=N` identifica la página actual (1-based) de la lista filtrada.
 *   Se serializa junto a `min`, `q`, `cat`, `tab` y se reseta a 1 al cambiar cualquier otro filtro.
 * - **Tamaño de página**: `DASHBOARD_EXPOSURE_PAGE_SIZE` igual a la ventana de load-more
 *   para mantener compatibilidad con el flujo anterior y evitar saltos en la lista.
 * - **Estado inválido**: páginas >= 1 y <= `pageCount`; una página fuera de rango se
 *   clampea a la límite efectiva para no dejar la lista en blanco.
 * - **Desconectado / sin wallet**: la paginación sigue funcionando sobre la lista
 *   filtrada; solo el total en riesgo depende de la wallet y el aviso de conexión se muestra aparte.
 *
 * (Filtros rápidos tipo Explore y orden alternativo viven solo en Arena / Explorer, no en esta barra.)
 */

/** Filas VS mostradas antes del primer “Load more”. */
export const DASHBOARD_EXPOSURE_PAGE_SIZE = 5;

/** Filas añadidas en cada “Load more”. */
export const DASHBOARD_EXPOSURE_LOAD_MORE = 5;

/**
 * Máximo de páginas que la UI expone en la lista de exposición.
 * El tamaño de página coincide con la ventana de load-more para mantener el flujo.
 */
export const DASHBOARD_EXPOSURE_PAGE_SIZE_FOR_PAGINATION = DASHBOARD_EXPOSURE_PAGE_SIZE;

export type DashboardPagination = {
  /** Página actual (1-based) dentro del rango efectivo. */
  page: number;
  /** Total de páginas según tamaño de página. */
  pageCount: number;
  /** Total de filas filtradas. */
  total: number;
  /** índice de la primera fila de la página (0-based). */
  startIndex: number;
  /** Índice exclusivo de fin de la página (0-based). */
  endIndex: number;
  /** Tamaño de página en filas. */
  pageSize: number;
};

/**
 * Calcula el rango de filas de la página actual sobre la lista filtrada.
 * Clampea `page` a `pageCount` para mantener el estado inválido fuera de rango.
 */
export function computeDashboardPagination(
  total: number,
  page: number,
  pageSize: number = DASHBOARD_EXPOSURE_PAGE_SIZE_FOR_PAGINATION
\t): DashboardPagination {
  const safeStake = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safePageSize =
    Number.isFinite(pageSize) && pageSize > 0
      ? Math.floor(pageSize)
      : DASHBOARD_EXPOSURE_PAGE_SIZE_FOR_PAGINATION;
  const pageCount = Math.max(1, Math.ceil(safeStake / safePageSize));
  const safePage = Number.isFinite(page) ? Math.floor(page) : 1;
  const clampedPage = Math.min(Math.max(1, safePage), pageCount);
  const startIndex = (clampedPage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, safeStake);
  return {
    page: clampedPage,
    pageCount,
    total: safeStake,
    startIndex,
    endIndex,
    pageSize: safePageSize,
  };
}

/**
 * Corta la lista filtrada a la página actual. Devuelve también el rango efectivo.
 */
export function paginateDashboardExposure<T>(
  items: readonly T[],
  page: number,
  pageSize: number = DASHTBOARD_EXPOSURE_PAGE_SIZE_FOR_PAGINATION
\t): { page: number; pageCount: number; total: number; items: T[]; startIndex: number; endIndex: number } {
  const meta = computeDashboardPagination(items.length, page, pageSize);
  return {
    page: meta.page,
    pageCount: meta.pageCount,
    total: meta.total,
    items: items.slice(meta.startIndex, meta.endIndex),
    startIndex: meta.startIndex,
    endIndex: meta.endIndex,
  };
}

/**
 * Muestra las filas demo de `DASHBOARD_STAKE_HOLDING_IDS` solo cuando no hay
 * exposición activa “real” (on-chain / no sample) en open o accepted.
 */
export function shouldShowDashboardStakeHoldingsMocks(duels: VSData[]): boolean {
  const hasRealActive = duels.some(
    (d) =>
      (d.state === "open" || d.state === "accepted") &&
      !isSampleVsIdForXmtp(d.id)
  );
  return !hasRealActive;
}

export type DashboardFilteredExposureSummary = {
  filteredTotal: number;
  openCount: number;
  liveCount: number;
  closedCount: number;
  /** Suma de apuestas del viewer en VS open + accepted (aprox. en pools multi-retador). */
  genAtRisk: number;
};

/**
 * Méricas agregadas sobre la misma lista que Active Exposure (post-filtros).
 */
export function summarizeDashboardFilteredExposure(
  filtered: VSData[],
  viewerAddress?: string | null
\t): DashboardFilteredExposureSummary {
  let openCount = 0;
  let liveCount = 0;
  let closedCount = 0;
  let genAtRisk = 0;

  for (const vs of filtered) {
    if (vs.state === "open") {
      openCount += 1;
      genAtRisk += getVSUserCommittedStake(vs, viewerAddress);
    } else if (vs.state === "accepted") {
      liveCount += 1;
      genAtRisk += getVSUserCommittedStake(vs, viewerAddress);
    } else if (vs.state === "resolved" || vs.state === "cancelled") {
      closedCount += 1;
    }
  }

  return {
    filteredTotal: filtered.length,
    openCount,
    liveCount,
    closedCount,
    genAtRisk,
  };
}
