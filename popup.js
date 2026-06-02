// popup.js — détection, extraction et compilation de fichiers pour LLM
import { zipSync } from "./fflate.mjs";
import Tesseract from "./tesseract.esm.min.js";
import {
  EXTENSIONS, TEXT_MIME_PREFIXES, PDF_EXT, IMAGE_EXT,
  getExt, basename, cleanText,
  TOTAL_THRESHOLD_KO, applyGlobalBudget,
  findCrossFileRepetitions, stripCrossFileRepetitions,
  BIG_FILE_THRESHOLD_KO, detectHeadings,
  deduplicateSections, buildLLMDoc, buildSingleDoc,
  downloadBlob,
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

const btnAction        = document.getElementById("btn-action");
const btnReload        = document.getElementById("btn-reload");
const statusEl         = document.getElementById("status");
const listEl           = document.getElementById("file-list");
const emptyEl          = document.getElementById("empty");
const subtitleEl       = document.getElementById("subtitle");
const selectBar        = document.getElementById("select-bar");
const checkedCountEl   = document.getElementById("checked-count");
const btnToggleAll     = document.getElementById("btn-toggle-all");
const optionsToggle    = document.getElementById("options-toggle");
const optionsPanel     = document.getElementById("options-panel");
const chkSplit         = document.getElementById("chk-split");
const typeFiltersEl    = document.getElementById("type-filters");

let fileEntries    = []; // [{url, name}]
let activeTypeFilters = new Set(); // types activés (vide = tous)
let mode = "compile"; // "compile" | "download"

// --- Sélecteur de mode ---
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
    // Masquer l'option split en mode téléchargement
    document.querySelector("#options-panel .option-row:first-child").style.display =
      mode === "compile" ? "flex" : "none";
    updateActionButton();
  });
});

// --- Toggle options ---
optionsToggle.addEventListener("click", () => {
  optionsToggle.classList.toggle("open");
  optionsPanel.classList.toggle("open");
});

// --- Filtres par type ---
function buildTypeFilters(files) {
  // Compter les occurrences par extension
  const counts = {};
  for (const { url } of files) {
    const ext = getExt(url) || "?";
    counts[ext] = (counts[ext] || 0) + 1;
  }

  typeFiltersEl.innerHTML = "";
  activeTypeFilters = new Set(Object.keys(counts)); // tout actif par défaut

  for (const [ext, count] of Object.entries(counts)) {
    const chip = document.createElement("div");
    chip.className   = "type-chip active";
    chip.dataset.ext = ext;
    chip.innerHTML   = `${ext} <span class="chip-count">${count}</span>`;
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      if (chip.classList.contains("active")) {
        activeTypeFilters.add(ext);
      } else {
        activeTypeFilters.delete(ext);
      }
      applyTypeFilter();
    });
    typeFiltersEl.appendChild(chip);
  }
}

function applyTypeFilter() {
  const items = listEl.querySelectorAll(".file-item");
  fileEntries.forEach(({ url }, i) => {
    const ext  = getExt(url) || "?";
    const item = items[i];
    if (!item) return;
    const visible = activeTypeFilters.has(ext);
    item.style.display = visible ? "flex" : "none";
    // Si on masque, décocher aussi
    if (!visible) {
      const cb = item.querySelector("input[type=checkbox]");
      if (cb) cb.checked = false;
      item.classList.add("unchecked");
    } else {
      const cb = item.querySelector("input[type=checkbox]");
      if (cb && !cb.checked) {
        cb.checked = true;
        item.classList.remove("unchecked");
      }
    }
  });
  updateSelectBar();
  updateActionButton();
}

function updateActionButton() {
  const count = checkedEntries().length;
  if (count === 0) {
    btnAction.disabled = true;
    btnAction.textContent = mode === "compile" ? "Compiler pour LLM" : "Télécharger fichiers";
    return;
  }
  btnAction.disabled = false;
  if (mode === "compile") {
    btnAction.textContent = `Compiler ${count} fichier${count > 1 ? "s" : ""} pour LLM`;
  } else {
    btnAction.textContent = `Télécharger ${count} fichier${count > 1 ? "s" : ""}`;
  }
}

function checkedEntries() {
  return fileEntries.filter((_, i) => {
    const cb = listEl.querySelectorAll("input[type=checkbox]")[i];
    return cb?.checked;
  });
}

// --- Tout cocher / décocher ---
btnToggleAll.addEventListener("click", () => {
  const checkboxes = [...listEl.querySelectorAll("input[type=checkbox]")];
  const allChecked = checkboxes.every(cb => cb.checked);
  checkboxes.forEach(cb => {
    cb.checked = !allChecked;
    syncItem(cb);
  });
  updateSelectBar();
  updateActionButton();
});

