// popup.js — détection, extraction et compilation de fichiers pour LLM
import { zipSync } from "./fflate.mjs";
import Tesseract from "./tesseract.esm.min.js";

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

// Extensions de fichiers considérées comme des ressources à capturer
const EXTENSIONS = [
  // Documents / texte
  "pdf", "txt", "md", "rst", "csv", "tsv", "log", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
  // Code source
  "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "swift",
  "kt", "scala", "sh", "bash", "zsh", "ps1", "sql", "r", "m", "ipynb",
  // Archives / données
  "zip", "gz", "tar", "bz2", "7z", "rar", "tgz",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff",
  // Tableurs / présentations
  "xls", "xlsx", "ods", "ppt", "pptx", "odp", "doc", "docx", "odt",
];

// Types MIME lisibles en texte pour la compilation LLM
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript",
  "application/typescript", "application/x-yaml", "application/sql"];

// Extensions qu'on sait extraire avec PDF.js
const PDF_EXT = new Set(["pdf"]);

// Extensions images supportées nativement dans le navigateur
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);

function getExt(url) {
  try {
    const path     = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);
    // Chercher le dernier segment qui a une extension connue (pas .php, .aspx, etc.)
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(segments[i]);
      const m   = seg.match(/\.([a-z0-9]+)$/i);
      if (m && !["php", "aspx", "jsp", "html", "htm", "cgi"].includes(m[1].toLowerCase())) {
        return m[1].toLowerCase();
      }
    }
    return "";
  } catch {
    return "";
  }
}

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

      return out;
    },
  });

  const candidates = results[0]?.result ?? [];

  // Résoudre les redirections Moodle (mod/resource/view.php)
  const resolved = await Promise.all(
    candidates.map(async ({ href, name }) => {
      const lower = href.toLowerCase();
      const ext   = getExt(href);
      if (EXTENSIONS.includes(ext) || lower.includes("pluginfile.php")) {
        return { url: href, name };
      }
      try {
        const res = await fetch(
          href.includes("?") ? href + "&redirect=1" : href + "?redirect=1",
          { credentials: "include", redirect: "follow" }
        );
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("pdf") || ct.includes("octet-stream") ||
            EXTENSIONS.includes(getExt(res.url)) || res.url.includes("pluginfile.php")) {
          return { url: res.url, name };
        }
      } catch {}
      return null;
    })
  );

  return resolved.filter(Boolean);
}

