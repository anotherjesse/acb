import process from "node:process";

import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { loadOrchestratorConfig } from "../lib/config/orchestratorConfig.js";
import { MatrixClient } from "../lib/matrix/client.js";
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
  const config = loadOrchestratorConfig();
  const stateStore = new JsonOrchestratorStateStore(config.runtime.stateFile);

  const matrix = new MatrixClient({
    homeserverUrl: config.homeserverUrl,
    accessToken: config.botAccessToken,
    botUserId: config.botUserId,
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
    projects: config.projects.map((project) => project.key),
    stateFile: config.runtime.stateFile,
  });

  await orchestrator.initialize();
  await orchestrator.runLoop(() => isRunning);

  log("info", "MetaOrchestrator shutdown complete.");
}
