// La vue « Axon Mind » : rendu three.js, transitions, intro, panneau « Vue »,
// légende par dossier, statistiques, recherche, survol et clic.

import { ItemView, Keymap } from 'obsidian';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VIEWS, ROLE, BODY_ROLES, SKEL_ROLES, computeLayout, flowPositions } from './layouts.js';
import { buildModel, wordTotals, countWords, parseSplit } from './model.js';
import { t, setLang, getLang } from './i18n.js';
import { buildNav, syncNav, syncStatus, setLive, renderNavigator, renderSide, SIDE_KEYS } from './panels.js';
import { PALETTES, THEMES, samplePalette, dustColor, paletteCss, hexToRgb } from './palettes.js';
import { DEFAULT_SETTINGS } from './settings.js';
import {
  el,
  fmt,
  clamp,
  hash01,
  hashStr,
  normalizeText,
  easeInOutCubic,
  easeOutExpo,
  smoothstep,
  debounce,
  dayNumber,
  dayToDate,
  TAU,
  GOLDEN,
} from './util.js';

THREE.ColorManagement.enabled = false;

export const VIEW_TYPE = 'axon-mind-view';
const MAX_DUST = 12000;
const MAX_BEADS = 700;
const QUALITY_PR = { fast: 1, high: 1.5, max: 2 };
const DEG = Math.PI / 180;
const NOTE_SIZE = 2.6;
const DUST_SIZE = 1.6;

const POINT_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uScale;
uniform float uBreath;
uniform float uSearch;
uniform float uSearchFloor;
uniform float uAlpha;
uniform float uDrift;
uniform float uBody;
uniform float uRecord;
uniform float uSkel;
uniform float uMaxPx;
attribute vec3 aColor;
attribute float aSize;
attribute float aPhase;
attribute float aMatch;
attribute float aBody;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float ph = aPhase * 6.2831853;
  vec3 p = position + vec3(sin(uTime * 0.7 + ph), cos(uTime * 0.6 + ph * 1.3), sin(uTime * 0.65 + ph * 0.7)) * uDrift;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float pulse = 1.0 + uBreath * 0.45 * sin(uTime * 1.5 + ph);
  float hit = mix(1.0, mix(0.8, 2.2, aMatch), uSearch);
  // aBody : 0 = normal, 1 = silhouette du corps, 2 = moelle, 3 = squelette et nerfs.
  float isBody = step(0.5, aBody) * (1.0 - step(1.5, aBody));
  float isRec = step(1.5, aBody) * (1.0 - step(2.5, aBody));
  float isSkel = step(2.5, aBody);
  float a = mix(1.0, mix(uSearchFloor, 1.3, aMatch), uSearch) * mix(1.0, uBody, isBody) * mix(1.0, uRecord, isRec) * mix(1.0, uSkel, isSkel);
  float dist = max(-mv.z, 0.001);
  float px = aSize * uSize * pulse * hit * uScale / dist;
  vAlpha = a * uAlpha * smoothstep(6.0, 60.0, dist) * clamp(px / 1.5, 0.2, 1.0);
  gl_PointSize = clamp(px, 1.0, uMaxPx);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 9.0);
  float halo = exp(-d2 * 2.6) * 0.3;
  gl_FragColor = vec4(vColor, (core + halo) * vAlpha);
}`;

/** Lueur : un grand disque très doux autour de chaque note (donne du volume au cerveau). */
const GLOW_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  gl_FragColor = vec4(vColor, exp(-d2 * 3.2) * (1.0 - d2) * vAlpha);
}`;

const RING_VERT = /* glsl */ `
uniform float uPx;
void main() {
  gl_PointSize = uPx;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float ring = smoothstep(0.6, 0.7, d) * (1.0 - smoothstep(0.82, 0.96, d));
  gl_FragColor = vec4(uColor, ring * uOpacity);
}`;