function syncItem(checkbox) {
  checkbox.closest(".file-item").classList.toggle("unchecked", !checkbox.checked);
}

function updateSelectBar() {
  const checkboxes = [...listEl.querySelectorAll("input[type=checkbox]")];
  const total   = checkboxes.length;
  const checked = checkboxes.filter(cb => cb.checked).length;
  checkedCountEl.textContent = `${checked}/${total} sélectionné${checked > 1 ? "s" : ""}`;
  btnToggleAll.textContent   = checked === total ? "Tout décocher" : "Tout cocher";
}

// --- Détection des fichiers dans l'onglet actif ---
async function detectFiles() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const extList = EXTENSIONS; // transmis dans le contexte de la page via func args

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const seen = new Set();
      const out  = [];

      function addLink(href, name) {
        if (!href || seen.has(href)) return;
        seen.add(href);
        out.push({ href, name });
      }

      // Stratégie 1 : .activity-item[data-activityname] contenant .modtype_resource
      const activities = Array.from(
        document.querySelectorAll(".activity-item[data-activityname] .modtype_resource")
      );
      for (const activity of activities) {
        const card = activity.closest(".activity-item[data-activityname]");
        const name = card?.dataset.activityname || null;
        for (const a of activity.querySelectorAll("a[href]")) {
          addLink(a.href, name);
        }
      }

      // Stratégie 2 : .activity[data-activityname] (Moodle 4.x sans tiret)
      const activities2 = Array.from(
        document.querySelectorAll(".activity[data-activityname]")
      );
      for (const card of activities2) {
        if (!card.classList.contains("modtype_resource") &&
            !card.querySelector(".modtype_resource") &&
            !card.className.includes("resource")) continue;
        const name = card.dataset.activityname || null;
        for (const a of card.querySelectorAll("a[href]")) {
          addLink(a.href, name);
        }
      }

      // Stratégie 3 : tous les liens vers pluginfile.php ou mod/resource/view.php
      for (const a of document.querySelectorAll("a[href]")) {
        const h = a.href || "";
        if (h.includes("pluginfile.php") || h.includes("/mod/resource/view.php")) {
          const card = a.closest("[data-activityname]");
          const name = card?.dataset.activityname || a.textContent.trim() || null;
          addLink(h, name);
        }
      }

      // Stratégie 4 : dossiers Moodle (mod/folder/view.php) — à résoudre côté popup
      const folders = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const h = a.href || "";
        if (h.includes("/mod/folder/view.php")) {
          const card = a.closest("[data-activityname]");
          const name = card?.dataset.activityname || a.textContent.trim() || null;
          if (!folders.some(f => f.href === h)) folders.push({ href: h, name });
        }
      }

      return { links: out, folders };
    },
  });

  const raw       = results[0]?.result ?? { links: [], folders: [] };
  const links     = Array.isArray(raw) ? raw : (raw.links ?? []);   // compat ancienne version
  const folders   = Array.isArray(raw) ? []  : (raw.folders ?? []);

  // Résoudre les dossiers Moodle : fetcher chaque page et en extraire les pluginfile.php
  const folderLinks = (await Promise.all(folders.map(async ({ href, name: folderName }) => {
    try {
      const res  = await fetch(href, { credentials: "include" });
      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, "text/html");
      return Array.from(doc.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(h => h.includes("pluginfile.php"))
        .map(h => ({ href: h, name: folderName, folder: folderName }));
    } catch { return []; }
  }))).flat();

  const candidates = [...links, ...folderLinks];

  // Résoudre les redirections Moodle (mod/resource/view.php)
  const resolved = await Promise.all(
    candidates.map(async ({ href, name, folder }) => {
      const lower = href.toLowerCase();
      const ext   = getExt(href);
      if (EXTENSIONS.includes(ext) || lower.includes("pluginfile.php")) {
        return { url: href, name, folder };
      }
      try {
        const res = await fetch(
          href.includes("?") ? href + "&redirect=1" : href + "?redirect=1",
          { credentials: "include", redirect: "follow" }
        );
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("pdf") || ct.includes("octet-stream") ||
            EXTENSIONS.includes(getExt(res.url)) || res.url.includes("pluginfile.php")) {
          return { url: res.url, name, folder };
        }
      } catch {}
      return null;
    })
  );

  return resolved.filter(Boolean);
}

