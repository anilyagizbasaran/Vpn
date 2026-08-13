// The popup renders whatever the service worker reports and never talks to
// the native host itself — one code path to the daemon, one place to change.

const dot = document.getElementById('dot');
const stageEl = document.getElementById('stage');
const detailEl = document.getElementById('detail');
const uptimeEl = document.getElementById('uptime');
const toggle = document.getElementById('toggle');
const errorEl = document.getElementById('error');

const webrtcEl = document.getElementById('webrtc');
const webrtcHint = document.getElementById('webrtc-hint');
const killSwitchEl = document.getElementById('killSwitch');
const autoConnectEl = document.getElementById('autoConnect');
const blockAdsEl = document.getElementById('blockAds');
const blockTrackersEl = document.getElementById('blockTrackers');
const setupForm = document.getElementById('setup');
const serverAddressEl = document.getElementById('serverAddress');
const inviteTokenEl = document.getElementById('inviteToken');
const enrollButton = document.getElementById('enroll');
const allowSiteRow = document.getElementById('allow-site-row');
const allowSiteEl = document.getElementById('allowSite');
const siteNameEl = document.getElementById('site-name');

/** The site in the tab the icon was clicked on, or null when there is none. */
let currentSite = null;

const LABELS = {
  connected: 'Connected',
  connecting: 'Connecting…',
  preparing: 'Preparing…',
  disconnecting: 'Disconnecting…',
  disconnected: 'Not connected',
  failed: 'Connection failed',
};

const WEBRTC_HINTS = {
  safe: 'Hides local addresses; calls still work',
  strict: 'Blocks non-proxied UDP; may break video calls',
  off: 'Pages can see your real adapter address',
};

const BUSY = new Set(['connecting', 'preparing', 'disconnecting']);

/** The setup form and the connect button are alternatives, never both. */
function showSetup(show) {
  setupForm.hidden = !show;
  toggle.hidden = show;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply ?? { ok: false, error: 'No answer from the extension.' });
    });
  });
}

/** "1h 04m" — seconds are noise at this size and cause a redraw every tick. */
function formatDuration(since) {
  const total = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'just now';
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message ?? '';
}

function render(reply, connectedSince) {
  if (!reply.ok) {
    dot.dataset.state = 'failed';
    stageEl.textContent = 'Unavailable';
    detailEl.textContent = reply.missingHost
      ? 'Install the VPN desktop app'
      : 'The VPN service is not reachable';
    toggle.textContent = 'Retry';
    toggle.disabled = false;
    delete toggle.dataset.state;
    toggle.dataset.action = 'status';
    uptimeEl.hidden = true;
    showError(reply.error);
    return;
  }

  const stage = reply.stage ?? 'disconnected';
  const busy = BUSY.has(stage);
  const connected = stage === 'connected';

  dot.dataset.state = connected ? 'connected' : busy ? 'busy' : stage === 'failed' ? 'failed' : 'off';
  stageEl.textContent = LABELS[stage] ?? stage;
  detailEl.textContent = connected
    ? 'Your traffic goes through the VPN'
    : 'Traffic is not protected';

  uptimeEl.hidden = !(connected && connectedSince);
  if (connected && connectedSince) uptimeEl.textContent = formatDuration(connectedSince);

  toggle.textContent = connected ? 'Disconnect' : 'Connect';
  toggle.dataset.action = connected ? 'disconnect' : 'connect';
  toggle.disabled = busy;
  if (connected) {
    toggle.dataset.state = 'connected';
  } else {
    delete toggle.dataset.state;
  }

  showError(null);
}

function renderSettings(settings) {
  webrtcEl.value = settings.webrtc;
  webrtcHint.textContent = WEBRTC_HINTS[settings.webrtc] ?? '';
  killSwitchEl.checked = settings.killSwitch;
  autoConnectEl.checked = settings.autoConnect;
  blockAdsEl.checked = settings.blockAds;
  blockTrackersEl.checked = settings.blockTrackers;
}

function renderSite(allowlist) {
  allowSiteRow.hidden = !currentSite;
  if (!currentSite) return;
  siteNameEl.textContent = currentSite;
  allowSiteEl.checked = allowlist.includes(currentSite);
}

/**
 * activeTab gives the popup the current tab's url, and only because the user
 * just clicked the icon. Pages that are not http(s) — the new tab page, the
 * store, a pdf viewer — have nothing to allow, so the row stays hidden.
 */
async function readCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
}

async function refresh() {
  const [status, meta] = await Promise.all([
    send({ type: 'status' }),
    send({ type: 'get-settings' }),
  ]);
  render(status, meta.ok ? meta.connectedSince : null);

  // The daemon reports whether this machine has ever enrolled, so the form is
  // on screen the moment the popup opens rather than after a failed connect.
  // Only when the daemon answered at all: a service that cannot be reached is
  // a different problem, and a setup form would send the user hunting for a
  // code they do not need.
  if (status.ok) showSetup(!status.enrolled);
  if (meta.ok) {
    renderSettings(meta.settings);
    renderSite(meta.allowlist ?? []);
  }
}

toggle.addEventListener('click', async () => {
  const action = toggle.dataset.action ?? 'status';
  toggle.disabled = true;
  toggle.textContent = 'Working…';

  const reply = await send({ type: action });
  // Re-read from the daemon rather than trusting the reply: the tunnel may
  // still be mid-transition, and this is what puts the setup form on screen if
  // the device turned out to be gone.
  await refresh();
  if (!reply.ok && reply.error) showError(reply.error);
});

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const serverAddress = serverAddressEl.value.trim();
  const inviteToken = inviteTokenEl.value.trim();
  if (!serverAddress || !inviteToken) return;

  enrollButton.disabled = true;
  enrollButton.textContent = 'Setting up...';
  showError(null);

  const reply = await send({ type: 'enroll', serverAddress, inviteToken });

  enrollButton.disabled = false;
  enrollButton.textContent = 'Set up and connect';

  if (!reply.ok) {
    showError(reply.error ?? 'Setup failed.');
    return;
  }

  // Cleared on success, not on failure: retyping a long code because the
  // address had a typo is its own small misery.
  inviteTokenEl.value = '';
  showSetup(false);
  await refresh();
});

webrtcEl.addEventListener('change', async () => {
  webrtcHint.textContent = WEBRTC_HINTS[webrtcEl.value] ?? '';
  const reply = await send({ type: 'set-setting', key: 'webrtc', value: webrtcEl.value });
  if (!reply.ok) showError(reply.error);
});

for (const [element, key] of [
  [killSwitchEl, 'killSwitch'],
  [autoConnectEl, 'autoConnect'],
  [blockAdsEl, 'blockAds'],
  [blockTrackersEl, 'blockTrackers'],
]) {
  element.addEventListener('change', async () => {
    const reply = await send({ type: 'set-setting', key, value: element.checked });
    if (!reply.ok) {
      showError(reply.error);
      element.checked = !element.checked;
      return;
    }
    // The kill switch takes effect immediately, so the status line has to be
    // re-read rather than left showing what was true a moment ago.
    if (key === 'killSwitch') await refresh();
  });
}

allowSiteEl.addEventListener('change', async () => {
  if (!currentSite) return;
  const reply = await send({
    type: 'set-site-allowed',
    domain: currentSite,
    allowed: allowSiteEl.checked,
  });
  if (!reply.ok) {
    showError(reply.error);
    allowSiteEl.checked = !allowSiteEl.checked;
  }
});

currentSite = await readCurrentSite();
await refresh();
