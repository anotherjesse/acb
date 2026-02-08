import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { JsonOrchestratorStateStore, createDefaultState } from "./orchestratorState.js";

test("JsonOrchestratorStateStore save/load round trip and event dedupe index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-state-"));
  const file = path.join(dir, "orchestrator-state.json");
  const store = new JsonOrchestratorStateStore(file);

  const state = createDefaultState();
  state.workspace = {
    name: "Coding",
    spaceId: "!workspace:example",
    updatedAt: new Date().toISOString(),
  };

  store.markEventProcessed(state, "!lobby:example", "$event:example", "task-1");
  state.tasks["task-1"] = {
    id: "task-1",
    projectKey: "rc",
    lobbyRoomId: "!lobby:example",
    lobbyEventId: "$event:example",
    status: "active",
    bridge: {
      pid: 123,
    },
    initialPrompt: "hello",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  store.save(state);

  assert.ok(fs.existsSync(file));
  const loaded = store.load();

  assert.equal(loaded.workspace.spaceId, "!workspace:example");
  assert.equal(loaded.tasks["task-1"]?.bridge.pid, 123);
  assert.equal(store.hasProcessedEvent(loaded, "!lobby:example", "$event:example"), true);
});
