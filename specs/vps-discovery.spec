VPS-Backed Project Discovery and Remote Task Execution
=====================================================

Goal
----
Enable an entire Gladius project to live on a VPS reachable over SSH.
The user should be able to:
- connect to a VPS using normal SSH auth
- choose a remote base directory where repositories live
- discover or clone repos into that directory
- create tasks and worktrees on the VPS
- open task terminals and LLM consoles against the remote worktree
- keep Gladius's existing local UX model: project -> repo -> task

This feature should feel like "a project has an execution location", not like
an entirely different product mode.

Core Product Model
------------------
Add the concept of a project backend:
- local project: current behavior, path is on the local machine
- ssh project: project path is a remote directory reachable through an SSH target

A single Gladius project should be either:
- local
- ssh-backed

All repos and tasks under that project inherit the same execution backend.
Mixing local and remote repos inside one project should not be allowed.

User Experience
---------------
The user flow should look like this:

1. Create SSH-backed project
   - From Project Selection, choose "New Project"
   - First prompt asks for project backend:
     - local
     - ssh
   - If ssh is chosen, user enters an SSH target such as:
     - user@host
     - root@1.2.3.4
     - a named SSH config host
   - Gladius attempts a lightweight SSH connection test
   - If successful, prompt for a remote base directory, for example:
     - ~/src
     - /srv/work
     - /home/austin/code
   - Gladius creates or validates that directory remotely
   - The new project is stored as an SSH-backed project

2. Enter Project View
   - Project header makes it obvious this is remote, e.g.:
     - "Remote Project"
     - ssh target shown in dim text
     - remote base path shown in dim text
   - Project refresh scans the remote base directory for git repos
   - Repo list is populated from the VPS, not local disk

3. Add or discover repos
   Two valid ways to populate repos:
   - discovery: scan remote base directory for existing git repos
   - clone: open a remote shell rooted at the project base dir and let the user run git clone manually

   The most natural UX is to reuse the existing embedded terminal pattern:
   - spawn an SSH shell into the project base dir
   - user runs git clone / ls / cd
   - on Esc, Gladius captures the remote cwd and offers to add the repo if it is a git repo

4. Create task
   - Same as today from the repo's task list
   - Worktree creation runs remotely via SSH
   - Branch naming remains the same
   - Task metadata is still stored locally in Gladius's SQLite DB
   - worktree_path becomes a remote path string

5. Open task
   - Terminal pane becomes an SSH-backed shell rooted at the remote worktree
   - Console pane runs Claude/Codex on the VPS inside the remote worktree
   - Git status, PR status, Create PR, reviewer selection, and PR comments all work using remote git commands

6. Close task
   - Worktree removal runs remotely
   - Branch deletion logic stays the same, but executed over SSH

High-Level Design
-----------------
The cleanest implementation is to separate:
- metadata storage: still local SQLite
- execution: local shell vs remote SSH shell
- filesystem assumptions: abstracted behind a backend layer

Introduce a backend interface such as:

- project backend
  - kind: "local" | "ssh"
  - run(command, cwd)
  - capturePane/session command launching
  - resolvePath(...)
  - discoverRepos(baseDir)
  - gitWorktreeAdd(...)
  - gitWorktreeRemove(...)
  - gitStatus(...)

This allows existing features to reuse the same workflows while swapping how
commands are executed.

Data Model Changes
------------------
Projects need backend metadata.

Proposed fields for `projects`:
- backend_kind: "local" | "ssh"
- backend_target: nullable string
  - examples: user@host, prod-vps
- backend_base_path: string
  - local path for local projects
  - remote path for ssh projects
- backend_display_name: optional cached label for UI

Repos should continue storing:
- path
But for SSH projects that path is a remote absolute path, not a local one.

Tasks should continue storing:
- worktree_path
But for SSH projects that path is also remote.

No separate remote database is needed for phase 1.
Gladius remains the source of truth locally.

SSH Connection Model
--------------------
Preferred behavior:
- rely on the user's existing SSH setup
- support SSH config hosts and keys automatically
- use `ssh <target> ...` rather than implementing SSH in-process

