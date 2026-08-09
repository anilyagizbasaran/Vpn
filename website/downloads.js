// Fills the download grid from releases.json.
//
// The page is static and the release list is data, so publishing a version
// means writing one JSON file rather than editing HTML. The CI release job
// produces it.

const PLATFORMS = [
  { key: 'android', name: 'Android', hint: 'APK, 7.0 ve üzeri' },
  { key: 'windows', name: 'Windows', hint: '10 ve üzeri, 64-bit' },
  { key: 'macos', name: 'macOS', hint: '12 ve üzeri' },
  { key: 'linux', name: 'Linux', hint: 'x86-64 · wireguard-tools gerekir' },
];

const grid = document.getElementById('download-grid');

/** Best guess at which card to highlight, from the user agent. */
function guessPlatform() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad/i.test(ua)) return 'ios';
  if (/Mac/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  if (/Win/i.test(ua)) return 'windows';
  return null;
}

function card(platform, release, isCurrent) {
  const entry = release?.downloads?.[platform.key];
  const article = document.createElement('article');
  article.className = 'download';
  if (isCurrent) article.dataset.current = 'true';

  const heading = document.createElement('h3');
  heading.textContent = platform.name;
  article.append(heading);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = platform.hint;
  article.append(hint);

  if (entry) {
    const link = document.createElement('a');
    link.className = 'button';
    link.href = entry.url;
    link.textContent = `İndir ${release.version}`;
    // Downloads are cross-origin to the release host; do not leak the
    // referrer or hand the target a window handle.
    link.rel = 'noopener noreferrer';
    article.append(link);

    if (entry.sha256) {
      const sum = document.createElement('p');
      sum.className = 'checksum';
      // Unsigned builds make the checksum the only integrity check a careful
      // user has, so it is shown rather than buried in the release notes.
      sum.textContent = `SHA-256 ${entry.sha256.slice(0, 16)}…`;
      sum.title = entry.sha256;
      article.append(sum);
    }
  } else {
    const pending = document.createElement('p');
    pending.className = 'pending';
    pending.textContent = 'Henüz yayınlanmadı';
    article.append(pending);
  }

  return article;
}

async function render() {
  let release;
  try {
    const response = await fetch('releases.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    release = await response.json();
  } catch {
    grid.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'loading',
        textContent:
          'Sürüm listesi yüklenemedi. GitHub sürümler sayfasından indirebilirsiniz.',
      }),
    );
    return;
  }

  const current = guessPlatform();
  grid.replaceChildren(
    ...PLATFORMS.map((platform) => card(platform, release, platform.key === current)),
  );

  // iOS has no download: the App Store build does not exist yet, and there is
  // no sideloading story worth putting in front of a user.
  if (current === 'ios') {
    grid.append(
      Object.assign(document.createElement('p'), {
        className: 'browser-note',
        textContent: 'iOS sürümü henüz hazır değil.',
      }),
    );
  }
}

render();
