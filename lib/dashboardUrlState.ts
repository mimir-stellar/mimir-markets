import { CATEGORIES } from "@/lib/constants";
import {
  normalizeExploreMinStake,
  parseExploreSearchParams,
} from "@/lib/exploreFilters";

const VALID_CATEGORY_IDS = new Set<string>(
  CATEGORIES.map((c) => c.id as string)
);

export type DashboardUrlTab = "all" | "active" | "done";

/**
 * Estado de filtros del dashboard en query (`tab`, `cat`, `min`, `q`, `page`).
 * Orden de lista y filtros rápidos tipo Explore no forman parte del producto dashboard.
 */
export type DashboardFilterUrlState = {
  tab: DashboardUrlTab;
  cat: string;
  minStake: number;
  search: string;
  /** Página actual (1-based) de la lista de exposición. */
  page: number;
};

export const DEFAULT_DASHBOARD_FILTER_URL_STATE: DashboardFilterUrlState = {
  tab: "all",
  cat: "all",
  minStake: 0,
  search: "",
  page: 1,
};

/** Página máxima aceptada en URL para evitar valores absurdos/de Mon. */
export const DASHBOARD_MAX_PAGE = 9999;

function parseDashboardCategory(raw: string | null): string {
  const v = (raw ?? "all").trim().toLowerCase();
  if (v === "all") return "all";
  if (v === "clima") return "clima";
  if (VALID_CATEGORY_IDS.has(v)) return v;
  return "all";
}

/**
 * Normaliza el parámetro `page` de la URL a un entero 1..DASHBOARD_MAX_PAGE.
 * Valores no válidos (decimales, 0, Negativos, NaN, infinito, texto) caen a 1.
 */
export function normalizeDashboardPage(raw: string | null | undefined): number {
  if (raw == null) return 1;
  const trimmed = raw.trim();
  if (!trimmed) return 1;
  if (!/^\d+$/.test(trimmed)) return 1;
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 1) return 1;
  return Math.min(num, DASHTBOARD_MAX_PAGE);
}

/**
 * Lee `?tab=&cat=&min=&q=&page=` con validación alineada a la barra del dashboard
 * (incl. categoría legacy `clima` usada en Advanced).
 */
export function parseDashboardUrlSearchParams(
  sp: URLSearchParams
): DashboardFilterUrlState {
  const explore = parseExploreSearchParams(sp);
  const tabRaw = (sp.get("tab") ?? "all").toLowerCase();
  const tab: DashboardUrlTab =
    tabRaw === "active" || tabRaw === "done" ? tabRaw : "all";

  return {
    tab,
    cat: parseDashboardCategory(sp.get("cat")),
    minStake: normalizeExploreMinStake(explore.minStake),
    search: explore.search,
    page: normalizeDashboardPage(sp.get("page")),
  };
}

/** Solo incluye desviaciones respecto a defaults (URLs cortas). */
export function serializeDashboardUrlState(
  s: DashboardFilterUrlState
): string {
  const p = new URLSearchParams();
  if (s.tab !== "all") p.set("tab", s.tab);
  if (s.cat !== "all") p.set("cat", s.cat);
  if (s.minStake !== 0) p.set("min", String(s.minStake));
  const q = s.search.trim();
  if (q) p.set("q", q);
  if (s.page > 1) p.set("page", String(s.page));
  return p.toString();
}
