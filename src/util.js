// Petits outils partagés : hasard déterministe, courbes d'animation, texte.

import { locale } from './i18n.js';

export const TAU = Math.PI * 2;
export const GOLDEN = 0.6180339887498949;

/** Hash FNV-1a d'une chaîne (entier non signé 32 bits). */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Nombre pseudo-aléatoire stable dans [0, 1) à partir de deux entiers. */
export function hash01(a, b = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Minuscules sans accents, pour une recherche tolérante. */
export function normalizeText(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const nfCache = {};
/** Nombre formaté selon la langue choisie (1,432 / 1 432). */
export const fmt = (n) => {
  const loc = locale();
  if (!nfCache[loc]) nfCache[loc] = new Intl.NumberFormat(loc);
  return nfCache[loc].format(n);
};

/** Anti-rebond simple (le dernier appel gagne). */
export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return d;
}

/** Crée un élément DOM (sans dépendre des aides d'Obsidian). */
export function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Numéro de jour local (minuit local) pour une date en millisecondes. */
export function dayNumber(ms) {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

export function dayToDate(day) {
  const d = new Date(day * 86400000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
