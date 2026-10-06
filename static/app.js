/* ==========================================================
   GitHub Repository Explorer — UI logic

   The browser only talks to this app's own /api/* endpoints.
   Each endpoint is answered by the MCP client in web_app.py,
   which calls the MCP server (github_server.py) → GitHub API.
   ========================================================== */

(() => {
  'use strict';

  // ---------- Small DOM helpers ----------

  const $ = (selector, root = document) => root.querySelector(selector);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Build an element. All text goes through text nodes, so repo content is never parsed as HTML. */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /** Reference an icon from the sprite in index.html. */
  function icon(name, extraClass = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `icon ${extraClass}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const skeleton = (width, height = 14, extra = '') =>
    h('span', { class: 'skeleton', style: `width:${width};height:${height}px;${extra}` });

  // ---------- Formatters ----------

  const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

  const formatCount = (n) => (n >= 10000 ? compactNumber.format(n) : n.toLocaleString('en-US'));

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------- API layer (talks to web_app.py → MCP) ----------

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  async function api(endpoint, params = {}) {
    let response;
    try {
      response = await fetch(`/api/${endpoint}?${new URLSearchParams(params)}`);
    } catch {
      throw new ApiError('network', 'Unable to reach the application server. Please check that it is running.', 0);
    }

    let body = null;
    try { body = await response.json(); } catch { /* non-JSON response */ }

    if (!response.ok) {
      const error = body && body.error;
      throw new ApiError(
        (error && error.code) || 'unknown',
        (error && error.message) || 'Something went wrong. Please try again.',
        response.status
      );
    }
    return body;
  }

  // ---------- App state ----------

  const MAX_RENDERED_LINES = 5000;
  const README_PATTERN = /^readme(\.[a-z]+)?$/i;

  const state = {
    owner: '',
    repo: '',
    loadId: 0,        // bumps on every repository load → stale responses are ignored
    fileLoadId: 0,    // bumps on every file open
    dirCache: new Map(),
    ui: null,         // references to the rendered workspace
  };

  const els = {
    form: $('#repo-form'),
    owner: $('#owner-input'),
    repo: $('#repo-input'),
    button: $('#explore-btn'),
    results: $('#results'),
    statusMcp: $('#status-mcp'),
    statusGithub: $('#status-github'),
  };

  const setResults = (...nodes) => els.results.replaceChildren(...nodes);

  /** Once a repository is on screen, shrink the search card so the explorer gets the space. */
  const setCompactSearch = (isCompact) => $('.search-card').classList.toggle('is-compact', isCompact);

  function setBusy(isBusy) {
    els.button.disabled = isBusy;
    els.button.classList.toggle('is-loading', isBusy);
    $('.btn-label', els.button).textContent = isBusy ? 'Loading…' : 'Explore Repository';
  }

  // ---------- Connection status (header) ----------

  function setPill(pill, stateName, text, title = '') {
    pill.dataset.state = stateName;
    $('.status-text', pill).textContent = text;
    pill.title = title;
  }

  async function refreshStatus() {
    try {
      const status = await api('status');
      const tools = status.mcp.tools.length ? `Tools: ${status.mcp.tools.join(', ')}` : '';

      if (status.mcp.connected) setPill(els.statusMcp, 'ok', 'MCP Connected', tools);
      else setPill(els.statusMcp, 'error', 'MCP Disconnected');

      const { connected, reason } = status.github;
      if (connected) setPill(els.statusGithub, 'ok', 'GitHub API Connected');
      else if (reason === 'auth') setPill(els.statusGithub, 'error', 'GitHub Authentication Error', 'Check GITHUB_TOKEN in your .env file');
      else if (reason === 'rate_limit') setPill(els.statusGithub, 'warn', 'GitHub Rate Limited');
      else setPill(els.statusGithub, 'error', 'GitHub API Unreachable');
    } catch {
      setPill(els.statusMcp, 'error', 'MCP Disconnected');
      setPill(els.statusGithub, 'error', 'GitHub API Unknown');
    }
  }

  // ---------- Generic state blocks (empty / error) ----------

  function stateBlock({ iconName, title, text, tone = 'info', action = null }) {
    return h('div', { class: 'state', 'data-tone': tone },
      h('div', { class: 'state-icon' }, icon(iconName)),
      h('h3', { class: 'state-title' }, title),
      h('p', { class: 'state-text' }, text),
      action && h('button', { class: 'btn btn-secondary', type: 'button', onclick: action.onClick }, action.label)
    );
  }

  const emptyView = () =>
    h('div', { class: 'card' }, stateBlock({
      iconName: 'search',
      title: 'No repository selected',
      text: 'Enter a GitHub owner and repository name above to start exploring.',
    }));

  /** Map API error codes to concise, user-facing copy. */
  function describeError(err, subject = 'content') {
    switch (err.code) {
      case 'not_found':
        return subject === 'repository'
          ? { iconName: 'search', title: 'Repository not found', text: 'Unable to load repository. Please check the owner and repository name.', tone: 'error' }
          : { iconName: 'search', title: 'Not found', text: err.message, tone: 'error' };
      case 'auth':
        return { iconName: 'lock', title: 'Authentication error', text: err.message, tone: 'warn' };
      case 'rate_limit':
        return { iconName: 'alert', title: 'GitHub rate limit reached', text: err.message, tone: 'warn' };
      case 'invalid':
        return { iconName: 'alert', title: 'Check your input', text: err.message, tone: 'warn' };
      case 'mcp':
      case 'network':
        return { iconName: 'alert', title: err.code === 'mcp' ? 'MCP server unavailable' : 'Connection problem', text: err.message, tone: 'error' };
      case 'binary':
        return { iconName: 'file', title: 'Preview unavailable', text: err.message, tone: 'info' };
      case 'too_large':
        return { iconName: 'file', title: 'File too large to preview', text: err.message, tone: 'info' };
      default:
        return { iconName: 'alert', title: 'GitHub API error', text: err.message, tone: 'error' };
    }
  }

  // ---------- Loading view ----------

  function loadingView() {
    return h('div', { class: 'card overview', 'aria-busy': 'true' },
      skeleton('38%', 26),
      skeleton('62%', 14, 'margin-top:12px'),
      h('div', { class: 'stats' },
        ...Array.from({ length: 5 }, () => skeleton('100%', 66, 'border-radius:10px'))
      ),
      h('p', { class: 'loading-caption' }, 'Loading repository…')
    );
  }

  // ---------- Repository overview ----------

  function overviewCard(repo) {
    const stats = [
      { icon: 'star',   label: 'Stars',          value: formatCount(repo.stars),       title: repo.stars.toLocaleString('en-US') },
      { icon: 'fork',   label: 'Forks',          value: formatCount(repo.forks),       title: repo.forks.toLocaleString('en-US') },
      { icon: 'issue',  label: 'Open Issues',    value: formatCount(repo.open_issues), title: repo.open_issues.toLocaleString('en-US') },
      { icon: 'code',   label: 'Language',       value: repo.language || '—',          title: repo.language ? '' : 'No primary language detected' },
      { icon: 'branch', label: 'Default Branch', value: repo.default_branch,           title: repo.default_branch, mono: true },
    ];

    const displayUrl = repo.url.replace(/^https?:\/\//, '');

    return h('section', { class: 'card overview', 'aria-label': 'Repository overview' },
      h('div', { class: 'overview-top' },
        h('div', { class: 'overview-main' },
          h('h2', { class: 'repo-name' },
            h('span', { class: 'owner' }, repo.owner), h('span', { class: 'slash' }, '/'), repo.name
          ),
          h('p', { class: `repo-description${repo.description ? '' : ' is-empty'}` },
            repo.description || 'No description provided.'
          ),
          h('a', { class: 'repo-url', href: repo.url, target: '_blank', rel: 'noopener noreferrer' },
            displayUrl, icon('external')
          )
        ),
        h('a', { class: 'btn btn-secondary', href: repo.url, target: '_blank', rel: 'noopener noreferrer' },
          'Open on GitHub', icon('external')
        )
      ),
      h('div', { class: 'stats' },
        stats.map((stat) =>
          h('div', { class: 'stat' },
            h('span', { class: 'stat-icon' }, icon(stat.icon)),
            h('div', { class: 'stat-body' },
              h('div', { class: 'stat-label' }, stat.label),
              h('div', { class: `stat-value${stat.mono ? ' mono' : ''}`, title: stat.title }, stat.value)
            )
          )
        )
      )
    );
  }

  // ---------- Workspace: explorer + viewer ----------

  function workspaceView(repo) {
    const treeEl = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Repository files' });
    const viewer = h('section', { class: 'card panel panel-viewer', 'aria-label': 'File viewer' });

    const explorer = h('section', { class: 'card panel panel-explorer', 'aria-label': 'File explorer' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'panel-title' }, 'Files'),
        h('span', { class: 'branch-chip', title: `Default branch: ${repo.default_branch}` },
          icon('branch'), h('span', {}, repo.default_branch)
        )
      ),
      h('div', { class: 'tree-scroll' }, treeEl)
    );

    state.ui = { treeEl, viewer };
    renderViewerEmpty();
    return h('div', { class: 'workspace' }, explorer, viewer);
  }

  // ----- File tree -----

  async function getDirectory(path) {
    if (state.dirCache.has(path)) return state.dirCache.get(path);
    const data = await api('files', { owner: state.owner, repo: state.repo, path });
    state.dirCache.set(path, data.items);
    return data.items;
  }

  const treeNote = (depth, ...content) =>
    h('li', { role: 'none' }, h('div', { class: 'tree-note', style: `--depth:${depth}` }, ...content));

  const treeSkeleton = () =>
    h('li', { role: 'none' }, h('div', { class: 'skeleton-stack', 'aria-label': 'Loading files' },
      ...[70, 55, 82, 48, 64, 58].map((w) => skeleton(`${w}%`, 14))
    ));

  /** Fill `listEl` with the contents of `path`. Resolves true on success. */
  async function populateDirectory(path, listEl, depth) {
    const loadId = state.loadId;
    listEl.replaceChildren(depth === 0 ? treeSkeleton() : treeNote(depth, 'Loading…'));

    try {
      const items = await getDirectory(path);
      if (loadId !== state.loadId) return false;

      if (!items.length) {
        listEl.replaceChildren(treeNote(depth, 'Empty folder'));
      } else {
        listEl.replaceChildren(...items.map((item) => treeItem(item, depth)));
      }
      return true;
    } catch (err) {
      if (loadId !== state.loadId) return false;
      const retry = h('button', { type: 'button', onclick: () => populateDirectory(path, listEl, depth) }, 'Retry');
      listEl.replaceChildren(treeNote(depth, `${err.message} `, retry));
      return false;
    }
  }

  function treeItem(item, depth) {
    const li = h('li', { role: 'none' });
    const name = h('span', { class: 'tree-name', title: item.name }, item.name);

    if (item.type === 'dir') {
      const children = h('ul', { role: 'group', hidden: true });
      const row = h('button', {
        class: 'tree-row', type: 'button', role: 'treeitem',
        'aria-expanded': 'false', 'data-path': item.path, style: `--depth:${depth}`,
      }, icon('chevron', 'tree-chevron'), icon('folder', 'folder-icon'), name);

      let loaded = false;
      row.addEventListener('click', async () => {
        const isOpen = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', String(!isOpen));
        children.hidden = isOpen;

        if (!isOpen && !loaded) {
          loaded = await populateDirectory(item.path, children, depth + 1);
        }
      });

      li.append(row, children);
    } else {
      const row = h('button', {
        class: 'tree-row', type: 'button', role: 'treeitem',
        'data-path': item.path, style: `--depth:${depth}`,
        onclick: () => openFile(item.path),
      }, h('span', { class: 'tree-spacer' }), icon('file', 'file-icon'), name);
      li.append(row);
    }
    return li;
  }

  function markSelected(path) {
    const { treeEl } = state.ui;
    treeEl.querySelectorAll('.tree-row.is-selected').forEach((row) => {
      row.classList.remove('is-selected');
      row.removeAttribute('aria-current');
    });
    const row = treeEl.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) {
      row.classList.add('is-selected');
      row.setAttribute('aria-current', 'true');
    }
  }

  // ----- Code viewer -----

  function viewerHeader(path, extraMeta = [], copyButton = null) {
    const name = path.split('/').pop();
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

    const meta = h('div', { class: 'viewer-meta' });
    if (dir) meta.append(h('span', { class: 'path', title: path }, dir + '/'));
    extraMeta.forEach((text, index) => {
      if (index > 0 || dir) meta.append(h('span', { class: 'dot', 'aria-hidden': 'true' }, '•'));
      meta.append(h('span', {}, text));
    });

    return h('div', { class: 'viewer-head' },
      h('div', { class: 'viewer-file' },
        h('span', { class: 'viewer-file-icon' }, icon('file-code')),
        h('div', { class: 'viewer-file-text' },
          h('span', { class: 'viewer-name', title: name }, name),
          meta
        )
      ),
      copyButton
    );
  }

  function setViewer(...nodes) {
    // replaceChildren() would render a literal "null", so drop empty slots
    state.ui.viewer.replaceChildren(...nodes.filter(Boolean));
  }

  function renderViewerEmpty() {
    setViewer(
      h('div', { class: 'panel-head' }, h('span', { class: 'panel-title' }, 'File viewer')),
      h('div', { class: 'viewer-empty' }, stateBlock({
        iconName: 'file-code',
        title: 'Select a file to preview',
        text: 'Choose a file from the explorer to view its contents here.',
      }))
    );
  }

  function renderViewerLoading(path) {
    const widths = [48, 72, 36, 64, 80, 42, 58, 70, 30, 66];
    setViewer(
      viewerHeader(path, ['Loading file…']),
      h('div', { class: 'code-loading', 'aria-busy': 'true', 'aria-label': 'Loading file content' },
        ...widths.map((w) => skeleton(`${w}%`, 11))
      )
    );
  }

  function renderViewerError(path, err) {
    setViewer(
      viewerHeader(path),
      h('div', { class: 'viewer-empty' }, stateBlock({
        ...describeError(err, 'file'),
        action: err.code === 'binary' || err.code === 'too_large' ? null
          : { label: 'Try again', onClick: () => openFile(path) },
      }))
    );
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers/contexts without the async clipboard API
      const area = h('textarea', { style: 'position:fixed;opacity:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  function renderViewerFile(file) {
    const text = file.content.replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline

    // Copy button with brief confirmation
    const label = h('span', {}, 'Copy');
    const copyButton = h('button', { class: 'btn btn-secondary', type: 'button', 'aria-label': 'Copy file contents' },
      icon('copy'), label);
    let resetTimer;
    copyButton.addEventListener('click', async () => {
      await copyText(file.content);
      copyButton.classList.add('is-done');
      copyButton.replaceChildren(icon('check'), h('span', {}, 'Copied'));
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyButton.classList.remove('is-done');
        copyButton.replaceChildren(icon('copy'), h('span', {}, 'Copy'));
      }, 1800);
    });

    const meta = [formatBytes(file.size), `${lines.length.toLocaleString('en-US')} ${lines.length === 1 ? 'line' : 'lines'}`];
    const header = viewerHeader(file.path, meta, copyButton);

    if (!lines.length) {
      setViewer(header, h('div', { class: 'viewer-empty' }, stateBlock({
        iconName: 'file', title: 'This file is empty', text: 'There is nothing to display for this file.',
      })));
      return;
    }

    const visible = lines.slice(0, MAX_RENDERED_LINES);
    const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' },
      visible.map((_, i) => i + 1).join('\n'));
    const code = h('pre', { class: 'code-body' }, h('code', {}, visible.join('\n')));

    const area = h('div', {
      class: 'code-area', tabindex: '0', role: 'region', 'aria-label': `Contents of ${file.name}`,
    }, gutter, code);

    const note = lines.length > MAX_RENDERED_LINES
      ? h('div', { class: 'code-note' },
          `Showing the first ${MAX_RENDERED_LINES.toLocaleString('en-US')} of ${lines.length.toLocaleString('en-US')} lines. Copy still includes the full file.`)
      : null;

    setViewer(header, area, note);
  }

  async function openFile(path) {
    const loadId = state.loadId;
    const fileLoadId = ++state.fileLoadId;
    const isStale = () => loadId !== state.loadId || fileLoadId !== state.fileLoadId;

    markSelected(path);
    renderViewerLoading(path);

    try {
      const file = await api('file', { owner: state.owner, repo: state.repo, path });
      if (!isStale()) renderViewerFile(file);
    } catch (err) {
      if (!isStale()) renderViewerError(path, err);
    }
  }

  // ---------- Explore flow ----------

  function updateUrl(owner, repo, mode) {
    const url = `?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`;
    history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
  }

  async function explore(owner, repo, { history: historyMode = 'push' } = {}) {
    const loadId = ++state.loadId;
    state.fileLoadId++;
    state.owner = owner;
    state.repo = repo;
    state.dirCache.clear();
    state.ui = null;

    setBusy(true);
    setCompactSearch(false);
    setResults(loadingView());

    // 1) Repository overview  (MCP tool: get_repository)
    let repoData;
    try {
      repoData = await api('repository', { owner, repo });
    } catch (err) {
      if (loadId !== state.loadId) return;
      setBusy(false);
      setResults(h('div', { class: 'card' }, stateBlock({
        ...describeError(err, 'repository'),
        action: err.code === 'invalid' ? null : { label: 'Try again', onClick: () => explore(owner, repo, { history: 'replace' }) },
      })));
      refreshStatus();
      return;
    }
    if (loadId !== state.loadId) return;

    // Use GitHub's canonical casing from here on
    state.owner = repoData.owner;
    state.repo = repoData.name;
    els.owner.value = repoData.owner;
    els.repo.value = repoData.name;
    updateUrl(repoData.owner, repoData.name, historyMode);
    document.title = `${repoData.full_name} · GitHub Repository Explorer`;

    const workspace = workspaceView(repoData);
    setResults(overviewCard(repoData), workspace);
    setCompactSearch(true);
    setBusy(false);
    refreshStatus();

    // 2) Root file listing  (MCP tool: list_files)
    const ok = await populateDirectory('', state.ui.treeEl, 0);
    if (!ok || loadId !== state.loadId) return;

    // 3) Open the README by default so the viewer isn't empty
    const readme = state.dirCache.get('').find((item) => item.type === 'file' && README_PATTERN.test(item.name));
    if (readme) openFile(readme.path);
  }

  function showEmpty() {
    state.loadId++;
    document.title = 'GitHub Repository Explorer';
    setBusy(false);
    setCompactSearch(false);
    setResults(emptyView());
  }

  // ---------- Form handling ----------

  /** Accepts "owner" + "repo", a pasted "owner/repo", or a full GitHub URL. */
  function readInputs() {
    let owner = els.owner.value.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    let repo = els.repo.value.trim();

    if (owner.includes('/')) {
      const [first, second] = owner.split('/');
      owner = first;
      if (!repo) repo = second;
    }
    repo = repo.replace(/\.git$/i, '');

    els.owner.value = owner;
    els.repo.value = repo;
    return { owner, repo };
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const { owner, repo } = readInputs();

    // Native "required" bubble on the first empty field
    const empty = !owner ? els.owner : !repo ? els.repo : null;
    if (empty) { empty.focus(); empty.reportValidity(); return; }

    explore(owner, repo);
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.owner.value = chip.dataset.owner;
      els.repo.value = chip.dataset.repo;
      explore(chip.dataset.owner, chip.dataset.repo);
    });
  });

  // Browser back/forward
  window.addEventListener('popstate', () => loadFromUrl('replace'));

  function loadFromUrl(historyMode) {
    const params = new URLSearchParams(window.location.search);
    const owner = (params.get('owner') || '').trim();
    const repo = (params.get('repo') || '').trim();

    if (owner && repo) {
      els.owner.value = owner;
      els.repo.value = repo;
      explore(owner, repo, { history: historyMode });
    } else {
      els.owner.value = '';
      els.repo.value = '';
      showEmpty();
    }
  }

  // ---------- Boot ----------

  refreshStatus();
  setInterval(refreshStatus, 30000);
  loadFromUrl('replace');
})();
