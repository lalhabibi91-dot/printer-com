/* Settings page: controls the account's printer from any device. Settings are
   saved in MongoDB and pushed to the printer screen live; test prints, feed
   and clear are sent to it as commands. */
import {
  $, api, proxied, el, requireSession, logout, loadSettings, normalizeSettings, makeSaver,
  loadCatalog, giftByName, connectSocket, liveStatusText, CLIENT_ID,
  TIER_ORDER, TIER_NAMES, SIZE_OPTIONS,
} from './common.js';
import { SOUND_PRESETS, playPreview } from './printer-sound.js';

const me = await requireSession();
$('meName').textContent = me.username;
$('logoutBtn').addEventListener('click', logout);

let { settings } = await loadSettings(me);
const catalog = await loadCatalog();
const save = makeSaver(() => settings, (state, err) => {
  $('saveState').textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Not saved: ' + (err && err.message);
});

// ── Printer screen online? ──────────────────────────────────────────────────
let printerSeenAt = 0;
function renderPrinterPill() {
  const on = Date.now() - printerSeenAt < 25000;
  const pill = $('printerPill');
  pill.textContent = on ? 'Printer: online' : 'Printer: not open';
  pill.className = 'pill ' + (on ? 'on' : 'off');
  return on;
}

// ── Live connection ─────────────────────────────────────────────────────────
function setLiveStatus(text, cls = '') {
  $('liveStatus').textContent = text;
  $('liveStatus').className = 'status ' + cls;
}
const sock = connectSocket((msg) => {
  if (msg.type === 'socket-open') {
    sock.send({ type: 'relay:who' });
  } else if (msg.type === 'relay:printer-here') {
    printerSeenAt = Date.now();
    renderPrinterPill();
  } else if (msg.type === 'live-status') {
    setLiveStatus(...liveStatusText(msg));
  } else if (msg.type === 'live-error') {
    setLiveStatus(msg.message, 'err');
  } else if (msg.type === 'settings' && msg.settings && msg.from !== CLIENT_ID) {
    // Changed on another device: show it here too.
    settings = normalizeSettings(msg.settings);
    renderAll();
  } else if (msg.type === 'asset') {
    showDecoPreview(msg.key, msg.version);
  }
});
setInterval(() => { sock.send({ type: 'relay:who' }); setTimeout(renderPrinterPill, 3000); }, 15000);
setTimeout(renderPrinterPill, 3000);

const connectBtn = $('liveConnect');
connectBtn.addEventListener('click', async () => {
  if (connectBtn.disabled) return;
  settings.liveUser = $('liveUser').value.trim();
  save();
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  setLiveStatus('Connecting… (this can take a few seconds)');
  try {
    // The server retries a few times on its own, so one click is enough.
    const st = await api('/api/live/start', { method: 'POST', body: { uniqueId: settings.liveUser, sessionId: $('liveSession').value.trim() } });
    setLiveStatus(st.connected ? `Connected to @${st.liveUniqueId}` : 'Connecting…', st.connected ? 'ok' : '');
  } catch (e) {
    setLiveStatus(e.message, 'err');
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});
$('liveDisconnect').addEventListener('click', async () => {
  try { await api('/api/live/stop', { method: 'POST' }); } catch { /* ignore */ }
  setLiveStatus('Not connected');
});

// ── Commands for the printer screen ─────────────────────────────────────────
function command(msg, done) {
  const st = $('testStatus');
  if (!renderPrinterPill()) {
    st.textContent = 'No printer screen is open. Open the printer first (Portal → Printer).';
    st.className = 'status err';
    return;
  }
  sock.send(msg);
  st.textContent = done;
  st.className = 'status ok';
}
document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => {
  const user = $('testUser').value.trim().replace(/^@+/, '');
  if (!user) { $('testStatus').textContent = 'Enter a TikTok username'; $('testStatus').className = 'status err'; return; }
  const top = b.dataset.test === 'top';
  const kind = top ? 'vip' : b.dataset.test;
  const name = top ? 'TOP 1' : kind === 'comment' ? 'Comment' : TIER_NAMES[kind];
  command({ type: 'relay:test-print', username: user, kind, top }, `Sent to the printer: ${name} print of @${user}`);
}));
$('feedBtn').addEventListener('click', () => command({ type: 'relay:feed' }, 'Feeding the paper'));
$('clearBtn').addEventListener('click', () => command({ type: 'relay:clear' }, 'Paper cleared'));

