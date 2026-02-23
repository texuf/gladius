New Project Flow
================

Trigger: Ctrl+N on the project selection screen.

Phase 1: Embedded Terminal
--------------------------
1. Store sets addingProject = true.
2. ProjectSelection detects this via useEffect, sets terminalActive = true.
3. The entire project list view is replaced with the EmbeddedTerminal component.
4. A PTY shell spawns at $HOME via Bun.spawn with the terminal option.
5. Raw stdin listener attaches -- all keystrokes go directly to the PTY shell.
6. xterm-headless parses PTY output. A 30fps render loop converts the buffer
   to ANSI strings displayed as Ink <Text> elements.
7. Footer shows "Esc Cancel" instead of the normal project shortcuts.

The user interacts with a real shell -- cd, ls, git clone, etc.

Phase 2: Esc to Capture
------------------------
1. 100ms timeout confirms the keypress is a bare Esc (not an arrow key
   escape sequence).
2. lsof reads the shell process's current working directory.
3. PTY is killed, stdin listener removed, xterm disposed.
4. onExit(cwd) fires. ProjectSelection sets capturedPath to the shell's cwd
   and terminalActive to false.
5. View switches to confirmation bar:
   "Add project at: /path/to/dir" with "Enter Add / Esc Cancel".

Phase 3a: Enter to Confirm
---------------------------
1. handleAddProject(capturedPath) runs.
2. addProject() in db.ts validates the path exists and has a .git directory.
3. Creates the project record in SQLite.
4. Refreshes the project list, resets all add-project state.

Phase 3b: Esc to Cancel
------------------------
Everything resets back to the project list.

Error Handling
--------------
If PTY allocation fails (e.g. system out of PTY devices), the terminal
is not shown. Instead an error message appears with "Esc Cancel".
The user can free PTY devices by closing unused terminal tabs or rebooting.

Key Files
---------
- src/components/EmbeddedTerminal.tsx  -- PTY spawn, xterm rendering, Esc detection
- src/views/ProjectSelection.tsx       -- two-phase state machine (terminal -> confirm -> create)
- src/components/HotkeyHints.tsx       -- contextual footer hints
- src/services/db.ts                   -- addProject() validation and SQLite insert
