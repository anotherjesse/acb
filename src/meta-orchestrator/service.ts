import { OrchestratorConfig, OrchestratorProjectConfig } from "../lib/config/orchestratorConfig.js";
import { MatrixClient } from "../lib/matrix/client.js";
import { MatrixSyncEvent, MatrixSyncResponse } from "../lib/matrix/types.js";
import { buildTaskIdentifiers } from "../lib/spark/naming.js";
import { SparkClient } from "../lib/spark/client.js";
import {
  JsonOrchestratorStateStore,
  OrchestratorStateData,
  ProjectStateRecord,
  TaskStateRecord,
  TaskStatus,
} from "../lib/state/orchestratorState.js";
import { formatError, log } from "../lib/util/log.js";
import { truncate } from "../lib/util/strings.js";

export type MetaOrchestratorDeps = {
  matrix: Pick<
    MatrixClient,
    | "verifyConnection"
    | "ensureJoinedRoom"
    | "createSpace"
    | "createRoom"
    | "linkRoomUnderSpace"
    | "ensureInvites"
    | "sync"
    | "sendNotice"
    | "sendMessage"
    | "leaveAndForget"
  >;
  spark: Pick<
    SparkClient,
    | "verifyAvailability"
    | "ensureWorkVolume"
    | "ensureMainSpark"
    | "ensureRepoInMainSpark"
    | "runBootstrap"
    | "createTaskSparkFork"
    | "launchBridgeInSpark"
  >;
  stateStore: JsonOrchestratorStateStore;
  now?: () => Date;
};

type LobbyMessage = {
  roomId: string;
  eventId: string;
  sender: string;
  body: string;
};

export class MetaOrchestrator {
  private readonly config: OrchestratorConfig;
  private readonly deps: MetaOrchestratorDeps;
  private state: OrchestratorStateData;
  private sinceToken: string | undefined;
  private readonly inFlightEvents = new Set<string>();
  private readonly now: () => Date;

  constructor(config: OrchestratorConfig, deps: MetaOrchestratorDeps) {
    this.config = config;
    this.deps = deps;
    this.state = deps.stateStore.load();
    this.now = deps.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.deps.matrix.verifyConnection();
    this.deps.spark.verifyAvailability();

    await this.reconcileWorkspaceAndProjects();

    const lobbyRoomIds = this.getLobbyRoomIds();
    const sync = await this.deps.matrix.sync(undefined, 0, lobbyRoomIds);
    this.sinceToken = sync.next_batch;

    log("info", "MetaOrchestrator initialized.", {
      configPath: this.config.configPath,
      projects: this.config.projects.map((project) => project.key),
      lobbyRoomIds,
      stateFile: this.config.runtime.stateFile,
      syncTimeoutMs: this.config.runtime.syncTimeoutMs,
    });
  }

  async runLoop(shouldContinue: () => boolean): Promise<void> {
    while (shouldContinue()) {
      try {
        const lobbyRoomIds = this.getLobbyRoomIds();
        const sync = await this.deps.matrix.sync(this.sinceToken, this.config.runtime.syncTimeoutMs, lobbyRoomIds);
        await this.handleSync(sync);
        this.sinceToken = sync.next_batch;
      } catch (error) {
        log("error", "MetaOrchestrator loop failed.", {
          error: formatError(error),
        });
        await sleep(1500);
      }
    }
  }

  getState(): OrchestratorStateData {
    return this.state;
  }

  async reconcileWorkspaceAndProjects(): Promise<void> {
    const workspaceSpaceId = await this.ensureWorkspaceSpace();

    for (const project of this.config.projects) {
      await this.ensureProjectResources(project, workspaceSpaceId);
    }

    this.persistState();
  }

  async handleSync(sync: MatrixSyncResponse): Promise<void> {
    const joinMap = sync.rooms?.join;
    if (!joinMap) {
      return;
    }

    for (const project of this.config.projects) {
      const projectState = this.state.projects[project.key];
      const lobbyRoomId = projectState?.lobbyRoomId;
      if (!lobbyRoomId) {
        continue;
      }

      const roomTimeline = joinMap[lobbyRoomId]?.timeline?.events ?? [];
      for (const event of roomTimeline) {
        const message = this.toLobbyMessage(lobbyRoomId, event);
        if (!message) {
          continue;
        }

        await this.handleLobbyMessage(project, projectState, message);
      }
    }
  }