function basename(url) {
  try {
    const parts = new URL(url).pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1]) || url;
  } catch {
    return url;
  }
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
// Retourne toujours une string
async function extractContent(pdfjsLib, url, onProgress) {
  const ext = getExt(url);

  if (PDF_EXT.has(ext)) {
    const { text, usedOcr } = await extractPdfText(pdfjsLib, url, onProgress);
    return usedOcr ? `<!-- OCR appliqué sur pages sans texte sélectionnable -->\n${text}` : text;
  }

  if (IMAGE_EXT.has(ext)) {
    // OCR direct sur les images
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob   = await res.blob();
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
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";

  const looksLikeText = TEXT_MIME_PREFIXES.some(p => ct.includes(p)) ||
    ["txt","md","csv","tsv","json","xml","yaml","yml","toml","ini","cfg","conf",
     "js","ts","jsx","tsx","py","java","c","cpp","h","hpp","cs","go","rs","rb",
     "php","swift","kt","scala","sh","bash","zsh","ps1","sql","r","log","rst","ipynb"]
      .includes(ext);

  if (looksLikeText) {
    const text = await res.text();
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

async function extractPdfText(pdfjsLib, url, onProgress) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();

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

// --- Nettoyage du contenu pour réduire le bruit ---
function cleanText(text) {
  return text
    // Commentaires de page <!-- page N --> et <!-- OCR appliqué ... -->
    .replace(/<!--[^>]*-->/g, "")
    // Numéros de slide isolés : "- 3 -" ou juste "3"
    .replace(/^\s*-\s*\d{1,4}\s*-\s*$/gm, "")
    .replace(/^\s*\d{1,4}\s*$/gm, "")
    // Numéros de page style "1/6", "2/47"
    .replace(/^\s*\d{1,3}\/\d{1,3}\s*$/gm, "")
    // Métadonnées d'auteur/cours répétitives
    .replace(/^Auteur\s*:.*$/gm, "")
    .replace(/^Dernière mise à jour\s*:.*$/gm, "")
    .replace(/^61-\d+\.\d+.*$/gm, "")
    // Lignes courtes répétées ≥ 3 fois dans le doc (entêtes/pieds)
    .split("\n").filter((line, _, arr) => {
      const t = line.trim();
      if (!t || t.length > 80) return true;
      return arr.filter(l => l.trim() === t).length < 3;
    }).join("\n")
    // Réduire les blocs de lignes vides à 2 max
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

const BIG_FILE_THRESHOLD_KO = 50;

// --- Heuristique titres (pour PDFs) ---
function detectHeadings(text, ext) {
  if (ext !== "pdf") return text; // ne pas transformer du code en titres Markdown
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const stripped = line.trim();
    if (!stripped) return "";
    const prevEmpty  = i === 0 || !lines[i - 1].trim();
    const nextEmpty  = i === lines.length - 1 || !lines[i + 1].trim();
    const isShort    = stripped.length < 80;
    const noPeriod   = !stripped.endsWith(".");
    const upperRatio = [...stripped].filter(c => c >= "A" && c <= "Z").length / stripped.length;
    if (prevEmpty && nextEmpty && isShort && noPeriod) {
      return upperRatio > 0.5 ? `## ${stripped}` : `### ${stripped}`;
    }
    return line;
  }).join("\n");
}

// --- Déduplication inter-fichiers ---
// Supprime les paragraphes déjà vus dans un fichier précédent (≥ 5 mots)
function deduplicateSections(sections) {
  const seenBlocks = new Set();

  return sections.map(section => {
    const paragraphs = section.text.split(/\n{2,}/);
    const kept = [];
    let removed = 0;

    for (const para of paragraphs) {
      const key = para.trim().replace(/\s+/g, " ");
      const wordCount = key.split(" ").length;
      if (wordCount >= 5 && seenBlocks.has(key)) {
        removed++;
        continue;
      }
      if (wordCount >= 5) seenBlocks.add(key);
      kept.push(para);
    }

    const text = kept.join("\n\n");
    const suffix = removed > 0 ? `\n\n*[${removed} bloc${removed > 1 ? "s" : ""} dupliqué${removed > 1 ? "s" : ""} supprimé${removed > 1 ? "s" : ""}]*` : "";
    return { ...section, text: text + suffix };
  });
}

// --- Construction du fichier LLM ---
// Retourne { main: string, extras: [{name, content}] }
function buildLLMDoc(sections, pageTitle) {
  const now   = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  const parts = [];

  // Nettoyer puis dédupliquer
  const allCleaned = deduplicateSections(sections.map(s => ({ ...s, text: cleanText(s.text) })));

  // Séparer petits et gros fichiers
  const main   = allCleaned.filter(s => s.text.length / 1024 <= BIG_FILE_THRESHOLD_KO);
  const extras = allCleaned.filter(s => s.text.length / 1024 >  BIG_FILE_THRESHOLD_KO);

  const totalKo = Math.round(main.reduce((acc, s) => acc + s.text.length, 0) / 1024);

  parts.push(`# ${pageTitle || "Compilation de fichiers"}\n`);
  parts.push(`**Source :** page web active  `);
  parts.push(`**Généré le :** ${now}  `);
  parts.push(`**Fichiers inclus :** ${main.length} — **${totalKo} Ko** de contenu\n`);

  if (extras.length > 0) {
    parts.push(`> **${extras.length} fichier${extras.length > 1 ? "s" : ""} volumineux exporté${extras.length > 1 ? "s" : ""} séparément :** ${extras.map(s => `\`${s.name}\``).join(", ")}\n`);
  }

  parts.push("---\n");

  parts.push("## Table des matières\n");
  for (const [i, { name, text, ext }] of main.entries()) {
    const anchor  = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const ko      = Math.round(text.length / 1024);
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
    parts.push(`${i + 1}. [${name}](#${anchor}) — *${(ext || "?").toUpperCase()}, ${ko} Ko*`);
    if (preview) parts.push(`   > ${preview}${text.length > 120 ? "…" : ""}`);
  }
  parts.push("\n---\n");

  for (const [i, { name, text, ext }] of main.entries()) {
    const anchor    = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const cleanName = name.replace(/\.[a-z0-9]+$/i, "");
    parts.push(`# ${i + 1}. ${cleanName}`);
    parts.push(`**Fichier source :** \`${name}\`  `);
    parts.push(`**Type :** ${(ext || "?").toUpperCase()}\n`);
    parts.push("---\n");
    parts.push(detectHeadings(text, ext));
    parts.push("\n\n---\n");
  }

  const extraFiles = extras.map(s => ({
    name: s.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/gi, "_") + ".md",
    content: buildSingleDoc(s),
  }));

  return { main: parts.join("\n"), extras: extraFiles };
}

// --- Construction d'un .md individuel ---
function buildSingleDoc({ name, text, ext }) {
  const now       = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  const cleanName = name.replace(/\.[a-z0-9]+$/i, "");
  const cleaned   = cleanText(text);
  const parts     = [];
  parts.push(`# ${cleanName}\n`);
  parts.push(`**Fichier source :** \`${name}\`  `);
  parts.push(`**Type :** ${(ext || "?").toUpperCase()}  `);
  parts.push(`**Généré le :** ${now}\n`);
  parts.push("---\n");
  parts.push(detectHeadings(cleaned, ext));
  return parts.join("\n");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Action principale ---
btnAction.addEventListener("click", async () => {
  btnAction.disabled = true;
  setStatus("");

  const allCheckboxes   = [...listEl.querySelectorAll("input[type=checkbox]")];
  const selectedIndices = allCheckboxes.map((cb, i) => cb.checked ? i : -1).filter(i => i !== -1);

  if (selectedIndices.length === 0) return;

  const [tab]     = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageTitle = tab.title || "compilation";
  const total     = selectedIndices.length;

  if (mode === "download") {
    // --- Téléchargement brut ---
    const files = {};
    for (const [j, idx] of selectedIndices.entries()) {
      const { url, name: activityName } = fileEntries[idx];
      const name = activityName || basename(url);
      const dot  = listEl.querySelectorAll(".dot")[idx];

      setStatus(`Téléchargement ${j + 1}/${total} — ${name}`);
      if (dot) dot.style.background = "#ff9500";

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ext      = getExt(url);
        const filename = name.includes(".") ? name : ext ? `${name}.${ext}` : name;
        const buf      = await res.arrayBuffer();
        files[filename] = new Uint8Array(buf);
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
      const zipName = `${pageTitle.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.zip`;
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
    const { url, name: activityName } = fileEntries[idx];
    const ext  = getExt(url);
    const name = activityName || basename(url);
    const dot  = listEl.querySelectorAll(".dot")[idx];

    setStatus(`Extraction ${j + 1}/${total} — ${name}`);
    if (dot) dot.style.background = "#ff9500";

    try {
      const text = await extractContent(pdfjsLib, url, (pageNum, pageCount) => {
        setStatus(`Extraction ${j + 1}/${total} — ${name} (p.${pageNum}/${pageCount})`);
      });
      sections.push({ name, text, ext });
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
      const cleanName = section.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/gi, "_");
      files[`${cleanName}.md`] = enc.encode(buildSingleDoc(section));
    }
    const zipName = `${pageTitle.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}_llm.zip`;
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
    const baseName = pageTitle.replace(/[^a-z0-9]/gi, "_").slice(0, 40);

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

// --- Init ---
(async () => {
  document.getElementById("mode-selector").style.display = "none";
  selectBar.style.display = "none";
  btnAction.style.display = "none";

  await runDetect();

  document.getElementById("mode-selector").style.display = "flex";
})();