function renderList(files) {
  listEl.innerHTML = "";

  if (files.length === 0) {
    emptyEl.style.display          = "block";
    selectBar.style.display        = "none";
    optionsToggle.style.display    = "none";
    subtitleEl.textContent         = "Aucun fichier détecté";
    return;
  }

  emptyEl.style.display        = "none";
  selectBar.style.display      = "flex";
  optionsToggle.style.display  = "flex";
  subtitleEl.textContent       = `${files.length} fichier${files.length > 1 ? "s" : ""} détecté${files.length > 1 ? "s" : ""}`;

  for (const { url, name } of files) {
    const label = name || basename(url);
    const ext   = getExt(url) || "?";
    const item  = document.createElement("label");
    item.className = "file-item";
    item.title     = url;
    item.innerHTML = `
      <input type="checkbox" checked>
      <span class="dot"></span>
      <span class="name">${label}</span>
      <span class="ext-badge">${ext}</span>`;
    listEl.appendChild(item);

    item.querySelector("input").addEventListener("change", e => {
      syncItem(e.target);
      updateSelectBar();
      updateActionButton();
    });
  }

  buildTypeFilters(files);
  updateSelectBar();
  updateActionButton();
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className   = type;
}

// --- PDF.js ---
async function getPdfJs() {
  const mod = await import(chrome.runtime.getURL("pdf.min.mjs"));
  mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");
  return mod;
}

// --- Extraction de contenu selon le type de fichier ---
// Retourne toujours une string. buffer optionnel pour éviter un double fetch.
async function extractContent(pdfjsLib, url, onProgress, buffer = null) {
  const ext = getExt(url);

  if (PDF_EXT.has(ext)) {
    const { text, usedOcr } = await extractPdfText(pdfjsLib, url, onProgress, buffer);
    return usedOcr ? `<!-- OCR appliqué sur pages sans texte sélectionnable -->\n${text}` : text;
  }

  if (IMAGE_EXT.has(ext)) {
    // OCR direct sur les images
    try {
      const blob = buffer
        ? new Blob([buffer])
        : await fetch(url, { credentials: "include" }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); });
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

  // Tentative de lecture texte brut (code, CSV, JSON, SQL, MD, etc.)
  let ct = "";
  if (!buffer) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ct = res.headers.get("content-type") || "";
    buffer = await res.arrayBuffer();
  }

  const looksLikeText = TEXT_MIME_PREFIXES.some(p => ct.includes(p)) ||
    ["txt","md","csv","tsv","json","xml","yaml","yml","toml","ini","cfg","conf",
     "js","ts","jsx","tsx","py","java","c","cpp","h","hpp","cs","go","rs","rb",
     "php","swift","kt","scala","sh","bash","zsh","ps1","sql","r","log","rst","ipynb"]
      .includes(ext);

  if (looksLikeText) {
    const text = new TextDecoder().decode(buffer);
    return "```" + (ext || "") + "\n" + text + "\n```";
  }

  // Fichier binaire (zip, etc.) — on ne peut pas en extraire le texte
  return `[Fichier binaire — ${basename(url)} (${ext.toUpperCase()}) — contenu non extractible]`;
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
      // Page sans texte sélectionnable → OCR
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

  const result = pageParts.join("\n\n");
  return { text: result, usedOcr };
}

