# Gladius - Terminal Task Orchestrator

## Overview

Gladius is a terminal-based task orchestration application for managing multiple AI-assisted development workflows in parallel. It provides a heads-up-display style interface for managing projects, tasks, git worktrees, and LLM coding sessions (Claude, Codex) with real-time status tracking and notifications.

**Philosophy:** A video game HUD for developers — fast UI switching, real-time status, keyboard-driven everything.

---

## Technical Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | **Bun** | Fast TypeScript runtime, built-in watch mode |
| UI Framework | **Ink 6.x** (React for CLI) | Terminal UI rendering via React components |
| Terminal Emulation | **xterm-headless** | In-memory VT100/ANSI terminal state machine |
| PTY Management | **node-pty** | Spawn and manage pseudo-terminal sessions |
| Layout Engine | **Yoga** (via Ink) | Flexbox layout for terminal |
| Keyboard Protocol | **Kitty keyboard protocol** | Cmd+key detection (requires Ghostty/Kitty/WezTerm/iTerm2) |
| Storage | **SQLite** (via `better-sqlite3` or `bun:sqlite`) | Task state, session metadata, project registry |
| Language | **TypeScript** (strict mode) | Type safety throughout |

### Terminal Requirement

Gladius requires a terminal that supports the **Kitty keyboard protocol** for Cmd+key shortcuts. Recommended: **Ghostty** (`brew install --cask ghostty`). Also supported: Kitty, WezTerm, iTerm2.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Gladius App                     │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ View     │  │ State    │  │ Session       │ │
│  │ Manager  │  │ Store    │  │ Manager       │ │
│  │ (React)  │  │ (Zustand)│  │ (node-pty)    │ │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘ │
│       │              │                │         │
│  ┌────┴──────────────┴────────────────┴───────┐ │
│  │            Ink Renderer                     │ │
│  │  ┌─────────────────────────────────────┐   │ │
│  │  │  TerminalPane (xterm-headless)      │   │ │
│  │  │  - Parses PTY output → virtual buf  │   │ │
│  │  │  - Renders buffer → Ink <Text>      │   │ │
│  │  │  - Forwards keystrokes → PTY        │   │ │
│  │  └─────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Git      │  │ Worktree │  │ Notification  │ │
│  │ Monitor  │  │ Manager  │  │ Engine        │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │            SQLite (bun:sqlite)              │ │
│  │  ~/.gladius/gladius.db                      │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Key Modules

1. **View Manager** — React component tree managing view transitions (Project List → Task List → Task View)
2. **State Store** — Zustand store for app state (active project, active task, view stack, focus state)
3. **Session Manager** — Manages PTY lifecycle for claude/codex sessions, bookkeeps session IDs for resume
4. **TerminalPane** — Custom Ink component: node-pty ↔ xterm-headless ↔ Ink `<Text>` rendering pipeline
5. **Git Monitor** — Polls git status for branch info, commit diffs, file counts (runs in background)
6. **Worktree Manager** — Creates/deletes git worktrees, copies .env files, manages branch naming
7. **Notification Engine** — Watches all active tasks for status changes, emits color-coded notifications

---

## Data Model

### Storage Location

```
~/.gladius/
├── gladius.db          # SQLite database
├── logs/               # Application logs
└── config.json         # User preferences (optional)
```

