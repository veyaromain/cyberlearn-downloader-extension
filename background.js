import { zipSync } from "./fflate.mjs";

// Envoie un message de statut au content script de l'onglet
function sendStatus(tabId, status) {
  chrome.tabs.sendMessage(tabId, { type: "cld-status", ...status });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg.action || !msg.files) return;
  const tabId = sender.tab.id;

  // Résoudre les URLs depuis l'onglet (cookies présents), puis traiter
  chrome.scripting.executeScript({
    target: { tabId },
    func: async (files, extensions) => {
      const resolved = await Promise.all(files.map(async ({ href, name, folder: isFolder }) => {
        if (isFolder || href.includes("/mod/folder/view.php")) {
          try {
            const res  = await fetch(href, { credentials: "include" });
            const html = await res.text();
            const doc  = new DOMParser().parseFromString(html, "text/html");
            return Array.from(doc.querySelectorAll("a[href]"))
              .map(a => a.href)
              .filter(h => h.includes("pluginfile.php"))
              .map(h => ({ url: h, name, folder: name }));
          } catch { return []; }
        }
        const ext = href.split(".").pop().toLowerCase().split("?")[0];
        if (extensions.includes(ext) || href.includes("pluginfile.php")) {
          return [{ url: href, name }];
        }
        try {
          const res = await fetch(
            href.includes("?") ? href + "&redirect=1" : href + "?redirect=1",
            { credentials: "include", redirect: "follow" }
          );
          const ct   = res.headers.get("content-type") || "";
          const rext = res.url.split(".").pop().toLowerCase().split("?")[0];
          if (ct.includes("pdf") || ct.includes("octet-stream") ||
              extensions.includes(rext) || res.url.includes("pluginfile.php")) {
            return [{ url: res.url, name }];
          }
        } catch {}
        return [];
      }));
      return resolved.flat().filter(Boolean);
    },
    args: [msg.files, ["pdf","doc","docx","ppt","pptx","xls","xlsx","txt","md","py","js","java","sql","zip","png","jpg","jpeg","gif","svg"]],
  }).then(async results => {
    const resolvedFiles = results[0]?.result ?? [];
    if (resolvedFiles.length === 0) {
      sendStatus(tabId, { btnKey: msg.btnKey, text: "Aucun fichier", state: "error" });
      return;
    }

    if (msg.action === "download") {
      const total = resolvedFiles.length;
      const collected = []; // { filename, b64, subfolder }

      for (const [i, { url, name, folder }] of resolvedFiles.entries()) {
        sendStatus(tabId, { btnKey: msg.btnKey, text: `${i + 1}/${total}`, state: "progress" });
        try {
          const [fetchResult] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (u) => {
              const r = await fetch(u, { credentials: "include" });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const buf = await r.arrayBuffer();
              return btoa(String.fromCharCode(...new Uint8Array(buf)));
            },
            args: [url],
          });
          if (fetchResult.error) throw new Error(fetchResult.error.message);
          const ext      = url.split(".").pop().toLowerCase().split("?")[0];
          const basename = name || url.split("/").pop().split("?")[0];
          const filename = basename.includes(".") ? basename : ext ? `${basename}.${ext}` : basename;
          const subfolder = folder ? folder.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_") + "/" : "";
          collected.push({ path: subfolder + filename, b64: fetchResult.result });
        } catch (e) {
          sendStatus(tabId, { btnKey: msg.btnKey, text: "Erreur", state: "error" });
          return;
        }
      }

      sendStatus(tabId, { btnKey: msg.btnKey, text: "Compression…", state: "progress" });

      // Zipper dans le background (a accès à fflate), puis déclencher le download depuis l'onglet
      const entries = {};
      for (const { path, b64 } of collected) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        entries[path] = arr;
      }
      const zipped  = zipSync(entries);
      const zipName = (msg.sectionName || "cours").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 60) + ".zip";

      // Transférer le zip comme tableau de nombres (Array) pour traverser la IPC
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (bytes, filename) => {
          const arr = new Uint8Array(bytes);
          const a   = document.createElement("a");
          a.href     = URL.createObjectURL(new Blob([arr], { type: "application/zip" }));
          a.download = filename;
          a.click();
          URL.revokeObjectURL(a.href);
        },
        args: [Array.from(zipped), zipName],
      });

      sendStatus(tabId, { btnKey: msg.btnKey, text: `✓ ${total} fichier${total > 1 ? "s" : ""}`, state: "done" });

    } else {
      // compile — nécessite PDF.js, déléguer au popup
      const task = { ...msg, files: resolvedFiles, tabId };
      chrome.storage.session.set({ pendingTask: task }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
      });
    }
  });
});
