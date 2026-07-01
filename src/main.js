import "./polyfills.js";
import { createDatabase, exportCsv, exportExcel } from "./database.js";
import { expandInputFile, extractDocument } from "./extractors.js";
import "./styles.css";

const state = {
  documents: [],
  imports: [],
  busy: false
};

document.querySelector("#app").innerHTML = `
  <main class="shell">
    <section class="workspace">
      <header class="topbar">
        <div>
          <h1>docs2rows</h1>
          <p>Build a local document table from browser-readable files. Everything runs offline in this browser.</p>
        </div>
        <div class="actions">
          <button id="downloadSqlite" class="primary" disabled>Download SQLite</button>
          <button id="downloadExcel" disabled>Download Excel</button>
          <button id="downloadCsv" disabled>Download CSV</button>
        </div>
      </header>

      <label id="dropzone" class="dropzone">
        <input id="fileInput" type="file" multiple />
        <span class="drop-title">Drop documents or ZIPs</span>
          <span class="drop-subtitle">TXT, MRG treebank, PDF, DOCX, XLSX, RTF, HTML, CSV, JSON, ZIP, and unknown text-like extensions are processed locally. Legacy DOC files are listed as unsupported.</span>
      </label>

      <div id="statusLine" class="status-line">No files imported yet.</div>

      <section id="progressPanel" class="progress-panel" aria-live="polite" hidden>
        <div class="progress-head">
          <strong id="progressLabel">Working</strong>
          <span id="progressPercent">0%</span>
        </div>
        <div class="progress-track">
          <div id="progressFill" class="progress-fill"></div>
        </div>
      </section>

      <section class="status-grid">
        <div>
          <span class="metric" id="documentCount">0</span>
          <span class="label">documents</span>
        </div>
        <div>
          <span class="metric" id="wordCount">0</span>
          <span class="label">words</span>
        </div>
        <div>
          <span class="metric" id="warningCount">0</span>
          <span class="label">warnings</span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Documents</h2>
          <div class="table-actions">
            <input id="filterInput" type="search" placeholder="Filter filename, title, author, text, status" disabled />
            <button id="clearAll" class="ghost" disabled>Clear</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>Filename</th>
                <th>Title</th>
                <th>Author</th>
                <th>Type</th>
                <th>Words</th>
                <th>Status</th>
                <th>Text</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="documentRows">
              <tr><td colspan="10" class="muted">Import files to populate rows.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
`;

const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const statusLine = document.querySelector("#statusLine");
const filterInput = document.querySelector("#filterInput");
const downloadSqlite = document.querySelector("#downloadSqlite");
const downloadExcel = document.querySelector("#downloadExcel");
const downloadCsv = document.querySelector("#downloadCsv");
const clearAll = document.querySelector("#clearAll");
const progressPanel = document.querySelector("#progressPanel");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressFill = document.querySelector("#progressFill");

fileInput.addEventListener("change", () => importFiles([...fileInput.files]));
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  importFiles([...event.dataTransfer.files]);
});
filterInput.addEventListener("input", renderDocuments);
clearAll.addEventListener("click", () => {
  state.documents = [];
  state.imports = [];
  render();
});
downloadSqlite.addEventListener("click", async () => {
  setBusy(true, "Building SQLite database...");
  try {
    const bytes = await createDatabase(state.documents);
    downloadBlob(bytes, "docs2rows.sqlite", "application/vnd.sqlite3");
  } finally {
    setBusy(false);
  }
});
downloadCsv.addEventListener("click", () => {
  downloadBlob(exportCsv(state.documents), "docs2rows.csv", "text/csv;charset=utf-8");
});
downloadExcel.addEventListener("click", () => {
  downloadBlob(
    exportExcel(state.documents),
    "docs2rows.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
});

if ("serviceWorker" in navigator) {
  let reloadingForServiceWorker = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForServiceWorker) return;
    reloadingForServiceWorker = true;
    window.location.reload();
  });
  window.addEventListener("load", async () => {
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    registration.update();
  });
}

async function importFiles(files) {
  if (!files.length || state.busy) return;
  setBusy(true, "Reading files...");
  setProgress("Reading selected files", 1);
  try {
    const inputs = [];
    for (let index = 0; index < files.length; index += 1) {
      setProgress(`Expanding ${files[index].name}`, percent(index, files.length, 1, 18));
      inputs.push(...(await expandInputFile(files[index])));
    }

    const seen = new Set(state.documents.map((document) => document.sha256).filter(Boolean));
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      setProgress(`Extracting ${input.filename}`, percent(index, inputs.length, 18, 96));
      const hash = await sha256(input.bytes);
      if (seen.has(hash)) {
        state.imports.push({ name: input.archive || input.filename, detail: input.path, status: "warn", count: 0 });
        continue;
      }
      seen.add(hash);
      const document = await extractDocument(input, ({ pageNumber, pageCount }) => {
        setProgress(`Extracting ${input.filename}: page ${pageNumber} of ${pageCount}`, percent(index, inputs.length, 18, 96));
      });
      document.sha256 = hash;
      state.documents.push(document);
      state.imports.push({
        name: input.archive || input.filename,
        detail: input.archive ? input.path : document.extraction_warnings || document.extension.toUpperCase(),
        status: document.extraction_status === "error" ? "error" : document.extraction_status === "warning" ? "warn" : "ok",
        count: document.text ? 1 : 0
      });
      render();
    }
    setProgress("Import complete", 100);
    hideProgressSoon();
  } catch (error) {
    console.error("import error", error);
    state.imports.push({ name: "Import error", detail: describeError(error), count: 0, status: "error" });
  } finally {
    setBusy(false);
    fileInput.value = "";
    render();
  }
}

