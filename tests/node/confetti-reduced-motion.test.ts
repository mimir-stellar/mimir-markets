import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import Confetti from "../../components/Confetti";

test("SSR: Confetti renders null when active is false", () => {
  const html = renderToString(React.createElement(Confetti, { active: false }));
  assert.equal(html, "");
});

test("SSR: Confetti initial server render is safe and produces null without throwing", () => {
  const html = renderToString(React.createElement(Confetti, { active: true }));
  assert.equal(html, "");
});

test("prefers-reduced-motion: Confetti returns null when reduced motion is enabled", () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  try {
    (globalThis as unknown as { window: unknown }).window = {
      matchMedia: (query: string) => ({
        matches: query.includes("prefers-reduced-motion: reduce"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    };

    const html = renderToString(React.createElement(Confetti, { active: true }));
    assert.equal(html, "");
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  }
});
