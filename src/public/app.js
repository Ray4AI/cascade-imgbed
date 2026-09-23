/* CascadeImg frontend — vanilla JS, no build step. */
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let cfg = null;          // /api/config payload
let items = [];          // cascade items, newest first
let formats = [];        // template list
let authRequired = false;
let loggedIn = true;

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
  renderFormatSelects();
  fillSettingsForm();
}

async function loadImages() {
  const data = await api('/api/images?limit=200');
  items = data.items || [];
  const stream = $('#stream');
  stream.querySelectorAll('.card').forEach((c) => c.remove());
  for (const it of items.slice().reverse()) stream.appendChild(createCard(it)); // reverse → newest on top
  toggleEmpty();
}

function toggleEmpty() {
  $('#emptyState').style.display = items.length ? 'none' : '';
}

// --------------------------------------------------------------- upload

async function uploadFile(file) {
  if (!file) return;
  // client-side pre-check against per-kind limits (server re-validates after sniffing)
  const kind = guessKind(file);
  const lim = (cfg.sizeLimitsMb || {})[kind];
  if (lim && file.size > lim * 1048576) {
    toast(`${KIND_LABEL[kind] || '文件'}类上限 ${lim} MB，当前 ${(file.size / 1048576).toFixed(1)} MB`, true);
    return;
  }
  const card = createPendingCard(file);
  $('#stream').prepend(card);
  toggleEmpty();
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
    if (res.status === 401) { card.remove(); showLogin(); return; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    card.replaceWith(createCard(data));
    items.unshift(data);
    toggleEmpty();
  } catch (e) {
    card.remove();
    toggleEmpty();
    toast('上传失败: ' + e.message, true);
  }
}

// ---------------------------------------------------------------- cards

function createPendingCard(file) {
  const card = el('article', 'card pending');
  const thumb = el('div', 'thumb');
  if (file.type.startsWith('image/')) {
    const img = el('img');
    img.alt = '';
    try { img.src = URL.createObjectURL(file); } catch { /* ignore */ }
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el('div', 'kind-icon', kindIcon(file.type, file.name)));
  }
  const body = el('div', 'body');
  body.appendChild(el('div', 'meta', `正在上传 ${file.name || '文件'}…`));
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

