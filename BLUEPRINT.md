---
title: Obsidian Sticky Headings (No Flicker)
one_liner: Community-maintained fork of the Obsidian Sticky Headings plugin focused on eliminating flicker and keeping the codebase stable.
status: active
updated: 2026-11-13
discord_channel: https://discord.com/channels/1526462398872158329
---

## Where it stands

- Fork of Zhou Hua's Sticky Headings plugin; goal is flicker-free sticky headers with no major feature changes planned.
- v2.4.1 shipped with an offset-invariant gate, lazy re-inits, gated warns, and timeout-aware signatures.
- Sticky bar re-syncs after offset-shifting pastes without scroll (dirty-flag offset-deferred leaves, offset gate re-opened after timeout commits).
- Shared heading core adopted, with owner claim + resolve hook.

## Log

### 2026-11-10 — Paste re-sync + shared core

Sticky bar re-syncs after offset-shifting pastes even without a scroll: dirty-flag offset-deferred leaves, with the offset gate re-opened after timeout commits. Also adopted the shared heading core (owner claim + resolve hook).

https://discord.com/channels/1526462398872158329/1569394102376595467

### 2026-10-21 — 2.4.1 hardening

Offset-invariant gate, lazy re-inits, gated warns, and timeout-aware signatures released as 2.4.1.

### 2026-10-17 — Slider saga + debug tooling

Slider works again via imperative sticky-top writes even when Svelte reactive updates are poisoned; plugin survives lazy-plugins/hot-reload lifecycles with stale-view rebinding. Added an append-only debug trace with build stamp and heartbeat, plus a saga retrospective on why the slider bug took five rounds.
