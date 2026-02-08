import crypto from "node:crypto";

import { slugify } from "../util/strings.js";

export type TaskIdentifiers = {
  taskId: string;
  sparkName: string;
  roomLabel: string;
};

export function buildTaskIdentifiers(options: {
  projectKey: string;
  prompt: string;
  lobbyEventId: string;
  now?: Date;
}): TaskIdentifiers {
  const now = options.now ?? new Date();
  const timestamp = formatTimestamp(now);
  const hash = shortHash(`${options.projectKey}:${options.lobbyEventId}`);
  const slug = slugify(options.prompt, "task", 24);

  const baseSparkName = `task-${timestamp}-${slug}-${hash}`;
  const sparkName = baseSparkName.length <= 63 ? baseSparkName : baseSparkName.slice(0, 63);

  return {
    taskId: `${options.projectKey}-${timestamp}-${hash}`,
    sparkName,
    roomLabel: `${slug}-${hash}`,
  };
}

export function formatTimestamp(value: Date): string {
  const year = value.getUTCFullYear().toString().padStart(4, "0");
  const month = (value.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = value.getUTCDate().toString().padStart(2, "0");
  const hour = value.getUTCHours().toString().padStart(2, "0");
  const minute = value.getUTCMinutes().toString().padStart(2, "0");
  const second = value.getUTCSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function shortHash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 6);
}
