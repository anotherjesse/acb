# Matrix Agent Platform — Implementation Plan (v1)

## Status

This document is the implementation plan for the production architecture.
The current `rc` codebase is a proof of concept and should be treated as a stepping stone.

## Phase 1-2 Delivery Decisions (implemented)

1. Hard cutover from the prototype to MetaOrchestrator + AgentBridge.
2. `spark_fork` is the only supported fork mode in this phase.
3. Durable state is JSON with atomic writes and crash-safe reload (`data/orchestrator-state.json`).
4. Task lifecycle is persistent multi-turn in each task room; the bridge resumes the existing Codex session.
5. Status is posted as textual notices (`waiting -> active -> needs_input/completed/error`); avatar color transitions are deferred.
6. Bridge env uses `MATRIX_HOMESERVER_URL` (not `MATRIX_HOMESERVER`).

## Goals

1. Run one autonomous coding agent per Matrix room in an isolated Spark.
2. Keep project setup low-ceremony for users: ask in lobby, get an agent room.
3. Make Spark lifecycle explicit and reproducible from orchestrator config.
4. Support opinionated repos and optional per-project backing services (Postgres/Redis) using the same operational pattern as `~/lw/spark-services`.

## Non-goals (v1)

1. Rich Matrix messages/cards (plaintext only).
2. User-triggered ad hoc sub-agent tooling from threads.
3. Multi-bot routing or web UI.
4. Automatic project discovery from Matrix.

## Matrix Model

| Concept | Matrix primitive | Notes |
|---|---|---|
| Workspace | Top-level space | One per team |
| Project | Subspace | One per repo/mono-repo target |
| Lobby | Room | One per project, control-plane entrypoint |
| Agent instance | Room | One room per task spark |
| Sub-agent work | Thread in agent room | Agent-created threads only in v1 |

## Runtime Components

## MetaOrchestrator (control plane)

Responsibilities:

1. Load YAML config.
2. Ensure Matrix hierarchy (workspace space, project subspaces, lobby rooms, invites).
3. Ensure Spark project-level resources (`project-main` spark, base, volumes).
4. Watch lobby rooms for new work requests.
5. Create task spark + task Matrix room.
6. Launch AgentBridge process in that task spark.
7. Track lifecycle state and post status links back to lobby.
8. Perform retention/garbage collection.

## AgentBridge (data plane, one per task spark)

Responsibilities:

1. Login to Matrix bot account and join only assigned room.
2. Consume messages in that room and run coding agent turns inside local spark filesystem.
3. Emit typing indicators + concise progress.
4. Use textual status transitions (`waiting -> active -> needs_input/completed/error`) in room notices.
5. Optionally create agent-owned threads for sub-agent activity.
6. Remain active for follow-up prompts in the same task room and resume prior Codex session state.

## Spark Runtime

Used as isolation and snapshot substrate:

1. btrfs-backed root filesystem snapshots.
2. Named data volumes mounted into sparks.
3. Snapshot/fork support for root and data volumes.

## How Code Uses Sparks

This is the core contract between Matrix services and Spark.

## Naming

For project key `auth-service`:

1. Spark project namespace: `auth-service`
2. Project template/main spark: `auth-service-main`
3. Project main work volume: `work-auth-service-main`
4. Task spark: `task-<timestamp>-<slug>`
5. Task work volume (explicit mode): `work-task-<id>`

## Fork Modes

### Mode A (default): full Spark fork from `project-main`

Use Spark native forking:

```bash
spark create task-20260208-oauth-refactor \
  --project auth-service \
  --fork auth-service-main \
  -t matrix_room_id=!abc:server \
  -t matrix_project=auth-service
```

Behavior:

1. Clones root filesystem from source spark snapshot.
2. Clones mounted data volumes from source to new forked volumes.
3. Fastest path, minimal orchestrator logic.

Use this mode when:

1. Project bootstrap state in `project-main` is trusted.
2. Forking all mounted state is desirable.

