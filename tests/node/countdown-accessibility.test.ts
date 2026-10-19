import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import CountdownTimer from "../../components/ui/CountdownTimer";

function renderCountdown(deadline: number, locale = "en") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: {},
      timeZone: "UTC",
      children: createElement(CountdownTimer, { deadline }),
    }),
  );
}

for (const component of [
  "components/ui/CountdownTimer.tsx",
  "components/LiveDeadline.tsx",
]) {
  test(`${component} does not announce every countdown tick`, () => {
    const source = readFileSync(join(process.cwd(), component), "utf8");

    assert.match(source, /role="timer"/);
    // Timer text updates every second. Its implicit live setting is "off";
    // an explicit live region would queue those updates in a screen reader.
    for (const attribute of source.matchAll(/\baria-live\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})/g)) {
      assert.match(attribute[1]!, /^(?:"off"|'off'|\{\s*["']off["']\s*\})$/);
    }
  });
}

test("CountdownTimer exposes the absolute deadline even after it has expired", () => {
  const markup = renderCountdown(1_700_000_000);

  assert.match(markup, /aria-label="[^"]*Nov 14, 2023[^"]*(?:UTC|GMT)[^"]*"/);
  assert.match(markup, />00:00:00<\/span>/);
});

test("CountdownTimer uses the page locale for its accessible deadline", () => {
  const markup = renderCountdown(1_700_000_000, "es");

  assert.match(markup, /aria-label="[^"]*14 de nov[^"]*2023[^"]*(?:UTC|GMT)[^"]*"/);
});

test("CountdownTimer omits an absolute label when the deadline is invalid", () => {
  for (const deadline of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
    const markup = renderCountdown(deadline);

    assert.doesNotMatch(markup, /aria-label=/);
    assert.doesNotMatch(markup, /Invalid Date/);
  }
});
