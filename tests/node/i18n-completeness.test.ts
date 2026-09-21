import assert from "node:assert/strict";
import test from "node:test";

import { findMissingTranslations } from "../../scripts/check-i18n-completeness.mjs";

test("i18n check accepts existing literal keys and skips dynamic keys", () => {
  const missing = findMissingTranslations(
    [{ file: "fixture.tsx", source: 'const t = useTranslations("home"); t("title"); t(`dynamic.${name}`);' }],
    { home: { title: "Home" } },
  );
  assert.deepEqual(missing, []);
});

test("i18n check reports missing nested literal keys with their source location", () => {
  const missing = findMissingTranslations(
    [{ file: "fixture.tsx", source: 'const t = useTranslations("home");\nreturn t("missing.label");' }],
    { home: { title: "Home" } },
  );
  assert.deepEqual(missing, [{ file: "fixture.tsx", line: 2, key: "home.missing.label" }]);
});
