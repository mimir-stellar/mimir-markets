"use client";

import { useLocale } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const nextLocale = locale === "en" ? "es" : "en";

  return (
    <Link
      href={pathname}
      locale={nextLocale}
      aria-label={nextLocale === "es" ? "Cambiar a español" : "Switch to English"}
      title={nextLocale === "es" ? "Español" : "English"}
      className={`grid h-9 w-9 place-items-center border border-pv-ink/[0.14] text-pv-muted font-mono text-[11px] font-bold uppercase transition-colors duration-150 hover:border-pv-ink/[0.28] hover:text-pv-text ${className}`}
    >
      <span aria-hidden>{nextLocale}</span>
    </Link>
  );
}

export default LocaleSwitcher;