  async handleLobbyMessage(
    project: OrchestratorProjectConfig,
    projectState: ProjectStateRecord,
    message: LobbyMessage,
  ): Promise<void> {
    const dedupeKey = `${message.roomId}:${message.eventId}`;
    if (this.state.eventIndex[dedupeKey]) {
      return;
    }

    if (this.inFlightEvents.has(dedupeKey)) {
      return;
    }

    this.inFlightEvents.add(dedupeKey);

    try {
      await this.spawnTaskForLobbyMessage(project, projectState, message);
    } catch (error) {
      this.markFailedEvent(project, projectState, message, error);
    } finally {
      this.inFlightEvents.delete(dedupeKey);
      this.persistState();
    }
  }

  private async spawnTaskForLobbyMessage(
    project: OrchestratorProjectConfig,
    projectState: ProjectStateRecord,
    message: LobbyMessage,
  ): Promise<void> {
    const ids = buildTaskIdentifiers({
      projectKey: project.key,
      prompt: message.body,
      lobbyEventId: message.eventId,
      now: this.now(),
    });

    const taskRoomName = `${project.matrix.taskRoomPrefix} ${ids.roomLabel}`;
    const taskRecord: TaskStateRecord = {
      id: ids.taskId,
      projectKey: project.key,
      lobbyRoomId: message.roomId,
      lobbyEventId: message.eventId,
      status: "waiting",
      bridge: {},
      initialPrompt: message.body,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };

    this.state.tasks[taskRecord.id] = taskRecord;
    this.state.eventIndex[`${message.roomId}:${message.eventId}`] = taskRecord.id;
    this.persistState();

    const taskRoomId = await this.deps.matrix.createRoom(
      taskRoomName,
      `Task room for ${project.displayName}`,
      this.config.workspace.teamMembers,
    );

    taskRecord.taskRoomId = taskRoomId;
    taskRecord.taskRoomName = taskRoomName;
    taskRecord.updatedAt = this.now().toISOString();

    if (projectState.projectSpaceId) {
      await this.deps.matrix.linkRoomUnderSpace(projectState.projectSpaceId, taskRoomId);
    }

    await this.deps.matrix.sendNotice(
      taskRoomId,
      [
        "status: waiting",
        `project: ${project.key}`,
        `task_id: ${taskRecord.id}`,
        `source_lobby_event: ${message.eventId}`,
      ].join("\n"),
    );

    await this.deps.matrix.sendNotice(
      taskRoomId,
      [
        "Initial prompt from lobby:",
        truncate(message.body, 3000),
      ].join("\n"),
    );

    this.deps.spark.createTaskSparkFork({
      project: project.spark.project,
      taskSpark: ids.sparkName,
      mainSpark: project.spark.mainSpark,
      tags: {
        matrix_room_id: taskRoomId,
        matrix_project: project.key,
        matrix_lobby_room_id: message.roomId,
        matrix_lobby_event_id: message.eventId,
      },
    });

    taskRecord.sparkProject = project.spark.project;
    taskRecord.sparkName = ids.sparkName;
    taskRecord.updatedAt = this.now().toISOString();

    const bridgeEnv = this.buildBridgeEnv(project, ids.sparkName, taskRoomId, message.body);
    const launch = this.deps.spark.launchBridgeInSpark({
      project: project.spark.project,
      sparkName: ids.sparkName,
      bridgeEntrypoint: this.config.runtime.bridgeEntrypoint,
      bridgeWorkdir: this.config.runtime.bridgeWorkdir,
      env: bridgeEnv,
    });

    taskRecord.bridge = {
      pid: launch.pid,
      processId: launch.processId,
      rawOutput: launch.rawOutput,
    };
    this.setTaskStatus(taskRecord, "active");

    const roomLink = `https://matrix.to/#/${encodeURIComponent(taskRoomId)}`;
    await this.deps.matrix.sendNotice(
      message.roomId,
      [
        "Task created.",
        `project: ${project.key}`,
        `task_id: ${taskRecord.id}`,
        `room_id: ${taskRoomId}`,
        `room_link: ${roomLink}`,
        `spark: ${project.spark.project}:${ids.sparkName}`,
      ].join("\n"),
    );

    this.persistState();
  }