### Mode B (optional): explicit data snapshot/clone (spark-services pattern)

Use this when you want tighter control over which volumes clone and when to quiesce state (db/cache).

```bash
# Snapshot source work volume (and any selected service volumes)
spark data snapshot create work-auth-service-main fork-20260208-oauth

# Clone new task volume from snapshot
spark data create work-task-20260208-oauth \
  --project auth-service \
  --from work-auth-service-main \
  --from-snapshot fork-20260208-oauth

# Create task spark from base + cloned task volume
spark create task-20260208-oauth-refactor \
  --project auth-service \
  --base spark-base-coding \
  --data work-task-20260208-oauth=/work
```

Use this mode when:

1. You need deterministic data-volume selection.
2. You want pre-snapshot hooks (for example clean DB shutdown/checkpoint).
3. You want fresh root from base but cloned `/work`.

## Project Main Spark Contract

Each project has one orchestrator-managed template spark.

Rules:

1. `project-main` is not a user conversation target.
2. It contains repo checkout + dependencies + bootstrap outputs.
3. It is periodically refreshed (or manually rebuilt) from repo default branch.
4. It is the source for task forks.

Bootstrap behavior:

1. If `/work/scripts/bootstrap.sh` exists, run it.
2. Otherwise no-op.
3. Script must be idempotent.
4. Script timeout and retries are config-driven.

## Per-Project YAML Schema

```yaml
homeserver: https://matrix.yourserver.example
bot_account: "@codebot:yourserver.example"
bot_access_token: "syt_..."
top_level_space_name: "Coding"
team_members:
  - "@jesse:yourserver.example"

projects:
  - key: auth-service
    display_name: auth-service
    repo: git@github.com:yourorg/auth-service.git
    default_branch: main

    matrix:
      lobby_room_name: "#lobby"
      room_prefix: "#agent"

    spark:
      project: auth-service
      base: spark-base-coding
      main_spark: auth-service-main
      fork_mode: spark_fork   # spark_fork | explicit_data_clone
      work:
        volume: work-auth-service-main
        mount_path: /work
      bootstrap:
        script_if_exists: scripts/bootstrap.sh
        timeout_sec: 1800
        retries: 1
      retention:
        task_ttl_hours: 168
        keep_completed: true

      services:
        - name: pg
          enabled: false
          data_volume: pg-auth-service-main
          mount_path: /var/lib/postgresql/data
          init_script: scripts/services/init-postgres.sh
          start_script: scripts/services/start-postgres.sh
          stop_script: scripts/services/stop-postgres.sh
        - name: redis
          enabled: false
          data_volume: redis-auth-service-main
          mount_path: /var/lib/redis
          init_script: scripts/services/init-redis.sh
          start_script: scripts/services/start-redis.sh
          stop_script: scripts/services/stop-redis.sh
```

Notes:

1. Every project gets its own YAML entry.
2. Spark data volumes must be in same Spark project namespace as their sparks.
3. `services` are optional and follow the same init/start/stop lifecycle pattern as `spark-services`.

## End-to-End Flows

## 1. Startup/Reconcile

For each configured project:

1. Ensure Matrix project subspace + lobby room + invites.
2. Ensure Spark project namespace is usable.
3. Ensure `project-main` resources exist.
4. Ensure work volume exists.
5. Ensure optional service volumes exist.
6. Ensure `main_spark` exists with required mounts.
7. Ensure repo exists in `/work` (clone if missing).
8. Ensure branch/remote state for `default_branch`.
9. Run bootstrap convention (`/work/scripts/bootstrap.sh` if present).
10. Run optional service init/start scripts if enabled.
11. Mark project ready.

## 2. Lobby Request -> Task Room + Task Spark

On user message in project lobby:

1. Create agent room under project subspace.
2. Set textual room status `waiting`.
3. Create task spark (mode A or B).
4. Launch AgentBridge process inside task spark.
5. Post room link back in lobby.
6. Seed first prompt in task room (original lobby message quoted or copied).

