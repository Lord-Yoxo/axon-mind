// Panneaux autour de la vue : menu de gauche, navigateur de dossiers, et colonne
// de droite (fiche d'une note, Stats, Historique d'écriture, Profil).

import { el, fmt, dayNumber, dayToDate } from './util.js';
import { t, getLang, locale } from './i18n.js';
import { folderTree, wordTotals } from './model.js';

export const NAV_ITEMS = ['mind', 'explorer', 'stats', 'history', 'profile'];
export const SIDE_KEYS = ['stats', 'history', 'profile'];

const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14"/></svg>';
const ICON_MENU =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h12M2 8h12M2 12h12"/></svg>';

const dateLong = (ms) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
const dateShort = (day) => dayToDate(day).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
const pctTxt = (p) => (getLang() === 'fr' ? `${p} %` : `${p}%`);

// ------------------------------------------------------------------ menu de gauche
export function buildNav(v) {
  const n = v.navEl;
  n.replaceChildren();
  const brand = el('div', 'c3d-brand', n);
  el('span', 'c3d-brand-mark', brand);
  el('span', 'c3d-brand-name', brand, 'Axon Mind');
  const hide = el('button', 'c3d-nav-hide', brand);
  hide.innerHTML = ICON_MENU;
  hide.title = t('navHide');
  hide.onclick = () => v.toggleNav(false);
  el('div', 'c3d-brand-line', n);
  const sb = el('button', 'c3d-nav-search', n);
  el('span', 'c3d-search-ico', sb).innerHTML = ICON_SEARCH;
  el('span', 'c3d-nav-search-t', sb, t('searchNav'));
  el('span', 'c3d-kbd', sb, '/');
  sb.onclick = () => v.searchInput.focus();
  const list = el('div', 'c3d-nav-list', n);
  v.navItems = {};
  for (const k of NAV_ITEMS) {
    const b = el('button', 'c3d-nav-item', list, t('nav.' + k));
    b.onclick = () => v.navTo(k);
    v.navItems[k] = b;
  }
  const foot = el('div', 'c3d-nav-foot', n);
  v.navLive = el('div', 'c3d-nav-live', foot);
  el('span', 'c3d-live-dot', v.navLive);
  v.navLiveT = el('span', null, v.navLive, t('live'));
  v.navStatus = el('div', 'c3d-nav-status', foot);
  syncNav(v);
}

export function syncNav(v) {
  if (!v.navItems) return;
  const s = v.settings;
  const side = v.sideKey();
  for (const k of NAV_ITEMS) {
    let on = false;
    if (k === 'explorer') on = !!s.navOpen;
    else if (k === 'mind') on = !side && !s.navOpen && v.view === 'brain';
    else on = side === k;
    v.navItems[k].classList.toggle('is-active', on);
  }
  syncStatus(v);
}

/** « 66 dans plans · Effacer » : ce qui est allumé dans le cerveau. */
export function syncStatus(v) {
  for (const box of [v.navStatus, v.stageStatus]) {
    if (!box) continue;
    box.replaceChildren();
    const hl = v.hl;
    box.classList.toggle('is-on', !!hl);
    if (!hl) continue;
    el('span', 'c3d-status-t', box, t(hl.kind === 'note' ? 'aroundLabel' : 'inLabel', { n: fmt(hl.count), label: hl.label }));
    const c = el('button', 'c3d-link c3d-status-clear', box, t('clear'));
    c.onclick = () => v.clearHighlight();
  }
}

export function setLive(v, busy) {
  if (!v.navLive) return;
  v.navLive.classList.toggle('is-busy', !!busy);
  v.navLiveT.textContent = busy ? t('updating') : t('live');
}