This keeps behavior aligned with the user's normal shell environment.

Phase 1 should explicitly not manage:
- SSH key creation
- password prompts in custom UI
- agent forwarding configuration
- persistent multiplexing configuration UI

But implementation should be compatible with:
- SSH agent
- `~/.ssh/config`
- ControlMaster if the user already has it configured
- per-repo deploy keys if the user configures git access that way on the VPS

A useful optimization is to optionally standardize on a Gladius control socket
per target so repeated commands are faster, but this should be an internal
performance detail, not a user-facing concept.

Remote Dependency Checks
------------------------
SSH-backed projects should have an explicit `Check Dependencies` action.

Purpose:
- verify that the VPS is actually usable for Gladius workflows
- surface missing tools before task creation or PR creation fails
- give the user a single place to diagnose remote setup problems

Recommended checks for phase 1:
- `git`
- `gh`
- `claude` and/or `codex`
- `bun` if the user expects to run Bun-based projects
- `node` / `npm` only if we later want optional language/runtime checks
- shell availability (`$SHELL` or fallback shell)

Output should distinguish:
- required for all remote repos
- required for PR workflows
- required for LLM console workflows
- optional/project-specific

Recommended UX:
- project-level action in Project View: `Check Dependencies`
- show pass/fail rows per tool
- preserve the last successful check timestamp
- allow rerun on demand

For PR workflows, prefer `gh` on the VPS if available.
This keeps repo state and GitHub auth colocated with the remote git checkout.
If deploy keys work for git but not for `gh`, the project may still support:
- remote git workflows
- local-only PR creation as a fallback in a later phase

Phase 1 should still target:
- remote git
- remote gh
- remote LLM CLI

Repo Discovery on VPS
---------------------
For SSH-backed projects, `refreshProjectRepos(projectId)` should:
- SSH to the target
- scan the configured remote base path
- find nested `.git` directories similar to local discovery
- insert/update repo records using remote paths

This should mirror local discovery behavior as closely as possible.

Because remote scans can be slower, the UI should:
- show "Refreshing remote project..."
- preserve partial progress if possible
- tolerate transient SSH failures without corrupting repo metadata

Remote Shell and Terminal UX
----------------------------
The existing embedded terminal model is a strong fit.

Project-level remote shell:
- used for cloning repos or exploring the remote project directory
- command shape:
  - ssh -t <target> "cd <base> && exec \$SHELL -l"

Task terminal:
- used for builds/tests/manual commands in the task worktree
- command shape:
  - ssh -t <target> "cd <worktree> && exec \$SHELL -l"

Task console:
- used for Claude/Codex running on the VPS in the task worktree
- command shape roughly:
  - ssh -t <target> "cd <worktree> && claude --resume ..."
  - ssh -t <target> "cd <worktree> && codex resume ..."

This implies session persistence for remote tasks should also live on the VPS,
which is desirable because the LLM process is actually running there.

LLM Session Capture on VPS
--------------------------
Current Gladius logic reads:
- local Claude transcript files
- local Codex transcript files
- local tmux pane content

For SSH-backed tasks, those data sources also need to become remote-aware.

Phase 1 approach:
- keep using tmux on the local machine only for Gladius's own PTY/session model
- the PTY itself wraps an SSH command to the VPS
- status detection should come from captured pane output first
- transcript-file parsing can be deferred or made backend-aware later

Pragmatic recommendation:
- for remote tasks, treat pane capture as the primary LLM status source
- avoid depending on remote transcript file parsing in the first usable version
- once the workflow is stable, add remote transcript discovery for Claude/Codex

Git and PR Operations
---------------------
All repo and task git operations should go through the project backend.
That includes:
- branch detection
- ahead/behind counts
- diff stats
- worktree add/remove
- fetch/push
- PR creation
- PR comments/thread resolution
- CI failure retrieval

Most of this can remain implemented via the same shell commands, but executed
through SSH instead of directly on the local filesystem.

Important constraint:
- `gh` must be installed and authenticated on the VPS if PR operations are
  executed remotely

Alternative option:
- run pure git commands remotely, but run `gh` locally against the pushed branch

The cleaner phase 1 is:
- remote git
- remote gh

