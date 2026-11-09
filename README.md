# Market Ticker Chrome Extension

A single Chrome extension that shows **Bitcoin fees and price, Ethereum gas, gold,
silver and Monero prices** on **one toolbar badge**. Chrome allows only one badge
per extension (one `chrome.action`), so instead of installing six separate
extensions, the badge rotates through all metrics and a popup dashboard shows
everything at a glance.

Merged from `BTC-extension`, `ETH-extension`, `Gold-extension`,
`Silver-extension` and `XMR-extension` (plus the Bitcoin price, which replaces a
standalone BTC price extension).

## Features

- **Rotating badge** — cycles through all six metrics every 5 seconds; the
  toolbar icon and badge color change to match the metric on display
- **Pin a metric** — keep one value permanently on the badge (stops the rotation
  interval and keep-alive, letting the service worker sleep)
- **Popup dashboard** — click the icon for all values, per-metric refresh, and
  pin/unpin controls; a "Next" button advances the rotation manually
- **Per-metric TTL caching** — values are cached in `chrome.storage.local`
  (5 min for ETH gas, 30 min for the rest) to minimize API calls
- **Retry on failure** — failed fetches are retried via a one-shot alarm 1 minute
  later; the last good value stays on the badge (flagged in the tooltip)
- **Re-initialization** — `chrome.runtime.onStartup` + `chrome.idle.onStateChanged`
  refresh everything after browser restart or wake from sleep

## Why one badge?

Chrome's API gives each extension exactly one `chrome.action` (one icon + one
badge text overlay). Multiple simultaneous badges from a single extension are not
possible. Rotation + popup is the standard workaround. Note that a popup reserves
the icon's left-click, so `chrome.action.onClicked` never fires — manual advancing
happens via the popup's "Next" button instead.

## Metrics & APIs

| Metric | API | Refresh |
|--------|-----|---------|
| Bitcoin fee (6-block, sat/vB) | `https://blockstream.info/api/fee-estimates` | 30 min |
| Bitcoin price (USD) | `https://api.gold-api.com/price/BTC` | 30 min |
| Ethereum gas (safe, Gwei) | `eth_feeHistory` via publicnode / llamarpc / ankr RPCs | 5 min |
| Gold (XAU) | `https://api.gold-api.com/price/XAU` | 30 min |
| Silver (XAG) | `https://api.gold-api.com/price/XAG` | 30 min |
| Monero (XMR) | `https://api.coingecko.com/api/v3/simple/price?ids=monero` | 30 min |

## Architecture

No bundler — files loaded directly by Chrome. No ES module imports.

```
manifest.json          <- MV3 manifest (minimum Chrome 120: sub-minute alarms)
common.js              <- shared metric registry (order, colors, icons, formatters)
background.js          <- service worker: fetchers, TTL cache, rotation, alarms
popup.html / popup.js  <- dashboard popup
icons/                 <- per-metric icons (btc/eth/gold/silver/xmr × 16/48/128)
                          + mosaic default icon (icon16/48/128.png)
```

- `background.js` pulls the registry in via `importScripts('common.js')`;
  `popup.html` loads it with a plain `<script>` tag.

## Storage schema (`chrome.storage.local`)

| Key | Contents |
|-----|----------|
| `metric:<id>` | `{ value: number, updated: epochMs, error?: string }` — one key per metric, namespaced to avoid collisions |
| `pinned` | `''` (rotate) or a metric id (`btc`, `btcprice`, `eth`, `gold`, `silver`, `xmr`) |
| `rotationIndex` | index into `ORDER` for the currently displayed metric |

## Rotation mechanics

The 5-second rotation runs on a `setInterval` inside the service worker. Because
MV3 workers idle out after ~30 s, a second interval touches
`chrome.runtime.getPlatformInfo()` every 20 s, which resets the idle timer and
keeps the worker alive (Chrome 110+ behavior). Pinning a metric stops both
intervals and clears the rotation alarm, so the worker can actually sleep.

## Alarms

- `rotate-badge` — every 30 s (the alarm floor); **fallback only** — it skips
  advancing if the in-worker interval rotated less than 15 s ago
- `refresh-<id>` — one per metric, period equals its TTL
- `retry-<id>` — one-shot, 1 min after a failed fetch

Alarms are only created when missing (checked on every service-worker start);
re-creating them unconditionally on every wake would reset their schedules and
the refresh alarms would never fire.

## Installation

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. "Load unpacked" and select this directory

## Commands

- `npm run lint` — ESLint (config from `../release/config/`)
- `npm run pack` — build `.zip` + `.crx` into `dist/`
- `npm run publish` — tag + GitHub release (see root `AGENTS.md`)

## Permissions

- **storage** — cache metric values and preferences
- **alarms** — rotation + refresh scheduling
- **idle** — refresh after the system wakes from sleep
- **host permissions** — the five API/RPC hosts listed above
