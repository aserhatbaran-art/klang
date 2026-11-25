// Klang – schlanker Offline-Audioplayer (ohne Abhängigkeiten)

const $ = (sel, root = document) => root.querySelector(sel);
const audio = $('#audio');
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
const TIMER_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90];
const FADE_MS = 15000;
const wide = matchMedia('(min-width: 960px)');

const isAudio = f => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const initial = s => ([...s.trim()][0] || '♪').toUpperCase();
const cleanName = n => n.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || n;

/* ================= IndexedDB ================= */
let dbPromise;
function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('klang', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('folders', { keyPath: 'id' });
      d.createObjectStore('tracks', { keyPath: 'id' }).createIndex('folderId', 'folderId');
      d.createObjectStore('blobs');
      d.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); dbPromise = null; };
      resolve(d);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}
// Führt fn in einer Transaktion aus; löst nach dem Commit auf.
async function run(stores, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = e => reject(e.target.error || t.error);
    t.onabort = () => reject(t.error || new DOMException('Transaktion abgebrochen', 'AbortError'));
  });
}
const dbGetAll = s => run([s], 'readonly', t => t.objectStore(s).getAll());
const dbGet = (s, k) => run([s], 'readonly', t => t.objectStore(s).get(k));
const dbPut = (s, v, k) => run([s], 'readwrite', t => { t.objectStore(s).put(v, k); });

/* ================= Zustand ================= */
const S = {
  folders: [],
  tracks: new Map(),
  folderId: null,      // geöffneter Ordner
  queueFolder: null,   // Ordner, aus dem gespielt wird
  order: [],           // Titel-IDs in Ordnerreihenfolge
  queue: [],           // tatsächliche Abspielreihenfolge
  qi: -1,
  current: null,
  shuffle: false,
  repeat: 'off',       // off | all | one
  speed: 1,
};
const T = { mode: null, end: 0 }; // Schlaftimer: null | 'time' | 'track'

const tracksOf = fid => [...S.tracks.values()]
  .filter(t => t.folderId === fid)
  .sort((a, b) => collator.compare(a.name, b.name));
const folderById = id => S.folders.find(f => f.id === id);

