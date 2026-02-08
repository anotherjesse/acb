# Matrix MetaOrchestrator + AgentBridge (TypeScript)

This repo now implements the hard-cutover architecture:

- **MetaOrchestrator** (`src/meta-orchestrator/index.ts`): control plane that reconciles Matrix + Spark resources, watches lobby rooms, and spawns one task spark + room per lobby request.
- **AgentBridge** (`src/agent-bridge/index.ts`): data plane process launched inside each task spark; runs Codex turns in that task room and persists/resumes session state.

## Phase 1-2 Scope

Implemented in this repo:

- YAML-driven orchestrator config (`config/matrix-orchestrator.yaml`, override via `MATRIX_ORCHESTRATOR_CONFIG`)
- JSON durable orchestrator state (`data/orchestrator-state.json`) with atomic writes
- Matrix hierarchy reconciliation: workspace space -> project subspace -> lobby room
- Spark reconcile for each project: work volume, main spark, repo sync, optional bootstrap script
- Lobby message -> task room + forked spark + bridge launch path
- Persistent multi-turn bridge behavior (`/run`, `/new`, `/stop`, `/status`, plain text)
- No global task concurrency cap

Deferred to later phases:

- `explicit_data_clone` fork mode
- service lifecycle (`pg` / `redis`) orchestration
- retention GC automation
- room-avatar status colors and slash admin commands (`/archive`, `/restart`)

## Configuration

Use `config/matrix-orchestrator.yaml` as the source of truth. Example fields:

```yaml
homeserver_url: https://spark-services--test.loop.work/_matrix/static/
bot_user_id: "@codebot:test.spark-services"
bot_access_token: "syt_..."
workspace:
  name: Coding
  topic: Codex Matrix workspace
  team_members:
    - "@you:test.spark-services"
runtime:
  state_file: data/orchestrator-state.json
  bridge_entrypoint: /spark/proj/agent-bridge/dist/index.js
  bridge_workdir: /work
  sync_timeout_ms: 30000
  keep_error_rooms: false
projects:
  - key: rc
    display_name: rc
    repo: git@github.com:yourorg/rc.git
    default_branch: main
    matrix:
      lobby_room_name: "#lobby"
      task_room_prefix: "#agent"
    spark:
      project: rc
      base: spark-base-coding
      main_spark: rc-main
      fork_mode: spark_fork
      work:
        volume: work-rc-main
        mount_path: /work
      bootstrap:
        script_if_exists: scripts/bootstrap.sh
        timeout_sec: 1800
        retries: 1
```

Validation rules:

- `fork_mode` must be `spark_fork` in this phase.
- Enabled `services` are rejected in this phase.

## Setup

1. Install dependencies (already pinned in this repo):

```bash
npm install
```

2. Copy env defaults:

```bash
cp .env.example .env
```

3. Update `config/matrix-orchestrator.yaml` with your homeserver, bot token, project repo, and Spark settings.

## Run

Development:

```bash
npm run dev
# or explicitly
npm run dev:orchestrator
```

Bridge-only local run (usually launched by orchestrator in Spark):

```bash
npm run dev:bridge
```

Production build:

```bash
npm run build
npm run start:orchestrator
```

## AgentBridge Commands (inside task room)

- `/run <prompt>`: run one Codex turn
- `/new`: reset to a new Codex thread
- `/stop`: interrupt active run
- `/status`: report bridge + thread status
- Plain text: treated as `/run`

Bridge persists per-room thread IDs in `data/bridge-sessions.json` (path override: `BRIDGE_SESSION_FILE`).
