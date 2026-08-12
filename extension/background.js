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

/** Stages where the tunnel is mid-transition and nothing should act on it. */
const BUSY = new Set(['connecting', 'preparing', 'disconnecting']);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** 'off' | 'safe' | 'strict' — see WEBRTC_POLICY. */
  webrtc: 'safe',
  /** Block web requests while the tunnel is known to be down. */
  killSwitch: false,
  /** Ask the daemon to connect when the browser starts. */
  autoConnect: false,
  /** Static rulesets, matching the ids declared in the manifest. */
  blockAds: true,
  blockTrackers: true,
};

/** Setting name -> the manifest ruleset it switches on and off. */
const RULESETS = { blockAds: 'ads', blockTrackers: 'trackers' };

async function readSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// ---------------------------------------------------------------------------
// WebRTC leak protection
//
// This is the leak the tunnel cannot close. WebRTC asks the OS for network
// interfaces directly and hands their addresses to page JavaScript, so a site
// can learn the real adapter's address even while every packet it receives
// comes out of the VPN. Only the browser can prevent it, which is most of the
// reason this extension exists.
// ---------------------------------------------------------------------------

const WEBRTC_POLICY = {
  // Keeps WebRTC working — calls still connect — but stops pages from
  // enumerating local interfaces. With a full-tunnel VPN the remaining public
  // interface is the tunnel itself.
  safe: 'default_public_interface_only',
  // Refuses any UDP that does not go through a proxy. The strongest setting
  // and the one that breaks video calls, which is why it is not the default.
  strict: 'disable_non_proxied_udp',
};

async function applyWebRtc(mode) {
  const setting = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!setting) return;

  // Applied as a standing preference rather than only while connected. Tying
  // it to the tunnel would leave a window open on every connect and disconnect,
  // and that window is exactly when a page is most likely to be reloading.
  if (mode === 'off') {
    await setting.clear({ scope: 'regular' });
    return;
  }
  await setting.set({ scope: 'regular', value: WEBRTC_POLICY[mode] ?? WEBRTC_POLICY.safe });
}

// ---------------------------------------------------------------------------
// Kill switch
//
// Blocks web requests when the tunnel is down, so a dropped tunnel stops
// traffic instead of quietly sending it in the clear.
//
// It fails OPEN when the daemon cannot be reached. That is a deliberate
// trade-off and the same principle the badge follows: unknown is not the same
// as off. Failing closed on "cannot tell" would lock the browser out of the
// web with no page left that could explain why — including the ones that would
// help fix it. The popup keeps working either way, because extension pages are
// not subject to these rules.
// ---------------------------------------------------------------------------

const KILL_RULE_ID = 1;

// Priorities, highest first. The kill switch has to outrank the per-site
// allowlist: "do not block ads here" must not become "keep browsing here while
// the tunnel is down", which is the opposite of what a kill switch is for.
const PRIORITY = { kill: 30, allow: 20, block: 1 };

const KILL_RULE = {
  id: KILL_RULE_ID,
  priority: PRIORITY.kill,
  action: { type: 'block' },
  condition: {
    urlFilter: '*',
    resourceTypes: [
      'main_frame',
      'sub_frame',
      'stylesheet',
      'script',
      'image',
      'font',
      'xmlhttprequest',
      'ping',
      'media',
      'websocket',
      'other',
    ],
  },
};

async function applyKillSwitch({ enabled, reachable, stage }) {
  const block = enabled && reachable && stage !== 'connected' && !BUSY.has(stage);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const active = existing.some((rule) => rule.id === KILL_RULE_ID);
  if (block === active) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [KILL_RULE_ID],
    addRules: block ? [KILL_RULE] : [],
  });
}

// ---------------------------------------------------------------------------
// Per-site allowlist
//
// Some sites break when their ad or analytics calls fail, and the honest fix
// is to let the person say "not here" rather than to make them turn blocking
// off everywhere. Dynamic rather than session rules: an allowlist the user set
// on purpose should survive a browser restart.
// ---------------------------------------------------------------------------

/** Dynamic ids from here up belong to the allowlist. */
const ALLOW_ID_BASE = 100;

async function readAllowlist() {
  const { allowlist } = await chrome.storage.local.get('allowlist');
  return Array.isArray(allowlist) ? allowlist : [];
}

async function applyAllowlist(domains) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const stale = existing.filter((r) => r.id >= ALLOW_ID_BASE).map((r) => r.id);

  const rules = domains.map((domain, index) => ({
    id: ALLOW_ID_BASE + index,
    priority: PRIORITY.allow,
    action: { type: 'allow' },
    // initiatorDomains, not requestDomains: what is being allowed is every
    // request *made by* this site, whoever it is talking to.
    condition: { initiatorDomains: [domain] },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: stale,
    addRules: rules,
  });
}

