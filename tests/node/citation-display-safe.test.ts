/**
 * #934 — render untrusted citation titles without directional or terminal controls.
 *
 * Verifies the shared presentation-boundary sanitizer and that
 * ResearchSourceCitations applies it to the domain, URL text and excerpt while
 * leaving ordinary Unicode (and the navigation href) intact.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import ResearchSourceCitations from "../../components/research/ResearchSourceCitations";
import { sanitizeDisplayText } from "../../lib/text/display-safe";

// Built from char codes so the controls are visible in review (see display-safe.ts).
const ch = (code: number) => String.fromCharCode(code);
const ESC = ch(0x1b);
const RLO = ch(0x202e); // RIGHT-TO-LEFT OVERRIDE
const LRE = ch(0x202a);
const PDF = ch(0x202c);
const RLI = ch(0x2067);
const PDI = ch(0x2069);
const LRM = ch(0x200e);
const RLM = ch(0x200f);
const ALM = ch(0x061c);
const BEL = ch(0x07);
const NUL = ch(0x00);
const DEL = ch(0x7f);
const C1_CSI = ch(0x9b);
const ZWJ = ch(0x200d);
const ZWNJ = ch(0x200c);

const ALL_UNSAFE = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
);

const PRIMARY_HASH = "aa".repeat(32);
const NOW = 1_700_000_000_000;

test("bidi overrides, embeddings, isolates and marks are removed", () => {
  // "Trojan Source" style: RLO makes "gpj.exe" render as "exe.jpg".
  assert.equal(sanitizeDisplayText(`report${RLO}gpj.exe`), "reportgpj.exe");
  assert.equal(sanitizeDisplayText(`${LRE}a${PDF}${RLI}b${PDI}`), "ab");
  assert.equal(sanitizeDisplayText(`x${LRM}y${RLM}z${ALM}`), "xyz");
});

test("ANSI CSI, OSC and two-character escapes plus 8-bit CSI are removed", () => {
  assert.equal(sanitizeDisplayText(`${ESC}[31mRED${ESC}[0m title`), "RED title");
  assert.equal(sanitizeDisplayText(`${ESC}]0;pwned${BEL}Title`), "Title");
  assert.equal(sanitizeDisplayText(`${ESC}]8;;https://evil.example${ESC}\\link`), "link");
  assert.equal(sanitizeDisplayText(`${ESC}cReset`), "Reset");
  assert.equal(sanitizeDisplayText(`${C1_CSI}2JClear`), "Clear");
  // Truncated sequences at the end of the string do not leave a stray ESC.
  assert.equal(sanitizeDisplayText(`tail${ESC}[`), "tail");
  assert.equal(sanitizeDisplayText(`tail${ESC}`), "tail");
});

test("other C0/C1 controls are dropped and line breaks become a single space", () => {
  assert.equal(sanitizeDisplayText(`a${NUL}b${DEL}c${BEL}d`), "abcd");
  assert.equal(sanitizeDisplayText("Line one\r\n\tLine   two\n"), "Line one Line two");
});

test("ordinary Unicode source names are preserved", () => {
  const samples = [
    "Reuters — Résumé des marchés",
    "日本経済新聞",
    "الجزيرة نت",
    "עיתון הארץ",
    "Ελληνικά νέα",
    "Café Ñandú",
    `Family ${"\u{1F468}"}${ZWJ}${"\u{1F469}"}${ZWJ}${"\u{1F467}"} news`,
    `می${ZWNJ}خواهم`, // Persian needs ZWNJ for correct shaping
    "Prices < $5 & \"quoted\"",
  ];
  for (const sample of samples) {
    assert.equal(sanitizeDisplayText(sample), sample, sample);
  }
});

test("empty and nullish inputs become empty strings", () => {
  assert.equal(sanitizeDisplayText(null), "");
  assert.equal(sanitizeDisplayText(undefined), "");
  assert.equal(sanitizeDisplayText(""), "");
  assert.equal(sanitizeDisplayText(`${RLO}${ESC}[0m${NUL}`), "");
});

test("fuzz: output never contains bidi or control characters", () => {
  const alphabet = [
    "a", "Z", "é", "日", "ا", " ", "\t", "\n", "[", "]", ";", "0", "m",
    ESC, RLO, LRE, PDF, RLI, PDI, LRM, RLM, ALM, BEL, NUL, DEL, C1_CSI, ZWJ,
  ];
  let state = 0x2545f491;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = 0; i < 2000; i += 1) {
    let input = "";
    const len = next() % 24;
    for (let j = 0; j < len; j += 1) input += alphabet[next() % alphabet.length];
    const out = sanitizeDisplayText(input);
    assert.equal(ALL_UNSAFE.test(out), false, JSON.stringify(input));
    assert.equal(out, out.trim());
    // Idempotent: sanitizing again changes nothing.
    assert.equal(sanitizeDisplayText(out), out);
  }
});

function renderCitations(sources: Parameters<typeof ResearchSourceCitations>[0]["sources"]) {
  const messages = JSON.parse(readFileSync(join(process.cwd(), "messages/en.json"), "utf8"));
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages,
      timeZone: "UTC",
      children: createElement(ResearchSourceCitations, { sources, nowMs: NOW }),
    }),
  );
}

test("ResearchSourceCitations renders untrusted domain and excerpt without controls", () => {
  const html = renderCitations([
    {
      url: "https://primary.example/report",
      domain: `evil${RLO}moc.elgoog${PDF}.example`,
      trustTier: "primary",
      contentHash: PRIMARY_HASH,
      excerpt: `${ESC}[2J${ESC}[31mThe number was 42${ESC}[0m${BEL}`,
      capturedAt: NOW - 60_000,
    },
  ]);

  assert.equal(ALL_UNSAFE.test(html), false, "rendered markup contains a control character");
  assert.match(html, /evilmoc\.elgoog\.example/);
  assert.match(html, /The number was 42/);
  // The navigation target is unchanged.
  assert.match(html, /href="https:\/\/primary\.example\/report"/);
});

test("ResearchSourceCitations keeps ordinary Unicode source names and excerpts", () => {
  const html = renderCitations([
    {
      url: "https://primary.example/report",
      domain: "日本経済新聞.example",
      trustTier: "primary",
      contentHash: PRIMARY_HASH,
      excerpt: "الجزيرة: Résumé — 42",
      capturedAt: NOW - 60_000,
    },
  ]);
  assert.match(html, /日本経済新聞\.example/);
  assert.match(html, /الجزيرة: Résumé — 42/);
});