// ── Print modes ─────────────────────────────────────────────────────────────
function giftSearchBox(onPick) {
  const input = el('input', { type: 'text', placeholder: 'Search gifts…' });
  const list = el('div', { className: 'gift-list' });
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    list.classList.toggle('show', !!q);
    if (!q) return;
    catalog.filter((g) => g.name.toLowerCase().includes(q)).slice(0, 60).forEach((g) => {
      const b = el('button', { type: 'button', className: 'gift-item' },
        el('img', { src: proxied(g.icon), alt: '', loading: 'lazy' }), g.name,
        el('span', { className: 'coins', textContent: g.coins.toLocaleString() }));
      b.addEventListener('click', () => { input.value = ''; list.classList.remove('show'); onPick(g); });
      list.append(b);
    });
  });
  return el('div', {}, input, list);
}

function renderTiers() {
  const box = $('tiers');
  box.innerHTML = '';
  TIER_ORDER.forEach((key) => {
    const t = settings.tiers[key];
    const on = el('input', { type: 'checkbox', checked: t.on });
    on.addEventListener('change', () => { t.on = on.checked; save(); renderTiers(); });
    const min = el('input', { type: 'number', min: '1', step: '1', value: t.min });
    min.addEventListener('input', () => { t.min = Math.max(1, Math.round(Number(min.value) || 1)); save(); });
    const size = el('select');
    SIZE_OPTIONS[key].forEach(([v, name]) => size.append(el('option', { value: v, textContent: name, selected: Number(t.width) === v })));
    size.addEventListener('change', () => { t.width = Number(size.value); save(); });
    const label = el('input', { type: 'text', value: t.label });
    label.addEventListener('input', () => { t.label = label.value; save(); });
    const g = giftByName(catalog, t.gift);
    const icon = el('span', { className: 'chip' }, g && g.icon ? el('img', { src: proxied(g.icon), alt: '' }) : null, t.gift || 'none');
    const picker = giftSearchBox((gift) => { t.gift = gift.name; save(); renderTiers(); });
    picker.hidden = true;
    const change = el('button', { type: 'button', className: 'btn small', textContent: 'Change icon' });
    change.addEventListener('click', () => { picker.hidden = !picker.hidden; if (!picker.hidden) picker.querySelector('input').focus(); });
    box.append(el('div', { className: 'tier' + (t.on ? '' : ' off') },
      el('label', { className: 'check tier-head' }, on, el('b', { textContent: TIER_NAMES[key] })),
      el('div', { className: 'grid2' },
        el('div', {}, el('label', { textContent: 'From coins' }), min),
        el('div', {}, el('label', { textContent: 'Card size' }), size)),
      el('label', { textContent: 'Panel label' }), label,
      el('label', { textContent: 'Panel icon' }),
      el('div', { className: 'row' }, icon, change),
      picker));
  });
}

// ── Printer sound choice, with a preview on this device ─────────────────────
SOUND_PRESETS.forEach((p, i) => $('soundPreset').append(el('option', { value: p.id, textContent: `${i + 1}. ${p.name}` })));
$('soundPreview').addEventListener('click', () => playPreview($('soundPreset').value, Number(settings.soundVolume) || 0.6));

