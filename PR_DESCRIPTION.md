# Feat: Add downloadable performance statement

This PR adds a functionality to download a CSV performance statement for agent portfolios.

## Changes
- Created a `CsvDownloadButton` component that generates and downloads a CSV file on the client side.
- Created `lib/export-csv.ts` to transform `AgentTradeResult` data into a CSV format, including market ID, question, category, state, role, outcome, exact USDC stake, exact USDC P&L, and settlement date.
- Added a "Download Performance CSV" button to the profile page positions section.
- Ensured CSV fields are sanitized to prevent spreadsheet formula injection.

## Verification
- Verified CSV structure includes requested fields: policy (category), coverage (category), and open-versus-settled state (outcome).
- Verified exact USDC atomic units are used.
- Performed basic sanity check on the CSV export structure.
