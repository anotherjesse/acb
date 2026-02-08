import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import { parseSimpleYaml } from "./simpleYaml.js";
import { normalizeHomeserverUrl } from "../util/matrixUrl.js";

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config", "matrix-orchestrator.yaml");
export const DEFAULT_STATE_FILE = path.resolve(process.cwd(), "data", "orchestrator-state.json");

const runtimeSchema = z.object({
  state_file: z.string().min(1).optional(),
  bridge_entrypoint: z.string().min(1).optional(),
  bridge_workdir: z.string().min(1).optional(),
  sync_timeout_ms: z.number().int().positive().optional(),
  keep_error_rooms: z.boolean().optional(),
});

const sparkWorkSchema = z.object({
  volume: z.string().min(1),
  mount_path: z.string().min(1).default("/work"),
});

const sparkBootstrapSchema = z.object({
  script_if_exists: z.string().min(1).default("scripts/bootstrap.sh"),
  timeout_sec: z.number().int().positive().default(1800),
  retries: z.number().int().min(0).default(1),
});

const sparkServicesSchema = z.array(
  z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(false),
    data_volume: z.string().optional(),
    mount_path: z.string().optional(),
    init_script: z.string().optional(),
    start_script: z.string().optional(),
    stop_script: z.string().optional(),
  }),
);

const projectSchema = z.object({
  key: z.string().min(1),
  display_name: z.string().min(1),
  repo: z.string().min(1),
  default_branch: z.string().min(1),
  matrix: z.object({
    lobby_room_name: z.string().min(1),
    task_room_prefix: z.string().min(1),
  }),
  spark: z.object({
    project: z.string().min(1),
    base: z.string().min(1),
    main_spark: z.string().min(1),
    fork_mode: z.enum(["spark_fork", "explicit_data_clone"]),
    work: sparkWorkSchema,
    bootstrap: sparkBootstrapSchema,
    services: sparkServicesSchema.optional(),
  }),
});

const rawSchema = z.object({
  homeserver_url: z.string().min(1),
  bot_user_id: z.string().min(1),
  bot_access_token: z.string().min(1),
  workspace: z.object({
    name: z.string().min(1),
    topic: z.string().optional(),
    team_members: z.array(z.string().min(1)).default([]),
  }),
  runtime: runtimeSchema.optional(),
  projects: z.array(projectSchema).min(1),
});

export type OrchestratorProjectConfig = {
  key: string;
  displayName: string;
  repo: string;
  defaultBranch: string;
  matrix: {
    lobbyRoomName: string;
    taskRoomPrefix: string;
  };
  spark: {
    project: string;
    base: string;
    mainSpark: string;
    forkMode: "spark_fork";
    work: {
      volume: string;
      mountPath: string;
    };
    bootstrap: {
      scriptIfExists: string;
      timeoutSec: number;
      retries: number;
    };
  };
};

export type OrchestratorConfig = {
  configPath: string;
  homeserverUrl: string;
  botUserId: string;
  botAccessToken: string;
  workspace: {
    name: string;
    topic?: string;
    teamMembers: string[];
  };
  runtime: {
    stateFile: string;
    bridgeEntrypoint: string;
    bridgeWorkdir: string;
    syncTimeoutMs: number;
    keepErrorRooms: boolean;
  };
  projects: OrchestratorProjectConfig[];
};

export function resolveConfigPath(overridePath: string | undefined = process.env.MATRIX_ORCHESTRATOR_CONFIG): string {
  return overridePath && overridePath.trim().length > 0 ? path.resolve(overridePath.trim()) : DEFAULT_CONFIG_PATH;
}

export function loadOrchestratorConfig(overridePath?: string): OrchestratorConfig {
  const configPath = resolveConfigPath(overridePath);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing orchestrator config file: ${configPath}`);
  }

  const rawText = fs.readFileSync(configPath, "utf8");
  const parsedYaml = parseSimpleYaml(rawText);
  const raw = rawSchema.parse(parsedYaml);

  const projects: OrchestratorProjectConfig[] = raw.projects.map((project) => {
    if (project.spark.fork_mode !== "spark_fork") {
      throw new Error(
        `Project ${project.key} requested unsupported fork_mode=${project.spark.fork_mode}. Phase 1-2 supports only spark_fork.`,
      );
    }

    const enabledService = project.spark.services?.find((service) => service.enabled);
    if (enabledService) {
      throw new Error(
        `Project ${project.key} enables service ${enabledService.name}, but services are not supported in this phase.`,
      );
    }

    return {
      key: project.key,
      displayName: project.display_name,
      repo: project.repo,
      defaultBranch: project.default_branch,
      matrix: {
        lobbyRoomName: project.matrix.lobby_room_name,
        taskRoomPrefix: project.matrix.task_room_prefix,
      },
      spark: {
        project: project.spark.project,
        base: project.spark.base,
        mainSpark: project.spark.main_spark,
        forkMode: "spark_fork",
        work: {
          volume: project.spark.work.volume,
          mountPath: project.spark.work.mount_path,
        },
        bootstrap: {
          scriptIfExists: project.spark.bootstrap.script_if_exists,
          timeoutSec: project.spark.bootstrap.timeout_sec,
          retries: project.spark.bootstrap.retries,
        },
      },
    };
  });

  const dedupedProjectKeys = new Set<string>();
  for (const project of projects) {
    if (dedupedProjectKeys.has(project.key)) {
      throw new Error(`Duplicate project key in orchestrator config: ${project.key}`);
    }
    dedupedProjectKeys.add(project.key);
  }

  return {
    configPath,
    homeserverUrl: normalizeHomeserverUrl(raw.homeserver_url),
    botUserId: raw.bot_user_id,
    botAccessToken: raw.bot_access_token,
    workspace: {
      name: raw.workspace.name,
      topic: raw.workspace.topic,
      teamMembers: [...new Set(raw.workspace.team_members)],
    },
    runtime: {
      stateFile: path.resolve(raw.runtime?.state_file ?? DEFAULT_STATE_FILE),
      bridgeEntrypoint: raw.runtime?.bridge_entrypoint ?? "/spark/proj/agent-bridge/dist/index.js",
      bridgeWorkdir: raw.runtime?.bridge_workdir ?? "/work",
      syncTimeoutMs: raw.runtime?.sync_timeout_ms ?? 30_000,
      keepErrorRooms: raw.runtime?.keep_error_rooms ?? false,
    },
    projects,
  };
}
