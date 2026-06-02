(function () {
  if (document.querySelector('.cld-global-bar')) return;

  const BLUE = '#0071e3';

  const style = document.createElement('style');
  style.textContent = `
    .cld-global-bar {
      display: flex;
      gap: 8px;
      padding: 8px 0;
      margin-top: 8px;
    }
    .cld-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: ${BLUE};
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      line-height: 1.4;
    }
    .cld-btn:hover {
      background: #005bb5;
    }
    .cld-section-btns {
      display: inline-flex;
      gap: 6px;
      margin-left: 10px;
      vertical-align: middle;
    }
    .cld-item-btns {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 10;
    }
    li.activity:hover .cld-item-btns {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);

  function makeBtn(label, onclick) {
    const btn = document.createElement('button');
    btn.className = 'cld-btn';
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onclick();
    });
    return btn;
  }

  function collectSectionFiles(section) {
    const files = [];
    section.querySelectorAll('li[data-for="cmitem"]').forEach((item) => {
      const isResource = item.querySelector('.modtype_resource');
      const isFolder = item.querySelector('.modtype_folder');
      if (!isResource && !isFolder) return;
      const anchor = item.querySelector('a[href]');
      if (!anchor) return;
      const name = item.querySelector('.activity-item')?.dataset?.activityname
        || anchor.textContent.trim();
      files.push({ href: anchor.href, name, folder: !!isFolder });
    });
    return files;
  }

  function collectAllFiles() {
    const files = [];
    document.querySelectorAll('li.section.course-section[data-for="section"]').forEach((section) => {
      files.push(...collectSectionFiles(section));
    });
    return files;
  }

  function send(payload) {
    chrome.runtime.sendMessage(payload);
  }

  // Global bar
  const pageHeader = document.querySelector('.page-context-header');
  if (pageHeader) {
    const bar = document.createElement('div');
    bar.className = 'cld-global-bar';
    bar.appendChild(makeBtn('⬇ Tout télécharger', () => {
      send({ action: 'download', scope: 'all', files: collectAllFiles() });
    }));
    bar.appendChild(makeBtn('📄 Tout compiler pour LLM', () => {
      send({ action: 'compile', scope: 'all', files: collectAllFiles() });
    }));
    pageHeader.insertAdjacentElement('afterend', bar);
  }

  // Section buttons + file buttons
  document.querySelectorAll('li.section.course-section[data-for="section"]').forEach((section) => {
    const sectionName = section.dataset.sectionname || '';
    const header = section.querySelector('.course-section-header');

    if (header) {
      const sectionBtns = document.createElement('span');
      sectionBtns.className = 'cld-section-btns';
      sectionBtns.appendChild(makeBtn('⬇ Section', () => {
        send({ action: 'download', scope: 'section', sectionName, files: collectSectionFiles(section) });
      }));
      sectionBtns.appendChild(makeBtn('📄 Section', () => {
        send({ action: 'compile', scope: 'section', sectionName, files: collectSectionFiles(section) });
      }));
      const title = header.querySelector('h3.sectionname');
      if (title) {
        title.appendChild(sectionBtns);
      } else {
        header.appendChild(sectionBtns);
      }
    }

    section.querySelectorAll('li[data-for="cmitem"]').forEach((item) => {
      const isResource = item.querySelector('.modtype_resource');
      const isFolder = item.querySelector('.modtype_folder');
      if (!isResource && !isFolder) return;

      const anchor = item.querySelector('a[href]');
      if (!anchor) return;

      const name = item.querySelector('.activity-item')?.dataset?.activityname
        || anchor.textContent.trim();
      const href = anchor.href;
      const folder = !!isFolder;

      item.style.position = 'relative';

      const itemBtns = document.createElement('span');
      itemBtns.className = 'cld-item-btns';
      itemBtns.appendChild(makeBtn('⬇', () => {
        send({ action: 'download', scope: 'file', files: [{ href, name, folder }] });
      }));
      itemBtns.appendChild(makeBtn('📄', () => {
        send({ action: 'compile', scope: 'file', files: [{ href, name, folder }] });
      }));
      item.appendChild(itemBtns);
    });
  });
})();
