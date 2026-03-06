VPS Project Implementation Spec
===============================

Purpose
-------
Translate `specs/vps-discovery.spec` into an implementation plan that fits the
current Gladius architecture with minimal disruption.

Primary outcome:
- support SSH-backed projects that can discover repos, create tasks/worktrees,
  run task terminals, run task consoles, and report remote status
- preserve the current local UX and SQLite-first state model

Non-Goals for Initial Implementation
------------------------------------
- full remote transcript parsing for Claude/Codex
- SSH key management UI
- password prompt UI
- project-specific runtime checks beyond a small dependency check set
- mixed local/remote repos inside one project
- remote bootstrap automation

Architecture Strategy
---------------------
Do not fork the app into separate local and remote modes.
Instead:
- extend the project model with backend metadata
- route repo/task operations through a backend layer
- keep the app state, navigation, and SQLite storage local
- prefer remote shell command execution over protocol-specific libraries

This allows the existing code paths to stay recognizable while replacing direct
local shell/fs assumptions with backend-aware helpers.

Implementation Phases
---------------------
Phase 1: Project backend metadata and command runner
- add backend columns to `projects`
- introduce project backend resolver helpers
- introduce SSH command execution helpers
- add unified `New Project` flow with backend selection
- support remote dependency checks at project level

Phase 2: Remote repo discovery and project-level shell
- make project refresh backend-aware
- add SSH-backed project shell in Project View
- allow repo discovery in remote base dir
- add repo records using remote paths

Phase 3: Remote task/worktree lifecycle
- make worktree creation/removal backend-aware
- create tasks for remote repos
- store remote worktree paths in tasks
- preserve label/branch conventions

Phase 4: Remote task terminal + console
- run task terminal over SSH in remote worktree
- run Claude/Codex over SSH in remote worktree
- ensure status refresh can use pane capture for remote tasks
- add immediate status updates on console exit/focus changes

Phase 5: Backend-aware git/PR flows
- remote git status
- remote push/fetch/worktree commands
- remote Create PR
- remote PR Issues / PR comments / thread resolution

Phase 6: Offline and degraded-mode UX
- grey status dots when remote backend is unavailable
- pause refresh without mutating repo/task metadata
- surface clear action errors for unreachable projects/tasks

Database Changes
----------------
Current project model stores:
- id
- name
- path
- timestamps

Add columns to `projects`:
- `backend_kind TEXT NOT NULL DEFAULT 'local'`
- `backend_target TEXT`
- `backend_base_path TEXT`
- `backend_display_name TEXT`

Recommended semantics:
- local project
  - `path` remains the local path
  - `backend_kind = 'local'`
  - `backend_target = NULL`
  - `backend_base_path = path`
- ssh project
  - `path` remains a display/storage field but should equal remote base path for compatibility
  - `backend_kind = 'ssh'`
  - `backend_target = <ssh target>`
  - `backend_base_path = <remote base path>`

Type updates:
- extend `Project` in `src/store/types.ts`
- add `ProjectBackendKind = 'local' | 'ssh'`

Migration plan:
1. add new project columns with defaults
2. backfill all existing projects as `local`
3. set `backend_base_path = path` for existing rows
4. keep `path` populated to reduce blast radius in existing UI code

Backend Abstractions
--------------------
Add a new service, for example:
- `src/services/projectBackend.ts`

Proposed types:
- `ProjectBackendKind`
- `ResolvedProjectBackend`
- `RunCommandOptions`
- `BackendRunResult`
- `DependencyCheckResult`

Proposed interface:
- `resolveProjectBackend(projectOrRepoOrTask)`
- `runBackendCommand(backend, command, options)`
- `openBackendShellCommand(backend, cwd)`
- `discoverBackendRepos(backend)`
- `checkBackendDependencies(backend)`
- `isBackendReachable(backend)`

Do not start with a class hierarchy.
Simple discriminated unions and helper functions are enough.

Command Execution Model
-----------------------
For local backends:
- preserve current `bun $` / shell execution

For SSH backends:
- execute commands via `ssh`
- prefer command shape:
  - `ssh <target> "cd <cwd> && <command>"`