// ------------------------------------------------------------ navigateur de dossiers
export function renderNavigator(v) {
  const box = v.navigatorEl;
  if (!box) return;
  const keep = v.treeBox ? v.treeBox.scrollTop : 0;
  box.replaceChildren();
  v.treeBox = null;
  if (!v.settings.navOpen || !v.model) return;
  const head = el('div', 'c3d-col-head', box);
  el('span', 'c3d-col-title', head, t('nav.explorer'));
  const x = el('button', 'c3d-vp-x', head, '×');
  x.title = t('close');
  x.onclick = () => v.toggleNavigator(false);
  el('div', 'c3d-col-sub', box, t('foldersHead'));
  const list = (v.treeBox = el('div', 'c3d-tree', box));
  const tree = v.tree || (v.tree = folderTree(v.model));
  const hl = v.hl;

  const all = el('button', 'c3d-tree-item c3d-tree-all' + (!hl ? ' is-active' : ''), list);
  el('span', 'c3d-tree-name', all, t('everything'));
  el('span', 'c3d-tree-n', all, fmt(tree.count));
  all.onclick = () => v.clearHighlight();

  const renderNode = (node, depth) => {
    const open = v.navExpanded.has(node.path);
    const has = node.list.length > 0 || node.notes.length > 0;
    const it = el('button', 'c3d-tree-item', list);
    it.style.paddingLeft = `${4 + depth * 11}px`;
    if (hl && hl.kind === 'folder' && hl.key === node.path) it.classList.add('is-active');
    const chev = el('span', 'c3d-tree-chev', it, has ? (open ? '▾' : '▸') : '');
    const dot = el('span', 'c3d-dot', it);
    if (node.gi >= 0) dot.style.color = v.groupCss(node.gi);
    const nm = el('span', 'c3d-tree-name', it, node.name);
    nm.title = node.path === '/' ? t('rootFull') : node.path;
    el('span', 'c3d-tree-n', it, fmt(node.count));
    chev.onclick = (e) => {
      e.stopPropagation();
      toggleOpen(node.path);
    };
    it.onclick = () => {
      if (has && !open) v.navExpanded.add(node.path);
      v.highlightFolder(node);
    };
    if (!open) return;
    for (const k of node.list) renderNode(k, depth + 1);
    const LIM = 150;
    node.notes.slice(0, LIM).forEach((ni) => {
      const nb = el('button', 'c3d-tree-note' + (v.sel === ni ? ' is-active' : ''), list);
      nb.style.paddingLeft = `${17 + (depth + 1) * 11}px`;
      el('span', 'c3d-tree-name', nb, v.model.notes[ni].name);
      nb.onclick = () => v.selectNote(ni, { fly: true });
    });
    if (node.notes.length > LIM) el('div', 'c3d-tree-more', list, t('moreNotes', { n: fmt(node.notes.length - LIM) })).style.paddingLeft = `${17 + (depth + 1) * 11}px`;
  };
  const toggleOpen = (path) => {
    if (v.navExpanded.has(path)) v.navExpanded.delete(path);
    else v.navExpanded.add(path);
    renderNavigator(v);
  };
  for (const node of tree.list) renderNode(node, 0);
  if (tree.notes.length) renderNode({ name: t('root'), path: '/', count: tree.notes.length, list: [], notes: tree.notes, gi: v.model.notes[tree.notes[0]].gi }, 0);
  list.scrollTop = keep;
}

// ------------------------------------------------------------------ colonne de droite
export function renderSide(v) {
  const box = v.sideEl;
  if (!box) return;
  const key = v.sideKey();
  v.root.classList.toggle('c3d-side-open', !!key);
  const keep = key && key === v._sideRendered && v.sideScroll ? v.sideScroll.scrollTop : 0;
  box.replaceChildren();
  v._sideRendered = key;
  v.statWords = null;
  if (!key || !v.model) return;
  const head = el('div', 'c3d-col-head', box);
  const titles = { note: v.model.notes[v.sel] ? v.model.notes[v.sel].name : '', stats: t('nav.stats'), history: t('hist.title'), profile: t('profile.title') };
  el('span', 'c3d-col-title c3d-col-title-big', head, titles[key]);
  const x = el('button', 'c3d-vp-x', head, '×');
  x.title = t('close');
  x.onclick = () => v.closeSide();
  const body = (v.sideScroll = el('div', 'c3d-side-body', box));
  if (key === 'note') renderNote(v, body);
  else if (key === 'stats') renderStats(v, body);
  else if (key === 'history') renderHistory(v, body);
  else if (key === 'profile') renderProfile(v, body);
  body.scrollTop = keep;
}

const secTitle = (p, text) => el('div', 'c3d-side-sec', p, text);
const statLine = (p, label, value, onClick) => {
  const r = el(onClick ? 'button' : 'div', 'c3d-st-row' + (onClick ? ' c3d-st-click' : ''), p);
  el('span', 'c3d-st-l', r, label);
  const val = el('span', 'c3d-st-v', r, value);
  if (onClick) r.onclick = onClick;
  return val;
};

