// runner.js — traitement headless de compilation (PDF.js + Tesseract)
// Chargé dans un iframe caché injecté par le content script
import { zipSync } from "./fflate.mjs";
import Tesseract from "./tesseract.esm.min.js";
import {
  getExt, basename, TEXT_MIME_PREFIXES, PDF_EXT, IMAGE_EXT,
  buildLLMDoc, buildSingleDoc, downloadBlob,
} from "./engine.js";

let tesseractWorker = null;
async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker("fra+eng", 1, {
    workerPath:  chrome.runtime.getURL("tesseract.worker.min.js"),
    corePath:    chrome.runtime.getURL("tesseract-core.wasm.js"),
    langPath:    chrome.runtime.getURL(""),
    cacheMethod: "none",
    logger:      () => {},
  });
  return tesseractWorker;
}

async function getPdfJs() {
  const mod = await import(chrome.runtime.getURL("pdf.min.mjs"));
  mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");
  return mod;
}

async function renderPageToCanvas(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas   = document.createElement("canvas");
  canvas.width   = viewport.width;
  canvas.height  = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

async function extractPdfText(pdfjsLib, url, onProgress, buffer = null) {
  if (!buffer) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buffer = await response.arrayBuffer();
  }
  const doc       = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageParts = [];
  let   usedOcr   = false;
  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(i, doc.numPages);
    const page    = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null, lines = [], currentLine = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 5) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = item.str;
      } else {
        currentLine += item.str;
      }
      lastY = y;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    if (lines.length > 0) {
      pageParts.push(`<!-- page ${i} -->\n${lines.join("\n")}`);
    } else {
      usedOcr = true;
      try {
        const canvas = await renderPageToCanvas(page);
        const worker = await getTesseractWorker();
        const { data: { text } } = await worker.recognize(canvas);
        const ocrText = text.trim();
        if (ocrText) pageParts.push(`<!-- page ${i} (OCR) -->\n${ocrText}`);
      } catch (e) {
        pageParts.push(`<!-- page ${i} — OCR échoué : ${e.message} -->`);
      }
    }
  }
  return { text: pageParts.join("\n\n"), usedOcr };
}

async function extractContent(pdfjsLib, url, onProgress, buffer = null) {
  const ext = getExt(url);
  if (PDF_EXT.has(ext)) {
    const { text, usedOcr } = await extractPdfText(pdfjsLib, url, onProgress, buffer);
    return usedOcr ? `<!-- OCR appliqué sur pages sans texte sélectionnable -->\n${text}` : text;
  }
  if (IMAGE_EXT.has(ext)) {
    try {
      const blob   = buffer ? new Blob([buffer]) : await fetch(url, { credentials: "include" }).then(r => r.blob());
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width  = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const worker = await getTesseractWorker();
      const { data: { text } } = await worker.recognize(canvas);
      return `<!-- OCR image -->\n${text.trim()}`;
    } catch (e) {
      return `[Image — OCR échoué : ${e.message}]`;
    }
  }
  let ct = "";
  if (!buffer) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ct     = res.headers.get("content-type") || "";
    buffer = await res.arrayBuffer();
  }
  const looksLikeText = TEXT_MIME_PREFIXES.some(p => ct.includes(p)) ||
    ["txt","md","csv","tsv","json","xml","yaml","yml","toml","ini","cfg","conf",
     "js","ts","jsx","tsx","py","java","c","cpp","h","hpp","cs","go","rs","rb",
     "php","swift","kt","scala","sh","bash","zsh","ps1","sql","r","log","rst","ipynb"]
      .includes(ext);
  if (looksLikeText) return "```" + (ext || "") + "\n" + new TextDecoder().decode(buffer) + "\n```";
  return `[Fichier binaire — ${basename(url)} (${(ext || "?").toUpperCase()}) — contenu non extractible]`;
}

// Écouter la tâche depuis le content script via postMessage
window.addEventListener("message", async (event) => {
  if (event.data?.type !== "cld-compile-task") return;
  const { task } = event.data;
  const reply = (msg) => event.source.postMessage({ type: "cld-compile-status", btnKey: task.btnKey, ...msg }, "*");

  const entries = task.files.filter(f => f.url);
  if (entries.length === 0) { reply({ state: "error", text: "Aucun fichier" }); return; }

  let pdfjsLib;
  try { pdfjsLib = await getPdfJs(); }
  catch { reply({ state: "error", text: "PDF.js indisponible" }); return; }

  const sections = [];
  const total    = entries.length;
  for (const [j, { url, name: actName, folder }] of entries.entries()) {
    const ext  = getExt(url);
    const name = actName || basename(url);
    reply({ state: "progress", text: `Extraction ${j + 1}/${total}` });
    try {
      const text = await extractContent(pdfjsLib, url, (p, c) => {
        reply({ state: "progress", text: `Extraction ${j + 1}/${total} — p.${p}/${c}` });
      });
      sections.push({ name, text, ext, folder });
    } catch (e) {
      sections.push({ name, text: `<!-- Erreur : ${e.message} -->`, ext, folder });
    }
  }

  reply({ state: "progress", text: "Compilation…" });
  const pageTitle = task.sectionName || task.files[0]?.name || "compilation";
  const { main, extras } = buildLLMDoc(sections, pageTitle);
  const baseName = pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60);

  if (extras.length > 0) {
    const enc = new TextEncoder();
    const zfiles = {};
    zfiles[`${baseName}_llm.md`] = enc.encode(main);
    for (const { name: n, content } of extras) zfiles[n] = enc.encode(content);
    downloadBlob(new Blob([zipSync(zfiles)], { type: "application/zip" }), `${baseName}_llm.zip`);
  } else {
    downloadBlob(new Blob([main], { type: "text/markdown;charset=utf-8" }), `${baseName}_llm.md`);
  }

  reply({ state: "done", text: `✓ ${(main.length / 1024).toFixed(0)} Ko` });
});