- for interactive shells:
  - `ssh -t <target> "cd <cwd> && exec \$SHELL -l"`

Important implementation detail:
- centralize shell escaping in one place
- avoid building remote commands ad hoc in many files

Recommended helpers:
- `quoteShell(value: string)`
- `buildRemoteCommand(cwd: string, command: string)`
- `buildSshExecArgs(target: string, remoteCommand: string)`

Connection Reuse
----------------
Initial version:
- use plain `ssh`
- no mandatory ControlMaster logic in Gladius

Optional later improvement:
- add internal support for a Gladius-managed control socket
- keep this behind helpers so call sites do not care

Unified New Project Flow
------------------------
Files likely touched:
- `src/app.tsx`
- `src/views/RepoSelection.tsx`
- `src/components/TextInput.tsx`
- `src/services/db.ts`

Recommended UX state machine:
1. Trigger `New Project`
2. Modal step: backend selection
   - local
   - ssh
3. If local:
   - current local create-project behavior
4. If ssh:
   - step 1: SSH target input
   - step 2: test connection
   - step 3: remote base path input
   - step 4: validate/create remote path
   - step 5: insert project record

Do not overload the existing one-field input overlay.
Implement a dedicated multi-step flow for project creation.

Project View Changes
--------------------
Files likely touched:
- `src/views/ProjectView.tsx`
- `src/components/HotkeyHints.tsx`

Add remote project cues:
- badge or label for `REMOTE`
- show `backend_target`
- show `backend_base_path`

Add actions:
- `Check Dependencies`
- project refresh uses backend-aware repo discovery
- project shell opens local shell for local projects, SSH shell for SSH projects

Dependency Check Design
-----------------------
Add a project-level action, likely in `ProjectView`.

Checks for phase 1:
- git
- gh
- claude
- codex
- shell availability
- optionally bun

Implementation approach:
- for local: use `command -v`
- for remote: SSH and run `command -v`

Result model:
- tool name
- status: ok | missing | warning
- requiredFor: repo | pr | llm | optional
- detail text
- checkedAt

UI can be simple:
- modal or pane with rows like `git OK`, `gh missing`

Repo Discovery Changes
----------------------
Files likely touched:
- `src/services/db.ts`
- `src/views/RepoSelection.tsx`
- `src/views/ProjectView.tsx`

Current repo refresh is local filesystem traversal.
For SSH projects, replace with remote traversal command.

Recommended first implementation:
- run a remote `find` command scoped to the project base path
- detect `.git` dirs and emit repo roots
- normalize and sort results locally after capture

Be conservative with remote traversal depth to avoid expensive scans.

New helper:
- `discoverRemoteGitRepos(target, basePath): Promise<string[]>`

Repo records for SSH projects should store:
- `path = remote absolute path`
- existing `project_id` semantics unchanged

Task Creation and Worktrees
---------------------------
Files likely touched:
- `src/services/worktree.ts`
- `src/views/TaskList.tsx`
- `src/views/AdoptBranch.tsx`
- `src/views/AdoptCommit.tsx`

Current worktree functions assume local paths and local git.
Refactor them into backend-aware variants.

Recommended API change:
- current:
  - `createWorktree(projectPath, label)`
  - `deleteWorktree(projectPath, worktreePath, branchName)`
- proposed:
  - `createWorktree(repoOrBackend, label)`
  - `deleteWorktree(repoOrBackend, worktreePath, branchName)`

Remote worktree convention:
- default root: `~/.wt/<repo>/<label>`
- derive `<repo>` from repo name or basename(repo.path)

Remote `.env` copying:
- keep the current behavior conceptually
- implement via remote shell commands instead of local fs APIs

Terminal and Console Execution
------------------------------
Files likely touched:
- `src/components/TerminalPane.tsx`
- `src/components/EmbeddedTerminal.tsx`
- `src/services/sessionCapture.ts`

Key requirement:
- `EmbeddedTerminal` should not care whether the spawned command is local or SSH-backed
- `TerminalPane` should ask backend helpers for the command/cwd semantics

Project shell:
- SSH-backed projects use `ssh -t ...` shell in base path

