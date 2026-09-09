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

/**
 * The policy to actually apply, given the setting and whether the browser is
 * tunnelling itself.
 *
 * Browser-only mode overrides the preference. The tunnel it uses is a SOCKS5
 * proxy, and SOCKS5 carries TCP: any UDP WebRTC opens would go straight out of
 * the real adapter, from the real address, while the tab it belongs to looked
 * private. `disable_non_proxied_udp` is the only setting that closes that, so
 * in this mode it is not optional.
 */
function effectiveWebRtc(mode, browserOnly) {
  if (browserOnly) return 'strict';
  return mode;
}

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
// Browser-only mode
//
// The daemon runs a WireGuard tunnel in userspace and offers it as a SOCKS5
// proxy on loopback. Nothing system-wide changes — no interface, no route —
// and pointing Chrome at that proxy is what makes this browser, and only this
// browser, come out of the VPN.
//
// The scheme matters. Chrome resolves names at the *proxy* for socks5, and
// locally for socks4: with the wrong one every site visited would be sent to
// the local network's DNS in the clear while the pages themselves loaded
// privately. socks5 is the whole reason the proxy implements domain
// addresses at all.
// ---------------------------------------------------------------------------

// Only loopback. A bypass list is a hole in the tunnel by construction, so it
// holds the addresses that cannot leave this machine and nothing else.
const PROXY_BYPASS = ['localhost', '127.0.0.1', '[::1]'];

function proxyConfig(host, port) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'socks5', host, port },
      bypassList: PROXY_BYPASS,
    },
  };
}

async function applyProxy(host, port) {
  const settings = chrome.proxy?.settings;
  if (!settings) throw new Error('This browser does not allow proxy settings to be changed.');

  const current = await settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions' ||
      current.levelOfControl === 'not_controllable') {
    // Failing loudly. Setting it and having it silently not take effect would
    // leave the popup saying the browser is tunnelled while it is not.
    throw new Error('Another extension or a policy controls the proxy settings.');
  }

  await settings.set({ scope: 'regular', value: proxyConfig(host, port) });
  await chrome.storage.session.set({ appliedProxy: `${host}:${port}` });
}

async function clearProxy() {
  const settings = chrome.proxy?.settings;
  if (!settings) return;
  try {
    await settings.clear({ scope: 'regular' });
  } finally {
    await chrome.storage.session.remove('appliedProxy');
  }
}

/**
 * Keeps Chrome's proxy setting in step with what the daemon reports.
 *
 * The service worker is killed and restarted constantly, so the daemon is the
 * only thing that knows whether the browser tunnel is running; this runs on
 * every status refresh to make the browser agree with it.
 *
 * A daemon that cannot be reached leaves the proxy exactly as it is. Clearing
 * it would send the next request out of the real adapter the moment the VPN
 * app crashed, which is the leak this mode exists to prevent — so it fails
 * closed, and the switch in the popup still turns it off by hand.
 */
