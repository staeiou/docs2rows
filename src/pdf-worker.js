// Dedicated pdf.js worker entry.
//
// polyfills.js MUST be imported before the pdf.js worker bundle: the worker
// realm has its own globals, and pdf.js's worker code relies on
// Promise.withResolvers (Safari < 17.4) and async ReadableStream iteration,
// neither of which Safari 17.2 ships. The main-thread polyfill cannot reach
// here, so we install them in the worker realm too.
import "./polyfills.js";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
