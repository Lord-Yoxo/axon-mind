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
};
/** Rôles qui forment le corps (la « silhouette », masquée quand le curseur Anatomie est au minimum). */
export const BODY_ROLES = new Set([ROLE.SPINE, ROLE.RIB, ROLE.SKIN, ROLE.NECK]);

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
  const neckBot = -60;
  const shoulder = -84;
  const bottom = -262;
  const bodyR = (y) => {
    if (y >= neckBot) return 9.5 + 3 * smoothstep(neckBot + 20, neckTop, y);
    if (y >= shoulder) {
      const t = (neckBot - y) / (neckBot - shoulder);
      return 9.5 + 56.5 * t * t;
    }
    const t = clamp((shoulder - y) / (shoulder - bottom), 0, 1);
    return Math.max(3, 66 + 30 * Math.sin(t * Math.PI * 0.75) - 90 * t ** 4);
  };
  const DEPTH = 0.42;
  const G = groups.length;
  const ribYs = [];
  for (let y = shoulder - 6; y > bottom + 28; y -= 13) ribYs.push(y);

  // Répartition de la poussière (rôle choisi au hasard pour que tout préfixe reste représentatif).
  const N = notes.length;
  const shares = [
    [ROLE.FILAMENT, 0.08],
    [ROLE.RECORD, N ? 0.38 : 0],
    [ROLE.SPINE, 0.03],
    [ROLE.RIB, 0.11],
    [ROLE.SKIN, 0.19],
    [ROLE.NECK, 0.04],
    [ROLE.CEREBELLUM, 0.07],
    [ROLE.STEM, 0.03],
    [ROLE.HAZE, 0.07],
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

  // Cadrage : le cerveau en haut, la moelle file vers le bas de l'écran (comme la vidéo).
  L.frame = { center: [0, -92, 0], width: 190, height: 258, depth: 70 };
  L.frameNear = { center: [0, 0, 0], width: 108, height: 86, depth: 90 };
  L.body = { top: B, bottom };
  L.camDir = [0, 0.06, 1];
  L.linkFactor = 0.22;
  L.sizeMul = 0.6;
  L.drift = 0.25;
  L.question = t('q.brain');
  L.answer = t('a.brain', { n: fmt(notes.length), g: fmt(groups.length) });
  return L;
}

// --------------------------------------------------------------- 2. Molécule
function shellsFor(n) {
  let K = 0;
  let cap = 0;
  while (cap < n) {
    K++;
    cap += 3 * K * K;
  }
  return Math.max(1, K);
}
const SHELL0 = 4.5;
const SHELL_DR = 3.6;

function layoutMolecule(model, D) {
  const L = base('molecule', model, D);
  const { notes, groups, groupLinks } = model;
  const G = groups.length;
  const R = groups.map((g) => SHELL0 + SHELL_DR * shellsFor(g.notes.length) + 2.5);

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
      const rest = R[i] + R[j] + 34;
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
        const minD = R[i] + R[j] + 16;
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

  // Notes en couches autour du noyau (les plus liées au centre). Noms encadrés comme dans la vidéo.
  const maxN = Math.max(1, ...groups.map((g) => g.notes.length));
  const named = new Set([...groups].sort((a, b) => b.notes.length - a.notes.length).slice(0, 20).map((g) => g.idx));
  groups.forEach((g, gi) => {
    const list = [...g.notes].sort((a, b) => notes[b].deg - notes[a].deg || a - b);
    let k = 0;
    let shell = 1;
    while (k < list.length) {
      const cap = Math.min(3 * shell * shell, list.length - k);
      const rad = SHELL0 + SHELL_DR * shell;
      const rx = TAU * hash01(gi * 31 + shell, 51);
      const ry = TAU * hash01(gi * 31 + shell, 52);
      for (let j = 0; j < cap; j++, k++) {
        const y = cap === 1 ? 0 : 1 - (2 * (j + 0.5)) / cap;
        const rr = Math.sqrt(1 - y * y);
        const a = j * GA;
        const v = rotXY(Math.cos(a) * rr, y, Math.sin(a) * rr, rx, ry);
        const ni = list[k];
        const jr = rad * (0.9 + 0.2 * hash01(notes[ni].seed, 53));
        L.pos[ni * 3] = P[gi * 3] + v[0] * jr;
        L.pos[ni * 3 + 1] = P[gi * 3 + 1] + v[1] * jr;
        L.pos[ni * 3 + 2] = P[gi * 3 + 2] + v[2] * jr;
      }
      shell++;
    }
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

  // Poussière : noyaux lumineux, orbites d'électrons, étoiles.
  const cdf = [];
  let acc = 0;
  for (const g of groups) cdf.push((acc += Math.sqrt(g.notes.length)));
  for (let i = 0; i < D; i++) {
    const o = i * 3;
    const r = hash01(i, 61);
    if (r < 0.82 && G) {
      const gi = pickCdf(cdf, hash01(i, 62));
      const n = groups[gi].notes.length;
      L.dustGroup[i] = gi;
      if (r < 0.46) {
        const b = ballPoint(i, 63, 2 + Math.cbrt(n) * 0.9);
        L.dustPos[o] = P[gi * 3] + b[0];
        L.dustPos[o + 1] = P[gi * 3 + 1] + b[1];
        L.dustPos[o + 2] = P[gi * 3 + 2] + b[2];
        L.dustRole[i] = ROLE.NUCLEUS;
      } else {
        const ring = Math.floor(hash01(i, 66) * 3);
        const th = TAU * hash01(i, 67);
        const rad = R[gi] - 1;
        const v = rotXY(Math.cos(th) * rad, 0, Math.sin(th) * rad, 1.15, (ring * TAU) / 3 + hash01(gi, 68) * TAU);
        L.dustPos[o] = P[gi * 3] + v[0];
        L.dustPos[o + 1] = P[gi * 3 + 1] + v[1];
        L.dustPos[o + 2] = P[gi * 3 + 2] + v[2];
        L.dustRole[i] = ROLE.ORBIT;
      }
    } else {
      hazeSphere(i, L.dustPos, o);
      L.dustRole[i] = ROLE.HAZE;
    }
  }

  L.frame = { center: [0, 0, 0], width: ext * 2, height: extY * 2 + 10, depth: ext * 1.4 };
  L.camDir = [0.12, 0.22, 1];
  L.linkFactor = 0.55;
  L.sizeMul = 1.25;
  L.drift = 0.3;
  L.question = t('q.molecule');
  L.answer = topPair
    ? t('a.molecule', { a: groups[topPair[0]].short, b: groups[topPair[1]].short, n: fmt(topPair[2]) })
    : t('a.moleculeNone');
  return L;
}

// ------------------------------------------------------------------ 3. Grille
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

