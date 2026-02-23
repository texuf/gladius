New Task Flow
=============

Trigger: Ctrl+N on the tasks view (requires an active project).

Step 1: Open Modal
------------------
1. app.tsx useInput catches input "n" with modifier key.
2. Since view is "tasks" (not "projects") and activeProject exists,
   it calls setModal({ type: "newTask" }).
3. TaskList.tsx renders a TextInputField overlay with:
   - Label: "Enter task description:"
   - Placeholder: "e.g., Fix authentication bug in login flow"
   - Footer: "Enter Submit  Esc Cancel"

Step 2: User Submits Description
--------------------------------
1. User types a description and presses Enter.
2. InkTextInput calls onSubmit, which triggers handleCreateTask(description).
3. UI sets creating = true, blocking further keyboard input.

Step 3: Generate Label
----------------------
File: src/utils/label.ts

1. generateLabel(description) produces a short slug:
   - Lowercase, strip non-alphanumeric characters.
   - Extract first verb from a known VERBS set (fix, add, update, etc.).
   - Extract first meaningful noun (non-verb, non-skip-word).
   - Append date as MMDD.
   - Example: "Fix authentication bug in login flow" -> "fix-auth-0223".
2. deduplicateLabel(label, existingLabels) appends -2, -3, etc. if needed.

Step 4: Create Git Worktree
----------------------------
File: src/services/worktree.ts

1. createWorktree(projectPath, label) runs:
   - mkdir -p {projectPath}/.gladius/worktrees/
   - git -C {projectPath} worktree add {worktreePath} -b ae/{label}
2. copyEnvFiles(projectPath, worktreePath) copies all .env* files
   from the project root into the worktree (max depth 3, skipping
   node_modules, .git, .gladius, dist, build).
3. Returns the absolute worktree path.

Step 5: Insert Database Records
-------------------------------
File: src/services/db.ts

1. Get MAX(sort_order) from existing tasks for this project.
2. INSERT INTO tasks with:
   - id: new UUID
   - project_id: from activeProject
   - label: generated slug
   - description: user's input
   - status: "active"
   - model, session_id: null (Phase 1)
   - worktree_path: from createWorktree
   - branch_name: "ae/{label}"
   - sort_order: max + 1
   - created_at, last_accessed_at: now
   - closed_at: null
3. addTaskEvent(taskId, "created") inserts a row into task_events.

Step 6: Navigate to Task View
------------------------------
1. reloadTasks() fetches fresh task list from DB.
2. setModal(null) closes the modal.
3. setActiveTask(task) sets the newly created task.
4. setView("taskView") navigates to the 3-pane editor
   (notes / terminal / console).

Error Handling
--------------
If any step fails (worktree creation, DB insert), the error is logged
to console. creating is always reset to false in a finally block.
User-facing error display is planned for Phase 2.

Key Files
---------
- src/app.tsx                  -- Ctrl+N routing based on current view
- src/views/TaskList.tsx       -- handleCreateTask orchestration
- src/components/TextInput.tsx -- TextInputField modal component
- src/utils/label.ts           -- generateLabel, deduplicateLabel
- src/utils/constants.ts       -- BRANCH_PREFIX ("ae"), WORKTREE_DIR
- src/services/worktree.ts     -- createWorktree, copyEnvFiles
- src/services/db.ts           -- createTask, addTaskEvent, getTasksForProject
