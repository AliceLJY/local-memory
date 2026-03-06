const queryInput = document.getElementById('queryInput');
const profileInput = document.getElementById('profileInput');
const scopeInput = document.getElementById('scopeInput');
const limitInput = document.getElementById('limitInput');
const formatInput = document.getElementById('formatInput');
const resultOutput = document.getElementById('resultOutput');
const resultMeta = document.getElementById('resultMeta');
const resultTitle = document.getElementById('resultTitle');
const artifactBar = document.getElementById('artifactBar');
const resultCards = document.getElementById('resultCards');
const viewToolbar = document.getElementById('viewToolbar');
const viewFilterInput = document.getElementById('viewFilterInput');
const statusLine = document.getElementById('statusLine');
const pinMemoryId = document.getElementById('pinMemoryId');
const pinTitle = document.getElementById('pinTitle');
const pinsOutput = document.getElementById('pinsOutput');
const statsOutput = document.getElementById('statsOutput');
const toggleStatsButton = document.getElementById('toggleStatsButton');
const togglePinsButton = document.getElementById('togglePinsButton');
const toggleTraceButton = document.getElementById('toggleTraceButton');
const viewTabs = Array.from(document.querySelectorAll('.view-tab'));

let currentView = 'search';
let lastItems = [];
let lastMode = 'search';
let lastArtifact = null;
let fullStatsText = 'Loading stats...';
let fullPinsText = 'Loading pins...';
let statsExpanded = false;
let pinsExpanded = false;
let traceExpanded = false;
let lastPins = [];
let lastExports = [];
let currentViewFilter = '';

async function api(path, payload) {
  const response = await fetch(path, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.output || `Request failed: ${response.status}`);
  }
  return data;
}