Task terminal:
- SSH-backed tasks use `ssh -t ...` shell in remote worktree

Task console:
- SSH-backed tasks run `claude` or `codex` remotely
- session persistence is therefore remote by nature

Remote LLM Status
-----------------
For phase 1, do not block on remote transcript parsing.
Use pane capture as the primary source for remote LLM state.

Implementation recommendation:
- extend the task-status logic so remote tasks can rely on pane markers first
- if transcript files become backend-aware later, merge them in as a secondary signal

This is aligned with recent fixes already made in local status heuristics.

Git and PR Operations Refactor
------------------------------
Files likely touched:
- `src/services/git.ts`
- `src/views/CreatePr.tsx`
- `src/views/PrComments.tsx`
- `src/services/taskStatus.ts`

Current git helpers likely assume direct local filesystem access.
Refactor command execution out of those helpers rather than duplicating a remote version of every method.

Recommended pattern:
- keep public API shape mostly stable
- route shell execution through backend-aware helpers

Examples:
- `getGitStatusWithPr(repoPath, ...)` becomes backend-aware via repo lookup or explicit backend param
- `pushBranch`, `createPullRequest`, `getPrComments`, `resolveThread`, `getCiFailures` all use backend execution

Important constraint:
- remote PR flows expect `gh` on the VPS
- if `gh` is missing, disable PR actions with a specific dependency error

Offline / Unreachable Backend Handling
--------------------------------------
Add a backend availability concept.

Recommended state behavior:
- if SSH project is unreachable:
  - do not delete repo/task metadata
  - do not update statuses from stale partial results
  - mark project/repo/task status as unavailable
  - render dots grey

Implementation sketch:
- extend task status color with `none` for unavailable display if possible, or add separate offline flag
- likely simplest UI path is to map unreachable remote tasks to grey dots in repo/task list rendering

Need a backend reachability cache with short TTL, e.g. 10-30s.

Testing Strategy
----------------
Unit-testable areas:
- project backend resolution
- SSH command argument building
- DB migration/backfill
- remote dependency check parsing
- remote repo discovery parsing
- remote worktree path derivation

Manual/integration test matrix:
1. Create local project still works unchanged
2. Create SSH project against reachable host
3. Dependency check passes/fails clearly
4. Remote repo discovery finds existing repos
5. Clone repo manually in project shell, then add/discover it
6. Create remote task and open terminal
7. Open Claude/Codex on remote task
8. Create PR from remote task
9. Disconnect network / break SSH and verify grey/offline behavior
10. Reconnect and verify refresh recovers

Suggested File-Level Work Plan
------------------------------
1. `src/store/types.ts`
   - extend `Project` type with backend fields
2. `src/services/db.ts`
   - add migration and CRUD support for backend metadata
3. `src/services/projectBackend.ts`
   - new backend resolver + SSH/local command helpers
4. `src/views/RepoSelection.tsx`
   - unified project creation flow with backend selection
5. `src/views/ProjectView.tsx`
   - remote project header, dependency checks, backend-aware refresh
6. `src/services/worktree.ts`
   - backend-aware worktree creation/removal
7. `src/components/TerminalPane.tsx`
   - backend-aware shell/console command launching
8. `src/services/git.ts`
   - backend-aware git/gh execution
9. `src/services/taskStatus.ts`
   - backend availability + remote pane-first status
10. `src/views/CreatePr.tsx` / `src/views/PrComments.tsx`
   - ensure remote task flows work through backend-aware services

Recommended First Slice
-----------------------
Build the smallest end-to-end remote slice first:
- create SSH-backed project
- check dependencies
- discover repos remotely
- open project shell remotely

Then add:
- remote task creation
- remote task terminal
- remote task console

Only after that:
- remote PR and review flows

This de-risks the backend model before touching every git/PR feature.

Success Criteria
----------------
We should consider phase 1 successful when a user can:
- create an SSH-backed project
- verify remote dependencies
- discover a repo on the VPS
- create a task for that repo
- open terminal + Claude/Codex in the remote worktree
- see remote task status update reasonably from pane output
- create and push a PR from that remote task using `gh` on the VPS