### Database Schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,           -- UUID
  name TEXT NOT NULL,            -- Directory name relative to ~
  path TEXT NOT NULL UNIQUE,     -- Absolute path on disk
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,           -- UUID
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,           -- Auto-generated label (e.g., "fix-auth-0223")
  description TEXT NOT NULL,     -- User-entered description
  status TEXT NOT NULL DEFAULT 'active',  -- active | closed
  model TEXT,                    -- 'claude' | 'codex' | NULL (not yet selected)
  session_id TEXT,               -- LLM session ID for resume
  worktree_path TEXT,            -- Absolute path to worktree
  branch_name TEXT,              -- Git branch name
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,      -- 'created' | 'started' | 'paused' | 'closed' | 'reopened'
  metadata TEXT,                 -- JSON blob
  created_at TEXT NOT NULL
);
```

---

## Views & Navigation

### Global Keyboard Shortcuts

These work from **any view**:

| Key | Action |
|-----|--------|
| `Cmd+Shift+0` | Return to Project Selection view |
| `Cmd+Shift+N` | Add new project (directory picker) |
| `Cmd+N` | Create new task (in current project context) |
| `Cmd+P` | Return to Task List view (current project) |
| `Cmd+Shift+P` | Open task switcher (fuzzy search across all tasks) |
| `Cmd+Q` | Quit Gladius |

### View 1: Project Selection

**Trigger:** App launch (if no projects) or `Cmd+Shift+0`

```
┌─ GLADIUS ──────────────────────────────────────────┐
│                                                     │
│  Projects                          Cmd+Shift+N: New │
│  ─────────                                          │
│  ▸ gladius              3 tasks  ●2 ●1              │
│    api-server            5 tasks  ●3 ●1 ●1          │
│    frontend-app          2 tasks  ●2                 │
│                                                     │
│                                                     │
│  ↑↓ Navigate  ⏎ Select  Cmd+Shift+N New Project    │
└─────────────────────────────────────────────────────┘
```

- `↑/↓` — Navigate project list
- `Enter` — Select project → go to Task List view
- `Cmd+Shift+N` — Open directory picker (text input for path, with tab completion)
- Project name = directory name relative to `~` (e.g., `~/github/gladius` → `github/gladius`, displayed as `gladius` with full path on hover/focus)
- Status dots show aggregate task status counts: green/red/orange

### View 2: Task List

**Trigger:** Select a project from Project Selection

```
┌─ gladius ─────────────────────────────── ●1 ●2 ●1 ─┐
│                                                      │
│  Tasks                                    Cmd+N: New │
│  ─────                                               │
│  ▸ fix-auth-0223                              ● ●    │
│    "Fix authentication bug in login flow"            │
│    ae/fix-auth-0223 (+2/-0) [-3] 2 files             │
│                                                      │
│    add-search-0222                            ●      │
│    "Add full-text search to API"                     │
│    ae/add-search-0222 (+5/-1) [-8] 4 files           │
│                                                      │
│    refactor-db-0221                           ●      │
│    "Refactor database layer to use..."               │
│    ae/refactor-db-0221 (+0/-0) [-12] 0 files         │
│                                                      │
│  ↑↓ Navigate  ⇧↑↓ Reorder  ⏎ Open  x Close        │
│  Cmd+N New  Cmd+⇧P Search  Cmd+⇧0 Projects          │
└──────────────────────────────────────────────────────┘
```

Each task entry shows (multi-line):
- **Line 1:** Label + status indicator dots
- **Line 2:** First 50 chars of description (quoted)
- **Line 3:** Git status line: `branch (+ahead/-behind_remote) [-behind_main] N files`

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate tasks |
| `Shift+↑/↓` | Reorder task (swap with neighbor) |
| `Enter` | Open task → Task View |
| `x` | Close task (with confirmation modal) |
| `Cmd+N` | Create new task |

### View 3: Task View

**Trigger:** Select a task from Task List

```
┌─ fix-auth-0223 ── ae/fix-auth-0223 (+2/-0) [-3] 2 files ── ●1 ●2 ─┐
│ ╔═══════════════════════════════════════════════════════════════════╗ │
│ ║ Fix authentication bug in login flow. The JWT refresh token     ║ │
│ ║ is not being properly validated on the server side, causing...  ║ │
│ ╚═══════════════════════════════════════════════════════════════════╝ │
│ ┌─ Terminal ──────────────────────────────────────────── t: focus ─┐ │
│ │ $ npm run test                                                   │ │
│ │ PASS src/auth.test.ts                                            │ │
│ │ PASS src/token.test.ts                                           │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌─ Console (claude) ──────────────────────────────────── c: focus ─┐ │
│ │                                                                   │ │
│ │ Claude: I've analyzed the authentication flow and found the       │ │
│ │ issue in src/auth/validateToken.ts. The refresh token...          │ │
│ │                                                                   │ │
│ │ > _                                                               │ │
│ │                                                                   │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│  i: Edit notes  t: Terminal  c: Console  Esc: Back  x: Close       │
└─────────────────────────────────────────────────────────────────────┘
```

**Layout:**
- **Header bar** — Task label, branch status, notification dots
- **Notes pane** (top, 20%) — Task description, editable
- **Terminal pane** (middle, 15%) — General purpose terminal (tests, builds, etc.)
- **Console pane** (bottom, ~65%) — LLM session (claude or codex)
- **Footer** — Context-sensitive hotkey hints

**Pane Focus Behavior:**

| Key | Action |
|-----|--------|
| `i` | Edit description (inline edit mode in notes pane) |
| `t` | Focus terminal pane (keystrokes forwarded to PTY) |
| `c` | Focus console pane (see model selection below) |
| `Esc` | Return focus to task view (unfocus panes), or go back to task list if already unfocused |
| `x` | Close task (confirmation modal) |

**Model Selection (first time `c` is pressed):**

If no model has been selected for this task yet, pressing `c` does nothing. Instead:
- `cl` — Select Claude, start a claude session, focus console pane
- `co` — Select Codex, start a codex session, focus console pane

After model is selected, `c` directly focuses the console pane.

### View 4: Task Switcher (Cmd+Shift+P)

**Trigger:** `Cmd+Shift+P` from any view

```
┌─ Switch Task ──────────────────────────────────────┐
│ > search query_                                     │
│                                                     │
│ Current Project: gladius                             │
│  ▸ fix-auth-0223  "Fix authentication bug in..." ●● │
│    add-search-0222 "Add full-text search to..."  ●  │
│                                                     │
│ Other Projects:                                      │
│    api-server / migrate-db-0220 "Migrate dat..." ●  │
│    frontend / dark-mode-0219 "Implement dark..." ●● │
│                                                     │
│  ↑↓ Navigate  ⏎ Switch  Esc Cancel                 │
└────────────────────────────────────────────────────┘
```

- Empty input lists all tasks, ranked: current project first, then other projects by last accessed
- Typing filters/searches across label and description
- Each entry shows: label, first 30 chars of description, status dots
- Tasks from other projects show project name prefix
- `Enter` switches to selected task
- `Esc` dismisses switcher

---

## Task Lifecycle

### Creating a Task (`Cmd+N`)

1. **Input description** — Modal text input: "Enter task description:"
2. **Generate label** — Heuristic: extract key words from description, append date
   - `"Fix authentication bug in login flow"` → `fix-auth-0223`
   - Algorithm: take first verb + first noun, lowercase, hyphenate, append MMDD
   - If collision, append `-2`, `-3`, etc.
3. **Create branch** — `ae/{label}` (user's initials prefix, configurable)
4. **Create worktree** — `git worktree add <worktree-path> -b ae/{label}`
   - Worktree location: `{project-root}/.gladius/worktrees/{label}/`
5. **Copy .env files** — Recursively find all `.env*` files in project root, copy to worktree maintaining relative paths
6. **Save to DB** — Insert task record with status=active, worktree_path, branch_name
7. **Navigate** — Auto-open the new task in Task View

### Closing a Task (`x`)

1. **Confirmation modal** — "Close task '{label}'? This will delete the worktree. Enter to confirm, Esc to cancel."
2. On confirm:
   - **Stop LLM session** — Kill the PTY process for claude/codex
   - **Save session ID** — Record the session ID in DB for potential reopen
   - **Delete worktree** — `git worktree remove <path> --force` then `git worktree prune`
   - **Update DB** — Set status=closed, closed_at=now
   - **Navigate** — Return to Task List view

### Reopening a Task

1. From Task List, closed tasks appear in a separate "Closed" section (collapsed by default)
2. Selecting a closed task and pressing `Enter` reopens it:
   - **Create new worktree** — Same branch (if still exists), new worktree path
   - **Copy .env files** — Same as creation
   - **Resume LLM session** — Use saved session_id:
     - Claude: `claude --resume <session_id>`
     - Codex: `codex resume <session_id>`
   - **Update DB** — Set status=active, closed_at=NULL, update worktree_path

---

## Terminal Pane Implementation

### Rendering Pipeline

```
node-pty (PTY) ──→ xterm-headless (parse ANSI) ──→ Ink <Text> (render)
     ↑                                                    │
     └──────────── keyboard input ←───────────────────────┘
