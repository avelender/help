'use strict';

(function () {
  'use strict';

  var THEME_KEY = 'secutar-help-theme';
  var EXPANDED_KEY = 'secutar-help-expanded';
  var SEARCH_DEBOUNCE_MS = 150;
  var ALL = 'all';

  var els = {
    tree: document.getElementById('tree'),
    tagCloud: document.getElementById('tag-cloud'),
    sidebar: document.getElementById('sidebar'),
    overlay: document.getElementById('overlay'),
    menuToggle: document.getElementById('menu-toggle'),
    search: document.getElementById('search'),
    filters: document.getElementById('filters'),
    catTitle: document.getElementById('cat-title'),
    copyLink: document.getElementById('copy-link'),
    resultsInfo: document.getElementById('results-info'),
    list: document.getElementById('resource-list'),
    content: document.getElementById('content'),
    toast: document.getElementById('toast')
  };

  var state = { category: ALL, q: '', tags: [] };

  var catalog = { categories: [], resources: [] };
  var categories = new Map();     // id -> {cat, path, descendants:Set, count}
  var tagCounts = new Map();      // tag -> число ресурсов
  var searchIndex = new Map();    // resource id -> строка для поиска
  var expanded = loadExpanded();

  // ---------- Утилиты ----------

  function norm(s) {
    return (s || '').toString().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); }
    catch (e) { return ''; }
  }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function loadExpanded() {
    try {
      var raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
      return Array.isArray(raw) ? new Set(raw.filter(function (x) { return typeof x === 'string'; })) : new Set();
    } catch (e) { return new Set(); }
  }

  function saveExpanded() {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(expanded))); } catch (e) { /* ignore */ }
  }

  // ---------- Загрузка и мягкая валидация данных ----------

  function loadData() {
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('FILE_PROTOCOL'));
    }
    return fetch('data/catalog.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  function softValidate(data) {
    var problems = [];
    var seenIds = new Set();
    var cats = [];
    var res = [];

    var catById = new Set();

    function walkCats(list, depth) {
      if (!Array.isArray(list)) { problems.push('categories должен быть массивом'); return; }
      list.forEach(function (c) {
        if (!c || typeof c !== 'object') { problems.push('Пропущена категория: не объект'); return; }
        var id = c.id;
        if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || seenIds.has(id)) {
          problems.push('Пропущена категория с некорректным или дублирующимся id: ' + JSON.stringify(id));
          return;
        }
        if (typeof c.name !== 'string' || !c.name.trim()) {
          problems.push('Пропущена категория "' + id + '": пустое name');
          return;
        }
        seenIds.add(id);
        catById.add(id);
        cats.push(c);
        if (Array.isArray(c.children)) walkCats(c.children, depth + 1);
      });
    }

    if (data && Array.isArray(data.categories)) walkCats(data.categories, 0);
    else problems.push('В данных отсутствует массив categories');

    if (data && Array.isArray(data.resources)) {
      data.resources.forEach(function (r) {
        if (!r || typeof r !== 'object') { problems.push('Пропущен ресурс: не объект'); return; }
        var id = r.id;
        var why = null;
        if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) why = 'некорректный id';
        else if (seenIds.has(id)) why = 'id уже занят';
        else if (typeof r.title !== 'string' || !r.title.trim()) why = 'пустое title';
        else if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) why = 'некорректный url';
        else if (!r.category || !catById.has(r.category)) why = 'несуществующая категория "' + r.category + '"';
        if (why) { problems.push('Пропущен ресурс "' + (id || '?') + '": ' + why); return; }
        seenIds.add(id);
        res.push({
          id: id,
          title: r.title,
          url: r.url,
          description: typeof r.description === 'string' ? r.description : '',
          category: r.category,
          tags: Array.isArray(r.tags) ? r.tags.filter(function (t) { return typeof t === 'string' && t.trim(); }) : [],
          order: typeof r.order === 'number' ? r.order : 0
        });
      });
    } else {
      problems.push('В данных отсутствует массив resources');
    }

    return { categories: cats, resources: res, problems: problems };
  }

  function buildIndexes() {
    categories.clear();
    tagCounts.clear();
    searchIndex.clear();

    // Сортировка категорий внутри уровней
    function sortCats(list) {
      list.sort(function (a, b) {
        var oa = typeof a.order === 'number' ? a.order : 0;
        var ob = typeof b.order === 'number' ? b.order : 0;
        if (oa !== ob) return oa - ob;
        return (a.name || '').localeCompare(b.name || '', 'ru');
      });
      list.forEach(function (c) { if (Array.isArray(c.children)) sortCats(c.children); });
    }
    sortCats(catalog.categories);

    // Индекс категорий: путь, потомки
    function register(cat, path) {
      var entry = { cat: cat, path: path, descendants: new Set(), count: 0 };
      categories.set(cat.id, entry);
      (cat.children || []).forEach(function (child) {
        var childPath = path.concat([child.id]);
        register(child, childPath);
        entry.descendants.add(child.id);
        categories.get(child.id).descendants.forEach(function (d) { entry.descendants.add(d); });
      });
    }
    catalog.categories.forEach(function (root) { register(root, [root.id]); });

    // Счётчики ресурсов и теги
    var resourceCount = new Map();
    catalog.resources.forEach(function (r) {
      resourceCount.set(r.category, (resourceCount.get(r.category) || 0) + 1);
      var tags = r.tags.map(function (t) { return t.toLowerCase(); });
      r.tagsNorm = tags;
      tags.forEach(function (t) { tagCounts.set(t, (tagCounts.get(t) || 0) + 1); });
      searchIndex.set(r.id, norm([r.title, r.description, domainOf(r.url), r.tags.join(' ')].join(' ')));
    });
    categories.forEach(function (entry) {
      var own = resourceCount.get(entry.cat.id) || 0;
      var total = own;
      entry.descendants.forEach(function (d) { total += resourceCount.get(d) || 0; });
      entry.count = total;
    });

    // Порядок категорий (после сортировки дерева) — для сортировки общего списка
    var pos = 0;
    categories.forEach(function (entry) { entry.pos = pos++; });

    // Сортировка ресурсов: по категории, затем order, затем название
    catalog.resources.sort(function (a, b) {
      var pa = categories.get(a.category).pos, pb = categories.get(b.category).pos;
      if (pa !== pb) return pa - pb;
      if (a.order !== b.order) return a.order - b.order;
      return a.title.localeCompare(b.title, 'ru');
    });
  }

  // ---------- Адресная строка ----------

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var qIndex = h.indexOf('?');
    var pathPart = qIndex === -1 ? h : h.slice(0, qIndex);
    var paramsPart = qIndex === -1 ? '' : h.slice(qIndex + 1);

    var segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    var category = ALL;
    if (segs.length) {
      var last = segs[segs.length - 1];
      if (categories.has(last)) category = last;
    }

    var params = new URLSearchParams(paramsPart);
    var q = params.get('q') || '';
    var tags = (params.get('tags') || '').split(',').filter(Boolean);

    state.category = category;
    state.q = q;
    state.tags = tags;
  }

  function writeHash(push) {
    var path = '';
    if (state.category !== ALL && categories.has(state.category)) {
      path = categories.get(state.category).path.join('/');
    }
    var params = [];
    if (state.q) params.push('q=' + encodeURIComponent(state.q));
    if (state.tags.length) params.push('tags=' + encodeURIComponent(state.tags.join(',')));
    var hash = '#/' + path + (params.length ? '?' + params.join('&') : '');
    if (location.hash !== hash) {
      if (push) history.pushState(null, '', location.pathname + location.search + hash);
      else history.replaceState(null, '', location.pathname + location.search + hash);
    }
  }

  // ---------- Дерево категорий ----------

  function buildTree() {
    els.tree.textContent = '';

    var allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'tree-link all-link';
    allBtn.setAttribute('data-id', ALL);
    var allLabel = document.createElement('span');
    allLabel.textContent = 'Все ресурсы';
    allBtn.appendChild(allLabel);
    var allCount = document.createElement('span');
    allCount.className = 'tree-count';
    allCount.textContent = String(catalog.resources.length);
    allBtn.appendChild(allCount);
    els.tree.appendChild(allBtn);

    catalog.categories.forEach(function (root) {
      els.tree.appendChild(renderNode(root, 0));
    });

    els.tree.addEventListener('click', onTreeClick);
    refreshTree();
  }

  function renderNode(cat, depth) {
    var li = document.createElement('li');
    li.className = 'tree-node';
    li.setAttribute('data-id', cat.id);

    var row = document.createElement('div');
    row.className = 'tree-row';

    var hasChildren = Array.isArray(cat.children) && cat.children.length > 0;

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle' + (hasChildren ? '' : ' no-children');
    if (hasChildren) {
      toggle.setAttribute('aria-expanded', String(expanded.has(cat.id)));
      toggle.setAttribute('aria-label', 'Развернуть/свернуть «' + cat.name + '»');
      var arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '▸';
      toggle.appendChild(arrow);
    }
    row.appendChild(toggle);

    var link = document.createElement('button');
    link.type = 'button';
    link.className = 'tree-link';
    link.setAttribute('data-id', cat.id);
    var label = document.createElement('span');
    label.textContent = cat.name;
    link.appendChild(label);
    var count = document.createElement('span');
    count.className = 'tree-count';
    count.textContent = String(categories.get(cat.id).count);
    link.appendChild(count);
    row.appendChild(link);

    li.appendChild(row);

    if (hasChildren) {
      var ul = document.createElement('ul');
      ul.className = 'tree-children';
      cat.children.forEach(function (child) { ul.appendChild(renderNode(child, depth + 1)); });
      li.appendChild(ul);
    }

    return li;
  }

  function onTreeClick(e) {
    var toggleBtn = e.target.closest('.tree-toggle:not(.no-children)');
    if (toggleBtn) {
      var node = toggleBtn.closest('.tree-node');
      var id = node.getAttribute('data-id');
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      saveExpanded();
      node.setAttribute('data-open', String(expanded.has(id)));
      toggleBtn.setAttribute('aria-expanded', String(expanded.has(id)));
      return;
    }
    var link = e.target.closest('.tree-link');
    if (link) {
      selectCategory(link.getAttribute('data-id'));
      closeMenu();
    }
  }

  function refreshTree() {
    var nodes = els.tree.querySelectorAll('.tree-node');
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute('data-id');
      node.setAttribute('data-open', String(expanded.has(id)));
    });
    var links = els.tree.querySelectorAll('.tree-link');
    Array.prototype.forEach.call(links, function (link) {
      if (link.getAttribute('data-id') === state.category) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  // ---------- Теги ----------

  function buildTagCloud() {
    els.tagCloud.textContent = '';
    var tags = Array.from(tagCounts.keys()).sort(function (a, b) {
      return a.localeCompare(b, 'ru');
    });
    if (!tags.length) {
      var note = document.createElement('span');
      note.className = 'tree-empty-note';
      note.textContent = 'Теги не заданы';
      els.tagCloud.appendChild(note);
      return;
    }
    tags.forEach(function (t) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('data-tag', t);
      chip.textContent = t + ' (' + tagCounts.get(t) + ')';
      chip.setAttribute('aria-pressed', String(state.tags.indexOf(t) !== -1));
      els.tagCloud.appendChild(chip);
    });
  }

  function onTagCloudClick(e) {
    var chip = e.target.closest('.chip[data-tag]');
    if (!chip) return;
    toggleTag(chip.getAttribute('data-tag'));
  }

  function toggleTag(tag) {
    var i = state.tags.indexOf(tag);
    if (i === -1) state.tags.push(tag); else state.tags.splice(i, 1);
    update();
  }

  // ---------- Фильтрация и список ----------

  function matchesFilters(r) {
    if (state.category !== ALL) {
      var entry = categories.get(state.category);
      if (!entry) return false;
      if (r.category !== state.category && !entry.descendants.has(r.category)) return false;
    }
    if (state.tags.length) {
      for (var i = 0; i < state.tags.length; i++) {
        if (r.tagsNorm.indexOf(state.tags[i].toLowerCase()) === -1) return false;
      }
    }
    if (state.q) {
      var hay = searchIndex.get(r.id) || '';
      if (hay.indexOf(norm(state.q)) === -1) return false;
    }
    return true;
  }

  function currentResources() {
    return catalog.resources.filter(matchesFilters);
  }

  function currentCategoryName() {
    if (state.category === ALL || !categories.has(state.category)) return 'Все ресурсы';
    return categories.get(state.category).cat.name;
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function resourceWord(n) {
    return plural(n, 'ресурс', 'ресурса', 'ресурсов');
  }

  function renderMain() {
    els.catTitle.textContent = currentCategoryName();

    var list = currentResources();
    els.resultsInfo.textContent = 'Найдено: ' + list.length + ' ' + resourceWord(list.length);

    renderFilters();

    els.list.textContent = '';
    if (!list.length) {
      var msg = document.createElement('div');
      msg.className = 'state-message';
      var p1 = document.createElement('p');
      p1.textContent = 'Ничего не найдено.';
      var p2 = document.createElement('p');
      p2.textContent = 'Попробуйте изменить запрос или сбросить фильтры.';
      msg.appendChild(p1);
      msg.appendChild(p2);
      els.list.appendChild(msg);
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function (r) { frag.appendChild(renderCard(r)); });
    els.list.appendChild(frag);
  }

  function renderFilters() {
    var q = state.q;
    var tags = state.tags;
    if (!q && !tags.length) {
      els.filters.hidden = true;
      els.filters.textContent = '';
      return;
    }
    els.filters.hidden = false;
    els.filters.textContent = '';

    if (q) {
      var qChip = makeRemoveChip('Поиск: «' + q + '»', function () {
        state.q = '';
        els.search.value = '';
        update();
      });
      els.filters.appendChild(qChip);
    }
    tags.forEach(function (t) {
      els.filters.appendChild(makeRemoveChip('Тег: ' + t, function () { toggleTag(t); }));
    });

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn-reset';
    reset.textContent = 'Сбросить всё';
    reset.addEventListener('click', resetFilters);
    els.filters.appendChild(reset);
  }

  function makeRemoveChip(label, onRemove) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip active';
    chip.setAttribute('aria-label', 'Убрать фильтр: ' + label);
    var text = document.createElement('span');
    text.textContent = label;
    var x = document.createElement('span');
    x.className = 'x';
    x.setAttribute('aria-hidden', 'true');
    x.textContent = '×';
    chip.appendChild(text);
    chip.appendChild(x);
    chip.addEventListener('click', onRemove);
    return chip;
  }

  function resetFilters() {
    state.q = '';
    state.tags = [];
    els.search.value = '';
    update();
  }

  function renderCard(r) {
    var card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('data-url', r.url);

    var avatar = document.createElement('div');
    avatar.className = 'card-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (domainOf(r.url).replace(/^([a-z0-9-]+)\..*$/i, '$1')[0] || '·');
    card.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'card-body';

    var title = document.createElement('a');
    title.className = 'card-title';
    title.href = r.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = r.title;
    body.appendChild(title);

    if (r.description) {
      var desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = r.description;
      body.appendChild(desc);
    }

    var meta = document.createElement('div');
    meta.className = 'card-meta';

    var domain = document.createElement('span');
    domain.className = 'card-domain';
    domain.textContent = domainOf(r.url);
    meta.appendChild(domain);

    if (r.tags.length) {
      var tagWrap = document.createElement('div');
      tagWrap.className = 'card-tags';
      r.tags.forEach(function (t) {
        var tagBtn = document.createElement('button');
        tagBtn.type = 'button';
        tagBtn.className = 'chip';
        tagBtn.setAttribute('data-tag', t.toLowerCase());
        tagBtn.textContent = t;
        tagWrap.appendChild(tagBtn);
      });
      meta.appendChild(tagWrap);
    }

    body.appendChild(meta);
    card.appendChild(body);

    // Клик по карточке вне ссылок и тегов — открыть ресурс
    card.addEventListener('click', function (e) {
      if (e.target.closest('a, button')) return;
      window.open(r.url, '_blank', 'noopener');
    });

    return card;
  }

  // ---------- Темы ----------

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    var mode = (saved === 'light' || saved === 'dark' || saved === 'system') ? saved : 'system';
    applyTheme(mode);

    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (currentMode() === 'system') applyTheme('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);

    Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (btn) {
      btn.addEventListener('click', function () { applyTheme(btn.getAttribute('data-theme-mode')); });
    });
  }

  function currentMode() {
    return document.documentElement.getAttribute('data-theme-mode') || 'system';
  }

  function applyTheme(mode) {
    var resolved = mode;
    if (mode === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* ignore */ }
    Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-theme-mode') === mode));
    });
  }

  // ---------- Мобильное меню ----------

  function openMenu() {
    document.body.classList.add('menu-open');
    els.menuToggle.setAttribute('aria-expanded', 'true');
    els.overlay.hidden = false;
  }

  function closeMenu() {
    document.body.classList.remove('menu-open');
    els.menuToggle.setAttribute('aria-expanded', 'false');
    els.overlay.hidden = true;
  }

  function initMenu() {
    els.menuToggle.addEventListener('click', function () {
      if (document.body.classList.contains('menu-open')) closeMenu(); else openMenu();
    });
    els.overlay.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
        closeMenu();
        els.menuToggle.focus();
      }
    });
  }

  // ---------- Копирование ссылки и уведомления ----------

  var toastTimer = null;
  function showToast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2000);
  }

  function initCopyLink() {
    els.copyLink.addEventListener('click', function () {
      writeHash();
      var url = location.href;
      function ok() { showToast('Ссылка скопирована'); }
      function fail() {
        // Резервный путь для старых браузеров
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          ok();
        } catch (e) {
          showToast('Не удалось скопировать — скопируйте адрес из строки браузера');
        }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, fail);
      } else {
        fail();
      }
    });
  }

  // ---------- Состояние каталога ----------

  function selectCategory(id) {
    state.category = categories.has(id) ? id : ALL;
    // Автоматически раскрыть ветви до выбранной категории
    if (state.category !== ALL) {
      var path = categories.get(state.category).path;
      for (var i = 0; i < path.length - 1; i++) expanded.add(path[i]);
      saveExpanded();
    }
    update(true);
    els.content.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function update(push) {
    writeHash(push === true);
    refreshTree();
    renderMain();
    refreshTagCloudPressed();
  }

  function refreshTagCloudPressed() {
    var chips = els.tagCloud.querySelectorAll('.chip[data-tag]');
    Array.prototype.forEach.call(chips, function (chip) {
      var t = chip.getAttribute('data-tag');
      chip.setAttribute('aria-pressed', String(state.tags.indexOf(t) !== -1));
    });
  }

  function showFatal(title, detail, hint) {
    els.catTitle.textContent = title;
    els.resultsInfo.textContent = '';
    els.list.textContent = '';
    var msg = document.createElement('div');
    msg.className = 'state-message error';
    var p = document.createElement('p');
    p.textContent = detail;
    msg.appendChild(p);
    if (hint) {
      var p2 = document.createElement('p');
      p2.textContent = hint;
      msg.appendChild(p2);
    }
    els.list.appendChild(msg);
  }

  // ---------- Запуск ----------

  function init() {
    initTheme();
    initMenu();
    initCopyLink();

    els.search.addEventListener('input', debounce(function () {
      state.q = els.search.value.trim();
      update();
    }, SEARCH_DEBOUNCE_MS));

    els.tagCloud.addEventListener('click', onTagCloudClick);

    window.addEventListener('hashchange', function () {
      parseHash();
      els.search.value = state.q;
      update();
    });

    loadData()
      .then(function (data) {
        var checked = softValidate(data);
        if (!checked.resources.length && !checked.categories.length) {
          showFatal('Ошибка данных', 'Не удалось прочитать каталог.',
            'Проверьте файл data/catalog.json — подробности в Actions репозитория.');
          return;
        }
        catalog.categories = checked.categories;
        catalog.resources = checked.resources;
        buildIndexes();
        buildTree();
        buildTagCloud();
        parseHash();
        els.search.value = state.q;
        update();
        if (checked.problems.length) {
          console.warn('SecuTar Help: пропущены проблемные записи каталога:', checked.problems);
        }
      })
      .catch(function (err) {
        if (err && err.message === 'FILE_PROTOCOL') {
          showFatal('Локальное открытие',
            'Страница открыта как файл (file://), поэтому браузер не даёт загрузить данные каталога.',
            'Запустите локальный сервер, например: python -m http.server, и откройте http://localhost:8000');
        } else {
          showFatal('Ошибка загрузки',
            'Не удалось загрузить data/catalog.json' + (err && err.message ? ' (' + err.message + ')' : ''),
            'Проверьте публикацию на GitHub Pages или настройки доступа.');
        }
      });
  }

  init();
})();
