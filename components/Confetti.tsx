"use client";

import { useEffect, useState } from "react";

const COLORS = ["#10B981", "#22D3EE", "#E879F9", "#FBBF24", "#FAFAFA"];
const PARTICLE_COUNT = 50;

interface Particle {
  id: number;
  left: string;
  width: number;
  height: number;
  color: string;
  borderRadius: string;
  duration: number;
  delay: number;
}

export default function Confetti({ active }: { active: boolean }) {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    if (!active) {
      setParticles([]);
      return;
    }

    const mediaQuery =
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    if (mediaQuery?.matches) {
      setParticles([]);
      return;
    }

    setParticles(
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        id: i,
        left: `${Math.random() * 100}%`,
        width: 5 + Math.random() * 10,
        height: 5 + Math.random() * 10,
        color: COLORS[i % COLORS.length],
        borderRadius: Math.random() > 0.5 ? "50%" : "2px",
        duration: 1.5 + Math.random() * 1.5,
        delay: Math.random() * 0.5,
      }))
    );

    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setParticles([]);
      }
    };

    mediaQuery?.addEventListener?.("change", handleChange);
    return () => {
      mediaQuery?.removeEventListener?.("change", handleChange);
    };
  }, [active]);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!active || prefersReducedMotion || particles.length === 0) return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[999]"
      aria-hidden="true"
    >
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute -top-[3%]"
          style={{
            left: p.left,
            width: p.width,
            height: p.height,
            borderRadius: p.borderRadius,
            background: p.color,
            animation: `confDrop ${p.duration}s ${p.delay}s ease-in forwards`,
            opacity: 0,
          }}
        />
      ))}
    </div>
  );
}
