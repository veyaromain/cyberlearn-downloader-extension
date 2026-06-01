// popup.js — détection, extraction et compilation de fichiers pour LLM

const btnAction      = document.getElementById("btn-action");
const statusEl       = document.getElementById("status");
const listEl         = document.getElementById("file-list");
const emptyEl        = document.getElementById("empty");
const subtitleEl     = document.getElementById("subtitle");
const selectBar      = document.getElementById("select-bar");
const checkedCountEl = document.getElementById("checked-count");
const btnToggleAll   = document.getElementById("btn-toggle-all");
const splitOption    = document.getElementById("split-option");
const chkSplit       = document.getElementById("chk-split");

let fileEntries = []; // [{url, name}]
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
    splitOption.style.display = mode === "compile" ? "flex" : "none";
    updateActionButton();
  });
});

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

      // Cibler uniquement les ressources déposées par le prof :
      // .activity-item[data-activityname] contenant .modtype_resource
      const activities = Array.from(
        document.querySelectorAll(".activity-item[data-activityname] .modtype_resource")
      );

      return activities.flatMap(activity => {
        const card = activity.closest(".activity-item[data-activityname]");
        const name = card?.dataset.activityname || null;
        const anchors = Array.from(activity.querySelectorAll("a[href]"));

        return anchors
          .map(a => ({ href: a.href, name }))
          .filter(({ href }) => {
            if (seen.has(href)) return false;
            seen.add(href);
            return true;
          });
      });
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
    emptyEl.style.display    = "block";
    selectBar.style.display  = "none";
    subtitleEl.textContent   = "Aucun fichier détecté";
    return;
  }

  emptyEl.style.display   = "none";
  selectBar.style.display = "flex";
  subtitleEl.textContent  = `${files.length} fichier${files.length > 1 ? "s" : ""} détecté${files.length > 1 ? "s" : ""}`;

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
async function extractContent(pdfjsLib, url) {
  const ext = getExt(url);

  if (PDF_EXT.has(ext)) {
    return await extractPdfText(pdfjsLib, url);
  }

  if (IMAGE_EXT.has(ext)) {
    return `[Image binaire — ${basename(url)} — extraction texte non disponible]`;
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

async function extractPdfText(pdfjsLib, url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();

  const doc       = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageParts = [];

  for (let i = 1; i <= doc.numPages; i++) {
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
    if (lines.length) pageParts.push(`<!-- page ${i} -->\n${lines.join("\n")}`);
  }

  return pageParts.join("\n\n");
}

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

// --- Construction du fichier LLM ---
function buildLLMDoc(sections, pageTitle) {
  const now   = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  const parts = [];

  parts.push(`# ${pageTitle || "Compilation de fichiers"}\n`);
  parts.push(`**Source :** page web active  `);
  parts.push(`**Généré le :** ${now}  `);
  parts.push(`**Fichiers inclus :** ${sections.length}\n`);
  parts.push("---\n");

  parts.push("## Table des matières\n");
  for (const [i, { name }] of sections.entries()) {
    const anchor = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    parts.push(`${i + 1}. [${name}](#${anchor})`);
  }
  parts.push("\n---\n");

  for (const [i, { name, text, ext }] of sections.entries()) {
    const anchor    = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const cleanName = name.replace(/\.[a-z0-9]+$/i, "");
    parts.push(`# ${i + 1}. ${cleanName}`);
    parts.push(`<a id="${anchor}"></a>`);
    parts.push(`**Fichier source :** \`${name}\`  `);
    parts.push(`**Type :** ${(ext || "?").toUpperCase()}\n`);
    parts.push("---\n");
    parts.push(detectHeadings(text, ext));
    parts.push("\n\n---\n");
  }

  return parts.join("\n");
}

// --- Construction d'un .md individuel ---
function buildSingleDoc({ name, text, ext }) {
  const now       = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  const cleanName = name.replace(/\.[a-z0-9]+$/i, "");
  const parts     = [];
  parts.push(`# ${cleanName}\n`);
  parts.push(`**Fichier source :** \`${name}\`  `);
  parts.push(`**Type :** ${(ext || "?").toUpperCase()}  `);
  parts.push(`**Généré le :** ${now}\n`);
  parts.push("---\n");
  parts.push(detectHeadings(text, ext));
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
    for (const [j, idx] of selectedIndices.entries()) {
      const { url, name: activityName } = fileEntries[idx];
      const name = activityName || basename(url);
      const dot  = listEl.querySelectorAll(".dot")[idx];

      setStatus(`Téléchargement ${j + 1}/${total} — ${name}`);
      if (dot) dot.style.background = "#ff9500";

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext  = getExt(url);
        const filename = name.includes(".") ? name : ext ? `${name}.${ext}` : name;
        downloadBlob(blob, filename);
        if (dot) dot.style.background = "#34c759";
      } catch (e) {
        if (dot) dot.style.background = "#ff3b30";
        setStatus(`Erreur : ${e.message}`, "error");
      }
    }

    setStatus(`${total} fichier${total > 1 ? "s" : ""} téléchargé${total > 1 ? "s" : ""}`, "success");
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
      const text = await extractContent(pdfjsLib, url);
      sections.push({ name, text, ext });
      if (dot) dot.style.background = "#34c759";
    } catch (e) {
      sections.push({ name, text: `<!-- Erreur : ${e.message} -->`, ext });
      if (dot) dot.style.background = "#ff3b30";
    }
  }

  if (chkSplit.checked) {
    // --- Un .md par fichier ---
    for (const { name, text, ext } of sections) {
      const cleanName = name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]/gi, "_");
      const content   = buildSingleDoc({ name, text, ext });
      downloadBlob(new Blob([content], { type: "text/markdown;charset=utf-8" }), `${cleanName}.md`);
    }
    setStatus(`${sections.length} fichier${sections.length > 1 ? "s" : ""} .md générés`, "success");
  } else {
    // --- Compilation en un seul .md ---
    const content  = buildLLMDoc(sections, pageTitle);
    const filename = `${pageTitle.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}_llm.md`;
    downloadBlob(new Blob([content], { type: "text/markdown;charset=utf-8" }), filename);
    setStatus(`Terminé — ${(content.length / 1024).toFixed(1)} Ko`, "success");
  }
  btnAction.disabled = false;
});

// --- Init ---
(async () => {
  splitOption.style.display = "flex"; // visible par défaut (mode compile actif)
  fileEntries = await detectFiles();
  renderList(fileEntries);
})();
