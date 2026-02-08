# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|

## User Preferences
- Use concise, practical implementation updates and make concrete code changes directly.

## Patterns That Work
- Read available skills and repo context first, then implement directly with env-configurable integrations.

## Patterns That Don't Work
- Assuming repo notes/files exist without creating required scaffolding first.

## Domain Notes
- This repo is transitioning messaging integration from Telegram to Matrix.
- Matrix credentials and server configuration should be fully environment-driven.
- Matrix agent spec text may live in `/Users/jesse/lw/sparks/docs/matrix.md` even when working from `/Users/jesse/oss/rc`.
- Spark root filesystem cloning (`spark create --fork`) is separate from data volume cloning.
- Data volume cloning requires snapshot flow: `spark data snapshot create` then `spark data create --from ... --from-snapshot ...`.
- For Matrix orchestration planning, a per-project "template/main spark" entry in orchestrator YAML is a good fit to capture project-specific deps/bootstrap.
- Prefer opinionated repo bootstrap convention (`scripts/bootstrap.sh` when present) over per-project hardcoded script names in orchestrator config.

## Session Notes
| 2026-02-08 | self | Tried `npm uninstall` to remove Telegram deps, but registry failed on `@openai/codex-sdk@^0.9.0` resolution (`ETARGET`) | Avoid npm lockfile operations in this repo unless Codex SDK version source is confirmed; prefer code-only migration changes |
| 2026-02-08 | self | Homeserver URL may be provided as `/ _matrix/static/` web path rather than base host | Normalize Matrix homeserver URL before calling client API endpoints |
| 2026-02-08 | self | Existing Matrix rooms did not re-apply configured invites on restart | After room resolution, call membership check + invite missing `MATRIX_ROOM_INVITE_USERS` users |
| 2026-02-08 | self | Repo may be intentionally dirty during sessions (`.claude/`, `data/`) | Always report current git status first; do not assume clean working tree |
| 2026-02-08 | self | Advanced Matrix sync token before event handling completed | Move `since = sync.next_batch` to after successful handler pass; avoid dropping messages on handler errors |
| 2026-02-08 | self | `/run` matcher accepted `/runner` because of naive `startsWith(\"/run\")` | Use anchored regex `^/run(?:\\s|$)` for exact command semantics |
| 2026-02-08 | self | Sandbox blocks writes under `.git` (`index.lock` cannot be created), so commit commands fail | Report commit blocker clearly and provide exact `git add`/`git commit` command for user to run locally |
| 2026-02-08 | self | Matrix instance-thread routing requires strict event filtering | Route only events with `m.relates_to.rel_type = m.thread` and matching root event id |
| 2026-02-08 | self | Migrating from room-per-instance to project room can strand existing users | Reuse `data/matrix-rooms.json` entry as fallback project room before creating new resources |
| 2026-02-08 | self | Removed unused deps in `package.json` without lockfile refresh | Keep deps until lockfile can be regenerated safely; avoid `package.json`/`package-lock.json` drift |
| 2026-02-08 | self | Ran `rg` with a pattern starting `--...` without `-e`, causing flag parsing failure | Use `rg -e \"pattern\"` (or quote patterns carefully) when pattern text can look like CLI flags |
| 2026-02-08 | self | Edited file in `/Users/jesse/lw/sparks` when user wanted changes only in `/Users/jesse/oss/rc` | Confirm target repo path before file edits; keep cross-repo reads strictly read-only unless explicitly asked to patch there |
| 2026-02-08 | self | Tried adding `yaml` dependency with npm and hit `ETARGET` again for `@openai/codex-sdk@^0.9.0` | Avoid lockfile/dependency mutation; prefer zero-dependency implementation paths in this repo |
| 2026-02-08 | self | Introduced malformed template-string quotes while building spark command args (`${project}:${spark}`) | Run `npm run build` immediately after large file writes and fix parser-level TS errors before continuing |
| 2026-02-08 | self | YAML parser treated MXIDs like `@user:server` as inline key/value because of colon handling | Only treat `:` as mapping separator when followed by whitespace/end-of-token in simple YAML parsing |
| 2026-02-08 | self | `@openai/codex-sdk@^0.9.0` is no longer published and breaks installs | Query `npm view @openai/codex-sdk version` and pin/bump to current published version before lockfile operations |
