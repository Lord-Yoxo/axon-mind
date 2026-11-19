// Couleurs des données (dégradés lus de 0 à 1) et thèmes de fond.

export const PALETTES = {
  defaut: {
    label: 'Défaut',
    stops: ['#ff3b5c', '#ff8a2b', '#ffd23f', '#5dff7a', '#2fe0ff', '#4c7dff', '#b05cff'],
    dust: '#8f9bb8',
  },
  lave: {
    label: 'Lave',
    stops: ['#7d0f05', '#c4220b', '#ff4a1c', '#ff7a3d', '#ffb08a'],
    dust: '#b8341a',
  },
  ocean: {
    label: 'Océan',
    stops: ['#0b3a8c', '#1663d6', '#2fa0ff', '#5fd6ff', '#c2f2ff'],
    dust: '#3d7fd6',
  },
  foret: {
    label: 'Forêt',
    stops: ['#1d5c2a', '#2f8f3a', '#5fc24a', '#a6e36b', '#e0f7b8'],
    dust: '#4f9a52',
  },
  aurore: {
    label: 'Aurore',
    stops: ['#ff2d75', '#ff8a1f', '#ffe14d', '#3dff8b', '#22c7ff', '#7a5cff', '#e44dff'],
    dust: '#5e6cff',
  },
  matrice: {
    label: 'Matrice',
    stops: ['#0d6b2c', '#17a845', '#2fe866', '#7dffa3', '#d4ffe1'],
    dust: '#1f9a4a',
  },
  celeste: {
    label: 'Céleste',
    stops: ['#2a3fff', '#3f8cff', '#7fd0ff', '#dff3ff', '#b49cff'],
    dust: '#6f95ff',
  },
  braise: {
    label: 'Braise',
    stops: ['#a11500', '#e83300', '#ff6a00', '#ffaa1c', '#ffe7a0'],
    dust: '#ff5418',
  },
  soleil: {
    label: 'Coucher de soleil',
    stops: ['#3b1e8f', '#a12a8c', '#ff4f6d', '#ff9a3c', '#ffe08a'],
    dust: '#c0507a',
  },
};

/** Thèmes de fond (fond du canevas + teinte des panneaux). */
export const THEMES = {
  original: { label: 'Original', bg: '#050506', panel: '#0b0b0d', line: '#232327' },
  minuit: { label: 'Minuit', bg: '#04070f', panel: '#0a0f1c', line: '#1c2438' },
  graphite: { label: 'Graphite', bg: '#121315', panel: '#18191c', line: '#2b2d31' },
  pin: { label: 'Pin', bg: '#16211b', panel: '#1b2821', line: '#2c3d33' },
  prune: { label: 'Prune', bg: '#130a17', panel: '#1b0f20', line: '#33203a' },
  braise: { label: 'Braise', bg: '#150906', panel: '#1e0d09', line: '#3a1c14' },
};

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const cache = new Map();
function stopsOf(key) {
  if (!cache.has(key)) {
    const p = PALETTES[key] || PALETTES.defaut;
    cache.set(key, { stops: p.stops.map(hexToRgb), dust: hexToRgb(p.dust) });
  }
  return cache.get(key);
}

/** Couleur [r,g,b] du dégradé `key` à la position t ∈ [0,1]. */
export function samplePalette(key, t) {
  const { stops } = stopsOf(key);
  const x = Math.min(0.99999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function dustColor(key) {
  return stopsOf(key).dust;
}

export function paletteCss(key) {
  const p = PALETTES[key] || PALETTES.defaut;
  return `linear-gradient(90deg, ${p.stops.join(', ')})`;
}
