import process from "node:process";

import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { loadOrchestratorConfig } from "../lib/config/orchestratorConfig.js";
import { loginWithPassword, MatrixClient } from "../lib/matrix/client.js";
import { SparkClient } from "../lib/spark/client.js";
import { JsonOrchestratorStateStore } from "../lib/state/orchestratorState.js";
import { formatError, log } from "../lib/util/log.js";
import { MetaOrchestrator } from "./service.js";

void main().catch((error) => {
  log("error", "init-dev failed.", { error: formatError(error) });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const loadedConfig = loadOrchestratorConfig();
  const auth = await resolveMatrixAuth(loadedConfig);

  const config = {
    ...loadedConfig,
    botUserId: auth.userId,
    botAccessToken: auth.accessToken,
  };

  const stateStore = new JsonOrchestratorStateStore(config.runtime.stateFile);
  const matrix = new MatrixClient({
    homeserverUrl: config.homeserverUrl,
    accessToken: auth.accessToken,
    botUserId: auth.userId,
  });
  const spark = new SparkClient();

  const sourceSpark = process.env.INIT_DEV_SOURCE_SPARK?.trim() || "dev";
  const allowBaseSaveFallback = (process.env.INIT_DEV_ALLOW_BASE_SAVE ?? "false").trim().toLowerCase() === "true";

  log("info", "init-dev starting.", {
    configPath: config.configPath,
    botUserId: auth.userId,
    authMode: auth.mode,
    sourceSpark,
    allowBaseSaveFallback,
    projects: config.projects.map((project) => project.key),
  });

  spark.verifyAvailability();
  const existingBases = spark.listBaseNames();

  for (const project of config.projects) {
    // First-run bootstrap strategy: seed missing project-main by forking an existing dev spark.
    spark.ensureWorkVolume(project.spark.project, project.spark.work.volume);
    spark.ensureSparkForked({
      project: project.spark.project,
      sparkName: project.spark.mainSpark,
      sourceSpark,
      tags: {
        init_source_spark: sourceSpark,
        matrix_project: project.key,
      },
    });

    if (!existingBases.includes(project.spark.base)) {
      if (!allowBaseSaveFallback) {
        log("warn", "Configured base is missing; continuing without base creation (main spark seeded by fork).", {
          project: project.key,
          base: project.spark.base,
          sourceSpark,
        });
        continue;
      }

      log("warn", "Configured base is missing; creating from source spark (fallback enabled).", {
        project: project.key,
        base: project.spark.base,
        sourceSpark,
      });
      spark.ensureBaseFromSpark(project.spark.base, sourceSpark);
    }
  }

  const orchestrator = new MetaOrchestrator(config, {
    matrix,
    spark,
    stateStore,
  });

  await orchestrator.initialize();
  await orchestrator.reconcileWorkspaceAndProjects();

  const state = orchestrator.getState();
  const summary = config.projects.map((project) => {
    const projectState = state.projects[project.key];
    return {
      project: project.key,
      projectSpaceId: projectState?.projectSpaceId,
      lobbyRoomId: projectState?.lobbyRoomId,
      mainSpark: project.spark.mainSpark,
      sparkBase: project.spark.base,
      workVolume: project.spark.work.volume,
    };
  });

  log("info", "init-dev completed.", { summary });
}

async function resolveMatrixAuth(config: ReturnType<typeof loadOrchestratorConfig>): Promise<{
  mode: "access_token" | "password";
  userId: string;
  accessToken: string;
}> {
  if (config.botAccessToken) {
    return {
      mode: "access_token",
      userId: config.botUserId,
      accessToken: config.botAccessToken,
    };
  }

  if (!config.botPassword) {
    throw new Error("Missing Matrix bot credentials: configure bot_access_token or bot_password.");
  }

  const login = await loginWithPassword({
    homeserverUrl: config.homeserverUrl,
    user: config.botUserId,
    password: config.botPassword,
  });

  return {
    mode: "password",
    userId: login.user_id,
    accessToken: login.access_token,
  };
}
