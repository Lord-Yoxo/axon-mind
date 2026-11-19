// Les formes. Chaque fonction renvoie la position de chaque note, celle de chaque
// grain de poussière (avec son rôle), les étiquettes, le cadrage et une question
// à laquelle la vue répond. Tout est déterministe : même coffre, même forme.

import { TAU, GOLDEN, hash01, dayNumber, dayToDate, fmt, clamp, smoothstep } from './util.js';
import { t, locale } from './i18n.js';

export const VIEWS = [
  { key: 'brain', label: 'Cerveau', rot: 'spinY' },
  { key: 'molecule', label: 'Molécule', rot: 'spinY' },
  { key: 'grid', label: 'Grille', rot: 'sway' },
  { key: 'curve', label: 'Courbe', rot: 'sway' },
  { key: 'wheel', label: 'Roue', rot: 'sway' },
  { key: 'flow', label: 'Flux', rot: 'sway' },
  { key: 'life', label: 'Lignes de vie', rot: 'sway' },
  { key: 'micro', label: 'Microscope', rot: 'spinZ' },
];

export const ROLE = {
  HAZE: 0,
  FILAMENT: 2,
  NUCLEUS: 3,
  ORBIT: 4,
  LATTICE: 5,
  AXIS: 6,
  CURVE: 7,
  SPOKE: 8,
  RIM: 9,
  SPINE: 10,
  RIB: 11,
  SKIN: 12,
  NECK: 13,
  CEREBELLUM: 14,
  STEM: 15,
  RIBBON: 16,
  ARC: 17,
  ROWLINE: 18,
  BAR: 19,
  FILL: 20,
  RINGFILL: 21,
  RECORD: 22,
  BONE: 23,
  NERVE: 24,
};
/** Rôles qui forment le corps (la « silhouette », masquée quand le curseur Anatomie est au minimum). */
export const BODY_ROLES = new Set([ROLE.SPINE, ROLE.RIB, ROLE.SKIN, ROLE.NECK]);
/** Squelette et nerfs (curseur Squelette). */
export const SKEL_ROLES = new Set([ROLE.BONE, ROLE.NERVE]);

const GA = Math.PI * (3 - Math.sqrt(5)); // angle d'or

export function computeLayout(key, model, D, aspect, opts = {}) {
  switch (key) {
    case 'molecule':
      return layoutMolecule(model, D);
    case 'grid':
      return layoutGrid(model, D, aspect);
    case 'curve':
      return layoutCurve(model, D, aspect);
    case 'wheel':
      return opts.wheelStyle === 'clock' ? layoutClock(model, D) : layoutSlices(model, D);
    case 'flow':
      return layoutFlow(model, D, aspect);
    case 'life':
      return layoutLife(model, D, aspect);
    case 'micro':
      return layoutMicro(model, D);
    default:
      return layoutBrain(model, D);
  }
}

function base(key, model, D) {
  return {
    key,
    pos: new Float32Array(model.notes.length * 3),
    dustPos: new Float32Array(D * 3),
    dustRole: new Uint8Array(D),
    dustGroup: new Int16Array(D).fill(-1),
    dustOwner: null, // note portée par chaque grain de la moelle (forme Cerveau)
    dustT: null, // place du grain dans le temps (0 = plus ancien, 1 = plus récent)
    labels: [],
    frame: { center: [0, 0, 0], width: 200, height: 200, depth: 0 },
    camDir: [0, 0, 1],
    linkFactor: 0,
    sizeMul: 1,
    drift: 0.3,
    question: '',
    answer: '',
  };
}

// Étoiles de fond : une coquille lointaine (vues 3D) ou un plan derrière (vues à plat).
function hazeSphere(i, out, o) {
  const u = 2 * hash01(i, 901) - 1;
  const a = TAU * hash01(i, 902);
  const r = 480 + 460 * hash01(i, 903);
  const s = Math.sqrt(1 - u * u);
  out[o] = Math.cos(a) * s * r;
  out[o + 1] = u * r;
  out[o + 2] = Math.sin(a) * s * r;
}
function hazeFlat(i, out, o, w, h) {
  out[o] = (hash01(i, 904) - 0.5) * w * 2.8;
  out[o + 1] = (hash01(i, 905) - 0.5) * h * 2.8;
  out[o + 2] = -140 - 460 * hash01(i, 906);
}

function ballPoint(i, salt, r) {
  const u = 2 * hash01(i, salt) - 1;
  const a = TAU * hash01(i, salt + 1);
  const rr = r * Math.cbrt(hash01(i, salt + 2));
  const s = Math.sqrt(1 - u * u);
  return [Math.cos(a) * s * rr, u * rr, Math.sin(a) * s * rr];
}

function rotXY(x, y, z, rx, ry) {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  return [x * cy + z1 * sy, y1, -x * sy + z1 * cy];
}

