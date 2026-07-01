import initSqlJs from "sql.js";
import * as XLSX from "xlsx";

const EXCEL_CELL_TEXT_LIMIT = 32760;

export const DOCUMENT_COLUMNS = [
  "filename",
  "path",
  "archive",
  "extension",
  "mime_type",
  "file_size",
  "title",
  "author",
  "created_at",
  "modified_at",
  "page_count",
  "sheet_count",
  "word_count",
  "character_count",
  "sha256",
  "text",
  "raw_metadata_json",
  "extraction_status",
  "extraction_warnings"
];

export async function createDatabase(documents) {
  const SQL = await initSqlJs({ locateFile: locateSqlWasm });
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      filename TEXT,
      path TEXT,
      archive TEXT,
      extension TEXT,
      mime_type TEXT,
      file_size INTEGER,
      title TEXT,
      author TEXT,
      created_at TEXT,
      modified_at TEXT,
      page_count INTEGER,
      sheet_count INTEGER,
      word_count INTEGER,
      character_count INTEGER,
      sha256 TEXT,
      text TEXT,
      raw_metadata_json TEXT,
      extraction_status TEXT,
      extraction_warnings TEXT
    );
    CREATE INDEX idx_documents_filename ON documents(filename);
    CREATE INDEX idx_documents_extension ON documents(extension);
    CREATE INDEX idx_documents_status ON documents(extraction_status);
    CREATE INDEX idx_documents_sha256 ON documents(sha256);
  `);

  const placeholders = DOCUMENT_COLUMNS.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT INTO documents (${DOCUMENT_COLUMNS.join(", ")}) VALUES (${placeholders})`);

  db.run("BEGIN");
  try {
    for (const document of documents) {
      insert.run(DOCUMENT_COLUMNS.map((column) => document[column] ?? ""));
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  } finally {
    insert.free();
  }

  return db.export();
}

export function exportCsv(documents) {
  const columns = ["row", ...DOCUMENT_COLUMNS];
  const rows = [
    columns,
    ...documents.map((document, index) =>
      columns.map((column) => (column === "row" ? index + 1 : document[column] ?? ""))
    )
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function exportExcel(documents) {
  const baseColumns = ["row", ...DOCUMENT_COLUMNS];
  const baseRows = documents.map((document, index) => {
    const row = { row: index + 1 };
    for (const column of DOCUMENT_COLUMNS) row[column] = document[column] ?? "";
    return row;
  });
  const { columns, rows } = splitLongExcelCells(baseColumns, baseRows);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  sheet["!cols"] = columns.map((column) => ({ wch: column === "text" || column.startsWith("text.continued.") ? 90 : 22 }));
  XLSX.utils.book_append_sheet(workbook, sheet, "documents");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" });
}

function splitLongExcelCells(baseColumns, baseRows) {
  const continuationCounts = new Map();
  for (const row of baseRows) {
    for (const column of baseColumns) {
      const value = row[column];
      if (typeof value !== "string" || value.length <= EXCEL_CELL_TEXT_LIMIT) continue;
      const count = Math.ceil(value.length / EXCEL_CELL_TEXT_LIMIT) - 1;
      continuationCounts.set(column, Math.max(continuationCounts.get(column) || 0, count));
    }
  }

  const columns = [];
  for (const column of baseColumns) {
    columns.push(column);
    const count = continuationCounts.get(column) || 0;
    for (let index = 1; index <= count; index += 1) {
      columns.push(`${column}.continued.${index}`);
    }
  }

  const rows = baseRows.map((baseRow) => {
    const row = {};
    for (const column of baseColumns) {
      const value = baseRow[column];
      if (typeof value !== "string" || value.length <= EXCEL_CELL_TEXT_LIMIT) {
        row[column] = value;
      } else {
        const chunks = chunkString(value, EXCEL_CELL_TEXT_LIMIT);
        row[column] = chunks[0] || "";
        for (let index = 1; index < chunks.length; index += 1) {
          row[`${column}.continued.${index}`] = chunks[index];
        }
      }
    }
    return row;
  });

  return { columns, rows };
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function csvCell(value) {
  const string = String(value ?? "");
  if (/[",\n\r]/.test(string)) return `"${string.replace(/"/g, '""')}"`;
  return string;
}

function locateSqlWasm(file) {
  const wasmFile = file.endsWith(".wasm") ? "sql-wasm.wasm" : file;
  return new URL(wasmFile, new URL(import.meta.env.BASE_URL, window.location.href)).href;
}