/* ================= DOM-Helfer ================= */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter(c => c != null && c !== false));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const setIcon = (btn, name) => btn.querySelector('use').setAttribute('href', '#i-' + name);
const eq = () => h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
function hue(str) { let x = 0; for (const c of str) x = (x * 31 + c.codePointAt(0)) >>> 0; return x % 360; }

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtTotal(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return '< 1 Min.';
  return m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60} Min.` : `${m} Min.`;
}
function fmtBytes(b) {
  if (b < 1e6) return Math.round(b / 1e3) + ' KB';
  if (b < 1e9) return Math.round(b / 1e6) + ' MB';
  return (b / 1e9).toFixed(1).replace('.', ',') + ' GB';
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ================= Ebenen + Zurück-Taste (Android) ================= */
const layers = [];
const popWaiters = [];
function pushLayer(close) {
  layers.push(close);
  history.pushState({ layer: layers.length }, '');
}
function closeTop() {
  return new Promise(res => {
    if (!layers.length) return res();
    popWaiters.push(res);
    history.back();
  });
}
addEventListener('popstate', e => {
  // Nur so viele Ebenen schließen, wie der History-Eintrag vorgibt
  const target = e.state?.layer ?? 0;
  while (layers.length > target) layers.pop()();
  popWaiters.shift()?.();
});

/* ================= Sheets (Menüs & Dialoge) ================= */
const sheet = $('#sheet');
const sheetPanel = $('#sheetPanel');
function sheetUI(title, build) {
  return new Promise(resolve => {
    let settled = false;
    const finish = async v => {
      if (settled) return;
      settled = true;
      await closeTop();
      resolve(v);
    };
    sheetPanel.replaceChildren(
      h('div', { class: 'grip' }),
      title ? h('h3', { class: 'sheet-title', id: 'sheetTitle' }, title) : null,
      ...build(finish),
    );
    sheetPanel.setAttribute('aria-labelledby', 'sheetTitle');
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
    sheet.onclick = e => { if (e.target === sheet) finish(null); };
    pushLayer(() => {
      sheet.classList.remove('open');
      setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 300);
      if (!settled) { settled = true; resolve(null); }
    });
    setTimeout(() => (sheetPanel.querySelector('input') || sheetPanel.querySelector('button'))?.focus({ preventScroll: true }), 60);
  });
}
const actionSheet = (title, items) => sheetUI(title, finish => [
  h('div', { class: 'sheet-list' }, items.map((it, i) => h('button', {
    type: 'button',
    class: 'sheet-item' + (it.danger ? ' danger' : '') + (it.active ? ' active' : ''),
    onclick: () => finish(it.value ?? i),
  }, it.icon ? icon(it.icon) : null, h('span', {}, it.label), it.hint ? h('span', { class: 'hint' }, it.hint) : null))),
]);
const inputSheet = (title, value = '', ok = 'Speichern') => sheetUI(title, finish => {
  const inp = h('input', { class: 'field', type: 'text', value, maxLength: 80, placeholder: 'Name', autocomplete: 'off', enterKeyHint: 'done' });
  const submit = () => { const v = inp.value.trim(); if (v) finish(v); else inp.focus(); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  return [inp, h('div', { class: 'sheet-actions' },
    h('button', { class: 'pill', type: 'button', onclick: () => finish(null) }, 'Abbrechen'),
    h('button', { class: 'pill primary', type: 'button', onclick: submit }, ok))];
});
const confirmSheet = (title, text, ok = 'Löschen') => sheetUI(title, finish => [
  h('p', { class: 'sheet-text' }, text),
  h('div', { class: 'sheet-actions' },
    h('button', { class: 'pill', type: 'button', onclick: () => finish(false) }, 'Abbrechen'),
    h('button', { class: 'pill danger', type: 'button', onclick: () => finish(true) }, ok)),
]).then(v => v === true);

/* ================= Ansichten ================= */
function showView(v) {
  $('#libraryView').hidden = v !== 'library';
  $('#folderView').hidden = v !== 'folder';
  $('#backBtn').hidden = v === 'library';
  $('#addBtn').setAttribute('aria-label', v === 'library' ? 'Ordner hinzufügen' : 'Dateien hinzufügen');
  if (v === 'library') $('#title').textContent = 'Klang';
}

function renderLibrary() {
  const items = [...S.folders].sort((a, b) => collator.compare(a.name, b.name)).map(f => {
    const ts = tracksOf(f.id);
    const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
    const art = h('span', { class: 'fart', 'aria-hidden': 'true' }, initial(f.name),
      S.current?.folderId === f.id ? eq() : null);
    art.style.setProperty('--h', hue(f.name));
    return h('li', {}, h('button', { class: 'folder', type: 'button', onclick: () => openFolder(f.id) },
      art,
      h('span', { class: 'fname' }, f.name),
      h('span', { class: 'fmeta' }, `${ts.length} Titel` + (total ? ' · ' + fmtTotal(total) : ''))));
  });
  $('#folderList').replaceChildren(...items);
  $('#emptyLib').hidden = S.folders.length > 0;
  updateStorage();
}

function openFolder(id) {
  S.folderId = id;
  renderFolder();
  showView('folder');
  scrollTo(0, 0);
  pushLayer(() => { S.folderId = null; showView('library'); renderLibrary(); });
}

function renderFolder() {
  const f = folderById(S.folderId);
  if (!f) return;
  const ts = tracksOf(f.id);
  const total = ts.reduce((s, t) => s + (t.duration || 0), 0);
  $('#title').textContent = f.name;
  $('#folderCount').textContent = `${ts.length} Titel` + (total ? ' · ' + fmtTotal(total) : '');
  $('#trackList').replaceChildren(...ts.map((t, i) => {
    const cur = S.current?.id === t.id;
    return h('li', { class: 'track' + (cur ? ' current' : '') },
      h('button', { class: 'track-main', type: 'button', onclick: () => playFolder(f.id, i) },
        h('span', { class: 'tnum' }, cur ? eq() : String(i + 1)),
        h('span', { class: 'tname' }, t.name),
        h('span', { class: 'tdur' }, t.duration ? fmt(t.duration) : '')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Optionen: ' + t.name, onclick: () => trackMenu(t) }, icon('more')));
  }));
  $('#emptyFolder').hidden = ts.length > 0;
  $('#playAllBtn').disabled = $('#shuffleAllBtn').disabled = !ts.length;
}

function refresh() {
  if (S.folderId) renderFolder(); else renderLibrary();
}

async function updateStorage() {
  if (!navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    $('#storageInfo').textContent = quota ? `${fmtBytes(usage)} belegt · max. ${fmtBytes(quota)}` : '';
  } catch { /* egal */ }
}

/* ================= Ordner & Import ================= */
async function createFolder(name) {
  const f = { id: crypto.randomUUID(), name, created: Date.now() };
  await dbPut('folders', f);
  S.folders.push(f);
  return f;
}

async function newFolder() {
  const name = await inputSheet('Neuer Ordner', '', 'Erstellen');
  if (!name) return;
  const f = await createFolder(name);
  renderLibrary();
  openFolder(f.id);
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* optional */ }
}

function probeDuration(file) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = d => {
      if (done) return;
      done = true;
      clearTimeout(to);
      a.removeAttribute('src');
      a.load(); // Ressource sofort freigeben
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    const to = setTimeout(() => finish(0), 5000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    a.src = url;
  });
}

let importing = false;
// Importiert Dateien in einen Ordner. Gibt die Anzahl neuer Titel zurück.
async function importFiles(files, folderId, progress = { done: 0, total: files.length }) {
  const existing = new Set(tracksOf(folderId).map(t => t.file + '|' + t.size));
  let added = 0;
  for (const f of files) {
    if (!folderById(folderId)) throw new Error('Ordner wurde gelöscht – Import abgebrochen');
    progress.done++;
    toast(`Importiere ${progress.done} / ${progress.total} …`, 0);
    const key = f.name + '|' + f.size;
    if (existing.has(key)) continue;
    const t = {
      id: crypto.randomUUID(), folderId,
      name: cleanName(f.name), file: f.name, size: f.size, type: f.type,
      duration: await probeDuration(f), added: Date.now(),
    };
    try {
      await run(['tracks', 'blobs'], 'readwrite', tx => {
        tx.objectStore('tracks').put(t);
        tx.objectStore('blobs').put(f, t.id);
      });
    } catch (e) {
      const full = e?.name === 'QuotaExceededError';
      throw new Error(full ? 'Speicher voll – Import abgebrochen' : `Import fehlgeschlagen: ${f.name}`);
    }
    S.tracks.set(t.id, t);
    existing.add(key);
    added++;
  }
  return added;
}

async function withImport(fn) {
  if (importing) return toast('Import läuft bereits …');
  importing = true;
  await requestPersist();
  try {
    const { added, skipped } = await fn();
    toast(added ? `${added} Titel hinzugefügt` + (skipped ? ` · ${skipped} übersprungen` : '') : 'Keine neuen Titel');
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    importing = false;
    syncQueue();
    refresh();
  }
}

function addFilesToFolder(fileList, folderId) {
  const files = [...fileList].filter(isAudio).sort((a, b) => collator.compare(a.name, b.name));
  if (!files.length) return toast('Keine Audiodateien gefunden');
  return withImport(async () => {
    const added = await importFiles(files, folderId);
    return { added, skipped: files.length - added };
  });
}

function importDirectory(fileList) {
  const groups = new Map();
  for (const f of fileList) {
    if (!isAudio(f)) continue;
    const parts = (f.webkitRelativePath || f.name).split('/');
    parts.pop();
    const name = parts.slice(1).join(' / ') || parts[0] || 'Importiert';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  if (!groups.size) return toast('Keine Audiodateien im Ordner gefunden');
  return withImport(async () => {
    const total = [...groups.values()].reduce((s, g) => s + g.length, 0);
    const progress = { done: 0, total };
    let added = 0;
    for (const [name, files] of groups) {
      files.sort((a, b) => collator.compare(a.name, b.name));
      const folder = S.folders.find(f => f.name === name) || await createFolder(name);
      added += await importFiles(files, folder.id, progress);
    }
    return { added, skipped: total - added };
  });
}

const dirSupported = 'webkitdirectory' in HTMLInputElement.prototype;
function pickFiles() { $('#fileInput').click(); }
function pickDirectory() { $('#dirInput').click(); }

async function addMenu() {
  const items = [{ label: 'Neuer Ordner', icon: 'folder-plus', value: 'new' }];
  if (dirSupported) items.push({ label: 'Ordner vom Gerät importieren', icon: 'upload', value: 'dir' });
  const v = await actionSheet('Hinzufügen', items);
  if (v === 'new') newFolder();
  else if (v === 'dir') pickDirectory();
}

const busyImporting = () => (importing ? (toast('Bitte warten, bis der Import fertig ist'), true) : false);

async function folderMenu() {
  const f = folderById(S.folderId);
  if (!f || busyImporting()) return;
  const v = await actionSheet(f.name, [
    { label: 'Dateien hinzufügen', icon: 'plus', value: 'add' },
    { label: 'Umbenennen', icon: 'edit', value: 'rename' },
    { label: 'Ordner löschen', icon: 'trash', value: 'delete', danger: true },
  ]);
  if (v === 'add') pickFiles();
  else if (v === 'rename') {
    const name = await inputSheet('Ordner umbenennen', f.name);
    if (!name || name === f.name) return;
    f.name = name;
    await dbPut('folders', f);
    renderFolder();
    if (S.current?.folderId === f.id) updateNowPlaying();
  } else if (v === 'delete') {
    deleteFolder(f);
  }
}

async function deleteFolder(f) {
  const ok = await confirmSheet(`„${f.name}“ löschen?`,
    'Der Ordner und alle darin gespeicherten Titel werden aus der App entfernt. Die Originaldateien auf deinem Gerät bleiben erhalten.');
  if (!ok || busyImporting()) return;
  const ids = tracksOf(f.id).map(t => t.id);
  try {
    await run(['folders', 'tracks', 'blobs'], 'readwrite', tx => {
      tx.objectStore('folders').delete(f.id);
      for (const id of ids) { tx.objectStore('tracks').delete(id); tx.objectStore('blobs').delete(id); }
    });
  } catch { return toast('Löschen fehlgeschlagen', 4000); }
  if (S.current && ids.includes(S.current.id)) stopPlayback();
  ids.forEach(id => S.tracks.delete(id));
  S.folders = S.folders.filter(x => x !== f);
  if (S.folderId === f.id) await closeTop();
  renderLibrary();
  toast('Ordner gelöscht');
}

async function trackMenu(t) {
  if (busyImporting()) return;
  const others = S.folders.filter(f => f.id !== t.folderId);
  const items = [{ label: 'Umbenennen', icon: 'edit', value: 'rename' }];
  if (others.length) items.push({ label: 'In anderen Ordner verschieben', icon: 'move', value: 'move' });
  items.push({ label: 'Entfernen', icon: 'trash', value: 'delete', danger: true });
  const v = await actionSheet(t.name, items);
  if (v === 'rename') {
    const name = await inputSheet('Titel umbenennen', t.name);
    if (!name || name === t.name) return;
    t.name = name;
    await dbPut('tracks', t);
    if (S.current?.id === t.id) updateNowPlaying();
  } else if (v === 'move') {
    const target = await actionSheet('Verschieben nach …',
      [...others].sort((a, b) => collator.compare(a.name, b.name)).map(f => ({ label: f.name, icon: 'folder', value: f.id })));
    if (!target) return;
    t.folderId = target;
    await dbPut('tracks', t);
    toast(`Verschoben nach „${folderById(target).name}“`);
  } else if (v === 'delete') {
    if (!await confirmSheet(`„${t.name}“ entfernen?`, 'Der Titel wird aus der App gelöscht. Die Originaldatei bleibt erhalten.', 'Entfernen')) return;
    try {
      await run(['tracks', 'blobs'], 'readwrite', tx => {
        tx.objectStore('tracks').delete(t.id);
        tx.objectStore('blobs').delete(t.id);
      });
    } catch { return toast('Entfernen fehlgeschlagen', 4000); }
    if (S.current?.id === t.id) stopPlayback();
    S.tracks.delete(t.id);
  } else return;
  syncQueue();
  refresh();
}

/* ================= Wiedergabe ================= */
let objectUrl = null;
let loadToken = 0;
let pendingAt = 0;

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(currentId) {
  if (S.shuffle) {
    const rest = shuffled(S.order.filter(id => id !== currentId));
    S.queue = currentId ? [currentId, ...rest] : rest;
    S.qi = 0;
  } else {
    S.queue = [...S.order];
    S.qi = Math.max(0, S.queue.indexOf(currentId));
  }
}

// Gleicht Warteschlange nach Änderungen an der Bibliothek ab.
function syncQueue() {
  if (!S.current) return;
  S.order = S.queueFolder ? tracksOf(S.queueFolder).map(t => t.id) : S.order.filter(id => S.tracks.has(id));
  if (S.shuffle) {
    const known = S.queue.filter(id => S.order.includes(id) || id === S.current.id);
    S.queue = [...known, ...S.order.filter(id => !known.includes(id))];
  } else if (S.order.includes(S.current.id)) {
    S.queue = [...S.order];
  } else {
    // Laufender Titel wurde verschoben: an alter Stelle vor dem bisherigen Nachfolger einreihen
    const nextId = S.queue.slice(S.qi + 1).find(id => S.order.includes(id));
    const at = nextId ? S.order.indexOf(nextId) : S.order.length;
    S.queue = [...S.order.slice(0, at), S.current.id, ...S.order.slice(at)];
  }
  S.qi = S.queue.indexOf(S.current.id);
  saveState();
}

async function playFolder(fid, index = 0, shuffle = S.shuffle) {
  const ts = tracksOf(fid);
  if (!ts.length) return;
  S.queueFolder = fid;
  S.order = ts.map(t => t.id);
  S.shuffle = shuffle;
  syncModes();
  buildQueue(S.order[clamp(index, 0, ts.length - 1)]);
  await loadCurrent({ autoplay: true });
}

async function loadCurrent({ autoplay = true, at = 0 } = {}) {
  const id = S.queue[S.qi];
  const t = S.tracks.get(id);
  if (!t) return stopPlayback();
  const token = ++loadToken;
  let blob;
  try { blob = await dbGet('blobs', id); } catch { blob = null; }
  if (token !== loadToken) return;
  if (!blob) {
    toast('Datei nicht gefunden', 4000);
    return stopPlayback();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  S.current = t;
  pendingAt = at;
  audio.src = objectUrl;
  audio.defaultPlaybackRate = audio.playbackRate = S.speed;
  audio.addEventListener('loadedmetadata', () => {
    if (token !== loadToken) return;
    if (at > 0 && at < audio.duration - 2) audio.currentTime = at;
    pendingAt = 0;
    if (!t.duration && Number.isFinite(audio.duration)) {
      t.duration = audio.duration;
      dbPut('tracks', t).catch(() => {});
    }
    updateProgress();
    positionState();
  }, { once: true });
  updateNowPlaying();
  if (autoplay) {
    try { await audio.play(); } catch (e) {
      if (e.name === 'NotSupportedError') toast('Diese Datei kann nicht abgespielt werden', 4000);
      syncPlayState();
    }
  }
  saveState();
}

function stopPlayback() {
  loadToken++;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  S.current = null;
  S.queue = []; S.order = []; S.qi = -1; S.queueFolder = null;
  if (player.classList.contains('open')) closeTop();
  updateNowPlaying();
  saveState();
}

function togglePlay() {
  if (!S.current) {
    if (S.folderId) playFolder(S.folderId);
    return;
  }
  if (audio.paused) audio.play().catch(() => toast('Wiedergabe nicht möglich'));
  else audio.pause();
}

function next(auto = false) {
  if (!S.queue.length) return;
  const play = auto || !audio.paused;
  if (S.qi < S.queue.length - 1) {
    S.qi++;
    loadCurrent({ autoplay: play });
  } else if (S.repeat === 'all') {
    if (S.shuffle) S.queue = shuffled(S.order);
    S.qi = 0;
    loadCurrent({ autoplay: play });
  } else {
    // Ende der Liste: auf den Anfang zurück, pausiert
    if (S.shuffle) S.queue = shuffled(S.order);
    S.qi = 0;
    loadCurrent({ autoplay: false });
  }
}

function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3 || (S.qi <= 0 && S.repeat !== 'all')) {
    audio.currentTime = 0;
    return;
  }
  const play = !audio.paused;
  S.qi = S.qi > 0 ? S.qi - 1 : S.queue.length - 1;
  loadCurrent({ autoplay: play });
}

function seekBy(d) {
  if (!S.current || !Number.isFinite(audio.duration)) return;
  audio.currentTime = clamp(audio.currentTime + d, 0, audio.duration);
}

function toggleShuffle() {
  S.shuffle = !S.shuffle;
  if (S.current) {
    if (!S.order.includes(S.current.id)) S.order = [S.current.id, ...S.order];
    buildQueue(S.current.id);
  }
  syncModes();
  saveState();
  toast(S.shuffle ? 'Zufallswiedergabe an' : 'Zufallswiedergabe aus', 1500);
}
function cycleRepeat() {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat];
  syncModes();
  saveState();
  toast({ off: 'Wiederholen aus', all: 'Ordner wiederholen', one: 'Titel wiederholen' }[S.repeat], 1500);
}
function cycleSpeed() {
  S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
  audio.defaultPlaybackRate = audio.playbackRate = S.speed;
  syncModes();
  saveState();
}

/* ================= Anzeige ================= */
const player = $('#player');
const seek = $('#seek');
let seeking = false;

function updateNowPlaying() {
  const t = S.current;
  const f = t && folderById(t.folderId);
  document.body.classList.toggle('has-track', !!t);
  $('#miniPlayer').hidden = !t;
  const title = t ? t.name : 'Nichts ausgewählt';
  const sub = t ? (f?.name || '') : 'Wähle einen Ordner und tippe auf einen Titel.';
  $('#miniTitle').textContent = $('#pTitle').textContent = title;
  $('#miniSub').textContent = $('#pSub').textContent = sub;
  const key = f?.name || t?.name || '';
  for (const el of [$('#art'), $('#miniArt')]) {
    if (t) el.style.setProperty('--h', hue(key)); else el.style.removeProperty('--h');
  }
  $('#artLetter').textContent = t ? initial(key) : '♪';
  document.title = t ? `${t.name} · Klang` : 'Klang';
  for (const id of ['prevBtn', 'nextBtn', 'rewBtn', 'fwdBtn']) $('#' + id).disabled = !t;
  seek.disabled = !t;
  mediaMeta(t, f);
  updateProgress();
  syncPlayState();
  refresh();
}

function updateProgress() {
  const d = audio.duration;
  const c = audio.readyState ? audio.currentTime : pendingAt;
  const p = Number.isFinite(d) && d > 0 ? clamp(c / d, 0, 1) : 0;
  if (!seeking) {
    seek.value = Math.round(p * 1000);
    seek.style.setProperty('--p', p * 100 + '%');
    $('#cur').textContent = fmt(c);
  }
  $('#dur').textContent = fmt(Number.isFinite(d) ? d : S.current?.duration || 0);
  $('#miniBar').style.transform = `scaleX(${p})`;
}

function syncPlayState() {
  const playing = !audio.paused && !!S.current;
  document.body.classList.toggle('is-playing', playing);
  for (const b of [$('#playBtn'), $('#miniPlay')]) {
    setIcon(b, playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = S.current ? (playing ? 'playing' : 'paused') : 'none';
}

function syncModes() {
  const sh = $('#shuffleBtn');
  sh.classList.toggle('on', S.shuffle);
  sh.setAttribute('aria-pressed', String(S.shuffle));
  const rp = $('#repeatBtn');
  setIcon(rp, S.repeat === 'one' ? 'repeat-one' : 'repeat');
  rp.classList.toggle('on', S.repeat !== 'off');
  rp.setAttribute('aria-label', { off: 'Wiederholen: aus', all: 'Wiederholen: Ordner', one: 'Wiederholen: Titel' }[S.repeat]);
  $('#speedVal').textContent = String(S.speed).replace('.', ',') + '×';
  $('#speedBtn').classList.toggle('on', S.speed !== 1);
  $('#speedBtn').setAttribute('aria-label', `Geschwindigkeit ${S.speed}-fach`);
}

/* ---------- Player öffnen/schließen (mobil) ---------- */
function openPlayer() {
  if (wide.matches || !S.current || player.classList.contains('open')) return;
  player.classList.add('open');
  player.inert = false;
  pushLayer(() => { player.classList.remove('open'); syncWide(); });
}
function syncWide() {
  player.inert = !wide.matches && !player.classList.contains('open');
}
wide.addEventListener('change', syncWide);

// Nach unten wischen schließt den Player
{
  const zone = $('#playerDrag');
  let startY = null;
  zone.addEventListener('pointerdown', e => {
    if (wide.matches || e.target.closest('button') || e.button > 0) return;
    startY = e.clientY;
    player.style.transition = 'none';
    zone.setPointerCapture(e.pointerId);
  });
  zone.addEventListener('pointermove', e => {
    if (startY == null) return;
    player.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  const end = e => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    startY = null;
    player.style.transition = '';
    player.style.transform = '';
    if (dy > 110) closeTop();
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}

/* ================= Media Session (Sperrbildschirm) ================= */
function mediaMeta(t, f) {
  if (!('mediaSession' in navigator)) return;
  if (!t) { navigator.mediaSession.metadata = null; return; }
  const src = n => new URL(n, location.href).href;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.name,
    artist: f?.name || '',
    album: f?.name || '',
    artwork: [
      { src: src('icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: src('icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
  });
}
function positionState() {
  const ms = navigator.mediaSession;
  const d = audio.duration;
  if (!ms?.setPositionState || !Number.isFinite(d) || d <= 0) return;
  try { ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, d) }); } catch { /* ignorieren */ }
}
if ('mediaSession' in navigator) {
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* nicht unterstützt */ } };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', prev);
  set('nexttrack', () => next());
  set('seekbackward', d => seekBy(-(d.seekOffset || 15)));
  set('seekforward', d => seekBy(d.seekOffset || 30));
  set('seekto', d => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; positionState(); });
}

/* ================= Schlaftimer ================= */
function setTimer(v) {
  if (v === 'off') {
    clearTimer();
    toast('Schlaftimer aus', 1500);
    return;
  }
  if (v === 'track') {
    T.mode = 'track'; T.end = 0;
    toast('Stoppt am Ende des Titels');
  } else if (v === 'plus5') {
    T.mode = 'time'; T.end = Math.max(T.end, Date.now()) + 5 * 60000;
    toast('+5 Minuten');
  } else {
    T.mode = 'time'; T.end = Date.now() + v * 60000;
    toast(`Schlaftimer: ${v} Minuten`);
  }
  if (!audio.paused) audio.volume = 1;
  syncTimer();
}
function clearTimer() {
  T.mode = null;
  T.end = 0;
  if (!audio.paused) audio.volume = 1;
  syncTimer();
}
function timerLeft() { return Math.max(0, T.end - Date.now()); }
function tickTimer() {
  if (T.mode !== 'time') return;
  const left = timerLeft();
  if (left <= 0) {
    audio.pause();
    clearTimer();
    toast('Schlaftimer: Wiedergabe beendet', 4000);
    return;
  }
  // sanft ausblenden (quadratisch wirkt gleichmäßiger fürs Ohr)
  if (!audio.paused) audio.volume = left < FADE_MS ? Math.max(0, (left / FADE_MS) ** 2) : 1;
  syncTimer();
}
function timerText() {
  if (T.mode === 'time') return fmt(Math.ceil(timerLeft() / 1000));
  if (T.mode === 'track') return 'Titelende';
  return '';
}
function syncTimer() {
  const txt = timerText();
  $('#timerBtn').classList.toggle('on', !!T.mode);
  $('#timerLabel').textContent = txt || 'Timer';
  $('#miniTimer').hidden = !T.mode;
  $('#miniTimerText').textContent = T.mode === 'time' ? txt : '';
  const now = $('#timerNow');
  if (now) now.textContent = txt ? `Aktiv · ${txt}` : '';
}
function timerMenu() {
  return sheetUI('Schlaftimer', finish => {
    const chips = TIMER_MINUTES.map(m => h('button', { class: 'chip', type: 'button', onclick: () => finish(m) }, String(m), h('small', {}, 'Min.')));
    const extra = [h('button', { class: 'chip wide' + (T.mode === 'track' ? ' on' : ''), type: 'button', onclick: () => finish('track') }, icon('music'), 'Ende des Titels')];
    if (T.mode === 'time') extra.push(h('button', { class: 'chip wide', type: 'button', onclick: () => finish('plus5') }, icon('plus'), '5 Minuten'));
    if (T.mode) extra.push(h('button', { class: 'chip wide off', type: 'button', onclick: () => finish('off') }, 'Ausschalten'));
    return [
      h('p', { class: 'timer-now', id: 'timerNow' }, T.mode ? `Aktiv · ${timerText()}` : ''),
      h('div', { class: 'chips' }, chips, extra),
    ];
  }).then(v => { if (v != null) setTimer(v); });
}
setInterval(tickTimer, 1000);

/* ================= Zustand speichern ================= */
let lastSave = 0;
let ready = false; // erst nach restore() speichern, sonst wird der Zustand überschrieben
function saveState() {
  if (!ready) return;
  lastSave = Date.now();
  const time = audio.readyState ? audio.currentTime : pendingAt;
  dbPut('kv', {
    queue: S.queue, order: S.order, qi: S.qi, queueFolder: S.queueFolder,
    time: Number.isFinite(time) ? time : 0,
    shuffle: S.shuffle, repeat: S.repeat, speed: S.speed,
  }, 'state').catch(() => {});
}

async function restore() {
  let st = null;
  try { st = await dbGet('kv', 'state'); } catch { /* leer */ }
  if (!st) return;
  S.shuffle = st.shuffle === true;
  S.repeat = ['off', 'all', 'one'].includes(st.repeat) ? st.repeat : 'off';
  S.speed = SPEEDS.includes(st.speed) ? st.speed : 1;
  syncModes();
  const lastId = Array.isArray(st.queue) ? st.queue[st.qi] : null;
  const queue = (st.queue || []).filter(id => S.tracks.has(id));
  if (!queue.length) return;
  S.queue = queue;
  S.order = (st.order || []).filter(id => S.tracks.has(id));
  S.queueFolder = folderById(st.queueFolder) ? st.queueFolder : null;
  S.qi = Math.max(0, queue.indexOf(lastId));
  await loadCurrent({ autoplay: false, at: queue[S.qi] === lastId ? Number(st.time) || 0 : 0 });
}

/* ================= Ereignisse ================= */
audio.addEventListener('play', () => {
  if (T.mode !== 'time' || timerLeft() > FADE_MS) audio.volume = 1;
  syncPlayState(); positionState();
});
audio.addEventListener('pause', () => { syncPlayState(); positionState(); saveState(); });
audio.addEventListener('timeupdate', () => {
  updateProgress();
  tickTimer();
  if (Date.now() - lastSave > 5000) saveState();
});
audio.addEventListener('durationchange', updateProgress);
audio.addEventListener('seeked', positionState);
audio.addEventListener('ratechange', positionState);
audio.addEventListener('ended', () => {
  if (T.mode === 'track') {
    clearTimer();
    toast('Schlaftimer: Wiedergabe beendet', 4000);
    return;
  }
  if (S.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  next(true);
});
audio.addEventListener('error', () => {
  if (S.current && audio.getAttribute('src')) toast('Format wird nicht unterstützt', 4000);
});

seek.addEventListener('input', () => {
  seeking = true;
  const p = seek.value / 1000;
  seek.style.setProperty('--p', p * 100 + '%');
  $('#cur').textContent = fmt(p * (audio.duration || 0));
});
seek.addEventListener('change', () => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (seek.value / 1000) * audio.duration;
  seeking = false;
});
for (const ev of ['pointercancel', 'blur']) seek.addEventListener(ev, () => { seeking = false; updateProgress(); });

$('#addBtn').addEventListener('click', () => (S.folderId ? pickFiles() : addMenu()));
$('#backBtn').addEventListener('click', () => closeTop());
$('#emptyNewBtn').addEventListener('click', newFolder);
$('#emptyImportBtn').addEventListener('click', pickDirectory);
$('#emptyImportBtn').hidden = !dirSupported;
$('#emptyAddBtn').addEventListener('click', pickFiles);
$('#playAllBtn').addEventListener('click', () => playFolder(S.folderId, 0, false));
$('#shuffleAllBtn').addEventListener('click', () => {
  const n = tracksOf(S.folderId).length;
  playFolder(S.folderId, Math.floor(Math.random() * n), true);
});
$('#folderMoreBtn').addEventListener('click', folderMenu);
$('#miniOpen').addEventListener('click', openPlayer);
$('#miniPlay').addEventListener('click', togglePlay);
$('#closePlayer').addEventListener('click', () => closeTop());
$('#playBtn').addEventListener('click', togglePlay);
$('#prevBtn').addEventListener('click', prev);
$('#nextBtn').addEventListener('click', () => next());
$('#shuffleBtn').addEventListener('click', toggleShuffle);
$('#repeatBtn').addEventListener('click', cycleRepeat);
$('#rewBtn').addEventListener('click', () => seekBy(-15));
$('#fwdBtn').addEventListener('click', () => seekBy(30));
$('#speedBtn').addEventListener('click', cycleSpeed);
$('#timerBtn').addEventListener('click', timerMenu);

$('#fileInput').addEventListener('change', e => {
  const files = e.target.files;
  if (files?.length && S.folderId) addFilesToFolder(files, S.folderId);
  e.target.value = '';
});
$('#dirInput').addEventListener('change', e => {
  const files = e.target.files;
  if (files?.length) importDirectory(files);
  e.target.value = '';
});

// Drag & Drop (Desktop): Dateien in den geöffneten Ordner ziehen
// (verhindert immer, dass der Browser die Datei selbst öffnet und die App verlässt)
addEventListener('dragover', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  if (S.folderId) document.body.classList.add('dragging');
});
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', e => {
  document.body.classList.remove('dragging');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  if (S.folderId) addFilesToFolder(e.dataTransfer.files, S.folderId);
  else toast('Öffne zuerst einen Ordner');
});

// Tastatur (Desktop)
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea') || !sheet.hidden) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') seekBy(10);
  else if (e.key === 'ArrowLeft') seekBy(-10);
});

addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState(); });
addEventListener('pagehide', saveState);

/* ================= Start ================= */
async function init() {
  syncModes();
  syncTimer();
  syncWide();
  try {
    const [folders, tracks] = await Promise.all([dbGetAll('folders'), dbGetAll('tracks')]);
    S.folders = folders;
    const ids = new Set(folders.map(f => f.id));
    const orphans = tracks.filter(t => !ids.has(t.folderId));
    for (const t of tracks) if (ids.has(t.folderId)) S.tracks.set(t.id, t);
    if (orphans.length) {
      // Reste abgebrochener Vorgänge aufräumen
      run(['tracks', 'blobs'], 'readwrite', tx => {
        for (const t of orphans) { tx.objectStore('tracks').delete(t.id); tx.objectStore('blobs').delete(t.id); }
      }).catch(() => {});
    }
  } catch {
    toast('Speicher nicht verfügbar (privater Modus?)', 6000);
  }
  // Nach Neuladen: alte Ebenen-Einträge der History zurückspulen
  const stale = history.state?.layer;
  if (stale > 0) history.go(-stale);
  else history.replaceState(null, '');
  showView('library');
  updateNowPlaying();
  await restore();
  ready = true;
}
init();

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