  private markFailedEvent(
    project: OrchestratorProjectConfig,
    projectState: ProjectStateRecord,
    message: LobbyMessage,
    error: unknown,
  ): void {
    const dedupeKey = `${message.roomId}:${message.eventId}`;
    const taskId = this.state.eventIndex[dedupeKey];
    const task = taskId ? this.state.tasks[taskId] : undefined;
    const reason = formatError(error);

    log("error", "Failed to spawn task from lobby message.", {
      project: project.key,
      roomId: message.roomId,
      eventId: message.eventId,
      error: reason,
    });

    if (task) {
      this.setTaskStatus(task, "error", reason);
      if (task.taskRoomId && !this.config.runtime.keepErrorRooms) {
        void this.deps.matrix.leaveAndForget(task.taskRoomId).catch((cleanupError) => {
          log("warn", "Failed to cleanup error task room.", {
            roomId: task.taskRoomId,
            taskId: task.id,
            error: formatError(cleanupError),
          });
        });
      }
    }

    void this.deps.matrix
      .sendNotice(
        message.roomId,
        [
          "Task creation failed.",
          `project: ${project.key}`,
          `event_id: ${message.eventId}`,
          `reason: ${truncate(reason, 1200)}`,
        ].join("\n"),
      )
      .catch((postError) => {
        log("warn", "Failed to post task failure notice to lobby.", {
          lobbyRoomId: message.roomId,
          eventId: message.eventId,
          error: formatError(postError),
        });
      });

    if (!taskId) {
      // Preserve idempotency even when we fail before a task object is created.
      this.state.eventIndex[dedupeKey] = `failed-${Date.now()}`;
    }

    if (!projectState.lobbyRoomId) {
      projectState.lobbyRoomId = message.roomId;
    }
  }

  private toLobbyMessage(roomId: string, event: MatrixSyncEvent): LobbyMessage | null {
    if (event.type !== "m.room.message") {
      return null;
    }

    if (!event.event_id || !event.sender || event.sender === this.config.botUserId) {
      return null;
    }

    const body = event.content?.body?.trim();
    if (!body) {
      return null;
    }

    if (body.startsWith("/")) {
      return null;
    }

    return {
      roomId,
      eventId: event.event_id,
      sender: event.sender,
      body,
    };
  }