function pointsMaterial(searchFloor, frag = POINT_FRAG) {
  return new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: frag,
    uniforms: {
      uMaxPx: { value: 90 },
      uTime: { value: 0 },
      uSize: { value: 1 },
      uScale: { value: 800 },
      uBreath: { value: 0.5 },
      uSearch: { value: 0 },
      uSearchFloor: { value: searchFloor },
      uAlpha: { value: 1 },
      uDrift: { value: 0.3 },
      uBody: { value: 1 },
      uRecord: { value: 1 },
      uSkel: { value: 1 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const wrapAngle = (a) => a - TAU * Math.round(a / TAU);

const COLOR_MODES = () => ['folder', 'subfolder', 'tag', 'date', 'size', 'links', 'mono'].map((k) => [k, t('mode.' + k)]);
/** Teintes du LARP en couleurs : une teinte unique par forme, qui change à chaque étape. */
const LARP_PALETTES = ['lave', 'foret', 'ocean', 'soleil', 'matrice', 'celeste', 'braise'];
/** Position, dans chaque palette, de sa teinte la plus franche (lave → rouge, océan → bleu…). */
const MONO_T = { defaut: 0.62, lave: 0.36, ocean: 0.45, foret: 0.5, aurore: 0.1, matrice: 0.5, celeste: 0.3, braise: 0.45, soleil: 0.42 };
const RECORD_MODES = () => ['same', 'folder', 'date'].map((k) => [k, t('spine.' + k)]);
const CAT_MODES = new Set(['folder', 'subfolder', 'tag']);
/** Couleur du temps : du rouge (ancien) au vert (récent), comme la vidéo. */
const timeColor = (pal, x) => samplePalette(pal, 0.02 + 0.56 * clamp(x, 0, 1));
const LABEL_MODES = () => ['auto', 'on', 'off'].map((k) => [k, t('labels.' + k)]);
const LANGS = [
  ['en', 'English'],
  ['fr', 'Français'],
];

const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14"/></svg>';
const ICON_PANEL =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 9h3l2-5 3 9 2-6 1.5 2H15"/></svg>';

function fmtBytes(b) {
  if (b < 1024) return `${b} ${getLang() === 'fr' ? 'o' : 'B'}`;
  const fr = getLang() === 'fr';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} ${fr ? 'Ko' : 'KB'}`;
  return `${(b / 1024 / 1024).toFixed(1)} ${fr ? 'Mo' : 'MB'}`;
}
const pct = (v) => `${Math.round(v * 100)}${getLang() === 'fr' ? ' %' : '%'}`;
const lerpFrame = (a, b, t) => ({
  center: a.center.map((v, i) => v + (b.center[i] - v) * t),
  width: a.width + (b.width - a.width) * t,
  height: a.height + (b.height - a.height) * t,
  depth: a.depth + (b.depth - a.depth) * t,
});

export class AxonView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.model = null;
    this.layouts = {};
    this.view = VIEWS.some((v) => v.key === this.settings.view) ? this.settings.view : 'brain';
    this.intro = null;
    this.tween = null;
    this.colTween = null;
    this.camTween = null;
    this.hover = -1;
    this.mouse = null;
    this.searchVal = 0;
    this.searchTarget = 0;
    this.searchActive = false;
    this.hl = null; // ce qui est allumé : dossier, période, catégorie, note et voisines
    this.sel = -1; // note choisie (fiche à droite)
    this.selPath = null;
    this.spinHold = false;
    this.navExpanded = new Set();
    this.tlLabel = 'folder';
    this.notesAlpha = this.settings.showNotes === false ? 0 : 1;
    this.recAlpha = this.settings.showRecord === false ? 0 : 1;
    this.scaffoldVal = clamp(this.settings.scaffold, 0, 1);
    this.spinY = 0;
    this.spinZ = 0;
    this.width = 0;
    this.height = 0;
    this.started = false;
    this.destroyed = false;
    this.transitionCount = 0;
    this.linkFactor = 0;
    this.sizeMul = 1;
    this.drift = 0.3;
    this.introPulse = 1;
    this.flash = 0;
    this.wantIntro = false;
    this.anat = clamp(this.settings.anatomy, 0, 1);
    this.anatTarget = this.anat;
    this.anatCam = -1;
    this.flowPhase = 0;
    this.ctrls = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Axon Mind';
  }
  getIcon() {
    return 'brain-circuit';
  }

  async onOpen() {
    this.buildDOM();
    if (!this.initThree()) return;
    this.applyTheme();
    this.app.workspace.onLayoutReady(() => this.start());
  }

  async onClose() {
    this.destroy();
  }

  // ------------------------------------------------------------------ DOM
  buildDOM() {
    const c = this.contentEl;
    c.replaceChildren();
    c.classList.add('c3d-view');
    const root = (this.root = el('div', 'c3d-root', c));
    root.tabIndex = 0;
    // Colonnes : menu | navigateur de dossiers | scène 3D | fiche / chiffres / chronologie / toi.
    this.navEl = el('div', 'c3d-nav c3d-ui', root);
    this.navigatorEl = el('div', 'c3d-navigator c3d-ui', root);
    const stage = (this.stage = el('div', 'c3d-stage', root));
    this.sideEl = el('div', 'c3d-side c3d-ui', root);
    this.canvasWrap = el('div', 'c3d-canvas', stage);
    this.labelLayer = el('div', 'c3d-labels', stage);
    this.tipLine = el('div', 'c3d-tipline', stage);
    this.tooltip = el('div', 'c3d-tip', stage);
    this.tipName = el('div', 'c3d-tip-name', this.tooltip);
    this.tipSub = el('div', 'c3d-tip-sub', this.tooltip);
    this.introText = el('div', 'c3d-intro-text', stage);
    this.loading = el('div', 'c3d-loading', stage);
    this.emptyMsg = el('div', 'c3d-empty', stage);

    // En haut à gauche : bouton LARP (bien visible), recherche, statistiques.
    const tl = el('div', 'c3d-tl c3d-ui', stage);
    this.btnMenu = el('button', 'c3d-chip c3d-menu-btn', tl);
    this.btnMenu.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h12M2 8h12M2 12h12"/></svg>';
    this.btnMenu.onclick = () => this.toggleNav(true);
    this.btnArp = el('button', 'c3d-arp', tl);
    el('span', 'c3d-arp-dot', this.btnArp);
    el('span', 'c3d-arp-txt', this.btnArp, 'LARP');
    this.btnArp.onclick = () => this.toggleArp();
    const sb = el('label', 'c3d-search', tl);
    el('span', 'c3d-search-ico', sb).innerHTML = ICON_SEARCH;
    const input = (this.searchInput = el('input', null, sb));
    input.type = 'text';
    input.spellcheck = false;
    this.searchCount = el('span', 'c3d-search-count', sb);
    el('span', 'c3d-kbd', sb, '/');
    input.addEventListener('input', () => this.onSearch());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.value = '';
        this.onSearch();
        this.root.focus();
      } else if (e.key === 'Enter' && this.firstMatch >= 0) {
        this.selectNote(this.firstMatch, { fly: true });
      }
    });
    this.btnStats = el('button', 'c3d-chip', tl);
    this.btnStats.onclick = () => this.setSide(this.settings.side === 'stats' ? '' : 'stats');
    this.btnReset = el('button', 'c3d-chip', tl);
    this.btnReset.onclick = () => this.resetView();
    this.btnFocus = el('button', 'c3d-chip c3d-focus-btn', tl);
    this.btnFocus.onclick = () => this.toggleFocus();
    // Ce qui est allumé, quand le menu de gauche est masqué.
    this.stageStatus = el('div', 'c3d-stage-status c3d-ui', stage);

    // En haut à droite : bouton du panneau « Vue ».
    this.btnPanel = el('button', 'c3d-panel-btn c3d-ui', stage);
    this.btnPanel.innerHTML = ICON_PANEL;
    this.btnPanel.onclick = () => this.togglePanel('showPanel');
    this.panel = el('div', 'c3d-vpanel c3d-ui', stage);

    // En bas : légende par dossier.
    this.folderBar = el('div', 'c3d-folders c3d-ui', stage);

    buildNav(this);
    this.localizeStatic();
    this.buildPanel();
    this.syncPanels();
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  togglePanel(key) {
    this.settings[key] = !this.settings[key];
    this.save();
    this.syncPanels();
  }

  syncPanels() {
    const s = this.settings;
    this.btnStats.classList.toggle('is-active', s.side === 'stats' && this.sel < 0);
    this.panel.classList.toggle('is-open', !!s.showPanel);
    this.btnPanel.classList.toggle('is-active', !!s.showPanel);
    this.root.classList.toggle('c3d-panel-open', !!s.showPanel);
    this.root.classList.toggle('c3d-nav-on', s.showNav !== false);
    this.root.classList.toggle('c3d-navigator-on', !!s.navOpen);
    this.root.classList.toggle('c3d-side-open', !!this.sideKey());
    this.labelLayer.style.display = s.labels === 'off' ? 'none' : '';
    this.root.classList.toggle('c3d-labels-all', s.labels === 'on');
    if (this.formBtns) for (const v of VIEWS) this.formBtns[v.key].classList.toggle('is-active', v.key === this.view);
    if (this.anatRow) this.anatRow.classList.toggle('is-dim', this.view !== 'brain');
    syncNav(this);
  }

  // ------------------------------------------- menu, navigateur, colonne de droite
  /** Contenu de la colonne de droite : la fiche d'une note passe avant le reste. */
  sideKey() {
    if (this.sel >= 0 && this.model && this.model.notes[this.sel]) return 'note';
    return SIDE_KEYS.includes(this.settings.side) ? this.settings.side : '';
  }

  navTo(k) {
    if (k === 'explorer') return this.toggleNavigator(!this.settings.navOpen);
    if (k === 'mind') {
      this.clearSelection(false);
      this.setSide('');
      if (this.view !== 'brain') this.setView('brain');
      else this.resetView();
      return;
    }
    this.clearSelection(false);
    this.setSide(this.settings.side === k ? '' : k);
  }

  toggleNav(on) {
    this.settings.showNav = !!on;
    this.save();
    this.syncPanels();
  }

  toggleNavigator(on) {
    this.settings.navOpen = !!on;
    this.save();
    this.syncPanels();
    renderNavigator(this);
  }

  setSide(key) {
    const before = this.colorModeEff();
    this.settings.side = SIDE_KEYS.includes(key) ? key : '';
    this.save();
    this.syncPanels();
    renderSide(this);
    if (this.model && this.colorModeEff() !== before) this.recolor();
  }

  closeSide() {
    if (this.sel >= 0) this.clearSelection(true);
    else this.setSide('');
  }

  /** Mode de couleur effectif : l'Historique d'écriture colore tout par date. */
  colorModeEff() {
    if (this.arpPal) return 'mono';
    return this.settings.side === 'history' && this.sel < 0 ? 'date' : this.settings.colorMode;
  }

  // --------------------------------------------------------- ce qui est allumé
  setHighlight(hl) {
    this.hl = hl;
    this.onSearch();
    syncStatus(this);
    renderNavigator(this);
    if (this.sideKey() === 'history') renderSide(this);
  }

  clearHighlight() {
    if (this.sel >= 0) return this.clearSelection(true);
    this.setHighlight(null);
  }

  /** Allume les notes qui vérifient `test` (clic à nouveau = éteint). */
  highlightWhere(key, label, test, kind = 'set') {
    if (!this.model) return;
    if (this.hl && this.hl.key === key && this.sel < 0) return this.setHighlight(null);
    if (this.sel >= 0) this.clearSelection(false);
    const N = this.model.notes.length;
    const mask = new Uint8Array(N);
    let count = 0;
    this.model.notes.forEach((n, i) => {
      if (test(n, i)) {
        mask[i] = 1;
        count++;
      }
    });
    this.setHighlight({ kind, key, label, mask, count });
  }

  highlightFolder(node) {
    const pre = node.path + '/';
    const label = node.path === '/' ? t('root') : node.name;
    this.highlightWhere(node.path, label, (n) => (node.path === '/' ? !n.path.includes('/') : n.path.startsWith(pre)), 'folder');
  }

  highlightPeriod(b) {
    const set = new Set(b.notes);
    this.highlightWhere('period:' + b.key, b.label, (n, i) => set.has(i), 'period');
  }

  highlightCategory(mode, ci) {
    const cats = mode === 'folder' ? null : this.cats;
    if (mode === 'folder') {
      const g = this.model.groups[ci];
      this.highlightWhere('cat:folder:' + ci, g.short, (n) => n.gi === ci, 'cat');
    } else {
      const c = cats[ci];
      this.highlightWhere('cat:' + mode + ':' + c.key, c.short, (n, i) => this.noteCat[i] === ci, 'cat');
    }
    this.syncFolderBar();
  }

  // ---------------------------------------------------------- note choisie
  selectNote(i, { fly = false } = {}) {
    const m = this.model;
    if (!m || !m.notes[i]) return;
    if (this.intro) this.skipIntro();
    const before = this.colorModeEff();
    this.sel = i;
    this.selPath = m.notes[i].path;
    const mask = new Uint8Array(m.notes.length);
    mask[i] = 1;
    for (const j of m.adj[i]) mask[j] = 1;
    this.hl = { kind: 'note', key: 'note:' + m.notes[i].path, label: m.notes[i].name, mask, count: 1 + m.adj[i].length };
    this.onSearch();
    this.syncPanels();
    renderSide(this);
    renderNavigator(this);
    if (this.colorModeEff() !== before) this.recolor();
    if (fly) this.focusOnNote(i);
  }

  clearSelection(render = true) {
    if (this.sel < 0) return;
    const before = this.colorModeEff();
    this.sel = -1;
    this.selPath = null;
    this.spinHold = false;
    if (this.hl && this.hl.kind === 'note') this.hl = null;
    this.onSearch();
    if (!render) return;
    this.syncPanels();
    renderSide(this);
    renderNavigator(this);
    if (this.model && this.colorModeEff() !== before) this.recolor();
  }

  /** « Zoomer dans le cerveau » : la caméra vient tout près de la note, la rotation s'arrête. */
  focusOnNote(i) {
    if (!this.model || !this.cur || i < 0) return;
    this.spinHold = true;
    this.group.updateMatrixWorld();
    const p = new THREE.Vector3(this.cur[i * 3], this.cur[i * 3 + 1], this.cur[i * 3 + 2]).applyMatrix4(this.group.matrixWorld);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const L = this.layout(this.view);
    const dist = Math.max(28, Math.min(140, Math.max(L.frame.width, L.frame.height) * 0.32));
    this.camTween = {
      start: performance.now(),
      dur: 1100,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: p.clone().addScaledVector(dir, dist),
      toTarget: p,
    };
    this.userCam = true;
  }

  // --------------------------------------------------- panneau « Vue »
  buildPanel() {
    const p = this.panel;
    p.replaceChildren();
    this.ctrls = [];
    const head = el('div', 'c3d-vp-head', p);
    el('span', 'c3d-vp-title', head, t('panel'));
    const close = el('button', 'c3d-vp-x', head, '×');
    close.title = t('close');
    close.onclick = () => this.togglePanel('showPanel');
    const sec = (title) => {
      const s = el('div', 'c3d-vp-sec', p);
      el('div', 'c3d-vp-sectitle', s, title);
      return s;
    };
    const row = (parent, label) => {
      const r = el('div', 'c3d-vp-row', parent);
      el('span', 'c3d-vp-label', r, label);
      return r;
    };
    const select = (parent, label, key, options, onChange) => {
      const r = row(parent, label);
      const sel = el('select', 'c3d-select', r);
      for (const [k, l] of options) {
        const o = el('option', null, sel, l);
        o.value = k;
      }
      sel.addEventListener('change', () => {
        this.settings[key] = sel.value;
        this.save();
        onChange();
      });
      this.ctrls.push(() => (sel.value = this.settings[key]));
      return r;
    };
    const slider = (parent, label, key, min, max, step, fmtv, onInput) => {
      const r = row(parent, label);
      r.classList.add('c3d-vp-row-slider');
      const val = el('span', 'c3d-vp-val', r);
      const inp = el('input', 'c3d-range', r);
      inp.type = 'range';
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.addEventListener('input', () => {
        this.settings[key] = parseFloat(inp.value);
        val.textContent = fmtv(this.settings[key]);
        if (onInput) onInput();
        this.save();
      });
      this.ctrls.push(() => {
        inp.value = String(this.settings[key]);
        val.textContent = fmtv(this.settings[key]);
      });
      return r;
    };
    const toggle = (parent, label, key, onChange) => {
      const r = row(parent, label);
      const sw = el('button', 'c3d-switch', r);
      sw.setAttribute('role', 'switch');
      sw.onclick = () => {
        this.settings[key] = !this.settings[key];
        sw.classList.toggle('is-on', !!this.settings[key]);
        this.save();
        if (onChange) onChange();
      };
      this.ctrls.push(() => sw.classList.toggle('is-on', !!this.settings[key]));
      return r;
    };

    // Apparence
    let s = sec(t('appearance'));
    select(
      s,
      t('theme'),
      'theme',
      Object.keys(THEMES).map((k) => [k, t('theme.' + k)]),
      () => this.applyTheme()
    );
    slider(s, t('brightness'), 'brightness', 0.4, 1.8, 0.01, pct);
    slider(s, t('glow'), 'glow', 0, 1, 0.01, pct);
    select(s, t('quality'), 'quality', ['fast', 'high', 'max'].map((k) => [k, t('quality.' + k)]), () => this.applyQuality());

    // Couleurs des données
    s = sec(t('dataColours'));
    select(s, t('notesBy'), 'colorMode', COLOR_MODES(), () => this.recolor());
    select(s, t('spineBy'), 'recordBy', RECORD_MODES(), () => this.recolor());
    const pl = el('div', 'c3d-pal-list', s);
    this.palBtns = [];
    for (const key of Object.keys(PALETTES)) {
      const b = el('button', 'c3d-pal-row', pl);
      el('span', 'c3d-pal-name', b, t('pal.' + key));
      el('span', 'c3d-pal-strip', b).style.background = paletteCss(key);
      b.onclick = () => {
        this.settings.palette = key;
        this.save();
        this.syncSettingsUI();
        this.recolor();
      };
      this.palBtns.push([key, b]);
    }
    this.scaleEl = el('div', 'c3d-scale', s);

    // Forme
    s = sec(t('form'));
    const grid = el('div', 'c3d-forms', s);
    this.formBtns = {};
    VIEWS.forEach((v, i) => {
      const b = el('button', 'c3d-form', grid, t('view.' + v.key));
      b.title = t('formTitle', { name: t('view.' + v.key), n: i + 1 });
      b.onclick = () => this.setView(v.key);
      this.formBtns[v.key] = b;
    });
    select(s, t('wheelStyle'), 'wheelStyle', ['slices', 'clock'].map((k) => [k, t('wheel.' + k)]), () => {
      delete this.layouts.wheel;
      if (this.view === 'wheel' && this.model) {
        const L = this.layout('wheel');
        this.startTransition(L, { dur: 1600, stagger: 0.25, arc: 0.2 });
        this.setLabels(L, 800);
        this.flyCamera(L, 1400);
        this.updateAnswer();
      }
    });
    this.anatRow = slider(s, t('body'), 'anatomy', 0, 1, 0.01, (v) => (v < 0.05 ? t('bodyMin') : v > 0.95 ? t('bodyMax') : pct(v)), () => {
      this.anatTarget = this.settings.anatomy;
      if (this.view === 'brain') this.userCam = false;
    });
    toggle(s, t('showNotes'), 'showNotes');
    toggle(s, t('showSpine'), 'showRecord', () => this.updateFolderBar());
    slider(s, t('shell'), 'scaffold', 0, 1, 0.01, pct);
    slider(s, t('skeleton'), 'skeleton', 0, 1, 0.01, pct);
    this.qEl = el('div', 'c3d-q', s);
    this.aEl = el('div', 'c3d-a', s);

    // Groupes
    s = sec(t('groups'));
    el('div', 'c3d-vp-sub', s, t('splitInto'));
    this.splitList = el('div', 'c3d-split-list', s);
    this.updateSplitList();
    select(s, t('labels'), 'labels', LABEL_MODES(), () => this.syncPanels());
    toggle(s, t('hideIsolated'), 'hideIsolated', () => this.recolor());

    // Mouvement
    s = sec(t('motion'));
    toggle(s, t('rotation'), 'turning');
    slider(s, t('speed'), 'rotationSpeed', 0, 1.5, 0.01, pct);
    slider(s, t('breathing'), 'breathing', 0, 1, 0.01, pct);
    toggle(s, t('larpColors'), 'larpColors', () => {
      if (!this.settings.larpColors && this.arpPal) {
        this.arpPal = null;
        this.recolor();
      }
    });

    // Dessin
    s = sec(t('drawing'));
    toggle(s, t('links'), 'links');
    slider(s, t('linkOpacity'), 'linkOpacity', 0, 1, 0.01, pct);
    toggle(s, t('signals'), 'signals');
    slider(s, t('signalSpeed'), 'signalSpeed', 0.2, 3, 0.05, pct);
    toggle(s, t('clouds'), 'clouds');
    slider(s, t('dust'), 'dust', 0, 1, 0.01, pct, () => this.updateDustRange());
    slider(s, t('pointSize'), 'pointSize', 0.3, 2.5, 0.05, pct);

    const foot = el('div', 'c3d-vp-foot', p);
    select(foot, t('language'), 'language', LANGS, () => this.relocalize());
    toggle(foot, t('introOnLaunch'), 'intro');
    const acts = el('div', 'c3d-vp-actions', foot);
    el('button', 'c3d-link', acts, t('replayIntro')).onclick = () => this.playIntro();
    el('button', 'c3d-link', acts, t('reset')).onclick = () => {
      const s0 = this.settings;
      const keep = {
        splitFolders: s0.splitFolders,
        language: s0.language,
        view: this.view,
        side: s0.side,
        navOpen: s0.navOpen,
        showNav: s0.showNav,
        clickOpens: s0.clickOpens,
        showPanel: true,
      };
      Object.assign(this.settings, DEFAULT_SETTINGS, keep);
      this.save();
      this.syncSettingsUI();
      this.syncPanels();
      this.applyTheme();
      this.updateDustRange();
      this.anatTarget = this.settings.anatomy;
      this.refreshData(true);
    };
    el('button', 'c3d-link', acts, t('fewer')).onclick = () => this.togglePanel('showPanel');
    this.syncSettingsUI();
  }

  /** Textes qui ne sont pas reconstruits avec le panneau. */
  localizeStatic() {
    this.emptyMsg.textContent = t('empty');
    this.searchInput.placeholder = t('search');
    this.btnStats.textContent = t('stats');
    this.btnReset.textContent = t('resetView');
    this.btnReset.title = t('resetTitle');
    this.btnFocus.textContent = t('focus');
    this.btnFocus.title = this.focusMode ? t('focusExit') : t('focusTitle');
    this.btnPanel.title = t('panelToggle');
    this.btnArp.title = this.arp ? t('larpStop') : t('larpTitle');
    this.btnMenu.title = t('navShow');
  }

  /** Changement de langue : on retraduit tout sans faire bouger les points. */
  relocalize() {
    setLang(this.settings.language);
    buildNav(this);
    this.localizeStatic();
    this.buildPanel();
    this.syncPanels();
    if (!this.model) return;
    this.layouts = {};
    this.timeline = null;
    this.refreshData(true);
    if (!this.intro) this.setLabels(this.layout(this.view), 0);
  }

  /** Liste des dossiers qui ont des sous-dossiers, avec un interrupteur chacun. */
  updateSplitList() {
    const box = this.splitList;
    if (!box) return;
    box.replaceChildren();
    const list = (this.model && this.model.splittable) || [];
    if (!list.length) {
      el('div', 'c3d-vp-note', box, t('splitNone'));
      return;
    }
    const current = new Set(parseSplit(this.settings.splitFolders));
    for (const f of list) {
      const r = el('div', 'c3d-vp-row', box);
      const lab = el('span', 'c3d-vp-label', r, f.name);
      lab.title = f.name;
      el('span', 'c3d-vp-hint', lab, ' · ' + t('splitHint', { n: fmt(f.count) }));
      const sw = el('button', 'c3d-switch' + (current.has(f.name) ? ' is-on' : ''), r);
      sw.setAttribute('role', 'switch');
      sw.onclick = () => {
        const set = new Set(parseSplit(this.settings.splitFolders));
        if (set.has(f.name)) set.delete(f.name);
        else set.add(f.name);
        this.settings.splitFolders = [...set].join(', ');
        sw.classList.toggle('is-on', set.has(f.name));
        this.save();
        this.refreshData(true);
      };
    }
  }

  syncSettingsUI() {
    for (const f of this.ctrls) f();
    if (this.palBtns) for (const [k, b] of this.palBtns) b.classList.toggle('is-active', this.settings.palette === k);
  }

  save() {
    this.plugin.saveSettingsSoon();
  }

  applyTheme() {
    const th = THEMES[this.settings.theme] || THEMES.original;
    const st = this.root.style;
    st.setProperty('--c3d-bg', th.bg);
    st.setProperty('--c3d-panel', th.panel);
    st.setProperty('--c3d-line', th.line);
    if (this.renderer) this.renderer.setClearColor(new THREE.Color(...hexToRgb(th.bg)), 1);
  }

  // ---------------------------------------------------------------- three
  initThree() {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (e) {
      console.error('[Axon Mind] WebGL unavailable', e);
      this.emptyMsg.textContent = t('noWebgl');
      this.root.classList.add('c3d-is-empty');
      return false;
    }
    const r = this.renderer;
    this.win = this.root.ownerDocument.defaultView || window;
    this.pixelRatio = Math.min(this.win.devicePixelRatio || 1, QUALITY_PR[this.settings.quality] || 2);
    r.setPixelRatio(this.pixelRatio);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.canvasWrap.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1.6, 0.5, 8000);
    this.camera.position.set(0, 40, 480);
    this.group = new THREE.Group();
    this.scene.add(this.group);

    const ctl = (this.controls = new OrbitControls(this.camera, r.domElement));
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    ctl.rotateSpeed = 0.6;
    ctl.zoomSpeed = 0.9;
    ctl.minDistance = 15;
    ctl.maxDistance = 2500;
    ctl.addEventListener('start', () => {
      this.userCam = true;
      this.camTween = null;
    });

    this.noteMat = pointsMaterial(0.06);
    this.dustMat = pointsMaterial(0.3);
    this.glowMat = pointsMaterial(0.02, GLOW_FRAG);
    this.glowMat.uniforms.uMaxPx.value = 260;
    // Enveloppe du corps en fil de fer (forme Cerveau) : de fins traits, très discrets.
    this.shellMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.shellAlpha = 0;
    this.linkMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      // Mélange normal : des milliers de liens superposés gardent leur couleur au lieu de virer au blanc.
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
    });

    // Poussière : un réservoir fixe de grains.
    const D = MAX_DUST;
    this.dustCur = new Float32Array(D * 3);
    this.dustFrom = new Float32Array(D * 3);
    this.dustTo = new Float32Array(D * 3);
    this.dustArc = new Float32Array(D * 3);
    this.dustDelay = new Float32Array(D);
    this.dustCol = new Float32Array(D * 3);
    this.dustColFrom = new Float32Array(D * 3);
    this.dustColTo = new Float32Array(D * 3);
    this.dustBody = new Float32Array(D);
    const dSize = new Float32Array(D);
    const dPhase = new Float32Array(D);
    for (let i = 0; i < D; i++) {
      const h = hash01(i, 121);
      dSize[i] = DUST_SIZE * (0.45 + 0.9 * h * h);
      dPhase[i] = hash01(i, 122);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dustCur, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aColor', new THREE.BufferAttribute(this.dustCol, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
    dg.setAttribute('aPhase', new THREE.BufferAttribute(dPhase, 1));
    this.dustMatch = new Float32Array(D);
    dg.setAttribute('aMatch', new THREE.BufferAttribute(this.dustMatch, 1).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aBody', new THREE.BufferAttribute(this.dustBody, 1).setUsage(THREE.DynamicDrawUsage));
    this.dustPoints = new THREE.Points(dg, this.dustMat);
    this.dustPoints.frustumCulled = false;
    this.group.add(this.dustPoints);
    this.updateDustRange();

    this.initBeads();
    this.initClouds();

    // Anneau de survol.
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uPx: { value: 30 }, uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ring = new THREE.Points(rg, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 10;
    this.group.add(this.ring);

    // Taille de la zone (0 quand l'onglet est caché).
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);

    // Souris : survol, clic, sortie.
    const cv = r.domElement;
    cv.addEventListener('pointermove', (e) => {
      const b = cv.getBoundingClientRect();
      this.mouse = { x: e.clientX - b.left, y: e.clientY - b.top };
      this.mouseDirty = true;
    });
    cv.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.setHover(-1);
    });
    cv.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    cv.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || this.intro || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 6 || performance.now() - d.t >= 600) return;
      if (this.hover >= 0) {
        // Clic : la fiche de la note (ou la note directement si demandé, ou avec Ctrl / Cmd).
        if (this.settings.clickOpens || Keymap.isModEvent(e)) this.openNote(this.hover, e);
        else this.selectNote(this.hover);
      } else if (this.sel >= 0) {
        this.clearSelection(true);
      }
    });
    cv.addEventListener('dblclick', (e) => {
      if (!this.intro && this.hover >= 0 && !this.settings.clickOpens) this.openNote(this.hover, e);
    });
    this.root.addEventListener('pointerdown', () => {
      if (this.intro && performance.now() - this.intro.t0 > 300) this.skipIntro();
    });

    this.loopBound = (t) => this.loop(t);
    this.raf = this.win.requestAnimationFrame(this.loopBound);
    return true;
  }

  onResize() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    this.width = w;
    this.height = h;
    if (!w || !h || !this.renderer) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = (h * this.pixelRatio * 0.5) / Math.tan((this.camera.fov * DEG) / 2);
    this.noteMat.uniforms.uScale.value = scale;
    this.dustMat.uniforms.uScale.value = scale;
    this.ringMat.uniforms.uPx.value = 26 * this.pixelRatio;
    this.root.classList.toggle('c3d-narrow', w < 760);
    if (!this.model) return;
    if (!this.userCam && !this.camTween) this.snapCamera(this.layout(this.view));
    if (!this.relayoutSoon) this.relayoutSoon = debounce(() => this.relayoutFlat(), 350);
    this.relayoutSoon();
  }

  /** Les vues à plat dépendent du format de l'écran : on les recalcule s'il a beaucoup changé. */
  relayoutFlat() {
    if (this.destroyed || !this.model || !this.width || !this.height) return;
    const asp = this.width / this.height;
    for (const k of ['grid', 'curve', 'flow', 'life']) {
      const L = this.layouts[k];
      if (!L || Math.abs(Math.log(asp / L.aspect)) < 0.2) continue;
      delete this.layouts[k];
      if (k === this.view && !this.intro) {
        const nl = this.layout(k);
        this.startTransition(nl, { dur: 1000, stagger: 0.15, arc: 0.05 });
        this.setLabels(nl, 500);
        if (!this.userCam) this.flyCamera(nl, 900);
      }
    }
  }

  // ------------------------------------------------------------- données
  start() {
    if (this.destroyed || this.started) return;
    this.started = true;
    const refresh = (this.refreshSoon = debounce(() => this.refreshData(true), 700));
    this.registerEvent(this.app.metadataCache.on('resolved', refresh));
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        this.plugin.wordCache.delete(file.path);
        refresh();
      })
    );
    this.registerEvent(this.app.vault.on('create', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));

    this.refreshData(false);
    if ((this.settings.intro || this.wantIntro) && this.model.notes.length) this.playIntro();
  }

  /** Relit le coffre et fait voler les points vers la nouvelle forme si besoin. */
  refreshData(animate) {
    if (this.destroyed) return;
    if (this.intro && animate) {
      this.pendingRefresh = true;
      return;
    }
    const old = this.model;
    if (animate) {
      setLive(this, true);
      if (this._liveT) this.win.clearTimeout(this._liveT);
      this._liveT = this.win.setTimeout(() => setLive(this, false), 1200);
    }
    const model = buildModel(this.app, this.settings, this.plugin.wordCache);
    const N = model.notes.length;
    const structural = !old || old.structSig !== model.structSig;
    this.model = model;
    this.tree = null;
    this.timeline = null;
    if (structural) this.layouts = {};
    else {
      for (const k of ['curve', 'wheel', 'life']) delete this.layouts[k]; // dépendent des dates
    }
    // Si la structure est la même (mêmes notes, même ordre), on garde les tableaux.
    if (structural) {
      this.allocNotes(model, old);
      this.buildLinks();
      // Les indices changent : on retrouve la note choisie par son chemin, le reste s'éteint.
      const si = this.selPath ? model.notes.findIndex((n) => n.path === this.selPath) : -1;
      this.sel = -1;
      this.hl = null;
      if (si >= 0) {
        this.sel = si;
        const mask = new Uint8Array(N);
        mask[si] = 1;
        for (const j of model.adj[si]) mask[j] = 1;
        this.hl = { kind: 'note', key: 'note:' + this.selPath, label: model.notes[si].name, mask, count: 1 + model.adj[si].length };
      } else this.selPath = null;
    }
    this.root.classList.toggle('c3d-is-empty', N === 0);
    this.computeNoteColors();
    this.onSearch();
    const L = this.layout(this.view);
    if (!animate) {
      this.cur.set(this.targetPositions(L, 0));
      this.dustCur.set(L.dustPos);
      this.setDustBody(L);
      this.computeDustColors(L);
      this.noteCol.set(this.noteColTo);
      this.dustCol.set(this.dustColTo);
      this.linkFactor = L.linkFactor;
      this.sizeMul = L.sizeMul;
      this.drift = L.drift;
      this.markDirty();
      this.setLabels(L, 0);
      this.snapCamera(L);
    } else if (structural || ['curve', 'wheel', 'life'].includes(this.view)) {
      this.startTransition(L, { dur: 1500, stagger: 0.2, arc: 0.1 });
      this.setLabels(L, 600);
    } else {
      this.computeDustColors(L);
      this.startColorTween(600);
    }
    this.updateLinkColors();
    this.updateFolderBar();
    this.updateScale();
    this.updateAnswer();
    this.updateSplitList();
    this.syncPanels();
    renderSide(this);
    renderNavigator(this);
    this.loadWords();
  }

  allocNotes(model, old) {
    const N = model.notes.length;
    const prev = new Map();
    if (old && this.cur) old.notes.forEach((n, i) => prev.set(n.path, i));
    const cur = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const maxDeg = Math.max(1, model.maxDeg);
    model.notes.forEach((n, i) => {
      const j = prev.get(n.path);
      if (j !== undefined) {
        cur[i * 3] = this.cur[j * 3];
        cur[i * 3 + 1] = this.cur[j * 3 + 1];
        cur[i * 3 + 2] = this.cur[j * 3 + 2];
        col[i * 3] = this.noteCol[j * 3];
        col[i * 3 + 1] = this.noteCol[j * 3 + 1];
        col[i * 3 + 2] = this.noteCol[j * 3 + 2];
      }
      phase[i] = hash01(n.seed, 7);
      size[i] = NOTE_SIZE * (0.8 + 0.75 * Math.sqrt(n.deg / maxDeg));
    });
    this.cur = cur;
    this.noteCol = col;
    this.from = new Float32Array(N * 3);
    this.to = new Float32Array(N * 3);
    this.arc = new Float32Array(N * 3);
    this.delay = new Float32Array(N);
    this.noteColFrom = new Float32Array(N * 3);
    this.noteColTo = new Float32Array(N * 3);
    this.match = new Float32Array(N);
    this.hidden = new Uint8Array(N);

    if (this.notePoints) {
      this.group.remove(this.notePoints);
      if (this.glowPoints) this.group.remove(this.glowPoints);
      this.notePoints.geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(cur, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aMatch', new THREE.BufferAttribute(this.match, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(N), 1));
    // La lueur partage la géométrie des notes (mêmes positions, mêmes couleurs), dessinée en dessous.
    this.glowPoints = new THREE.Points(g, this.glowMat);
    this.glowPoints.frustumCulled = false;
    this.glowPoints.renderOrder = -1;
    this.group.add(this.glowPoints);
    this.notePoints = new THREE.Points(g, this.noteMat);
    this.notePoints.frustumCulled = false;
    this.group.add(this.notePoints);
    this.setHover(-1);
  }

  /** Enveloppe en fil de fer de la forme Cerveau (anneaux et méridiens du corps). */
  buildShell(L) {
    if (this.shellLines) {
      this.group.remove(this.shellLines);
      this.shellLines.geometry.dispose();
      this.shellLines = null;
    }
    if (this.skelLines) {
      this.group.remove(this.skelLines);
      this.skelLines.geometry.dispose();
      this.skelLines = null;
    }
    if (!L || !L.shellLines || !this.shellMat) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(L.shellLines, 3));
    this.shellLines = new THREE.LineSegments(g, this.shellMat);
    this.shellLines.frustumCulled = false;
    this.shellLines.renderOrder = -3;
    this.group.add(this.shellLines);
    // Squelette (côtes, sternum, clavicules, omoplates, bassin) et nerfs : traits fins colorés.
    if (L.skelLines && L.skelLines.length) {
      if (!this.skelMat) {
        this.skelMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthTest: false,
          depthWrite: false,
        });
      }
      this.skelKind = L.skelKind;
      this.skelY = new Float32Array(L.skelLines.length / 3);
      for (let k = 0; k < this.skelY.length; k++) this.skelY[k] = L.skelLines[k * 3 + 1];
      this.skelBody = L.body;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(L.skelLines, 3));
      sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(L.skelLines.length), 3));
      this.skelLines = new THREE.LineSegments(sg, this.skelMat);
      this.skelLines.frustumCulled = false;
      this.skelLines.renderOrder = -2;
      this.group.add(this.skelLines);
      this.colorSkeleton();
    }
  }

  /** Couleurs du squelette : os blanc teinté, nerfs de la couleur de la scène (ou dégradé du haut vers le bas). */
  colorSkeleton() {
    if (!this.skelLines || !this.model) return;
    const pal = this.palette();
    const mono = this.colorModeEff() === 'mono' ? this.monoBase() : null;
    const dc = dustColor(pal);
    const col = this.skelLines.geometry.attributes.color;
    const b = this.skelBody || { top: 33, bottom: -262 };
    for (let k = 0; k < this.skelKind.length; k++) {
      let c;
      if (this.skelKind[k] === 0) {
        const base = mono || dc;
        c = [base[0] * 0.5 + 0.5, base[1] * 0.5 + 0.5, base[2] * 0.5 + 0.5];
      } else {
        const along = clamp((b.top - this.skelY[k]) / (b.top - b.bottom), 0, 1);
        c = mono || samplePalette(pal, 0.08 + 0.8 * along);
      }
      col.array[k * 3] = c[0];
      col.array[k * 3 + 1] = c[1];
      col.array[k * 3 + 2] = c[2];
    }
    col.needsUpdate = true;
  }

  buildLinks() {
    const pairs = this.model.pairs;
    const M = pairs.length / 2;
    if (this.linkLines) {
      this.group.remove(this.linkLines);
      this.linkLines.geometry.dispose();
    }
    this.linkPos = new Float32Array(M * 6);
    this.linkCol = new Float32Array(M * 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.linkPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.linkCol, 4));
    this.linkLines = new THREE.LineSegments(g, this.linkMat);
    this.linkLines.frustumCulled = false;
    this.linkLines.renderOrder = -1;
    this.group.add(this.linkLines);
    this.buildFibers();
    this.updateLinkPositions();
  }

  /**
   * Fibres du cerveau : une sélection de liens (surtout entre dossiers différents, qui traversent
   * le cerveau de part en part) dessinés en lumineux, pour voir les filaments à l'intérieur.
   */
  buildFibers() {
    if (this.fiberLines) {
      this.group.remove(this.fiberLines);
      this.fiberLines.geometry.dispose();
      this.fiberLines = null;
    }
    const pairs = this.model.pairs;
    const notes = this.model.notes;
    const M = pairs.length / 2;
    // Les notes « carrefours » (les plus liées) deviennent des neurones : leurs liens partent en éventail.
    const hubs = new Set(
      [...notes]
        .sort((a, b) => b.deg - a.deg)
        .slice(0, 48)
        .filter((n) => n.deg > 2)
        .map((n) => n.i)
    );
    const cand = [];
    for (let k = 0; k < M; k++) {
      const a = pairs[k * 2];
      const b = pairs[k * 2 + 1];
      const hub = hubs.has(a) || hubs.has(b);
      const cross = notes[a].gi !== notes[b].gi;
      cand.push([(hub ? 1 : cross ? 0.4 : 0.15) * hash01(k, 911), k]);
    }
    cand.sort((x, y) => y[0] - x[0]);
    const F = Math.min(1500, M);
    this.fiberIdx = Uint32Array.from(cand.slice(0, F).map((c) => c[1]));
    if (!F) return;
    if (!this.fiberMat) {
      this.fiberMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });
      this.fiberAlpha = 0;
    }
    this.fiberPos = new Float32Array(F * 6);
    this.fiberCol = new Float32Array(F * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.fiberPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.fiberCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.fiberLines = new THREE.LineSegments(g, this.fiberMat);
    this.fiberLines.frustumCulled = false;
    this.fiberLines.renderOrder = -1;
    this.group.add(this.fiberLines);
  }

  updateLinkPositions() {
    const p = this.model.pairs;
    const lp = this.linkPos;
    const c = this.cur;
    for (let k = 0, o = 0; k < p.length; k += 2, o += 6) {
      const a = p[k] * 3;
      const b = p[k + 1] * 3;
      lp[o] = c[a];
      lp[o + 1] = c[a + 1];
      lp[o + 2] = c[a + 2];
      lp[o + 3] = c[b];
      lp[o + 4] = c[b + 1];
      lp[o + 5] = c[b + 2];
    }
    this.linkLines.geometry.attributes.position.needsUpdate = true;
    if (this.fiberLines) {
      const fp = this.fiberPos;
      const idx = this.fiberIdx;
      for (let f = 0; f < idx.length; f++) {
        const o = f * 6;
        fp.set(lp.subarray(idx[f] * 6, idx[f] * 6 + 6), o);
      }
      this.fiberLines.geometry.attributes.position.needsUpdate = true;
    }
  }

  updateLinkColors() {
    if (!this.linkLines) return;
    const p = this.model.pairs;
    const lc = this.linkCol;
    const c = this.noteColTo;
    const notes = this.model.notes;
    for (let k = 0, o = 0; k < p.length; k += 2, o += 8) {
      const a = p[k] * 3;
      const b = p[k + 1] * 3;
      // Liens internes à un dossier discrets, liens entre dossiers plus visibles.
      let alpha = notes[p[k]].gi === notes[p[k + 1]].gi ? 0.3 : 1;
      if (this.hidden[p[k]] || this.hidden[p[k + 1]]) alpha = 0;
      for (let j = 0; j < 3; j++) {
        lc[o + j] = c[a + j];
        lc[o + 4 + j] = c[b + j];
      }
      lc[o + 3] = alpha;
      lc[o + 7] = alpha;
    }
    this.linkLines.geometry.attributes.color.needsUpdate = true;
    if (this.fiberLines) {
      // Fibres : la couleur des deux notes, éclaircie (filament lumineux), éteinte si une note est masquée.
      const fc = this.fiberCol;
      const idx = this.fiberIdx;
      for (let f = 0; f < idx.length; f++) {
        const k = idx[f] * 2;
        const off = this.hidden[p[k]] || this.hidden[p[k + 1]] ? 0 : 1;
        for (let e = 0; e < 2; e++) {
          const ni = p[k + e] * 3;
          for (let j = 0; j < 3; j++) fc[f * 6 + e * 3 + j] = (c[ni + j] * 0.85 + 0.08) * off;
        }
      }
      this.fiberLines.geometry.attributes.color.needsUpdate = true;
    }
  }

  layout(key) {
    if (!this.layouts[key]) {
      const aspect = this.width && this.height ? this.width / this.height : 1.6;
      this.layouts[key] = computeLayout(key, this.model, MAX_DUST, aspect, { wheelStyle: this.settings.wheelStyle });
      this.layouts[key].aspect = aspect;
      if (key === 'brain') this.buildShell(this.layouts[key]);
    }
    return this.layouts[key];
  }

  flowSpeed() {
    return this.settings.turning ? 0.025 * Math.max(0.15, this.settings.rotationSpeed) : 0;
  }

  /** Positions d'arrivée des notes (le flux continue de couler pendant la transition). */
  targetPositions(L, durMs) {
    if (!L.flow) return L.pos;
    const out = (this._flowTarget = new Float32Array(L.pos.length));
    flowPositions(L, this.flowPhase + (durMs / 1000) * this.flowSpeed(), out, 1);
    return out;
  }

  setDustBody(L) {
    for (let i = 0; i < MAX_DUST; i++) {
      const r = L.dustRole[i];
      this.dustBody[i] = r === ROLE.RECORD ? 2 : SKEL_ROLES.has(r) ? 3 : BODY_ROLES.has(r) ? 1 : 0;
    }
    this.dustPoints.geometry.attributes.aBody.needsUpdate = true;
    this.dustOwnerCur = L.dustOwner;
    this.updateDustMatch();
  }

  /** Les grains de la mémoire s'allument avec leur note (recherche, période, dossier…). */
  updateDustMatch() {
    if (!this.dustMatch) return;
    const own = this.dustOwnerCur;
    const m = this.match;
    if (!own || !m) this.dustMatch.fill(0);
    else for (let i = 0; i < MAX_DUST; i++) this.dustMatch[i] = own[i] >= 0 ? m[own[i]] || 0 : 0;
    this.dustPoints.geometry.attributes.aMatch.needsUpdate = true;
  }

  updateDustRange() {
    if (this.dustPoints) this.dustPoints.geometry.setDrawRange(0, Math.round(MAX_DUST * clamp(this.settings.dust, 0, 1)));
  }

  markDirty() {
    if (!this.notePoints) return;
    this.notePoints.geometry.attributes.position.needsUpdate = true;
    this.notePoints.geometry.attributes.aColor.needsUpdate = true;
    this.dustPoints.geometry.attributes.position.needsUpdate = true;
    this.dustPoints.geometry.attributes.aColor.needsUpdate = true;
    this.updateLinkPositions();
  }

  // -------------------------------------------------------------- couleurs
  palette() {
    if (this.arpPal) return this.arpPal; // LARP en couleurs : la teinte change à chaque forme
    return PALETTES[this.settings.palette] ? this.settings.palette : 'defaut';
  }

  /** Teinte du mode « une seule couleur » : la couleur la plus franche de la palette choisie. */
  monoBase() {
    const pal = this.palette();
    return samplePalette(pal, MONO_T[pal] != null ? MONO_T[pal] : 0.55);
  }

  /** Couleur des traits de l'enveloppe : la teinte unique, ou le gris-bleu de la poussière. */
  colorShell() {
    if (!this.shellMat) return;
    const c = this.colorModeEff() === 'mono' ? this.monoBase() : dustColor(this.palette());
    this.shellMat.color.setRGB(c[0], c[1], c[2]);
  }

  computeNoteColors() {
    const m = this.model;
    const s = this.settings;
    const mode = this.colorModeEff();
    const pal = this.palette();
    const out = this.noteColTo;
    const raw = (this.noteRaw = new Float32Array(m.notes.length * 3));
    const G = m.groups.length;
    const nDays = m.dayList.length;
    const lmin = Math.log(m.minSize);
    const lmax = Math.log(m.maxSize);
    const ldeg = Math.log1p(m.maxDeg) || 1;
    const mono = this.monoBase();
    // Catégories (sous-dossier, étiquette) : une couleur par catégorie, dans l'ordre alphabétique.
    this.cats = null;
    this.noteCat = null;
    if (mode === 'subfolder' || mode === 'tag') {
      const keyOf = (n) => (mode === 'tag' ? n.tags[0] || '' : n.sub);
      const map = new Map();
      for (const n of m.notes) {
        const k = keyOf(n);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(n.i);
      }
      const keys = [...map.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
      const C = keys.length;
      this.cats = keys.map((k, idx) => {
        const short = k === '' ? t('untagged') : mode === 'tag' ? '#' + k : k === '/' ? t('root') : k.split('/').pop();
        const full = k === '' ? t('untagged') : mode === 'tag' ? '#' + k : k === '/' ? t('rootFull') : k.split('/').join(' › ');
        return { key: k, short, full, notes: map.get(k), t: k === '' ? -1 : C > 1 ? (idx * GOLDEN + 0.11) % 1 : 0.5 };
      });
      const idxOf = new Map(keys.map((k, idx) => [k, idx]));
      this.noteCat = new Int32Array(m.notes.length);
      for (const n of m.notes) this.noteCat[n.i] = idxOf.get(keyOf(n));
    }
    m.notes.forEach((n, i) => {
      let tt;
      let k = 1;
      let c = null;
      switch (mode) {
        case 'date':
          tt = nDays > 1 ? m.dayRank.get(dayNumber(n.mtime)) / (nDays - 1) : 1;
          c = timeColor(pal, tt);
          break;
        case 'size':
          tt = lmax > lmin ? (Math.log(Math.max(1, n.size)) - lmin) / (lmax - lmin) : 0.5;
          break;
        case 'links':
          tt = Math.log1p(n.deg) / ldeg;
          if (n.deg === 0) k = 0.45;
          break;
        case 'subfolder':
        case 'tag': {
          const cat = this.cats[this.noteCat[i]];
          if (cat.t < 0) {
            c = dustColor(pal);
            k = 0.55;
          } else tt = cat.t;
          break;
        }
        case 'mono': {
          // Une seule teinte : plus ou moins lumineuse, et les notes les plus liées tirent vers le blanc.
          const b = mono;
          // Chaque dossier a sa nuance (plus clair / plus sombre) : les cellules restent distinctes.
          const v = 0.38 + 0.42 * hash01(n.gi, 43) + 0.32 * hash01(n.seed, 41);
          const w = Math.min(0.85, 0.7 * Math.sqrt(n.deg / Math.max(1, m.maxDeg)) + (hash01(n.seed, 42) < 0.035 ? 0.45 : 0));
          c = [0, 1, 2].map((j) => b[j] * v * (1 - w) + w);
          break;
        }
        default:
          tt = G > 1 ? (n.gi * GOLDEN + 0.11) % 1 : 0.5;
      }
      if (!c) c = samplePalette(pal, tt);
      raw[i * 3] = c[0] * k;
      raw[i * 3 + 1] = c[1] * k;
      raw[i * 3 + 2] = c[2] * k;
      const hide = s.hideIsolated && n.deg === 0;
      this.hidden[i] = hide ? 1 : 0;
      if (hide) k = 0;
      out[i * 3] = c[0] * k;
      out[i * 3 + 1] = c[1] * k;
      out[i * 3 + 2] = c[2] * k;
    });
    // Couleur de chaque dossier (noyaux, filaments, pastilles) : celle de ses notes en mode Dossier.
    const gc = (this.groupCol = new Float32Array(G * 3));
    for (const g of m.groups) {
      if (mode === 'folder') {
        const c = samplePalette(pal, G > 1 ? (g.idx * GOLDEN + 0.11) % 1 : 0.5);
        gc.set(c, g.idx * 3);
        continue;
      }
      for (const ni of g.notes) for (let j = 0; j < 3; j++) gc[g.idx * 3 + j] += raw[ni * 3 + j];
      for (let j = 0; j < 3; j++) gc[g.idx * 3 + j] /= g.notes.length || 1;
    }
    // Couleur fixe par dossier (pour la mémoire « par dossier » et la chronologie), quel que soit le mode.
    const fc = (this.folderCol = new Float32Array(G * 3));
    for (const g of m.groups) fc.set(samplePalette(pal, G > 1 ? (g.idx * GOLDEN + 0.11) % 1 : 0.5), g.idx * 3);
  }

  /** Couleur fixe d'un dossier (indépendante du mode de couleur). */
  folderCss(gi) {
    const c = this.folderCol;
    if (!c) return this.groupCss(gi);
    return this.rgbCss(c[gi * 3], c[gi * 3 + 1], c[gi * 3 + 2]);
  }

  /** Couleur CSS d'une note (pour les fiches et listes). */
  noteCss(i) {
    const c = this.noteRaw || this.noteColTo;
    return this.rgbCss(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
  }

  rgbCss(r, g, b) {
    const m = Math.max(r, g, b, 0.001);
    const f = Math.min(1, 1 / m);
    return `rgb(${Math.round(r * f * 255)}, ${Math.round(g * f * 255)}, ${Math.round(b * f * 255)})`;
  }

  /** Couleur stable d'une étiquette (chronologie « par étiquette »). */
  tagCss(tag) {
    return this.rgbCss(...samplePalette(this.palette(), (hashStr(tag) % 997) / 997));
  }

  computeDustColors(L) {
    const pal = this.palette();
    const dc = dustColor(pal);
    const acc = samplePalette(pal, 0.82);
    const gc = this.groupCol;
    const out = this.dustColTo;
    const body = L.body;
    const rb = this.settings.recordBy;
    const recTime = rb === 'date' || (rb === 'same' && this.colorModeEff() === 'date');
    // Une seule couleur : toute la scène (moelle, corps, poussière) prend la même teinte.
    const mono = this.colorModeEff() === 'mono' ? this.monoBase() : null;
    const raw = this.noteRaw;
    const fc = this.folderCol;
    const notes = this.model.notes;
    for (let i = 0; i < MAX_DUST; i++) {
      const h = hash01(i, 131);
      const g = L.dustGroup[i];
      const G = g >= 0 && gc ? [gc[g * 3], gc[g * 3 + 1], gc[g * 3 + 2]] : dc;
      const y = L.dustPos[i * 3 + 1];
      const along = body ? clamp((body.top - y) / (body.top - body.bottom), 0, 1) : 0;
      let c;
      let k;
      switch (L.dustRole[i]) {
        case ROLE.RECORD: {
          // La mémoire : chaque grain porte la couleur de sa note (ou du temps, ou de son dossier).
          const ow = L.dustOwner ? L.dustOwner[i] : -1;
          if (ow < 0 || !notes[ow]) c = dc;
          else if (recTime) c = timeColor(pal, L.dustT[i]);
          else if (rb === 'folder' && fc) {
            const gi = notes[ow].gi;
            c = [fc[gi * 3], fc[gi * 3 + 1], fc[gi * 3 + 2]];
          } else c = raw ? [raw[ow * 3], raw[ow * 3 + 1], raw[ow * 3 + 2]] : dc;
          const vert = Math.pow(Math.max(0, Math.cos((y / 7.2) * TAU)), 6);
          k = 0.4 + 0.3 * h + 0.4 * vert;
          break;
        }
        case ROLE.BONE:
          // Os : blanc teinté (de la couleur unique, ou du gris-bleu de la poussière).
          c = mono ? [mono[0] * 0.6 + 0.4, mono[1] * 0.6 + 0.4, mono[2] * 0.6 + 0.4] : [dc[0] * 0.55 + 0.45, dc[1] * 0.55 + 0.45, dc[2] * 0.55 + 0.45];
          k = 0.34 + 0.3 * h;
          break;
        case ROLE.NERVE:
          // Nerfs : la teinte de la scène, ou le dégradé de la palette du cou vers le bas du corps.
          c = mono || samplePalette(pal, 0.08 + 0.8 * along);
          k = 0.45 + 0.4 * h;
          break;
        case ROLE.FILAMENT: {
          c = [dc[0] * 0.3 + G[0] * 0.7, dc[1] * 0.3 + G[1] * 0.7, dc[2] * 0.3 + G[2] * 0.7];
          // Plus discrets là où ils se rejoignent (sinon un point blanc au centre du cerveau).
          const near = L.body ? clamp((y - L.body.top * -0.45) / 30, 0.35, 1) : 1;
          k = (0.38 + 0.3 * h) * near;
          break;
        }
        case ROLE.SPINE: {
          c = samplePalette(pal, along);
          const vert = Math.cos(((y - (body ? -14 : 0)) / 6.5) * TAU) > 0.55;
          k = (vert ? 0.85 : 0.55) + 0.25 * h;
          break;
        }
        case ROLE.RIB:
          c = samplePalette(pal, along);
          k = 0.3 + 0.25 * h;
          break;
        case ROLE.SKIN:
          c = samplePalette(pal, along);
          k = 0.16 + 0.22 * h;
          break;
        case ROLE.NECK:
          c = samplePalette(pal, along);
          k = 0.35 + 0.3 * h;
          break;
        case ROLE.CEREBELLUM:
          c = samplePalette(pal, 0.15 + 0.2 * h);
          k = 0.45 + 0.3 * h;
          break;
        case ROLE.STEM:
          c = samplePalette(pal, 0.05);
          k = 0.55 + 0.3 * h;
          break;
        case ROLE.NUCLEUS:
          c = G;
          k = 0.75 + 0.45 * h;
          break;
        case ROLE.ORBIT:
          // Brume colorée autour de chaque amas (molécule).
          c = [G[0] * 0.82 + dc[0] * 0.18, G[1] * 0.82 + dc[1] * 0.18, G[2] * 0.82 + dc[2] * 0.18];
          k = 0.16 + 0.24 * h;
          break;
        case ROLE.RIBBON:
          c = G;
          k = 0.5 + 0.4 * h;
          break;
        case ROLE.BAR:
          c = G;
          k = 0.8 + 0.2 * h;
          break;
        case ROLE.ARC:
          c = G;
          k = 0.45 + 0.3 * h;
          break;
        case ROLE.ROWLINE:
          c = G;
          k = 0.16 + 0.16 * h;
          break;
        case ROLE.FILL: {
          const f = L.fill ? clamp((L.dustPos[i * 3] - L.fill.x0) / L.fill.w, 0, 1) : h;
          c = samplePalette(pal, f);
          k = 0.16 + 0.24 * h;
          break;
        }
        case ROLE.RINGFILL:
          c = G;
          k = (L.rot === 'sway' ? 0.42 : 0.24) + 0.28 * h; // horloge : pistes bien visibles
          break;
        case ROLE.LATTICE:
          c = dc;
          k = 0.1 + 0.18 * h;
          break;
        case ROLE.AXIS:
          c = dc;
          k = 0.5 + 0.3 * h;
          break;
        case ROLE.CURVE:
          c = acc;
          k = 0.7 + 0.3 * h;
          break;
        case ROLE.SPOKE:
          c = dc;
          k = 0.14 + 0.12 * h;
          break;
        case ROLE.RIM:
          c = L.key === 'wheel' ? acc : dc;
          k = 0.3 + 0.2 * h;
          break;
        default: {
          c = [dc[0] * 0.65 + 0.35, dc[1] * 0.65 + 0.35, dc[2] * 0.65 + 0.35];
          k = 0.12 + 0.28 * h * h;
        }
      }
      if (mono && L.dustRole[i] !== ROLE.RECORD && L.dustRole[i] !== ROLE.BONE) {
        // Quelques grains plus clairs, comme des étincelles.
        const sp = hash01(i, 133) < 0.05 ? 0.5 : 0;
        c = [mono[0] * (1 - sp) + sp, mono[1] * (1 - sp) + sp, mono[2] * (1 - sp) + sp];
      }
      out[i * 3] = c[0] * k;
      out[i * 3 + 1] = c[1] * k;
      out[i * 3 + 2] = c[2] * k;
    }
    this.colorShell();
    this.colorSkeleton();
  }

  recolor() {
    if (!this.model) return;
    this.computeNoteColors();
    this.computeDustColors(this.layout(this.view));
    this.startColorTween(700);
    this.updateLinkColors();
    this.colorClouds();
    this.updateScale();
    this.updateLabelColors();
    this.updateFolderBar();
    this.onSearch();
    renderSide(this);
    renderNavigator(this);
  }

  startColorTween(dur) {
    this.noteColFrom.set(this.noteCol);
    this.dustColFrom.set(this.dustCol);
    this.colTween = { start: performance.now(), dur };
  }

  updateColors(now) {
    const ct = this.colTween;
    if (!ct) return;
    const e = easeInOutCubic(clamp((now - ct.start) / ct.dur, 0, 1));
    const lerpArr = (out, a, b) => {
      for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * e;
    };
    lerpArr(this.noteCol, this.noteColFrom, this.noteColTo);
    lerpArr(this.dustCol, this.dustColFrom, this.dustColTo);
    this.notePoints.geometry.attributes.aColor.needsUpdate = true;
    this.dustPoints.geometry.attributes.aColor.needsUpdate = true;
    if (e >= 1) this.colTween = null;
  }

  // ------------------------------------------------------------ transitions
  startTransition(L, { dur = 2300, ease = easeInOutCubic, stagger = 0.32, arc = 0.22 } = {}) {
    const N = this.model.notes.length;
    const salt = ++this.transitionCount;
    this.from.set(this.cur);
    this.to.set(this.targetPositions(L, dur));
    const fill = (from, to, arcArr, delay, n, seedOf) => {
      for (let i = 0; i < n; i++) {
        const s = seedOf(i);
        delay[i] = hash01(s, 300 + salt) * stagger;
        const dx = to[i * 3] - from[i * 3];
        const dy = to[i * 3 + 1] - from[i * 3 + 1];
        const dz = to[i * 3 + 2] - from[i * 3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) * arc;
        const u = 2 * hash01(s, 400 + salt) - 1;
        const a = TAU * hash01(s, 500 + salt);
        const r = Math.sqrt(1 - u * u);
        arcArr[i * 3] = Math.cos(a) * r * len;
        arcArr[i * 3 + 1] = u * len;
        arcArr[i * 3 + 2] = Math.sin(a) * r * len;
      }
    };
    const notes = this.model.notes;
    fill(this.from, this.to, this.arc, this.delay, N, (i) => notes[i].seed);
    this.dustFrom.set(this.dustCur);
    this.dustTo.set(L.dustPos);
    fill(this.dustFrom, this.dustTo, this.dustArc, this.dustDelay, MAX_DUST, (i) => i * 7919 + 13);
    this.tween = {
      start: performance.now(),
      dur,
      ease,
      stagger,
      linkFrom: this.linkFactor,
      linkTo: L.linkFactor,
      sizeFrom: this.sizeMul,
      sizeTo: L.sizeMul,
      driftFrom: this.drift,
      driftTo: L.drift,
    };
    this.setDustBody(L);
    this.computeDustColors(L);
    this.startColorTween(dur * 0.8);
  }

  updateTween(now) {
    const tw = this.tween;
    if (!tw) return false;
    const T = (now - tw.start) / tw.dur;
    const span = 1 - tw.stagger;
    const run = (cur, from, to, arc, delay, n) => {
      for (let i = 0; i < n; i++) {
        const local = clamp((T - delay[i]) / span, 0, 1);
        const e = tw.ease(local);
        const s = Math.sin(Math.PI * e);
        const o = i * 3;
        cur[o] = from[o] + (to[o] - from[o]) * e + arc[o] * s;
        cur[o + 1] = from[o + 1] + (to[o + 1] - from[o + 1]) * e + arc[o + 1] * s;
        cur[o + 2] = from[o + 2] + (to[o + 2] - from[o + 2]) * e + arc[o + 2] * s;
      }
    };
    run(this.cur, this.from, this.to, this.arc, this.delay, this.model.notes.length);
    run(this.dustCur, this.dustFrom, this.dustTo, this.dustArc, this.dustDelay, MAX_DUST);
    const g = easeInOutCubic(clamp(T, 0, 1));
    this.linkFactor = tw.linkFrom + (tw.linkTo - tw.linkFrom) * g;
    this.sizeMul = tw.sizeFrom + (tw.sizeTo - tw.sizeFrom) * g;
    this.drift = tw.driftFrom + (tw.driftTo - tw.driftFrom) * g;
    this.notePoints.geometry.attributes.position.needsUpdate = true;
    this.dustPoints.geometry.attributes.position.needsUpdate = true;
    if (T >= 1) this.tween = null;
    return true;
  }

  setView(key, opts = {}) {
    if (!VIEWS.some((v) => v.key === key) || !this.model) return;
    if (!opts.arp) this.stopArp(); // un choix à la main arrête le défilement
    if (this.intro) this.skipIntro();
    const changed = key !== this.view;
    this.view = key;
    this.settings.view = key;
    this.save();
    this.syncPanels();
    const L = this.layout(key);
    const rot = this.group.rotation;
    rot.y = wrapAngle(rot.y);
    rot.z = wrapAngle(rot.z);
    this.spinY = rot.y;
    this.spinZ = rot.z;
    // En mode LARP, tout va plus vite : ~1,2 s de vol puis la forme reste affichée jusqu'aux 2 s.
    const fast = !!opts.arp;
    if (changed) {
      this.startTransition(L, fast ? { dur: 1250, stagger: 0.22, arc: 0.2 } : undefined);
      this.setLabels(L, fast ? 650 : 1300);
    }
    this.spinHold = false;
    this.flyCamera(L, changed ? (fast ? 1150 : 2100) : 900);
    this.updateAnswer();
    if (changed) this.updateFolderBar();
  }

  // ------------------------------------------------------- Focus, Recentrer
  /** Focus : Axon occupe toute la fenêtre d'Obsidian (barres latérales, onglets et barre d'état cachés). */
  toggleFocus() {
    this.setFocus(!this.focusMode);
  }

  setFocus(on) {
    if (!this.root || !!on === !!this.focusMode) return;
    const doc = this.root.ownerDocument;
    if (on) {
      // On déplace la vue dans un calque plein écran posé sur toute la fenêtre.
      this.focusLayer = el('div', 'axon-mind-focus-layer', doc.body);
      this.focusLayer.appendChild(this.root);
      doc.body.classList.add('axon-mind-focus-on');
    } else {
      this.contentEl.appendChild(this.root);
      if (this.focusLayer) this.focusLayer.remove();
      this.focusLayer = null;
      doc.body.classList.remove('axon-mind-focus-on');
    }
    this.focusMode = !!on;
    this.root.classList.toggle('c3d-focused', this.focusMode);
    if (this.btnFocus) {
      this.btnFocus.classList.toggle('is-active', this.focusMode);
      this.btnFocus.title = this.focusMode ? t('focusExit') : t('focusTitle');
    }
    this.userCam = false;
    this.root.focus({ preventScroll: true });
  }

  /** Remet la caméra en place pour la forme affichée. */
  resetView() {
    if (!this.model) return;
    this.userCam = false;
    this.spinHold = false;
    this.flyCamera(this.layout(this.view), 900);
  }

  applyQuality() {
    if (!this.renderer) return;
    this.pixelRatio = Math.min(this.win.devicePixelRatio || 1, QUALITY_PR[this.settings.quality] || 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.onResize();
  }

  // ------------------------------------------------------------- Signaux
  /** Petites perles lumineuses qui voyagent le long des liens, comme l'influx nerveux. */
  initBeads() {
    const B = MAX_BEADS;
    this.beadPos = new Float32Array(B * 3);
    this.beadCol = new Float32Array(B * 3);
    this.beadState = new Float32Array(B * 3); // lien, avancement, vitesse
    const size = new Float32Array(B);
    const phase = new Float32Array(B);
    for (let i = 0; i < B; i++) {
      size[i] = 2.4 + 1.6 * hash01(i, 701);
      phase[i] = hash01(i, 702);
      this.beadState[i * 3] = 1e9; // pas encore de lien : tiré au premier tour
      this.beadState[i * 3 + 1] = hash01(i, 703);
      this.beadState[i * 3 + 2] = 0.25 + 0.5 * hash01(i, 704);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.beadPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.beadCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aMatch', new THREE.BufferAttribute(new Float32Array(B), 1));
    g.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(B), 1));
    this.beadMat = pointsMaterial(0.25);
    this.beads = new THREE.Points(g, this.beadMat);
    this.beads.frustumCulled = false;
    this.beads.renderOrder = 5;
    this.group.add(this.beads);
    this.beadAlpha = 0;
  }

  updateBeads(dt, time) {
    const s = this.settings;
    const pairs = this.model.pairs;
    const M = pairs.length / 2;
    const want = s.signals && M > 0 && !this.intro ? Math.min(1, this.linkFactor * 3) * this.notesAlpha : 0;
    this.beadAlpha += (want - this.beadAlpha) * Math.min(1, dt * 3);
    this.beads.visible = this.beadAlpha > 0.01;
    if (!this.beads.visible) return;
    const u = this.beadMat.uniforms;
    u.uTime.value = time;
    u.uSize.value = s.pointSize * this.sizeMul;
    u.uScale.value = this.noteMat.uniforms.uScale.value;
    u.uAlpha.value = this.beadAlpha * s.brightness;
    u.uSearch.value = this.searchVal;
    const st = this.beadState;
    const p = this.beadPos;
    const c = this.beadCol;
    const cur = this.cur;
    const col = this.noteCol;
    const speed = s.signalSpeed;
    for (let i = 0; i < MAX_BEADS; i++) {
      let k = st[i * 3];
      let tt = st[i * 3 + 1] + dt * st[i * 3 + 2] * speed;
      if (tt >= 1 || k >= M) {
        k = Math.floor(Math.random() * M);
        tt = tt >= 1 ? tt - 1 : tt;
        st[i * 3 + 2] = 0.25 + 0.5 * Math.random();
      }
      st[i * 3] = k;
      st[i * 3 + 1] = tt;
      const a = pairs[k * 2] * 3;
      const b = pairs[k * 2 + 1] * 3;
      const fade = Math.sin(Math.PI * tt);
      for (let j = 0; j < 3; j++) {
        p[i * 3 + j] = cur[a + j] + (cur[b + j] - cur[a + j]) * tt;
        c[i * 3 + j] = Math.min(1.4, (col[a + j] + (col[b + j] - col[a + j]) * tt) * 1.5 + 0.15) * fade;
      }
    }
    this.beads.geometry.attributes.position.needsUpdate = true;
    this.beads.geometry.attributes.aColor.needsUpdate = true;
  }

  // -------------------------------------------------------------- Nuages
  /** Grandes taches de couleur floues au fond de la scène, aux couleurs de la palette. */
  initClouds() {
    const cv = this.root.ownerDocument.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    this.cloudTex = new THREE.CanvasTexture(cv);
    this.cloudGroup = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const m = new THREE.SpriteMaterial({
        map: this.cloudTex,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(m);
      const u = 2 * hash01(i, 801) - 1;
      const a = TAU * hash01(i, 802);
      const r = 780 + 260 * hash01(i, 803);
      const sq = Math.sqrt(1 - u * u);
      sp.position.set(Math.cos(a) * sq * r, u * r * 0.6, Math.sin(a) * sq * r);
      const sc = 700 + 600 * hash01(i, 804);
      sp.scale.set(sc, sc * (0.6 + 0.4 * hash01(i, 805)), 1);
      sp.renderOrder = -2;
      this.cloudGroup.add(sp);
    }
    this.scene.add(this.cloudGroup);
    this.cloudAlpha = 0;
  }

  colorClouds() {
    if (!this.cloudGroup) return;
    const pal = this.palette();
    const mono = this.colorModeEff() === 'mono' ? this.monoBase() : null;
    this.cloudGroup.children.forEach((sp, i) =>
      sp.material.color.setRGB(...(mono ? mono.map((v) => v * (0.7 + 0.3 * hash01(i, 806))) : samplePalette(pal, (i * GOLDEN + 0.2) % 1)))
    );
  }

  updateClouds(dt) {
    const want = this.settings.clouds ? 1 : 0;
    this.cloudAlpha += (want - this.cloudAlpha) * Math.min(1, dt * 2);
    this.cloudGroup.visible = this.cloudAlpha > 0.005;
    if (!this.cloudGroup.visible) return;
    if (!this._cloudColored) {
      this.colorClouds();
      this._cloudColored = true;
    }
    this.cloudGroup.rotation.y += dt * 0.01;
    for (const sp of this.cloudGroup.children) sp.material.opacity = 0.075 * this.cloudAlpha * this.settings.brightness;
  }

  // --------------------------------------------------------------- LARP
  /** LARP : fait défiler toutes les formes, 2 secondes chacune, en boucle (pratique pour filmer). */
  toggleArp() {
    if (this.arp) this.stopArp();
    else this.startArp();
  }

  startArp() {
    if (!this.model || !this.model.notes.length) return;
    if (this.intro) this.skipIntro();
    const idx = Math.max(0, VIEWS.findIndex((v) => v.key === this.view));
    this.arp = { idx, next: 0 };
    this.btnArp.classList.add('is-on');
    this.btnArp.title = t('larpStop');
  }

  stopArp() {
    if (!this.arp) return;
    this.arp = null;
    this.btnArp.classList.remove('is-on');
    this.btnArp.title = t('larpTitle');
    if (this.arpPal) {
      // On rend ses couleurs habituelles à la vue.
      this.arpPal = null;
      this.recolor();
    }
  }

  updateArp(now) {
    const a = this.arp;
    if (!a || now < a.next) return;
    a.idx = (a.idx + 1) % VIEWS.length;
    a.next = now + 2000;
    if (this.settings.larpColors) {
      // Une teinte unique par forme, qui change à chaque étape (rouge, vert, bleu…).
      a.hue = ((a.hue == null ? -1 : a.hue) + 1) % LARP_PALETTES.length;
      this.arpPal = LARP_PALETTES[a.hue];
      this.computeNoteColors(); // la transition repart des nouvelles couleurs
      this.setView(VIEWS[a.idx].key, { arp: true });
      this.updateLinkColors();
      this.colorClouds();
      this.colorShell();
    } else {
      if (this.arpPal) {
        this.arpPal = null;
        this.computeNoteColors();
        this.updateLinkColors();
      }
      this.setView(VIEWS[a.idx].key, { arp: true });
    }
  }

  updateAnswer() {
    if (!this.model || !this.qEl) return;
    const L = this.layout(this.view);
    this.qEl.textContent = L.question || '';
    this.aEl.textContent = L.answer || '';
  }

  // ---------------------------------------------------------------- caméra
  frameOf(L) {
    if (L.frameNear) return lerpFrame(L.frameNear, L.frame, smoothstep(0, 1, this.anat));
    return L.frame;
  }

  cameraFor(L) {
    const f = this.frameOf(L);
    const vf = this.camera.fov * DEG;
    const asp = this.camera.aspect || 1.6;
    // Place prise par le panneau de droite et la légende du bas.
    const panelW = this.settings.showPanel && this.width > 700 ? 250 : 0;
    const usableW = Math.max(200, this.width - panelW);
    const wFrac = this.width ? usableW / this.width : 1;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * asp * wFrac);
    const pad = this.height > 260 ? this.height / (this.height - 110) : 1.25;
    const dist = Math.max((f.height * pad) / 2 / Math.tan(vf / 2), (f.width * 1.04) / 2 / Math.tan(hf / 2)) + f.depth / 2;
    const dir = new THREE.Vector3(...L.camDir).normalize();
    const target = new THREE.Vector3(...f.center);
    // Décale la cible pour centrer la forme dans la zone libre (à gauche du panneau, au-dessus de la légende).
    const worldPerPx = (2 * dist * Math.tan(vf / 2)) / Math.max(1, this.height);
    target.x += (panelW / 2) * worldPerPx;
    target.y -= 18 * worldPerPx;
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }

  snapCamera(L) {
    const c = this.cameraFor(L);
    this.camera.position.copy(c.pos);
    this.controls.target.copy(c.target);
    this.camTween = null;
    this.anatCam = this.anat;
    this.controls.update();
  }

  flyCamera(L, dur) {
    const c = this.cameraFor(L);
    this.camTween = {
      start: performance.now(),
      dur,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: c.pos,
      toTarget: c.target,
    };
    this.userCam = false;
  }

  updateCamera(now) {
    const ct = this.camTween;
    if (!ct) return;
    const e = easeInOutCubic(clamp((now - ct.start) / ct.dur, 0, 1));
    this.camera.position.lerpVectors(ct.fromPos, ct.toPos, e);
    this.controls.target.lerpVectors(ct.fromTarget, ct.toTarget, e);
    if (e >= 1) {
      this.camTween = null;
      this.anatCam = this.anat;
    }
  }

  updateRotation(dt, t) {
    const def = VIEWS.find((v) => v.key === this.view);
    const lay = this.layouts[this.view];
    const rotMode = (lay && lay.rot) || def.rot;
    const speed = this.settings.turning && !this.spinHold ? this.settings.rotationSpeed : 0;
    const r = this.group.rotation;
    const k = Math.min(1, dt * 3);
    if (this.intro && this.intro.phase === 'seed') return;
    if (rotMode === 'spinY') {
      this.spinY += dt * speed * 0.3;
      r.y += (this.spinY - r.y) * k;
      r.z += (0 - r.z) * k;
    } else if (rotMode === 'spinZ') {
      this.spinZ -= dt * speed * 0.1;
      r.z += (this.spinZ - r.z) * k;
      r.y += (0 - r.y) * k;
    } else {
      const ty = Math.sin(t * 0.22) * 0.08 * Math.min(1, speed * 2);
      r.y += (ty - r.y) * Math.min(1, dt * 2);
      r.z += (0 - r.z) * k;
    }
  }

  // -------------------------------------------------------------- étiquettes
  setLabels(L, delayMs) {
    if (this.labelSet) {
      const old = this.labelSet;
      old.el.classList.add('c3d-out');
      this.win.setTimeout(() => old.el.remove(), 700);
    }
    const set = {
      el: el('div', `c3d-labelset c3d-ls-${L.key}`, this.labelLayer),
      items: [],
      showAt: this.intro ? Infinity : performance.now() + delayMs,
      flat: L.frame.depth === 0,
      radius: Math.max(L.frame.width, L.frame.height) / 2,
    };
    const big = L.key === 'brain' || L.key === 'molecule';
    for (const lb of L.labels) {
      const d = el('div', `c3d-label c3d-${lb.kind}${lb.autoHide ? ' c3d-autohide' : ''}`, set.el);
      let dot = null;
      if (lb.gi != null && lb.kind !== 'box') dot = el('span', 'c3d-dot', d);
      if (big && lb.kind === 'group') d.style.fontSize = `${(10 + 4 * lb.weight).toFixed(1)}px`;
      el('span', 'c3d-label-t', d, lb.text);
      if (lb.sub) el('span', 'c3d-label-s', d, lb.sub);
      set.items.push({
        lb,
        d,
        dot,
        v: new THREE.Vector3(lb.x, lb.y, lb.z),
        n: lb.n ? new THREE.Vector3(lb.n[0], lb.n[1], lb.n[2]).normalize() : null,
        base: big && lb.kind === 'group' ? 0.5 + 0.5 * lb.weight : 1,
      });
    }
    this.labelSet = set;
    this.updateLabelColors();
  }

  updateLabelColors() {
    const set = this.labelSet;
    if (!set || !this.groupCol) return;
    for (const it of set.items) {
      if (it.lb.gi == null) continue;
      const css = this.groupCss(it.lb.gi);
      if (it.dot) it.dot.style.color = css;
      if (it.lb.kind === 'box') it.d.style.borderColor = css;
    }
  }

  groupCss(gi) {
    const c = this.groupCol;
    const g = gi * 3;
    const m = Math.max(c[g], c[g + 1], c[g + 2], 0.001);
    const f = Math.min(1, 1 / m);
    return `rgb(${Math.round(c[g] * f * 255)}, ${Math.round(c[g + 1] * f * 255)}, ${Math.round(c[g + 2] * f * 255)})`;
  }

  updateLabels(now) {
    const set = this.labelSet;
    if (!set || this.settings.labels === 'off') return;
    const fade = clamp((now - set.showAt) / 700, 0, 1);
    set.el.style.opacity = String(fade);
    if (fade <= 0) return;
    const W = this.width;
    const H = this.height;
    const mw = this.group.matrixWorld;
    const cam = this.camera;
    const camPos = cam.position;
    const tmp = (this._lt = this._lt || new THREE.Vector3());
    const nrm = (this._ln = this._ln || new THREE.Vector3());
    const dir = (this._ld = this._ld || new THREE.Vector3());
    const camDist = camPos.distanceTo(this.controls.target);
    const showAuto = this.settings.labels === 'on';
    const ctr = (this._lc = this._lc || new THREE.Vector3());
    ctr.set(0, 0, 0).applyMatrix4(mw).project(cam);
    const cx = (ctr.x * 0.5 + 0.5) * W;
    const cy = (-ctr.y * 0.5 + 0.5) * H;
    for (const it of set.items) {
      if (it.lb.autoHide && !showAuto) {
        if (it.shown !== false) {
          it.d.style.visibility = 'hidden';
          it.shown = false;
        }
        continue;
      }
      tmp.copy(it.v).applyMatrix4(mw);
      let alpha = it.base;
      if (it.n) {
        nrm.copy(it.n).transformDirection(mw);
        dir.copy(camPos).sub(tmp).normalize();
        alpha *= smoothstep(-0.12, 0.42, nrm.dot(dir));
      } else if (!set.flat) {
        const d = camPos.distanceTo(tmp);
        alpha *= 0.35 + 0.65 * clamp((camDist + set.radius - d) / (2 * set.radius), 0, 1);
      }
      tmp.project(cam);
      if (tmp.z > 1 || alpha < 0.03) {
        if (it.shown !== false) {
          it.d.style.visibility = 'hidden';
          it.shown = false;
        }
        continue;
      }
      if (it.shown !== true) {
        it.d.style.visibility = 'visible';
        it.shown = true;
      }
      const sxn = (tmp.x * 0.5 + 0.5) * W;
      const syn = (-tmp.y * 0.5 + 0.5) * H;
      const sx = sxn.toFixed(1);
      const sy = syn.toFixed(1);
      let tr;
      switch (it.lb.align) {
        case 'right':
          tr = `translate(${sx}px,${sy}px) translate(-100%,-50%)`;
          break;
        case 'left':
          tr = `translate(${sx}px,${sy}px) translate(0,-50%)`;
          break;
        case 'above':
          tr = `translate(${sx}px,${sy}px) translate(-50%,-100%)`;
          break;
        case 'below':
          tr = `translate(${sx}px,${sy}px) translate(-50%,0)`;
          break;
        case 'radial': {
          const a = Math.atan2(syn - cy, sxn - cx);
          tr =
            Math.cos(a) >= 0
              ? `translate(${sx}px,${sy}px) rotate(${a.toFixed(4)}rad) translate(0,-50%)`
              : `translate(${sx}px,${sy}px) rotate(${(a + Math.PI).toFixed(4)}rad) translate(-100%,-50%)`;
          break;
        }
        case 'tilt':
          tr = `translate(${sx}px,${sy}px) rotate(-50deg) translate(-100%,-50%)`;
          break;
        default:
          tr = `translate(${sx}px,${sy}px) translate(-50%,-50%)`;
      }
      it.d.style.transform = tr;
      it.d.style.opacity = alpha.toFixed(3);
    }
  }

  // ------------------------------------------------------------------ intro
  playIntro() {
    if (!this.started) {
      this.wantIntro = true;
      return;
    }
    if (!this.model || !this.model.notes.length || !this.renderer) return;
    const now = performance.now();
    this.stopArp();
    this.view = 'brain';
    this.syncPanels();
    const L = this.layout('brain');
    const N = this.model.notes.length;
    for (let i = 0; i < N; i++) {
      const s = this.model.notes[i].seed;
      for (let c = 0; c < 3; c++) this.cur[i * 3 + c] = (hash01(s, 600 + c) - 0.5) * 0.8;
    }
    for (let i = 0; i < MAX_DUST; i++) {
      for (let c = 0; c < 3; c++) this.dustCur[i * 3 + c] = (hash01(i, 610 + c) - 0.5) * 1.2;
    }
    this.tween = null;
    this.colTween = null;
    this.setDustBody(L);
    this.computeDustColors(L);
    this.noteCol.set(this.noteColTo);
    this.dustCol.set(this.dustColTo);
    this.linkFactor = 0;
    this.sizeMul = 1;
    this.drift = 0;
    this.markDirty();
    this.group.rotation.set(0, 0, 0);
    this.spinY = 0;
    this.spinZ = 0;
    this.userCam = false;
    // Gros plan sur le cerveau, puis la caméra recule pour montrer le corps.
    this.anat = 0;
    this.anatTarget = 0;
    this.snapCamera(L);
    this.setHover(-1);
    this.intro = { phase: 'seed', t0: now };
    this.root.classList.add('c3d-intro-on');
    this.introText.classList.remove('show', 'low');
    this.introText.textContent = t('introDot');
    this.loading.classList.add('show');
    this.setLabels(L, 0);
    this.updateAnswer();
  }

  explode(fast) {
    const it = this.intro;
    if (!it) return;
    it.phase = 'explode';
    it.t1 = performance.now();
    this.introText.classList.remove('show');
    this.startTransition(this.layout('brain'), {
      dur: fast ? 1100 : 2600,
      ease: easeOutExpo,
      stagger: fast ? 0.05 : 0.12,
      arc: 0.12,
    });
    this.flash = 1;
  }

  updateIntro(now) {
    const it = this.intro;
    if (!it) return;
    if (it.phase === 'seed') {
      const e = now - it.t0;
      if (!it.shown && e > 400) {
        this.introText.classList.add('show');
        it.shown = true;
      }
      this.introPulse = 0.9 + 0.22 * Math.sin((e / 1000) * 3.4);
      this.setLoading(Math.min(0.55, e / 5600));
      if (e > 3100) this.explode(false);
    } else if (it.phase === 'explode') {
      const e = now - it.t1;
      this.introPulse += (1 - this.introPulse) * 0.1;
      this.flash = Math.max(0, 1 - e / 900);
      this.setLoading(Math.min(1, 0.55 + (0.45 * e) / 1700));
      if (e > 1900) this.loading.classList.remove('show');
      if (!it.pulled && e > 1700) {
        it.pulled = true;
        this.anatTarget = clamp(this.settings.anatomy, 0, 1);
      }
      if (!it.text2 && e > 2500) {
        this.introText.textContent = t('introCount', { n: fmt(this.model.notes.length) });
        this.introText.classList.add('show', 'low');
        it.text2 = now;
      }
      if (it.text2 && now - it.text2 > 2900) {
        this.introText.classList.remove('show');
        it.phase = 'outro';
        it.t3 = now;
      }
    } else if (it.phase === 'outro' && now - it.t3 > 500) {
      this.finishIntro();
    }
  }

  setLoading(p) {
    const v = Math.round(p * 100);
    if (v !== this._loadingPct) {
      this._loadingPct = v;
      this.loading.textContent = t('loading', { p: v });
    }
  }

  skipIntro() {
    const it = this.intro;
    if (!it) return;
    if (it.phase === 'seed') this.explode(true);
    this.introText.classList.remove('show');
    this.loading.classList.remove('show');
    this.anatTarget = clamp(this.settings.anatomy, 0, 1);
    this.finishIntro();
  }

  finishIntro() {
    this.intro = null;
    this.introPulse = 1;
    this.root.classList.remove('c3d-intro-on');
    this.loading.classList.remove('show');
    if (this.labelSet) this.labelSet.showAt = performance.now() + 300;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      this.refreshData(true);
    }
  }

  // ------------------------------------------------------- survol / clic
  pick() {
    if (!this.model || this.intro || !this.mouse || this.notesAlpha < 0.3) return this.setHover(-1);
    const m = (this._pm = this._pm || new THREE.Matrix4());
    this.group.updateMatrixWorld();
    m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.group.matrixWorld);
    const e = m.elements;
    const W = this.width;
    const H = this.height;
    const mx = this.mouse.x;
    const my = this.mouse.y;
    const c = this.cur;
    const N = this.model.notes.length;
    const only = this.searchActive && this.matchCount > 0;
    let best = -1;
    let bestD = 13 * 13;
    for (let i = 0; i < N; i++) {
      if ((only && !this.match[i]) || this.hidden[i]) continue;
      const x = c[i * 3];
      const y = c[i * 3 + 1];
      const z = c[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 0) continue;
      const sx = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5) * W;
      const sy = ((-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5) * H;
      const d = (sx - mx) * (sx - mx) + (sy - my) * (sy - my);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.setHover(best);
  }

  setHover(i) {
    if (!this.tooltip) return;
    if (i === this.hover) return;
    this.hover = i;
    if (i >= 0 && this.model) {
      const n = this.model.notes[i];
      const g = this.model.groups[n.gi];
      this.tipName.textContent = n.name;
      this.tipSub.textContent = t('tipSub', { folder: g.full, links: t(n.deg > 1 ? 'nLinks' : 'oneLink', { n: fmt(n.deg) }) });
      const c = this.noteColTo;
      const col = [Math.min(1, c[i * 3] * 1.3 + 0.2), Math.min(1, c[i * 3 + 1] * 1.3 + 0.2), Math.min(1, c[i * 3 + 2] * 1.3 + 0.2)];
      this.ringMat.uniforms.uColor.value.setRGB(...col);
      this.tipLine.style.background = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
    }
    this.tooltip.classList.toggle('show', i >= 0);
    this.tipLine.classList.toggle('show', i >= 0);
    if (this.renderer) this.renderer.domElement.style.cursor = i >= 0 ? 'pointer' : '';
  }

  /** Infobulle accrochée au point survolé, avec un petit trait (comme dans la vidéo). */
  placeTooltip() {
    const i = this.hover;
    if (i < 0) return;
    const v = (this._tv = this._tv || new THREE.Vector3());
    v.set(this.cur[i * 3], this.cur[i * 3 + 1], this.cur[i * 3 + 2]).applyMatrix4(this.group.matrixWorld).project(this.camera);
    const sx = (v.x * 0.5 + 0.5) * this.width;
    const sy = (-v.y * 0.5 + 0.5) * this.height;
    const flip = sx > this.width - 300;
    this.tipLine.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) rotate(${flip ? -135 : -45}deg)`;
    const tx = flip ? sx - 13 : sx + 13;
    this.tooltip.style.transform = `translate(${tx.toFixed(1)}px,${(sy - 13).toFixed(1)}px) translate(${flip ? '-100%' : '0'},-100%)`;
  }

  updateRing() {
    // Anneau sur la note survolée, sinon sur la note choisie.
    const i = this.hover >= 0 ? this.hover : this.sel;
    const u = this.ringMat.uniforms.uOpacity;
    u.value += ((i >= 0 ? 0.9 : 0) - u.value) * 0.25;
    if (this.hover < 0 && i >= 0 && this._ringFor !== i) {
      this._ringFor = i;
      const c = this.noteRaw || this.noteColTo;
      this.ringMat.uniforms.uColor.value.setRGB(Math.min(1, c[i * 3] * 1.3 + 0.2), Math.min(1, c[i * 3 + 1] * 1.3 + 0.2), Math.min(1, c[i * 3 + 2] * 1.3 + 0.2));
    } else if (this.hover >= 0) this._ringFor = -1;
    if (i >= 0) {
      const p = this.ring.geometry.attributes.position;
      p.array[0] = this.cur[i * 3];
      p.array[1] = this.cur[i * 3 + 1];
      p.array[2] = this.cur[i * 3 + 2];
      p.needsUpdate = true;
    }
  }

  async openNote(i, evt) {
    const n = this.model && this.model.notes[i];
    if (!n) return;
    const ws = this.app.workspace;
    const mod = evt ? Keymap.isModEvent(evt) : false;
    let leaf;
    if (mod) leaf = ws.getLeaf(mod);
    else leaf = ws.getLeavesOfType('markdown').find((l) => l !== this.leaf) || ws.getLeaf('tab');
    await leaf.openFile(n.file, { active: true });
    if (ws.setActiveLeaf) ws.setActiveLeaf(leaf, { focus: true });
  }

  // -------------------------------------------------------------- recherche
  onSearch() {
    if (!this.model || !this.match) return;
    const q = normalizeText(this.searchInput.value.trim());
    const terms = q.split(/\s+/).filter(Boolean);
    const hl = this.hl && this.hl.mask && this.hl.mask.length === this.model.notes.length ? this.hl : null;
    const active = terms.length > 0 || !!hl;
    let count = 0;
    this.firstMatch = -1;
    this.model.notes.forEach((n, i) => {
      if (!n.norm) n.norm = normalizeText(n.path.replace(/\.md$/i, ''));
      // La note choisie reste visible même si elle est masquée (isolée).
      const ok = active && (!hl || hl.mask[i]) && terms.every((t) => n.norm.includes(t)) && (!this.hidden[i] || i === this.sel);
      this.match[i] = ok ? 1 : 0;
      if (ok) {
        if (this.firstMatch < 0) this.firstMatch = i;
        count++;
      }
    });
    this.notePoints.geometry.attributes.aMatch.needsUpdate = true;
    this.searchActive = active;
    this.searchTarget = active ? 1 : 0;
    this.matchCount = count;
    this.searchCount.textContent = terms.length ? `${fmt(count)}` : '';
    this.searchCount.classList.toggle('is-zero', terms.length > 0 && count === 0);
    this.mouseDirty = true;
    this.updateDustMatch();
    this.syncFolderBar();
  }

  /** Souligne, dans la légende du bas, la catégorie allumée. */
  syncFolderBar() {
    if (!this.folderItems) return;
    const key = this.hl && this.hl.kind === 'cat' ? this.hl.key : null;
    for (const [k, item] of this.folderItems) item.classList.toggle('is-active', k === key);
  }

  onKey(e) {
    if (e.target === this.searchInput || (e.target && e.target.tagName === 'SELECT')) return;
    if (this.intro && (e.key === ' ' || e.key === 'Escape' || e.key === 'Enter')) {
      e.preventDefault();
      this.skipIntro();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = parseInt(e.key, 10);
    if (k >= 1 && k <= VIEWS.length) {
      e.preventDefault();
      this.setView(VIEWS[k - 1].key);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.toggleFocus();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.resetView();
    } else if (e.key === 'Escape' && (this.sel >= 0 || this.hl)) {
      e.preventDefault();
      this.clearHighlight();
    } else if (e.key === 'Escape' && this.focusMode) {
      e.preventDefault();
      this.setFocus(false);
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      this.toggleArp();
    } else if (e.key === '/') {
      e.preventDefault();
      this.searchInput.focus();
    }
  }

  // ------------------------------------------- légende du bas, stats, échelle
  updateFolderBar() {
    const m = this.model;
    const bar = this.folderBar;
    const expanded = bar.classList.contains('is-expanded');
    bar.replaceChildren();
    this.folderItems = new Map();
    if (!m.notes.length) return;
    const mode = this.colorModeEff();
    const cats = CAT_MODES.has(mode) && mode !== 'folder' && this.cats ? this.cats : null;
    const title = cats ? (mode === 'tag' ? t('byTag') : t('bySubfolder')) : t('byFolder');
    el('div', 'c3d-folders-title', bar, title);
    const list = el('div', 'c3d-folders-list', bar);
    const linksOf = (arr) => arr.reduce((s, ni) => s + m.notes[ni].deg, 0);
    const pal = this.palette();
    let items;
    if (cats) {
      items = cats.map((c, ci) => ({
        key: `cat:${mode}:${c.key}`,
        short: c.short,
        full: c.full,
        notes: c.notes,
        css: c.t < 0 ? this.rgbCss(...dustColor(pal)) : this.rgbCss(...samplePalette(pal, c.t)),
        pick: () => this.highlightCategory(mode, ci),
      }));
    } else {
      items = m.groups.map((g) => ({
        key: 'cat:folder:' + g.idx,
        short: g.short,
        full: g.full,
        notes: g.notes,
        css: this.groupCss(g.idx),
        pick: () => this.highlightCategory('folder', g.idx),
      }));
    }
    items.sort((a, b) => b.notes.length - a.notes.length);
    for (const c of items) {
      const it = el('button', 'c3d-fitem', list);
      const l = linksOf(c.notes);
      it.title = t('folderTitle', { name: c.full, n: fmt(c.notes.length), l: fmt(l) });
      el('span', 'c3d-dot', it).style.color = c.css;
      el('span', 'c3d-fname', it, c.short);
      el('span', 'c3d-fnum', it, `${fmt(c.notes.length)} · ${fmt(l)}`);
      it.onclick = c.pick;
      this.folderItems.set(c.key, it);
    }
    const allKey = cats ? (mode === 'tag' ? 'allTags' : 'allSub') : 'allFolders';
    const all = el('button', 'c3d-fitem c3d-fall', list, expanded ? t('fewerItems') : t(allKey, { n: fmt(items.length) }));
    all.onclick = () => {
      bar.classList.toggle('is-expanded');
      all.textContent = bar.classList.contains('is-expanded') ? t('fewerItems') : t(allKey, { n: fmt(items.length) });
    };
    // Deuxième ligne : la mémoire (moelle), du plus ancien au plus récent.
    if (this.view === 'brain' && this.settings.showRecord !== false) {
      const rec = el('div', 'c3d-folders-rec', bar);
      el('span', 'c3d-folders-title', rec, t('spineLegend'));
      el('span', 'c3d-fnum', rec, t('oldest'));
      const strip = el('span', 'c3d-rec-strip', rec);
      const rb = this.settings.recordBy;
      if (rb === 'date' || (rb === 'same' && mode === 'date')) {
        const stops = [0, 0.25, 0.5, 0.75, 1].map((x) => this.rgbCss(...timeColor(pal, x)));
        strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
      } else {
        // Couleurs des notes dans l'ordre du temps.
        const order = m.timeOrder;
        const col = rb === 'folder' ? this.folderCol : this.noteRaw;
        const stops = [];
        for (let k = 0; k <= 12; k++) {
          const ni = order[Math.min(order.length - 1, Math.floor((k / 12) * (order.length - 1)))];
          const gi = rb === 'folder' ? m.notes[ni].gi : ni;
          stops.push(this.rgbCss(col[gi * 3], col[gi * 3 + 1], col[gi * 3 + 2]));
        }
        strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
      }
      el('span', 'c3d-fnum', rec, t('newest'));
    }
    if (expanded) bar.classList.add('is-expanded');
    this.syncFolderBar();
  }

  updateWordStat() {
    if (!this.statWords || !this.model) return;
    const { words, missing } = wordTotals(this.model);
    this.statWords.textContent = fmt(words) + (missing ? '…' : '');
    this.statWords.title = missing ? t('counting', { n: fmt(missing) }) : '';
  }

  async loadWords() {
    if (this.loadingWords) {
      this.wordsAgain = true;
      return;
    }
    this.loadingWords = true;
    try {
      do {
        this.wordsAgain = false;
        const cache = this.plugin.wordCache;
        const todo = this.model.notes.filter((n) => !cache.has(n.path)).map((n) => n.file);
        let k = 0;
        for (const f of todo) {
          if (this.destroyed) return;
          try {
            cache.set(f.path, countWords(await this.app.vault.cachedRead(f)));
          } catch (e) {
            cache.set(f.path, 0);
          }
          if (++k % 80 === 0) {
            this.updateWordStat();
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        this.updateWordStat();
        // La fiche et le panneau « Toi » affichent des nombres de mots.
        if (todo.length && ['profile', 'note'].includes(this.sideKey())) renderSide(this);
      } while (this.wordsAgain && !this.destroyed);
    } finally {
      this.loadingWords = false;
    }
  }

  /** Bornes du dégradé quand la couleur suit la date, la taille ou les liens. */
  updateScale() {
    const m = this.model;
    const s = this.settings;
    const el2 = this.scaleEl;
    if (!el2 || !m) return;
    el2.replaceChildren();
    const mode = this.colorModeEff();
    if (CAT_MODES.has(mode) || !m.notes.length) {
      el2.style.display = 'none';
      return;
    }
    el2.style.display = '';
    let a = '';
    let b = '';
    if (mode === 'date') {
      const f = (d) => dayToDate(d).toLocaleDateString(getLang() === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'short' });
      a = f(m.dayList[0]);
      b = f(m.dayList[m.dayList.length - 1]);
    } else if (mode === 'size') {
      a = fmtBytes(m.minSize);
      b = fmtBytes(m.maxSize);
    } else {
      a = t('zeroLinks');
      b = t('nLinks', { n: fmt(m.maxDeg) });
    }
    el('span', null, el2, a);
    el('span', null, el2, b);
  }

  // ------------------------------------------------------------------ boucle
  loop(now) {
    if (this.destroyed) return;
    this.raf = this.win.requestAnimationFrame(this.loopBound);
    // Filet de sécurité : si la taille n'a pas été transmise (onglet ouvert en arrière-plan), on la relit.
    if ((!this.width || !this.height) && this.stage.clientWidth && this.stage.clientHeight) this.onResize();
    if (!this.width || !this.height || !this.model) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    const t = now / 1000;

    this.updateIntro(now);
    this.updateArp(now);
    let moved = this.updateTween(now);
    // Le flux coule en continu.
    if (this.view === 'flow') {
      this.flowPhase += dt * this.flowSpeed();
      if (!this.tween && !this.intro) {
        const L = this.layout('flow');
        if (L.flow) {
          flowPositions(L, this.flowPhase, this.cur, 1);
          this.notePoints.geometry.attributes.position.needsUpdate = true;
          moved = true;
        }
      }
    }
    // Curseur Anatomie : la caméra suit en douceur.
    this.anat += (this.anatTarget - this.anat) * Math.min(1, dt * (this.intro ? 1.5 : 4));
    if (this.view === 'brain' && !this.userCam && !this.camTween && Math.abs(this.anat - this.anatCam) > 0.0005) {
      this.snapCamera(this.layout('brain'));
    }
    this.updateColors(now);
    this.updateRotation(dt, t);
    const s = this.settings;
    this.group.scale.setScalar(1 + 0.018 * s.breathing * Math.sin(t * 0.9));
    this.searchVal += (this.searchTarget - this.searchVal) * Math.min(1, dt * 6);
    // Interrupteurs Notes / Mémoire et curseur Silhouette : fondus doux.
    const kf = Math.min(1, dt * 5);
    this.notesAlpha += ((s.showNotes === false ? 0 : 1) - this.notesAlpha) * kf;
    this.recAlpha += ((s.showRecord === false ? 0 : 1) - this.recAlpha) * kf;
    this.scaffoldVal += (clamp(s.scaffold, 0, 1) - this.scaffoldVal) * kf;
    this.notePoints.visible = this.notesAlpha > 0.01;

    for (const mat of [this.noteMat, this.dustMat]) {
      const u = mat.uniforms;
      u.uTime.value = t;
      u.uBreath.value = s.breathing;
      u.uDrift.value = this.drift * (0.4 + 0.6 * s.breathing);
      u.uAlpha.value = (1 + this.flash * 0.9) * s.brightness;
    }
    this.noteMat.uniforms.uAlpha.value *= this.notesAlpha;
    this.noteMat.uniforms.uSize.value = s.pointSize * this.sizeMul * this.introPulse;
    this.noteMat.uniforms.uSearch.value = this.searchVal;
    this.dustMat.uniforms.uSize.value = (0.6 + 0.4 * s.pointSize) * (0.75 + 0.25 * this.sizeMul) * this.introPulse;
    this.dustMat.uniforms.uSearch.value = this.searchVal;
    this.dustMat.uniforms.uSearchFloor.value = this.hl ? 0.16 : 0.3;
    this.dustMat.uniforms.uAlpha.value *= 0.55 + 0.45 * s.dust;
    this.dustMat.uniforms.uBody.value = smoothstep(0.06, 0.7, this.anat) * this.scaffoldVal;
    this.dustMat.uniforms.uRecord.value = this.recAlpha;
    // Lueur autour des notes : mêmes points, trois fois plus grands, très transparents.
    const glow = clamp(s.glow == null ? 0.5 : s.glow, 0, 1);
    const gu = this.glowMat.uniforms;
    this.glowPoints.visible = glow > 0.01 && this.notesAlpha > 0.01;
    for (const k of ['uTime', 'uBreath', 'uDrift', 'uScale', 'uSearch']) gu[k].value = this.noteMat.uniforms[k].value;
    gu.uSize.value = this.noteMat.uniforms.uSize.value * 3.4;
    gu.uAlpha.value = this.noteMat.uniforms.uAlpha.value * 0.16 * glow;
    // Enveloppe en fil de fer : seulement sur le cerveau, quand le corps est visible, jamais pendant une transition.
    const wantShell = this.view === 'brain' && !this.tween ? 1 : 0;
    this.shellAlpha += (wantShell - this.shellAlpha) * Math.min(1, dt * (wantShell ? 2.5 : 8));
    if (this.shellLines) {
      this.shellMat.opacity = 0.085 * this.shellAlpha * smoothstep(0.06, 0.7, this.anat) * this.scaffoldVal * Math.min(1.2, s.brightness);
      this.shellLines.visible = this.shellMat.opacity > 0.002;
    }
    // Squelette et nerfs : curseur Squelette, avec le corps (Body) et sur la forme Cerveau seulement.
    this.skelVal = this.skelVal == null ? clamp(s.skeleton == null ? 0.7 : s.skeleton, 0, 1) : this.skelVal;
    this.skelVal += (clamp(s.skeleton == null ? 0.7 : s.skeleton, 0, 1) - this.skelVal) * kf;
    const skelBody = smoothstep(0.06, 0.7, this.anat) * this.skelVal;
    this.dustMat.uniforms.uSkel.value = skelBody;
    if (this.skelLines) {
      this.skelMat.opacity = 0.22 * this.shellAlpha * skelBody * Math.min(1.2, s.brightness);
      this.skelLines.visible = this.skelMat.opacity > 0.003;
    }
    this.linkMat.opacity =
      this.intro || !s.links
        ? 0
        : s.linkOpacity * 0.22 * this.linkFactor * (1 - 0.85 * this.searchVal) * Math.min(1, s.brightness) * this.notesAlpha;
    this.linkLines.visible = this.linkMat.opacity > 0.002;
    // Fibres lumineuses : seulement sur le cerveau, une fois la forme posée.
    const wantFib = this.view === 'brain' && !this.tween && !this.intro && s.links ? 1 : 0;
    this.fiberAlpha = this.fiberAlpha || 0;
    this.fiberAlpha += (wantFib - this.fiberAlpha) * Math.min(1, dt * (wantFib ? 2 : 8));
    if (this.fiberLines) {
      // Plusieurs teintes qui s'additionnent virent vite au blanc : plus discret qu'en une seule couleur.
      const fibBase = this.colorModeEff() === 'mono' ? 0.13 : 0.05;
      this.fiberMat.opacity =
        fibBase * this.fiberAlpha * Math.min(1.2, s.brightness) * this.notesAlpha * (1 - 0.85 * this.searchVal) * (0.4 + 0.6 * clamp(s.linkOpacity * 2.5, 0, 1));
      this.fiberLines.visible = this.fiberMat.opacity > 0.003;
    }
    const linesShown = this.linkLines.visible || (this.fiberLines && this.fiberLines.visible);
    if (moved && linesShown) this.updateLinkPositions();
    else if (moved) this.linksStale = true;
    if (linesShown && this.linksStale) {
      this.updateLinkPositions();
      this.linksStale = false;
    }

    this.updateBeads(dt, t);
    this.updateClouds(dt);
    this.updateCamera(now);
    this.controls.update();
    if (this.mouseDirty || (moved && this.mouse)) {
      this.mouseDirty = false;
      this.pick();
    }
    this.updateRing();
    this.renderer.render(this.scene, this.camera);
    this.placeTooltip();
    this.updateLabels(now);
  }

  destroy() {
    if (this.destroyed) return;
    this.setFocus(false);
    this.destroyed = true;
    if (this.raf && this.win) this.win.cancelAnimationFrame(this.raf);
    if (this.refreshSoon) this.refreshSoon.cancel();
    if (this.relayoutSoon) this.relayoutSoon.cancel();
    if (this.ro) this.ro.disconnect();
    if (this.controls) this.controls.dispose();
    for (const o of [this.notePoints, this.dustPoints, this.linkLines, this.ring, this.beads, this.shellLines, this.fiberLines, this.skelLines]) if (o) o.geometry.dispose();
    for (const m of [this.noteMat, this.dustMat, this.linkMat, this.ringMat, this.beadMat, this.glowMat, this.shellMat, this.fiberMat, this.skelMat]) if (m) m.dispose();
    if (this.cloudTex) this.cloudTex.dispose();
    if (this.cloudGroup) for (const c of this.cloudGroup.children) c.material.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.contentEl.replaceChildren();
  }
}
