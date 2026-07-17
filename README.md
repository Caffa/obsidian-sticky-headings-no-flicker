# Obsidian Sticky Headings (No Flicker)

> [!IMPORTANT]
>
> This is a community-maintained fork of [Zhou Hua's](https://github.com/zhouhua) excellent [Sticky Headings](https://github.com/zhouhua/obsidian-sticky-headings) plugin. The primary goal is to fix the flickering issue and keep the codebase stable. No major feature changes are planned beyond ensuring a smooth, reliable experience.

![GitHub Release](https://img.shields.io/github/v/release/zhouhua/obsidian-sticky-headings?include_prereleases&style=flat) ![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/zhouhua/obsidian-sticky-headings/total?style=flat)

> [!NOTE]
>
> It wasn't until I was about to release this plugin that I discovered there's already a plugin with similar functionality in the Obsidian Plugin Market: [Obsidian Sticky Heading](https://github.com/imshenshen/obsidian-sticky-heading). I mean no offense and have no intention of duplicating work. It seems that we just happened to have the same idea and wanted to solve the same problem. The truth is, after seeing the Sticky Scroll feature in the VS Code editor, I found it incredibly useful. For the past six months, I’ve been wanting to bring this feature to the Obsidian world.
>
> In terms of implementation, these two plugins are entirely different (there's no possibility of plagiarism), and each has its unique features. Obsidian users can choose whichever suits them better. Additionally, I have a few small suggestions:
>
> * The imshenshen/obsidian-sticky-heading plugin, by default, only displays the current heading, making it more streamlined compared to my version. In my plugin, the concise mode is equivalent to the prevToH1 mode in imshenshen/obsidian-sticky-heading. Therefore, users who prefer a more minimalist appearance might choose the imshenshen/obsidian-sticky-heading plugin.
> * My plugin offers good support for both editing and reading modes, so users who need functionality in reading mode as well can opt for my version.

## Overview

The Sticky Headings plugin for Obsidian enhances your writing and reading experience by keeping the current content's heading levels displayed, providing better orientation and progress tracking. By clicking on the displayed headings, you can quickly scroll to the corresponding section in your note.

## Installation

1. Install the `Sticky Headings (No Flicker)` plugin via the Obsidian Community Plugins marketplace.
2. Enable the plugin via the Obsidian Settings under the "Community Plugins" section.
3. Configure the plugin parameters as needed through the settings UI.

> Alternatively, you can install the original `Another Sticky Headings` by Zhou Hua if you prefer the mainline version.

## Features

### Default Mode

![Default Mode](./screenshots/defaultMode.gif)

In default mode, the heading of the current content, the ancestor headings of the current heading, and the sibling headings (that appeared previously) of these headings will all be displayed. The benefit of this approach is that it allows us to better understand what content has already been covered while editing or reading the note.

### Concise Mode

![Concise Mode](./screenshots/conciseMode.gif)

In concise mode, only the heading of the current content and the ancestor headings of the current heading will be displayed, resulting in a more streamlined presentation. The benefit of this approach is that it allows us to quickly understand the position of the current content within the overall note, enabling us to focus more on the task at hand.

### Quick Jump

![Quick Jump](./screenshots/quickJump.gif)

The headings that are fixed at the top of the note are all clickable. By clicking on them, you can quickly scroll the note to the corresponding section.

### More

![More](./screenshots/more.gif)

Supports both editing and reading modes, as well as multi-column layouts.

## Community Showcase

Here are some custom styles from the community. Thanks for the creative ideas and contributions!

* [Colorful and floating right](https://gist.github.com/Aiuanyu/8539a8425435406ea79cbc64eaea6082)
* ...

## Change Log

### 2.1.4 (No Flicker fork)

* Forked from Zhou Hua's original project.
* Original author: Zhou Hua. This fork maintained by Pamela.
* No major feature changes — this fork focuses on fixing the flickering issue and maintaining a stable, reliable experience.