// --- Action principale ---
btnAction.addEventListener("click", async () => {
  btnAction.disabled = true;
  setStatus("");

  const allCheckboxes   = [...listEl.querySelectorAll("input[type=checkbox]")];
  const selectedIndices = allCheckboxes.map((cb, i) => cb.checked ? i : -1).filter(i => i !== -1);

  if (selectedIndices.length === 0) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [titleResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.querySelector(".page-header-headings h1")?.textContent?.trim() || null,
  });
  const pageTitle = titleResult?.result || tab.title || "compilation";
  const total     = selectedIndices.length;

  if (mode === "download") {
    // --- Téléchargement brut ---
    const files = {};
    for (const [j, idx] of selectedIndices.entries()) {
      const { url, name: activityName, folder } = fileEntries[idx];
      const name = activityName || basename(url);
      const dot  = listEl.querySelectorAll(".dot")[idx];

      setStatus(`Téléchargement ${j + 1}/${total} — ${name}`);
      if (dot) dot.style.background = "#ff9500";

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext        = getExt(url);
        const filename   = name.includes(".") ? name : ext ? `${name}.${ext}` : name;
        const subfolder  = folder ? folder.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_") + "/" : "";
        const buf        = await res.arrayBuffer();
        files[subfolder + filename] = new Uint8Array(buf);
        if (dot) dot.style.background = "#34c759";
      } catch (e) {
        if (dot) dot.style.background = "#ff3b30";
        setStatus(`Erreur : ${e.message}`, "error");
      }
    }

    const entries = Object.keys(files);
    if (entries.length === 1) {
      const [filename] = entries;
      downloadBlob(new Blob([files[filename]]), filename);
    } else if (entries.length > 1) {
      const zipName = `${pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60)}.zip`;
      setStatus("Compression…");
      const zipped = zipSync(files);
      downloadBlob(new Blob([zipped], { type: "application/zip" }), zipName);
    }

    setStatus(`${entries.length} fichier${entries.length > 1 ? "s" : ""} téléchargé${entries.length > 1 ? "s" : ""}`, "success");
    btnAction.disabled = false;
    return;
  }

  // --- Compilation pour LLM ---
  let pdfjsLib;
  try {
    pdfjsLib = await getPdfJs();
  } catch {
    setStatus("Impossible de charger PDF.js", "error");
    btnAction.disabled = false;
    return;
  }

  const sections = [];

  for (const [j, idx] of selectedIndices.entries()) {
    const { url, name: activityName, folder } = fileEntries[idx];
    const ext  = getExt(url);
    const name = activityName || basename(url);
    const dot  = listEl.querySelectorAll(".dot")[idx];

    setStatus(`Extraction ${j + 1}/${total} — ${name}`);
    if (dot) dot.style.background = "#ff9500";

    try {
      const text = await extractContent(pdfjsLib, url, (pageNum, pageCount) => {
        setStatus(`Extraction ${j + 1}/${total} — ${name} (p.${pageNum}/${pageCount})`);
      });
      sections.push({ name, text, ext, folder });
      if (dot) dot.style.background = "#34c759";
    } catch (e) {
      sections.push({ name, text: `<!-- Erreur : ${e.message} -->`, ext });
      if (dot) dot.style.background = "#ff3b30";
    }
  }

  if (chkSplit.checked && sections.length > 1) {
    // --- Un .md par fichier → zip ---
    const enc   = new TextEncoder();
    const files = {};
    for (const section of sections) {
      const cleanName  = section.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/gi, "_");
      const subfolder  = section.folder ? section.folder.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_") + "/" : "";
      files[`${subfolder}${cleanName}.md`] = enc.encode(buildSingleDoc(section));
    }
    const zipName = `${pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60)}_llm.zip`;
    setStatus("Compression…");
    const zipped = zipSync(files);
    downloadBlob(new Blob([zipped], { type: "application/zip" }), zipName);
    setStatus(`${sections.length} fichiers .md compressés`, "success");
  } else if (chkSplit.checked && sections.length === 1) {
    // --- Un seul fichier, pas besoin de zip ---
    const section   = sections[0];
    const cleanName = section.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/gi, "_");
    downloadBlob(new Blob([buildSingleDoc(section)], { type: "text/markdown;charset=utf-8" }), `${cleanName}.md`);
    setStatus("1 fichier .md généré", "success");
  } else {
    // --- Compilation en un seul .md (+ éventuels .md séparés pour les gros fichiers) ---
    const { main, extras } = buildLLMDoc(sections, pageTitle);
    const baseName = pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60);

    if (extras.length > 0) {
      // Zipper le .md principal + les .md des gros fichiers
      const enc   = new TextEncoder();
      const files = {};
      files[`${baseName}_llm.md`] = enc.encode(main);
      for (const { name, content } of extras) files[name] = enc.encode(content);
      setStatus("Compression…");
      const zipped = zipSync(files);
      downloadBlob(new Blob([zipped], { type: "application/zip" }), `${baseName}_llm.zip`);
      setStatus(`Terminé — ${(main.length / 1024).toFixed(1)} Ko + ${extras.length} fichier${extras.length > 1 ? "s" : ""} séparé${extras.length > 1 ? "s" : ""}`, "success");
    } else {
      downloadBlob(new Blob([main], { type: "text/markdown;charset=utf-8" }), `${baseName}_llm.md`);
      setStatus(`Terminé — ${(main.length / 1024).toFixed(1)} Ko`, "success");
    }
  }
  btnAction.disabled = false;
});

async function runDetect() {
  const loader = document.getElementById("loader");

  btnReload.disabled = true;
  btnReload.classList.add("spinning");
  loader.classList.remove("hidden");
  selectBar.style.display = "none";
  btnAction.style.display = "none";
  setStatus("");

  fileEntries = await detectFiles();
  renderList(fileEntries);

  loader.classList.add("hidden");
  btnAction.style.display   = "block";
  btnReload.disabled = false;
  btnReload.classList.remove("spinning");
}