// ── Simple controls ─────────────────────────────────────────────────────────
// [element id, settings path, kind] — path "a.b" reaches into nested objects.
const CONTROLS = [
  ['showLabel', 'showLabel', 'checked'],
  ['labelPos', 'labelPos', 'text'],
  ['decoPrefix', 'prefix', 'text'],
  ['decoSuffix', 'suffix', 'text'],
  ['nameMode', 'nameMode', 'text'],
  ['speed', 'speed', 'number'],
  ['vipFrame', 'vipFrame', 'text'],
  ['vipCrownText', 'vipCrownText', 'text'],
  ['vipStamp', 'vipStamp', 'text'],
  ['vipThanks', 'vipThanks', 'text'],
  ['soundEnabled', 'soundEnabled', 'checked'],
  ['soundVolume', 'soundVolume', 'number'],
  ['soundPreset', 'soundPreset', 'text'],
  ['split', 'split', 'number'],
  ['zoom', 'zoom', 'number'],
  ['fitTop', 'fit.top', 'text'],
  ['fitBottom', 'fit.bottom', 'text'],
  ['videoSound', 'videoSound', 'checked'],
  ['commentsOn', 'comments.on', 'checked'],
  ['commentCooldown', 'comments.cooldownMin', 'number'],
  ['commentSize', 'comments.width', 'number'],
  ['commentKeyword', 'comments.keyword', 'text'],
  ['commentLabel', 'comments.label', 'text'],
  ['commentShowInPanel', 'comments.showInPanel', 'checked'],
];
const getPath = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), settings);
const setPath = (path, v) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] = o[k] || {}), settings)[last] = v;
};
function renderValues() {
  for (const [id, path, kind] of CONTROLS) {
    const c = $(id);
    if (c === document.activeElement) continue; // don't fight the user's typing
    if (kind === 'checked') c.checked = !!getPath(path);
    else c.value = getPath(path);
  }
  $('liveUser').value = document.activeElement === $('liveUser') ? $('liveUser').value : settings.liveUser || '';
  $('speedVal').textContent = Number(settings.speed).toFixed(1) + '×';
  $('soundVolumeVal').textContent = Math.round(settings.soundVolume * 100) + '%';
  $('splitVal').textContent = settings.split + '%';
  $('zoomVal').textContent = Math.round(settings.zoom * 100) + '%';
  syncDecoControls();
}
for (const [id, path, kind] of CONTROLS) {
  const c = $(id);
  c.addEventListener(kind === 'checked' || c.tagName === 'SELECT' ? 'change' : 'input', () => {
    setPath(path, kind === 'checked' ? c.checked : kind === 'number' ? Number(c.value) : c.value);
    save();
    renderValues();
  });
}

// ── Custom card images (saved on the server, used by every printer screen) ──
const DECO = {
  deco: { prefix: 'deco', placementKey: 'decoPlacement', scaleKey: 'decoScale' },
  'deco-vip': { prefix: 'vipDeco', placementKey: 'vipDecoPlacement', scaleKey: 'vipDecoScale' },
};
function showDecoPreview(key, version) {
  const d = DECO[key];
  if (!d) return;
  const img = $(d.prefix + 'Preview');
  img.hidden = !version;
  if (version) img.src = `/api/assets/${key}?v=${version}`;
}
function syncDecoControls() {
  for (const d of Object.values(DECO)) {
    const placement = settings[d.placementKey];
    const scale = Number((settings[d.scaleKey] || {})[placement]) || 1;
    $(d.prefix + 'Placement').value = placement;
    $(d.prefix + 'Scale').value = scale;
    $(d.prefix + 'ScaleVal').textContent = Math.round(scale * 100) + '%';
  }
}
for (const [key, d] of Object.entries(DECO)) {
  const file = $(d.prefix + 'File');
  $(d.prefix + 'Pick').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const res = await fetch(`/api/assets/${key}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'image/png' }, body: f });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || 'Upload failed');
      showDecoPreview(key, body.version);
    } catch (e) {
      window.alert(e.message);
    }
  });
  $(d.prefix + 'Remove').addEventListener('click', async () => {
    await api(`/api/assets/${key}`, { method: 'DELETE' }).catch(() => {});
    showDecoPreview(key, 0);
  });
  $(d.prefix + 'Placement').addEventListener('change', () => {
    settings[d.placementKey] = $(d.prefix + 'Placement').value;
    save(); syncDecoControls();
  });
  $(d.prefix + 'Scale').addEventListener('input', () => {
    settings[d.scaleKey] = { ...settings[d.scaleKey], [settings[d.placementKey]]: Number($(d.prefix + 'Scale').value) };
    save(); syncDecoControls();
  });
}
try {
  const { assets } = await api('/api/assets');
  assets.forEach((a) => showDecoPreview(a.key, a.version));
} catch { /* none */ }

function renderAll() {
  renderTiers();
  renderValues();
}
renderAll();
try {
  setLiveStatus(...liveStatusText(await api('/api/live/status')));
} catch { /* ignore */ }

window.__ptkSettings = { settings: () => settings };
