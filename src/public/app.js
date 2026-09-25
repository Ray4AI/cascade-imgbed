/* CascadeImg frontend — vanilla JS, no build step.
 * Layout: left hero (newest / focused item, big) + right cascade (history).
 * After every successful upload the reference text is auto-copied to the clipboard. */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const LS_AUTOCOPY = 'ci.autoCopy';

let cfg = null;          // /api/config payload
let items = [];          // cascade items, newest first
let formats = [];        // template list
let authRequired = false;
let loggedIn = true;
let focusId = null;      // item shown in the left hero pane
let globalFormatId = ''; // currently selected format template
let autoCopy = localStorage.getItem(LS_AUTOCOPY) !== '0';

// ------------------------------------------------------------------ boot

init();

async function init() {
  bindGlobalEvents();
  try {
    const me = await api('/api/me');
    authRequired = me.authRequired;
    loggedIn = me.loggedIn;
    updateAuthButton();
    await loadConfig();
    await loadImages();
    if (authRequired && !loggedIn) showLogin();
  } catch (e) {
    if (authRequired && !loggedIn) showLogin(); // expected gate, not an error
    else toast('初始化失败: ' + e.message, true);
  }
  setInterval(tickCountdowns, 15000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    authRequired = true;
    loggedIn = false;
    updateAuthButton();
    showLogin();
    throw new Error('需要登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadConfig() {
  try {
    cfg = await api('/api/config');
  } catch {
    cfg = { formats: [{ id: 'llm', name: 'LLM 引用', template: '[image:{url}]' }], defaultFormat: 'llm', retention: 'never' };
  }
  formats = cfg.formats || [];
  if (!formats.some((f) => f.id === globalFormatId)) globalFormatId = '';
  syncFormatSelects();
  fillSettingsForm();
}

async function loadImages() {
  const data = await api('/api/images?limit=200');
  items = data.items || [];
  focusId = items[0]?.id || null;
  renderAll();
}

function renderAll() {
  const focused = items.find((x) => x.id === focusId) || items[0] || null;
  focusId = focused ? focused.id : null;

  const slot = $('#heroSlot');
  slot.innerHTML = '';
  $('#emptyState').style.display = focused ? 'none' : '';
  $('#heroHint').style.display = focused ? 'none' : '';
  if (focused) slot.appendChild(buildHero(focused));

  const list = $('#cascadeList');
  list.innerHTML = '';
  for (const it of items) {
    if (it.id === focusId) continue;
    list.appendChild(createMini(it));
  }
  const rest = items.length - (focused ? 1 : 0);
  $('#sideCount').textContent = `${rest} 项`;
  $('#sideEmpty').style.display = rest ? 'none' : '';
  tickCountdowns();
}

function focusItem(id) {
  if (focusId === id) return;
  focusId = id;
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --------------------------------------------------------------- upload

/** Upload a batch (paste / drop / picker). One auto-copy of all references when done. */
async function handleFiles(files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return;
  const results = await Promise.all(list.map(uploadFile));
  const okItems = results.filter(Boolean);
  if (!okItems.length) return;
  if (!autoCopy) return;
  const text = okItems.map((it) => buildOutput(it, currentFormatId())).join('\n');
  const ok = await copyToClipboard(text);
  if (ok) {
    toast(okItems.length > 1 ? `已自动复制 ${okItems.length} 条引用 ✓` : '已自动复制引用 ✓', false, 'ok');
  } else {
    toast('自动复制被浏览器拦截，点「复制引用」按钮手动复制', true);
    pulsePrimaryCopy();
  }
}

async function uploadFile(file) {
  if (!file) return null;
  // client-side pre-check against per-kind limits (server re-validates after sniffing)
  const kind = guessKind(file);
  const lim = (cfg.sizeLimitsMb || {})[kind];
  if (lim && file.size > lim * 1048576) {
    toast(`${KIND_LABEL[kind] || '文件'}类上限 ${lim} MB，当前 ${(file.size / 1048576).toFixed(1)} MB`, true);
    return null;
  }
  const pending = createPendingCard(file);
  $('#cascadeList').prepend(pending);
  $('#sideEmpty').style.display = 'none';
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name || 'pasted-image.png'),
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { pending.remove(); showLogin(); return null; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    pending.remove();
    items.unshift(data);
    focusId = data.id; // newest → left hero
    renderAll();
    return data;
  } catch (e) {
    pending.remove();
    renderAll();
    toast('上传失败: ' + e.message, true);
    return null;
  }
}

// ---------------------------------------------------------------- cards

function createPendingCard(file) {
  const card = el('article', 'mini-card pending');
  const thumb = el('div', 'mini-thumb');
  if ((file.type || '').startsWith('image/')) {
    const img = el('img');
    img.alt = '';
    try { img.src = URL.createObjectURL(file); } catch { /* ignore */ }
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el('div', 'kind-icon', kindIcon(file.type, file.name)));
  }
  const body = el('div', 'mini-body');
  body.appendChild(el('div', 'mini-name', file.name || '粘贴内容'));
  body.appendChild(el('div', 'mini-meta', '正在上传…'));
  card.append(thumb, body);
  return card;
}

function kindIcon(mime, name) {
  const m = String(mime || '');
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (m.startsWith('audio/') || ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return '🎵';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ogv'].includes(ext)) return '🎬';
  if (m.startsWith('text/') || ['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'log'].includes(ext)) return '📝';
  return '📄';
}

const KIND_LABEL = { image: '图', text: '文本', audio: '音频', video: '视频', doc: '文件' };
const LIMIT_INPUTS = { image: '#s_limImage', text: '#s_limText', audio: '#s_limAudio', video: '#s_limVideo', doc: '#s_limDoc' };

function guessKind(file) {
  const m = String(file.type || '');
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (m.startsWith('audio/') || ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ogv'].includes(ext)) return 'video';
  if (m.startsWith('text/') || m === 'application/json'
    || ['txt', 'md', 'json', 'csv', 'yaml', 'yml', 'log', 'js', 'css', 'html'].includes(ext)) return 'text';
  return 'doc';
}

function kindBadge(it) {
  return el('span', 'badge', KIND_LABEL[it.kind] || '文件');
}

function openUrl(url) {
  window.open(url, '_blank', 'noopener');
}

// ---- hero (left, focused item) ----

function buildHero(it) {
  const card = el('article', 'hero-card');
  card.dataset.id = it.id;

  const media = el('div', 'hero-media');
  if (it.kind === 'image') {
    const img = el('img');
    img.src = it.url;
    img.alt = it.filename || it.id;
    img.loading = 'eager';
    media.appendChild(img);
    media.onclick = () => openUrl(it.url);
  } else if (it.kind === 'video') {
    const v = el('video');
    v.src = it.url;
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    media.appendChild(v);
    media.style.cursor = 'default';
  } else if (it.kind === 'text') {
    const pre = el('pre', 'preview');
    pre.textContent = '加载预览…';
    media.appendChild(pre);
    media.style.cursor = 'text';
    loadTextPreview(it, pre, 200);
  } else {
    media.appendChild(el('div', 'kind-icon', kindIcon(it.mime, it.filename)));
    media.onclick = () => openUrl(it.url);
  }
  card.appendChild(media);

  // title + meta
  const title = el('div', 'hero-title');
  title.appendChild(kindBadge(it));
  title.appendChild(el('div', 'name', it.filename || `${it.id}.${it.ext}`));
  card.appendChild(title);

  const sub = el('div', 'hero-sub');
  const dims = it.w && it.h ? `${it.w}×${it.h}` : '';
  const when = it.createdAt ? new Date(it.createdAt).toLocaleString() : '';
  sub.appendChild(el('span', '', [dims, it.sizeLabel, when].filter(Boolean).join(' · ')));
  const ttl = el('span', 'ttl');
  ttl.dataset.expire = String(it.expireAt || 0);
  sub.appendChild(ttl);
  if (it.hits) sub.appendChild(el('span', '', `直链被访问 ${it.hits} 次`));
  card.appendChild(sub);

  // actions
  const actions = el('div', 'hero-actions');
  const dl = el('button', 'btn', '⬇ 保存');
  dl.title = '下载并保留原文件名';
  dl.onclick = () => downloadItem(it);
  const copyUrl = el('button', 'btn', '🔗 复制直链');
  copyUrl.onclick = () => copyWithBtn(it.url, copyUrl);
  const open = el('button', 'btn', '↗ 打开');
  open.onclick = () => openUrl(it.url);
  const del = el('button', 'btn danger', '删除');
  del.onclick = () => deleteImage(it, card);
  actions.append(dl, copyUrl, open, del);
  card.appendChild(actions);

  // citation block — big & prominent, the thing you actually paste to an LLM
  const cite = el('div', 'cite');
  const head = el('div', 'cite-head');
  head.appendChild(el('span', 'cite-label', '引用格式'));
  const fmtSelect = el('select', 'fmt-select');
  fillFormatSelect(fmtSelect, currentFormatId());
  head.appendChild(fmtSelect);
  cite.appendChild(head);

  const area = el('textarea', 'cite-text');
  area.readOnly = true;
  area.value = buildOutput(it, fmtSelect.value);
  area.onfocus = () => area.select();
  fmtSelect.onchange = () => setGlobalFormat(fmtSelect.value);
  cite.appendChild(area);

  const copyBtn = el('button', 'btn primary btn-copy-primary', '复制引用');
  copyBtn.id = 'heroCopyBtn';
  copyBtn.onclick = async () => {
    const ok = await copyToClipboard(buildOutput(it, fmtSelect.value));
    btnFlash(copyBtn, ok);
  };
  cite.appendChild(copyBtn);
  card.appendChild(cite);

  // direct link row
  card.appendChild(buildRow('直链', it.url, () => it.url, null));
  return card;
}

function refreshOutputs() {
  const cur = currentFormatId();
  // hero card
  const heroCard = $('#heroSlot .hero-card');
  if (heroCard) {
    const it = items.find((x) => x.id === heroCard.dataset.id);
    const area = heroCard.querySelector('.cite-text');
    const sel = heroCard.querySelector('.fmt-select');
    if (it && area && sel) {
      if (sel.value !== cur) sel.value = cur;
      area.value = buildOutput(it, sel.value);
    }
  }
  // history cards (per-card select follows the global one)
  document.querySelectorAll('.mini-card[data-id]').forEach((card) => {
    const it = items.find((x) => x.id === card.dataset.id);
    if (!it) return;
    const sel = card.querySelector('.fmt-select');
    const input = card.querySelector('.row-input');
    if (sel && sel.value !== cur) sel.value = cur;
    if (input) input.value = buildOutput(it, sel ? sel.value : cur);
  });
}

function pulsePrimaryCopy() {
  const btn = $('#heroCopyBtn');
  if (!btn) return;
  btn.classList.remove('pulse');
  void btn.offsetWidth; // restart animation
  btn.classList.add('pulse');
}

// ---- history card (right cascade, original-density cascade rows) ----

function createMini(it) {
  const card = el('article', 'mini-card');
  card.dataset.id = it.id;
  card.title = '点击置顶到左侧';

  const thumb = el('div', 'mini-thumb');
  if (it.kind === 'image') {
    const img = el('img');
    img.src = it.url;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
  } else if (it.kind === 'video') {
    const v = el('video');
    v.src = it.url;
    v.muted = true;
    v.preload = 'metadata';
    v.playsInline = true;
    thumb.appendChild(v);
  } else {
    thumb.appendChild(el('div', 'kind-icon', kindIcon(it.mime, it.filename)));
  }

  const body = el('div', 'mini-body');

  // meta line (same density as the old cascade cards)
  const meta = el('div', 'mini-meta');
  const dims = it.w && it.h ? `${it.w}×${it.h}` : '';
  if (it.kind !== 'image') meta.appendChild(kindBadge(it));
  meta.appendChild(el('div', 'mini-name', it.filename || `${it.id}.${it.ext}`));
  meta.appendChild(el('span', 'muted', [dims, it.sizeLabel].filter(Boolean).join(' · ')));
  const ttl = el('span', 'ttl');
  ttl.dataset.expire = String(it.expireAt || 0);
  meta.appendChild(ttl);
  const dl = el('button', 'btn tiny', '⬇ 保存');
  dl.title = '下载并保留原文件名';
  dl.onclick = (e) => { e.stopPropagation(); downloadItem(it); };
  meta.appendChild(dl);
  const del = el('button', 'btn tiny danger', '删除');
  del.onclick = (e) => { e.stopPropagation(); deleteImage(it, card); };
  meta.appendChild(del);
  body.appendChild(meta);

  // direct link row
  body.appendChild(buildRow('直链', it.url, () => it.url, null));

  // formatted output row (card-level format selector)
  const fmtSelect = el('select', 'fmt-select');
  fillFormatSelect(fmtSelect, currentFormatId());
  const outInput = buildRow('格式', buildOutput(it, fmtSelect.value), () => buildOutput(it, fmtSelect.value), fmtSelect);
  fmtSelect.onchange = (e) => {
    e.stopPropagation();
    outInput.querySelector('input').value = buildOutput(it, fmtSelect.value);
  };
  body.appendChild(outInput);

  if (it.kind === 'text') {
    const pre = el('pre', 'preview');
    body.appendChild(pre);
    loadTextPreview(it, pre, 6);
  }

  card.append(thumb, body);
  card.onclick = (e) => {
    if (e.target.closest('input, select, button, textarea, a')) return;
    focusItem(it.id);
  };
  return card;
}

async function loadTextPreview(it, pre, maxLines) {
  if ((it.size || 0) > 200 * 1024) { pre.textContent = '（文件过大，跳过预览）'; return; }
  try {
    const res = await fetch(it.url);
    const text = (await res.text()).trim();
    if (!text) { pre.textContent = '（空文件）'; return; }
    pre.textContent = text.split('\n').slice(0, maxLines || 6).join('\n').slice(0, 2000);
  } catch {
    pre.textContent = '（预览不可用）';
  }
}

function buildRow(labelText, value, refresh, extraControl) {
  const row = el('div', 'row');
  const label = el('label', 'row-label', labelText);
  if (extraControl) label.appendChild(extraControl);
  const input = el('input');
  input.className = 'row-input';
  input.readOnly = true;
  input.value = value;
  input.onfocus = () => input.select();
  const copy = el('button', 'btn tiny', '复制');
  copy.onclick = () => copyWithBtn(refresh ? refresh() : input.value, copy);
  row.append(label, input, copy);
  return row;
}

function buildOutput(it, fmtId) {
  const id = fmtId || currentFormatId();
  return (it.formats && it.formats[id]) || it.url;
}

async function deleteImage(it, card) {
  try {
    await api(`/api/images/${it.id}`, { method: 'DELETE' });
    items = items.filter((x) => x.id !== it.id);
    if (focusId === it.id) focusId = items[0]?.id || null;
    renderAll();
  } catch (e) {
    toast('删除失败: ' + e.message, true);
    card?.remove?.();
  }
}

function downloadItem(it) {
  const a = el('a');
  a.href = it.url;
  a.download = (cfg.keepOriginalName && it.filename) ? it.filename : `${it.id}.${it.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已下载: ' + a.download);
}

function tickCountdown(node) {
  const exp = Number(node.dataset.expire || 0);
  node.textContent = exp ? remainLabel(exp) : '永久保留';
  node.classList.toggle('soon', exp > 0 && exp - Date.now() < 3600000);
}

function tickCountdowns() {
  document.querySelectorAll('.ttl').forEach(tickCountdown);
}

function remainLabel(exp) {
  const ms = exp - Date.now();
  if (ms <= 0) return '已过期';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `剩余 ${d}天${h}小时`;
  if (h > 0) return `剩余 ${h}小时${m}分`;
  return `剩余 ${Math.max(1, m)}分钟`;
}

// ------------------------------------------------------------- formats UI

function currentFormatId() {
  if (globalFormatId && formats.some((f) => f.id === globalFormatId)) return globalFormatId;
  return cfg?.defaultFormat || formats[0]?.id;
}

function setGlobalFormat(id) {
  globalFormatId = id;
  syncFormatSelects();
  refreshOutputs();
}

function fillFormatSelect(sel, value) {
  sel.innerHTML = '';
  for (const f of formats) {
    const opt = el('option', '', f.name || f.id);
    opt.value = f.id;
    sel.appendChild(opt);
  }
  if (value) sel.value = value;
}

function syncFormatSelects() {
  const cur = currentFormatId();
  fillFormatSelect($('#globalFormat'), cur);
  const heroSel = $('#heroSlot .fmt-select');
  if (heroSel) fillFormatSelect(heroSel, cur);
}

// ------------------------------------------------------------- settings UI

function fillSettingsForm() {
  $('#s_autoCopy').checked = autoCopy;
  $('#s_baseUrl').value = cfg.baseUrl || '';
  $('#s_retention').value = cfg.retention || '7d';
  $('#s_cleanInterval').value = cfg.cleanInterval || '5m';
  $('#s_sliding').checked = !!cfg.slidingExpiry;
  $('#s_keepName').checked = !!cfg.keepOriginalName;
  const lim = cfg.sizeLimitsMb || {};
  for (const [kind, sel] of Object.entries(LIMIT_INPUTS)) $(sel).value = lim[kind] ?? '';
  const st = cfg.stats || {};
  const bytes = st.bytes ? (st.bytes / 1024 / 1024).toFixed(2) + ' MB' : '0 B';
  const swept = st.lastSweep?.at ? new Date(st.lastSweep.at).toLocaleTimeString() : '—';
  $('#statsLine').textContent = `文件 ${st.count || 0} 个，共 ${bytes} · 上次清理: ${swept}`;
  renderPwState();
  renderFormatRows();
}

function renderPwState() {
  const set = !!cfg.hasPassword;
  const node = $('#pwState');
  node.textContent = set ? '当前状态：已设置密码（查看历史 / 上传 / 设置需登录）' : '当前状态：未设置（开放模式，任何人可用）';
  node.classList.toggle('on', set);
}

function renderFormatRows() {
  const box = $('#formatRows');
  box.innerHTML = '';
  for (const f of formats) {
    const row = el('div', 'fmt-row');
    row.dataset.id = f.id;
    const name = el('input');
    name.placeholder = '名称';
    name.value = f.name || f.id;
    const tpl = el('input');
    tpl.placeholder = '模板，如 [image:{url}]';
    tpl.value = f.template;
    const isDefault = el('input');
    isDefault.type = 'radio';
    isDefault.name = 'defaultFormat';
    isDefault.checked = f.id === (cfg.defaultFormat || formats[0]?.id);
    isDefault.title = '设为默认格式';
    const del = el('button', 'btn tiny danger', '✕');
    del.onclick = () => {
      if (formats.length <= 1) return toast('至少保留一个模板', true);
      formats = formats.filter((x) => x.id !== f.id);
      renderFormatRows();
    };
    row.append(isDefault, name, tpl, del);
    box.appendChild(row);
  }
}

function collectFormats() {
  const rows = [...document.querySelectorAll('.fmt-row')];
  const out = [];
  let defaultId = null;
  for (const row of rows) {
    const name = row.children[1].value.trim();
    const template = row.children[2].value.trim();
    if (!template) continue;
    const id = row.dataset.id;
    out.push({ id, name: name || id, template });
    if (row.children[0].checked) defaultId = id;
  }
  return { formats: out, defaultFormat: defaultId || out[0]?.id };
}

async function saveSettings() {
  autoCopy = $('#s_autoCopy').checked;
  localStorage.setItem(LS_AUTOCOPY, autoCopy ? '1' : '0');

  const { formats: fmts, defaultFormat } = collectFormats();
  const payload = {
    baseUrl: $('#s_baseUrl').value.trim(),
    retention: $('#s_retention').value,
    cleanInterval: $('#s_cleanInterval').value,
    slidingExpiry: $('#s_sliding').checked,
    keepOriginalName: $('#s_keepName').checked,
    sizeLimitsMb: Object.fromEntries(
      Object.entries(LIMIT_INPUTS).map(([kind, sel]) => [kind, Number($(sel).value)]),
    ),
    formats: fmts,
    defaultFormat,
  };
  const cur = $('#s_pwCurrent').value;
  const next = $('#s_pwNext').value;
  if (cur || next) toast('密码请用左侧「设置 / 修改密码」按钮单独保存');
  try {
    cfg = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    formats = cfg.formats;
    for (const it of items) it.formats = (await reRenderFormats(it)) || it.formats;
    syncFormatSelects();
    fillSettingsForm();
    renderAll();
    toast('设置已保存');
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  }
}

// ---- password management (saved immediately, independent of 保存以上设置) ----

async function setPassword() {
  const cur = $('#s_pwCurrent').value;
  const next = $('#s_pwNext').value;
  const confirm2 = $('#s_pwConfirm').value;
  if (!next) return toast('请输入新密码', true);
  if (next.length < 4) return toast('密码至少 4 位', true);
  if (next !== confirm2) return toast('两次输入的新密码不一致', true);
  if (cfg.hasPassword && !cur) return toast('修改密码需先输入当前密码', true);
  try {
    cfg = await api('/api/config', { method: 'PUT', body: JSON.stringify({ password: { current: cur, next } }) });
    authRequired = true;
    loggedIn = true; // server issued a fresh session cookie
    clearPwInputs();
    renderPwState();
    updateAuthButton();
    toast('密码已设置，立即生效（本浏览器已登录，验证请用无痕窗口或点右上角退出）');
  } catch (e) {
    toast(e.message, true);
  }
}

async function clearPassword() {
  if (!cfg.hasPassword) return toast('当前本来就没设密码', true);
  const cur = $('#s_pwCurrent').value;
  if (!cur) return toast('清除密码需输入当前密码', true);
  if (!confirm('确定清除访问密码？之后任何人可管理此服务')) return;
  try {
    cfg = await api('/api/config', { method: 'PUT', body: JSON.stringify({ password: { current: cur, clear: true } }) });
    authRequired = false;
    loggedIn = true;
    clearPwInputs();
    renderPwState();
    updateAuthButton();
    toast('密码已清除，回到开放模式');
  } catch (e) {
    toast(e.message, true);
  }
}

function clearPwInputs() {
  $('#s_pwCurrent').value = '';
  $('#s_pwNext').value = '';
  $('#s_pwConfirm').value = '';
}

// After template changes the server is source of truth — ask it to re-render lazily
// by reusing stored records through /api/images is overkill; instead compute locally.
async function reRenderFormats(it) {
  // Local re-render mirrors server placeholders; kept simple & consistent for UI purposes.
  const out = {};
  const url = it.url;
  for (const f of formats) {
    out[f.id] = String(f.template)
      .replaceAll('{url}', url)
      .replaceAll('{id}', it.id)
      .replaceAll('{filename}', it.filename || `${it.id}.${it.ext}`)
      .replaceAll('{ext}', it.ext)
      .replaceAll('{size}', it.sizeLabel || '')
      .replaceAll('{w}', String(it.w || 0))
      .replaceAll('{h}', String(it.h || 0))
      .replaceAll('{time}', new Date(it.createdAt).toISOString());
  }
  return out;
}

// ------------------------------------------------------------------ auth

function updateAuthButton() {
  const btn = $('#authBtn');
  if (!authRequired) {
    btn.textContent = '开放模式';
    btn.disabled = true;
    btn.classList.add('ghost');
  } else {
    btn.disabled = false;
    btn.textContent = loggedIn ? '退出' : '登录';
  }
}

function showLogin() {
  $('#loginModal').classList.remove('hidden');
  $('#loginPassword').focus();
}

function hideLogin() {
  $('#loginModal').classList.add('hidden');
}

async function doLogin() {
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#loginPassword').value }) });
    loggedIn = true;
    $('#loginPassword').value = '';
    hideLogin();
    updateAuthButton();
    await loadConfig();
    await loadImages();
  } catch (e) {
    toast(e.message, true);
  }
}

async function doLogout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  loggedIn = false;
  updateAuthButton();
  showLogin();
}

// -------------------------------------------------------------- clipboard

/** Write text to the clipboard. Works on plain http too (execCommand fallback).
 *  Resolves true on success. */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function btnFlash(btn, ok) {
  const old = btn.textContent;
  btn.textContent = ok ? '已复制 ✓' : '复制失败';
  btn.classList.toggle('err', !ok);
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove('err');
  }, 1200);
}

async function copyWithBtn(text, btn) {
  const ok = await copyToClipboard(text);
  if (btn) btnFlash(btn, ok);
  if (!ok) toast('复制失败，请手动选中文本复制', true);
}

function copyAll() {
  const sel = currentFormatId();
  const lines = items.slice().reverse().map((it) => buildOutput(it, sel)); // 旧 → 新
  if (!lines.length) return toast('还没有文件', true);
  copyWithBtn(lines.join('\n'), null).then(() => toast(`已复制 ${lines.length} 条`));
}

// ---------------------------------------------------------------- events

function bindGlobalEvents() {
  // paste screenshots / files / plain text
  document.addEventListener('paste', (e) => {
    const files = [];
    for (const item of e.clipboardData?.items || []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
      return;
    }
    // plain-text paste (outside inputs) → temp .txt entry, like a pastebin
    const text = e.clipboardData?.getData('text/plain') || '';
    const tag = document.activeElement?.tagName || '';
    if (text.trim() && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      handleFiles([new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' })]);
    }
  });

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('#dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').classList.add('hidden');
    handleFiles([...(e.dataTransfer?.files || [])]);
  });

  // buttons
  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#emptyState').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  };
  $('#copyAllBtn').onclick = copyAll;
  $('#settingsBtn').onclick = async () => {
    await loadConfig();
    $('#settingsDrawer').classList.remove('hidden');
  };
  $('#closeSettings').onclick = () => $('#settingsDrawer').classList.add('hidden');
  $('#saveSettings').onclick = saveSettings;
  $('#setPwBtn').onclick = setPassword;
  $('#clearPwBtn').onclick = clearPassword;
  $('#s_autoCopy').onchange = () => {
    autoCopy = $('#s_autoCopy').checked;
    localStorage.setItem(LS_AUTOCOPY, autoCopy ? '1' : '0');
  };
  $('#addFormatBtn').onclick = () => {
    const id = 'custom' + Date.now().toString(36);
    formats.push({ id, name: '自定义', template: '[image:{url}]' });
    renderFormatRows();
  };
  $('#purgeBtn').onclick = async () => {
    if (!confirm('确定清空全部文件？此操作不可恢复')) return;
    try {
      await api('/api/purge', { method: 'POST' });
      items = [];
      focusId = null;
      renderAll();
      toast('已清空');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#authBtn').onclick = () => (loggedIn ? doLogout() : showLogin());
  $('#loginSubmit').onclick = doLogin;
  $('#loginPassword').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('#globalFormat').onchange = () => setGlobalFormat($('#globalFormat').value);
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
function toast(msg, isErr = false, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.toggle('ok', !isErr && kind === 'ok');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
