"use client";

import { useState, useEffect } from "react";
import { getTimeRemaining } from "@/lib/constants";
import { useLocale } from "next-intl";
import { resolveCountdownLocale } from "@i18n/locale";

export function useCountdown(deadline: number) {
  const locale = useLocale();
  const countdownLocale = resolveCountdownLocale(locale);
  const [state, setState] = useState(() => getTimeRemaining(deadline, countdownLocale));

  useEffect(() => {
    const interval = setInterval(() => {
      setState(getTimeRemaining(deadline, countdownLocale));
    }, 1000);
    return () => clearInterval(interval);
  }, [deadline, countdownLocale]);

  return state;
}
