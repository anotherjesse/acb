import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "waiting" | "active" | "needs_input" | "completed" | "error";

export type ProjectStateRecord = {
  key: string;
  displayName: string;
  projectSpaceId?: string;
  lobbyRoomId?: string;
  lobbyRoomName?: string;
  spark: {
    project: string;
    base: string;
    mainSpark: string;
    workVolume: string;
    workMountPath: string;
  };
  updatedAt: string;
};

export type TaskStateRecord = {
  id: string;
  projectKey: string;
  lobbyRoomId: string;
  lobbyEventId: string;
  taskRoomId?: string;
  taskRoomName?: string;
  sparkProject?: string;
  sparkName?: string;
  status: TaskStatus;
  statusReason?: string;
  bridge: {
    pid?: number;
    processId?: string;
    rawOutput?: string;
  };
  initialPrompt: string;
  createdAt: string;
  updatedAt: string;
};

export type OrchestratorStateData = {
  version: number;
  workspace: {
    name?: string;
    spaceId?: string;
    topic?: string;
    updatedAt?: string;
  };
  projects: Record<string, ProjectStateRecord>;
  tasks: Record<string, TaskStateRecord>;
  eventIndex: Record<string, string>;
};

const CURRENT_VERSION = 1;

export class JsonOrchestratorStateStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): OrchestratorStateData {
    if (!fs.existsSync(this.filePath)) {
      return createDefaultState();
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<OrchestratorStateData>;
      if (!parsed || typeof parsed !== "object") {
        return createDefaultState();
      }

      return {
        version: CURRENT_VERSION,
        workspace: sanitizeWorkspace(parsed.workspace),
        projects: sanitizeProjects(parsed.projects),
        tasks: sanitizeTasks(parsed.tasks),
        eventIndex: sanitizeEventIndex(parsed.eventIndex),
      };
    } catch {
      return createDefaultState();
    }
  }

  save(state: OrchestratorStateData): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const payload = JSON.stringify(state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tempPath, "w", 0o600);

    try {
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, this.filePath);

    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Some filesystems do not support fsync on directory descriptors.
    }
  }

  hasProcessedEvent(state: OrchestratorStateData, roomId: string, eventId: string): boolean {
    return Boolean(state.eventIndex[eventKey(roomId, eventId)]);
  }

  markEventProcessed(state: OrchestratorStateData, roomId: string, eventId: string, taskId: string): void {
    state.eventIndex[eventKey(roomId, eventId)] = taskId;
  }
}

export function eventKey(roomId: string, eventId: string): string {
  return `${roomId}:${eventId}`;
}

export function createDefaultState(): OrchestratorStateData {
  return {
    version: CURRENT_VERSION,
    workspace: {},
    projects: {},
    tasks: {},
    eventIndex: {},
  };
}

function sanitizeWorkspace(value: unknown): OrchestratorStateData["workspace"] {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    name: asString(record.name),
    spaceId: asString(record.spaceId),
    topic: asString(record.topic),
    updatedAt: asString(record.updatedAt),
  };
}

function sanitizeProjects(value: unknown): Record<string, ProjectStateRecord> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, ProjectStateRecord> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const displayName = asString(entry.displayName);
    const spark = entry.spark;
    if (!displayName || !spark || typeof spark !== "object") {
      continue;
    }

    const sparkRecord = spark as Record<string, unknown>;
    const sparkProject = asString(sparkRecord.project);
    const sparkBase = asString(sparkRecord.base);
    const sparkMain = asString(sparkRecord.mainSpark);
    const sparkWorkVolume = asString(sparkRecord.workVolume);
    const sparkWorkMountPath = asString(sparkRecord.workMountPath);
    if (!sparkProject || !sparkBase || !sparkMain || !sparkWorkVolume || !sparkWorkMountPath) {
      continue;
    }

    result[key] = {
      key,
      displayName,
      projectSpaceId: asString(entry.projectSpaceId),
      lobbyRoomId: asString(entry.lobbyRoomId),
      lobbyRoomName: asString(entry.lobbyRoomName),
      spark: {
        project: sparkProject,
        base: sparkBase,
        mainSpark: sparkMain,
        workVolume: sparkWorkVolume,
        workMountPath: sparkWorkMountPath,
      },
      updatedAt: asString(entry.updatedAt) ?? new Date().toISOString(),
    };
  }

  return result;
}

function sanitizeTasks(value: unknown): Record<string, TaskStateRecord> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, TaskStateRecord> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const projectKey = asString(entry.projectKey);
    const lobbyRoomId = asString(entry.lobbyRoomId);
    const lobbyEventId = asString(entry.lobbyEventId);
    const status = asTaskStatus(entry.status);
    const initialPrompt = asString(entry.initialPrompt);
    const createdAt = asString(entry.createdAt);
    const updatedAt = asString(entry.updatedAt);

    if (!projectKey || !lobbyRoomId || !lobbyEventId || !status || !initialPrompt || !createdAt || !updatedAt) {
      continue;
    }

    const bridge = entry.bridge && typeof entry.bridge === "object" ? (entry.bridge as Record<string, unknown>) : {};

    result[key] = {
      id: asString(entry.id) ?? key,
      projectKey,
      lobbyRoomId,
      lobbyEventId,
      taskRoomId: asString(entry.taskRoomId),
      taskRoomName: asString(entry.taskRoomName),
      sparkProject: asString(entry.sparkProject),
      sparkName: asString(entry.sparkName),
      status,
      statusReason: asString(entry.statusReason),
      bridge: {
        pid: asNumber(bridge.pid),
        processId: asString(bridge.processId),
        rawOutput: asString(bridge.rawOutput),
      },
      initialPrompt,
      createdAt,
      updatedAt,
    };
  }

  return result;
}

function sanitizeEventIndex(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" && raw.length > 0) {
      result[key] = raw;
    }
  }

  return result;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function asTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === "waiting" || value === "active" || value === "needs_input" || value === "completed" || value === "error") {
    return value;
  }
  return undefined;
}