btnReload.addEventListener("click", runDetect);

// --- Tâche déclenchée depuis le content script ---
// Les URLs sont déjà résolues par le background (depuis l'onglet CyberLearn)
async function runPendingTask(task) {
  const entries = task.files.filter(f => f.url);
  if (entries.length === 0) { setStatus("Aucun fichier trouvé", "error"); return; }

  const pageTitle = task.sectionName || task.files[0]?.name || "compilation";

  // Fetcher un fichier depuis l'onglet CyberLearn (cookies de session)
  async function fetchFromTab(url) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: task.tabId },
      func: async (u) => {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        // Convertir en base64 pour traverser la limite IPC
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
      },
      args: [url],
    });
    if (res.error) throw new Error(res.error.message);
    const b64 = res.result;
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  if (task.action === "download") {
    const files = {};
    const total = entries.length;
    for (const [j, { url, name: actName, folder }] of entries.entries()) {
      const name = actName || basename(url);
      setStatus(`Téléchargement ${j + 1}/${total} — ${name}`);
      try {
        const ext       = getExt(url);
        const filename  = name.includes(".") ? name : ext ? `${name}.${ext}` : name;
        const subfolder = folder ? folder.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_") + "/" : "";
        files[subfolder + filename] = new Uint8Array(await fetchFromTab(url));
      } catch (e) { setStatus(`Erreur : ${e.message}`, "error"); }
    }
    const keys = Object.keys(files);
    if (keys.length === 1) {
      downloadBlob(new Blob([files[keys[0]]]), keys[0].split("/").pop());
    } else if (keys.length > 1) {
      const zipName = pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60) + ".zip";
      downloadBlob(new Blob([zipSync(files)], { type: "application/zip" }), zipName);
    }
    setStatus(`${keys.length} fichier${keys.length > 1 ? "s" : ""} téléchargé${keys.length > 1 ? "s" : ""}`, "success");
  } else {
    // compile — PDF.js tourne dans le popup, mais le fetch doit venir de CyberLearn
    // On récupère d'abord les ArrayBuffers depuis l'onglet source
    let pdfjsLib;
    try { pdfjsLib = await getPdfJs(); } catch { setStatus("Impossible de charger PDF.js", "error"); return; }

    const sections = [];
    const total    = entries.length;
    for (const [j, { url, name: actName, folder }] of entries.entries()) {
      const ext  = getExt(url);
      const name = actName || basename(url);
      setStatus(`Extraction ${j + 1}/${total} — ${name}`);
      try {
        const buffer = await fetchFromTab(url);
        const text = await extractContent(pdfjsLib, url, (p, c) => {
          setStatus(`Extraction ${j + 1}/${total} — ${name} (p.${p}/${c})`);
        }, buffer);
        sections.push({ name, text, ext, folder });
      } catch (e) { sections.push({ name, text: `<!-- Erreur : ${e.message} -->`, ext, folder }); }
    }

    const { main, extras } = buildLLMDoc(sections, pageTitle);
    const baseName = pageTitle.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60);
    if (extras.length > 0) {
      const enc   = new TextEncoder();
      const zfiles = {};
      zfiles[`${baseName}_llm.md`] = enc.encode(main);
      for (const { name: n, content } of extras) zfiles[n] = enc.encode(content);
      downloadBlob(new Blob([zipSync(zfiles)], { type: "application/zip" }), `${baseName}_llm.zip`);
    } else {
      downloadBlob(new Blob([main], { type: "text/markdown;charset=utf-8" }), `${baseName}_llm.md`);
    }
    setStatus(`Terminé — ${(main.length / 1024).toFixed(1)} Ko`, "success");
  }
}

// --- Init ---
(async () => {
  // Vérifier si une tâche vient du content script
  const { pendingTask } = await chrome.storage.session.get("pendingTask");
  if (pendingTask) {
    await chrome.storage.session.remove("pendingTask");
    document.getElementById("mode-selector").style.display = "none";
    selectBar.style.display = "none";
    btnReload.style.display = "none";
    subtitleEl.textContent  = pendingTask.sectionName || (pendingTask.scope === "all" ? "Tout le cours" : pendingTask.files[0]?.name || "");
    document.getElementById("loader").classList.remove("hidden");
    btnAction.style.display = "none";
    await runPendingTask(pendingTask);
    document.getElementById("loader").classList.add("hidden");
    return;
  }

  document.getElementById("mode-selector").style.display = "none";
  selectBar.style.display = "none";
  btnAction.style.display = "none";

  await runDetect();

  document.getElementById("mode-selector").style.display = "flex";
})();
