import type { App, Plugin } from 'obsidian';
import { PluginSettingTab, Setting } from 'obsidian';
import L from './i18n';
import type { ISetting } from './types';

export const defaultSettings = {
  max: 0,
  mode: 'default',
  scrollBehaviour: 'smooth',
  theme: 'flat',
  showIcon: true,
  autoShowFileName: true,
  showInStatusBar: false,
  boundaryOffset: '0px',
  fontSize: 12,
  desktopTopOffset: 0,
  mobileTopOffset: 0,
  desktopLeftOffset: 0,
  mobileLeftOffset: 0,
} satisfies ISetting;

interface IStickyHeadingsPlugin extends Plugin {
  settings: ISetting;
  onSettingChanged: () => void;
  saveSettings: () => Promise<void>;
}

export default class StickyHeadingsSetting extends PluginSettingTab {
  plugin: IStickyHeadingsPlugin;

  constructor(app: App, plugin: IStickyHeadingsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private ensureSettings(): ISetting {
    return this.plugin.settings;
  }

  update(data: ISetting) {
    this.plugin.settings = { ...this.plugin.settings, ...data };
    void this.plugin.saveSettings();
    this.plugin.onSettingChanged();
  }

  display(): void {
    const settings = this.ensureSettings();
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName(L.setting.mode.title())
      .setDesc(L.setting.mode.description())
      .addDropdown(dropdown => {
        dropdown.addOption('default', L.setting.mode.default());
        dropdown.addOption('concise', L.setting.mode.concise());
        dropdown.addOption('disable', L.setting.mode.disable());
        dropdown.setValue(settings.mode);
        dropdown.onChange(value => {
          this.update({
            ...this.plugin.settings,
            mode: value as 'default' | 'concise',
          });
          this.display();
        });
      });
    if (settings.mode !== 'disable') {
      new Setting(containerEl)
        .setName(L.setting.max.title())
        .setDesc(L.setting.max.description())
        .addText(text => {
          text.setValue(settings.max.toString());
          text.onChange(value => {
            this.update({
              ...this.plugin.settings,
              max: parseInt(value, 10) || 0,
            });
          });
        });
      new Setting(containerEl)
        .setName(L.setting.fontSize.title())
        .setDesc(L.setting.fontSize.description())
        .addSlider(slider => {
          slider.setLimits(12, 20, 1);
          slider.setDynamicTooltip();
          slider.setValue(settings.fontSize);
          slider.onChange(value => {
            this.update({
              ...this.plugin.settings,
              fontSize: value,
            });
          });
        });
      new Setting(containerEl)
        .setName(L.setting.desktopTopOffset.title())
        .setDesc(L.setting.desktopTopOffset.description())
        .addSlider(slider => {
          slider.setLimits(0, 100, 1);
          slider.setDynamicTooltip();
          slider.setValue(settings.desktopTopOffset);
          slider.onChange(value => {
            this.update({
              ...this.plugin.settings,
              desktopTopOffset: value,
            });
          });
        });
      new Setting(containerEl)
        .setName(L.setting.mobileTopOffset.title())
        .setDesc(L.setting.mobileTopOffset.description())
        .addSlider(slider => {
          slider.setLimits(0, 100, 1);
          slider.setDynamicTooltip();
          slider.setValue(settings.mobileTopOffset);
          slider.onChange(value => {
            this.update({
              ...this.plugin.settings,
              mobileTopOffset: value,
            });
          });
        });
      new Setting(containerEl)
        .setName(L.setting.desktopLeftOffset.title())
        .setDesc(L.setting.desktopLeftOffset.description())
        .addSlider(slider => {
          slider.setLimits(0, 200, 1);
          slider.setDynamicTooltip();
          slider.setValue(settings.desktopLeftOffset);
          slider.onChange(value => {
            this.update({
              ...this.plugin.settings,
              desktopLeftOffset: value,
            });
          });
        });
      new Setting(containerEl)
        .setName(L.setting.mobileLeftOffset.title())
        .setDesc(L.setting.mobileLeftOffset.description())
        .addSlider(slider => {
          slider.setLimits(0, 200, 1);
          slider.setDynamicTooltip();
          slider.setValue(settings.mobileLeftOffset);
          slider.onChange(value => {
            this.update({
              ...this.plugin.settings,
              mobileLeftOffset: value,
            });
          });
        });
    }
    new Setting(containerEl)
      .setName(L.setting.scrollBehaviour.title())
      .setDesc(L.setting.scrollBehaviour.description())
      .addDropdown(dropdown => {
        dropdown.addOption('smooth', L.setting.scrollBehaviour.smooth());
        dropdown.addOption('instant', L.setting.scrollBehaviour.instant());
        dropdown.setValue(settings.scrollBehaviour);
        dropdown.onChange(value => {
          this.update({
            ...this.plugin.settings,
            scrollBehaviour: value as ScrollBehavior,
          });
        });
      });
    if (settings.mode !== 'disable') {
      new Setting(containerEl).setName(L.setting.theme.title()).addDropdown(dropdown => {
        dropdown.addOption('flat', 'flat');
        dropdown.addOption('blur', 'blur');
        dropdown.addOption('float', 'float');
        dropdown.setValue(settings.theme);
        dropdown.onChange(value => {
          this.update({
            ...this.plugin.settings,
            theme: value,
          });
        });
      });
    }
    if (settings.mode !== 'disable') {
      new Setting(containerEl)
        .setName(L.setting.indicators.title())
        .setDesc(L.setting.indicators.description())
        .addToggle(toggle => {
          toggle.setValue(settings.showIcon);
          toggle.onChange(value => {
            this.update({
              ...this.plugin.settings,
              showIcon: value,
            });
          });
        });
    }
    if (settings.mode !== 'disable') {
      new Setting(containerEl)
        .setName(L.setting.autoShowFileName.title())
        .setDesc(L.setting.autoShowFileName.description())
        .addToggle(toggle => {
          toggle.setValue(settings.autoShowFileName);
          toggle.onChange(value => {
            this.update({
              ...this.plugin.settings,
              autoShowFileName: value,
            });
          });
        });
    }
    new Setting(containerEl).setName(L.setting.showInStatusBar()).addToggle(toggle => {
      toggle.setValue(settings.showInStatusBar);
      toggle.onChange(value => {
        this.update({
          ...this.plugin.settings,
          showInStatusBar: value,
        });
      });
    });
    if (settings.mode !== 'disable') {
      new Setting(containerEl)
        .setName(L.setting.boundaryOffset.title())
        .setDesc(L.setting.boundaryOffset.description())
        .addText(text => {
          text.setValue(settings.boundaryOffset);
          text.onChange(value => {
            const isValid = /^-?\d+(%|px)$/.test(value);
            if (isValid) {
              this.update({
                ...this.plugin.settings,
                boundaryOffset: value,
              });
            }
          });
        });
    }
  }
}
