// My5 Focus Board — background service worker
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Toolbar icon follows the selected theme ────────────────────────────────
// The green pixels of icon48.png are re-tinted to the active theme's accent.
const THEME_ACCENTS = {
  green:'#639922', blue:'#378ADD', purple:'#6C66E0', amber:'#D4860A',
  slate:'#6B6B7E', dark:'#888888', pink:'#E05C9A', sparkles:'#B44FE8',
  teal:'#14A38F', crimson:'#D64545', sunset:'#EA580C', midnight:'#7B93D6'
};

async function tintIcon(hex) {
  try {
    const res = await fetch(chrome.runtime.getURL('icon48.png'));
    const bmp = await createImageBitmap(await res.blob());
    const c   = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const d   = img.data;
    const ar = parseInt(hex.slice(1, 3), 16),
          ag = parseInt(hex.slice(3, 5), 16),
          ab = parseInt(hex.slice(5, 7), 16);
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue; // transparent
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const f  = Math.min(1, (mx - mn) / 60); // how "colored" (vs white/grey) the pixel is
      if (f > 0) {
        d[i]     += (ar - d[i])     * f;
        d[i + 1] += (ag - d[i + 1]) * f;
        d[i + 2] += (ab - d[i + 2]) * f;
      }
    }
    ctx.putImageData(img, 0, 0);
    chrome.action.setIcon({ imageData: ctx.getImageData(0, 0, bmp.width, bmp.height) });
  } catch (e) { /* cosmetic — never block anything over the icon */ }
}

async function applyIconFromPrefs() {
  try {
    const r = await chrome.storage.local.get('paragon_sync_config'); // legacy key, do not rename
    let theme = 'green';
    if (r.paragon_sync_config) {
      const cfg = JSON.parse(r.paragon_sync_config);
      if (cfg.prefs && cfg.prefs.theme) theme = cfg.prefs.theme;
    }
    tintIcon(THEME_ACCENTS[theme] || THEME_ACCENTS.green);
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(applyIconFromPrefs);
chrome.runtime.onStartup.addListener(applyIconFromPrefs);
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'icon-color' && msg.color) tintIcon(msg.color);
});
applyIconFromPrefs(); // also run when the worker wakes