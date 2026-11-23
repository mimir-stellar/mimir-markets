# Research-source disagreement report

`lib/research/disagreement.ts` compares the facts several captured research
sources give for the same question and reports, per fact, whether they
**agree**, **disagree**, or leave **insufficient** evidence to tell. It is pure
and synchronous: it fetches nothing and reads only captures the gateway
already returned.

```ts
import { buildDisagreementReport, summariseDisagreement } from "@/lib/research/disagreement";

const report = buildDisagreementReport(
  [
    { id: "open-meteo", capture: await gatewayFetch(...), validation },
    { id: "met-office", capture: await gatewayFetch(...) },
  ],
  [
    {
      key: "max_temp_c",
      kind: "number",                 // "number" | "string" | "boolean"
      locate: {
        "open-meteo": "daily.temperature_2m_max.0",   // dotted JSON path
        "met-office": /High:\s*([^<\n]+)/,            // regex, first group
      },
      absTolerance: 0.5,              // and/or relTolerance (0.01 = 1%)
    },
  ],
);
report.disagreement;            // true when any fact disagrees
summariseDisagreement(report);  // "max_temp_c: disagree: 21.4 (open-meteo) vs 27 (met-office) [...]"
```

## Cell status

Every source gets one cell per fact. Only `value` cells take part in the
verdict, so an outage or a bad page never reads as a conflict.

| Status | Meaning |
| --- | --- |
| `value` | A normalized value was extracted |
| `missing` | The source was usable but the fact is absent, null, or has no locator |
| `unparseable` | The field exists but could not be normalized (bad JSON, `"warm"` for a number, two numbers, a path that lands on an object) |
| `unavailable` | The capture failed (`fetch failed: http 503`), was never made, was marked unusable by `validateResearchContent` (`content validation: stale`), or its body is over the size bound |

## Verdicts

- `agree`: two or more values, all equal (strings, booleans) or with the
  numeric min and max within tolerance.
- `disagree`: two or more values that do not agree. `groups` lists each
  distinct value with the sources that gave it.
- `insufficient`: fewer than two values. This is never counted as agreement or
  disagreement.

Normalization: numbers accept separators, currency, `%` and unit suffixes
(`$64,100`, `−3 °C`) and refuse anything with zero or several numbers; strings
are NFKC, trimmed, whitespace-collapsed and lowercased; booleans accept
`true/false`, `yes/no`, `1/0`, `final`, `ft`, `official`.

## Bounds

| Option | Default | Effect |
| --- | --- | --- |
| `maxSources` | 8 | Extra sources (and repeated ids) are listed in `skipped.sources` |
| `maxFacts` | 16 | Extra facts are listed in `skipped.facts` |
| `maxBodyBytes` | 524288 | Larger bodies are not parsed; the source is `unavailable` |
| `maxValueChars` | 200 | String values are truncated in the report |

The report and its summary never include a body, only extracted values and
short reasons.
