import { spawnSync } from "node:child_process";

import { toBashExports } from "../util/shell.js";
import { truncate } from "../util/strings.js";

export type SparkCommandResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SparkLaunchResult = {
  pid?: number;
  processId?: string;
  rawOutput: string;
};

type RunSparkOptions = {
  timeoutMs?: number;
  allowAlreadyExists?: boolean;
};

export class SparkClient {
  verifyAvailability(): void {
    this.runSpark(["--version"]);
  }

  ensureWorkVolume(project: string, volume: string): void {
    this.runSpark(["data", "create", volume, "--project", project], {
      allowAlreadyExists: true,
    });
  }

  ensureMainSpark(options: {
    project: string;
    base: string;
    mainSpark: string;
    workVolume: string;
    workMountPath: string;
  }): void {
    this.runSpark(
      [
        "create",
        options.mainSpark,
        "--project",
        options.project,
        "--base",
        options.base,
        "--data",
        `${options.workVolume}=${options.workMountPath}`,
      ],
      {
        allowAlreadyExists: true,
      },
    );
  }

  ensureRepoInMainSpark(options: {
    project: string;
    sparkName: string;
    repo: string;
    branch: string;
    workdir: string;
  }): void {
    const script = [
      "set -euo pipefail",
      `mkdir -p ${shellQuote(options.workdir)}`,
      `if [ ! -d ${shellQuote(options.workdir)}/.git ]; then`,
      `  git clone --branch ${shellQuote(options.branch)} ${shellQuote(options.repo)} ${shellQuote(options.workdir)}`,
      "else",
      `  cd ${shellQuote(options.workdir)}`,
      `  git remote set-url origin ${shellQuote(options.repo)}`,
      "  git fetch origin",
      `  git checkout ${shellQuote(options.branch)}`,
      `  git reset --hard ${shellQuote(`origin/${options.branch}`)}`,
      "fi",
    ].join("; ");

    this.runSparkExec(options.project, options.sparkName, ["/bin/bash", "-lc", script], {
      timeoutMs: 5 * 60_000,
    });
  }

  runBootstrap(options: {
    project: string;
    sparkName: string;
    workdir: string;
    scriptPath: string;
    timeoutSec: number;
    retries: number;
  }): void {
    const fullScript = `${options.workdir}/${options.scriptPath}`.replace(/\/+/g, "/");

    for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
      const script = [
        "set -euo pipefail",
        `cd ${shellQuote(options.workdir)}`,
        `if [ -f ${shellQuote(fullScript)} ]; then`,
        `  ${shellQuote(fullScript)}`,
        "fi",
      ].join("; ");

      try {
        this.runSparkExec(options.project, options.sparkName, ["/bin/bash", "-lc", script], {
          timeoutMs: options.timeoutSec * 1000,
        });
        return;
      } catch (error) {
        if (attempt > options.retries) {
          throw error;
        }
      }
    }
  }

  createTaskSparkFork(options: {
    project: string;
    taskSpark: string;
    mainSpark: string;
    tags: Record<string, string>;
  }): void {
    this.runSpark(buildSparkCreateForkArgs(options));
  }

  launchBridgeInSpark(options: {
    project: string;
    sparkName: string;
    bridgeEntrypoint: string;
    bridgeWorkdir: string;
    env: Record<string, string | undefined>;
  }): SparkLaunchResult {
    const args = buildSparkExecBridgeArgs({
      project: options.project,
      sparkName: options.sparkName,
      bridgeEntrypoint: options.bridgeEntrypoint,
      bridgeWorkdir: options.bridgeWorkdir,
      env: options.env,
    });

    const result = this.runSpark(args);
    const output = `${result.stdout}\n${result.stderr}`.trim();

    const pidMatch = output.match(/\bpid\s*[:=]\s*(\d+)/i);
    const processMatch = output.match(/\bprocess(?:_id)?\s*[:=]\s*([\w.-]+)/i);

    return {
      pid: pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : undefined,
      processId: processMatch?.[1],
      rawOutput: truncate(output, 2000),
    };
  }

  runSparkExec(project: string, sparkName: string, command: string[], options?: RunSparkOptions): SparkCommandResult {
    return this.runSpark(["exec", `${project}:${sparkName}`, "--", ...command], options);
  }

  private runSpark(args: string[], options?: RunSparkOptions): SparkCommandResult {
    const result = spawnSync("spark", args, {
      encoding: "utf8",
      timeout: options?.timeoutMs,
    });

    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    const exitCode = result.status ?? 1;

    const commandResult: SparkCommandResult = {
      command: "spark",
      args,
      stdout,
      stderr,
      exitCode,
    };

    if (exitCode === 0) {
      return commandResult;
    }

    const combined = `${stdout}\n${stderr}`;
    if (options?.allowAlreadyExists && /already exists|exists/i.test(combined)) {
      return commandResult;
    }

    throw new Error(
      `Spark command failed (${exitCode}): spark ${args.join(" ")} :: ${truncate(combined.trim(), 1500)}`,
    );
  }
}

export function buildSparkCreateForkArgs(options: {
  project: string;
  taskSpark: string;
  mainSpark: string;
  tags: Record<string, string>;
}): string[] {
  const args = ["create", options.taskSpark, "--project", options.project, "--fork", options.mainSpark];
  for (const [key, value] of Object.entries(options.tags)) {
    args.push("-t", `${key}=${value}`);
  }
  return args;
}

export function buildSparkExecBridgeArgs(options: {
  project: string;
  sparkName: string;
  bridgeEntrypoint: string;
  bridgeWorkdir: string;
  env: Record<string, string | undefined>;
}): string[] {
  const exportScript = toBashExports(options.env);
  const scriptPrefix = exportScript ? `${exportScript}; ` : "";
  const script = `${scriptPrefix}cd ${shellQuote(options.bridgeWorkdir)}; node ${shellQuote(options.bridgeEntrypoint)}`;

  return ["exec", `${options.project}:${options.sparkName}`, "--bg", "--", "/bin/bash", "-lc", script];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
