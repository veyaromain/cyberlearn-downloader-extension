// runner.js — offscreen document pour compilation PDF.js + Tesseract
import { zipSync } from "./fflate.mjs";
import Tesseract from "./tesseract.esm.min.js";
import {
  getExt, basename, TEXT_MIME_PREFIXES, PDF_EXT, IMAGE_EXT,
  buildLLMDoc, buildSingleDoc,
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

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

function bufferToB64(buf) {
  const arr = new Uint8Array(buf);
  let b64 = "";
  for (let i = 0; i < arr.length; i += 8192) {
    b64 += btoa(String.fromCharCode(...arr.subarray(i, i + 8192)));
  }
  return b64;
}

async function extractPdfText(pdfjsLib, url, onProgress, buffer) {
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

async function extractContent(pdfjsLib, url, onProgress, buffer) {
  const ext = getExt(url);
  if (PDF_EXT.has(ext)) {
    const { text, usedOcr } = await extractPdfText(pdfjsLib, url, onProgress, buffer);
    return usedOcr ? `<!-- OCR appliqué sur pages sans texte sélectionnable -->\n${text}` : text;
  }
  if (IMAGE_EXT.has(ext)) {
    try {
      const blob   = new Blob([buffer]);
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
  const looksLikeText =
    ["txt","md","csv","tsv","json","xml","yaml","yml","toml","ini","cfg","conf",
     "js","ts","jsx","tsx","py","java","c","cpp","h","hpp","cs","go","rs","rb",
     "php","swift","kt","scala","sh","bash","zsh","ps1","sql","r","log","rst","ipynb"]
      .includes(ext);
  if (looksLikeText) return "```" + (ext || "") + "\n" + new TextDecoder().decode(buffer) + "\n```";
  return `[Fichier binaire — ${basename(url)} (${(ext || "?").toUpperCase()}) — contenu non extractible]`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "cld-compile-task-offscreen") return false;

  (async () => {
    let pdfjsLib;
    try { pdfjsLib = await getPdfJs(); }
    catch (e) {
      chrome.runtime.sendMessage({ type: "cld-compile-result", btnKey: msg.btnKey, error: "PDF.js indisponible" });
      return;
    }

    const sections = [];
    const total    = msg.files.length;

    for (const [j, { url, name: actName, folder, b64, error }] of msg.files.entries()) {
      const ext  = getExt(url);
      const name = actName || basename(url);

      if (error || !b64) {
        sections.push({ name, text: `<!-- Erreur récupération : ${error || "buffer manquant"} -->`, ext, folder });
        continue;
      }

      try {
        const buffer = b64ToBuffer(b64);
        const text   = await extractContent(pdfjsLib, url, () => {}, buffer);
        sections.push({ name, text, ext, folder });
      } catch (e) {
        sections.push({ name, text: `<!-- Erreur : ${e.message} -->`, ext, folder });
      }
    }

    const pageTitle  = msg.sectionName || msg.files[0]?.name || "compilation";
    const { main, extras } = buildLLMDoc(sections, pageTitle);
    const baseName   = pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60);

    let b64out, filename, isZip = false;

    if (extras.length > 0) {
      const enc    = new TextEncoder();
      const zfiles = {};
      zfiles[`${baseName}_llm.md`] = enc.encode(main);
      for (const { name: n, content } of extras) zfiles[n] = enc.encode(content);
      const zipped = zipSync(zfiles);
      b64out   = bufferToB64(zipped.buffer);
      filename = `${baseName}_llm.zip`;
      isZip    = true;
    } else {
      const enc = new TextEncoder();
      b64out    = bufferToB64(enc.encode(main).buffer);
      filename  = `${baseName}_llm.md`;
    }

    chrome.runtime.sendMessage({
      type: "cld-compile-result",
      btnKey: msg.btnKey,
      b64: b64out,
      filename,
      isZip,
      sizeKo: Math.round(main.length / 1024),
    });
  })();

  return false;
});
