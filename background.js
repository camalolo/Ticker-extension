/* global importScripts, ORDER, METRICS, stateKey, badgeText */
// Market Ticker — one toolbar badge rotating through market metrics.
// Merged from BTC-extension, ETH-extension, Gold-extension, Silver-extension
// and XMR-extension (Chrome allows only one badge per extension).

importScripts('common.js');

const ROTATION_ALARM = 'rotate-badge';
const ROTATION_PERIOD_MINUTES = 0.5; // alarm floor is 30 s — fallback only
const RETRY_DELAY_MINUTES = 1;
const FETCH_TIMEOUT_MS = 20_000;
const ROTATION_INTERVAL_MS = 5000; // badge switches metric every 5 s
const KEEP_ALIVE_INTERVAL_MS = 20_000; // stays under the SW's 30 s idle timer
const ALARM_FALLBACK_MIN_GAP_MS = 15_000;

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchJsonWithRetry(url, options = {}, maxRetries = 6, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // AbortSignal.timeout: a hanging API must become a retryable failure.
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, baseDelay * 2 ** (attempt - 1)));
    }
  }
}

async function fetchBitcoinFee() {
  const data = await fetchJsonWithRetry('https://blockstream.info/api/fee-estimates');
  const fee = data['6']; // 6-block (~1 hour) confirmation, sat/vB
  if (!fee) throw new Error('no 6-block estimate in response');
  return fee;
}

// Public Ethereum RPC endpoints, tried in order for redundancy.
const ETH_RPC_ENDPOINTS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
];

// Safe (slow-confirmation) gas price in Gwei via eth_feeHistory.
async function fetchEthGas() {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_feeHistory',
    params: [4, 'latest', [25]],
    id: 1,
  });

  for (const url of ETH_RPC_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const data = await response.json();
      const fees = data.result?.baseFeePerGas;
      const rewards = data.result?.reward;
      if (!fees?.length || !rewards?.length) continue;

      // Next block's base fee (last element) + average 25th-percentile tip
      const baseFee = Number.parseInt(fees.at(-1), 16);
      const tipSum = rewards
        .map(reward => Number.parseInt(reward[0], 16))
        .reduce((sum, tip) => sum + tip, 0);
      const averageTip = tipSum / rewards.length;

      const gasGwei = (baseFee + averageTip) / 1e9;
      if (gasGwei > 0) return gasGwei;
    } catch (error) {
      console.warn(`RPC ${url} failed:`, error.message);
    }
  }
  throw new Error('all Ethereum RPC endpoints failed');
}

async function fetchGoldApiPrice(symbol) {
  const data = await fetchJsonWithRetry(`https://api.gold-api.com/price/${symbol}`);
  if (!data.price) throw new Error('no price in response');
  return data.price;
}

async function fetchMoneroPrice() {
  const data = await fetchJsonWithRetry('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
  const price = data.monero?.usd;
  if (!price) throw new Error('no monero price in response');
  return price;
}

const FETCHERS = {
  btc: fetchBitcoinFee,
  btcprice: () => fetchGoldApiPrice('BTC'),
  eth: fetchEthGas,
  gold: () => fetchGoldApiPrice('XAU'),
  silver: () => fetchGoldApiPrice('XAG'),
  xmr: fetchMoneroPrice,
};

// ---------------------------------------------------------------------------
// State helpers (chrome.storage.local)
// ---------------------------------------------------------------------------

async function getMetricState(metricId) {
  const key = stateKey(metricId);
  const result = await chrome.storage.local.get(key);
  return result[key]; // eslint-disable-line security/detect-object-injection
}

async function getPreferences() {
  const { pinned = '', rotationIndex = 0 } = await chrome.storage.local.get(['pinned', 'rotationIndex']);
  return {
    pinned,
    rotationIndex: Number.isInteger(rotationIndex) ? rotationIndex : 0,
  };
}

// Which metric the badge is currently showing.
async function activeMetricId() {
  const { pinned, rotationIndex } = await getPreferences();
  if (pinned && Object.hasOwn(METRICS, pinned)) {
    return pinned;
  }
  return ORDER[Math.abs(rotationIndex) % ORDER.length];
}

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

async function paintBadge(text, color, textColor, icon, title) {
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeTextColor({ color: textColor }),
    chrome.action.setIcon({ path: icon }),
    chrome.action.setTitle({ title }),
  ]);
}

async function renderBadge() {
  const metricId = await activeMetricId();
  const metric = METRICS[metricId]; // eslint-disable-line security/detect-object-injection
  const state = await getMetricState(metricId);

  if (!state || state.value === undefined) {
    const title = state?.error
      ? `${metric.name}: unavailable (${state.error})`
      : `${metric.name}: loading…`;
    const color = state?.error ? '#D32F2F' : '#444444';
    await paintBadge(state?.error ? 'Err' : '…', color, '#FFFFFF', metric.icon, title);
    return;
  }

  const ageMinutes = Math.round((Date.now() - state.updated) / 60_000);
  const ageText = ageMinutes < 1 ? 'just now' : `${ageMinutes} min ago`;
  const failureNote = state.error ? ` · refresh failed, retrying (${state.error})` : '';
  await paintBadge(
    badgeText(state.value),
    metric.color,
    metric.textColor,
    metric.icon,
    `${metric.name}: ${metric.display(state.value)} · updated ${ageText}${failureNote}`,
  );
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

let lastRotationAt = 0;

async function advanceRotation() {
  const { pinned, rotationIndex } = await getPreferences();
  if (pinned && Object.hasOwn(METRICS, pinned)) {
    await renderBadge(); // pinned — nothing to advance
    return;
  }
  lastRotationAt = Date.now();
  await chrome.storage.local.set({ rotationIndex: Math.abs(rotationIndex + 1) % ORDER.length });
  await renderBadge();
}

// chrome.alarms cannot fire more often than every 30 s, so the fast rotation
// runs on a setInterval inside the service worker, kept alive by touching an
// extension API every 20 s (resets the worker's 30 s idle timer, Chrome 110+).
// The periodic alarm stays as a fallback for the rare case the worker IS
// suspended — the gap check in the alarm handler prevents double-advancing.

let rotationTimer;
let keepAliveTimer;

function startRotation() {
  if (rotationTimer) return;
  rotationTimer = setInterval(() => { advanceRotation(); }, ROTATION_INTERVAL_MS);
  keepAliveTimer = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, KEEP_ALIVE_INTERVAL_MS);
}