function render() {
  const documents = state.documents;
  document.querySelector("#documentCount").textContent = documents.length.toLocaleString();
  document.querySelector("#wordCount").textContent = documents.reduce((sum, item) => sum + Number(item.word_count || 0), 0).toLocaleString();
  document.querySelector("#warningCount").textContent = documents.filter((item) => item.extraction_status !== "ok").length.toLocaleString();

  downloadSqlite.disabled = !documents.length || state.busy;
  downloadExcel.disabled = !documents.length || state.busy;
  downloadCsv.disabled = !documents.length || state.busy;
  clearAll.disabled = (!documents.length && !state.imports.length) || state.busy;
  filterInput.disabled = !documents.length;

  renderImports();
  renderDocuments();
}

function renderImports() {
  const latest = state.imports.at(-1);
  statusLine.textContent = latest
    ? `${latest.name}: ${latest.detail || latest.status}`
    : "No files imported yet.";
}

function moveDocument(from, to) {
  if (state.busy || !Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
  const [document] = state.documents.splice(from, 1);
  state.documents.splice(to, 0, document);
  render();
}

function removeDocument(index) {
  if (state.busy || !Number.isInteger(index)) return;
  state.documents.splice(index, 1);
  render();
}

function renderDocuments() {
  const query = filterInput.value.trim().toLowerCase();
  const rows = state.documents
    .map((document, index) => ({ document, index }))
    .filter(({ document }) => {
      if (!query) return true;
      return [
        document.filename,
        document.title,
        document.author,
        document.extension,
        document.extraction_status,
        document.extraction_warnings,
        document.text
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

  const body = document.querySelector("#documentRows");
  if (!state.documents.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted">Import files to populate rows.</td></tr>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted">No matching documents.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map(
      ({ document, index }) => `
        <tr draggable="${!state.busy}" data-index="${index}">
          <td><span class="drag-handle" aria-hidden="true">::</span></td>
          <td>${index + 1}</td>
          <td>${escapeHtml(document.filename)}</td>
          <td>${escapeHtml(document.title)}</td>
          <td>${escapeHtml(document.author)}</td>
          <td>${escapeHtml(document.extension || document.mime_type)}</td>
          <td>${Number(document.word_count || 0).toLocaleString()}</td>
          <td>
            <span class="status-pill ${escapeHtml(document.extraction_status)}" title="${escapeHtml(document.extraction_warnings)}">${escapeHtml(document.extraction_status)}</span>
            ${document.extraction_warnings ? `<span class="warning-text">${escapeHtml(document.extraction_warnings)}</span>` : ""}
          </td>
          <td>${escapeHtml(previewText(document.text || document.extraction_warnings))}</td>
          <td><button class="icon-button remove-document" data-index="${index}" ${state.busy ? "disabled" : ""} aria-label="Remove ${escapeHtml(document.filename)}">X</button></td>
        </tr>
      `
    )
    .join("");

  body.querySelectorAll("tr[data-index]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      if (state.busy) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.index);
      row.classList.add("dragging-row");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging-row"));
    row.addEventListener("dragover", (event) => {
      if (state.busy) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      moveDocument(Number(event.dataTransfer.getData("text/plain")), Number(row.dataset.index));
    });
  });

  body.querySelectorAll(".remove-document").forEach((button) => {
    button.addEventListener("click", () => removeDocument(Number(button.dataset.index)));
  });
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  if (message) statusLine.textContent = message;
  render();
}

function setProgress(label, value) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  progressPanel.hidden = false;
  progressLabel.textContent = label;
  progressPercent.textContent = `${clamped}%`;
  progressFill.style.width = `${clamped}%`;
}

function hideProgressSoon() {
  window.setTimeout(() => {
    if (!state.busy) progressPanel.hidden = true;
  }, 1200);
}

function percent(index, count, start, end) {
  if (!count) return end;
  return start + ((index + 1) / count) * (end - start);
}

function previewText(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 100)} [...] ${compact.slice(-100)}`;
}

async function sha256(bytes) {
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fnv1a32(bytes);
}

function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

function downloadBlob(content, name, type) {
  const blob = content instanceof Uint8Array ? new Blob([content], { type }) : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function describeError(error) {
  if (!error) return "Unknown error";
  return error.message || String(error);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
