(function () {
  if (document.querySelector('.cld-global-bar')) return;

  const style = document.createElement('style');
  style.textContent = `
    .cld-global-bar {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 6px 0 10px;
    }

    .cld-btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      white-space: nowrap;
    }

    .cld-section-btns {
      display: inline-flex;
      gap: 4px;
      margin-left: auto;
      padding-right: 8px;
      flex-shrink: 0;
    }
    .cld-btn-outline {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 400;
      line-height: 1.5;
      white-space: nowrap;
      cursor: pointer;
      border-radius: 4px;
      border: 1px solid #ced4da;
      background: #fff;
      color: #495057;
      transition: border-color 0.15s, color 0.15s;
    }
    .cld-btn-outline:hover { border-color: #0071e3; color: #0071e3; }
    .cld-btn-outline:disabled { opacity: 0.6; cursor: default; pointer-events: none; }

    .cld-item-btns {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      gap: 3px;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 10;
    }
    li.activity:hover .cld-item-btns { opacity: 1; }

    .cld-btn-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      cursor: pointer;
      border-radius: 4px;
      border: 1px solid #ced4da;
      background: #fff;
      color: #6c757d;
      font-size: 12px;
      transition: border-color 0.15s, color 0.15s;
    }
    .cld-btn-icon:hover { border-color: #0071e3; color: #0071e3; }
    .cld-btn-icon:disabled { opacity: 0.6; cursor: default; pointer-events: none; }

    .cld-btn-done  { border-color: #34c759 !important; color: #34c759 !important; }
    .cld-btn-error { border-color: #ff3b30 !important; color: #ff3b30 !important; }
  `;
  document.head.appendChild(style);

  const SVG = {
    download: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    compile:  `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    spinner:  `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:cld-spin 1s linear infinite"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>`,
  };

  // Ajouter l'animation du spinner
  const spinStyle = document.createElement('style');
  spinStyle.textContent = `@keyframes cld-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(spinStyle);

  // Registre des boutons par clé pour recevoir les mises à jour de statut
  const btnRegistry = new Map();
  let btnCounter = 0;

  function makeBtn(cls, icon, label, title, onclick) {
    const key = `cld-${++btnCounter}`;
    const btn = document.createElement('button');
    btn.className = cls;
    btn.title = title;
    btn.dataset.cldKey = key;
    btn.innerHTML = SVG[icon] + (label ? `<span class="cld-label">${label}</span>` : '');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onclick(key, btn);
    });
    btnRegistry.set(key, { btn, originalHTML: btn.innerHTML, originalClass: btn.className });
    return btn;
  }

  function setProgress(key, text) {
    const entry = btnRegistry.get(key);
    if (!entry) return;
    const { btn } = entry;
    btn.disabled = true;
    btn.classList.remove('cld-btn-done', 'cld-btn-error');
    const label = btn.querySelector('.cld-label');
    if (label) label.textContent = text;
    else btn.innerHTML = SVG.spinner + `<span class="cld-label">${text}</span>`;
  }

  function setDone(key, text) {
    const entry = btnRegistry.get(key);
    if (!entry) return;
    const { btn, originalHTML, originalClass } = entry;
    btn.disabled = false;
    btn.classList.add('cld-btn-done');
    const label = btn.querySelector('.cld-label');
    if (label) label.textContent = text;
    // Remettre le style original après 3s
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.className = originalClass;
    }, 3000);
  }

  function setError(key, text) {
    const entry = btnRegistry.get(key);
    if (!entry) return;
    const { btn, originalHTML, originalClass } = entry;
    btn.disabled = false;
    btn.classList.add('cld-btn-error');
    const label = btn.querySelector('.cld-label');
    if (label) label.textContent = text;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.className = originalClass;
    }, 4000);
  }

  // Écouter les mises à jour de statut du background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'cld-status') return;
    if (msg.state === 'progress') setProgress(msg.btnKey, msg.text);
    else if (msg.state === 'done')  setDone(msg.btnKey, msg.text);
    else if (msg.state === 'error') setError(msg.btnKey, msg.text);
  });

  function send(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (e) {
      // Extension rechargée, recharger la page pour réinitialiser le content script
      const entry = btnRegistry.get(payload.btnKey);
      if (entry) setError(payload.btnKey, "Recharge la page");
    }
  }

  function collectSectionFiles(section) {
    const files = [];
    section.querySelectorAll('li[data-for="cmitem"]').forEach((item) => {
      const isResource = item.querySelector('.modtype_resource');
      const isFolder   = item.querySelector('.modtype_folder');
      if (!isResource && !isFolder) return;
      const anchor = item.querySelector('a[href]');
      if (!anchor) return;
      const name = item.querySelector('.activity-item')?.dataset?.activityname || anchor.textContent.trim();
      files.push({ href: anchor.href, name, folder: !!isFolder });
    });
    return files;
  }

  function collectAllFiles() {
    const files = [];
    document.querySelectorAll('li.section.course-section[data-for="section"]').forEach((s) => {
      files.push(...collectSectionFiles(s));
    });
    return files;
  }

  // --- Barre globale ---
  const sectionList = document.querySelector('ul[data-for="course_sectionlist"]');
  if (sectionList) {
    const bar = document.createElement('div');
    bar.className = 'cld-global-bar';
    bar.appendChild(makeBtn('btn btn-primary btn-sm cld-btn-primary', 'download', 'Tout télécharger',    'Télécharger tous les fichiers du cours', (key) => { setProgress(key, 'Résolution…'); send({ action: 'download', scope: 'all', files: collectAllFiles(), btnKey: key }); }));
    bar.appendChild(makeBtn('btn btn-primary btn-sm cld-btn-primary', 'compile',  'Tout compiler pour LLM', 'Compiler tous les fichiers en Markdown', (key) => { setProgress(key, 'Résolution…'); send({ action: 'compile',  scope: 'all', files: collectAllFiles(), btnKey: key }); }));
    sectionList.insertAdjacentElement('beforebegin', bar);
  }

  // --- Boutons par section et par fichier ---
  document.querySelectorAll('li.section.course-section[data-for="section"]').forEach((section) => {
    const sectionName = section.dataset.sectionname || '';

    const header = section.querySelector('.course-section-header');
    if (header) {
      const wrap = document.createElement('span');
      wrap.className = 'cld-section-btns';
      wrap.appendChild(makeBtn('cld-btn-outline', 'download', 'Télécharger', 'Télécharger les fichiers de cette section', (key) => { setProgress(key, 'Résolution…'); send({ action: 'download', scope: 'section', sectionName, files: collectSectionFiles(section), btnKey: key }); }));
      wrap.appendChild(makeBtn('cld-btn-outline', 'compile',  'Compiler',    'Compiler cette section pour LLM',            (key) => { setProgress(key, 'Résolution…'); send({ action: 'compile',  scope: 'section', sectionName, files: collectSectionFiles(section), btnKey: key }); }));
      header.style.alignItems = 'center';
      header.appendChild(wrap);
    }

    section.querySelectorAll('li[data-for="cmitem"]').forEach((item) => {
      const isResource = item.querySelector('.modtype_resource');
      const isFolder   = item.querySelector('.modtype_folder');
      if (!isResource && !isFolder) return;
      const anchor = item.querySelector('a[href]');
      if (!anchor) return;

      const name   = item.querySelector('.activity-item')?.dataset?.activityname || anchor.textContent.trim();
      const href   = anchor.href;
      const folder = !!isFolder;

      item.style.position = 'relative';

      const wrap = document.createElement('span');
      wrap.className = 'cld-item-btns';
      wrap.appendChild(makeBtn('cld-btn-icon', 'download', '', 'Télécharger ce fichier',     (key) => { setProgress(key, ''); send({ action: 'download', scope: 'file', files: [{ href, name, folder }], btnKey: key }); }));
      wrap.appendChild(makeBtn('cld-btn-icon', 'compile',  '', 'Compiler ce fichier pour LLM', (key) => { setProgress(key, ''); send({ action: 'compile', scope: 'file', files: [{ href, name, folder }], btnKey: key }); }));
      item.appendChild(wrap);
    });
  });
})();