async function setAllowed(domain, allowed) {
  const current = new Set(await readAllowlist());
  if (allowed) current.add(domain);
  else current.delete(domain);

  const next = [...current].sort();
  await chrome.storage.local.set({ allowlist: next });
  await applyAllowlist(next);
  return next;
}

// ---------------------------------------------------------------------------
// Ad and tracker blocking
//
// Static rulesets declared in the manifest, toggled here. They cost no
// permission a page could notice: blocking rules need no host access, so the
// extension still cannot read, alter or even see a request — the browser
// applies the rules and never reports them back.
// ---------------------------------------------------------------------------

async function applyRulesets(settings) {
  const enabled = [];
  const disabled = [];
  for (const [key, ruleset] of Object.entries(RULESETS)) {
    (settings[key] ? enabled : disabled).push(ruleset);
  }

  // Asking for a state it is already in is not an error, but it does rebuild
  // the matcher, so only the difference is sent.
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = enabled.filter((id) => !current.has(id));
  const disableRulesetIds = disabled.filter((id) => current.has(id));
  if (enableRulesetIds.length === 0 && disableRulesetIds.length === 0) return;

  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds,
    disableRulesetIds,
  });
}

// ---------------------------------------------------------------------------
// Native host
// ---------------------------------------------------------------------------

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

/**
 * Records when the tunnel came up so the popup can show a duration. Stored
 * rather than counted: the service worker is not alive long enough to count.
 */
async function trackConnectedSince(stage) {
  const { connectedSince } = await chrome.storage.local.get('connectedSince');
  if (stage === 'connected' && !connectedSince) {
    await chrome.storage.local.set({ connectedSince: Date.now() });
  } else if (stage !== 'connected' && connectedSince) {
    await chrome.storage.local.remove('connectedSince');
  }
}

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

  await trackConnectedSince(reply.ok ? reply.stage : null);

  const { killSwitch } = await readSettings();
  await applyKillSwitch({
    enabled: killSwitch,
    reachable: reply.ok === true,
    stage: reply.stage,
  });

  return reply;
}

// ---------------------------------------------------------------------------
// Messages from the popup
// ---------------------------------------------------------------------------

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

      case 'get-settings': {
        const settings = await readSettings();
        const { connectedSince } = await chrome.storage.local.get('connectedSince');
        sendResponse({
          ok: true,
          settings,
          connectedSince: connectedSince ?? null,
          allowlist: await readAllowlist(),
        });
        return;
      }

      case 'set-site-allowed': {
        const { domain, allowed } = message;
        if (typeof domain !== 'string' || !domain) {
          sendResponse({ ok: false, error: 'no site to allow' });
          return;
        }
        sendResponse({ ok: true, allowlist: await setAllowed(domain, allowed) });
        return;
      }

      case 'set-setting': {
        const { key, value } = message;
        if (!(key in DEFAULTS)) {
          sendResponse({ ok: false, error: `unknown setting: ${key}` });
          return;
        }
        await chrome.storage.local.set({ [key]: value });

        if (key === 'webrtc') await applyWebRtc(value);
        if (key in RULESETS) await applyRulesets(await readSettings());
        // Re-evaluating rather than toggling blindly: turning the kill switch
        // on while already connected must not block anything.
        if (key === 'killSwitch') await refreshBadge();

        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();

  // Keeps the message channel open for the async work above.
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function start({ autoConnectAllowed }) {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });

  const settings = await readSettings();
  const { webrtc, autoConnect } = settings;
  await applyWebRtc(webrtc);
  await applyRulesets(settings);
  // Dynamic rules survive a restart, but rebuilding from storage keeps the
  // two from drifting if one is ever cleared without the other.
  await applyAllowlist(await readAllowlist());

  if (autoConnectAllowed && autoConnect) {
    const status = await ask('status');
    // Only when the daemon answers and says it is down: a failed connect on a
    // machine where the app has never run is noise, not a useful attempt.
    if (status.ok && status.stage === 'disconnected') await ask('connect');
  }

  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => start({ autoConnectAllowed: false }));
chrome.runtime.onStartup.addListener(() => start({ autoConnectAllowed: true }));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) refreshBadge();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-tunnel') return;
  const status = await ask('status');
  if (!status.ok || BUSY.has(status.stage)) return;
  await ask(status.stage === 'connected' ? 'disconnect' : 'connect');
  await refreshBadge();
});
