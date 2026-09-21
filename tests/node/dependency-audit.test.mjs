import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAuditReport, summarizeAudit } from '../../scripts/check-npm-audit.mjs'

test('passes when production advisories are below the blocking threshold', () => {
  const summary = summarizeAudit({
    vulnerabilities: {
      lodash: { severity: 'moderate', isDirect: true, fixAvailable: true },
      ws: { severity: 'low', isDirect: false, fixAvailable: false },
    },
  })

  assert.equal(summary.blocking.length, 0)
  assert.match(formatAuditReport({ vulnerabilities: { lodash: { severity: 'moderate' } } }), /Result: PASS/)
})

test('fails closed for high and critical advisories', () => {
  const summary = summarizeAudit({
    vulnerabilities: {
      next: { severity: 'high', isDirect: true, fixAvailable: false },
      undici: { severity: 'critical', isDirect: false, fixAvailable: true },
    },
  })

  assert.equal(summary.blocking.length, 2)
  const report = formatAuditReport({ vulnerabilities: { next: { severity: 'high', isDirect: true } } })
  assert.match(report, /High\/critical packages: 1/)
  assert.match(report, /Result: FAIL/)
})

test('rejects malformed audit output instead of silently passing', () => {
  assert.throws(() => summarizeAudit({}), /missing a vulnerabilities object/)
  assert.throws(() => summarizeAudit({ vulnerabilities: [] }), /missing a vulnerabilities object/)
})
