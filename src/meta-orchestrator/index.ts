import process from "node:process";

import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { loadOrchestratorConfig } from "../lib/config/orchestratorConfig.js";
import { loginWithPassword, MatrixClient } from "../lib/matrix/client.js";
import { SparkClient } from "../lib/spark/client.js";
import { JsonOrchestratorStateStore } from "../lib/state/orchestratorState.js";
import { formatError, log } from "../lib/util/log.js";
import { MetaOrchestrator } from "./service.js";

let isRunning = true;

process.once("SIGINT", () => {
  isRunning = false;
});

process.once("SIGTERM", () => {
  isRunning = false;
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection.", { reason: formatError(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception.", { error: formatError(error) });
});

void main().catch((error) => {
  log("error", "MetaOrchestrator fatal startup failure.", { error: formatError(error) });
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const loadedConfig = loadOrchestratorConfig();
  const stateStore = new JsonOrchestratorStateStore(loadedConfig.runtime.stateFile);
  const auth = await resolveMatrixAuth(loadedConfig);
  const config = {
    ...loadedConfig,
    botUserId: auth.userId,
    botAccessToken: auth.accessToken,
  };

  const matrix = new MatrixClient({
    homeserverUrl: config.homeserverUrl,
    accessToken: auth.accessToken,
    botUserId: auth.userId,
  });

  const spark = new SparkClient();

  const orchestrator = new MetaOrchestrator(config, {
    matrix,
    spark,
    stateStore,
  });

  log("info", "Booting MetaOrchestrator.", {
    configPath: config.configPath,
    homeserverUrl: config.homeserverUrl,
    botUserId: auth.userId,
    authMode: auth.mode,
    projects: config.projects.map((project) => project.key),
    stateFile: config.runtime.stateFile,
  });

  await orchestrator.initialize();
  await orchestrator.runLoop(() => isRunning);

  log("info", "MetaOrchestrator shutdown complete.");
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
