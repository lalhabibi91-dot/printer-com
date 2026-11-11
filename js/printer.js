/* Printer page: the machine you capture in TikTok LIVE Studio. It follows the
   account's settings (MongoDB, changed from the Settings page on any device),
   prints gifts from the TikTok LIVE, and runs the Settings page's commands
   (test print, feed, clear). Videos and the printed paper stay on this
   computer. */
import { createPrinterScene } from './printer-scene.js';
import {
  $, api, proxied, el, requireSession, logout, loadSettings, normalizeSettings, makeSaver,
  loadCatalog, giftByName, connectSocket, localStore, TIER_ORDER, TIER_NAMES,
} from './common.js';

const me = await requireSession();
$('meName').textContent = me.username;
$('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });

let { settings } = await loadSettings(me);
const save = makeSaver(() => settings);
const catalog = await loadCatalog();

// ── Machine ────────────────────────────────────────────────────────────────
const printer = createPrinterScene($('scene'), {
  speed: settings.speed, cardWidthPx: settings.tiers.small.width, zoom: settings.zoom,
  sound: settings.soundEnabled, volume: settings.soundVolume, soundPreset: settings.soundPreset,
});
const PAPER_KEY = `${me.username}:paper`;
try { await printer.restore(await localStore.get(PAPER_KEY)); } catch { /* fresh paper */ }
let saveTimer = null;
const savePaper = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStore.set(PAPER_KEY, printer.snapshot()).catch(() => {}), 800);
};

/* Built-in VIP frames: the gold "TOP 1" ring only for the viewer who has
   sent the most coins in this LIVE; the lantern-and-flower wreath for every
   other VIP print. */
const [top1Image, wreathImage] = await Promise.all([
  printer.loadImage('image/vip-top1.webp'),
  printer.loadImage('image/vip-frame.webp'),
]);
const TOP1_FRAME = top1Image ? { image: top1Image, mode: 'ring' } : null;
const VIP_FRAME = wreathImage ? { image: wreathImage, mode: 'wreath', hole: { cx: 0.5, cy: 0.5, r: 0.27 } } : null;

