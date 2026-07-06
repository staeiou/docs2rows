import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractPdfPages } from "./pdf.js";

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "log", "yaml", "yml", "mrg"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

export async function expandInputFile(file) {
  if (extensionOf(file.name) !== "zip") {
    return [await fileToInput(file, file.name, "", file.webkitRelativePath || file.name)];
  }

  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const expanded = [];
  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    expanded.push({
      filename: basename(entry.name),
      path: entry.name,
      archive: file.name,
      type: mimeFor(entry.name),
      size: bytes.byteLength,
      bytes
    });
  }
  return expanded;
}

export async function extractDocument(input, onProgress = () => {}) {
  const extension = extensionOf(input.filename);
  const base = {
    filename: input.filename,
    path: input.path || input.filename,
    archive: input.archive || "",
    extension,
    mime_type: input.type || mimeFor(input.filename),
    file_size: input.size || input.bytes.byteLength,
    title: "",
    author: "",
    created_at: "",
    modified_at: "",
    page_count: "",
    sheet_count: "",
    word_count: 0,
    character_count: 0,
    sha256: "",
    text: "",
    raw_metadata_json: "{}",
    extraction_status: "ok",
    extraction_warnings: ""
  };

  try {
    const extracted = await extractByType(input, extension, onProgress);
    const text = cleanText(extracted.text || "");
    const meta = normalizeMetadata(extracted.metadata || {});
    return {
      ...base,
      ...meta,
      page_count: extracted.pageCount || meta.page_count || "",
      sheet_count: extracted.sheetCount || meta.sheet_count || "",
      word_count: countWords(text),
      character_count: text.length,
      text,
      raw_metadata_json: JSON.stringify(extracted.metadata || {}),
      extraction_status: extracted.warning ? "warning" : "ok",
      extraction_warnings: extracted.warning || ""
    };
  } catch (error) {
    return {
      ...base,
      extraction_status: "error",
      extraction_warnings: error?.message || String(error)
    };
  }
}

async function fileToInput(file, filename, archive, path) {
  return {
    filename,
    path,
    archive,
    type: file.type || mimeFor(filename),
    size: file.size,
    bytes: new Uint8Array(await file.arrayBuffer())
  };
}

async function extractByType(input, extension, onProgress) {
  if (TEXT_EXTENSIONS.has(extension)) return { text: decode(input.bytes), metadata: {} };
  if (HTML_EXTENSIONS.has(extension)) return extractHtml(input.bytes);
  if (extension === "pdf") return extractPdf(input.bytes, onProgress);
  if (extension === "docx") return extractDocx(input.bytes);
  if (["xlsx", "xlsm", "xlsb", "xls"].includes(extension)) return extractWorkbook(input.bytes);
  if (extension === "rtf") return { text: rtfToText(decode(input.bytes)), metadata: {} };
  if (extension === "doc") {
    return { text: "", metadata: {}, warning: "Legacy binary .doc is not supported in this browser-only build." };
  }
  return {
    text: decode(input.bytes),
    metadata: {},
    warning: extension
      ? `Unknown .${extension} file type was imported as plain text.`
      : "File with no extension was imported as plain text."
  };
}

function extractHtml(bytes) {
  const doc = new DOMParser().parseFromString(decode(bytes), "text/html");
  const metadata = {
    title: doc.querySelector("title")?.textContent || "",
    author: doc.querySelector('meta[name="author"]')?.getAttribute("content") || "",
    created_at: doc.querySelector('meta[name="date"]')?.getAttribute("content") || ""
  };
  doc.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  return { text: doc.body?.textContent || doc.documentElement?.textContent || "", metadata };
}

async function extractPdf(bytes, onProgress) {
  const pages = await extractPdfPages(bytes, onProgress);
  return { text: pages.map((page) => page.text).join("\n\n"), metadata: {}, pageCount: pages.length };
}

async function extractDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) throw new Error("DOCX is missing word/document.xml");

  const text = [docxXmlToText(documentXml)];
  for (const name of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const xml = await zip.file(name)?.async("text");
    if (xml) text.push(docxXmlToText(xml));
  }

  const coreXml = await zip.file("docProps/core.xml")?.async("text");
  const appXml = await zip.file("docProps/app.xml")?.async("text");
  return {
    text: text.filter(Boolean).join("\n\n"),
    metadata: {
      ...parseDocxCore(coreXml || ""),
      ...parseDocxApp(appXml || "")
    }
  };
}

function docxXmlToText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return [...doc.getElementsByTagName("w:p")]
    .map((paragraph) =>
      [...paragraph.getElementsByTagName("*")]
        .map((node) => {
          if (node.localName === "t") return node.textContent || "";
          if (node.localName === "tab") return "\t";
          if (node.localName === "br" || node.localName === "cr") return "\n";
          return "";
        })
        .join("")
    )
    .join("\n");
}

function parseDocxCore(xml) {
  if (!xml) return {};
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return {
    title: firstLocalText(doc, "title"),
    author: firstLocalText(doc, "creator") || firstLocalText(doc, "lastModifiedBy"),
    created_at: firstLocalText(doc, "created"),
    modified_at: firstLocalText(doc, "modified")
  };
}

function parseDocxApp(xml) {
  if (!xml) return {};
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return {
    page_count: firstLocalText(doc, "Pages"),
    word_count: firstLocalText(doc, "Words")
  };
}

function extractWorkbook(bytes) {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const text = workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false });
    return `# ${name}\n${csv}`;
  }).join("\n\n");
  return { text, metadata: workbook.Props || {}, sheetCount: workbook.SheetNames.length };
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\line/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(parseInt(match.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_, raw) => {
      const code = Number(raw);
      return String.fromCharCode(code < 0 ? code + 65536 : code);
    })
    .replace(/\{\\\*[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/\\[^a-zA-Z\s]/g, "");
}

function normalizeMetadata(metadata) {
  return {
    title: pick(metadata, ["title", "Title", "Subject"]),
    author: pick(metadata, ["author", "Author", "creator", "Creator", "LastAuthor"]),
    created_at: normalizeDate(pick(metadata, ["created_at", "CreatedDate", "created", "CreationDate"])),
    modified_at: normalizeDate(pick(metadata, ["modified_at", "ModifiedDate", "modified", "ModDate"]))
  };
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toISOString();
}

function firstLocalText(doc, localName) {
  return [...doc.getElementsByTagName("*")].find((node) => node.localName === localName)?.textContent?.trim() || "";
}

function decode(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// XML 1.0 Char production (used by the xlsx export) excludes C0 controls
// other than tab/CR/LF and the Unicode noncharacters U+FFFE/U+FFFF. These
// can reach extracted text via pdf.js glyph-mapping fallbacks or RTF \'XX
// hex escapes, and the xlsx library writes them through unescaped,
// corrupting the exported .xlsx file.
function sanitizeXmlText(text) {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\ufffe\uffff]/g, "");
}

function cleanText(text) {
  return sanitizeXmlText(String(text || ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function countWords(text) {
  return text.trim().match(/\S+/g)?.length || 0;
}

function extensionOf(filename) {
  return /\.([^.\\/]+)$/.exec(filename || "")?.[1]?.toLowerCase() || "";
}

function basename(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function mimeFor(filename) {
  const map = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    rtf: "application/rtf",
    mrg: "text/plain",
    zip: "application/zip"
  };
  return map[extensionOf(filename)] || "";
}
