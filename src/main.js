// Axon Mind — your whole vault as a 3D particle cloud (brain, molecule, grid, curve, wheel, flow, lifelines).

import { Plugin, PluginSettingTab, Setting } from 'obsidian';
import { AxonView, VIEW_TYPE } from './view.js';
import { VIEWS } from './layouts.js';
import { migrateSettings } from './settings.js';
import { setLang, t } from './i18n.js';
import { debounce } from './util.js';

export default class AxonPlugin extends Plugin {
  async onload() {
    this.settings = migrateSettings(await this.loadData());
    setLang(this.settings.language);
    this.wordCache = new Map();
    this.saveSettingsSoon = debounce(() => this.saveData(this.settings), 500);

    this.registerView(VIEW_TYPE, (leaf) => new AxonView(leaf, this));
    this.addRibbonIcon('brain-circuit', t('open'), () => this.activateView());

    this.addCommand({ id: 'open', name: t('open'), callback: () => this.activateView() });
    this.addCommand({
      id: 'replay-intro',
      name: t('replayIntro'),
      callback: async () => {
        const v = await this.activateView();
        if (v) v.playIntro();
      },
    });
    this.addCommand({
      id: 'larp',
      name: t('larpCmd'),
      callback: async () => {
        const v = await this.activateView();
        if (v) v.toggleArp();
      },
    });
    this.addCommand({
      id: 'toggle-focus',
      name: t('cmdFocus'),
      callback: async () => {
        const v = await this.activateView();
        if (v) v.toggleFocus();
      },
    });
    this.addCommand({
      id: 'reset-view',
      name: t('resetView'),
      callback: async () => {
        const v = await this.activateView();
        if (v) v.resetView();
      },
    });
    for (const v of VIEWS) {
      this.addCommand({
        id: `view-${v.key}`,
        name: t('viewCmd', { name: t('view.' + v.key) }),
        callback: async () => {
          const view = await this.activateView();
          if (view) view.setView(v.key);
        },
      });
    }
    this.addSettingTab(new AxonSettingTab(this.app, this));
  }

  onunload() {
    if (this.saveSettingsSoon) this.saveSettingsSoon.cancel();
  }

  views() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v) => v instanceof AxonView);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view instanceof AxonView ? leaf.view : null;
  }
}

class AxonSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName(t('language'))
      .setDesc(t('settingLanguageDesc'))
      .addDropdown((d) =>
        d
          .addOption('en', 'English')
          .addOption('fr', 'Français')
          .setValue(s.language)
          .onChange((v) => {
            s.language = v;
            setLang(v);
            this.plugin.saveSettingsSoon();
            for (const view of this.plugin.views()) view.relocalize();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t('settingSplitName'))
      .setDesc(t('settingSplitDesc'))
      .addText((txt) =>
        txt
          .setPlaceholder('LihFolk, Projects')
          .setValue(s.splitFolders)
          .onChange((v) => {
            s.splitFolders = v;
            this.plugin.saveSettingsSoon();
            this.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName(t('introOnLaunch'))
      .setDesc(t('settingIntroDesc'))
      .addToggle((tg) =>
        tg.setValue(s.intro).onChange((v) => {
          s.intro = v;
          this.plugin.saveSettingsSoon();
          for (const view of this.plugin.views()) view.syncSettingsUI();
        })
      );

    new Setting(containerEl)
      .setName(t('clickOpens'))
      .setDesc(t('settingClickDesc'))
      .addToggle((tg) =>
        tg.setValue(!!s.clickOpens).onChange((v) => {
          s.clickOpens = v;
          this.plugin.saveSettingsSoon();
        })
      );

    new Setting(containerEl).setName(t('settingOther')).setDesc(t('settingOtherDesc'));
  }

  refreshViews() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const view of this.plugin.views()) {
        view.refreshData(true);
        view.updateSplitList();
      }
    }, 600);
  }
}