// ---- fiche d'une note
function excerptOf(txt) {
  let s = txt;
  if (s.startsWith('---')) {
    const end = s.indexOf('\n---', 3);
    if (end > 0) s = s.slice(end + 4);
  }
  s = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[\s>#*+-]+/gm, '')
    .replace(/[*_`~=]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 380 ? s.slice(0, 380).replace(/\s\S*$/, '') + '…' : s;
}

function renderNote(v, p) {
  const m = v.model;
  const i = v.sel;
  const n = m.notes[i];
  const g = m.groups[n.gi];
  const words = m.wordCache.get(n.path);
  const meta = el('div', 'c3d-card-meta', p);
  const dot = el('span', 'c3d-dot', meta);
  dot.style.color = v.noteCss(i);
  el('span', null, meta, n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')).split('/').join(' › ') : g.full);
  const dates = el('div', 'c3d-card-meta c3d-card-dates', p);
  const created = n.first || n.ctime;
  if (created) el('span', null, dates, t('card.created', { d: dateLong(created) }));
  if (n.mtime && (!created || dayNumber(n.mtime) !== dayNumber(created))) el('span', null, dates, t('card.edited', { d: dateLong(n.mtime) }));
  if (words != null) el('span', null, dates, t('card.words', { n: fmt(words) }));

  const ex = el('div', 'c3d-card-ex', p, '…');
  Promise.resolve()
    .then(() => v.app.vault.cachedRead(n.file))
    .then((txt) => {
      if (v.sel === i) ex.textContent = excerptOf(txt || '') || t('card.empty');
    })
    .catch(() => (ex.textContent = ''));

  const tags = el('div', 'c3d-card-tags', p);
  if (n.tags.length) for (const tg of n.tags.slice(0, 12)) el('span', 'c3d-tag', tags, '#' + tg);
  else el('span', 'c3d-card-faint', tags, t('card.noTags'));

  const acts = el('div', 'c3d-card-acts', p);
  const open = el('button', 'c3d-btn c3d-btn-main', acts, t('card.open'));
  open.onclick = (e) => v.openNote(i, e);
  const foc = el('button', 'c3d-btn', acts, t('card.zoom'));
  foc.onclick = () => v.focusOnNote(i);

  const nb = [...m.adj[i]].sort((a, b) => m.notes[b].deg - m.notes[a].deg);
  secTitle(p, t('card.linked', { n: fmt(nb.length) }));
  if (!nb.length) el('div', 'c3d-card-faint', p, t('card.noLinks'));
  for (const j of nb.slice(0, 60)) {
    const o = m.notes[j];
    const b = el('button', 'c3d-rel', p);
    const top = el('span', 'c3d-rel-name', b);
    el('span', 'c3d-dot', top).style.color = v.noteCss(j);
    el('span', null, top, o.name);
    el('span', 'c3d-rel-sub', b, `${m.groups[o.gi].short} · ${o.mtime ? dateLong(o.mtime) : ''}`);
    b.onclick = () => v.selectNote(j, { fly: true });
  }
}

// ---- Stats
function renderStats(v, p) {
  const m = v.model;
  secTitle(p, t('statistics'));
  statLine(p, t('notes'), fmt(m.notes.length));
  statLine(p, t('linksCount'), fmt(m.directedLinks));
  statLine(p, t('folders'), fmt(m.groups.length));
  v.statWords = statLine(p, t('words'), '…');
  statLine(p, t('isolated'), fmt(m.isolated), m.isolated ? () => v.highlightWhere('orph', t('profile.orphL'), (n) => n.deg === 0) : null);
  const lpn = m.notes.length ? ((m.directedLinks * 2) / m.notes.length).toFixed(1) : '0';
  statLine(p, t('linksPerNote'), getLang() === 'fr' ? lpn.replace('.', ',') : lpn);
  v.updateWordStat();

  secTitle(p, t('biggest'));
  const top = [...m.groups].sort((a, b) => b.notes.length - a.notes.length).slice(0, 10);
  const max = top.length ? top[0].notes.length : 1;
  for (const g of top) {
    const row = el('button', 'c3d-st-top', p);
    row.title = g.full;
    const head = el('div', 'c3d-st-row', row);
    const nm = el('span', 'c3d-st-l', head);
    el('span', 'c3d-dot', nm).style.color = v.groupCss(g.idx);
    el('span', null, nm, g.full);
    el('span', 'c3d-st-v', head, fmt(g.notes.length));
    const bar = el('div', 'c3d-st-bar', row);
    const fill = el('div', 'c3d-st-fill', bar);
    fill.style.width = `${(100 * g.notes.length) / max}%`;
    fill.style.background = v.groupCss(g.idx);
    row.onclick = () => v.highlightCategory('folder', g.idx);
  }
  if (m.mostLinked && m.mostLinked.deg > 0) {
    secTitle(p, t('mostLinked'));
    const b = el('button', 'c3d-st-most', p);
    el('span', 'c3d-st-l', b, m.mostLinked.name);
    el('span', 'c3d-st-v', b, t('nLinks', { n: fmt(m.mostLinked.deg) }));
    const idx = m.mostLinked.i;
    b.onclick = () => v.selectNote(idx, { fly: true });
  }
}

// ---- Historique d'écriture
/** Barres de temps : jour, semaine ou mois selon l'étendue des dates. */
export function timelineData(model) {
  let min = Infinity;
  let max = -Infinity;
  const dates = model.notes.map((n) => {
    const c = n.first ? dayNumber(n.first) : null;
    const e = n.mtime ? dayNumber(n.mtime) : null;
    for (const d of [c, e]) {
      if (d == null) continue;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return [c, e];
  });
  if (min === Infinity) return { unit: 'day', buckets: [], dates, older: 0 };
  const span = max - min + 1;
  const unit = span <= 120 ? 'day' : span <= 1100 ? 'week' : 'month';
  const keyOf = (d) => {
    if (unit === 'day') return d;
    if (unit === 'week') return Math.floor((d + 3) / 7);
    const dt = dayToDate(d);
    return dt.getFullYear() * 12 + dt.getMonth();
  };
  const startOf = (k) => (unit === 'day' ? k : unit === 'week' ? k * 7 - 3 : dayNumber(new Date(Math.floor(k / 12), k % 12, 1).getTime()));
  let k0 = keyOf(min);
  const k1 = keyOf(max);
  let older = 0;
  if (k1 - k0 + 1 > 160) k0 = k1 - 159;
  const buckets = [];
  for (let k = k0; k <= k1; k++) {
    const s = startOf(k);
    let label;
    if (unit === 'day') label = dateShort(s);
    else if (unit === 'week') label = t('hist.weekOf', { d: dateShort(s) });
    else label = dayToDate(s).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    const tick =
      unit === 'month' ? dayToDate(s).toLocaleDateString(locale(), { month: 'short', year: '2-digit' }) : dateShort(s);
    buckets.push({ key: k, start: s, label, tick, created: 0, edited: 0, notes: [], byCat: new Map() });
  }
  const at = (d) => (d == null ? null : buckets[keyOf(d) - k0] || null);
  model.notes.forEach((n, i) => {
    const [c, e] = dates[i];
    const bc = at(c);
    const be = at(e);
    if (!bc && !be) older++;
    if (bc) {
      bc.created++;
      bc.notes.push(i);
    }
    if (be && be !== bc) {
      be.edited++;
      be.notes.push(i);
    }
  });
  return { unit, buckets, dates, older, keyOf, at };
}

const C_CREATED = '#3fa6ff';
const C_EDITED = '#9b6bff';

function barChart(v, parent, tl, segsOf, titleOf) {
  const wrap = el('div', 'c3d-chart', parent);
  const bars = el('div', 'c3d-bars', wrap);
  const totals = tl.buckets.map((b) => segsOf(b).reduce((s, x) => s + x[0], 0));
  const max = Math.max(1, ...totals);
  const sel = v.hl && v.hl.kind === 'period' ? v.hl.key : null;
  tl.buckets.forEach((b, k) => {
    const col = el('button', 'c3d-bar', bars);
    col.title = titleOf(b);
    if (sel === 'period:' + b.key) col.classList.add('is-active');
    // Hauteur en racine carrée : les petits jours restent visibles à côté d'un énorme pic.
    const H = totals[k] ? 100 * Math.sqrt(totals[k] / max) : 0;
    for (const [val, color] of segsOf(b)) {
      if (!val) continue;
      const s = el('span', 'c3d-seg', col);
      s.style.height = `${(H * val) / totals[k]}%`;
      s.style.background = color;
    }
    col.onclick = () => v.highlightPeriod(b);
  });
  const axis = el('div', 'c3d-axis', wrap);
  const B = tl.buckets.length;
  const ticks = Math.min(5, B);
  for (let j = 0; j < ticks; j++) {
    const k = ticks === 1 ? 0 : Math.round((j * (B - 1)) / (ticks - 1));
    const tk = el('span', 'c3d-tick-l', axis, tl.buckets[k].tick);
    tk.style.left = `${((k + 0.5) / B) * 100}%`;
  }
  return wrap;
}

function legend(p, items) {
  const lg = el('div', 'c3d-chart-legend', p);
  for (const [label, color, onClick] of items) {
    const it = el(onClick ? 'button' : 'span', 'c3d-lg-item', lg);
    el('span', 'c3d-dot', it).style.color = color;
    el('span', null, it, label);
    if (onClick) it.onclick = onClick;
  }
}

function renderHistory(v, p) {
  const m = v.model;
  const tl = v.timeline || (v.timeline = timelineData(m));
  el('div', 'c3d-side-desc', p, t('hist.desc', { unit: t('unit.' + tl.unit) }));
  if (!tl.buckets.length) {
    el('div', 'c3d-card-faint', p, t('hist.none'));
    return;
  }
  barChart(
    v,
    p,
    tl,
    (b) => [
      [b.created, C_CREATED],
      [b.edited, C_EDITED],
    ],
    (b) => t('hist.bar', { label: b.label, c: fmt(b.created), e: fmt(b.edited) })
  );
  legend(p, [
    [t('created'), C_CREATED],
    [t('edited'), C_EDITED],
  ]);
  if (tl.older) el('div', 'c3d-card-faint', p, t('hist.older', { n: fmt(tl.older) }));

  // Sujets dans le temps : barres empilées par dossier ou par étiquette.
  secTitle(p, t('hist.topics'));
  const row = el('div', 'c3d-vp-row', p);
  el('span', 'c3d-vp-label', row, t('hist.label'));
  const sel = el('select', 'c3d-select', row);
  for (const k of ['folder', 'tag']) {
    const o = el('option', null, sel, t('hist.' + k));
    o.value = k;
  }
  sel.value = v.tlLabel;
  sel.onchange = () => {
    v.tlLabel = sel.value;
    renderSide(v);
  };
  const byTag = v.tlLabel === 'tag';
  const catOf = (n) => (byTag ? n.tags[0] || '' : n.gi);
  const totals = new Map();
  for (const n of m.notes) {
    const c = catOf(n);
    if (byTag && !c) continue;
    totals.set(c, (totals.get(c) || 0) + 1);
  }
  if (byTag && !totals.size) {
    el('div', 'c3d-card-faint', p, t('hist.noTags'));
    return;
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map((e) => e[0]);
  const colorOf = (c) => (byTag ? v.tagCss(c) : v.folderCss(c));
  const OTHER = '#5b5e66';
  const segs = (b) => {
    const cnt = new Map();
    let other = 0;
    for (const i of b.notes) {
      const n = m.notes[i];
      if (tl.dates[i][0] == null || tl.at(tl.dates[i][0]) !== b) continue; // date de création seulement
      const c = catOf(n);
      if (byTag && !c) continue;
      if (top.includes(c)) cnt.set(c, (cnt.get(c) || 0) + 1);
      else other++;
    }
    const out = top.map((c) => [cnt.get(c) || 0, colorOf(c)]);
    out.push([other, OTHER]);
    return out;
  };
  barChart(v, p, tl, segs, (b) => `${b.label}: ${fmt(b.created)}`);
  const items = top.map((c) => [byTag ? '#' + c : m.groups[c].short, colorOf(c), () => (byTag ? v.highlightWhere('tag:' + c, '#' + c, (n) => n.tags.includes(c)) : v.highlightCategory('folder', c))]);
  if (totals.size > top.length) items.push([t('other'), OTHER]);
  legend(p, items);
}

// ---- Profil
function renderProfile(v, p) {
  const m = v.model;
  const N = m.notes.length || 1;
  const linked = m.notes.length - m.isolated;
  const big = el('div', 'c3d-you-big', p, pctTxt(Math.round((100 * linked) / N)));
  big.title = `${fmt(linked)} / ${fmt(m.notes.length)}`;
  el('div', 'c3d-side-desc', p, t('profile.linked'));
  const bar = el('div', 'c3d-you-bar', p);
  const a = el('span', null, bar);
  a.style.width = `${(100 * linked) / N}%`;
  a.style.background = C_CREATED;
  const b = el('span', null, bar);
  b.style.width = `${(100 * m.isolated) / N}%`;
  b.style.background = '#ff9a3c';
  legend(p, [
    [`${t('profile.linkedL')} ${fmt(linked)}`, C_CREATED],
    [`${t('profile.isolatedL')} ${fmt(m.isolated)}`, '#ff9a3c', m.isolated ? () => v.highlightWhere('orph', t('profile.orphL'), (n) => n.deg === 0) : null],
  ]);

  // Écriture
  const { words, missing } = wordTotals(m);
  secTitle(p, t('profile.writing'));
  statLine(p, t('profile.words'), fmt(words) + (missing ? '…' : ''));
  statLine(p, t('profile.avg'), fmt(Math.round(words / Math.max(1, m.notes.length - missing))) + (missing ? '…' : ''));
  let longest = -1;
  let lw = -1;
  m.notes.forEach((n, i) => {
    const w = m.wordCache.get(n.path);
    if (w != null && w > lw) {
      lw = w;
      longest = i;
    }
  });
  if (longest >= 0) statLine(p, t('profile.longest'), m.notes[longest].name, () => v.selectNote(longest, { fly: true }));

  // Rythme
  secTitle(p, t('profile.rhythm'));
  const days = new Map();
  const wd = new Array(7).fill(0);
  const hr = new Array(24).fill(0);
  for (const n of m.notes) {
    if (!n.mtime) continue;
    const d = dayNumber(n.mtime);
    days.set(d, (days.get(d) || 0) + 1);
    const dt = new Date(n.mtime);
    wd[dt.getDay()]++;
    hr[dt.getHours()]++;
  }
  statLine(p, t('profile.activeDays'), fmt(days.size));
  let bestD = null;
  let bestN = 0;
  for (const [d, c] of days) if (c > bestN) [bestD, bestN] = [d, c];
  if (bestD != null)
    statLine(p, t('profile.bestDay'), `${dateShort(bestD)} · ${fmt(bestN)}`, () =>
      v.highlightWhere('day:' + bestD, dateShort(bestD), (n) => n.mtime && dayNumber(n.mtime) === bestD)
    );
  const wBest = wd.indexOf(Math.max(...wd));
  const wname = new Date(2024, 0, 7 + wBest).toLocaleDateString(locale(), { weekday: 'long' });
  statLine(p, t('profile.weekday'), wname);
  const hBest = hr.indexOf(Math.max(...hr));
  statLine(p, t('profile.hour'), getLang() === 'fr' ? `${hBest} h` : `${hBest}:00`);

  // Carrefours
  secTitle(p, t('profile.hubs'));
  const hubs = m.notes
    .filter((n) => n.deg > 0)
    .sort((x, y) => y.deg - x.deg)
    .slice(0, 6);
  for (const n of hubs) statLine(p, n.name, t('nLinks', { n: fmt(n.deg) }), () => v.selectNote(n.i, { fly: true }));

  // En attente
  secTitle(p, t('profile.waiting'));
  const short = m.notes.filter((n) => {
    const w = m.wordCache.get(n.path);
    return w != null && w < 50;
  }).length;
  statLine(p, missing ? t('profile.counting') : t('profile.short', { n: fmt(short) }), short ? t('profile.light') : '', short
    ? () =>
        v.highlightWhere('short', t('profile.shortL'), (n) => {
          const w = m.wordCache.get(n.path);
          return w != null && w < 50;
        })
    : null);
  statLine(p, t('profile.orph', { n: fmt(m.isolated) }), m.isolated ? t('profile.light') : '', m.isolated ? () => v.highlightWhere('orph', t('profile.orphL'), (n) => n.deg === 0) : null);
}
