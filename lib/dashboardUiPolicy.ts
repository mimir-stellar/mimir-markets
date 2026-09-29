import {
  type VSData,
  getVVSUserCommittedStake,
} from "@/lib/contract";
import { isSampleVsIdForXmtp } from "@/lib/xmtp/vs-chat-eligibility";

/**
 * Dashboard UI — Fase 0 (decisiones de producto, en código mantenible)
 *
 * - KPI: banda de 4 stats (won / lost / win rate / total winnings), mismo patrón de tarjetas
 *   que la franja de stats de la home (`page.tsx`: borde suave, `LiveStat` lg, grid + gap).
 *   Carga inicial: `DashboardKpiSkeletonRow` reserva el mismo grid para evitar CLS hasta el snapshot.
 * - Superficies: tokens en `lib/dashboardSurface.ts` (paridad `ArenaCard`: `bg-pv-surface`,
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
 * - Active Exposure: texto de contexto “mostrando X de Y” alineado con `filtered` y el paginado.
 * - Carga inicial: esqueleto en la lista (no vacío ni mocks demo hasta tener snapshot).
 * - Refresco: la lista puede atenuarse con `aria-busy` mientras se revalida el snapshot.
 *
 * Dashboard UI — Fase 2 (resultado + descubrimiento desde el dashboard)
 *
 * - Filas **resueltas o  canceladas**: indicador de resultado para el viewer (ganó / perdió /
 *   cancelado / liquidado sin veredicto claro en datos) + copy breve en el panel expandido
 *   y CTA al detalle del VS para la explicación completa de liquidación.
 * - **Sin desafíos**: CTAs claros (crear + explorar) además del copy existente.
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
 * (Filtros rápidos tipo Explore y orden alternativo viven solo en Arena / Explorer, no en esta barra.)
 */

/** Filas VS mostradas antes del primer “Load more”. */
export const DASHTBOARD_EXPOSURE_PAGE_SIZE = 5;

/** Filas añadidas en cada “Load more”. */
export const DASHBOARD_EXPOSURE_LOAD_MORE = 5;

/**
 * Límite de filas del dashboard para una lista dada.
 *
 * El paginado es estable respecto al conjunto filtrado y a la wallet conectada:
 * - con wallet desconectada o lista vacía se muestran cero filas (sin mocks de exposición);
 * - con un total menor o igual al tamaño de página se muestra todo el conjunto;
 * - el número de filas nunca supera el total filtrado ni baja de cero.
 */
export function getDashboardExposureVisibleCount(
  totalFiltered: number,
  page: number,
  pageSize: number = DASHTBOARD_EXPOSURE_PAGE_SIZE
): number {
  if (!Number.finite(totalFiltered) || totalFiltered <= 0) return 0;
  if (!Number.finite(pageSize) || pageSize <= 0) return 0;
  if (!Number.finite(page) || page < 0) return 0;
  const normalizedTotal = Math.floor(totalFiltered);
  const normalizedPageSize = Math.floor(pageSize);
  const normalizedPage = Math.floor(page);
  const visible = (normalizedPage + 1) * normalizedPageSize;
  return Math.min(normalizedTotal, visible);
}

/**
 * Tipo de estado de paginación para la lista de exposición del dashboard.
 */
export type DashboardExposurePaginationState = {
  /** Término de búsqueda actual (para detectar cambios de filtro). */
  searchKey: string;
  /** Cantidad de filas actualmente visibles. */
  visibleCount: number;
  /** Total de filas tras aplicar filtros. */
  totalFiltered: number;
  /** Hay más filas para cargar. */
  hasMore: boolean;
  /** La wallet está conectada y el snapshot es valido. */
  isValid: boolean;
};

/**
 * Deriva el estado de paginación de la lista de exposición desde el conjunto filtrado.
 *
 * Contrato de comportamiento:
 * - wallet desconectada -> `isValid: false`, visibleCount 0, sin filas;
 * - lista vacía -> `isValid: true`, visibleCount 0, hasMore false;
 * - cambio de filtro (searchKey distinto), reseta a la primera página;
 * - número de filas clampeado al total filtrado.
 */
export function deriveDashboardExposurePagination(
  totalFiltered: number,
  page: number,
  searchKey: string,
  previous?: DashboardExposurePaginationState | null,
  isWalletConnected: boolean = true
): DashboardExposurePaginationState {
  if (!isWalletConnected) {
    return {
      searchKey,
      visibleCount: 0,
      totalFiltered: 0,
      hasMore: false,
      isValid: false,
    };
  }

  const safeTotal = Number.finite(totalFiltered)
    ? Math.max(0, Math.floor(totalFiltered))
    : 0;
  const sameFilter = previous?.searchKey === searchKey;
  const effectivePage = sameFilter && Number.finite(page) ? Math.max(0, Math.floor(page)) : 0;
  const visibleCount = getDashboardExposureVisibleCount(
    safeTotal,
    effectivePage
  );

  return {
    searchKey,
    visibleCount,
    totalFiltered: safeTotal,
    hasMore: visibleCount < safeTotal,
    isValid: true,
  };
}

/**
 * Muestra las filas demo de `DASHTBOARD_STAKE_HOLDING_IDS` solo cuando no hay
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
O): DashboardFilteredExposureSummary {
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
