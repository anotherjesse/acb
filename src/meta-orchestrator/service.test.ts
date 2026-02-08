import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { OrchestratorConfig } from "../lib/config/orchestratorConfig.js";
import { JsonOrchestratorStateStore } from "../lib/state/orchestratorState.js";
import { MetaOrchestrator } from "./service.js";

class FakeMatrix {
  private nextSpace = 1;
  private nextRoom = 1;

  readonly notices: Array<{ roomId: string; text: string }> = [];

  async verifyConnection(): Promise<void> {}

  async ensureJoinedRoom(_roomId: string): Promise<void> {}

  async createSpace(_name: string, _topic: string | undefined, _invites: string[]): Promise<string> {
    const id = `!space${this.nextSpace}:example.com`;
    this.nextSpace += 1;
    return id;
  }

  async createRoom(_name: string, _topic: string | undefined, _invites: string[]): Promise<string> {
    const id = `!room${this.nextRoom}:example.com`;
    this.nextRoom += 1;
    return id;
  }

  async linkRoomUnderSpace(_spaceId: string, _roomId: string): Promise<void> {}

  async ensureInvites(_roomId: string, _mxids: string[]): Promise<void> {}

  async sync(): Promise<{ next_batch: string }> {
    return { next_batch: "token" };
  }

  async sendNotice(roomId: string, text: string): Promise<string> {
    this.notices.push({ roomId, text });
    return `$notice${this.notices.length}:example.com`;
  }

  async sendMessage(roomId: string, text: string): Promise<string> {
    this.notices.push({ roomId, text });
    return `$message${this.notices.length}:example.com`;
  }

  async leaveAndForget(_roomId: string): Promise<void> {}
}

class FakeSpark {
  failCreateTask = false;
  ensureMainSparkCalls = 0;
  ensureRepoCalls = 0;
  createTaskCalls: Array<{ project: string; taskSpark: string; mainSpark: string }> = [];
  launchCalls: Array<{ project: string; sparkName: string; env: Record<string, string | undefined> }> = [];

  verifyAvailability(): void {}

  ensureWorkVolume(_project: string, _volume: string): void {}

  ensureMainSpark(): void {
    this.ensureMainSparkCalls += 1;
  }

  ensureRepoInMainSpark(): void {
    this.ensureRepoCalls += 1;
  }

  runBootstrap(): void {}

  createTaskSparkFork(options: { project: string; taskSpark: string; mainSpark: string }): void {
    if (this.failCreateTask) {
      throw new Error("spark create failed");
    }
    this.createTaskCalls.push(options);
  }

  launchBridgeInSpark(options: {
    project: string;
    sparkName: string;
    env: Record<string, string | undefined>;
  }): { pid: number; processId: string; rawOutput: string } {
    this.launchCalls.push({
      project: options.project,
      sparkName: options.sparkName,
      env: options.env,
    });
    return {
      pid: 777,
      processId: "bridge-777",
      rawOutput: "pid=777",
    };
  }
}

function createConfig(stateFile: string): OrchestratorConfig {
  return {
    configPath: "/tmp/config.yaml",
    homeserverUrl: "https://matrix.example.com",
    botUserId: "@codebot:example.com",
    botAccessToken: "token",
    workspace: {
      name: "Coding",
      topic: "Main",
      teamMembers: ["@a:example.com"],
    },
    runtime: {
      stateFile,
      bridgeEntrypoint: "/spark/proj/agent-bridge/dist/index.js",
      bridgeWorkdir: "/work",
      syncTimeoutMs: 30000,
      keepErrorRooms: false,
    },
    projects: [
      {
        key: "rc",
        displayName: "rc",
        repo: "git@github.com:org/rc.git",
        defaultBranch: "main",
        matrix: {
          lobbyRoomName: "#lobby",
          taskRoomPrefix: "#agent",
        },
        spark: {
          project: "rc",
          base: "spark-base-coding",
          mainSpark: "rc-main",
          forkMode: "spark_fork",
          work: {
            volume: "work-rc-main",
            mountPath: "/work",
          },
          bootstrap: {
            scriptIfExists: "scripts/bootstrap.sh",
            timeoutSec: 1800,
            retries: 1,
          },
        },
      },
    ],
  };
}

