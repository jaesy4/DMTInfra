'use strict';
/* Document Tracker – all screens. Data lives in SQLite + a file vault via the Rust side. */

// ================= backend bridge =================
const invoke = (cmd, args = {}) =>
  window.__TAURI__ ? window.__TAURI__.core.invoke(cmd, args) : window.__mockInvoke(cmd, args);
const q = (sql, params = []) => invoke('db_query', { sql, params });
const ex = (sql, params = []) => invoke('db_execute', { sql, params });
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

// ================= constants & settings =================
const CLOSED = ['Released', 'Filed / Archived', 'Cancelled'];
const DEFAULT_ACTIONS = ['Received', 'For Review', 'For Approval', 'For Signature', 'Approved', 'Returned for Revision',
  'For Payment', 'Paid', 'Forwarded', 'Released', 'Filed / Archived', 'Cancelled'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let settings = {
  company_name: '',
  office_name: 'PMO',
  user_name: '',
  doc_prefix: 'DOC',
  default_due_days: '3',
  expiry_warn_days: '30',
  locations: 'PMO\nMr. Sabanal\nAccounting\nEngineering\nPurchasing\nLegal',
  categories: 'Plans / Drawings\nPermits & Licenses\nContracts\nBilling / Invoices\nLetters / Memos\nReports\nSpecifications\nOthers',
  actions: DEFAULT_ACTIONS.join('\n'),
  device_id: '',
};
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

const state = {
  view: 'dashboard',
  docId: null,
  search: '',
  fStatus: '',
  fLocation: '',
  fProject: '',
  fCategory: '',
  fFlag: '',
  showClosed: false,
};

// ================= utilities =================
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const nowStamp = () => { const d = new Date(); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseYmd = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const fmtDate = (s) => { if (!s) return ''; const d = parseYmd(s); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const fmtStamp = (s) => {
  if (!s) return '';
  const t = s.slice(11, 16);
  if (!t) return fmtDate(s);
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${fmtDate(s)} ${h}:${pad(m)} ${ap}`;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const nz = (v) => { const t = (v ?? '').toString().trim(); return t === '' ? null : t; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));
const opts = (list, sel) => list.map((o) => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');
const datalist = (id, list) => `<datalist id="${id}">${list.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const baseName = (p) => String(p).split(/[\\/]/).pop();
const stripExt = (n) => n.replace(/\.[^.]+$/, '');

function formData(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) if (!k.endsWith('[]')) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}

function openModal({ title, body, okText = 'Save', cancelText = 'Cancel', wide = false, onOk, onOpen, danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">${esc(title)}</div>
      <form class="modal-body" novalidate>${body}
        <div class="modal-foot">
          ${cancelText ? `<button type="button" class="btn ghost" data-cancel>${esc(cancelText)}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(okText)}</button>
        </div>
      </form></div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    let busy = false;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && document.body.lastElementChild === wrap) close(null); };
    document.addEventListener('keydown', onKey);
    const cancelBtn = wrap.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      try {
        const r = onOk ? await onOk(form) : true;
        if (r !== false) close(r === undefined ? true : r);
      } catch (err) {
        toast(String(err && err.message ? err.message : err), 'err');
      } finally {
        busy = false;
      }
    });
    if (onOpen) onOpen(form);
    const first = form.querySelector('[autofocus]') ||
      form.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea');
    if (first) first.focus();
  });
}
const confirmBox = (html, okText = 'OK', title = 'Please confirm', danger = false) =>
  openModal({ title, body: `<div>${html}</div>`, okText, danger });

// ================= domain helpers =================
async function loadSettings() {
  const rows = await q('SELECT key, value FROM settings');
  for (const r of rows) settings[r.key] = r.value ?? '';
  if (!settings.device_id) {
    settings.device_id = uuid();
    await saveSetting('device_id', settings.device_id);
  }
  $('#brand-company').textContent = settings.company_name || '';
}
const saveSetting = (k, v) =>
  ex('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);

const isClosed = (d) => CLOSED.includes(d.status);
const isOverdue = (d) => !isClosed(d) && d.due_date && d.due_date < today();
function expiryInfo(d) {
  if (!d.expiry_date) return null;
  const left = daysBetween(today(), d.expiry_date);
  if (left < 0) return { cls: 'expired', text: `EXPIRED ${fmtDate(d.expiry_date)}` };
  if (left <= (Number(settings.expiry_warn_days) || 30)) return { cls: 'soon', text: `Expires in ${plural(left, 'day')}` };
  return null;
}

function statusBadge(s) {
  const cls = {
    Approved: 'green', Paid: 'green', Released: 'gray', 'Filed / Archived': 'gray', Cancelled: 'gray',
    'Returned for Revision': 'red', 'For Approval': 'amber', 'For Signature': 'amber', 'For Review': 'blue',
    'For Payment': 'purple', Received: 'teal', Forwarded: 'blue',
  }[s] || '';
  return s ? `<span class="badge ${cls}">${esc(s)}</span>` : '';
}

function whereCell(d) {
  if (!d.location) return '<span class="muted">—</span>';
  const days = d.location_since ? daysBetween(d.location_since, today()) : null;
  const since = days === null ? '' : days === 0 ? 'since today' : `for ${plural(days, 'day')}`;
  return `<div class="where"><span class="who">${esc(d.location)}</span><span class="since">${since}</span></div>`;
}

function dueCell(d) {
  if (isClosed(d)) return '<span class="muted small">closed</span>';
  if (!d.due_date) return '<span class="muted">—</span>';
  if (isOverdue(d)) return `<span class="flag">OVERDUE · ${plural(daysBetween(d.due_date, today()), 'day')}</span>`;
  const left = daysBetween(today(), d.due_date);
  return `${fmtDate(d.due_date)}<div class="muted small">${left === 0 ? 'due today' : `${plural(left, 'day')} left`}</div>`;
}

async function nextDocNos(count) {
  const prefix = (settings.doc_prefix || 'DOC').trim();
  const year = today().slice(0, 4);
  const base = `${prefix}-${year}-`;
  const rows = await q('SELECT doc_no FROM documents WHERE doc_no LIKE ?', [base + '%']);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.doc_no).slice(base.length), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return Array.from({ length: count }, (_, i) => `${base}${String(max + 1 + i).padStart(4, '0')}`);
}

function nextRev(r) {
  if (!r) return '0';
  if (/^\d+$/.test(r)) return String(Number(r) + 1);
  if (/^[A-Y]$/i.test(r)) return String.fromCharCode(r.toUpperCase().charCodeAt(0) + 1);
  return r + '-1';
}

async function addMovement(docId, m) {
  const t = nowStamp();
  await ex(`INSERT INTO movements (id, document_id, kind, at, action, from_loc, to_loc, due_date, remarks, by_user, updated_at, device_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [uuid(), docId, m.kind || 'route', m.at || t, nz(m.action), nz(m.from_loc), nz(m.to_loc), nz(m.due_date),
    nz(m.remarks), nz(m.by_user ?? settings.user_name), t, settings.device_id]);
}

async function knownLocations() {
  const rows = await q(`SELECT DISTINCT to_loc AS v FROM movements WHERE IFNULL(to_loc,'') != '' AND deleted_at IS NULL`);
  return [...new Set([...lines(settings.locations), ...rows.map((r) => r.v)])];
}
async function knownProjects() {
  return (await q(`SELECT DISTINCT project AS v FROM documents WHERE IFNULL(project,'') != '' AND deleted_at IS NULL ORDER BY v`)).map((r) => r.v);
}

async function refreshBadge() {
  const r = await one(`SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND due_date IS NOT NULL AND due_date != ''
    AND due_date < ? AND IFNULL(status,'') NOT IN (${CLOSED.map(() => '?').join(',')})`, [today(), ...CLOSED]);
  const b = $('#nav-overdue');
  if (r && r.n > 0) { b.textContent = r.n; b.classList.remove('hidden'); } else b.classList.add('hidden');
}

// ================= navigation =================
const VIEWS = {};
async function render() {
  document.querySelectorAll('#nav button').forEach((b) => {
    const v = state.view === 'doc' ? 'register' : state.view;
    b.classList.toggle('active', b.dataset.view === v);
  });
  const main = $('#main');
  try { await VIEWS[state.view](main); } catch (e) {
    main.innerHTML = `<div class="banner red">Something went wrong: ${esc(e)}</div>`;
    console.error(e);
  }
  refreshBadge().catch(() => {});
}
function go(view, extra = {}) {
  Object.assign(state, { view }, extra);
  $('#main').scrollTop = 0;
  render();
}

// ================= document list query =================
function docFilterSql(f = state) {
  const cond = ['d.deleted_at IS NULL'], params = [];
  if (f.search && f.search.trim()) {
    const s = `%${f.search.trim()}%`;
    cond.push(`(IFNULL(d.doc_no,'') LIKE ? OR d.title LIKE ? OR IFNULL(d.tags,'') LIKE ? OR IFNULL(d.project,'') LIKE ?
      OR IFNULL(d.description,'') LIKE ? OR IFNULL(d.location,'') LIKE ?)`);
    params.push(s, s, s, s, s, s);
  }
  if (f.fStatus) { cond.push('d.status = ?'); params.push(f.fStatus); }
  if (f.fLocation) { cond.push('d.location = ?'); params.push(f.fLocation); }
  if (f.fProject) { cond.push('d.project = ?'); params.push(f.fProject); }
  if (f.fCategory) { cond.push('d.category = ?'); params.push(f.fCategory); }
  if (f.fFlag === 'overdue') {
    cond.push(`d.due_date IS NOT NULL AND d.due_date != '' AND d.due_date < ?`); params.push(today());
  }
  if (f.fFlag === 'expiry') {
    cond.push(`d.expiry_date IS NOT NULL AND d.expiry_date != '' AND d.expiry_date <= ?`);
    params.push(addDays(today(), Number(settings.expiry_warn_days) || 30));
  }
  if (!f.showClosed && !f.fStatus) {
    cond.push(`IFNULL(d.status,'') NOT IN (${CLOSED.map(() => '?').join(',')})`); params.push(...CLOSED);
  }
  return { where: 'WHERE ' + cond.join(' AND '), params };
}
const DOC_ORDER = `ORDER BY (CASE WHEN d.due_date IS NOT NULL AND d.due_date != '' AND d.due_date < '#T#' THEN 0 ELSE 1 END),
  d.due_date IS NULL OR d.due_date = '', d.due_date, d.updated_at DESC`;
async function loadDocs(f = state) {
  const { where, params } = docFilterSql(f);
  return q(`SELECT d.*, (SELECT COUNT(*) FROM files fl WHERE fl.document_id = d.id AND fl.deleted_at IS NULL) AS file_n
    FROM documents d ${where} ${DOC_ORDER.replace('#T#', today())}`, params);
}

function docTable(rows, { compact = false } = {}) {
  if (!rows.length) return `<div class="empty">No documents.</div>`;
  return `<div class="table-wrap"><table class="list"><thead><tr>
    <th>Doc No.</th><th>Title</th>${compact ? '' : '<th>Project</th>'}<th>Rev</th><th>Status</th><th>Now with</th><th>Due back</th>
    ${compact ? '' : '<th>Expiry</th>'}<th></th></tr></thead><tbody>
    ${rows.map((d) => {
      const exp = expiryInfo(d);
      return `<tr class="${isOverdue(d) ? 'overdue' : ''}">
        <td><a class="link docno" data-act="openDoc" data-id="${d.id}">${esc(d.doc_no || '—')}</a></td>
        <td class="title-cell"><a class="link" data-act="openDoc" data-id="${d.id}">${esc(d.title)}</a>
          <div class="muted small">${esc(d.category || '')}${d.file_n ? ` · ${plural(d.file_n, 'file')}` : ' · paper / no file'}</div></td>
        ${compact ? '' : `<td>${esc(d.project)}</td>`}
        <td>${esc(d.current_rev)}</td>
        <td>${statusBadge(d.status)}</td>
        <td>${whereCell(d)}</td>
        <td class="nowrap">${dueCell(d)}</td>
        ${compact ? '' : `<td class="nowrap">${exp ? `<span class="pill-exp ${exp.cls}">${esc(exp.text)}</span>` : (d.expiry_date ? fmtDate(d.expiry_date) : '')}</td>`}
        <td class="nowrap"><button class="btn small primary" data-act="route" data-id="${d.id}">Update</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ================= VIEW: dashboard =================
VIEWS.dashboard = async (el) => {
  const t = today();
  const closedQ = CLOSED.map(() => '?').join(',');
  const c = await one(`SELECT
      (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND IFNULL(status,'') NOT IN (${closedQ})) AS active,
      (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND IFNULL(status,'') NOT IN (${closedQ}) AND due_date != '' AND due_date < ?) AS overdue,
      (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND status = 'For Approval') AS pending,
      (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL AND expiry_date != '' AND expiry_date <= ?) AS expiring`,
  [...CLOSED, ...CLOSED, t, addDays(t, Number(settings.expiry_warn_days) || 30)]);
  const byLoc = await q(`SELECT IFNULL(location,'(not set)') AS loc, COUNT(*) AS n,
      SUM(CASE WHEN due_date != '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue_n,
      MIN(location_since) AS oldest
    FROM documents WHERE deleted_at IS NULL AND IFNULL(status,'') NOT IN (${closedQ})
    GROUP BY loc ORDER BY overdue_n DESC, n DESC`, [t, ...CLOSED]);
  const overdue = await loadDocs({ fFlag: 'overdue' });
  const recent = await q(`SELECT m.*, d.doc_no, d.title FROM movements m JOIN documents d ON d.id = m.document_id
    WHERE d.deleted_at IS NULL AND m.kind = 'route' ORDER BY m.at DESC, m.rowid DESC LIMIT 8`);

  el.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="sub">${fmtDate(t)}</div></div>
      <div class="actions"><button class="btn primary" data-act="newDoc">+ New Document</button></div></div>
    <div class="stats">
      <div class="stat ${c.overdue ? 'red' : ''}" data-act="filterGo" data-flag="overdue"><div class="num">${c.overdue}</div><div class="lbl">Overdue (past due-back date)</div></div>
      <div class="stat" data-act="filterGo"><div class="num">${c.active}</div><div class="lbl">Active documents</div></div>
      <div class="stat" data-act="filterGo" data-status="For Approval"><div class="num">${c.pending}</div><div class="lbl">Waiting for approval</div></div>
      <div class="stat ${c.expiring ? 'red' : ''}" data-act="filterGo" data-flag="expiry"><div class="num">${c.expiring}</div><div class="lbl">Expired or expiring soon</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Where are the documents now?</h2>
        ${byLoc.length ? `<table class="list"><thead><tr><th>With</th><th>Documents</th><th>Overdue</th><th>Longest there</th></tr></thead><tbody>
          ${byLoc.map((l) => `<tr class="loc-row" data-act="filterGo" data-loc="${esc(l.loc)}">
            <td><b>${esc(l.loc)}</b></td><td>${l.n}</td>
            <td>${l.overdue_n ? `<span class="flag">${l.overdue_n}</span>` : ''}</td>
            <td class="muted">${l.oldest ? plural(daysBetween(l.oldest, t), 'day') : ''}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">No active documents yet.</div>'}</div>
      <div class="card"><h2>Recent movements <a class="link small" data-act="nav" data-view="activity">View all</a></h2>
        ${recent.length ? `<table class="list"><tbody>${recent.map((m) => `<tr>
          <td class="nowrap muted small">${fmtStamp(m.at)}</td>
          <td><a class="link docno" data-act="openDoc" data-id="${m.document_id}">${esc(m.doc_no)}</a><div class="small">${esc(m.title)}</div></td>
          <td>${statusBadge(m.action)}<div class="small">→ <b>${esc(m.to_loc || '')}</b></div></td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No activity yet.</div>'}</div>
    </div>
    <div class="card"><h2>Overdue — past due-back date</h2>${overdue.length ? docTable(overdue, { compact: true }) : '<div class="empty">✓ Nothing overdue.</div>'}</div>`;
};

// ================= VIEW: register =================
VIEWS.register = async (el) => {
  const projects = await knownProjects();
  const locs = await knownLocations();
  el.innerHTML = `
    <div class="page-head"><div><h1>Documents</h1><div class="sub">Rows turn <b style="color:var(--red)">red</b> when a document is past its due-back date.</div></div>
      <div class="actions">
        <button class="btn" data-act="exportDocs">Export to Excel</button>
        <button class="btn" data-act="printRegister">Print list</button>
        <button class="btn primary" data-act="newDoc">+ New Document</button></div></div>
    <div class="card">
      <div class="filters">
        <input type="search" id="f-search" placeholder="Search no., title, tags, project, remarks…" value="${esc(state.search)}">
        <select id="f-location"><option value="">Anyone / anywhere</option>${opts(locs, state.fLocation)}
          ${state.fLocation && !locs.includes(state.fLocation) ? `<option selected>${esc(state.fLocation)}</option>` : ''}</select>
        <select id="f-status"><option value="">Any status</option>${opts(lines(settings.actions), state.fStatus)}</select>
        <select id="f-project"><option value="">All projects</option>${opts(projects, state.fProject)}</select>
        <select id="f-category"><option value="">All categories</option>${opts(lines(settings.categories), state.fCategory)}</select>
        <select id="f-flag"><option value="">All</option>
          <option value="overdue" ${state.fFlag === 'overdue' ? 'selected' : ''}>Overdue only</option>
          <option value="expiry" ${state.fFlag === 'expiry' ? 'selected' : ''}>Expired / expiring soon</option></select>
        <label class="check" style="margin:0"><input type="checkbox" id="f-closed" ${state.showClosed ? 'checked' : ''}> Include released / filed</label>
        <button class="btn small ghost" data-act="clearFilters">Clear</button>
      </div>
      <div id="doc-table"></div>
    </div>`;
  const reload = async () => {
    const rows = await loadDocs();
    $('#doc-table').innerHTML = `<div class="muted small" style="margin-bottom:6px">${plural(rows.length, 'document')}</div>` + docTable(rows);
  };
  $('#f-search').addEventListener('input', (e) => { state.search = e.target.value; reload(); });
  for (const [id, key] of [['f-location', 'fLocation'], ['f-status', 'fStatus'], ['f-project', 'fProject'], ['f-category', 'fCategory'], ['f-flag', 'fFlag']]) {
    $('#' + id).addEventListener('change', (e) => { state[key] = e.target.value; reload(); });
  }
  $('#f-closed').addEventListener('change', (e) => { state.showClosed = e.target.checked; reload(); });
  await reload();
};

// ================= VIEW: single document =================
VIEWS.doc = async (el) => {
  const d = await one('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [state.docId]);
  if (!d) { go('register'); return; }
  const files = await q('SELECT * FROM files WHERE document_id = ? AND deleted_at IS NULL ORDER BY added_at DESC, rowid DESC', [d.id]);
  const hist = await q('SELECT * FROM movements WHERE document_id = ? AND deleted_at IS NULL ORDER BY at DESC, rowid DESC', [d.id]);
  const exp = expiryInfo(d);
  const od = isOverdue(d);
  const days = d.location_since ? daysBetween(d.location_since, today()) : null;
  el.innerHTML = `
    <div class="page-head"><div><a class="link small" data-act="nav" data-view="register">← All documents</a>
      <h1><span class="docno" style="font-size:18px">${esc(d.doc_no || '')}</span> ${esc(d.title)}</h1>
      <div class="sub">${[d.project, d.category, d.current_rev ? 'Rev ' + d.current_rev : ''].filter(Boolean).map(esc).join(' · ')}</div></div>
      <div class="actions">
        <button class="btn" data-act="printSlip" data-id="${d.id}">Print tracking slip</button>
        <button class="btn" data-act="editDoc" data-id="${d.id}">Edit details</button>
        <button class="btn danger" data-act="delDoc" data-id="${d.id}">Delete</button></div></div>
    <div class="now-box ${od ? 'overdue' : ''}">
      <div><div class="lbl">Now with</div><div class="big">${esc(d.location || '—')}</div>
        <div class="muted small">${d.location_since ? `since ${fmtStamp(d.location_since)}${days ? ` (${plural(days, 'day')})` : ''}` : ''}</div></div>
      <div><div class="lbl">Status</div><div style="margin-top:4px">${statusBadge(d.status) || '—'}</div></div>
      <div><div class="lbl">Due back</div><div style="margin-top:4px">${dueCell(d)}</div></div>
      ${d.expiry_date ? `<div><div class="lbl">Expiry</div><div style="margin-top:4px">${exp ? `<span class="pill-exp ${exp.cls}">${esc(exp.text)}</span>` : fmtDate(d.expiry_date)}</div></div>` : ''}
      <div class="spacer"></div>
      <button class="btn primary" data-act="route" data-id="${d.id}" style="font-size:15px;padding:10px 18px">Update status / location</button>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Files <button class="btn small primary" data-act="addRev" data-id="${d.id}">+ Add revision / file</button></h2>
        ${files.length ? `<table class="list"><thead><tr><th>Rev</th><th>File</th><th>Added</th><th></th></tr></thead><tbody>
          ${files.map((f, i) => `<tr><td><b>${esc(f.rev)}</b>${i === 0 ? ' <span class="badge teal">current</span>' : ' <span class="badge gray">superseded</span>'}</td>
            <td>${esc(f.file_name)}<div class="file-tag">${fmtSize(f.size || 0)}${f.notes ? ' · ' + esc(f.notes) : ''}</div></td>
            <td class="nowrap small">${fmtStamp(f.added_at)}</td>
            <td class="nowrap"><button class="btn small" data-act="openFile" data-rel="${esc(f.rel_path)}">Open</button>
              <button class="btn small" data-act="saveCopy" data-rel="${esc(f.rel_path)}" data-name="${esc(f.file_name)}">Save copy</button></td></tr>`).join('')}
          </tbody></table>` : '<div class="empty">No file attached (paper document). Click “+ Add revision / file” to attach a PDF.</div>'}
      </div>
      <div class="card"><h2>Details</h2><div class="info-grid">
        <div><div class="k">Document no.</div><div class="v docno">${esc(d.doc_no) || '—'}</div></div>
        <div><div class="k">Project</div><div class="v">${esc(d.project) || '—'}</div></div>
        <div><div class="k">Category</div><div class="v">${esc(d.category) || '—'}</div></div>
        <div><div class="k">Tags</div><div class="v">${esc(d.tags) || '—'}</div></div>
        <div style="grid-column:1/-1"><div class="k">Description</div><div class="v" style="font-weight:400">${esc(d.description) || '—'}</div></div>
        <div><div class="k">Created</div><div class="v" style="font-weight:400">${fmtStamp(d.created_at)}</div></div>
      </div></div>
    </div>
    <div class="card"><h2>Tracking history</h2>
      <table class="list timeline"><thead><tr><th>Date &amp; time</th><th>Action / status</th><th>From → To</th><th>Due back</th><th>Remarks</th><th>By</th></tr></thead><tbody>
      ${hist.map((m) => m.kind === 'route' ? `<tr>
          <td class="nowrap">${fmtStamp(m.at)}</td><td>${statusBadge(m.action)}</td>
          <td>${m.from_loc ? esc(m.from_loc) + '<span class="arrow">→</span>' : ''}<b>${esc(m.to_loc || '')}</b></td>
          <td class="nowrap">${fmtDate(m.due_date)}</td><td>${esc(m.remarks)}</td><td>${esc(m.by_user)}</td></tr>`
        : `<tr><td class="nowrap sys">${fmtStamp(m.at)}</td><td class="sys" colspan="4">${esc(m.remarks || m.action)}</td><td class="sys">${esc(m.by_user)}</td></tr>`).join('')}
      </tbody></table></div>`;
};

// ================= VIEW: activity =================
VIEWS.activity = async (el) => {
  const rows = await q(`SELECT m.*, d.doc_no, d.title FROM movements m JOIN documents d ON d.id = m.document_id
    WHERE d.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY m.at DESC, m.rowid DESC LIMIT 300`);
  el.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><div class="sub">Every movement and change, newest first (last 300).</div></div>
      <div class="actions"><button class="btn" data-act="exportHistory">Export full history to Excel</button></div></div>
    <div class="card">${rows.length ? `<table class="list timeline"><thead><tr><th>Date &amp; time</th><th>Document</th><th>Action</th><th>From → To</th><th>Remarks</th><th>By</th></tr></thead><tbody>
      ${rows.map((m) => `<tr>
        <td class="nowrap ${m.kind !== 'route' ? 'sys' : ''}">${fmtStamp(m.at)}</td>
        <td><a class="link docno" data-act="openDoc" data-id="${m.document_id}">${esc(m.doc_no)}</a><div class="small">${esc(m.title)}</div></td>
        ${m.kind === 'route' ? `<td>${statusBadge(m.action)}</td>
          <td>${m.from_loc ? esc(m.from_loc) + '<span class="arrow">→</span>' : ''}<b>${esc(m.to_loc || '')}</b></td>`
        : `<td class="sys" colspan="2">${esc(m.action)}</td>`}
        <td class="${m.kind !== 'route' ? 'sys' : ''}">${esc(m.remarks)}</td><td>${esc(m.by_user)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No activity yet.</div>'}</div>`;
};

// ================= VIEW: reports =================
VIEWS.reports = async (el) => {
  const locs = await knownLocations();
  el.innerHTML = `
    <div class="page-head"><div><h1>Print &amp; Export</h1>
      <div class="sub">Print opens the print window — choose your printer, or <b>“Save as PDF”</b> / <b>“Microsoft Print to PDF”</b>.</div></div></div>
    <div class="grid-2">
      <div class="card"><h2>Follow-up list: documents with…</h2>
        <p class="muted">Everything currently with one person or office — handy when following up.</p>
        <label class="field"><span>Person / office</span><select id="r-loc">${opts(locs, locs[0])}</select></label>
        <button class="btn primary" data-act="printWith">Print / Save PDF</button></div>
      <div class="card"><h2>Overdue report</h2>
        <p class="muted">All active documents past their due-back date, oldest first, with where they are.</p>
        <button class="btn primary" data-act="printOverdue">Print / Save PDF</button></div>
      <div class="card"><h2>Document register</h2>
        <p class="muted">Uses the filters currently set on the Documents page.</p>
        <button class="btn primary" data-act="printRegister">Print / Save PDF</button></div>
      <div class="card"><h2>Expiry report</h2>
        <p class="muted">Documents with an expiry date (permits, certificates…), soonest first.</p>
        <button class="btn primary" data-act="printExpiry">Print / Save PDF</button></div>
      <div class="card"><h2>Export to Excel</h2>
        <div class="actions"><button class="btn" data-act="exportDocs">Document register</button>
          <button class="btn" data-act="exportHistory">Full tracking history</button></div></div>
      <div class="card"><h2>Tracking slip (per document)</h2>
        <p class="muted">Open a document and click <b>Print tracking slip</b>. It includes the history and blank rows for routing on paper.</p></div>
    </div>`;
};

// ================= VIEW: settings =================
VIEWS.settings = async (el) => {
  const info = await invoke('app_info');
  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form id="settings-form">
    <div class="grid-2">
      <div class="card"><h2>General</h2>
        <label class="field"><span>Company name (printouts)</span><input name="company_name" value="${esc(settings.company_name)}"></label>
        <div class="row2">
          <label class="field"><span>Your office (default “Now with” for new documents)</span><input name="office_name" value="${esc(settings.office_name)}"></label>
          <label class="field"><span>Your name (recorded in history)</span><input name="user_name" value="${esc(settings.user_name)}"></label></div>
        <div class="row3">
          <label class="field"><span>Document no. prefix</span><input name="doc_prefix" value="${esc(settings.doc_prefix)}"></label>
          <label class="field"><span>Default due-back (days)</span><input name="default_due_days" type="number" min="0" value="${esc(settings.default_due_days)}"></label>
          <label class="field"><span>Expiry warning (days before)</span><input name="expiry_warn_days" type="number" min="0" value="${esc(settings.expiry_warn_days)}"></label></div>
        <p class="muted small">Numbers are generated like <b class="docno">${esc(settings.doc_prefix || 'DOC')}-${today().slice(0, 4)}-0001</b> (you can still type your own).</p>
      </div>
      <div class="card"><h2>Lists (one per line)</h2>
        <div class="row3">
          <label class="field"><span>People / offices</span><textarea name="locations" rows="9">${esc(settings.locations)}</textarea></label>
          <label class="field"><span>Categories</span><textarea name="categories" rows="9">${esc(settings.categories)}</textarea></label>
          <label class="field"><span>Actions / statuses</span><textarea name="actions" rows="9">${esc(settings.actions)}</textarea></label></div>
        <p class="muted small">“${CLOSED.join('”, “')}” close a document (no more overdue flag).</p>
      </div>
    </div>
    <button class="btn primary" type="submit">Save settings</button>
    </form>
    <div class="card" style="margin-top:16px"><h2>Data &amp; backup</h2>
      <p>Your records and files are stored in: <code>${esc(info.dataDir)}</code></p>
      <p class="muted small">Keep this folder with the app when moving to another PC. Tip: choose your Google Drive or OneDrive folder as the backup location for an automatic cloud copy.</p>
      <div class="actions"><button class="btn primary" data-act="backup">Back up to a folder…</button>
        <button class="btn" data-act="openData">Open data folder</button></div>
      <p class="muted small" style="margin-top:12px">Version ${esc(info.version)}</p></div>`;
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    for (const [k, v] of Object.entries(d)) await saveSetting(k, v);
    await loadSettings();
    toast('Settings saved');
    render();
  });
};

// ================= forms: new document(s) =================
async function newDocuments(paths = []) {
  const projects = await knownProjects();
  const locs = await knownLocations();
  const actions = lines(settings.actions);
  const cats = lines(settings.categories);
  let files = paths.map((p) => ({ path: p, name: baseName(p) }));

  const rowHtml = (f, no) => `<tr>
    <td><input name="docno[]" value="${esc(no)}" class="docno"></td>
    <td><input name="title[]" value="${esc(f ? stripExt(f.name) : '')}" placeholder="Title *"></td>
    <td class="file-tag">${f ? esc(f.name) : '— no file (paper) —'}<input type="hidden" name="path[]" value="${esc(f ? f.path : '')}"></td>
    <td><button type="button" class="btn small ghost" data-rowdel>✕</button></td></tr>`;

  const res = await openModal({
    title: 'New Document',
    wide: true,
    okText: 'Save',
    body: `
      ${datalist('dl-projects', projects)}${datalist('dl-locs', locs)}
      <table class="entry"><thead><tr><th style="width:20%">Doc no.</th><th>Title *</th><th style="width:28%">File</th><th></th></tr></thead>
        <tbody id="nd-rows"></tbody></table>
      <div class="actions" style="margin:6px 0 14px">
        <button type="button" class="btn small" id="nd-pick">+ Add PDF files…</button>
        <button type="button" class="btn small ghost" id="nd-blank">+ Add row without file</button>
        <span class="muted small">Tip: you can also drop PDF files onto the window.</span></div>
      <div class="row3">
        <label class="field"><span>Project</span><input name="project" list="dl-projects"></label>
        <label class="field"><span>Category</span><select name="category"><option value=""></option>${opts(cats, '')}</select></label>
        <label class="field"><span>Revision</span><input name="rev" value="0"></label></div>
      <div class="card" style="background:#f2f8f6">
        <div class="row3">
          <label class="field"><span>Status / action</span><select name="action">${opts(actions, 'Received')}</select></label>
          <label class="field"><span>Now with *</span><input name="location" list="dl-locs" value="${esc(settings.office_name)}"></label>
          <label class="field"><span>Due back (optional)</span><input type="date" name="due_date"></label></div>
        <label class="field" style="margin:0"><span>Remarks</span><input name="remarks" placeholder="e.g. Received from contractor"></label>
      </div>
      <div class="row3">
        <label class="field"><span>Tags</span><input name="tags" placeholder="comma separated"></label>
        <label class="field"><span>Expiry date (optional)</span><input type="date" name="expiry_date"></label>
        <label class="field"><span>Description</span><input name="description"></label></div>`,
    onOpen: async (form) => {
      const body = form.querySelector('#nd-rows');
      const fill = async () => {
        const nos = await nextDocNos(Math.max(files.length, 1));
        body.innerHTML = files.length ? files.map((f, i) => rowHtml(f, nos[i])).join('') : rowHtml(null, nos[0]);
      };
      await fill();
      const renumber = async () => {
        const inputs = body.querySelectorAll('input[name="docno[]"]');
        const nos = await nextDocNos(inputs.length);
        inputs.forEach((inp, i) => { inp.value = nos[i]; });
      };
      form.querySelector('#nd-pick').addEventListener('click', async () => {
        const picked = await invoke('pick_files');
        if (!picked || !picked.length) return;
        const blanks = [...body.querySelectorAll('tr')].filter((tr) => !tr.querySelector('input[name="path[]"]').value
          && !tr.querySelector('input[name="title[]"]').value);
        blanks.forEach((tr) => tr.remove());
        picked.forEach((p) => body.insertAdjacentHTML('beforeend', rowHtml({ path: p, name: baseName(p) }, '')));
        await renumber();
      });
      form.querySelector('#nd-blank').addEventListener('click', async () => {
        body.insertAdjacentHTML('beforeend', rowHtml(null, ''));
        await renumber();
      });
      body.addEventListener('click', (e) => {
        if (e.target.matches('[data-rowdel]') && body.children.length > 1) e.target.closest('tr').remove();
      });
    },
    onOk: async (form) => {
      const d = formData(form);
      const fd = new FormData(form);
      const nos = fd.getAll('docno[]'), titles = fd.getAll('title[]'), ps = fd.getAll('path[]');
      const items = titles.map((t, i) => ({ title: String(t).trim(), no: String(nos[i]).trim(), path: ps[i] })).filter((x) => x.title);
      if (!items.length) throw new Error('Enter at least one title');
      if (!d.location) throw new Error('“Now with” is required');
      // duplicate doc numbers
      for (const it of items) {
        if (it.no && await one('SELECT id FROM documents WHERE doc_no = ? AND deleted_at IS NULL', [it.no])) {
          throw new Error(`Document no. ${it.no} already exists`);
        }
      }
      // import files first, check for duplicates by content
      const imported = [];
      const dups = [];
      for (const it of items) {
        if (!it.path) { imported.push(null); continue; }
        const r = await invoke('vault_import', { src: it.path });
        imported.push(r);
        const ex1 = await one(`SELECT f.rev, dd.doc_no, dd.title FROM files f JOIN documents dd ON dd.id = f.document_id
          WHERE f.sha256 = ? AND f.deleted_at IS NULL AND dd.deleted_at IS NULL LIMIT 1`, [r.sha256]);
        if (ex1) dups.push(`<li><b>${esc(r.fileName)}</b> is already saved as ${esc(ex1.doc_no)} – ${esc(ex1.title)} (Rev ${esc(ex1.rev)})</li>`);
      }
      if (dups.length) {
        const ok = await confirmBox(`<p>⚠️ Same file already in the system:</p><ul>${dups.join('')}</ul><p>Save anyway?</p>`, 'Save anyway', 'Duplicate file');
        if (!ok) return false;
      }
      const t = nowStamp();
      let lastId = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const id = uuid();
        lastId = id;
        await ex(`INSERT INTO documents (id, doc_no, title, project, category, description, tags, current_rev, status, location,
          location_since, due_date, expiry_date, created_at, updated_at, device_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, nz(it.no), it.title, nz(d.project), nz(d.category), nz(d.description), nz(d.tags), nz(d.rev) || '0',
          d.action, d.location, t, nz(d.due_date), nz(d.expiry_date), t, t, settings.device_id]);
        await addMovement(id, { kind: 'created', action: 'Created', remarks: 'Document created' });
        const f = imported[i];
        if (f) {
          await ex(`INSERT INTO files (id, document_id, rev, file_name, rel_path, sha256, size, added_at, updated_at, device_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, [uuid(), id, nz(d.rev) || '0', f.fileName, f.relPath, f.sha256, f.size, t, t, settings.device_id]);
        }
        await addMovement(id, { action: d.action, to_loc: d.location, due_date: d.due_date, remarks: d.remarks });
      }
      return { n: items.length, lastId };
    },
  });
  if (!res) return;
  toast(`${plural(res.n, 'document')} saved`);
  if (res.n === 1) go('doc', { docId: res.lastId }); else go('register');
}

// ================= forms: route / update status & location =================
async function routeDocument(id) {
  const d = await one('SELECT * FROM documents WHERE id = ?', [id]);
  if (!d) return;
  const locs = await knownLocations();
  const actions = lines(settings.actions);
  const dueDefault = addDays(today(), Number(settings.default_due_days) || 3);
  const quick = [['For Approval', ''], ['Approved', ''], ['Returned for Revision', ''], ['For Payment', 'Accounting'], ['Released', '']]
    .filter(([a]) => actions.includes(a));
  const res = await openModal({
    title: `Update: ${d.doc_no || ''} ${d.title}`,
    body: `
      ${datalist('dl-locs', locs)}
      <p class="muted" style="margin-top:0">Now with <b>${esc(d.location || '—')}</b> · ${statusBadge(d.status)}
        ${d.location_since ? `· since ${fmtStamp(d.location_since)}` : ''}</p>
      <div class="quick">${quick.map(([a, l]) => `<button type="button" class="btn" data-quick="${esc(a)}" data-loc="${esc(l)}">${esc(a)}</button>`).join('')}</div>
      <div class="row2">
        <label class="field"><span>Action / new status *</span><select name="action" autofocus>${opts(actions, d.status)}</select></label>
        <label class="field"><span>Now with (person / office) *</span><input name="location" list="dl-locs" value="${esc(d.location)}"></label></div>
      <div class="row2">
        <label class="field"><span>Due back / action due</span><input type="date" name="due_date" value="${esc(d.due_date || dueDefault)}"></label>
        <label class="field"><span>By</span><input name="by_user" value="${esc(settings.user_name)}"></label></div>
      <label class="field"><span>Remarks</span><textarea name="remarks" placeholder="e.g. For approval of Mr. Sabanal; follow up Friday"></textarea></label>`,
    onOpen: (form) => {
      const act = form.querySelector('[name=action]'), loc = form.querySelector('[name=location]'), due = form.querySelector('[name=due_date]');
      const syncDue = () => { if (CLOSED.includes(act.value)) due.value = ''; else if (!due.value) due.value = dueDefault; };
      act.addEventListener('change', syncDue);
      // moving to a different person/office starts a fresh due-back period
      loc.addEventListener('change', () => {
        if (loc.value.trim() !== (d.location || '')) due.value = CLOSED.includes(act.value) ? '' : dueDefault;
      });
      form.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
        act.value = b.dataset.quick;
        if (b.dataset.loc) loc.value = b.dataset.loc;
        due.value = '';
        syncDue();
        loc.focus();
        loc.select();
      }));
    },
    onOk: async (form) => {
      const v = formData(form);
      if (!v.action) throw new Error('Choose an action');
      if (!v.location) throw new Error('Enter who has the document now');
      const t = nowStamp();
      const moved = (v.location || '') !== (d.location || '');
      const due = CLOSED.includes(v.action) ? null : nz(v.due_date);
      await ex(`UPDATE documents SET status = ?, location = ?, location_since = ?, due_date = ?, updated_at = ?, device_id = ? WHERE id = ?`,
        [v.action, v.location, moved || !d.location_since ? t : d.location_since, due, t, settings.device_id, id]);
      await addMovement(id, { action: v.action, from_loc: d.location, to_loc: v.location, due_date: due, remarks: v.remarks, by_user: v.by_user, at: t });
      return true;
    },
  });
  if (res) { toast('Updated'); render(); }
}

// ================= forms: edit, revision =================
async function editDocument(id) {
  const d = await one('SELECT * FROM documents WHERE id = ?', [id]);
  const projects = await knownProjects();
  const cats = lines(settings.categories);
  const res = await openModal({
    title: 'Edit Document Details',
    body: `${datalist('dl-projects', projects)}
      <div class="row2">
        <label class="field"><span>Document no.</span><input name="doc_no" class="docno" value="${esc(d.doc_no)}"></label>
        <label class="field"><span>Project</span><input name="project" list="dl-projects" value="${esc(d.project)}"></label></div>
      <label class="field"><span>Title *</span><input name="title" value="${esc(d.title)}"></label>
      <div class="row3">
        <label class="field"><span>Category</span><select name="category"><option value=""></option>${opts(cats, d.category)}
          ${d.category && !cats.includes(d.category) ? `<option selected>${esc(d.category)}</option>` : ''}</select></label>
        <label class="field"><span>Due back</span><input type="date" name="due_date" value="${esc(d.due_date)}"></label>
        <label class="field"><span>Expiry date</span><input type="date" name="expiry_date" value="${esc(d.expiry_date)}"></label></div>
      <label class="field"><span>Tags</span><input name="tags" value="${esc(d.tags)}"></label>
      <label class="field"><span>Description</span><textarea name="description">${esc(d.description)}</textarea></label>`,
    onOk: async (form) => {
      const v = formData(form);
      if (!v.title) throw new Error('Title is required');
      if (v.doc_no && await one('SELECT id FROM documents WHERE doc_no = ? AND id != ? AND deleted_at IS NULL', [v.doc_no, id])) {
        throw new Error(`Document no. ${v.doc_no} already exists`);
      }
      const t = nowStamp();
      await ex(`UPDATE documents SET doc_no=?, title=?, project=?, category=?, due_date=?, expiry_date=?, tags=?, description=?, updated_at=?, device_id=? WHERE id=?`,
        [nz(v.doc_no), v.title, nz(v.project), nz(v.category), nz(v.due_date), nz(v.expiry_date), nz(v.tags), nz(v.description), t, settings.device_id, id]);
      await addMovement(id, { kind: 'edit', action: 'Edited', remarks: 'Details edited' });
      return true;
    },
  });
  if (res) { toast('Saved'); render(); }
}

async function addRevision(id) {
  const d = await one('SELECT * FROM documents WHERE id = ?', [id]);
  const hasFiles = await one('SELECT COUNT(*) AS n FROM files WHERE document_id = ? AND deleted_at IS NULL', [id]);
  const picked = await invoke('pick_files');
  if (!picked || !picked.length) return;
  const path = picked[0];
  const res = await openModal({
    title: hasFiles.n ? 'Add Revision' : 'Attach File',
    body: `<p>File: <b>${esc(baseName(path))}</b></p>
      <div class="row2">
        <label class="field"><span>Revision</span><input name="rev" value="${esc(hasFiles.n ? nextRev(d.current_rev) : (d.current_rev || '0'))}"></label>
        <label class="field"><span>Notes</span><input name="notes" placeholder="e.g. revised per comments"></label></div>`,
    onOk: async (form) => {
      const v = formData(form);
      const r = await invoke('vault_import', { src: path });
      const dup = await one(`SELECT f.rev, dd.doc_no FROM files f JOIN documents dd ON dd.id = f.document_id
        WHERE f.sha256 = ? AND f.deleted_at IS NULL AND dd.deleted_at IS NULL LIMIT 1`, [r.sha256]);
      if (dup) {
        const ok = await confirmBox(`<p>⚠️ This exact file is already saved as ${esc(dup.doc_no)} Rev ${esc(dup.rev)}.</p><p>Add it anyway?</p>`, 'Add anyway', 'Duplicate file');
        if (!ok) return false;
      }
      const t = nowStamp();
      const rev = nz(v.rev) || nextRev(d.current_rev);
      await ex(`INSERT INTO files (id, document_id, rev, file_name, rel_path, sha256, size, notes, added_at, updated_at, device_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uuid(), id, rev, r.fileName, r.relPath, r.sha256, r.size, nz(v.notes), t, t, settings.device_id]);
      await ex('UPDATE documents SET current_rev = ?, updated_at = ?, device_id = ? WHERE id = ?', [rev, t, settings.device_id, id]);
      await addMovement(id, { kind: 'revision', action: 'Revision', remarks: `Rev ${rev} added (${r.fileName})${v.notes ? ' – ' + v.notes : ''}` });
      return true;
    },
  });
  if (res) { toast('File added'); render(); }
}

// ================= printing =================
function docHeader(title) {
  return `<div class="doc-head"><div><div class="doc-company">${esc(settings.company_name || 'Document Tracker')}</div>
    ${settings.office_name ? `<div class="doc-addr">${esc(settings.office_name)}</div>` : ''}</div>
    <div><div class="doc-title">${esc(title)}</div><div class="doc-date">Printed ${esc(nowStamp())}</div></div></div>`;
}
function printDoc(html) {
  const area = $('#print-area');
  area.innerHTML = `<div class="doc">${html}</div>`;
  const done = () => { area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}
function printDocTable(rows, { showWhere = true } = {}) {
  return `<table><thead><tr><th style="width:13%">Doc No.</th><th>Title</th><th style="width:5%">Rev</th><th style="width:12%">Status</th>
    ${showWhere ? '<th style="width:14%">Now with</th>' : ''}<th style="width:11%">Since</th><th style="width:12%">Due back</th></tr></thead><tbody>
    ${rows.length ? rows.map((d) => {
      const od = isOverdue(d);
      return `<tr><td>${esc(d.doc_no)}</td><td>${esc(d.title)}${d.project ? `<br><i>${esc(d.project)}</i>` : ''}</td><td>${esc(d.current_rev)}</td>
        <td>${esc(d.status)}</td>${showWhere ? `<td>${esc(d.location)}</td>` : ''}
        <td>${d.location_since ? fmtDate(d.location_since) + `<br>(${plural(daysBetween(d.location_since, today()), 'day')})` : ''}</td>
        <td class="${od ? 'overdue-cell' : ''}">${fmtDate(d.due_date)}${od ? `<br>OVERDUE ${plural(daysBetween(d.due_date, today()), 'day')}` : ''}</td></tr>`;
    }).join('') : `<tr><td colspan="${showWhere ? 7 : 6}">None.</td></tr>`}</tbody></table>`;
}

async function printSlip(id) {
  const d = await one('SELECT * FROM documents WHERE id = ?', [id]);
  const hist = await q(`SELECT * FROM movements WHERE document_id = ? AND kind = 'route' AND deleted_at IS NULL ORDER BY at, rowid`, [id]);
  printDoc(`${docHeader('Document Tracking Slip')}
    <div class="doc-info">
      <div><b>Doc No.:</b> ${esc(d.doc_no)}</div><div><b>Revision:</b> ${esc(d.current_rev)}</div>
      <div style="grid-column:1/-1"><b>Title:</b> ${esc(d.title)}</div>
      <div><b>Project:</b> ${esc(d.project)}</div><div><b>Category:</b> ${esc(d.category)}</div>
      <div><b>Status:</b> ${esc(d.status)}</div><div><b>Now with:</b> ${esc(d.location)} ${d.location_since ? `(since ${fmtDate(d.location_since)})` : ''}</div>
    </div>
    <table class="routing"><thead><tr><th style="width:16%">Date &amp; time</th><th style="width:16%">Action</th><th style="width:15%">From</th>
      <th style="width:15%">To</th><th style="width:12%">Due back</th><th>Remarks</th><th style="width:14%">Received by</th></tr></thead><tbody>
      ${hist.map((m) => `<tr><td>${fmtStamp(m.at)}</td><td>${esc(m.action)}</td><td>${esc(m.from_loc)}</td><td>${esc(m.to_loc)}</td>
        <td>${fmtDate(m.due_date)}</td><td>${esc(m.remarks)}</td><td></td></tr>`).join('')}
      ${'<tr class="blank-row"><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>'.repeat(6)}
    </tbody></table>`);
}
async function printWith(loc) {
  const rows = await loadDocs({ fLocation: loc });
  printDoc(`${docHeader('Follow-up List')}<div class="summary">Documents currently with <b>${esc(loc)}</b>: <b>${rows.length}</b>
    · Overdue: <b>${rows.filter(isOverdue).length}</b></div>${printDocTable(rows, { showWhere: false })}`);
}
async function printOverdue() {
  const rows = await loadDocs({ fFlag: 'overdue' });
  printDoc(`${docHeader('Overdue Documents')}<div class="summary">Past due-back date as of ${fmtDate(today())}: <b>${rows.length}</b></div>${printDocTable(rows)}`);
}
async function printRegister() {
  const rows = await loadDocs();
  const f = [state.fLocation && `With: ${state.fLocation}`, state.fStatus && `Status: ${state.fStatus}`, state.fProject && `Project: ${state.fProject}`,
    state.fCategory && `Category: ${state.fCategory}`, state.search && `Search: “${state.search}”`, state.showClosed ? 'incl. released/filed' : 'active only'].filter(Boolean);
  printDoc(`${docHeader('Document Register')}<div class="summary">${esc(f.join(' · '))} · <b>${plural(rows.length, 'document')}</b></div>${printDocTable(rows)}`);
}
async function printExpiry() {
  const rows = await q(`SELECT * FROM documents WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date != '' ORDER BY expiry_date`);
  printDoc(`${docHeader('Expiry Report')}<table><thead><tr><th style="width:14%">Doc No.</th><th>Title</th><th style="width:15%">Category</th>
    <th style="width:13%">Expiry date</th><th style="width:16%">Status</th></tr></thead><tbody>
    ${rows.length ? rows.map((d) => {
      const e = expiryInfo(d);
      return `<tr><td>${esc(d.doc_no)}</td><td>${esc(d.title)}</td><td>${esc(d.category)}</td>
        <td class="${e && e.cls === 'expired' ? 'overdue-cell' : ''}">${fmtDate(d.expiry_date)}</td><td>${e ? esc(e.text) : 'Valid'}</td></tr>`;
    }).join('') : '<tr><td colspan="5">No documents with an expiry date.</td></tr>'}</tbody></table>`);
}

// ================= Excel =================
async function exportXlsx(name, sheet, headers, rows) {
  const path = await invoke('export_xlsx', { defaultName: `${name} ${today()}.xlsx`, sheetName: sheet, headers, rows });
  if (path) toast('Saved: ' + path);
}

// ================= drag & drop (Tauri delivers file paths) =================
function setupDrop() {
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (!ev) return;
  const hint = $('#drop-hint');
  ev.listen('tauri://drag-enter', () => hint.classList.remove('hidden'));
  ev.listen('tauri://drag-leave', () => hint.classList.add('hidden'));
  ev.listen('tauri://drag-drop', (e) => {
    hint.classList.add('hidden');
    const paths = (e.payload && e.payload.paths) || [];
    if (!paths.length) return;
    if (document.querySelector('.modal-back')) { toast('Close the open window first, then drop the files again', 'err'); return; }
    newDocuments(paths);
  });
}

// ================= click actions =================
const ACTIONS = {
  nav: (d) => go(d.view),
  filterGo: (d) => go('register', {
    search: '', fStatus: d.status || '', fLocation: d.loc && d.loc !== '(not set)' ? d.loc : '', fProject: '', fCategory: '',
    fFlag: d.flag || '', showClosed: false,
  }),
  clearFilters: () => go('register', { search: '', fStatus: '', fLocation: '', fProject: '', fCategory: '', fFlag: '', showClosed: false }),
  openDoc: (d) => go('doc', { docId: d.id }),
  newDoc: () => newDocuments([]),
  route: (d) => routeDocument(d.id),
  editDoc: (d) => editDocument(d.id),
  addRev: (d) => addRevision(d.id),
  delDoc: async (d) => {
    const doc = await one('SELECT doc_no, title FROM documents WHERE id = ?', [d.id]);
    const ok = await confirmBox(`<p>Delete <b>${esc(doc.doc_no || '')} ${esc(doc.title)}</b>?</p><p class="muted">It will be hidden from all lists. Its files stay in the vault folder.</p>`, 'Delete', 'Delete document', true);
    if (!ok) return;
    const t = nowStamp();
    await ex('UPDATE documents SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?', [t, t, settings.device_id, d.id]);
    toast('Document deleted');
    go('register');
  },
  openFile: (d) => invoke('open_file', { rel: d.rel }),
  saveCopy: async (d) => { const p = await invoke('save_copy', { rel: d.rel, name: d.name }); if (p) toast('Saved: ' + p); },
  printSlip: (d) => printSlip(d.id),
  printWith: () => printWith($('#r-loc').value),
  printOverdue: () => printOverdue(),
  printRegister: () => printRegister(),
  printExpiry: () => printExpiry(),
  exportDocs: async () => {
    const rows = await loadDocs({ ...state, showClosed: true, fFlag: '', fStatus: '', fLocation: '', fProject: '', fCategory: '', search: '' });
    await exportXlsx('Document Register', 'Documents',
      ['Doc No.', 'Title', 'Project', 'Category', 'Rev', 'Status', 'Now with', 'Since', 'Days there', 'Due back', 'Overdue', 'Expiry', 'Tags', 'Description', 'Files'],
      rows.map((d) => [d.doc_no, d.title, d.project, d.category, d.current_rev, d.status, d.location, d.location_since,
        d.location_since ? daysBetween(d.location_since, today()) : null, d.due_date, isOverdue(d) ? 'OVERDUE' : '', d.expiry_date, d.tags, d.description, d.file_n]));
  },
  exportHistory: async () => {
    const rows = await q(`SELECT m.*, d.doc_no, d.title FROM movements m JOIN documents d ON d.id = m.document_id
      WHERE d.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY d.doc_no, m.at, m.rowid`);
    await exportXlsx('Tracking History', 'History', ['Doc No.', 'Title', 'Date & time', 'Action', 'From', 'To', 'Due back', 'Remarks', 'By'],
      rows.map((m) => [m.doc_no, m.title, m.at, m.action, m.from_loc, m.to_loc, m.due_date, m.remarks, m.by_user]));
  },
  backup: async () => {
    const d = new Date();
    const name = `dmts-${ymd(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
    const r = await invoke('backup_to_folder', { dbName: name });
    if (r) toast(`Backup saved to ${r.path} (${plural(r.copied, 'new file')})`);
  },
  openData: () => invoke('open_data_folder'),
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el.dataset, el); } catch (err) { toast(String(err && err.message ? err.message : err), 'err'); console.error(err); }
});

(async function start() {
  try {
    await loadSettings();
    setupDrop();
    await render();
  } catch (e) {
    $('#main').innerHTML = `<div class="banner red">Could not start: ${esc(e)}</div>`;
  }
})();