async function reconcileProxy(reply) {
  if (!reply.ok) return;

  if (!reply.browserOnly || !reply.socksPort) {
    // The tunnel died rather than being switched off. The proxy setting stays
    // exactly where it is: undoing it would put the browser back on the real
    // adapter, from the real address, with pages still loading and nothing on
    // screen changed — which is the leak this mode exists to prevent. The
    // browser gets a refused connection instead, and the popup says why.
    if (reply.browserFailed) return;

    // Cleared unconditionally, not only when this session remembers setting
    // it. Chrome keeps the proxy setting across restarts and `appliedProxy`
    // does not, so a browser reopened after browser-only mode was on would
    // otherwise sit pointed at a port with nothing behind it, loading
    // nothing, with no way back. Clearing what was never set is a no-op:
    // an extension can only clear its own value.
    await clearProxy();
    return;
  }

  const host = reply.socksHost || '127.0.0.1';
  const wanted = `${host}:${reply.socksPort}`;

  const { appliedProxy } = await chrome.storage.session.get('appliedProxy');
  if (appliedProxy === wanted) return;
  await applyProxy(host, reply.socksPort);
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
function ask(action, extra = {}) {
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
      chrome.runtime.sendNativeMessage(HOST_NAME, { action, ...extra }, (reply) => {
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
  // Browser-only mode has no stage of its own — the system tunnel below it is
  // deliberately off — so it is badged from its own two states.
  let badge;
  if (!reply.ok) {
    badge = { text: '?', color: '#666' };
  } else if (reply.browserOnly) {
    badge = { text: 'ON', color: '#1B873F' };
  } else if (reply.browserFailed) {
    // Not an empty badge. The browser is blocked rather than leaking, but it
    // is blocked, and the person wondering why every page fails has to be
    // able to see that from the toolbar.
    badge = { text: '!', color: '#C4314B' };
  } else {
    badge = BADGES[reply.stage] ?? { text: '', color: '#666' };
  }

  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.storage.session.set({ lastStatus: reply });

  await trackConnectedSince(reply.ok ? reply.stage : null);

  // Before the kill switch: if the browser tunnel went away while nothing was
  // looking, the sooner the browser stops sending traffic to a dead proxy the
  // better. Failures here are reported rather than thrown — the badge refresh
  // runs on a timer and there is nobody to catch them.
  try {
    await reconcileProxy(reply);
  } catch (error) {
    console.warn('could not apply the proxy setting', error);
  }

  const { killSwitch, webrtc } = await readSettings();
  await applyWebRtc(effectiveWebRtc(webrtc, reply.ok === true && reply.browserOnly === true));
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

      case 'browser-only-on': {
        const reply = await ask('browser-only-on');
        if (!reply.ok) {
          sendResponse(reply);
          return;
        }
        try {
          await applyProxy(reply.socksHost || '127.0.0.1', reply.socksPort);
        } catch (error) {
          // The daemon is now running a tunnel this browser is not using.
          // Leaving it there would show "on" over an ordinary connection, so
          // it goes back down and the failure is what the user sees.
          await ask('browser-only-off');
          await clearProxy();
          await refreshBadge();
          sendResponse({ ok: false, error: String(error.message ?? error) });
          return;
        }
        await refreshBadge();
        sendResponse(reply);
        return;
      }

      case 'browser-only-off': {
        // Cleared first, and whatever the daemon says. This is the way out
        // when the VPN app has died with the proxy still set — the browser
        // cannot load anything until it is cleared, and asking a daemon that
        // is not there would make the button do nothing.
        await clearProxy();
        const reply = await ask('browser-only-off');
        await refreshBadge();
        sendResponse(reply);
        return;
      }

      case 'enroll': {
        // Straight through to the daemon. The extension deliberately keeps no
        // copy of either value: the code is spent on first use, and the
        // address belongs with the key it is useless without, which is in the
        // daemon and not here.
        const reply = await ask('enroll', {
          serverAddress: String(message.serverAddress ?? '').trim(),
          inviteToken: String(message.inviteToken ?? '').trim(),
        });
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

        if (key in RULESETS) await applyRulesets(await readSettings());
        // Re-evaluating rather than toggling blindly: turning the kill switch
        // on while already connected must not block anything, and the WebRTC
        // preference does not win over what browser-only mode requires.
        if (key === 'killSwitch' || key === 'webrtc') await refreshBadge();

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
  const { autoConnect } = settings;
  await applyRulesets(settings);
  // Dynamic rules survive a restart, but rebuilding from storage keeps the
  // two from drifting if one is ever cleared without the other.
  await applyAllowlist(await readAllowlist());

  if (autoConnectAllowed && autoConnect) {
    const status = await ask('status');
    // Only when the daemon answers and says it is down, and not while the
    // browser is tunnelling itself — the two modes exclude each other and the
    // daemon would refuse anyway.
    if (status.ok && status.stage === 'disconnected' && !status.browserOnly) {
      await ask('connect');
    }
  }

  // Applies the WebRTC policy and puts the proxy setting back in step with
  // whatever the daemon is actually running.
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
  // The shortcut drives the system-wide tunnel. In browser-only mode the
  // daemon would refuse it, so it does nothing rather than showing an error
  // nobody asked for.
  if (status.browserOnly) return;
  await ask(status.stage === 'connected' ? 'disconnect' : 'connect');
  await refreshBadge();
});