function currentPayload() {
  return {
    query: queryInput.value.trim(),
    profile: profileInput.value,
    scope: scopeInput.value.trim() || undefined,
    limit: Number(limitInput.value) || 5,
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collapsedBlockText(text, maxLines) {
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n\n... (${lines.length - maxLines} more lines)`;
}

function renderStats() {
  statsOutput.textContent = statsExpanded ? fullStatsText : collapsedBlockText(fullStatsText, 12);
  statsOutput.classList.toggle('is-collapsed', !statsExpanded);
  toggleStatsButton.textContent = statsExpanded ? 'Collapse' : 'Expand';
}

function renderPinsPanel() {
  pinsOutput.textContent = pinsExpanded ? fullPinsText : collapsedBlockText(fullPinsText, 8);
  pinsOutput.classList.toggle('is-collapsed', !pinsExpanded);
  togglePinsButton.textContent = pinsExpanded ? 'Collapse' : 'Expand';
}

function renderTrace() {
  resultOutput.classList.toggle('is-collapsed', !traceExpanded);
  toggleTraceButton.textContent = traceExpanded ? 'Collapse' : 'Expand';
}

function cardSnippet(item) {
  const title = item?.metadata?.title;
  if (item?.source === 'asset' && title) {
    return title;
  }

  const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '-';

  if (item?.source === 'asset') {
    const assetText = text
      .replace(/^\[Pinned Asset\]\s*/i, '')
      .replace(/Original Scope:.*$/i, '')
      .replace(/Snippet:.*$/i, '')
      .trim();
    return assetText || text;
  }

  return text;
}

function renderArtifactBar() {
  if (!lastArtifact) {
    artifactBar.innerHTML = '';
    return;
  }

  artifactBar.innerHTML = `
    <div class="artifact-card">
      <div class="artifact-copy">
        <strong>${escapeHtml(lastArtifact.label)}</strong>
        <span>${escapeHtml(lastArtifact.path)}</span>
      </div>
      <div class="result-card-actions">
        <button class="card-chip" id="copyArtifactPath">Copy Path</button>
        <button class="card-chip" id="openArtifactPath">Open File</button>
      </div>
    </div>
  `;

  document.getElementById('copyArtifactPath').addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastArtifact.path);
    statusLine.textContent = 'Artifact path copied.';
  });

  document.getElementById('openArtifactPath').addEventListener('click', async () => {
    try {
      await api('/api/open-path', { path: lastArtifact.path });
      statusLine.textContent = 'Artifact opened.';
    } catch (error) {
      statusLine.textContent = String(error.message || error);
    }
  });
}

function setActiveView(view) {
  currentView = view;
  viewTabs.forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === view);
  });
  const filterEnabled = view === 'pins' || view === 'exports';
  viewToolbar.classList.toggle('is-hidden', !filterEnabled);
  if (!filterEnabled) {
    currentViewFilter = '';
    viewFilterInput.value = '';
  }
}

function filterPins(items) {
  const needle = currentViewFilter.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    [item.title, item.summary, item.scope, item.type, item.hits, ...(item.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

function filterExports(items) {
  const needle = currentViewFilter.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    [item.query, item.profile, item.summary]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
}

function groupBySource(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.source || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries());
}

function bindResultCardActions() {
  resultCards.querySelectorAll('[data-fill-id]').forEach((button) => {
    button.addEventListener('click', () => {
      pinMemoryId.value = button.dataset.fillId;
      statusLine.textContent = `Loaded ${button.dataset.fillId} into pin panel.`;
    });
  });

  resultCards.querySelectorAll('[data-pin-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      pinMemoryId.value = button.dataset.pinId;
      await pinMemory();
    });
  });

  resultCards.querySelectorAll('[data-toggle-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.result-card');
      card.classList.toggle('is-open');
      button.textContent = card.classList.contains('is-open') ? 'Hide' : 'Details';
    });
  });

  resultCards.querySelectorAll('[data-copy-text]').forEach((button) => {
    button.addEventListener('click', async () => {
      const text = decodeURIComponent(button.dataset.copyText);
      await navigator.clipboard.writeText(text);
      statusLine.textContent = 'Snippet copied to clipboard.';
    });
  });

  resultCards.querySelectorAll('[data-open-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api('/api/open-path', { path: button.dataset.openPath });
        statusLine.textContent = 'File opened.';
      } catch (error) {
        statusLine.textContent = String(error.message || error);
      }
    });
  });

  resultCards.querySelectorAll('[data-copy-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copyPath);
      statusLine.textContent = 'Path copied.';
    });
  });
}

function renderSearchCards(items, mode) {
  if (!items || items.length === 0) {
    resultCards.innerHTML = '<div class="empty-state">No structured results yet. Run a query or broaden the profile.</div>';
    return;
  }

  const groups = groupBySource(items);
  resultCards.innerHTML = groups.map(([source, entries]) => `
    <section class="result-group">
      <div class="result-group-head">
        <strong>${escapeHtml(source)}</strong>
        <span>${entries.length} hit${entries.length > 1 ? 's' : ''}</span>
      </div>
      ${entries.map((item) => `
        <article class="result-card ${item.source === 'asset' ? 'is-asset' : ''}" data-card-id="${escapeHtml(item.shortId)}">
          <div class="result-card-header">
            <div class="result-card-meta">
              <span class="result-id">${escapeHtml(item.shortId)}</span>
              <span class="result-score">${escapeHtml(item.score)}%</span>
              <span>${escapeHtml(item.source)}</span>
              <span>${escapeHtml(item.date)}</span>
            </div>
          </div>
          <p class="result-snippet">${escapeHtml(cardSnippet(item).slice(0, 220))}${cardSnippet(item).length > 220 ? '...' : ''}</p>
          <div class="result-card-meta">
            <span>${escapeHtml(item.scope)}</span>
            <span>${escapeHtml(item.retrievalPath)}</span>
            <span>${escapeHtml(item.file || '-')}</span>
          </div>
          <div class="result-card-actions">
            <button class="card-chip" data-fill-id="${escapeHtml(item.shortId)}">Use ID</button>
            <button class="card-chip" data-pin-id="${escapeHtml(item.shortId)}">Pin</button>
            <button class="card-chip" data-toggle-id="${escapeHtml(item.shortId)}">Details</button>
            ${mode === 'distill' ? '' : `<button class="card-chip" data-copy-text="${encodeURIComponent(item.text)}">Copy Text</button>`}
          </div>
          <div class="result-card-detail">
            <div class="detail-block">
              <strong>Full Text</strong>
              <pre>${escapeHtml(item.text)}</pre>
            </div>
            <div class="detail-block">
              <strong>Metadata</strong>
              <code>${escapeHtml(JSON.stringify(item.metadata || {}, null, 2))}</code>
            </div>
          </div>
        </article>
      `).join('')}
    </section>
  `).join('');

  bindResultCardActions();
}

function formatEvidenceList(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return 'No evidence yet.';
  return evidence.map((item, index) => {
    const parts = [
      `${index + 1}. ${item.source || '-'}`,
      item.date || '-',
      item.retrievalPath || '-',
      item.scope || '-',
      item.snippet || '-',
    ];
    return parts.join(' | ');
  }).join('\n');
}

function formatSourceSummary(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '-';
  return sources.map((item) => `${item.source} (${item.hits})`).join(', ');
}

function assetDetailMarkup(item) {
  if (item.type === 'memory-brief') {
    return `
      <div class="result-card-detail">
        <div class="detail-block">
          <strong>Brief Meta</strong>
          <code>Query: ${escapeHtml(item.query || '-')}
Profile: ${escapeHtml(item.profile || '-')}
Hits: ${escapeHtml(String(item.hits || 0))}
Sources: ${escapeHtml(formatSourceSummary(item.sources || []))}</code>
        </div>
        <div class="detail-block">
          <strong>Takeaways</strong>
          <pre>${escapeHtml((item.takeaways || []).map((line, index) => `${index + 1}. ${line}`).join('\n') || 'No takeaways yet.')}</pre>
        </div>
        <div class="detail-block">
          <strong>Evidence</strong>
          <pre>${escapeHtml(formatEvidenceList(item.evidence || []))}</pre>
        </div>
        <div class="detail-block">
          <strong>Reusable Candidates</strong>
          <pre>${escapeHtml((item.reusableCandidates || []).map((line, index) => `${index + 1}. ${line}`).join('\n') || 'No reusable candidates yet.')}</pre>
        </div>
      </div>
    `;
  }

  return `
    <div class="result-card-detail">
      <div class="detail-block">
        <strong>Pin Meta</strong>
        <code>Source Memory: ${escapeHtml(item.sourceMemoryId || '-')}
Source Scope: ${escapeHtml(item.sourceScope || '-')}
Query: ${escapeHtml(item.retrieval?.query || '-')}
Profile: ${escapeHtml(item.retrieval?.profile || '-')}
Path: ${escapeHtml(item.retrieval?.path || '-')}</code>
      </div>
      <div class="detail-block">
        <strong>Snippet</strong>
        <pre>${escapeHtml(item.snippet || item.summary || '-')}</pre>
      </div>
      <div class="detail-block">
        <strong>Tags</strong>
        <pre>${escapeHtml((item.tags || []).join(', ') || '-')}</pre>
      </div>
    </div>
  `;
}

function renderPinsView(items) {
  if (!items || items.length === 0) {
    resultCards.innerHTML = '<div class="empty-state">No memory assets yet.</div>';
    return;
  }

  resultCards.innerHTML = items.map((item) => `
    <article class="list-card result-card is-asset">
      <div class="list-card-head">
        <strong>${escapeHtml(item.title)}</strong>
      </div>
      <div class="list-card-meta">
        <span>${escapeHtml(item.shortId)}</span>
        <span>${escapeHtml(item.type === 'memory-brief' ? 'brief' : 'pin')}</span>
        <span>${escapeHtml(item.scope)}</span>
        ${item.hits ? `<span>${escapeHtml(String(item.hits))} hits</span>` : ''}
        <span>${escapeHtml(item.date)}</span>
      </div>
      <p class="result-snippet">${escapeHtml(item.summary || '')}</p>
      <div class="result-card-actions">
        <button class="card-chip" data-toggle-id="${escapeHtml(item.shortId)}">Details</button>
        <button class="card-chip" data-copy-path="${escapeHtml(item.path)}">Copy Path</button>
        <button class="card-chip" data-open-path="${escapeHtml(item.path)}">Open File</button>
      </div>
      ${assetDetailMarkup(item)}
    </article>
  `).join('');

  bindResultCardActions();
}

function renderExportsView(items) {
  if (!items || items.length === 0) {
    resultCards.innerHTML = '<div class="empty-state">No exports yet.</div>';
    return;
  }

  resultCards.innerHTML = items.map((item) => `
    <article class="list-card">
      <div class="list-card-head">
        <strong>${escapeHtml(item.query || item.shortId)}</strong>
      </div>
      <div class="list-card-meta">
        <span>${escapeHtml(item.shortId)}</span>
        <span>${escapeHtml(item.profile)}</span>
        <span>${escapeHtml(item.format)}</span>
        <span>${escapeHtml(item.date)}</span>
      </div>
      <p class="result-snippet">${escapeHtml((item.summary || '').slice(0, 260))}${item.summary && item.summary.length > 260 ? '...' : ''}</p>
      <div class="result-card-actions">
        <button class="card-chip" data-copy-path="${escapeHtml(item.path)}">Copy Path</button>
        <button class="card-chip" data-open-path="${escapeHtml(item.path)}">Open File</button>
      </div>
    </article>
  `).join('');

  bindResultCardActions();
}

function renderMainSurface() {
  if (currentView === 'pins') {
    const filtered = filterPins(lastPins);
    resultTitle.textContent = 'Memory Assets';
    resultMeta.textContent = `Assets: ${filtered.length}${currentViewFilter ? ` / ${lastPins.length} total` : ''}`;
    renderPinsView(filtered);
    return;
  }

  if (currentView === 'exports') {
    const filtered = filterExports(lastExports);
    resultTitle.textContent = 'Export Artifacts';
    resultMeta.textContent = `Exports: ${filtered.length}${currentViewFilter ? ` / ${lastExports.length} total` : ''}`;
    renderExportsView(filtered);
    return;
  }

  resultTitle.textContent = 'Result Surface';
  resultMeta.textContent = `Mode: ${lastMode} | Profile: ${profileInput.value} | Query: ${queryInput.value.trim() || '-'} | Hits: ${lastItems.length}`;
  renderSearchCards(lastItems, lastMode);
}

async function runMode(mode) {
  const payload = currentPayload();
  if (!payload.query) {
    statusLine.textContent = 'Enter a query first.';
    return;
  }
  statusLine.textContent = `Running ${mode}...`;
  resultOutput.textContent = 'Loading...';
  setActiveView('search');
  try {
    const data = await api(`/api/${mode}`, payload);
    lastItems = data.items || [];
    lastMode = mode;
    lastArtifact = null;
    resultOutput.textContent = data.output;
    renderArtifactBar();
    renderMainSurface();
    statusLine.textContent = `${mode} completed.`;
  } catch (error) {
    resultOutput.textContent = String(error.message || error);
    lastArtifact = null;
    lastItems = [];
    renderArtifactBar();
    renderMainSurface();
    statusLine.textContent = `${mode} failed.`;
  }
}

async function loadPins() {
  try {
    const data = await api('/api/pins');
    lastPins = data.items || [];
    fullPinsText = data.output;
    renderPinsPanel();
    if (currentView === 'pins') renderMainSurface();
  } catch (error) {
    fullPinsText = String(error.message || error);
    renderPinsPanel();
  }
}

async function loadExports() {
  try {
    const data = await api('/api/exports');
    lastExports = data.items || [];
    if (currentView === 'exports') renderMainSurface();
  } catch (error) {
    statusLine.textContent = String(error.message || error);
  }
}

async function loadStats() {
  try {
    const data = await api('/api/stats');
    fullStatsText = data.output;
    renderStats();
  } catch (error) {
    fullStatsText = String(error.message || error);
    renderStats();
  }
}

async function pinMemory() {
  const memoryId = pinMemoryId.value.trim();
  if (!memoryId) {
    statusLine.textContent = 'Paste a memory ID first.';
    return;
  }
  statusLine.textContent = 'Pinning memory...';
  try {
    const data = await api('/api/pin', {
      memoryId,
      title: pinTitle.value.trim() || undefined,
      query: queryInput.value.trim() || undefined,
      profile: profileInput.value,
    });
    lastArtifact = {
      label: `Pinned Asset ${data.assetId.slice(0, 8)}`,
      path: data.path,
    };
    resultOutput.textContent = data.output;
    renderArtifactBar();
    statusLine.textContent = `Memory pinned: ${data.assetId.slice(0, 8)}.`;
    await loadPins();
    await loadStats();
  } catch (error) {
    resultOutput.textContent = String(error.message || error);
    statusLine.textContent = 'Pin failed.';
  }
}

async function createBrief() {
  const payload = currentPayload();
  if (!payload.query) {
    statusLine.textContent = 'Enter a query first.';
    return;
  }
  statusLine.textContent = 'Creating brief...';
  try {
    const data = await api('/api/brief', {
      ...payload,
      title: pinTitle.value.trim() || undefined,
    });
    lastArtifact = {
      label: `Brief ${data.assetId.slice(0, 8)}`,
      path: data.path,
    };
    resultOutput.textContent = data.output;
    renderArtifactBar();
    await loadPins();
    await loadStats();
    statusLine.textContent = 'Brief created.';
  } catch (error) {
    resultOutput.textContent = String(error.message || error);
    statusLine.textContent = 'Brief failed.';
  }
}

async function exportMemory() {
  const payload = currentPayload();
  if (!payload.query) {
    statusLine.textContent = 'Enter a query first.';
    return;
  }
  statusLine.textContent = 'Exporting...';
  try {
    const data = await api('/api/export', {
      ...payload,
      format: formatInput.value,
    });
    lastArtifact = {
      label: `Export ${data.artifactId.slice(0, 8)} (${data.format})`,
      path: data.path,
    };
    resultOutput.textContent = data.output;
    renderArtifactBar();
    await loadExports();
    statusLine.textContent = `Export completed: ${data.format}.`;
  } catch (error) {
    resultOutput.textContent = String(error.message || error);
    statusLine.textContent = 'Export failed.';
  }
}

viewTabs.forEach((tab) => {
  tab.addEventListener('click', async () => {
    const view = tab.dataset.view;
    setActiveView(view);
    if (view === 'pins') {
      await loadPins();
    }
    if (view === 'exports') {
      await loadExports();
    }
    renderMainSurface();
  });
});

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => runMode(button.dataset.mode));
});

document.getElementById('pinButton').addEventListener('click', pinMemory);
document.getElementById('reloadPinsButton').addEventListener('click', async () => {
  await loadPins();
  await loadExports();
  renderMainSurface();
});
document.getElementById('statsButton').addEventListener('click', loadStats);
document.getElementById('briefButton').addEventListener('click', createBrief);
document.getElementById('exportButton').addEventListener('click', exportMemory);
toggleStatsButton.addEventListener('click', () => {
  statsExpanded = !statsExpanded;
  renderStats();
});
togglePinsButton.addEventListener('click', () => {
  pinsExpanded = !pinsExpanded;
  renderPinsPanel();
});
toggleTraceButton.addEventListener('click', () => {
  traceExpanded = !traceExpanded;
  renderTrace();
});
viewFilterInput.addEventListener('input', () => {
  currentViewFilter = viewFilterInput.value;
  if (currentView === 'pins' || currentView === 'exports') {
    renderMainSurface();
  }
});

queryInput.value = 'telegram bridge';
profileInput.value = 'debug';
setActiveView('search');
renderArtifactBar();
renderStats();
renderPinsPanel();
renderTrace();
renderMainSurface();
loadPins();
loadExports();
loadStats();
runMode('search');