/** Choisit un indice selon des poids (tableau cumulé). */
function pickCdf(cdf, r) {
  const x = r * cdf[cdf.length - 1];
  let lo = 0,
    hi = cdf.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (cdf[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Treemap « squarified » : rectangles d'aire proportionnelle, dans l'ordre d'entrée. */
export function squarify(values, x, y, w, h) {
  const out = new Array(values.length);
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
  const total = values.reduce((s, v) => s + v, 0) || 1;
  const scale = (w * h) / total;
  let rx = x,
    ry = y,
    rw = w,
    rh = h;
  let row = [];
  let rowIdx = [];
  const worst = (r, side) => {
    let s = 0,
      mx = 0,
      mn = Infinity;
    for (const a of r) {
      s += a;
      if (a > mx) mx = a;
      if (a < mn) mn = a;
    }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const flush = () => {
    const s = row.reduce((a, b) => a + b, 0);
    if (rw >= rh) {
      const cw = s / rh;
      let cy = ry;
      row.forEach((a, k) => {
        const hh = a / cw;
        out[rowIdx[k]] = [rx, cy, cw, hh];
        cy += hh;
      });
      rx += cw;
      rw -= cw;
    } else {
      const ch = s / rw;
      let cx = rx;
      row.forEach((a, k) => {
        const ww = a / ch;
        out[rowIdx[k]] = [cx, ry, ww, ch];
        cx += ww;
      });
      ry += ch;
      rh -= ch;
    }
    row = [];
    rowIdx = [];
  };
  let i = 0;
  while (i < order.length) {
    const a = values[order[i]] * scale;
    const side = Math.min(rw, rh);
    if (!row.length || worst(row.concat(a), side) <= worst(row, side)) {
      row.push(a);
      rowIdx.push(order[i]);
      i++;
    } else flush();
  }
  if (row.length) flush();
  return out;
}

/** Carré [0,1]² → disque unité, en gardant les aires (Shirley-Chiu). */
function concentric(u, v) {
  const a = 2 * u - 1;
  const b = 2 * v - 1;
  if (a === 0 && b === 0) return [0, 0];
  let r, phi;
  if (Math.abs(a) > Math.abs(b)) {
    r = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

const fmtDayShort = (day) => dayToDate(day).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });
const fmtDayLong = (day) => dayToDate(day).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });

/** Jours couverts (limité à deux ans pour garder une forme lisible). */
function daySpan(days) {
  let minDay = Infinity;
  let maxDay = -Infinity;
  for (const d of days) {
    if (d < minDay) minDay = d;
    if (d > maxDay) maxDay = d;
  }
  if (!days.length) minDay = maxDay = dayNumber(Date.now());
  const clipped = maxDay - minDay + 1 > 730;
  if (clipped) minDay = maxDay - 729;
  return { minDay, maxDay, Dn: maxDay - minDay + 1, clipped };
}

/** Catmull-Rom sans dépassement entre p1 et p2. */
function smoothAt(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  return Math.min(Math.max(v, Math.min(p1, p2)), Math.max(p1, p2));
}

// ---------------------------------------------------------------- 1. Cerveau
// Un cerveau (les notes, groupées par dossier) posé sur une moelle épinière et un
// torse de poussière : colonne vertébrale lumineuse, nervures, contour du corps.
export const BRAIN = { A: 24, B: 33, C: 36, GAP: 2 };

function layoutBrain(model, D) {
  const L = base('brain', model, D);
  const { notes, groups } = model;
  const { A, B, C, GAP } = BRAIN;

  // Répartit les dossiers entre les deux hémisphères (le plus léger reçoit le suivant).
  const hemi = [
    { s: -1, total: 0, groups: [] },
    { s: 1, total: 0, groups: [] },
  ];
  const bySize = [...groups].sort((a, b) => b.notes.length - a.notes.length || a.idx - b.idx);
  for (const g of bySize) {
    const h = hemi[0].total <= hemi[1].total ? hemi[0] : hemi[1];
    h.groups.push(g);
    h.total += g.notes.length;
  }

  // Point de la surface : carré → disque → demi-sphère → forme de cerveau plissée.
  const surf = (u, v, s, rad) => {
    const [dx, dy] = concentric(u, v);
    const rho2 = Math.min(1, dx * dx + dy * dy);
    const k = Math.sqrt(Math.max(0, 2 - rho2));
    const x = 1 - rho2; // vers l'extérieur
    const y = dy * k; // haut / bas
    const z = dx * k; // avant / arrière
    const temporal = Math.exp(-(((z - 0.12) / 0.4) ** 2) - (((y + 0.45) / 0.32) ** 2));
    const fold =
      1 + 0.05 * Math.sin(x * 11 + y * 7) * Math.sin(z * 9 - y * 8) + 0.03 * Math.sin(z * 19 + x * 13 + y * 5);
    const r = rad * fold;
    const X = x * (1 + 0.3 * temporal) * A * r;
    let Y = y * B * r;
    const Z = z * C * r * (1 - 0.06 * smoothstep(0.2, 1, -z) * Math.max(0, -y));
    if (Y < 0) Y *= 0.74;
    Y -= temporal * 0.16 * B * r;
    Y -= smoothstep(0.3, 1, z) * 0.1 * B * Math.max(0, y);
    return [s * (GAP + X), Y, Z, s * x, y, z];
  };

  const anchors = new Array(groups.length);
  for (const h of hemi) {
    if (!h.groups.length) continue;
    const rects = squarify(
      h.groups.map((g) => g.notes.length),
      0,
      0,
      1,
      1
    );
    h.groups.forEach((g, gk) => {
      const [rx, ry, rw, rh] = rects[gk];
      const n = g.notes.length;
      const cols = Math.max(1, Math.round(Math.sqrt((n * rw) / Math.max(rh, 1e-6))));
      const rows = Math.ceil(n / cols);
      g.notes.forEach((ni, k) => {
        const seed = notes[ni].seed;
        const col = k % cols;
        const row = Math.floor(k / cols);
        const u = rx + ((col + 0.5 + (hash01(seed, 1) - 0.5) * 0.8) / cols) * rw;
        const v = ry + ((row + 0.5 + (hash01(seed, 2) - 0.5) * 0.8) / rows) * rh;
        const p = surf(u, v, h.s, 0.86 + 0.14 * hash01(seed, 3));
        L.pos[ni * 3] = p[0];
        L.pos[ni * 3 + 1] = p[1];
        L.pos[ni * 3 + 2] = p[2];
      });
      const c = surf(rx + rw / 2, ry + rh / 2, h.s, 1.12);
      const inner = surf(rx + rw / 2, ry + rh / 2, h.s, 0.78);
      anchors[g.idx] = { p: c.slice(0, 3), n: c.slice(3, 6), inner: inner.slice(0, 3) };
    });
  }

  // Noms (affichés seulement si « Étiquettes » est sur « Toujours » : la vidéo n'en montre pas).
  const maxN = Math.max(1, ...groups.map((g) => g.notes.length));
  const named = new Set(bySize.slice(0, 16).map((g) => g.idx));
  for (const g of groups) {
    const a = anchors[g.idx];
    if (!a || !named.has(g.idx)) continue;
    L.labels.push({
      text: g.short,
      sub: String(g.notes.length),
      x: a.p[0],
      y: a.p[1],
      z: a.p[2],
      n: a.n,
      align: 'center',
      weight: Math.sqrt(g.notes.length / maxN),
      kind: 'group',
      gi: g.idx,
      autoHide: true,
    });
  }

  // Corps : profil (demi-largeur) en fonction de la hauteur.
  const neckTop = -B * 0.45;
  const neckBot = -46;
  const shoulder = -90;
  const bottom = -262;
  // Silhouette en buste : cou court, larges épaules qui s'évasent en douceur (en cloche), torse qui s'affine.
  const bodyR = (y) => {
    if (y >= neckBot) return 9.5 + 3 * smoothstep(neckBot + 16, neckTop, y);
    if (y >= shoulder) {
      const t = (neckBot - y) / (neckBot - shoulder);
      const s = t * t * t * (t * (t * 6 - 15) + 10); // courbe en S très douce
      return 9.5 + 66 * s;
    }
    const t = clamp((shoulder - y) / (shoulder - bottom), 0, 1);
    return Math.max(3, 75.5 + 10 * Math.sin(t * Math.PI * 0.6) - 84 * t ** 3.2);
  };
  const DEPTH = 0.42;
  const G = groups.length;
  const ribYs = [];
  for (let y = shoulder - 6; y > bottom + 28; y -= 13) ribYs.push(y);

  // Répartition de la poussière (rôle choisi au hasard pour que tout préfixe reste représentatif).
  const N = notes.length;
  const shares = [
    [ROLE.FILAMENT, 0.08],
    [ROLE.RECORD, N ? 0.37 : 0],
    [ROLE.SPINE, 0.03],
    [ROLE.BONE, 0.08],
    [ROLE.NERVE, 0.06],
    [ROLE.SKIN, 0.14],
    [ROLE.NECK, 0.04],
    [ROLE.CEREBELLUM, 0.07],
    [ROLE.STEM, 0.03],
    [ROLE.HAZE, 0.1],
  ];
  const cdf = [];
  let acc = 0;
  for (const [, w] of shares) cdf.push((acc += w));

  // La « mémoire » : une longue moelle faite des notes rangées dans le temps,
  // de la plus ancienne (au bout) à la plus récente (sous le cerveau).
  // Chaque note a la même longueur ; les grosses notes y mettent plus de grains.
  L.dustOwner = new Int32Array(D).fill(-1);
  L.dustT = new Float32Array(D);
  const order = model.timeOrder || [];
  const wcdf = new Float64Array(N);
  let wacc = 0;
  for (let r = 0; r < N; r++) {
    wacc += 0.6 + Math.sqrt(Math.max(0, notes[order[r]].size) / 900);
    wcdf[r] = wacc;
  }
  const cordTop = -B * 0.4;
  const cordBot = bottom - 22;
  const cordAt = (s) => {
    // s : 0 sous le cerveau → 1 au bout. Courbure douce (comme une vraie colonne) qui se voit en tournant.
    const y = cordTop + (cordBot - cordTop) * s;
    const x = 3.2 * Math.sin(s * Math.PI * 1.15) * s;
    const z = -C * 0.18 - 4 + 10 * Math.sin(s * Math.PI * 1.7 - 0.4) * Math.min(1, s * 3);
    return [x, y, z];
  };
  const spineAt = (y) => cordAt(clamp((y - cordTop) / (cordBot - cordTop), 0, 1));

  // ---- Squelette et nerfs : des polylignes (os et nerfs), dessinées en traits fins et semées de grains.
  // Repère : x vers les côtés, y vers le haut, z vers l'avant (le dos est en z négatif).
  const bones = [];
  const nerves = [];
  let rk = 1;
  const rnd = () => hash01(rk++, 977);
  const inner = (y, k) => bodyR(y) * k;
  const around = (ang, y, k) => {
    const r = inner(y, k);
    return [Math.sin(ang) * r, y, -Math.cos(ang) * r * DEPTH];
  };
  const shoulderTip = (s) => [s * inner(shoulder + 8, 0.92), shoulder + 8, -2];
  // Côtes : partent de la colonne, s'enroulent sur les côtés et descendent vers le sternum.
  const RIBS = 11;
  const ribPaths = [];
  for (let i = 0; i < RIBS; i++) {
    const yb = shoulder - 3 - i * 11;
    const reach = i < 7 ? Math.PI - 0.32 : Math.PI * (0.78 - (i - 7) * 0.09); // côtes flottantes plus courtes
    for (const s of [-1, 1]) {
      const pts = [spineAt(yb)];
      const n = 16;
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const ang = 0.3 + (reach - 0.3) * u;
        const y = yb - 15 * Math.pow(u, 1.3);
        const p = around(ang, y, 0.84);
        p[0] *= s;
        pts.push(p);
      }
      bones.push(pts);
      ribPaths.push(pts);
    }
  }
  // Sternum, clavicules, omoplates, bassin.
  const zf = (y) => inner(y, 0.84) * DEPTH;
  const sternum = [];
  for (let y = shoulder - 1; y >= shoulder - 66; y -= 5) sternum.push([0, y, zf(y)]);
  bones.push(sternum);
  for (const s of [-1, 1]) {
    const a = [0, shoulder - 1, zf(shoulder - 1)];
    const b = shoulderTip(s);
    const cl = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      cl.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u + 3 * Math.sin(u * Math.PI), a[2] + (b[2] - a[2]) * u + 2 * Math.sin(u * TAU)]);
    }
    bones.push(cl);
    const zb = (y) => -inner(y, 0.8) * DEPTH;
    const t1 = [s * 13, shoulder - 6];
    const t2 = [s * inner(shoulder - 4, 0.66), shoulder - 4];
    const t3 = [s * 22, shoulder - 54];
    const tri = [t1, t2, t3, t1];
    const sc = [];
    for (let e = 0; e < 3; e++) {
      for (let k = 0; k < 8; k++) {
        const u = k / 8;
        const x = tri[e][0] + (tri[e + 1][0] - tri[e][0]) * u;
        const y = tri[e][1] + (tri[e + 1][1] - tri[e][1]) * u;
        sc.push([x, y, zb(y)]);
      }
    }
    sc.push([t1[0], t1[1], zb(t1[1])]);
    bones.push(sc);
    // Bassin : une aile de chaque côté, du dos vers l'avant.
    const il = [];
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      const ang = 0.35 + 2.2 * u;
      const y = -226 - 8 * Math.sin(u * Math.PI) - 10 * u;
      const p = around(ang, y, 0.9);
      p[0] *= s;
      il.push(p);
    }
    bones.push(il);
  }
  // Nerfs : petites branches qui partent d'un tronc, vers l'extérieur et vers le bas, toujours dans le corps.
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const keepIn = (p) => {
    const rm = inner(p[1], 0.95);
    const r = Math.hypot(p[0], p[2] / DEPTH);
    if (r > rm) {
      p[0] *= rm / r;
      p[2] *= rm / r;
    }
    return p;
  };
  const branch = (p0, dir, len, depth, steps) => {
    const pts = [p0];
    let p = p0.slice();
    let d = dir.slice();
    const st = len / steps;
    for (let k = 0; k < steps; k++) {
      d = norm([d[0] + (rnd() - 0.5) * 0.45, d[1] + (rnd() - 0.5) * 0.3, d[2] + (rnd() - 0.5) * 0.35]);
      p = keepIn([p[0] + d[0] * st, p[1] + d[1] * st, p[2] + d[2] * st]);
      pts.push(p);
      if (depth > 0 && k > 0 && rnd() < 0.3) {
        const sx = Math.sign(d[0]) || 1;
        branch(p, norm([d[0] + sx * 0.5 * rnd(), d[1] - 0.6 * rnd(), d[2] + (rnd() - 0.5) * 0.8]), len * (0.3 + 0.25 * rnd()), depth - 1, Math.max(3, Math.round(steps * 0.5)));
      }
    }
    nerves.push(pts);
  };
  /** Nerf qui suit un chemin donné (avec un léger tremblé), et lance des ramifications. */
  const follow = (path, depth, jit = 1.2) => {
    const pts = path.map((q) => keepIn([q[0] + (rnd() - 0.5) * jit, q[1] + (rnd() - 0.5) * jit, q[2] + (rnd() - 0.5) * jit]));
    nerves.push(pts);
    for (let k = 2; k < pts.length - 1; k++) {
      if (depth > 0 && rnd() < 0.18) {
        const a = pts[k];
        const b = pts[k + 1];
        const sx = Math.sign(a[0]) || 1;
        branch(a, norm([b[0] - a[0] + sx * 2 * rnd(), b[1] - a[1] - 3 * rnd(), b[2] - a[2]]), 10 + 14 * rnd(), depth - 1, 5);
      }
    }
  };
  for (const s of [-1, 1]) {
    // Plexus des épaules : plusieurs racines du cou qui se rejoignent vers l'épaule, puis descendent le long du flanc.
    const tip = shoulderTip(s);
    for (let r = 0; r < 4; r++) {
      const a = spineAt(-50 - r * 8);
      const path = [];
      for (let k = 0; k <= 10; k++) {
        const u = k / 10;
        path.push([a[0] + (tip[0] - a[0]) * u, a[1] + (tip[1] - 6 - a[1]) * u - 6 * Math.sin(u * Math.PI), a[2] + (tip[2] - a[2]) * u + 4 * Math.sin(u * Math.PI)]);
      }
      follow(path, 1, 1.4);
    }
    const arm = [];
    for (let y = tip[1]; y >= -208; y -= 6) arm.push([s * inner(y, 0.9), y, 3 + 2 * Math.sin(y * 0.11)]);
    follow(arm, 2, 1.6);
    // Bas du dos : de gros nerfs qui descendent vers les jambes.
    for (let r = 0; r < 3; r++) {
      const a = spineAt(-200 - r * 11);
      branch(a, norm([s * 0.5, -1, 0.15]), 48 + 10 * r, 2, 9);
    }
  }
  // Nerfs le long des côtes (juste en dessous de chaque côte).
  for (const rp of ribPaths) follow(rp.map((q) => [q[0] * 0.97, q[1] - 2.6, q[2] * 0.97]), 1, 0.9);

  // Segments (pour les traits) et longueurs cumulées (pour semer les grains uniformément).
  const segs = { bone: [], nerve: [] };
  for (const [kind, list] of [['bone', bones], ['nerve', nerves]]) {
    for (const pts of list) for (let k = 0; k + 1 < pts.length; k++) segs[kind].push([...pts[k], ...pts[k + 1]]);
  }
  const cum = (list) => {
    const c = new Float64Array(list.length);
    let a = 0;
    list.forEach((sg, k) => {
      a += Math.hypot(sg[3] - sg[0], sg[4] - sg[1], sg[5] - sg[2]) + 1e-6;
      c[k] = a;
    });
    return c;
  };
  const cumBone = cum(segs.bone);
  const cumNerve = cum(segs.nerve);
  const allSegs = segs.bone.concat(segs.nerve);
  L.skelLines = new Float32Array(allSegs.length * 6);
  L.skelKind = new Uint8Array(allSegs.length * 2); // 0 = os, 1 = nerf (par sommet)
  allSegs.forEach((sg, k) => {
    L.skelLines.set(sg, k * 6);
    L.skelKind[k * 2] = L.skelKind[k * 2 + 1] = k < segs.bone.length ? 0 : 1;
  });
  const onSeg = (list, c, i, salt) => {
    const sg = list[pickCdf(c, hash01(i, salt))];
    const u = hash01(i, salt + 1);
    const j = 0.7;
    return [
      sg[0] + (sg[3] - sg[0]) * u + (hash01(i, salt + 2) - 0.5) * j,
      sg[1] + (sg[4] - sg[1]) * u + (hash01(i, salt + 3) - 0.5) * j,
      sg[2] + (sg[5] - sg[2]) * u + (hash01(i, salt + 4) - 0.5) * j,
    ];
  };

  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const role = shares[pickCdf(cdf, hash01(i, 11))][0];
    let x = 0,
      y = 0,
      z = 0;
    switch (role) {
      case ROLE.RECORD: {
        const r = pickCdf(wcdf, hash01(i, 60));
        const tt = (r + hash01(i, 61)) / N; // 0 = plus ancien
        const s = 1 - tt;
        const c0 = cordAt(s);
        // Vertèbres : des anneaux plus larges et plus lumineux à intervalle régulier.
        const yy = c0[1];
        const vert = Math.pow(Math.max(0, Math.cos((yy / 7.2) * TAU)), 6);
        const flare = s < 0.1 ? 1 + 1.25 * (1 - s / 0.1) ** 2 : 1; // le tronc cérébral s'évase sous le cerveau
        const R = 9.6 * (1 - 0.6 * s) * (0.82 + 0.5 * vert) * flare;
        const rr = R * Math.pow(hash01(i, 62), 0.6);
        const a = TAU * hash01(i, 63);
        x = c0[0] + Math.cos(a) * rr;
        y = yy + (hash01(i, 64) - 0.5) * 1.6;
        z = c0[2] + Math.sin(a) * rr * 0.85;
        L.dustOwner[i] = order[r];
        L.dustT[i] = tt;
        break;
      }
      case ROLE.BONE: {
        if (!segs.bone.length) {
          hazeSphere(i, L.dustPos, o);
          L.dustRole[i] = ROLE.HAZE;
          continue;
        }
        [x, y, z] = onSeg(segs.bone, cumBone, i, 70);
        break;
      }
      case ROLE.NERVE: {
        if (!segs.nerve.length) {
          hazeSphere(i, L.dustPos, o);
          L.dustRole[i] = ROLE.HAZE;
          continue;
        }
        [x, y, z] = onSeg(segs.nerve, cumNerve, i, 80);
        break;
      }
      case ROLE.FILAMENT: {
        if (!G) {
          hazeSphere(i, L.dustPos, o);
          L.dustRole[i] = ROLE.HAZE;
          continue;
        }
        const g = Math.min(G - 1, Math.floor(hash01(i, 16) * G));
        const a = anchors[g];
        if (!a) {
          hazeSphere(i, L.dustPos, o);
          L.dustRole[i] = ROLE.HAZE;
          continue;
        }
        const t = hash01(i, 17);
        const p0 = [0, neckTop + 2, -C * 0.18];
        const p2 = a.inner;
        const p1 = [p2[0] * 0.15, -B * 0.15, p2[2] * 0.2 - C * 0.08];
        const mt = 1 - t;
        const j = 0.9 * (0.4 + t);
        x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0] + (hash01(i, 18) - 0.5) * j;
        y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1] + (hash01(i, 19) - 0.5) * j;
        z = mt * mt * p0[2] + 2 * mt * t * p1[2] + t * t * p2[2] + (hash01(i, 20) - 0.5) * j;
        L.dustGroup[i] = g;
        break;
      }
      case ROLE.SPINE: {
        y = neckTop - hash01(i, 21) * (neckTop - bottom - 6);
        const vert = Math.cos(((y - neckTop) / 6.5) * TAU);
        const r = (y > neckBot ? 1.6 : 2.4) * (0.4 + 0.6 * hash01(i, 22)) * (vert > 0.55 ? 1.6 : 0.8);
        const a = TAU * hash01(i, 23);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r * 0.7 - (y < shoulder ? 4 : 1);
        break;
      }
      case ROLE.RIB: {
        const y0 = ribYs[Math.floor(hash01(i, 24) * ribYs.length)] || shoulder;
        const side = hash01(i, 25) < 0.5 ? -1 : 1;
        const s = Math.pow(hash01(i, 26), 0.8);
        y = y0 - 24 * Math.pow(s, 1.5) + (hash01(i, 27) - 0.5) * 0.8;
        const r = bodyR(y) * 0.93;
        const ang = s * Math.PI * 0.5;
        x = side * Math.sin(ang) * r + (hash01(i, 28) - 0.5) * 0.7;
        z = -Math.cos(ang) * r * DEPTH * 0.6 + (hash01(i, 29) - 0.5) * 0.7;
        break;
      }
      case ROLE.SKIN: {
        // Hauteur tirée en proportion de la largeur (surface).
        let tries = 0;
        do {
          y = neckBot + 4 - hash01(i, 30 + tries * 2) * (neckBot + 4 - bottom);
          tries++;
        } while (tries < 6 && hash01(i, 31 + tries * 2) * 100 > bodyR(y));
        const r = bodyR(y) * (0.94 + 0.08 * hash01(i, 45));
        const a = TAU * hash01(i, 46);
        const inner = hash01(i, 47) < 0.14 ? Math.sqrt(hash01(i, 48)) : 1;
        x = Math.cos(a) * r * inner;
        z = Math.sin(a) * r * DEPTH * inner;
        break;
      }
      case ROLE.NECK: {
        y = neckTop - hash01(i, 50) * (neckTop - shoulder - 4);
        const r = bodyR(y) * Math.sqrt(hash01(i, 51));
        const a = TAU * hash01(i, 52);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r * 0.8 - 1;
        break;
      }
      case ROLE.CEREBELLUM: {
        const u = 2 * hash01(i, 53) - 1;
        const a = TAU * hash01(i, 54);
        const s = Math.sqrt(1 - u * u);
        const stripe = 1 + 0.07 * Math.sin(u * 38);
        x = Math.cos(a) * s * 21 * stripe;
        y = -B * 0.5 + u * 8 * stripe;
        z = -C * 0.62 + Math.sin(a) * s * 11 * stripe;
        break;
      }
      case ROLE.STEM: {
        const t = hash01(i, 55);
        const a = TAU * hash01(i, 56);
        const r = 3.2 * Math.sqrt(hash01(i, 57));
        x = Math.cos(a) * r;
        y = -B * 0.35 + (neckTop - 4 + B * 0.35) * t;
        z = -C * 0.18 + Math.sin(a) * r;
        break;
      }
      default:
        hazeSphere(i, L.dustPos, o);
        L.dustRole[i] = ROLE.HAZE;
        continue;
    }
    L.dustPos[o] = x;
    L.dustPos[o + 1] = y;
    L.dustPos[o + 2] = z;
    L.dustRole[i] = role;
  }

  // Enveloppe en fil de fer : anneaux horizontaux et méridiens qui suivent la silhouette du corps.
  const seg = [];
  const RING = 64;
  for (let y = neckTop - 4; y > bottom + 6; y -= 8.5) {
    const r = bodyR(y);
    for (let k = 0; k < RING; k++) {
      const a0 = (k / RING) * TAU;
      const a1 = ((k + 1) / RING) * TAU;
      seg.push(Math.cos(a0) * r, y, Math.sin(a0) * r * DEPTH, Math.cos(a1) * r, y, Math.sin(a1) * r * DEPTH);
    }
  }
  const MER = 36;
  for (let k = 0; k < MER; k++) {
    const a = (k / MER) * TAU;
    for (let y = neckTop - 4; y > bottom + 6; y -= 5) {
      const y2 = Math.max(bottom + 6, y - 5);
      const r1 = bodyR(y);
      const r2 = bodyR(y2);
      seg.push(Math.cos(a) * r1, y, Math.sin(a) * r1 * DEPTH, Math.cos(a) * r2, y2, Math.sin(a) * r2 * DEPTH);
    }
  }
  L.shellLines = new Float32Array(seg);

  // Cadrage : le cerveau en haut, la moelle file vers le bas de l'écran (comme la vidéo).
  L.frame = { center: [0, -92, 0], width: 190, height: 258, depth: 70 };
  L.frameNear = { center: [0, 0, 0], width: 108, height: 86, depth: 90 };
  L.body = { top: B, bottom };
  L.camDir = [0, 0.06, 1];
  // Liens discrets : des dizaines de milliers de traits superposés dans un petit cerveau le blanchissent vite.
  // Les fibres lumineuses (une sélection de liens) font le travail des filaments.
  L.linkFactor = 0.25;
  L.sizeMul = 0.6;
  L.drift = 0.25;
  L.question = t('q.brain');
  L.answer = t('a.brain', { n: fmt(notes.length), g: fmt(groups.length) });
  return L;
}

