// engine.js — fonctions pures sans dépendances DOM ni chrome.*
// Utilisé par popup.js (et éventuellement runner.js)

// Extensions de fichiers considérées comme des ressources à capturer
export const EXTENSIONS = [
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
export const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript",
  "application/typescript", "application/x-yaml", "application/sql"];

// Extensions qu'on sait extraire avec PDF.js
export const PDF_EXT = new Set(["pdf"]);

// Extensions images supportées nativement dans le navigateur
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);

export function getExt(url) {
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

export function basename(url) {
  try {
    const parts = new URL(url).pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1]) || url;
  } catch {
    return url;
  }
}

// --- Nettoyage structurel (universel, sans patterns spécifiques au cours) ---
export function cleanText(text) {
  return text
    // Commentaires HTML <!-- ... -->
    .replace(/<!--[^>]*-->/g, "")
    // Marqueurs de slide : "Slide 3", "Slide 3 :", "SLIDE 3"
    .replace(/^\s*Slides?\s*\d+\s*:?\s*$/gim, "")
    // Numéros de slide isolés : "- 3 -"
    .replace(/^\s*-\s*\d{1,4}\s*-\s*$/gm, "")
    // Numéros de page isolés : "3" ou "1/6"
    .replace(/^\s*\d{1,4}\s*$/gm, "")
    .replace(/^\s*\d{1,3}\/\d{1,3}\s*$/gm, "")
    // Adresses email isolées sur une ligne
    .replace(/^\s*[\w.+-]+@[\w.-]+\.[a-z]{2,}\s*$/gim, "")
    // URLs isolées sur une ligne
    .replace(/^\s*https?:\/\/\S+\s*$/gm, "")
    // Lignes courtes répétées ≥ 3 fois dans le même fichier (entêtes/pieds)
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

export const TOTAL_THRESHOLD_KO = 100;

// Tronque les fichiers les plus longs pour respecter le budget total
export function applyGlobalBudget(sections) {
  const totalKo = sections.reduce((acc, s) => acc + s.text.length / 1024, 0);
  if (totalKo <= TOTAL_THRESHOLD_KO) return sections;

  // Trier par taille décroissante, tronquer les plus gros en premier
  const budget  = TOTAL_THRESHOLD_KO * 1024;
  const sorted  = [...sections].sort((a, b) => b.text.length - a.text.length);
  let remaining = budget;

  // Calculer le quota par fichier (les petits gardent tout, les gros sont coupés)
  const quotas = new Map();
  for (const s of sorted) {
    const fair = remaining / (sorted.length - quotas.size);
    if (s.text.length <= fair) {
      quotas.set(s.name, s.text.length);
      remaining -= s.text.length;
    } else {
      quotas.set(s.name, Math.floor(fair));
      remaining -= fair;
    }
  }

  return sections.map(s => {
    const quota = quotas.get(s.name);
    if (s.text.length <= quota) return s;
    const truncated = s.text.slice(0, quota).replace(/\s+\S*$/, ""); // couper proprement
    const removedKo = Math.round((s.text.length - truncated.length) / 1024);
    return { ...s, text: truncated + `\n\n*[… ${removedKo} Ko tronqués pour respecter le budget global]*` };
  });
}

// --- Détection des lignes répétées entre fichiers (métadonnées de cours) ---
// Retourne un Set de lignes présentes dans ≥ 30% des fichiers
export function findCrossFileRepetitions(sections) {
  if (sections.length < 3) return new Set();
  const lineCount = new Map();
  for (const { text } of sections) {
    const seen = new Set();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.length > 100 || t.length < 4) continue;
      if (!seen.has(t)) {
        seen.add(t);
        lineCount.set(t, (lineCount.get(t) || 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.round(sections.length * 0.3));
  return new Set([...lineCount.entries()].filter(([, c]) => c >= threshold).map(([t]) => t));
}

export function stripCrossFileRepetitions(text, noiseLines) {
  if (noiseLines.size === 0) return text;
  return text.split("\n")
    .filter(line => !noiseLines.has(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const BIG_FILE_THRESHOLD_KO = 50;

// --- Heuristique titres (pour PDFs) ---
export function detectHeadings(text, ext) {
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
export function deduplicateSections(sections) {
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
export function buildLLMDoc(sections, pageTitle) {
  const now   = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  const parts = [];

  // Nettoyer individuellement, détecter le bruit inter-fichiers, dédupliquer
  const perFileCleaned = sections.map(s => ({ ...s, text: cleanText(s.text) }));
  const noiseLines     = findCrossFileRepetitions(perFileCleaned);
  const deduped        = deduplicateSections(
    perFileCleaned.map(s => ({ ...s, text: stripCrossFileRepetitions(s.text, noiseLines) }))
  );

  // Séparer gros fichiers (externalisés) puis appliquer le budget global sur le reste
  const main   = applyGlobalBudget(deduped.filter(s => s.text.length / 1024 <= BIG_FILE_THRESHOLD_KO));
  const extras = deduped.filter(s => s.text.length / 1024 >  BIG_FILE_THRESHOLD_KO);

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
export function buildSingleDoc({ name, text, ext }) {
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

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