function stopRotation() {
  clearInterval(rotationTimer);
  clearInterval(keepAliveTimer);
  rotationTimer = undefined;
  keepAliveTimer = undefined;
}

async function syncRotationRunner() {
  const { pinned } = await getPreferences();
  if (pinned && Object.hasOwn(METRICS, pinned)) {
    stopRotation(); // pinned: no rotation, no keep-alive — let the worker sleep
  } else {
    startRotation();
  }
}

async function setPinned(metricId) {
  if (metricId && !Object.hasOwn(METRICS, metricId)) {
    throw new Error(`unknown metric: ${metricId}`);
  }
  await chrome.storage.local.set({ pinned: metricId || '' });
  // Pinned: no need to wake the worker every 30 seconds, so drop the alarm.
  await (metricId ? chrome.alarms.clear(ROTATION_ALARM) : ensureRotationAlarm());
  await syncRotationRunner();
  await renderBadge();
}

// ---------------------------------------------------------------------------
// Refreshing
// ---------------------------------------------------------------------------

async function refreshMetric(metricId, force = false) {
  const metric = METRICS[metricId]; // eslint-disable-line security/detect-object-injection
  if (!Object.hasOwn(FETCHERS, metricId) || !metric) return;

  const key = stateKey(metricId);
  const previous = await getMetricState(metricId);
  const now = Date.now();

  const isFresh = previous?.updated && now - previous.updated < metric.ttlMinutes * 60 * 1000;
  if (!force && isFresh && !previous.error) return;

  try {
    const value = await FETCHERS[metricId](); // eslint-disable-line security/detect-object-injection
    if (value === undefined || Number.isNaN(Number(value))) throw new Error('invalid API response');
    await chrome.storage.local.set({ [key]: { value: Number(value), updated: now } });
  } catch (error) {
    console.warn(`[${metricId}] fetch failed:`, error.message);
    await chrome.storage.local.set({
      [key]: {
        value: previous?.value,
        updated: previous?.updated ?? 0,
        error: String(error.message ?? error),
      },
    });
    chrome.alarms.create(`retry-${metricId}`, { delayInMinutes: RETRY_DELAY_MINUTES });
  }

  await renderBadge();
}

async function refreshAll(force = false) {
  await Promise.all(ORDER.map(metricId => refreshMetric(metricId, force)));
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
// Alarms persist across service worker restarts, so only create the ones that
// are missing — re-creating on every wake would reset their schedules forever.

async function ensureRotationAlarm(existingAlarms) {
  const { pinned } = await getPreferences();
  if (pinned && Object.hasOwn(METRICS, pinned)) return;
  const alarms = existingAlarms ?? await chrome.alarms.getAll();
  const exists = alarms.some(alarm => alarm.name === ROTATION_ALARM);
  if (!exists) {
    chrome.alarms.create(ROTATION_ALARM, { periodInMinutes: ROTATION_PERIOD_MINUTES });
  }
}

async function ensureAlarms() {
  const alarms = await chrome.alarms.getAll();
  await ensureRotationAlarm(alarms);
  const existing = new Set(alarms.map(alarm => alarm.name));
  for (const metricId of ORDER) {
    const name = `refresh-${metricId}`;
    if (!existing.has(name)) {
      chrome.alarms.create(name, { periodInMinutes: METRICS[metricId].ttlMinutes }); // eslint-disable-line security/detect-object-injection
    }
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ROTATION_ALARM) {
    // Fallback path — only rotate if the in-SW interval hasn't run recently.
    if (Date.now() - lastRotationAt > ALARM_FALLBACK_MIN_GAP_MS) advanceRotation();
  } else if (alarm.name.startsWith('refresh-')) {
    refreshMetric(alarm.name.slice('refresh-'.length));
  } else if (alarm.name.startsWith('retry-')) {
    refreshMetric(alarm.name.slice('retry-'.length), true);
  }
});

// ---------------------------------------------------------------------------
// Popup messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'advance': {
          await advanceRotation();
          break;
        }
        case 'refreshAll': {
          refreshAll(true); // async — popup updates live via storage.onChanged
          break;
        }
        case 'refreshOne': {
          refreshMetric(message.id, true);
          break;
        }
        case 'pin': {
          await setPinned(message.id);
          break;
        }
        case 'unpin': {
          await setPinned('');
          break;
        }
        default: {
          throw new Error(`unknown message type: ${message?.type}`);
        }
      }
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error.message ?? error) });
    }
  })();
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  refreshAll();
  renderBadge();
});

chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') {
    ensureAlarms();
    refreshAll();
    renderBadge();
  }
});

async function init() {
  try {
    await ensureAlarms();
    await refreshAll();
    await renderBadge();
    await syncRotationRunner();
  } catch (error) {
    // A fire-and-forget init must never die silently.
    console.error('init failed:', error);
  }
}

// Top level — runs on every service worker start. Classic service workers
// cannot use top-level await, hence fire-and-forget.
init(); // eslint-disable-line unicorn/prefer-top-level-await