// --------------------------------------------------------------- 2. Molécule
/** Point 3D tiré d'une loi normale (Box-Muller), borné pour éviter les points perdus au loin. */
function gauss3(seed, salt, cap = 2.4) {
  const u1 = Math.max(1e-6, hash01(seed, salt));
  const u2 = hash01(seed, salt + 1);
  const u3 = Math.max(1e-6, hash01(seed, salt + 2));
  const u4 = hash01(seed, salt + 3);
  const r1 = Math.sqrt(-2 * Math.log(u1));
  const r2 = Math.sqrt(-2 * Math.log(u3));
  const v = [r1 * Math.cos(TAU * u2), r1 * Math.sin(TAU * u2), r2 * Math.cos(TAU * u4)];
  const m = Math.hypot(v[0], v[1], v[2]);
  if (m > cap) for (let k = 0; k < 3; k++) v[k] *= cap / m;
  return v;
}

function layoutMolecule(model, D) {
  const L = base('molecule', model, D);
  const { notes, groups, groupLinks } = model;
  const G = groups.length;
  // Chaque dossier est un amas nébuleux : un nuage dense (écart-type SIG), son encombrement R.
  const SIG = groups.map((g) => 2.4 + 1.75 * Math.cbrt(g.notes.length));
  const R = SIG.map((s) => s * 2.3 + 2);

  // Position des atomes : petite simulation de forces (liens entre dossiers = ressorts).
  const P = new Float64Array(G * 3);
  const vol = R.reduce((s, r) => s + r * r * r, 0);
  const spread = Math.cbrt(vol) * 1.4 + 20;
  for (let i = 0; i < G; i++) {
    const y = G === 1 ? 0 : 1 - (2 * (i + 0.5)) / G;
    const rr = Math.sqrt(1 - y * y);
    const a = i * GA;
    const s = spread * (0.7 + 0.3 * hash01(i, 41));
    P[i * 3] = Math.cos(a) * rr * s;
    P[i * 3 + 1] = y * s * 0.8;
    P[i * 3 + 2] = Math.sin(a) * rr * s;
  }
  const links = [];
  let topPair = null;
  for (const [key, w] of groupLinks) {
    links.push([Math.floor(key / G), key % G, Math.log1p(w)]);
    if (!topPair || w > topPair[2]) topPair = [Math.floor(key / G), key % G, w];
  }
  const F = new Float64Array(G * 3);
  const ITER = 320;
  for (let it = 0; it < ITER; it++) {
    const alpha = 1 - it / ITER;
    F.fill(0);
    for (let i = 0; i < G; i++) {
      for (let j = i + 1; j < G; j++) {
        const dx = P[j * 3] - P[i * 3];
        const dy = P[j * 3 + 1] - P[i * 3 + 1];
        const dz = P[j * 3 + 2] - P[i * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 1;
        const d = Math.sqrt(d2);
        const rs = R[i] + R[j];
        if (d > rs * 2.6) continue; // répulsion à courte portée : les atomes isolés restent près du groupe
        const rep = (rs * rs * 3.5) / d2;
        F[i * 3] -= (dx / d) * rep;
        F[i * 3 + 1] -= (dy / d) * rep;
        F[i * 3 + 2] -= (dz / d) * rep;
        F[j * 3] += (dx / d) * rep;
        F[j * 3 + 1] += (dy / d) * rep;
        F[j * 3 + 2] += (dz / d) * rep;
      }
    }
    for (const [i, j, w] of links) {
      const dx = P[j * 3] - P[i * 3];
      const dy = P[j * 3 + 1] - P[i * 3 + 1];
      const dz = P[j * 3 + 2] - P[i * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const rest = (R[i] + R[j]) * 1.3 + 40;
      if (d <= rest) continue;
      const f = 0.004 * w * (d - rest);
      F[i * 3] += (dx / d) * f;
      F[i * 3 + 1] += (dy / d) * f;
      F[i * 3 + 2] += (dz / d) * f;
      F[j * 3] -= (dx / d) * f;
      F[j * 3 + 1] -= (dy / d) * f;
      F[j * 3 + 2] -= (dz / d) * f;
    }
    for (let i = 0; i < G; i++) {
      F[i * 3] -= P[i * 3] * 0.025;
      F[i * 3 + 1] -= P[i * 3 + 1] * 0.034;
      F[i * 3 + 2] -= P[i * 3 + 2] * 0.025;
      const fx = F[i * 3],
        fy = F[i * 3 + 1],
        fz = F[i * 3 + 2];
      const m = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (m < 1e-9) continue;
      const step = Math.min(m, 9) * (0.15 + alpha);
      P[i * 3] += (fx / m) * step;
      P[i * 3 + 1] += (fy / m) * step;
      P[i * 3 + 2] += (fz / m) * step;
    }
    // Pas de chevauchement entre atomes.
    for (let i = 0; i < G; i++) {
      for (let j = i + 1; j < G; j++) {
        const dx = P[j * 3] - P[i * 3];
        const dy = P[j * 3 + 1] - P[i * 3 + 1];
        const dz = P[j * 3 + 2] - P[i * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
        const minD = (R[i] + R[j]) * 1.35 + 18; // du noir entre les amas, comme des nébuleuses séparées
        if (d < minD) {
          const push = (minD - d) / 2 / d;
          P[i * 3] -= dx * push;
          P[i * 3 + 1] -= dy * push;
          P[i * 3 + 2] -= dz * push;
          P[j * 3] += dx * push;
          P[j * 3 + 1] += dy * push;
          P[j * 3 + 2] += dz * push;
        }
      }
    }
  }
  // Recentrage.
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < G; i++) {
    cx += P[i * 3];
    cy += P[i * 3 + 1];
    cz += P[i * 3 + 2];
  }
  cx /= G || 1;
  cy /= G || 1;
  cz /= G || 1;
  let ext = 1,
    extY = 1;
  for (let i = 0; i < G; i++) {
    P[i * 3] -= cx;
    P[i * 3 + 1] -= cy;
    P[i * 3 + 2] -= cz;
    ext = Math.max(ext, Math.hypot(P[i * 3], P[i * 3 + 2]) + R[i]);
    extY = Math.max(extY, Math.abs(P[i * 3 + 1]) + R[i]);
  }

  // Notes en nuage (loi normale) : les plus liées au cœur, les autres de plus en plus loin.
  // Chaque amas a sa propre forme (un peu aplati ou étiré) et sa propre orientation. Noms encadrés.
  const maxN = Math.max(1, ...groups.map((g) => g.notes.length));
  const named = new Set([...groups].sort((a, b) => b.notes.length - a.notes.length).slice(0, 20).map((g) => g.idx));
  const shape = groups.map((g, gi) => ({
    ax: [1, 0.68 + 0.5 * hash01(gi, 54), 0.78 + 0.42 * hash01(gi, 55)],
    rx: TAU * hash01(gi, 56),
    ry: TAU * hash01(gi, 57),
  }));
  groups.forEach((g, gi) => {
    const list = [...g.notes].sort((a, b) => notes[b].deg - notes[a].deg || a - b);
    const n = list.length;
    const sh = shape[gi];
    list.forEach((ni, k) => {
      const sc = SIG[gi] * (0.42 + 0.78 * Math.sqrt((k + 0.5) / n));
      const q = gauss3(notes[ni].seed, 51, 2.3);
      const v = rotXY(q[0] * sh.ax[0], q[1] * sh.ax[1], q[2] * sh.ax[2], sh.rx, sh.ry);
      L.pos[ni * 3] = P[gi * 3] + v[0] * sc;
      L.pos[ni * 3 + 1] = P[gi * 3 + 1] + v[1] * sc;
      L.pos[ni * 3 + 2] = P[gi * 3 + 2] + v[2] * sc;
    });
    if (named.has(gi))
      L.labels.push({
        text: g.short,
        sub: String(g.notes.length),
        x: P[gi * 3],
        y: P[gi * 3 + 1] + R[gi] + 3,
        z: P[gi * 3 + 2],
        align: 'above',
        weight: Math.sqrt(g.notes.length / maxN),
        kind: 'box',
        gi,
      });
  });

  // Poussière : un cœur brillant et une brume colorée autour de chaque amas, des étoiles entre les amas,
  // et un fond d'étoiles lointaines.
  const cdf = [];
  let acc = 0;
  for (const g of groups) cdf.push((acc += Math.sqrt(g.notes.length)));
  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 61);
    if (r < 0.76 && G) {
      const gi = pickCdf(cdf, hash01(i, 62));
      const sh = shape[gi];
      L.dustGroup[i] = gi;
      const core = r < 0.4;
      const q = gauss3(i, 63, core ? 2.2 : 2.4);
      const sc = SIG[gi] * (core ? 0.55 : 1.2);
      const v = rotXY(q[0] * sh.ax[0], q[1] * sh.ax[1], q[2] * sh.ax[2], sh.rx, sh.ry);
      L.dustPos[o] = P[gi * 3] + v[0] * sc;
      L.dustPos[o + 1] = P[gi * 3 + 1] + v[1] * sc;
      L.dustPos[o + 2] = P[gi * 3 + 2] + v[2] * sc;
      L.dustRole[i] = core ? ROLE.NUCLEUS : ROLE.ORBIT;
    } else if (r < 0.86 && G) {
      // Champ d'étoiles entre les amas.
      const b = ballPoint(i, 69, 1);
      L.dustPos[o] = b[0] * ext * 1.15;
      L.dustPos[o + 1] = b[1] * extY * 1.25;
      L.dustPos[o + 2] = b[2] * ext * 1.15;
      L.dustRole[i] = ROLE.HAZE;
    } else {
      hazeSphere(i, L.dustPos, o);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  L.frame = { center: [0, 0, 0], width: ext * 2, height: extY * 2 + 10, depth: ext * 1.4 };
  L.camDir = [0.12, 0.22, 1];
  L.linkFactor = 0.4;
  L.sizeMul = 1.05;
  L.drift = 0.3;
  L.question = t('q.molecule');
  L.answer = topPair
    ? t('a.molecule', { a: groups[topPair[0]].short, b: groups[topPair[1]].short, n: fmt(topPair[2]) })
    : t('a.moleculeNone');
  return L;
}

// ------------------------------------------------------------------ 3. Grille
// ------------------------------------------------------------- 8. Microscope
// Chaque dossier est une cellule (une sphère remplie de ses notes, avec sa membrane et son noyau),
// rangée en tournesol autour de la plus grosse, dans une boîte de Petri vue de biais qui tourne.
function layoutMicro(model, D) {
  const L = base('micro', model, D);
  const { notes, groups } = model;
  const G = groups.length;
  const rad = groups.map((g) => 3.4 + 2.3 * Math.cbrt(g.notes.length));
  const order = [...groups].sort((a, b) => b.notes.length - a.notes.length || a.idx - b.idx).map((g) => g.idx);
  // Placement en spirale d'or (les plus grosses au centre), puis on écarte les cellules qui se touchent.
  const P = new Float64Array(G * 2);
  let area = 0;
  order.forEach((gi, k) => {
    const r = k === 0 ? 0 : 1.12 * Math.sqrt(area);
    const a = k * GA;
    P[gi * 2] = Math.cos(a) * r;
    P[gi * 2 + 1] = Math.sin(a) * r;
    area += rad[gi] * rad[gi] * 1.35;
  });
  for (let it = 0; it < 220; it++) {
    for (let i = 0; i < G; i++) {
      for (let j = i + 1; j < G; j++) {
        const dx = P[j * 2] - P[i * 2];
        const dy = P[j * 2 + 1] - P[i * 2 + 1];
        const d = Math.hypot(dx, dy) + 1e-6;
        const minD = rad[i] + rad[j] + 2.6;
        if (d < minD) {
          const push = (minD - d) / 2 / d;
          P[i * 2] -= dx * push;
          P[i * 2 + 1] -= dy * push;
          P[j * 2] += dx * push;
          P[j * 2 + 1] += dy * push;
        }
      }
    }
    for (let i = 0; i < G; i++) {
      P[i * 2] *= 0.992; // légère gravité vers le centre : un disque bien rempli
      P[i * 2 + 1] *= 0.992;
    }
  }
  let ext = 1;
  for (let i = 0; i < G; i++) ext = Math.max(ext, Math.hypot(P[i * 2], P[i * 2 + 1]) + rad[i]);
  const dish = ext + 9;
  const cz = (gi) => (hash01(gi, 801) - 0.5) * rad[gi] * 0.5; // un peu de relief

  // Notes : réparties uniformément dans le volume de leur cellule (une bille pleine de points).
  groups.forEach((g, gi) => {
    for (const ni of g.notes) {
      const s = notes[ni].seed;
      const u = 2 * hash01(s, 811) - 1;
      const a = TAU * hash01(s, 812);
      const rr = rad[gi] * 0.9 * Math.cbrt(hash01(s, 813));
      const q = Math.sqrt(1 - u * u);
      L.pos[ni * 3] = P[gi * 2] + Math.cos(a) * q * rr;
      L.pos[ni * 3 + 1] = P[gi * 2 + 1] + u * rr;
      L.pos[ni * 3 + 2] = cz(gi) + Math.sin(a) * q * rr;
    }
  });

  // Poussière : membrane de chaque cellule, noyau au centre, bord de la boîte, et quelques débris flottants.
  const cdfA = [];
  let accA = 0;
  for (let gi = 0; gi < G; gi++) cdfA.push((accA += rad[gi] * rad[gi]));
  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 821);
    if (G && r < 0.78) {
      const gi = pickCdf(cdfA, hash01(i, 822));
      L.dustGroup[i] = gi;
      const nucleus = r < 0.16;
      const u = 2 * hash01(i, 823) - 1;
      const a = TAU * hash01(i, 824);
      const q = Math.sqrt(1 - u * u);
      const rr = nucleus ? rad[gi] * 0.24 * Math.cbrt(hash01(i, 825)) : rad[gi] * (0.97 + 0.06 * hash01(i, 825));
      L.dustPos[o] = P[gi * 2] + Math.cos(a) * q * rr;
      L.dustPos[o + 1] = P[gi * 2 + 1] + u * rr;
      L.dustPos[o + 2] = cz(gi) + Math.sin(a) * q * rr;
      L.dustRole[i] = nucleus ? ROLE.NUCLEUS : ROLE.RINGFILL; // membrane bien visible
    } else if (r < 0.88) {
      // Bord de la boîte de Petri : un anneau fin.
      const a = TAU * hash01(i, 826);
      const rr = dish + (hash01(i, 827) - 0.5) * 1.6;
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = (hash01(i, 828) - 0.5) * 2;
      L.dustRole[i] = ROLE.RIM;
    } else if (r < 0.95) {
      // Débris en suspension dans la boîte.
      const a = TAU * hash01(i, 829);
      const rr = dish * Math.sqrt(hash01(i, 830));
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = (hash01(i, 831) - 0.5) * 10;
      L.dustRole[i] = ROLE.HAZE;
    } else {
      hazeSphere(i, L.dustPos, o);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  // Noms encadrés au-dessus des plus grosses cellules.
  const maxN = Math.max(1, ...groups.map((g) => g.notes.length));
  for (const gi of order.slice(0, 16)) {
    const g = groups[gi];
    L.labels.push({
      text: g.short,
      sub: String(g.notes.length),
      x: P[gi * 2],
      y: P[gi * 2 + 1] + rad[gi] + 1.5,
      z: cz(gi),
      align: 'above',
      weight: Math.sqrt(g.notes.length / maxN),
      kind: 'box',
      gi,
    });
  }

  // Vue de biais : la boîte paraît moins haute que large, on cadre plus serré.
  L.frame = { center: [0, 0, 0], width: dish * 2 + 6, height: dish * 1.55, depth: 20 };
  L.camDir = [0, -0.55, 1]; // vue de biais, comme une boîte posée sous l'objectif
  L.linkFactor = 0;
  L.sizeMul = 0.95;
  L.drift = 0.22;
  L.question = t('q.micro');
  const big = order.length ? groups[order[0]] : null;
  L.answer = big ? t('a.micro', { name: big.short, n: fmt(big.notes.length) }) : '';
  return L;
}

function layoutGrid(model, D, aspect) {
  const L = base('grid', model, D);
  const { groups } = model;
  const C = 24;
  const s = 2.6;
  const GAPR = 0.85; // espace entre blocs, en rangées
  const LABEL_W = 42;
  const COL_GAP = 16;
  const blocks = groups.map((g) => ({ g, rows: Math.max(1, Math.ceil(g.notes.length / C)) }));
  const totalRows = blocks.reduce((t, b) => t + b.rows + GAPR, 0);
  const blockW = LABEL_W + C * s;

  // Nombre de colonnes de blocs qui colle le mieux au format de l'écran.
  const split = (K) => {
    const target = totalRows / K;
    const cols = [[]];
    let h = 0;
    for (const b of blocks) {
      if (h > 0 && h + (b.rows + GAPR) / 2 > target && cols.length < K) {
        cols.push([]);
        h = 0;
      }
      cols[cols.length - 1].push(b);
      h += b.rows + GAPR;
    }
    return cols;
  };
  let best = null;
  for (let K = 1; K <= 6; K++) {
    const cols = split(K);
    const H = Math.max(...cols.map((c) => c.reduce((t, b) => t + b.rows + GAPR, 0))) * s;
    const W = cols.length * blockW + (cols.length - 1) * COL_GAP;
    const score = Math.abs(Math.log(W / Math.max(H, 1) / (aspect * 0.92)));
    if (!best || score < best.score) best = { cols, W, H, score };
  }
  const { cols, W, H } = best;
  const x0 = -W / 2;
  const y0 = H / 2;
  cols.forEach((col, ci) => {
    const bx = x0 + ci * (blockW + COL_GAP) + LABEL_W;
    let cursor = 0;
    for (const b of col) {
      b.g.notes.forEach((ni, k) => {
        L.pos[ni * 3] = bx + (k % C) * s;
        L.pos[ni * 3 + 1] = y0 - (cursor + Math.floor(k / C)) * s;
        L.pos[ni * 3 + 2] = 0;
      });
      L.labels.push({
        text: b.g.short,
        sub: String(b.g.notes.length),
        x: bx - 3.2,
        y: y0 - cursor * s,
        z: 0,
        align: 'right',
        weight: 1,
        kind: 'group',
        gi: b.g.idx,
      });
      cursor += b.rows + GAPR;
    }
  });

  for (let i = 0; i < D; i++) {
    const o = i * 3;
    if (hash01(i, 71) < 0.5) {
      const cx = Math.floor(hash01(i, 72) * (W / (s * 2)));
      const cy = Math.floor(hash01(i, 73) * ((H + 30) / (s * 2)));
      L.dustPos[o] = x0 + cx * s * 2;
      L.dustPos[o + 1] = y0 + 15 - cy * s * 2;
      L.dustPos[o + 2] = -10;
      L.dustRole[i] = ROLE.LATTICE;
    } else {
      hazeFlat(i, L.dustPos, o, W, H);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  const big = [...groups].sort((a, b) => b.notes.length - a.notes.length)[0];
  L.frame = { center: [0, 0, 0], width: W + 20, height: H + 14, depth: 0 };
  L.camDir = [0, 0, 1];
  L.linkFactor = 0;
  L.sizeMul = 0.62;
  L.drift = 0.08;
  L.question = t('q.grid');
  L.answer = big ? t('a.grid', { name: big.full, n: fmt(big.notes.length) }) : '';
  return L;
}

// ------------------------------------------------------- 4. Courbe (vagues)
// Une colonne de points par jour, fondue dans une vague lisse et remplie de poussière.
// Hauteur en échelle logarithmique : le pic ressort mais les petits jours restent visibles.
function layoutCurve(model, D, aspect) {
  const L = base('curve', model, D);
  const { notes, groups } = model;
  const day = notes.map((n) => dayNumber(n.mtime));
  const { minDay, Dn, clipped } = daySpan(day);
  const perDay = Array.from({ length: Dn }, () => []);
  notes.forEach((n, i) => perDay[Math.max(0, day[i] - minDay)].push(i));
  let maxCount = 1;
  let peakDay = 0;
  perDay.forEach((list, d) => {
    list.sort((a, b) => notes[a].gi - notes[b].gi || notes[a].mtime - notes[b].mtime);
    if (list.length > maxCount) {
      maxCount = list.length;
      peakDay = d;
    }
  });
  const H = 150;
  const W = clamp(H * aspect * 0.95, 170, 820);
  const dayW = W / Dn;
  const x0 = -W / 2;
  const yb = -H / 2;
  const hs = H / Math.log1p(maxCount);
  const val = (k) => (k < 0 || k >= Dn ? 0 : Math.log1p(perDay[k].length));
  const centerX = (d) => x0 + (d + 0.5) * dayW;
  const hAt = (x) => {
    const fd = (x - x0) / dayW - 0.5;
    const i = Math.floor(fd);
    return smoothAt(val(i - 1), val(i), val(i + 1), val(i + 2), fd - i) * hs;
  };

  perDay.forEach((list, d) => {
    const n = list.length;
    list.forEach((ni, k) => {
      const seed = notes[ni].seed;
      const x = centerX(d) + (hash01(seed, 81) - 0.5) * dayW * 0.94;
      const h = Math.max(hAt(x), hs * 0.5, 0.8);
      L.pos[ni * 3] = x;
      L.pos[ni * 3 + 1] = yb + ((k + 0.25 + 0.5 * hash01(seed, 83)) / n) * h;
      L.pos[ni * 3 + 2] = (hash01(seed, 82) - 0.5) * 1.2;
    });
  });

  // Dates inclinées sous l'axe, pic, liste des dossiers à droite (comme dans la vidéo).
  const step = Math.max(1, Math.ceil(Dn / 40));
  for (let d = 0; d < Dn; d += step) {
    L.labels.push({
      text: (clipped && d === 0 ? '≤ ' : '') + fmtDayShort(minDay + d),
      x: centerX(d),
      y: yb - 3,
      z: 0,
      align: 'tilt',
      weight: 1,
      kind: 'tick',
    });
  }
  L.labels.push({
    text: t('peak', { n: fmt(maxCount) }),
    sub: fmtDayLong(minDay + peakDay),
    x: centerX(peakDay),
    y: yb + H + 4,
    z: 0,
    align: 'above',
    weight: 1,
    kind: 'peak',
  });
  const legend = [...groups].sort((a, b) => b.notes.length - a.notes.length).slice(0, 26);
  const lx = W / 2 + 7;
  legend.forEach((g, k) => {
    L.labels.push({
      text: g.short,
      sub: fmt(g.notes.length),
      x: lx,
      y: H / 2 - k * (H / 25.5),
      z: 0,
      align: 'left',
      weight: 1,
      kind: 'legend',
      gi: g.idx,
    });
  });

  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 84);
    if (r < 0.2) {
      // Contour lumineux de la vague.
      const x = x0 + hash01(i, 85) * W;
      L.dustPos[o] = x;
      L.dustPos[o + 1] = yb + hAt(x) + (hash01(i, 86) - 0.5) * 0.6;
      L.dustPos[o + 2] = (hash01(i, 87) - 0.5) * 0.6;
      L.dustRole[i] = ROLE.CURVE;
    } else if (r < 0.72) {
      // Remplissage sous la vague (plus de grains là où elle est haute).
      let x = 0;
      let h = 0;
      for (let k = 0; k < 6; k++) {
        x = x0 + hash01(i, 140 + 2 * k) * W;
        h = hAt(x);
        if (hash01(i, 141 + 2 * k) * H <= h + 6) break;
      }
      L.dustPos[o] = x;
      L.dustPos[o + 1] = yb + Math.pow(hash01(i, 160), 0.85) * Math.max(h, 1);
      L.dustPos[o + 2] = (hash01(i, 161) - 0.5) * 2;
      L.dustRole[i] = ROLE.FILL;
    } else if (r < 0.82) {
      L.dustPos[o] = x0 - 4 + hash01(i, 88) * (W + 8);
      L.dustPos[o + 1] = yb - 1.2 + (hash01(i, 89) - 0.5) * 0.4;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.AXIS;
    } else {
      hazeFlat(i, L.dustPos, o, W, H);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  L.fill = { x0, w: W };
  L.frame = { center: [32, 2, 0], width: W + 96, height: H + 44, depth: 0 };
  L.camDir = [0, 0, 1];
  L.linkFactor = 0;
  L.sizeMul = 0.55;
  L.drift = 0.06;
  L.question = t('q.curve');
  L.answer = t('a.curve', { date: fmtDayLong(minDay + peakDay), n: fmt(maxCount) });
  return L;
}

// ------------------------------------------------------- 5. Roue (parts)
// Style « Parts » : une part par dossier, remplie de notes, noms autour ; la roue tourne.
function layoutSlices(model, D) {
  const L = base('wheel', model, D);
  const { notes, groups } = model;
  const R = 120;
  const r0 = 26;
  const N = Math.max(1, notes.length);
  const amin = TAU * 0.0088;
  const raw = groups.map((g) => Math.max((g.notes.length / N) * TAU, amin));
  const k = TAU / (raw.reduce((s2, v) => s2 + v, 0) || 1);
  let a0 = -Math.PI / 2;
  const bounds = [];
  const slices = [];
  groups.forEach((g, gi) => {
    const ang = raw[gi] * k;
    const pad = Math.min(ang * 0.12, 0.012);
    const n = g.notes.length;
    const off = hash01(gi, 91);
    g.notes.forEach((ni, j) => {
      const fr = (j + 0.5) / n;
      const rr = Math.sqrt(r0 * r0 + (R * R - r0 * r0) * fr);
      const af = (j * GOLDEN + off) % 1;
      const a = a0 + pad + af * (ang - 2 * pad);
      L.pos[ni * 3] = Math.cos(a) * rr;
      L.pos[ni * 3 + 1] = Math.sin(a) * rr;
      L.pos[ni * 3 + 2] = (hash01(notes[ni].seed, 92) - 0.5) * 3;
    });
    const mid = a0 + ang / 2;
    L.labels.push({
      text: g.short,
      sub: String(n),
      x: Math.cos(mid) * (R + 7),
      y: Math.sin(mid) * (R + 7),
      z: 0,
      align: 'radial',
      weight: 1,
      kind: 'group',
      gi,
    });
    bounds.push(a0);
    slices.push([gi, a0 + pad, ang - 2 * pad]);
    a0 += ang;
  });
  const scdf = [];
  let acc = 0;
  for (const [, , ang] of slices) scdf.push((acc += Math.max(ang, 0.001)));

  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 93);
    if (r < 0.2 && bounds.length > 1) {
      const b = bounds[Math.floor(hash01(i, 94) * bounds.length)];
      const rr = r0 - 2 + hash01(i, 95) * (R - r0 + 5);
      L.dustPos[o] = Math.cos(b) * rr;
      L.dustPos[o + 1] = Math.sin(b) * rr;
      L.dustPos[o + 2] = (hash01(i, 96) - 0.5) * 0.8;
      L.dustRole[i] = ROLE.SPOKE;
    } else if (r < 0.4) {
      const inner = hash01(i, 97) < 0.22;
      const rr = (inner ? r0 - 3 : R + 3.5) + (hash01(i, 98) - 0.5) * 1.2;
      const a = TAU * hash01(i, 99);
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = (hash01(i, 100) - 0.5) * 0.8;
      L.dustRole[i] = ROLE.RIM;
    } else if (r < 0.8 && slices.length) {
      // Chaque part est remplie d'une poussière à sa couleur.
      const [gi, sa, ang] = slices[pickCdf(scdf, hash01(i, 101))];
      const rr = Math.sqrt(r0 * r0 + (R * R - r0 * r0) * hash01(i, 102));
      const a = sa + hash01(i, 103) * ang;
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = (hash01(i, 104) - 0.5) * 3;
      L.dustRole[i] = ROLE.RINGFILL;
      L.dustGroup[i] = gi;
    } else {
      hazeFlat(i, L.dustPos, o, 2 * R, 2 * R);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  const big = [...groups].sort((a, b) => b.notes.length - a.notes.length)[0];
  L.frame = { center: [0, 0, 0], width: 2 * R + 230, height: 2 * R + 190, depth: 0 };
  L.camDir = [0, 0, 1];
  L.rot = 'spinZ';
  L.linkFactor = 0;
  L.sizeMul = 0.95;
  L.drift = 0.12;
  L.question = t('q.slices');
  L.answer = big ? t('a.slices', { name: big.full, p: Math.round((100 * big.notes.length) / N) }) : '';
  return L;
}

// ------------------------------------------------------- 5 bis. Roue (horloge)
// Style « Horloge » : un anneau par dossier, l'heure de modification fait le tour du cadran
// (00:00 en haut). Les anneaux sont remplis de poussière à la couleur du dossier.
function layoutClock(model, D) {
  const L = base('wheel', model, D);
  const { notes, groups } = model;
  const TOP = 23;
  const bySize = [...groups].sort((a, b) => b.notes.length - a.notes.length);
  const shown = bySize.slice(0, TOP).sort((a, b) => a.idx - b.idx);
  const others = bySize.slice(TOP);
  const rings = shown.map((g) => ({ name: g.short, n: g.notes.length, gi: g.idx }));
  if (others.length) rings.push({ name: t('othersFolders', { n: others.length }), n: others.reduce((s2, g) => s2 + g.notes.length, 0), gi: -1 });
  const ringOf = new Map(shown.map((g, k) => [g.idx, k]));
  const nR = Math.max(1, rings.length);
  const R = 140;
  const r0 = 42;
  const band = (R - r0) / nR;
  const angleOf = (minutes) => Math.PI / 2 - (minutes / 1440) * TAU;

  const perHour = new Array(24).fill(0);
  notes.forEach((n, ni) => {
    const d = new Date(n.mtime);
    const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    perHour[d.getHours()]++;
    const k = ringOf.has(n.gi) ? ringOf.get(n.gi) : nR - 1;
    const rOuter = R - k * band;
    const a = angleOf(minutes) + (hash01(n.seed, 91) - 0.5) * 0.09;
    const r = rOuter - band * (0.12 + 0.76 * hash01(n.seed, 92));
    L.pos[ni * 3] = Math.cos(a) * r;
    L.pos[ni * 3 + 1] = Math.sin(a) * r;
    L.pos[ni * 3 + 2] = (hash01(n.seed, 93) - 0.5) * 2;
  });

  for (let h = 0; h < 24; h++) {
    const a = angleOf(h * 60);
    L.labels.push({
      text: `${String(h).padStart(2, '0')}:00`,
      x: Math.cos(a) * (R + 11),
      y: Math.sin(a) * (R + 11),
      z: 0,
      align: 'center',
      weight: 1,
      kind: 'tick',
    });
  }
  rings.forEach((rg, k) => {
    L.labels.push({
      text: rg.name,
      sub: fmt(rg.n),
      x: 2.5,
      y: R - k * band - band / 2,
      z: 0,
      align: 'left',
      weight: 1,
      kind: 'ring',
      gi: rg.gi >= 0 ? rg.gi : undefined,
    });
  });

  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 94);
    if (r < 0.1) {
      // Cercles entre les anneaux.
      const k = Math.floor(hash01(i, 95) * (nR + 1));
      const rr = R - k * band;
      const a = TAU * hash01(i, 96);
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.RIM;
    } else if (r < 0.18) {
      // Rayons des heures.
      const h = Math.floor(hash01(i, 97) * 24);
      const a = angleOf(h * 60);
      const rr = r0 + hash01(i, 98) * (R - r0 + 4);
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.SPOKE;
    } else if (r < 0.22) {
      // Graduations extérieures.
      const a = TAU * hash01(i, 99);
      const rr = R + 3 + hash01(i, 100) * 1.2;
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.AXIS;
    } else if (r < 0.93) {
      // Anneaux remplis : une piste colorée par dossier, sur tout le tour.
      const k = Math.floor(hash01(i, 105) * nR);
      const rr = R - k * band - band * (0.32 + 0.36 * hash01(i, 106));
      const a = TAU * hash01(i, 107);
      L.dustPos[o] = Math.cos(a) * rr;
      L.dustPos[o + 1] = Math.sin(a) * rr;
      L.dustPos[o + 2] = (hash01(i, 108) - 0.5) * 1.5;
      L.dustRole[i] = ROLE.RINGFILL;
      L.dustGroup[i] = rings[k].gi;
    } else {
      hazeFlat(i, L.dustPos, o, 2 * R, 2 * R);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  let bestH = 0;
  for (let h = 1; h < 24; h++) if (perHour[h] > perHour[bestH]) bestH = h;
  L.frame = { center: [0, 0, 0], width: 2 * R + 60, height: 2 * R + 46, depth: 0 };
  L.camDir = [0, 0, 1];
  L.rot = 'sway';
  L.linkFactor = 0;
  L.sizeMul = 0.72;
  L.drift = 0.08;
  L.question = t('q.wheel');
  L.answer = t('a.wheel', { h: bestH, n: fmt(perHour[bestH]) });
  return L;
}

// -------------------------------------------------------------------- 6. Flux
// Chaque note coule de son dossier (à gauche) vers le dossier qu'elle cite le plus (à droite).
function layoutFlow(model, D, aspect) {
  const L = base('flow', model, D);
  const { notes, groups, pairs } = model;
  const N = notes.length;
  const TOP = 11;
  const bySize = [...groups].sort((a, b) => b.notes.length - a.notes.length);
  const bucketOf = new Map();
  bySize.forEach((g, k) => bucketOf.set(g.idx, Math.min(k, TOP)));
  const buckets = bySize.slice(0, TOP).map((g) => ({ name: g.short, gi: g.idx }));
  if (bySize.length > TOP) buckets.push({ name: t('others', { n: bySize.length - TOP }), gi: -1 });
  const B = buckets.length || 1;

  // Destination de chaque note : le groupe qu'elle cite le plus (sinon le sien).
  const votes = Array.from({ length: N }, () => new Map());
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k];
    const b = pairs[k + 1];
    const ba = bucketOf.get(notes[a].gi);
    const bb = bucketOf.get(notes[b].gi);
    votes[a].set(bb, (votes[a].get(bb) || 0) + 1);
    votes[b].set(ba, (votes[b].get(ba) || 0) + 1);
  }
  const src = new Int32Array(N);
  const dst = new Int32Array(N);
  notes.forEach((n, i) => {
    src[i] = bucketOf.get(n.gi);
    let best = src[i];
    let bestV = 0;
    for (const [bk, v] of votes[i]) {
      if (v > bestV || (v === bestV && bk === src[i])) {
        best = bk;
        bestV = v;
      }
    }
    dst[i] = best;
  });

  const flows = Array.from({ length: B }, () => new Array(B).fill(0));
  for (let i = 0; i < N; i++) flows[src[i]][dst[i]]++;
  const outC = flows.map((row) => row.reduce((s, v) => s + v, 0));
  const inC = buckets.map((_, h) => flows.reduce((s, row) => s + row[h], 0));
  const H = 210;
  const GAPU = 5;
  const unit = (H - GAPU * (B - 1)) / Math.max(1, N);
  const W = clamp(H * aspect * 0.78, 200, 560);
  const xL = -W / 2;
  const xR = W / 2;
  const topL = [];
  const topR = [];
  let yl = H / 2;
  let yr = H / 2;
  for (let b = 0; b < B; b++) {
    topL.push(yl);
    topR.push(yr);
    yl -= outC[b] * unit + GAPU;
    yr -= inC[b] * unit + GAPU;
  }
  // Début de chaque ruban dans la barre de gauche (trié par destination) et de droite (trié par source).
  const startL = Array.from({ length: B }, () => new Array(B).fill(0));
  const startR = Array.from({ length: B }, () => new Array(B).fill(0));
  for (let b = 0; b < B; b++) {
    let acc = 0;
    for (let h = 0; h < B; h++) {
      startL[b][h] = acc;
      acc += flows[b][h] * unit;
    }
  }
  for (let h = 0; h < B; h++) {
    let acc = 0;
    for (let b = 0; b < B; b++) {
      startR[b][h] = acc;
      acc += flows[b][h] * unit;
    }
  }
  const rank = Array.from({ length: B }, () => new Array(B).fill(0));
  const flow = new Float32Array(N * 4); // y0, y1, z, t0
  const yAt = (y0, y1, t) => y0 + (y1 - y0) * t * t * (3 - 2 * t);
  for (let i = 0; i < N; i++) {
    const b = src[i];
    const h = dst[i];
    const th = flows[b][h] * unit;
    const off = ((rank[b][h]++ + 0.5) / flows[b][h]) * th;
    const y0 = topL[b] - startL[b][h] - off;
    const y1 = topR[h] - startR[b][h] - off;
    const t0 = hash01(notes[i].seed, 111);
    flow[i * 4] = y0;
    flow[i * 4 + 1] = y1;
    flow[i * 4 + 2] = (hash01(notes[i].seed, 112) - 0.5) * 2;
    flow[i * 4 + 3] = t0;
    L.pos[i * 3] = xL + (xR - xL) * t0;
    L.pos[i * 3 + 1] = yAt(y0, y1, t0);
    L.pos[i * 3 + 2] = flow[i * 4 + 2];
  }
  L.flow = { xL, xR, data: flow };

  // Rubans texturés et barres en poussière.
  const ribbons = [];
  const rcdf = [];
  let acc = 0;
  for (let b = 0; b < B; b++)
    for (let h = 0; h < B; h++)
      if (flows[b][h]) {
        ribbons.push([b, h]);
        rcdf.push((acc += flows[b][h]));
      }
  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 113);
    if (r < 0.8 && ribbons.length) {
      const [b, h] = ribbons[pickCdf(rcdf, hash01(i, 114))];
      const th = flows[b][h] * unit;
      const off = hash01(i, 115) * th;
      const t = hash01(i, 116);
      L.dustPos[o] = xL + (xR - xL) * t;
      L.dustPos[o + 1] = yAt(topL[b] - startL[b][h] - off, topR[h] - startR[b][h] - off, t);
      L.dustPos[o + 2] = (hash01(i, 117) - 0.5) * 0.8;
      L.dustRole[i] = ROLE.RIBBON;
      L.dustGroup[i] = buckets[b].gi;
    } else if (r < 0.9) {
      const left = hash01(i, 118) < 0.5;
      const b = Math.floor(hash01(i, 119) * B);
      const len = (left ? outC[b] : inC[b]) * unit;
      L.dustPos[o] = (left ? xL - 2.5 : xR + 0.5) + hash01(i, 120) * 2;
      L.dustPos[o + 1] = (left ? topL[b] : topR[b]) - hash01(i, 121) * len;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.BAR;
      L.dustGroup[i] = buckets[b].gi;
    } else {
      hazeFlat(i, L.dustPos, o, W, H);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  for (let b = 0; b < B; b++) {
    if (outC[b] * unit >= 3)
      L.labels.push({
        text: buckets[b].name,
        sub: fmt(outC[b]),
        x: xL - 5,
        y: topL[b] - (outC[b] * unit) / 2,
        z: 0,
        align: 'right',
        weight: 1,
        kind: 'group',
        gi: buckets[b].gi >= 0 ? buckets[b].gi : undefined,
      });
    if (inC[b] * unit >= 3)
      L.labels.push({
        text: buckets[b].name,
        sub: fmt(inC[b]),
        x: xR + 5,
        y: topR[b] - (inC[b] * unit) / 2,
        z: 0,
        align: 'left',
        weight: 1,
        kind: 'group',
        gi: buckets[b].gi >= 0 ? buckets[b].gi : undefined,
      });
  }

  let big = null;
  for (let b = 0; b < B; b++) for (let h = 0; h < B; h++) if (b !== h && (!big || flows[b][h] > big[2])) big = [b, h, flows[b][h]];
  L.frame = { center: [0, 0, 0], width: W + 190, height: H + 16, depth: 0 };
  L.camDir = [0, 0, 1];
  L.linkFactor = 0;
  L.sizeMul = 0.68;
  L.drift = 0.05;
  L.question = t('q.flow');
  L.answer =
    big && big[2]
      ? t('a.flow', { a: buckets[big[0]].name, b: buckets[big[1]].name, n: fmt(big[2]) })
      : t('a.flowNone');
  return L;
}

/** Position d'une note qui coule dans le flux, au temps `t` (secondes). */
export function flowPositions(L, time, out, speed) {
  const { xL, xR, data } = L.flow;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    let t = (data[i * 4 + 3] + time * speed) % 1;
    if (t < 0) t += 1;
    const y0 = data[i * 4];
    const y1 = data[i * 4 + 1];
    out[i * 3] = xL + (xR - xL) * t;
    out[i * 3 + 1] = y0 + (y1 - y0) * t * t * (3 - 2 * t);
    out[i * 3 + 2] = data[i * 4 + 2];
  }
}

// ----------------------------------------------------------- 7. Lignes de vie
// Une ligne par dossier. Chaque note vit de sa première date connue (création ou
// modification) à la dernière : ses points s'étalent le long de cette vie, les arcs
// relient les jours où le dossier a bougé.
function layoutLife(model, D, aspect) {
  const L = base('life', model, D);
  const { notes, groups } = model;
  const dm = notes.map((n) => dayNumber(n.mtime));
  const dc = notes.map((n, i) => (n.ctime ? dayNumber(n.ctime) : dm[i]));
  const d0 = notes.map((_, i) => Math.min(dm[i], dc[i]));
  const d1 = notes.map((_, i) => Math.max(dm[i], dc[i]));
  const { minDay, maxDay, Dn, clipped } = daySpan(d0.concat(d1));
  const G = Math.max(1, groups.length);
  const rowH = 3.2;
  const H = G * rowH;
  const W = clamp(H * aspect * 0.8, 170, 760);
  const dayW = W / Dn;
  const x0 = -W / 2;
  const rowY = (g) => H / 2 - (g + 0.5) * rowH;
  const xOf = (d) => x0 + (d - minDay + 0.5) * dayW;

  const daysOf = groups.map(() => new Set());
  notes.forEach((n, i) => {
    const a = Math.max(minDay, d0[i]);
    const b = Math.max(minDay, d1[i]);
    daysOf[n.gi].add(a);
    daysOf[n.gi].add(b);
    const xa = xOf(a);
    const xb = xOf(b);
    L.pos[i * 3] = xa + (xb - xa) * hash01(n.seed, 131) + (hash01(n.seed, 134) - 0.5) * dayW * 0.6;
    L.pos[i * 3 + 1] = rowY(n.gi) + (hash01(n.seed, 132) - 0.5) * rowH * 0.4;
    L.pos[i * 3 + 2] = (hash01(n.seed, 133) - 0.5) * 1;
  });

  const arcs = [];
  const rows = [];
  let recent = 0;
  groups.forEach((g, gi) => {
    const ds = [...daysOf[gi]].sort((a, b) => a - b);
    if (!ds.length) return;
    if (maxDay - ds[ds.length - 1] <= 7) recent++;
    rows.push([gi, ds[0], ds[ds.length - 1]]);
    for (let k = 1; k < ds.length; k++) arcs.push([gi, ds[k - 1], ds[k]]);
    const gap = ds.length > 1 ? ds[ds.length - 1] - ds[ds.length - 2] : 0;
    L.labels.push({
      text: g.short,
      sub: gap >= 2 ? t('backAfter', { n: gap }) : ds.length > 1 ? t('activeDays', { n: ds.length }) : t('oneDay'),
      x: x0 - 4,
      y: rowY(gi),
      z: 0,
      align: 'right',
      weight: 1,
      kind: 'life',
      gi,
    });
  });
  const step = Math.max(1, Math.ceil(Dn / 40));
  for (let d = 0; d < Dn; d += step) {
    L.labels.push({
      text: (clipped && d === 0 ? '≤ ' : '') + fmtDayShort(minDay + d),
      x: xOf(minDay + d),
      y: -H / 2 - 3,
      z: 0,
      align: 'tilt',
      weight: 1,
      kind: 'tick',
    });
  }

  const acdf = [];
  let acc = 0;
  for (const [, a, b] of arcs) acdf.push((acc += 1 + (b - a)));
  const rcdf = [];
  let racc = 0;
  for (const [, a, b] of rows) rcdf.push((racc += 1 + (b - a)));
  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 134);
    if (r < 0.36 && arcs.length) {
      const [gi, a, b] = arcs[pickCdf(acdf, hash01(i, 135))];
      const s2 = hash01(i, 136);
      const xa = xOf(a);
      const xb = xOf(b);
      const h = Math.min(rowH * 2.6, 0.9 + (xb - xa) * 0.16);
      L.dustPos[o] = xa + (xb - xa) * s2;
      L.dustPos[o + 1] = rowY(gi) + Math.sin(Math.PI * s2) * h;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.ARC;
      L.dustGroup[i] = gi;
    } else if (r < 0.8 && rows.length) {
      // Traînée de vie : la ligne du dossier, épaisse et colorée, du premier au dernier jour.
      const [gi, a, b] = rows[pickCdf(rcdf, hash01(i, 137))];
      L.dustPos[o] = xOf(a) - dayW * 0.3 + hash01(i, 138) * (xOf(b) - xOf(a) + dayW * 0.6);
      L.dustPos[o + 1] = rowY(gi) + (hash01(i, 140) - 0.5) * rowH * 0.5;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.ROWLINE;
      L.dustGroup[i] = gi;
    } else if (r < 0.85) {
      L.dustPos[o] = x0 + hash01(i, 139) * W;
      L.dustPos[o + 1] = -H / 2 - 1;
      L.dustPos[o + 2] = 0;
      L.dustRole[i] = ROLE.AXIS;
    } else {
      hazeFlat(i, L.dustPos, o, W, H);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  L.frame = { center: [-40, -4, 0], width: W + 110, height: H + 22, depth: 0 };
  L.camDir = [0, 0, 1];
  L.linkFactor = 0;
  L.sizeMul = 0.62;
  L.drift = 0.04;
  L.question = t('q.life');
  L.answer = t('a.life', { k: fmt(recent), g: fmt(groups.length) });
  return L;
}

