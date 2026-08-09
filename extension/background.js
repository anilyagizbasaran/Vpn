// Service worker: the only place that talks to the native host.
//
// An MV3 service worker is killed whenever the browser feels like it, so
// nothing here holds state between messages. The badge is the one thing that
// has to survive, and it lives in the browser's own storage rather than in a
// variable that will be gone in thirty seconds.

const HOST_NAME = 'com.example.vpn_client';

/** How often to refresh the badge while the browser is awake. */
const POLL_ALARM = 'vpn-status-poll';
const POLL_PERIOD_MINUTES = 1;

/**
 * One request to the native host.
 *
 * `sendNativeMessage` starts the host, delivers one message and shuts it down,
 * which suits a client that asks a short question occasionally. A long-lived
 * port would keep a process alive for the whole browser session.
 */
function ask(action) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // If the host is missing, Chrome reports it through lastError rather than
    // by throwing, and never calls back on some platforms — hence the timer.
    const timer = setTimeout(
      () => finish({ ok: false, error: 'The VPN service did not respond.' }),
      10_000,
    );

    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, { action }, (reply) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish({
            ok: false,
            error: 'The VPN app is not installed, or its browser connector is missing.',
            missingHost: true,
          });
          return;
        }
        finish(reply ?? { ok: false, error: 'The VPN service sent no answer.' });
      });
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, error: String(error) });
    }
  });
}

const BADGES = {
  connected: { text: 'ON', color: '#1B873F' },
  connecting: { text: '···', color: '#B58900' },
  preparing: { text: '···', color: '#B58900' },
  disconnecting: { text: '···', color: '#B58900' },
  failed: { text: '!', color: '#C4314B' },
};

async function refreshBadge() {
  const reply = await ask('status');

  // Deliberately not a badge that says "off" when we simply cannot tell: an
  // empty badge means unknown, and claiming "off" would be as misleading as
  // claiming "on".
  const badge = reply.ok ? (BADGES[reply.stage] ?? { text: '', color: '#666' })
                         : { text: '?', color: '#666' };

  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.storage.session.set({ lastStatus: reply });
  return reply;
}

// The popup drives everything through here so there is one code path to the
// host, and so an action taken from the popup updates the badge immediately.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'status':
        sendResponse(await refreshBadge());
        return;
      case 'connect':
      case 'disconnect': {
        const reply = await ask(message.type);
        // Refresh from the daemon rather than trusting the reply: the tunnel
        // may still be mid-transition.
        await refreshBadge();
        sendResponse(reply);
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();

  // Keeps the message channel open for the async work above.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) refreshBadge();
});