// ── Custom card images (saved per account on the server) ────────────────────
const decoImages = { deco: null, 'deco-vip': null };
async function loadDeco(key, version) {
  decoImages[key] = version ? await printer.loadImage(`/api/assets/${key}?v=${version}`) : null;
}
async function loadAllDeco() {
  let list = [];
  try { list = (await api('/api/assets')).assets; } catch { /* none */ }
  // Images chosen before they were saved on the server: upload them once.
  for (const key of Object.keys(decoImages)) {
    if (list.some((a) => a.key === key)) continue;
    try {
      const blob = await localStore.get(`${me.username}:${key}`);
      if (blob && blob.size) {
        const res = await fetch(`/api/assets/${key}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob });
        const body = await res.json();
        if (body.success) list.push({ key, version: body.version });
      }
    } catch { /* keep going */ }
  }
  await Promise.all(Object.keys(decoImages).map((key) => loadDeco(key, (list.find((a) => a.key === key) || {}).version)));
}
await loadAllDeco();
const scaleFor = (key, placement) => Number((settings[key] || {})[placement]) || 1;
const decoFor = (vip) => {
  const image = decoImages[vip ? 'deco-vip' : 'deco'];
  if (!image) return null;
  const placement = settings[vip ? 'vipDecoPlacement' : 'decoPlacement'];
  return { image, placement, scale: scaleFor(vip ? 'vipDecoScale' : 'decoScale', placement) };
};

// ── Top-right panel: one row per print mode ─────────────────────────────────
function renderLabel() {
  const pos = ['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(settings.labelPos) ? settings.labelPos : 'top-right';
  $('giftLabel').className = `gift-label pos-${pos}` + (settings.showLabel ? '' : ' hidden');
  $('queueBadge').classList.toggle('right', settings.showLabel && pos === 'top-left');
  const rows = $('giftLabelRows');
  rows.innerHTML = '';
  const active = TIER_ORDER.filter((k) => settings.tiers[k].on);
  (settings.labelCollapsed ? active.slice(0, 1) : active).forEach((k) => {
    const t = settings.tiers[k];
    const g = giftByName(catalog, t.gift);
    rows.append(el('div', { className: 'gift-label-row' },
      g && g.icon ? el('img', { src: proxied(g.icon), alt: '' }) : el('span', { className: 'gift-label-dot' }),
      el('span', { textContent: t.label || TIER_NAMES[k] })));
  });
  const comments = settings.comments.on && settings.comments.showInPanel;
  if (comments && !settings.labelCollapsed) {
    rows.append(el('div', { className: 'gift-label-row' },
      el('span', { className: 'gift-label-emoji', textContent: '💬' }),
      el('span', { textContent: settings.comments.label || 'Comment' })));
  }
  $('giftLabelToggle').textContent = settings.labelCollapsed ? '⌄' : '⌃';
  $('giftLabelToggle').hidden = active.length + (comments ? 1 : 0) < 2;
}
$('giftLabelToggle').addEventListener('click', () => {
  settings.labelCollapsed = !settings.labelCollapsed;
  save(); renderLabel();
});

// ── Layout, videos (this computer) ──────────────────────────────────────────
const videos = { top: $('topVideo'), bottom: $('bottomVideo') };
const videoKey = (slot) => `${me.username}:video:${slot}`;
const urls = {};
async function showVideo(slot) {
  const v = videos[slot];
  let blob = null;
  try { blob = await localStore.get(videoKey(slot)); } catch { /* none */ }
  if (urls[slot]) { URL.revokeObjectURL(urls[slot]); urls[slot] = null; }
  if (blob) {
    urls[slot] = URL.createObjectURL(blob);
    v.src = urls[slot];
    v.classList.add('on');
    v.play().catch(() => {});
  } else {
    v.removeAttribute('src');
    v.load();
    v.classList.remove('on');
  }
  if (slot === 'bottom') $('bottomArea').classList.toggle('empty', !blob);
}
let pickSlot = 'top';
document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
  pickSlot = b.dataset.pick;
  $('videoFile').click();
}));
$('videoFile').addEventListener('change', async () => {
  const file = $('videoFile').files && $('videoFile').files[0];
  $('videoFile').value = '';
  if (!file) return;
  try {
    await localStore.set(videoKey(pickSlot), file);
  } catch {
    window.alert("Couldn't save that video on this computer (storage may be full).");
    return;
  }
  showVideo(pickSlot);
});
document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
  await localStore.del(videoKey(b.dataset.remove)).catch(() => {});
  showVideo(b.dataset.remove);
}));

// Everything the settings control, applied to this screen.
function applySettings() {
  $('topArea').style.flexBasis = settings.split + '%';
  $('bottomArea').style.display = settings.split >= 100 ? 'none' : '';
  videos.top.style.objectFit = settings.fit.top;
  videos.bottom.style.objectFit = settings.fit.bottom;
  Object.values(videos).forEach((v) => { v.muted = !settings.videoSound; });
  printer.setSpeed(settings.speed);
  printer.setZoom(settings.zoom);
  printer.setCardWidth(settings.tiers.small.width);
  printer.setSound({ enabled: settings.soundEnabled, volume: settings.soundVolume, preset: settings.soundPreset });
  renderLabel();
}

// ── Printing ────────────────────────────────────────────────────────────────
const MAX_QUEUE = 40;
function updateQueueBadge() {
  const n = printer.queued;
  $('queueBadge').hidden = n < 2;
  $('queueBadge').textContent = `${n} in queue`;
}

/* The gift event carries TikTok's small avatar; look the viewer up for the
   large one (server first, then the browser-side fallback). */
async function bestAvatar(username, eventAvatar) {
  if (username) {
    try {
      const res = await fetch(`/api/tiktok/profile/${encodeURIComponent(username)}`, { credentials: 'same-origin' });
      const body = await res.json();
      if (body && body.data && body.data.avatar) return { avatar: body.data.avatar, nickname: body.data.nickname };
    } catch { /* try the fallback */ }
    try {
      if (window.ClientProfileFallback) {
        const r = await window.ClientProfileFallback.resolveProfile(username, { timeoutMs: 7000 });
        if (r && r.avatar && !r.generated) return { avatar: proxied(r.avatar), nickname: r.name };
      }
    } catch { /* use the event's avatar */ }
  }
  return { avatar: eventAvatar || '', nickname: '' };
}

// Print order when several are waiting: VIP, then Medium, then Small, then comments.
const PRIORITY = { vip: 3, medium: 2, small: 1, comment: 0 };

async function printProfile({ username, nickname, avatar, top }, kind = 'small') {
  // A full queue only turns away small prints; bigger gifts always get in.
  if (printer.queued >= MAX_QUEUE && (PRIORITY[kind] || 0) < PRIORITY.medium) return;
  const clean = String(username || '').replace(/^@+/, '');
  const found = await bestAvatar(clean, avatar);
  const image = (await printer.loadImage(found.avatar)) || (await printer.loadImage(avatar));
  const display = settings.nameMode === 'username' ? '@' + (clean || 'viewer') : (nickname || found.nickname || clean || 'Viewer');
  const vip = kind === 'vip';
  const w = kind === 'comment' ? Number(settings.comments.width) || 200 : Number((settings.tiers[kind] || settings.tiers.small).width) || 240;
  const job = {
    name: display, image, prefix: settings.prefix, suffix: settings.suffix,
    priority: PRIORITY[kind] || 0,
    size: { w, h: Math.round(w * (vip ? 0.84 : 1.22)) },
    deco: decoFor(vip),
  };
  if (vip) {
    Object.assign(job, {
      vip: true, vipStamp: settings.vipStamp, vipThanks: settings.vipThanks,
      vipCrownText: settings.vipCrownText, vipOrnament: settings.vipFrame === 'crown',
      vipFrame: settings.vipFrame === 'top1' ? (top ? TOP1_FRAME : VIP_FRAME) : null,
    });
    // The top donor always gets the TOP 1 frame, even over an uploaded VIP image.
    if (top && settings.vipFrame === 'top1' && TOP1_FRAME) job.deco = null;
  }
  const run = printer.enqueue(job);
  updateQueueBadge();
  await run;
  updateQueueBadge();
  savePaper();
}

/* Which card a gift prints: the highest switched-on mode whose coin amount
   the gift reaches (coins x how many were sent together), or none. */
function printKind(gift) {
  const coins = Math.max(1, (Number(gift && gift.coins) || 0) * Math.max(1, Number(gift && gift.count) || 1));
  let kind = null;
  for (const k of TIER_ORDER) {
    const t = settings.tiers[k];
    if (t.on && coins >= (Number(t.min) || 1) && (!kind || Number(t.min) >= Number(settings.tiers[kind].min))) kind = k;
  }
  return kind;
}

/* A comment prints the commenter's photo: each viewer at most once per
   cooldown, and only while no more than one print is waiting, so gifts always
   come first (a comment that arrives while the printer is busy just doesn't
   print; the viewer's next comment can). */
const commentPrintedAt = new Map();
function maybePrintComment({ user, comment }) {
  const c = settings.comments;
  if (!c.on || !user || !user.username) return;
  const keyword = String(c.keyword || '').trim().toLowerCase();
  if (keyword && !String(comment || '').toLowerCase().includes(keyword)) return;
  if (printer.queued >= 2) return;
  const key = user.username.toLowerCase();
  const now = Date.now();
  if (now - (commentPrintedAt.get(key) || 0) < (Number(c.cooldownMin) || 0) * 60000) return;
  commentPrintedAt.set(key, now);
  if (commentPrintedAt.size > 5000) commentPrintedAt.clear();
  printProfile({ username: user.username, nickname: user.nickname, avatar: user.avatar }, 'comment');
}

/* One printer per browser: Chrome reopens old tabs, and every printer tab
   draws 3D and would print every gift again. The newest tab takes over; the
   others pause (no drawing, no sound, no printing) until clicked. */
let pausedHere = false;
const tabId = Math.random().toString(36).slice(2);
const tabs = 'BroadcastChannel' in window ? new BroadcastChannel(`ptk-printer:${me.username}`) : null;
function setPausedHere(on) {
  pausedHere = on;
  printer.setPaused(on);
  $('pausedNote').hidden = !on;
  if (!on) sock.send({ type: 'relay:printer-here', queued: printer.queued });
}
function takeOver() {
  if (tabs) tabs.postMessage({ type: 'claim', id: tabId });
  setPausedHere(false);
}
if (tabs) {
  tabs.onmessage = (e) => {
    if (e.data && e.data.type === 'claim' && e.data.id !== tabId) setPausedHere(true);
  };
}
$('pausedNote').addEventListener('click', takeOver);

// ── Live connection: gifts, settings changes, commands from Settings ────────
const sock = connectSocket(async (msg) => {
  // A paused tab only follows settings, so it's up to date when clicked.
  if (pausedHere && msg.type !== 'settings' && msg.type !== 'asset') return;
  if (msg.type === 'socket-open' || msg.type === 'relay:who') {
    sock.send({ type: 'relay:printer-here', queued: printer.queued });
  } else if (msg.type === 'live-gift') {
    const kind = printKind(msg.gift);
    if (kind) printProfile(msg.donor, kind);
  } else if (msg.type === 'live-chat') {
    maybePrintComment(msg);
  } else if (msg.type === 'settings' && msg.settings) {
    settings = normalizeSettings(msg.settings);
    applySettings();
  } else if (msg.type === 'asset' && msg.key in decoImages) {
    await loadDeco(msg.key, msg.version);
  } else if (msg.type === 'relay:test-print') {
    printProfile({ username: msg.username, nickname: '', avatar: '', top: !!msg.top }, msg.kind || 'small');
  } else if (msg.type === 'relay:feed') {
    await printer.feed();
    savePaper();
  } else if (msg.type === 'relay:clear') {
    printer.clear();
    savePaper();
  }
});

// ── Gear + panel (hidden while the mouse is still, to keep the capture clean)
const drawer = $('drawer');
const gear = $('gearBtn');
const setDrawer = (open) => { drawer.classList.toggle('open', open); drawer.setAttribute('aria-hidden', String(!open)); };
gear.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
$('closeDrawer').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setDrawer(false);
});
let idleTimer = null;
const wake = () => {
  gear.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => gear.classList.add('idle'), 2500);
};
document.addEventListener('mousemove', wake);
wake();

applySettings();
takeOver();
showVideo('top');
showVideo('bottom');

// Debug hook for testing in the console.
window.__ptk = { printer, printProfile, printKind, maybePrintComment, settings: () => settings, deco: () => decoImages };
