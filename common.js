/* eslint-disable no-unused-vars -- shared registry consumed by background.js and popup.js */
// Shared metric registry, used by both the service worker (background.js, via
// importScripts) and the popup (popup.js, via <script>). Keep this file free
// of fetch logic — it is metadata + formatting only.

const ORDER = ['btc', 'btcprice', 'eth', 'gold', 'silver', 'xmr'];

const METRICS = {
  btc: {
    name: 'Bitcoin fee',
    unit: 'sat/vB',
    color: '#F7931A',
    textColor: '#000000',
    icon: { 16: 'icons/btc16.png', 48: 'icons/btc48.png', 128: 'icons/btc128.png' },
    ttlMinutes: 30,
    display: value => `${round(value, 2)} sat/vB`,
  },
  btcprice: {
    name: 'Bitcoin price',
    unit: 'USD',
    // Same Bitcoin icon/orange as the fee, but white text distinguishes it.
    color: '#F7931A',
    textColor: '#FFFFFF',
    icon: { 16: 'icons/btc16.png', 48: 'icons/btc48.png', 128: 'icons/btc128.png' },
    ttlMinutes: 30,
    display: value => displayPrice(value),
  },
  eth: {
    name: 'Ethereum gas',
    unit: 'gwei',
    color: '#454A75',
    textColor: '#FFFFFF',
    icon: { 16: 'icons/eth16.png', 48: 'icons/eth48.png', 128: 'icons/eth128.png' },
    ttlMinutes: 5,
    display: value => `${round(value, 2)} gwei`,
  },
  gold: {
    name: 'Gold (XAU)',
    unit: 'USD/oz',
    color: '#B8860B',
    textColor: '#000000',
    icon: { 16: 'icons/gold16.png', 48: 'icons/gold48.png', 128: 'icons/gold128.png' },
    ttlMinutes: 30,
    display: value => displayPrice(value, '/oz'),
  },
  silver: {
    name: 'Silver (XAG)',
    unit: 'USD/oz',
    color: '#B8BCC2',
    textColor: '#000000',
    icon: { 16: 'icons/silver16.png', 48: 'icons/silver48.png', 128: 'icons/silver128.png' },
    ttlMinutes: 30,
    display: value => displayPrice(value, '/oz'),
  },
  xmr: {
    name: 'Monero (XMR)',
    unit: 'USD',
    color: '#F26822',
    textColor: '#000000',
    icon: { 16: 'icons/xmr16.png', 48: 'icons/xmr48.png', 128: 'icons/xmr128.png' },
    ttlMinutes: 30,
    display: value => displayPrice(value),
  },
};

// chrome.storage.local key holding one metric's state: { value, updated, error? }
function stateKey(metricId) {
  return `metric:${metricId}`;
}

// Round to a fixed number of decimals, dropping trailing zeros (3.104 → 3.1).
function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function displayPrice(value, suffix = '') {
  return `$${round(value, 2).toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
}

// Compact badge text, at most 4 characters (badge readability limit).
function badgeText(value) {
  const number = Number(value);
  let text;
  if (number < 10) {
    text = number.toFixed(2);
  } else if (number < 100) {
    text = number.toFixed(1);
  } else if (number < 10_000) {
    text = number.toFixed(0);
  } else if (number < 1_000_000) {
    text = `${Math.round(number / 1000)}k`;
  } else {
    text = `${Math.round(number / 1_000_000)}M`;
  }
  return text.slice(0, 4);
}
