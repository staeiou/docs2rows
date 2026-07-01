import "./polyfills.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// Parse in a real Web Worker so the UI thread stays responsive and progress
// updates can paint between pages. ./pdf-worker.js installs polyfills.js in the
// worker realm before loading pdf.js's worker bundle, which is required on
// Safari 17.2 (no Promise.withResolvers). The main-thread polyfill (imported
// above) covers the async ReadableStream iteration in getTextContent, which
// runs on this thread.
const pdfWorker = new Worker(new URL("./pdf-worker.js", import.meta.url), {
  type: "module"
});
pdfjsLib.GlobalWorkerOptions.workerPort = pdfWorker;

export async function extractPdfText(data, onProgress = () => {}) {
  const pages = await extractPdfPages(data, onProgress);
  return pages.map((page) => page.text).join("\n\f\n");
}

export async function extractPdfPages(data, onProgress = () => {}) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ normalizeWhitespace: true });
    const annotations = await page.getAnnotations();
    pages.push({
      pageNumber,
      text: itemsToText(content.items),
      annotations: annotations
        .filter((annotation) => annotation.subtype === "Link")
        .map((annotation) => ({
          subtype: annotation.subtype,
          url: annotation.url || "",
          unsafeUrl: annotation.unsafeUrl || "",
          overlaidText: annotation.overlaidText || "",
          rect: Array.isArray(annotation.rect) ? [...annotation.rect] : []
        }))
    });
    onProgress({ pageNumber, pageCount: pdf.numPages });
  }

  return pages;
}

function itemsToText(items) {
  const rows = [];
  for (const item of items) {
    const x = item.transform[4];
    const y = item.transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text: item.str });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}
