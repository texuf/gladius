# Gladius

Terminal task orchestrator for managing parallel AI-assisted development workflows. A video game HUD for developers — fast UI switching, real-time status, keyboard-driven everything.

## Requirements

- [Bun](https://bun.sh) runtime
- Any terminal emulator (see supported terminals below)

### Supported Terminals

All shortcuts work with both **Ctrl** and **Cmd** modifiers. Ctrl works in any terminal. Cmd requires a terminal with [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) support.

| Terminal | Ctrl shortcuts | Cmd shortcuts | Notes |
|----------|---------------|---------------|-------|
| Terminal.app | Yes | No | macOS built-in, works with Ctrl |
| [Ghostty](https://ghostty.org) | Yes | Yes | Recommended — full Kitty protocol, excellent performance |
| [Kitty](https://sw.kovidgoyal.net/kitty/) | Yes | Yes | The original Kitty protocol implementation |
| [WezTerm](https://wezfurlong.org/wezterm/) | Yes | Yes | Cross-platform, Lua-configurable |
| [iTerm2](https://iterm2.com) | Yes | Yes | macOS only, requires v3.5+ for Cmd support |
| Alacritty | Yes | No | No Kitty protocol support |

## Setup

```bash
bun install
```

## Run

```bash
bun run src/index.tsx
```

Or with watch mode for development:

```bash
bun --watch run src/index.tsx
```

## Keyboard Shortcuts

### Global

| Key | Action |
|-----|--------|
| `Ctrl/Cmd+Shift+0` | Return to Project Selection |
| `Ctrl/Cmd+Shift+N` | Add new project |
| `Ctrl/Cmd+N` | Create new task |
| `Ctrl/Cmd+P` | Return to Task List |
| `Ctrl/Cmd+Shift+P` | Open Task Switcher |
| `Ctrl/Cmd+Q` | Quit |

### Project Selection

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate |
| `Enter` | Select project |

### Task List

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate |
| `Shift+↑/↓` | Reorder tasks |
| `Enter` | Open task |
| `x` | Close task |

### Task View

| Key | Action |
|-----|--------|
| `i` | Edit notes |
| `t` | Focus terminal pane |
| `c` | Focus console pane |
| `cl` | Select Claude (first selection) |
| `co` | Select Codex (first selection) |
| `l` | Switch to Claude |
| `o` | Switch to Codex |
| `Esc` | Unfocus pane / go back |
| `x` | Close task |
