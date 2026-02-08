import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { loadOrchestratorConfig } from "./orchestratorConfig.js";

test("loadOrchestratorConfig parses valid YAML config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-config-"));
  const file = path.join(dir, "matrix-orchestrator.yaml");

  fs.writeFileSync(
    file,
    [
      "homeserver_url: https://matrix.example.com/_matrix/static/",
      'bot_user_id: "@codebot:example.com"',
      'bot_access_token: "token-123"',
      "workspace:",
      "  name: Coding",
      "  topic: Main",
      "  team_members:",
      '    - "@a:example.com"',
      "projects:",
      "  - key: rc",
      "    display_name: rc",
      "    repo: git@github.com:org/rc.git",
      "    default_branch: main",
      "    matrix:",
      "      lobby_room_name: '#lobby'",
      "      task_room_prefix: '#agent'",
      "    spark:",
      "      project: rc",
      "      base: spark-base-coding",
      "      main_spark: rc-main",
      "      fork_mode: spark_fork",
      "      work:",
      "        volume: work-rc-main",
      "        mount_path: /work",
      "      bootstrap:",
      "        script_if_exists: scripts/bootstrap.sh",
      "        timeout_sec: 1800",
      "        retries: 1",
    ].join("\n"),
    "utf8",
  );

  const config = loadOrchestratorConfig(file);
  assert.equal(config.homeserverUrl, "https://matrix.example.com");
  assert.equal(config.runtime.bridgeEntrypoint, "/spark/proj/agent-bridge/dist/index.js");
  assert.equal(config.projects[0]?.spark.forkMode, "spark_fork");
  assert.equal(config.projects[0]?.matrix.lobbyRoomName, "#lobby");
});

test("loadOrchestratorConfig rejects unsupported fork mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-config-"));
  const file = path.join(dir, "matrix-orchestrator.yaml");

  fs.writeFileSync(
    file,
    [
      "homeserver_url: https://matrix.example.com",
      'bot_user_id: "@codebot:example.com"',
      'bot_access_token: "token-123"',
      "workspace:",
      "  name: Coding",
      "  team_members:",
      '    - "@a:example.com"',
      "projects:",
      "  - key: rc",
      "    display_name: rc",
      "    repo: git@github.com:org/rc.git",
      "    default_branch: main",
      "    matrix:",
      "      lobby_room_name: '#lobby'",
      "      task_room_prefix: '#agent'",
      "    spark:",
      "      project: rc",
      "      base: spark-base-coding",
      "      main_spark: rc-main",
      "      fork_mode: explicit_data_clone",
      "      work:",
      "        volume: work-rc-main",
      "      bootstrap:",
      "        script_if_exists: scripts/bootstrap.sh",
    ].join("\n"),
    "utf8",
  );

  assert.throws(() => loadOrchestratorConfig(file), /unsupported fork_mode/i);
});

test("loadOrchestratorConfig accepts password auth without access token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-config-"));
  const file = path.join(dir, "matrix-orchestrator.yaml");

  fs.writeFileSync(
    file,
    [
      "homeserver_url: https://matrix.example.com",
      'bot_user_id: "@codebot:example.com"',
      'bot_password: "secret-password"',
      "workspace:",
      "  name: Coding",
      "  team_members:",
      '    - "@a:example.com"',
      "projects:",
      "  - key: rc",
      "    display_name: rc",
      "    repo: git@github.com:org/rc.git",
      "    default_branch: main",
      "    matrix:",
      "      lobby_room_name: '#lobby'",
      "      task_room_prefix: '#agent'",
      "    spark:",
      "      project: rc",
      "      base: spark-base-coding",
      "      main_spark: rc-main",
      "      fork_mode: spark_fork",
      "      work:",
      "        volume: work-rc-main",
      "      bootstrap:",
      "        script_if_exists: scripts/bootstrap.sh",
    ].join("\n"),
    "utf8",
  );

  const config = loadOrchestratorConfig(file);
  assert.equal(config.botAccessToken, undefined);
  assert.equal(config.botPassword, "secret-password");
});

test("loadOrchestratorConfig requires token or password auth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-config-"));
  const file = path.join(dir, "matrix-orchestrator.yaml");

  fs.writeFileSync(
    file,
    [
      "homeserver_url: https://matrix.example.com",
      'bot_user_id: "@codebot:example.com"',
      "workspace:",
      "  name: Coding",
      "  team_members:",
      '    - "@a:example.com"',
      "projects:",
      "  - key: rc",
      "    display_name: rc",
      "    repo: git@github.com:org/rc.git",
      "    default_branch: main",
      "    matrix:",
      "      lobby_room_name: '#lobby'",
      "      task_room_prefix: '#agent'",
      "    spark:",
      "      project: rc",
      "      base: spark-base-coding",
      "      main_spark: rc-main",
      "      fork_mode: spark_fork",
      "      work:",
      "        volume: work-rc-main",
      "      bootstrap:",
      "        script_if_exists: scripts/bootstrap.sh",
    ].join("\n"),
    "utf8",
  );

  assert.throws(() => loadOrchestratorConfig(file), /bot_access_token or bot_password/i);
});
