// Default settings (saved in the plugin's data.json).

export const DEFAULT_SETTINGS = {
  language: 'en', // en | fr
  view: 'brain',
  colorMode: 'folder', // folder | subfolder | tag | date | size | links
  recordBy: 'same', // same | folder | date  (colour of the record = the spinal cord)
  palette: 'defaut', // defaut | lave | ocean | foret | aurore | matrice | celeste | braise | soleil
  theme: 'original', // original | minuit | graphite | pin | prune | braise
  brightness: 1,
  pointSize: 1,
  dust: 0.75,
  links: true,
  linkOpacity: 0.35,
  signals: true,
  signalSpeed: 1,
  clouds: false,
  quality: 'max', // fast | high | max
  turning: true,
  rotationSpeed: 0.35,
  breathing: 0.5,
  labels: 'auto', // auto | on | off
  hideIsolated: false,
  anatomy: 1,
  scaffold: 0.3, // faint body around the spinal cord (0 = none)
  showNotes: true,
  showRecord: true,
  wheelStyle: 'slices', // slices | clock
  intro: true,
  showPanel: true,
  showNav: true,
  navOpen: false, // folder navigator column
  side: '', // '' | numbers | timeline | you  (right column)
  clickOpens: false, // true = a click opens the note directly instead of showing its card
  splitFolders: '', // top-level folders whose subfolders count as separate folders, comma-separated
};

/** Brings older saved settings (v1 / v2 beta) up to date without losing anything. */
export function migrateSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  if (raw && raw.showNames === false && !raw.labels) s.labels = 'off';
  if (raw && raw.split === false) s.splitFolders = '';
  if (raw && raw.showStats && !raw.side) s.side = 'numbers';
  if (s.language !== 'fr') s.language = 'en';
  if (!['', 'numbers', 'timeline', 'you'].includes(s.side)) s.side = '';
  if (!['same', 'folder', 'date'].includes(s.recordBy)) s.recordBy = 'same';
  delete s.showNames;
  delete s.showSettings;
  delete s.split;
  delete s.showStats;
  return s;
}