  private buildBridgeEnv(
    project: OrchestratorProjectConfig,
    sparkName: string,
    roomId: string,
    initialPrompt: string,
  ): Record<string, string | undefined> {
    const passThrough: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) {
        continue;
      }
      if (key === "OPENAI_API_KEY" || key === "LOG_LEVEL" || key.startsWith("CODEX_")) {
        passThrough[key] = value;
      }
    }

    return {
      ...passThrough,
      MATRIX_HOMESERVER_URL: this.config.homeserverUrl,
      MATRIX_ACCESS_TOKEN: this.config.botAccessToken,
      MATRIX_BOT_USER: this.config.botUserId,
      MATRIX_ROOM_ID: roomId,
      PROJECT_KEY: project.key,
      SPARK_PROJECT: project.spark.project,
      SPARK_NAME: sparkName,
      INITIAL_PROMPT: initialPrompt,
    };
  }

  private async ensureWorkspaceSpace(): Promise<string> {
    const stateWorkspace = this.state.workspace;
    if (stateWorkspace.spaceId) {
      try {
        await this.deps.matrix.ensureJoinedRoom(stateWorkspace.spaceId);
        await this.deps.matrix.ensureInvites(stateWorkspace.spaceId, this.config.workspace.teamMembers);
        return stateWorkspace.spaceId;
      } catch (error) {
        log("warn", "Unable to reuse saved workspace space; creating a new one.", {
          spaceId: stateWorkspace.spaceId,
          error: formatError(error),
        });
      }
    }

    const created = await this.deps.matrix.createSpace(
      this.config.workspace.name,
      this.config.workspace.topic,
      this.config.workspace.teamMembers,
    );

    this.state.workspace = {
      name: this.config.workspace.name,
      topic: this.config.workspace.topic,
      spaceId: created,
      updatedAt: this.now().toISOString(),
    };

    return created;
  }

  private async ensureProjectResources(project: OrchestratorProjectConfig, workspaceSpaceId: string): Promise<void> {
    const existing = this.state.projects[project.key];
    const projectState: ProjectStateRecord = existing ?? {
      key: project.key,
      displayName: project.displayName,
      spark: {
        project: project.spark.project,
        base: project.spark.base,
        mainSpark: project.spark.mainSpark,
        workVolume: project.spark.work.volume,
        workMountPath: project.spark.work.mountPath,
      },
      updatedAt: this.now().toISOString(),
    };

    if (projectState.projectSpaceId) {
      try {
        await this.deps.matrix.ensureJoinedRoom(projectState.projectSpaceId);
      } catch {
        projectState.projectSpaceId = undefined;
      }
    }

    if (!projectState.projectSpaceId) {
      projectState.projectSpaceId = await this.deps.matrix.createSpace(
        project.displayName,
        `Project space for ${project.key}`,
        this.config.workspace.teamMembers,
      );
    }

    await this.deps.matrix.linkRoomUnderSpace(workspaceSpaceId, projectState.projectSpaceId);
    await this.deps.matrix.ensureInvites(projectState.projectSpaceId, this.config.workspace.teamMembers);

    if (projectState.lobbyRoomId) {
      try {
        await this.deps.matrix.ensureJoinedRoom(projectState.lobbyRoomId);
      } catch {
        projectState.lobbyRoomId = undefined;
      }
    }

    if (!projectState.lobbyRoomId) {
      projectState.lobbyRoomId = await this.deps.matrix.createRoom(
        project.matrix.lobbyRoomName,
        `Lobby for ${project.displayName}`,
        this.config.workspace.teamMembers,
      );
      projectState.lobbyRoomName = project.matrix.lobbyRoomName;
    }

    await this.deps.matrix.linkRoomUnderSpace(projectState.projectSpaceId, projectState.lobbyRoomId);
    await this.deps.matrix.ensureInvites(projectState.lobbyRoomId, this.config.workspace.teamMembers);

    this.deps.spark.ensureWorkVolume(project.spark.project, project.spark.work.volume);
    this.deps.spark.ensureMainSpark({
      project: project.spark.project,
      base: project.spark.base,
      mainSpark: project.spark.mainSpark,
      workVolume: project.spark.work.volume,
      workMountPath: project.spark.work.mountPath,
    });
    this.deps.spark.ensureRepoInMainSpark({
      project: project.spark.project,
      sparkName: project.spark.mainSpark,
      repo: project.repo,
      branch: project.defaultBranch,
      workdir: project.spark.work.mountPath,
    });
    this.deps.spark.runBootstrap({
      project: project.spark.project,
      sparkName: project.spark.mainSpark,
      workdir: project.spark.work.mountPath,
      scriptPath: project.spark.bootstrap.scriptIfExists,
      timeoutSec: project.spark.bootstrap.timeoutSec,
      retries: project.spark.bootstrap.retries,
    });

    projectState.updatedAt = this.now().toISOString();
    projectState.spark = {
      project: project.spark.project,
      base: project.spark.base,
      mainSpark: project.spark.mainSpark,
      workVolume: project.spark.work.volume,
      workMountPath: project.spark.work.mountPath,
    };

    this.state.projects[project.key] = projectState;
  }

  private setTaskStatus(task: TaskStateRecord, status: TaskStatus, reason?: string): void {
    task.status = status;
    task.statusReason = reason;
    task.updatedAt = this.now().toISOString();
  }

  private getLobbyRoomIds(): string[] {
    const roomIds = this.config.projects
      .map((project) => this.state.projects[project.key]?.lobbyRoomId)
      .filter((value): value is string => Boolean(value));

    return [...new Set(roomIds)];
  }

  private persistState(): void {
    this.deps.stateStore.save(this.state);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
