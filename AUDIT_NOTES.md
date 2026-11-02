# Security Audit Notes & Dependency Review

## 1. Spreadsheet Parser Remediation
- **Prior State**: The project used `xlsx` (SheetJS) `<=0.18.5`, which had two high-severity advisories:
  - GHSA-4r6h-8v6p-xvw6 (Prototype Pollution)
  - GHSA-5pgg-2g8v-p4x9 (Regular Expression Denial of Service - ReDoS)
- **Remediation**:
  - Uninstalled `xlsx`.
  - Installed `exceljs` (^4.4.0) to parse modern `.xlsx` workbooks and `.csv` files safely in memory via stream pipelines.
  - Legacy `.xls` (BIFF8 binary format) is explicitly rejected at upload time with an informative user-facing message instructing the user to upload modern `.xlsx` or `.csv`. This completely mitigates legacy binary parser vulnerabilities.
- **Transitive Dependency Advisories**:
  - `npm audit` reports 9 moderate advisories originating transitively through `exceljs -> archiver -> glob -> minimatch` and `exceljs -> uuid`.
  - Remediation via `npm audit fix --force` would downgrade `exceljs` to version `3.4.0` (a breaking change that lacks modern Node stream and ESM support).
  - In our architecture, ExcelJS is only used for read-only workbook and CSV parsing; the archive/zip generation features that invoke `glob` and `minimatch` are not executed by our catalog parser.
  - These advisories are tracked and documented rather than forcing a breaking downgrade.

## 2. HTTP Hardening Dependencies
- Installed `helmet` for default security headers (CSP, HSTS, X-Content-Type-Options, Frameguard).
- Installed `express-rate-limit` to protect public webhook endpoints and authentication routes from automated brute force and denial of service.