test("reconcile creates workspace/project/lobby resources and persists state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-orch-"));
  const stateFile = path.join(dir, "state.json");

  const matrix = new FakeMatrix();
  const spark = new FakeSpark();
  const store = new JsonOrchestratorStateStore(stateFile);

  const orchestrator = new MetaOrchestrator(createConfig(stateFile), {
    matrix,
    spark,
    stateStore: store,
  });

  await orchestrator.reconcileWorkspaceAndProjects();

  const state = orchestrator.getState();
  assert.ok(state.workspace.spaceId);
  assert.ok(state.projects.rc?.projectSpaceId);
  assert.ok(state.projects.rc?.lobbyRoomId);
  assert.equal(spark.ensureMainSparkCalls, 1);
  assert.equal(spark.ensureRepoCalls, 1);

  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { projects?: Record<string, unknown> };
  assert.ok(persisted.projects?.rc);
});

test("single lobby event creates one task room + spark + bridge launch and dedupes replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-orch-"));
  const stateFile = path.join(dir, "state.json");

  const matrix = new FakeMatrix();
  const spark = new FakeSpark();
  const store = new JsonOrchestratorStateStore(stateFile);

  const orchestrator = new MetaOrchestrator(createConfig(stateFile), {
    matrix,
    spark,
    stateStore: store,
    now: () => new Date("2026-02-08T19:00:00.000Z"),
  });

  await orchestrator.reconcileWorkspaceAndProjects();

  const lobbyRoomId = orchestrator.getState().projects.rc?.lobbyRoomId;
  assert.ok(lobbyRoomId);

  const sync = {
    next_batch: "token-2",
    rooms: {
      join: {
        [lobbyRoomId!]: {
          timeline: {
            events: [
              {
                type: "m.room.message",
                event_id: "$event1:example.com",
                sender: "@user:example.com",
                content: {
                  body: "implement oauth migration",
                },
              },
            ],
          },
        },
      },
    },
  };

  await orchestrator.handleSync(sync);
  await orchestrator.handleSync(sync);

  const state = orchestrator.getState();
  assert.equal(Object.keys(state.tasks).length, 1);
  assert.equal(spark.createTaskCalls.length, 1);
  assert.equal(spark.launchCalls.length, 1);
  assert.equal(spark.launchCalls[0]?.env.INITIAL_PROMPT, "implement oauth migration");
});

test("spark creation failure marks task error and posts failure notice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-orch-"));
  const stateFile = path.join(dir, "state.json");

  const matrix = new FakeMatrix();
  const spark = new FakeSpark();
  spark.failCreateTask = true;

  const store = new JsonOrchestratorStateStore(stateFile);
  const orchestrator = new MetaOrchestrator(createConfig(stateFile), {
    matrix,
    spark,
    stateStore: store,
    now: () => new Date("2026-02-08T19:00:00.000Z"),
  });

  await orchestrator.reconcileWorkspaceAndProjects();

  const lobbyRoomId = orchestrator.getState().projects.rc?.lobbyRoomId;
  assert.ok(lobbyRoomId);

  await orchestrator.handleSync({
    next_batch: "token-3",
    rooms: {
      join: {
        [lobbyRoomId!]: {
          timeline: {
            events: [
              {
                type: "m.room.message",
                event_id: "$event-fail:example.com",
                sender: "@user:example.com",
                content: {
                  body: "trigger failure",
                },
              },
            ],
          },
        },
      },
    },
  });

  const firstTask = Object.values(orchestrator.getState().tasks)[0];
  assert.ok(firstTask);
  assert.equal(firstTask?.status, "error");

  const failureNotice = matrix.notices.find((entry) => /Task creation failed/i.test(entry.text));
  assert.ok(failureNotice);
});