```

1. **Spawn PTY** via `node-pty.spawn(shell, args, { cols, rows, cwd })`
2. **Feed output** to `xterm-headless` Terminal instance: `terminal.write(data)`
3. **Read buffer** from xterm's screen buffer: iterate rows, extract cells with attributes (fg, bg, bold, etc.)
4. **Render to Ink** — Convert each cell to `<Text color={fg} backgroundColor={bg} bold={bold}>char</Text>`
5. **Forward input** — When pane is focused, capture keystrokes via Ink's `useInput` and write to PTY: `pty.write(data)`
6. **Resize handling** — On terminal resize, update PTY dimensions: `pty.resize(cols, rows)` and xterm: `terminal.resize(cols, rows)`

### Rendering Optimization

- **Dirty tracking** — Only re-render rows that changed since last frame
- **Throttled rendering** — Cap at 30fps for terminal output (avoid flooding React reconciler)
- **Viewport scrolling** — Only render visible rows from xterm's buffer
- **Batch writes** — Accumulate PTY output and flush to xterm in batches

---

## LLM Session Management

### Claude Sessions

```typescript
interface ClaudeSession {
  taskId: string;
  sessionId: string | null;  // null until first session starts
  status: 'idle' | 'running' | 'paused' | 'finished' | 'needs_input';
}
```

**Starting:** `claude` (new session) in the task's worktree directory
**Resuming:** `claude --resume <sessionId>` or `claude --continue` (if same directory)
**Session ID capture:** Parse claude's output for session identifiers, or use `claude --resume` picker to list sessions

### Codex Sessions

```typescript
interface CodexSession {
  taskId: string;
  sessionId: string | null;
  status: 'idle' | 'running' | 'paused' | 'finished' | 'needs_input';
}
```

**Starting:** `codex` (new session) in the task's worktree directory
**Resuming:** `codex resume <sessionId>` or `codex resume --last`

### Session Status Detection

Monitor PTY output to detect status changes:
- **needs_input** — Detect prompt patterns (waiting for user input)
- **finished** — Detect exit/completion patterns or process exit
- **running** — PTY is producing output
- **paused** — PTY process exists but no recent output

This drives the notification system (red = needs_input/finished, orange = running, green = PR green).

---

## Notification System

### Status Indicators

Displayed as colored dots in the header/notification area. Visible from Task View and Task List.

| Color | Meaning | Trigger |
|-------|---------|---------|
| 🟢 Green | PR is green, no comments | GitHub PR status check (poll or webhook) |
| 🔴 Red | Needs attention | LLM asked a question, LLM finished, PR has new comments |
| 🟠 Orange | Working | LLM is actively producing output |

### Notification Bar (Task View)

When working on a task, other active tasks' statuses appear as compact indicators in the header:

```
●2 ●1 ●3    ← 2 green, 1 red, 3 orange across all other tasks
```

Pressing a notification indicator (or a dedicated hotkey) could expand to show which tasks need attention.

### Status Polling

- **Git status** — Poll every 5 seconds: `git status --porcelain`, `git rev-list` for ahead/behind counts
- **LLM status** — Monitor PTY output in real-time, detect patterns
- **PR status** — Poll GitHub API every 60 seconds via `gh pr status` (if `gh` CLI available)

---

## Git Status Line Format

Displayed in Task View header and Task List entries:

```
ae/fix-auth-0223 (+5/-4) [-15] 3 files
│                  │  │    │    │
│                  │  │    │    └─ Files with changes (unstaged + staged + untracked new/deleted)
│                  │  │    └────── Local main is 15 commits behind origin/main
│                  │  └─────────── origin/ae/fix-auth-0223 has 4 new commits since last sync
│                  └────────────── Local branch is 5 commits ahead of last sync with origin
└───────────────────────────────── Branch name
```

### Calculation

```bash
# Ahead/behind remote tracking branch
git rev-list --left-right --count ae/fix-auth-0223...origin/ae/fix-auth-0223

