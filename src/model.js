// Lecture du coffre : notes, dossiers, liens (metadataCache.resolvedLinks) et statistiques.

import { hashStr, dayNumber } from './util.js';
import { t } from './i18n.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function parseSplit(text) {
  return (text || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

/**
 * Dossier d'une note. En général le dossier de premier niveau ; pour un
 * dossier « éclaté » (réglage « Séparer en sous-dossiers », vide par défaut),
 * chaque sous-dossier direct compte comme un dossier à part.
 */
export function groupKeyFor(path, split) {
  const parts = path.split('/');
  parts.pop();
  if (!parts.length) return '/';
  for (const s of split) {
    const sp = s.split('/');
    if (parts.length > sp.length && sp.every((x, i) => parts[i] === x)) {
      return parts.slice(0, sp.length + 1).join('/');
    }
  }
  return parts[0];
}

export function groupLabel(key) {
  if (key === '/') return { short: t('root'), full: t('rootFull') };
  const parts = key.split('/');
  return { short: parts[parts.length - 1], full: parts.join(' › ') };
}

/**
 * Construit le modèle affiché. `wordCache` : Map chemin → nombre de mots
 * (rempli en tâche de fond).
 */
export function buildModel(app, settings, wordCache) {
  const split = parseSplit(settings.splitFolders);
  const files = app.vault.getMarkdownFiles();

  // Dossiers de premier niveau qui ont des sous-dossiers (proposés dans « Séparer en sous-dossiers »).
  const subs = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.length < 3) continue;
    if (!subs.has(parts[0])) subs.set(parts[0], new Set());
    subs.get(parts[0]).add(parts[1]);
  }
  const splittable = [...subs.entries()]
    .map(([name, set]) => ({ name, count: set.size }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const mc = app.metadataCache;
  const notes = files.map((f) => {
    const mtime = (f.stat && f.stat.mtime) || 0;
    const ctime = (f.stat && f.stat.ctime) || 0;
    const parts = f.path.split('/');
    parts.pop();
    return {
      path: f.path,
      name: f.basename,
      file: f,
      group: groupKeyFor(f.path, split),
      // Sous-dossier : les deux premiers niveaux de dossiers.
      sub: parts.length ? parts.slice(0, 2).join('/') : '/',
      tags: tagsOf(mc, f),
      mtime,
      ctime,
      // Première date connue (création ou modification) : l'ordre de la « mémoire ».
      first: ctime && mtime ? Math.min(ctime, mtime) : ctime || mtime,
      size: (f.stat && f.stat.size) || 0,
      seed: hashStr(f.path),
      deg: 0,
      out: 0,
      inn: 0,
      i: 0,
      gi: 0,
    };
  });
  notes.sort((a, b) => collator.compare(a.group, b.group) || collator.compare(a.path, b.path));

  const groups = [];
  const gmap = new Map();
  notes.forEach((n, i) => {
    n.i = i;
    let g = gmap.get(n.group);
    if (!g) {
      g = { key: n.group, ...groupLabel(n.group), idx: groups.length, notes: [] };
      gmap.set(n.group, g);
      groups.push(g);
    }
    g.notes.push(i);
    n.gi = g.idx;
  });

  // Liens résolus : on garde les liens entre notes Markdown, sans les boucles.
  const N = notes.length;
  const index = new Map(notes.map((n) => [n.path, n.i]));
  const rl = (app.metadataCache && app.metadataCache.resolvedLinks) || {};
  const pairSet = new Set();
  const pairs = [];
  let directed = 0;
  for (const src in rl) {
    const a = index.get(src);
    if (a === undefined) continue;
    const targets = rl[src];
    for (const dst in targets) {
      const b = index.get(dst);
      if (b === undefined || b === a) continue;
      directed++;
      notes[a].out++;
      notes[b].inn++;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * N + hi;
      if (!pairSet.has(key)) {
        pairSet.add(key);
        pairs.push(lo, hi);
      }
    }
  }
  const G = groups.length;
  const groupLinks = new Map();
  const adj = notes.map(() => []);
  for (let k = 0; k < pairs.length; k += 2) {
    const a = notes[pairs[k]];
    const b = notes[pairs[k + 1]];
    adj[a.i].push(b.i);
    adj[b.i].push(a.i);
    a.deg++;
    b.deg++;
    if (a.gi !== b.gi) {
      const lo = Math.min(a.gi, b.gi);
      const hi = Math.max(a.gi, b.gi);
      const key = lo * G + hi;
      groupLinks.set(key, (groupLinks.get(key) || 0) + 1);
    }
  }

  let maxDeg = 0;
  let isolated = 0;
  let mostLinked = null;
  let minSize = Infinity;
  let maxSize = 0;
  for (const n of notes) {
    if (n.deg > maxDeg) {
      maxDeg = n.deg;
      mostLinked = n;
    }
    if (n.deg === 0) isolated++;
    minSize = Math.min(minSize, Math.max(1, n.size));
    maxSize = Math.max(maxSize, Math.max(1, n.size));
  }

  // Jours de modification (pour la courbe et la couleur par date).
  const dayList = [...new Set(notes.map((n) => dayNumber(n.mtime)))].sort((a, b) => a - b);
  const dayRank = new Map(dayList.map((d, i) => [d, i]));

  // Ordre dans le temps (de la plus ancienne à la plus récente) : la moelle de la forme Cerveau.
  const timeOrder = notes
    .map((n) => n.i)
    .sort((a, b) => notes[a].first - notes[b].first || notes[a].seed - notes[b].seed);
  timeOrder.forEach((ni, r) => (notes[ni].trank = r));

  // Signature de structure : si elle ne change pas, les formes ne bougent pas.
  let sig = 2166136261 >>> 0;
  const mix = (v) => {
    sig ^= v;
    sig = Math.imul(sig, 16777619) >>> 0;
  };
  for (const n of notes) mix(n.seed ^ hashStr(n.group));
  for (let k = 0; k < pairs.length; k++) mix(pairs[k]);

  return {
    notes,
    groups,
    pairs: Uint32Array.from(pairs),
    groupLinks,
    directedLinks: directed,
    maxDeg,
    isolated,
    mostLinked,
    minSize: minSize === Infinity ? 1 : minSize,
    maxSize: Math.max(1, maxSize),
    dayList,
    dayRank,
    timeOrder,
    adj,
    structSig: sig,
    splittable,
    wordCache,
  };
}

/** Étiquettes d'une note (#tag dans le texte et `tags:` dans les propriétés), sans « # », en minuscules. */
function tagsOf(mc, f) {
  const c = mc && typeof mc.getFileCache === 'function' ? mc.getFileCache(f) : null;
  if (!c) return [];
  const out = [];
  const add = (v) => {
    if (typeof v !== 'string') return;
    for (const p of v.split(/[,\s]+/)) {
      const tg = p.replace(/^#/, '').trim().toLowerCase();
      if (tg && !out.includes(tg)) out.push(tg);
    }
  };
  const fm = c.frontmatter;
  if (fm) {
    for (const key of ['tags', 'tag']) {
      const v = fm[key];
      if (Array.isArray(v)) v.forEach(add);
      else add(v);
    }
  }
  if (Array.isArray(c.tags)) for (const x of c.tags) add(x && x.tag);
  return out;
}

/** Arbre des dossiers (pour le navigateur) : nombre de notes par dossier, sous-dossiers et notes directes. */
export function folderTree(model) {
  const root = { name: '', path: '', count: 0, kids: new Map(), notes: [], gi: -1 };
  for (const n of model.notes) {
    const parts = n.path.split('/');
    parts.pop();
    let node = root;
    root.count++;
    let p = '';
    for (const part of parts) {
      p = p ? p + '/' + part : part;
      let k = node.kids.get(part);
      if (!k) {
        k = { name: part, path: p, count: 0, kids: new Map(), notes: [], gi: n.gi };
        node.kids.set(part, k);
      }
      k.count++;
      node = k;
    }
    node.notes.push(n.i);
  }
  const sortNode = (node) => {
    node.list = [...node.kids.values()].sort((a, b) => collator.compare(a.name, b.name));
    node.notes.sort((a, b) => collator.compare(model.notes[a].name, model.notes[b].name));
    node.list.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/** Somme des mots connus et nombre de notes encore à compter. */
export function wordTotals(model) {
  let words = 0;
  let missing = 0;
  for (const n of model.notes) {
    const w = model.wordCache.get(n.path);
    if (w == null) missing++;
    else words += w;
  }
  return { words, missing };
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
export function countWords(text) {
  // On ignore l'en-tête YAML éventuel.
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) text = text.slice(end + 4);
  }
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}
