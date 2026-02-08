import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskIdentifiers } from "./naming.js";

test("buildTaskIdentifiers is deterministic and safe", () => {
  const now = new Date("2026-02-08T19:00:01.000Z");
  const first = buildTaskIdentifiers({
    projectKey: "rc",
    prompt: "Refactor OAuth callback handler + add retries!!",
    lobbyEventId: "$abc123:example",
    now,
  });
  const second = buildTaskIdentifiers({
    projectKey: "rc",
    prompt: "Refactor OAuth callback handler + add retries!!",
    lobbyEventId: "$abc123:example",
    now,
  });

  assert.equal(first.taskId, second.taskId);
  assert.equal(first.sparkName, second.sparkName);
  assert.match(first.sparkName, /^task-20260208190001-[a-z0-9-]+-[a-f0-9]{6}$/);
  assert.ok(first.sparkName.length <= 63);
});