# Behind main
git rev-list --count HEAD..origin/main

# Changed files
git status --porcelain | wc -l
```

---

## Hot Reload & Crash Resistance

### Hot Reload Strategy

Use Bun's `--watch` mode for development:

```bash
bun --watch run src/index.tsx
```

- File changes trigger process restart
- **State persistence** — On restart, reload state from SQLite (all PTY sessions are re-attachable via session IDs)
- **Graceful shutdown** — SIGTERM handler saves current view state, focused pane, scroll positions to SQLite
- **Startup recovery** — On launch, detect if previous session crashed and restore last view state

### Crash Resistance

1. **Error boundaries** — React error boundaries around each view and pane component. A crashed pane doesn't take down the app.
2. **PTY isolation** — Each terminal pane runs in its own PTY. A crashed child process doesn't affect the parent.
3. **State checkpointing** — Periodic SQLite writes (every 10 seconds) of volatile state
4. **Watchdog** — If the Ink renderer throws, catch at top level, log error, attempt re-render
5. **Safe imports** — Dynamic imports for non-critical modules with try/catch

### Self-Building Safety

Since Gladius will be used to build itself:
- The running instance reads from the **installed/built** version
- Edits happen in a **worktree** (separate directory)
- Hot reload only triggers on the development copy
- A catastrophic build failure in the worktree doesn't affect the running instance
- Keep a known-good built version as fallback: `~/.gladius/bin/gladius-stable`

---

## Directory Structure

```
gladius/
├── specs/
│   └── SPEC.md                    # This file
├── src/
│   ├── index.tsx                  # Entry point, Ink render
│   ├── app.tsx                    # Root App component, view router
│   ├── store/
│   │   ├── index.ts               # Zustand store
│   │   └── types.ts               # State types
│   ├── views/
│   │   ├── ProjectSelection.tsx   # View 1
│   │   ├── TaskList.tsx           # View 2
│   │   ├── TaskView.tsx           # View 3
│   │   └── TaskSwitcher.tsx       # View 4 (modal overlay)
│   ├── components/
│   │   ├── TerminalPane.tsx       # PTY + xterm-headless renderer
│   │   ├── NotesPane.tsx          # Editable text area
│   │   ├── StatusBar.tsx          # Git status + notifications
│   │   ├── HotkeyHints.tsx        # Context-sensitive hotkey display
│   │   ├── ConfirmModal.tsx       # Confirmation dialog
│   │   └── TextInput.tsx          # Text input component
│   ├── services/
│   │   ├── db.ts                  # SQLite operations
│   │   ├── git.ts                 # Git operations (status, worktree, branch)
│   │   ├── session.ts             # LLM session management
│   │   ├── worktree.ts            # Worktree create/delete/env copy
│   │   └── notifications.ts      # Status polling and notification logic
│   └── utils/
│       ├── label.ts               # Task label generation heuristic
│       ├── keyboard.ts            # Kitty protocol key parsing
│       └── constants.ts           # Config constants
├── package.json
├── tsconfig.json
├── bunfig.toml
└── .gitignore
```

---

## Dependencies

### Core
```json
{
  "ink": "^6.0.0",
  "react": "^18.0.0",
  "ink-text-input": "^6.0.0",
  "zustand": "^5.0.0",
  "node-pty": "^1.0.0",
  "@xterm/headless": "^5.0.0",
  "better-sqlite3": "^11.0.0",
  "uuid": "^10.0.0"
}
```

### Dev
```json
{
  "typescript": "^5.0.0",
  "@types/react": "^18.0.0",
  "@types/better-sqlite3": "^7.0.0"
}
```

---

## Configuration

### User Config (`~/.gladius/config.json`)

```json
{
  "branchPrefix": "ae",
  "defaultShell": "/bin/zsh",
  "gitPollIntervalMs": 5000,
  "prPollIntervalMs": 60000,
  "renderFpsCap": 30,
  "worktreeLocation": ".gladius/worktrees"
}
```

### Per-Project (`.gladius/` in project root)

The `.gladius/worktrees/` directory lives inside each project root and contains worktree checkouts. This directory should be added to the project's `.gitignore`.

---

## Implementation Phases

### Phase 1: Foundation
- Project scaffolding (Bun + TypeScript + Ink)
- SQLite database setup and migrations
- Basic Ink app shell with view routing
- Keyboard input handling (Kitty protocol)
- Project Selection view (add/list/select projects)

### Phase 2: Task Management
- Task List view with multi-line task entries
- Task creation flow (description → label → worktree → env copy)
- Task reordering (shift+arrow)
- Task close flow with confirmation modal
- Git status line calculation and display

### Phase 3: Terminal Panes
- TerminalPane component (node-pty + xterm-headless + Ink rendering)
- Task View layout (notes + terminal + console, proper sizing)
- Pane focus management (i/t/c/Esc)
- Notes pane editing

### Phase 4: LLM Session Management
- Claude session start/stop/resume
- Codex session start/stop/resume
- Model selection flow (cl/co on first use)
- Session ID bookkeeping in SQLite

### Phase 5: Notifications & Status
- LLM status detection from PTY output
- Notification dot rendering
- PR status polling (via `gh` CLI)
- Git monitor background polling

### Phase 6: Task Switcher & Polish
- Cmd+P task switcher with fuzzy search
- Task reopening flow
- Hot reload and crash recovery
- Performance optimization (dirty tracking, throttling)
- Self-building safety mechanisms

---

## Open Questions / Future Considerations

1. **Branch prefix configuration** — Currently hardcoded to `ae`. Should be configurable at project or global level.
2. **Multiple LLM sessions per task** — Current spec assumes one. Could support switching models mid-task.
3. **Task templates** — Pre-configured task types (bug fix, feature, refactor) with different defaults.
4. **Remote sync** — Sync task state across machines (currently local-only).
5. **Plugin system** — Allow custom notification sources, status checks, or actions.
6. **PR creation** — Integrate `gh pr create` directly from the task view.
7. **Task dependencies** — Allow tasks to block/depend on each other.
8. **Split console** — Allow multiple terminal panes or resize ratios.
