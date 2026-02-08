import assert from "node:assert/strict";
import test from "node:test";

import { buildSparkCreateForkArgs, buildSparkExecBridgeArgs } from "./client.js";

test("buildSparkCreateForkArgs emits expected spark fork command args", () => {
  const args = buildSparkCreateForkArgs({
    project: "auth-service",
    taskSpark: "task-20260208-oauth",
    mainSpark: "auth-service-main",
    tags: {
      matrix_room_id: "!abc:example.com",
      matrix_project: "auth-service",
    },
  });

  assert.deepEqual(args, [
    "create",
    "task-20260208-oauth",
    "--project",
    "auth-service",
    "--fork",
    "auth-service-main",
    "-t",
    "matrix_room_id=!abc:example.com",
    "-t",
    "matrix_project=auth-service",
  ]);
});

test("buildSparkExecBridgeArgs emits expected spark exec command args", () => {
  const args = buildSparkExecBridgeArgs({
    project: "auth-service",
    sparkName: "task-20260208-oauth",
    bridgeEntrypoint: "/spark/proj/agent-bridge/dist/index.js",
    bridgeWorkdir: "/work",
    env: {
      MATRIX_ROOM_ID: "!abc:example.com",
      PROJECT_KEY: "auth-service",
      OPENAI_API_KEY: "sk-test",
    },
  });

  assert.equal(args[0], "exec");
  assert.equal(args[1], "auth-service:task-20260208-oauth");
  assert.equal(args[2], "--bg");
  assert.equal(args[4], "/bin/bash");
  assert.equal(args[5], "-lc");

  const shellScript = args[6] ?? "";
  assert.match(shellScript, /export MATRIX_ROOM_ID='!abc:example.com'/);
  assert.match(shellScript, /export PROJECT_KEY='auth-service'/);
  assert.match(shellScript, /cd '\/work'/);
  assert.match(shellScript, /node '\/spark\/proj\/agent-bridge\/dist\/index\.js'/);
});