## 3. Agent Processing

AgentBridge:

1. Joins assigned room.
2. Sets textual status `active` while work is executing.
3. Sends typing indicators during runs.
4. Posts progress summaries and structured checkpoints.
5. Uses threads for sub-agent work it initiates.

If blocked:

1. Set textual status `needs_input`.
2. Ask concise follow-up in room and idle.

On completion:

1. Post summary.
2. Set textual status `completed`.
3. Keep bridge process alive for subsequent prompts in the same task room.

## 4. Failure Handling

If bridge crashes:

1. Set textual status `error`.
2. Post failure reason in room.
3. Optionally allow `/restart` later (future iteration).

If Spark creation fails:

1. Post explicit failure in lobby with reason.
2. Keep no partial Matrix room unless configured to keep error rooms.

## Service Lifecycle Pattern (pg/redis style)

When service volumes are enabled:

1. During main initialization: run service `init_script`.
2. During task fork in explicit mode: run source service `stop_script` (or quiesce hook).
3. Snapshot service volume(s).
4. Clone destination service volume(s) from snapshot(s).
5. Create task spark with cloned service volumes.
6. Run destination service `start_script`.

This mirrors the safe snapshot/fork orchestration pattern used in `spark-services`.

## Process Launch Model

AgentBridge is launched inside each task spark via `spark exec --bg`.

Example:

```bash
spark exec auth-service:task-20260208-oauth-refactor --bg -- \
  /bin/bash -lc 'cd /work && node /spark/proj/agent-bridge/dist/index.js'
```

Required bridge env (injected by orchestrator):

1. `MATRIX_HOMESERVER_URL`
2. `MATRIX_ACCESS_TOKEN`
3. `MATRIX_ROOM_ID`
4. `MATRIX_BOT_USER`
5. `SPARK_PROJECT`
6. `SPARK_NAME`
7. `PROJECT_KEY`
8. `INITIAL_PROMPT` (optional)

## State Tracking

Orchestrator should persist durable state (JSON in Phase 1-2) with:

1. Project resource IDs (space ID, lobby room ID).
2. Task mapping (`matrix_room_id <-> spark_name`).
3. Bridge process metadata (pid/process ID when available).
4. Lifecycle timestamps.
5. Last known status and failure reason.

All reconcile paths must be idempotent.

## Retention and Cleanup

Default policy:

1. Keep completed task sparks for inspection.
2. GC after `task_ttl_hours`.
3. Delete task room optionally after archival policy (future).

Cleanup must remove:

1. Task spark.
2. Task data volumes (if explicit clone mode).
3. Fork snapshots created solely for that task.
4. Orchestrator state entries.

## Security and Isolation

1. Single Matrix bot account with many concurrent sessions is acceptable.
2. Each bridge process only joins one assigned room.
3. Spark network/storage isolation is per spark.
4. Secrets are injected at runtime, never committed.

## Implementation Phases

## Phase 1: Real Orchestrator Skeleton

1. Parse new YAML schema.
2. Reconcile Matrix hierarchy.
3. Reconcile `project-main` Spark resources.

## Phase 2: Task Spawn Path

1. Lobby watcher.
2. Task room creation.
3. Spark creation (mode A first).
4. Bridge launch in spark.

## Phase 3: Bootstrap + Services

1. `scripts/bootstrap.sh` convention.
2. Optional `services` init/start/stop hooks.
3. Explicit clone mode B.

## Phase 4: Reliability

1. Durable state store.
2. Crash recovery/reconcile loops.
3. GC + retention.

## Phase 5: UX and Commands

1. Room rename/status polish.
2. Slash commands (`/status`, `/archive`, `/restart`) in orchestrator.

## Success Criteria

1. User posts in lobby and receives task room link.
2. Task room has active bridge in isolated spark.
3. Agent completes task and marks room status.
4. Reconcile after orchestrator restart does not duplicate resources.
5. Project bootstrap + optional service hooks are deterministic and repeatable.
