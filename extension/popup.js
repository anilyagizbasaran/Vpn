// The popup renders whatever the service worker reports and never talks to
// the native host itself — one code path to the daemon, one place to change.

const dot = document.getElementById('dot');
const stageEl = document.getElementById('stage');
const detailEl = document.getElementById('detail');
const toggle = document.getElementById('toggle');
const errorEl = document.getElementById('error');

const LABELS = {
  connected: 'Connected',
  connecting: 'Connecting…',
  preparing: 'Preparing…',
  disconnecting: 'Disconnecting…',
  disconnected: 'Not connected',
  failed: 'Connection failed',
};

const BUSY = new Set(['connecting', 'preparing', 'disconnecting']);

function send(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply ?? { ok: false, error: 'No answer from the extension.' });
    });
  });
}

function render(reply) {
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

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message ?? '';
}

toggle.addEventListener('click', async () => {
  const action = toggle.dataset.action ?? 'status';
  toggle.disabled = true;
  toggle.textContent = 'Working…';

  const reply = await send(action);
  // `connect` asks the daemon to reuse the config it already has. If it has
  // none — the app has not connected since the service started — that is not
  // a failure to hide, it is an instruction.
  if (!reply.ok && reply.error) {
    render(await send('status'));
    showError(reply.error);
    return;
  }
  render(await send('status'));
});

render(await send('status'));