because it keeps all repo state and credentials colocated.

Task Creation and Worktrees
---------------------------
For SSH-backed repos, task creation should work almost exactly like local task
creation, except every filesystem and git step runs remotely.

Desired behavior:
- worktree root for remote tasks should be configurable per project or derived
  consistently, for example:
  - <repo>/.git worktree add <base>/.gladius/worktrees/<label>
  - or a shared remote directory like ~/.wt/<repo>/<label>

It is important that:
- worktree paths are stable and visible in the UI
- delete/cleanup is reversible and understandable
- remote `.env` copying behavior is clearly defined

Recommendation:
- preserve the current shared worktree convention conceptually
- add backend-specific helpers for copying ignored `.env*` files remotely

Decision:
- remote tasks should use the shared worktree convention
- preferred default: `~/.wt/<repo>/<label>` on the VPS

Navigation and Visual Language
------------------------------
SSH-backed projects should be visibly distinct in the UI.

Recommended cues:
- Project header badge: `REMOTE`
- Show SSH target and base path in headers
- Repo list entries show remote path on focus/detail
- Task view header can show `user@host:/path/to/worktree`

This avoids subtle mistakes where a user thinks they are working locally.

Failure Modes
-------------
The design must handle these explicitly:

1. SSH target unreachable
   - Project remains visible
   - Refresh shows an actionable error
   - Existing task metadata is preserved
   - repo refresh pauses/fails cleanly instead of mutating repo/task metadata
   - aggregate and per-task status dots should render grey while the backend is unavailable

2. Remote path missing
   - Offer to create it during project setup
   - Later failures should surface clearly

3. Missing remote dependencies
   - git missing on VPS
   - gh missing on VPS
   - claude/codex missing on VPS
   - tmux/shell assumptions broken

   Gladius should detect and explain the missing dependency at the feature point
   where it is required.

4. Connection drops during task session
   - terminal pane exits visibly
   - task should not be marked closed
   - user can reopen the pane and reconnect

5. Local and remote path confusion
   - avoid passing remote paths into local fs utilities
   - backend boundary should make this impossible by construction

Offline Behavior
----------------
When an SSH-backed project is offline:
- reviewer defaults should remain available because they are local Gladius metadata
- repo/task records should remain visible but read-only with respect to remote actions
- project refresh should pause/fail cleanly
- task status dots should go grey rather than implying PR/LLM state is current
- destructive or network-dependent actions should explain that the remote backend is unavailable

Recommended Scope Split
-----------------------
Phase 1: SSH-backed projects and remote command execution
- add SSH project type
- store target + remote base path
- discover repos remotely
- create remote worktrees
- remote task terminal
- remote task console
- remote git status
- remote Create PR flow
- obvious UI labeling

Phase 2: richer remote ergonomics
- remote transcript parsing for Claude/Codex
- SSH connection reuse / control sockets
- remote environment checks screen
- clone-new-repo shortcut in UI
- better latency handling and progressive loading

Phase 3: fleet / multi-host capabilities
- multiple SSH targets per user
- move repo between hosts
- project templates
- remote bootstrap automation

Resolved Product Decisions
--------------------------
1. Prefer `gh` on the VPS for PR workflows. Add a project-level dependency check so missing tools are visible early.
2. The remote shell for project setup/repo addition should start in the project base directory.
3. Remote tasks should use the shared worktree convention, preferably `~/.wt/<repo>/<label>`.
4. When the remote host is offline, reviewer defaults remain available locally, repo refresh pauses/fails cleanly, and status dots go grey.
5. Use a unified `New Project` flow with backend selection instead of a separate `New SSH Project` flow.

Recommended Direction
---------------------
The cleanest path is:
- keep Gladius local
- make projects backend-aware
- treat SSH as a project execution backend
- reuse the existing keyboard-driven repo/task/task-view flows
- run repo/task commands remotely through SSH
- make remote pane output the primary source of immediate LLM status

That gives the user exactly what they want:
- SSH into a VPS
- navigate to a directory
- clone repos there
- create and manage tasks there

without forcing them to think about a second Gladius instance or a separate
remote mode.
