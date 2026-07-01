# docs2rows

Offline browser app for turning local documents into a table you can export as SQLite, XLSX, or CSV.

## Current scope

- Runs entirely in the browser after the app is cached.
- Supports direct uploads of any file extension and `.zip` files.
- Extracts text from TXT/MD/MRG/CSV/TSV/JSON/XML/HTML, PDF, DOCX, XLSX/XLS, RTF, and unknown extensions as plain text.
- Records unsupported legacy `.doc` files as warning rows.
- Normalizes common metadata columns when browser-readable metadata is available.
- Exports:
  - `docs2rows.sqlite` with a `documents` table
  - `docs2rows.xlsx`
  - `docs2rows.csv`

## Development

```sh
npm install
npm run dev
```
