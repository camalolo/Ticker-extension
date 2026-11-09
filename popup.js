/* global ORDER, METRICS, stateKey */
// Popup dashboard for Market Ticker. Reads state directly from
// chrome.storage and sends action messages to the service worker.

const valueElement = document.querySelector('#curValue');
const metaElement = document.querySelector('#curMeta');
const nameElement = document.querySelector('#curName');
const iconElement = document.querySelector('#curIcon');
const modeElement = document.querySelector('#mode');
const nextButton = document.querySelector('#nextBtn');
const rowsElement = document.querySelector('#rows');

let storageState = {};

async function loadStorageState() {
  // NB: storage.get([]) returns an EMPTY object — fetch the known keys explicitly.
  storageState = await chrome.storage.local.get([...ORDER.map(id => stateKey(id)), 'pinned', 'rotationIndex']);
}

function metricState(metricId) {
  const key = stateKey(metricId);
  return storageState[key]; // eslint-disable-line security/detect-object-injection
}

function activeMetricId() {
  const { pinned = '', rotationIndex = 0 } = storageState;
  if (pinned && Object.hasOwn(METRICS, pinned)) {
    return pinned;
  }
  const index = Number.isInteger(rotationIndex) ? rotationIndex : 0;
  return ORDER[Math.abs(index) % ORDER.length];
}

function ago(timestamp) {
  if (!timestamp) return 'never';
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Metrics with a manual refresh in flight — shown per-row while waiting, so
// each metric visibly loads independently of the others.
const refreshing = new Set();
const REFRESH_FEEDBACK_MS = 45_000; // safety clear if no storage write arrives

function startRefresh(metricId) {
  refreshing.add(metricId);
  render();
  send({ type: 'refreshOne', id: metricId });
  setTimeout(() => {
    if (refreshing.delete(metricId)) render();
  }, REFRESH_FEEDBACK_MS);
}

function startRefreshAll() {
  for (const metricId of ORDER) refreshing.add(metricId);
  render();
  send({ type: 'refreshAll' });
  setTimeout(() => {
    if (refreshing.size > 0) {
      refreshing.clear();
      render();
    }
  }, REFRESH_FEEDBACK_MS);
}

function renderValue(element, metric, state) {
  if (state && state.value !== undefined) {
    element.textContent = metric.display(state.value);
    element.classList.toggle('err', Boolean(state.error));
  } else {
    element.textContent = '…';
    element.classList.toggle('err', Boolean(state?.error));
  }
}

function renderRows(activeId, pinned) {
  rowsElement.textContent = '';
  for (const metricId of ORDER) {
    const metric = METRICS[metricId]; // eslint-disable-line security/detect-object-injection
    const itemState = metricState(metricId);

    const row = document.createElement('li');
    row.style.borderLeftColor = metric.color;
    if (metricId === activeId) row.classList.add('active');

    const icon = document.createElement('img');
    icon.src = metric.icon[16];
    icon.alt = '';
    row.append(icon);

    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = metric.name;
    row.append(name);

    const value = document.createElement('span');
    value.className = 'm-value';
    if (refreshing.has(metricId)) {
      value.textContent = '⟳';
      value.classList.add('refreshing');
    } else {
      renderValue(value, metric, itemState);
    }
    row.append(value);

    const age = document.createElement('span');
    age.className = 'm-age';
    age.textContent = itemState ? ago(itemState.updated) : 'never';
    row.append(age);

    const refreshButton = document.createElement('button');
    refreshButton.textContent = '↻';
    refreshButton.title = `Refresh ${metric.name} now`;
    refreshButton.addEventListener('click', () => startRefresh(metricId));
    row.append(refreshButton);

    const isPinned = metricId === pinned;
    const pinButton = document.createElement('button');
    pinButton.textContent = isPinned ? 'Unpin' : 'Pin';
    pinButton.title = isPinned ? 'Resume badge rotation' : `Keep ${metric.name} on the badge`;
    pinButton.addEventListener('click', () => send({ type: isPinned ? 'unpin' : 'pin', id: metricId }));
    row.append(pinButton);

    rowsElement.append(row);
  }
}

function render() {
  const activeId = activeMetricId();
  const activeMetric = METRICS[activeId]; // eslint-disable-line security/detect-object-injection
  const activeState = metricState(activeId);
  const pinned = storageState.pinned || '';

  iconElement.src = activeMetric.icon[16];
  nameElement.textContent = activeMetric.name;
  renderValue(valueElement, activeMetric, activeState);
  if (refreshing.has(activeId)) {
    metaElement.textContent = 'refreshing…';
  } else {
    metaElement.textContent = activeState?.error
      ? `refresh failed, retrying (${activeState.error})`
      : `updated ${ago(activeState?.updated)}`;
  }

  nextButton.disabled = Boolean(pinned);
  modeElement.textContent = pinned
    ? `badge pinned to ${METRICS[pinned].name}` // eslint-disable-line security/detect-object-injection
    : 'badge rotates every 5 s';

  renderRows(activeId, pinned);
}

nextButton.addEventListener('click', () => send({ type: 'advance' }));
document.querySelector('#refreshAllBtn').addEventListener('click', () => startRefreshAll());

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    // Each metric's write clears its own spinner — independent per-metric updates.
    for (const key of Object.keys(changes)) {
      const match = key.match(/^metric:(.+)$/);
      if (match) refreshing.delete(match[1]);
    }
  }
  await loadStorageState();
  render();
});

// Classic popup page — no top-level await.
init(); // eslint-disable-line unicorn/prefer-top-level-await
setInterval(render, 15_000); // keep "updated X ago" labels fresh

async function init() {
  await loadStorageState();
  render();
}
