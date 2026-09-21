#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const blockingSeverities = new Set(['high', 'critical'])

export function summarizeAudit(report) {
  const vulnerabilities = report?.vulnerabilities
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw new Error('npm audit report is missing a vulnerabilities object')
  }

  const entries = Object.entries(vulnerabilities).map(([name, details]) => ({
    name,
    severity: details?.severity ?? 'unknown',
    direct: details?.isDirect === true,
    fixAvailable: details?.fixAvailable !== false,
  }))
  const blocking = entries.filter((entry) => blockingSeverities.has(entry.severity))

  return { entries, blocking }
}

export function formatAuditReport(report) {
  const { entries, blocking } = summarizeAudit(report)
  const lines = [
    '# Dependency vulnerability triage',
    '',
    `Packages with advisories: ${entries.length}`,
    `High/critical packages: ${blocking.length}`,
    '',
    '| Package | Severity | Direct | Fix available |',
    '| --- | --- | --- | --- |',
  ]

  for (const entry of entries.sort((left, right) => right.severity.localeCompare(left.severity) || left.name.localeCompare(right.name))) {
    lines.push(`| ${entry.name} | ${entry.severity} | ${entry.direct ? 'yes' : 'no'} | ${entry.fixAvailable ? 'yes' : 'no'} |`)
  }

  lines.push('', blocking.length === 0
    ? 'Result: PASS — no high or critical production dependency advisories were reported.'
    : 'Result: FAIL — high or critical production dependency advisories require triage before release.')
  return lines.join('\n') + '\n'
}

export async function main(path) {
  if (!path) throw new Error('usage: check-npm-audit.mjs <audit-json>')
  const report = JSON.parse(await readFile(path, 'utf8'))
  const { blocking } = summarizeAudit(report)
  process.stdout.write(formatAuditReport(report))
  if (blocking.length > 0) process.exitCode = 1
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv[2]).catch((error) => {
    console.error(`Audit triage failed: ${error.message}`)
    process.exitCode = 2
  })
}
