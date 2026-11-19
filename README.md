# Axon Mind

An Obsidian plugin that shows every note in your vault as a 3D particle cloud (three.js):
a brain on a glowing spinal cord made of your notes in time order, plus molecule, grid, curve, wheel, flow
and lifelines, with animated transitions.
English by default, French available (*Français disponible* : View panel → Language).

## Install

### Option 1 — with BRAT (easiest, auto-updates)

1. In Obsidian: Settings → Community plugins → Browse → install and enable **BRAT**.
2. Command palette (Ctrl/Cmd + P) → **BRAT: Add a beta plugin for testing**.
3. Paste this and confirm:

   ```
   Lord-Yoxo/axon-mind
   ```

4. Settings → Community plugins → enable **Axon Mind**.

### Option 2 — manually

1. Download `axon-mind-<version>.zip` from the [latest release](https://github.com/Lord-Yoxo/axon-mind/releases/latest) and unzip it.
2. Put the `axon-mind` folder (with `manifest.json`, `main.js`, `styles.css` inside) in
   `<your vault>/.obsidian/plugins/` — the `.obsidian` folder is hidden: show hidden files if needed.
3. Restart Obsidian (or Settings → Community plugins → reload), turn off Restricted mode if asked,
   then enable **Axon Mind**.

Open it with the brain icon in the ribbon, or the command palette → "Axon Mind: Open Axon Mind".

## What you get

- **Intro**: every note collapses into a single point ("It all starts with an idea"), "Loading your vault… %",
  an explosion into a close-up of the brain, the camera pulls back to reveal the body, then "<n> ideas later.".
  Click or press Esc to skip.
- **7 forms** (View panel → Form, or keys 1–7):
  1. **Brain**: notes form the brain (one region per folder) on a long glowing spinal cord — the **record**:
     every note in time order, the oldest at the tip, the newest under the brain, bigger notes brighter.
     A faint body (**Scaffold** slider) can be shown around it. The Anatomy slider goes from brain only to full
     view; the Notes and Record switches show or hide each part.
  2. **Molecule**: one atom per folder, notes in shells, [[links]] as lines, boxed labels.
  3. **Grid**: one block of points per folder, names on the left.
  4. **Curve**: a filled wave of points per day of modification (log scale: the peak stands out, small days
     stay visible), tilted dates, folders on the right.
  5. **Wheel**: two styles (View panel → Wheel style): **Slices** — one coloured slice per folder, filled with
     its notes, names around, the wheel turns; **Clock** — one ring per folder, the time of modification goes
     around the dial.
  6. **Flow**: each note flows from its folder to the folder it links to most.
  7. **Lifelines**: one line per folder; each note lives from its first to its last known date, arcs link the
     days the folder changed.
  Each form shows a question and its answer computed from your vault.
- **LARP** (top left, or key L): cycles through the 7 forms, 2 seconds each, on a loop — made for filming.
- **Focus** (top left, or key F): Axon Mind fills the whole Obsidian window. Click again, F or Esc to go back.
- **Reset view** (or key R): puts the camera back after zooming or rotating.
- **Signals**: glowing beads travel along the links between notes, like nerve impulses.
- **Menu** (left): Brain, Navigator, Numbers, Timeline, You. The ☰ button hides it; a red dot shows the view
  is live (amber while it updates), with what is lit in the brain and a **Clear** link.
- **Navigator**: your folder tree with counts; click a folder to light its notes in the brain, unfold it to
  see its notes, click a note to open its card.
- **Note card** (click a point): title, folder, dates, words, an excerpt, tags, **Open the note**, **Focus in
  the brain** (the camera flies to it and stops turning) and its linked notes; the note and its neighbours
  light up. Double-click or Ctrl/Cmd + click opens the note directly (or turn on "Click opens the note" in the
  plugin settings).
- **Timeline** ("When you wrote"): one bar per day, week or month — notes created and edited; click a bar to
  light those notes (and their part of the spinal cord). "Labels over time" stacks the bars by folder or tag.
  While it is open, the brain is coloured by date (red = old, green = recent).
- **Numbers**: notes, links, folders, words, isolated notes, biggest folders, most linked note.
- **You**: how many of your notes are linked, words written, busiest day, favourite weekday and hour, hubs,
  short notes and notes without links (one click lights them).
- Hover a point: note name. Drag: rotate. Scroll: zoom. Right-drag: pan. Search with `/`, Enter opens the card
  of the first match. Esc clears what is lit.
- Bottom: legend (by folder, subfolder or tag — notes · links); click one to light it. Under it, the record's
  colours from oldest to newest.
- **View panel** (right): colour theme, brightness, quality, **Notes by** folder / subfolder / tag / date /
  size / links, **Record by** same as notes / folder / date, 9 palettes, form, anatomy, Notes / Record switches,
  Scaffold, **split into subfolders** (pick which folders count each subfolder as its own folder), labels,
  hide isolated notes, rotation, speed, breathing, links, signals, clouds, dust, point size, language, intro.
- The view updates by itself when a note is created, edited, renamed or deleted.

## Build from source

Sources live in `src/`. `main.js` is generated (it bundles three.js, MIT licence):

```
npm install
npm run build
```