function createCard(it) {
  const card = el('article', 'card');
  card.dataset.id = it.id;

  const thumb = el('div', 'thumb');
  if (it.kind === 'image') {
    const img = el('img');
    img.src = it.url;
    img.alt = it.filename || it.id;
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

  const body = el('div', 'body');

  // meta line
  const meta = el('div', 'meta');
  const dims = it.w && it.h ? `${it.w}×${it.h}` : '';
  if (it.kind !== 'image') meta.appendChild(el('span', 'badge', KIND_LABEL[it.kind] || '文件'));
  meta.appendChild(el('span', 'name', it.filename || `${it.id}.${it.ext}`));
  meta.appendChild(el('span', 'muted', [dims, it.sizeLabel].filter(Boolean).join(' · ')));
  const ttl = el('span', 'ttl');
  ttl.dataset.expire = String(it.expireAt || 0);
  meta.appendChild(ttl);
  const dl = el('button', 'btn tiny', '⬇ 保存');
  dl.title = '下载并保留原文件名';
  dl.onclick = () => downloadItem(it);
  meta.appendChild(dl);
  const del = el('button', 'btn tiny danger', '删除');
  del.onclick = () => deleteImage(it, card);
  meta.appendChild(del);
  body.appendChild(meta);

  // direct link row
  body.appendChild(buildRow('直链', it.url, () => it.url, null));

  // formatted output row
  const fmtSelect = el('select', 'fmt-select');
  for (const f of formats) {
    const opt = el('option', '', f.name || f.id);
    opt.value = f.id;
    fmtSelect.appendChild(opt);
  }
  fmtSelect.value = it.defaultFormat || cfg.defaultFormat || formats[0]?.id;
  const outInput = buildRow('格式', buildOutput(it, fmtSelect.value), () => buildOutput(it, fmtSelect.value), fmtSelect);
  fmtSelect.onchange = () => {
    outInput.querySelector('input').value = buildOutput(it, fmtSelect.value);
  };
  body.appendChild(outInput);

  card.append(thumb, body);
  tickCountdown(ttl);
  if (it.kind === 'text') loadTextPreview(it, body);
  return card;
}

async function loadTextPreview(it, body) {
  if ((it.size || 0) > 200 * 1024) return; // skip huge texts
  try {
    const res = await fetch(it.url);
    const text = (await res.text()).trim();
    if (!text) return;
    const pre = el('pre', 'preview');
    pre.textContent = text.split('\n').slice(0, 6).join('\n').slice(0, 500);
    body.appendChild(pre);
  } catch { /* preview is optional */ }
}

function buildRow(labelText, value, refresh, extraControl) {
  const row = el('div', 'row');
  const label = el('label', 'row-label', labelText);
  if (extraControl) label.appendChild(extraControl);
  const input = el('input');
  input.readOnly = true;
  input.value = value;
  input.onfocus = () => input.select();
  const copy = el('button', 'btn tiny', '复制');
  copy.onclick = () => copyText(refresh ? refresh() : input.value, copy);
  row.append(label, input, copy);
  return row;
}

function buildOutput(it, fmtId) {
  const id = fmtId || cfg.defaultFormat || formats[0]?.id;
  return (it.formats && it.formats[id]) || it.url;
}

async function deleteImage(it, card) {
  try {
    await api(`/api/images/${it.id}`, { method: 'DELETE' });
    items = items.filter((x) => x.id !== it.id);
    card.remove();
    toggleEmpty();
  } catch (e) {
    toast('删除失败: ' + e.message, true);
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

function renderFormatSelects() {
  const sel = $('#globalFormat');
  sel.innerHTML = '';
  for (const f of formats) {
    const opt = el('option', '', f.name || f.id);
    opt.value = f.id;
    sel.appendChild(opt);
  }
  sel.value = cfg.defaultFormat || formats[0]?.id || '';
  document.querySelectorAll('.card .fmt-select').forEach((s) => {
    const cur = s.value;
    s.innerHTML = '';
    for (const f of formats) {
      const opt = el('option', '', f.name || f.id);
      opt.value = f.id;
      s.appendChild(opt);
    }
    if (formats.some((f) => f.id === cur)) s.value = cur;
  });
}

// ------------------------------------------------------------- settings UI

function fillSettingsForm() {
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
  $('#statsLine').textContent = `图片 ${st.count || 0} 张，共 ${bytes} · 上次清理: ${swept}`;
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
    renderFormatSelects();
    fillSettingsForm();
    // re-render card outputs with new templates
    for (const it of items) {
      it.formats = (await reRenderFormats(it)) || it.formats;
    }
    document.querySelectorAll('.card').forEach((card) => {
      const it = items.find((x) => x.id === card.dataset.id);
      if (!it) return;
      const sel = card.querySelector('.fmt-select');
      const input = card.querySelectorAll('.row')[1]?.querySelector('input');
      if (sel && input) input.value = buildOutput(it, sel.value);
      const urlInput = card.querySelectorAll('.row')[0]?.querySelector('input');
      if (urlInput) urlInput.value = it.url;
    });
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

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

function copyAll() {
  const sel = $('#globalFormat').value;
  const lines = items.slice().reverse().map((it) => buildOutput(it, sel)); // 旧 → 新
  if (!lines.length) return toast('还没有图片', true);
  copyText(lines.join('\n'));
  toast(`已复制 ${lines.length} 条`);
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
      files.forEach(uploadFile);
      return;
    }
    // plain-text paste (outside inputs) → temp .txt entry, like a pastebin
    const text = e.clipboardData?.getData('text/plain') || '';
    const tag = document.activeElement?.tagName || '';
    if (text.trim() && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      uploadFile(new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' }));
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
    for (const f of e.dataTransfer?.files || []) uploadFile(f);
  });

  // buttons
  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#emptyState').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    [...e.target.files].forEach(uploadFile);
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
  $('#addFormatBtn').onclick = () => {
    const id = 'custom' + Date.now().toString(36);
    formats.push({ id, name: '自定义', template: '[image:{url}]' });
    renderFormatRows();
  };
  $('#purgeBtn').onclick = async () => {
    if (!confirm('确定清空全部图片？此操作不可恢复')) return;
    try {
      await api('/api/purge', { method: 'POST' });
      items = [];
      document.querySelectorAll('.card').forEach((c) => c.remove());
      toggleEmpty();
      toast('已清空');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#authBtn').onclick = () => (loggedIn ? doLogout() : showLogin());
  $('#loginSubmit').onclick = doLogin;
  $('#loginPassword').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('#globalFormat').onchange = () => {
    document.querySelectorAll('.card').forEach((card) => {
      const sel = card.querySelector('.fmt-select');
      if (sel) {
        sel.value = $('#globalFormat').value;
        sel.onchange();
      }
    });
  };
}

// ------------------------------------------------------------------ toast

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
