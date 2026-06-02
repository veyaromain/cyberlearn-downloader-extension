chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg.action || !msg.files) return;
  // Résoudre les URLs depuis l'onglet CyberLearn (qui a les cookies de session)
  // puis stocker le résultat et ouvrir le popup
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id },
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
          const ct = res.headers.get("content-type") || "";
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
  }).then(results => {
    const resolvedFiles = results[0]?.result ?? [];
    const task = { ...msg, files: resolvedFiles, tabId: sender.tab.id };
    chrome.storage.session.set({ pendingTask: task }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  });
});
