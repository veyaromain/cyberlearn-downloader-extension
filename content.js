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

    /* Boutons globaux : style btn-primary Moodle/Bootstrap */
    .cld-btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      white-space: nowrap;
      cursor: pointer;
      border-radius: 4px;
      border: 1px solid #0071e3;
      background: #0071e3;
      color: #fff;
      transition: background 0.15s, border-color 0.15s;
    }
    .cld-btn-primary:hover { background: #005bb5; border-color: #005bb5; }

    /* Boutons section : outline discret */
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

    /* Boutons fichier : icône seule, visible au survol */
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
  `;
  document.head.appendChild(style);

  // SVG icons inline (Font Awesome shapes, no dependency)
  const SVG = {
    download: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    compile:  `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  };

  function makeBtn(cls, icon, label, title, onclick) {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.title = title;
    btn.innerHTML = SVG[icon] + (label ? `<span>${label}</span>` : '');
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onclick(); });
    return btn;
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

  function send(payload) { chrome.runtime.sendMessage(payload); }

  // --- Barre globale (juste avant la liste des sections) ---
  const sectionList = document.querySelector('ul[data-for="course_sectionlist"]');
  if (sectionList) {
    const bar = document.createElement('div');
    bar.className = 'cld-global-bar';
    bar.appendChild(makeBtn('cld-btn-primary', 'download', 'Tout télécharger',    'Télécharger tous les fichiers du cours', () => send({ action: 'download', scope: 'all', files: collectAllFiles() })));
    bar.appendChild(makeBtn('cld-btn-primary', 'compile',  'Tout compiler pour LLM', 'Compiler tous les fichiers en Markdown', () => send({ action: 'compile',  scope: 'all', files: collectAllFiles() })));
    sectionList.insertAdjacentElement('beforebegin', bar);
  }

  // --- Boutons par section et par fichier ---
  document.querySelectorAll('li.section.course-section[data-for="section"]').forEach((section) => {
    const sectionName = section.dataset.sectionname || '';

    const header = section.querySelector('.course-section-header');
    if (header) {
      const wrap = document.createElement('span');
      wrap.className = 'cld-section-btns';
      wrap.appendChild(makeBtn('cld-btn-outline', 'download', 'Télécharger', 'Télécharger les fichiers de cette section', () => send({ action: 'download', scope: 'section', sectionName, files: collectSectionFiles(section) })));
      wrap.appendChild(makeBtn('cld-btn-outline', 'compile',  'Compiler',    'Compiler cette section pour LLM',            () => send({ action: 'compile',  scope: 'section', sectionName, files: collectSectionFiles(section) })));
      // Insérer dans le header directement (déjà d-flex) pour que margin-left:auto fonctionne
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
      wrap.appendChild(makeBtn('cld-btn-icon', 'download', '', 'Télécharger ce fichier',    () => send({ action: 'download', scope: 'file', files: [{ href, name, folder }] })));
      wrap.appendChild(makeBtn('cld-btn-icon', 'compile',  '', 'Compiler ce fichier pour LLM', () => send({ action: 'compile',  scope: 'file', files: [{ href, name, folder }] })));
      item.appendChild(wrap);
    });
  });
})();
