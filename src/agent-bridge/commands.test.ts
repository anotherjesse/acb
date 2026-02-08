import assert from "node:assert/strict";
import test from "node:test";

import { isStaleResumeError, parseBridgeCommand } from "./commands.js";

test("parseBridgeCommand handles slash and plain-text command variants", () => {
  assert.deepEqual(parseBridgeCommand("/help"), { type: "help" });
  assert.deepEqual(parseBridgeCommand("/new"), { type: "new" });
  assert.deepEqual(parseBridgeCommand("/stop"), { type: "stop" });
  assert.deepEqual(parseBridgeCommand("/status"), { type: "status" });
  assert.deepEqual(parseBridgeCommand("/run fix tests"), { type: "run", prompt: "fix tests" });
  assert.deepEqual(parseBridgeCommand("plain text prompt"), { type: "run", prompt: "plain text prompt" });
  assert.deepEqual(parseBridgeCommand("/unknown"), { type: "unknown", raw: "/unknown" });
});

test("isStaleResumeError recognizes known stale-thread failures", () => {
  assert.equal(isStaleResumeError("state db missing rollout path for thread abc"), true);
  assert.equal(isStaleResumeError("missing rollout path for thread xyz"), true);
  assert.equal(isStaleResumeError("network timeout"), false);
});
