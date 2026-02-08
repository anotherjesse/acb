import { truncate } from "../util/strings.js";
import { normalizeHomeserverUrl } from "../util/matrixUrl.js";
import {
  MatrixCreateRoomResponse,
  MatrixJoinedRoomsResponse,
  MatrixLoginResponse,
  MatrixRoomMembersResponse,
  MatrixSendMessageResponse,
  MatrixSyncResponse,
  MatrixWhoAmIResponse,
} from "./types.js";

type MatrixRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: boolean;
};

type SendMessageOptions = {
  threadRootEventId?: string;
};

export async function loginWithPassword(options: {
  homeserverUrl: string;
  user: string;
  password: string;
  deviceId?: string;
}): Promise<MatrixLoginResponse> {
  const homeserverUrl = normalizeHomeserverUrl(options.homeserverUrl);
  const url = buildMatrixUrl(homeserverUrl, "/_matrix/client/v3/login");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: options.user,
      },
      password: options.password,
      device_id: options.deviceId,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Matrix password login failed (${response.status}): ${truncate(text, 1200)}`);
  }

  const login = JSON.parse(text) as MatrixLoginResponse;
  if (!login.access_token || !login.user_id) {
    throw new Error("Matrix password login response missing access_token/user_id.");
  }

  return login;
}

export class MatrixClient {
  readonly homeserverUrl: string;
  private accessToken: string;
  readonly botUserId: string;
  private txnCounter = 0;

  constructor(options: { homeserverUrl: string; accessToken: string; botUserId: string }) {
    this.homeserverUrl = normalizeHomeserverUrl(options.homeserverUrl);
    this.accessToken = options.accessToken;
    this.botUserId = options.botUserId;
  }

  async verifyConnection(): Promise<void> {
    await this.request("GET", "/_matrix/client/versions", { auth: false });
    const who = await this.whoami();
    if (!who.user_id) {
      throw new Error("Matrix whoami response missing user_id.");
    }
  }

  async whoami(): Promise<MatrixWhoAmIResponse> {
    return this.request<MatrixWhoAmIResponse>("GET", "/_matrix/client/v3/account/whoami", {
      auth: true,
    });
  }

  async ensureJoinedRoom(roomId: string): Promise<void> {
    const joined = await this.request<MatrixJoinedRoomsResponse>("GET", "/_matrix/client/v3/joined_rooms", {
      auth: true,
    });

    if (joined.joined_rooms?.includes(roomId)) {
      return;
    }

    await this.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      auth: true,
      body: {},
    });
  }

  async createSpace(name: string, topic: string | undefined, invites: string[]): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      preset: "private_chat",
      creation_content: {
        type: "m.space",
      },
    };

    if (topic) {
      body.topic = topic;
    }

    if (invites.length > 0) {
      body.invite = invites;
    }

    const created = await this.request<MatrixCreateRoomResponse>("POST", "/_matrix/client/v3/createRoom", {
      auth: true,
      body,
    });

    if (!created.room_id) {
      throw new Error("Matrix createSpace response did not include room_id.");
    }

    return created.room_id;
  }

  async createRoom(name: string, topic: string | undefined, invites: string[]): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      preset: "private_chat",
    };

    if (topic) {
      body.topic = topic;
    }

    if (invites.length > 0) {
      body.invite = invites;
    }

    const created = await this.request<MatrixCreateRoomResponse>("POST", "/_matrix/client/v3/createRoom", {
      auth: true,
      body,
    });

    if (!created.room_id) {
      throw new Error("Matrix createRoom response did not include room_id.");
    }

    return created.room_id;
  }

  async linkRoomUnderSpace(spaceId: string, roomId: string): Promise<void> {
    const via = inferViaServer(this.botUserId, this.homeserverUrl);
    const viaList = via ? [via] : [];

    await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
      {
        auth: true,
        body: {
          via: viaList,
        },
      },
    );

    await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.space.parent/${encodeURIComponent(spaceId)}`,
      {
        auth: true,
        body: {
          via: viaList,
          canonical: true,
        },
      },
    );
  }

  async getRoomMemberships(roomId: string): Promise<Map<string, string>> {
    const response = await this.request<MatrixRoomMembersResponse>(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
      {
        auth: true,
      },
    );

    const memberships = new Map<string, string>();
    for (const event of response.chunk ?? []) {
      if (!event.state_key || !event.content?.membership) {
        continue;
      }
      memberships.set(event.state_key, event.content.membership);
    }

    return memberships;
  }

  async ensureInvites(roomId: string, mxids: string[]): Promise<void> {
    if (mxids.length === 0) {
      return;
    }

    const memberships = await this.getRoomMemberships(roomId);
    const missing = mxids.filter((mxid) => {
      const membership = memberships.get(mxid);
      return membership !== "join" && membership !== "invite";
    });

    for (const mxid of missing) {
      await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
        auth: true,
        body: {
          user_id: mxid,
        },
      });
    }
  }

  async sync(since: string | undefined, timeoutMs: number, roomIds: string[]): Promise<MatrixSyncResponse> {
    const filter = JSON.stringify({
      room: {
        rooms: roomIds,
        timeline: {
          types: ["m.room.message"],
          limit: 100,
        },
      },
    });

    return this.request<MatrixSyncResponse>("GET", "/_matrix/client/v3/sync", {
      auth: true,
      query: {
        since,
        timeout: timeoutMs,
        filter,
      },
    });
  }

  async sendMessage(
    roomId: string,
    text: string,
    msgtype: "m.text" | "m.notice",
    options?: SendMessageOptions,
  ): Promise<string> {
    const txnId = this.nextTxnId();
    const body: Record<string, unknown> = {
      msgtype,
      body: truncate(text, 30_000),
    };

    if (options?.threadRootEventId) {
      body["m.relates_to"] = {
        rel_type: "m.thread",
        event_id: options.threadRootEventId,
        is_falling_back: true,
        "m.in_reply_to": {
          event_id: options.threadRootEventId,
        },
      };
    }

    const response = await this.request<MatrixSendMessageResponse>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        auth: true,
        body,
      },
    );

    if (!response.event_id) {
      throw new Error("Matrix sendMessage response did not include event_id.");
    }

    return response.event_id;
  }

  async sendNotice(roomId: string, text: string, options?: SendMessageOptions): Promise<string> {
    return this.sendMessage(roomId, text, "m.notice", options);
  }

  async sendTyping(roomId: string, timeoutMs: number): Promise<void> {
    await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.botUserId)}`,
      {
        auth: true,
        body: {
          typing: true,
          timeout: timeoutMs,
        },
      },
    );
  }

  async leaveAndForget(roomId: string): Promise<void> {
    try {
      await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
        auth: true,
        body: {},
      });
    } catch {
      // Best effort.
    }

    try {
      await this.request("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, {
        auth: true,
        body: {},
      });
    } catch {
      // Best effort.
    }
  }

  async doesEventExist(roomId: string, eventId: string): Promise<boolean> {
    try {
      await this.request(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        {
          auth: true,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(method: string, endpoint: string, options: MatrixRequestOptions): Promise<T> {
    const auth = options.auth ?? true;
    const url = buildMatrixUrl(this.homeserverUrl, endpoint, options.query);
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (auth) {
        headers.Authorization = `Bearer ${this.accessToken}`;
      }

      let body: string | undefined;
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }

      const response = await fetch(url, {
        method,
        headers,
        body,
      });

      const text = await response.text();
      if (response.ok) {
        if (!text) {
          return undefined as T;
        }

        try {
          return JSON.parse(text) as T;
        } catch {
          return text as T;
        }
      }

      if (response.status === 429 && attempt < maxAttempts) {
        const retryMs = extractRetryAfterMs(text, attempt);
        await sleep(retryMs);
        continue;
      }

      throw new Error(`Matrix API ${method} ${endpoint} failed (${response.status}): ${truncate(text, 1200)}`);
    }

    throw new Error(`Matrix API ${method} ${endpoint} failed: exhausted retries`);
  }

  private nextTxnId(): string {
    this.txnCounter += 1;
    return `mx-${Date.now()}-${this.txnCounter}`;
  }
}

export function buildMatrixUrl(
  homeserverUrl: string,
  endpoint: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const base = new URL(homeserverUrl.endsWith("/") ? homeserverUrl : `${homeserverUrl}/`);
  const basePath = base.pathname.replace(/\/$/, "");
  base.pathname = `${basePath}${endpoint}`;

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      base.searchParams.set(key, String(value));
    }
  }

  return base.toString();
}

function inferViaServer(matrixUserId: string, homeserverUrl: string): string | undefined {
  const mxidMatch = matrixUserId.match(/^[^:]+:(.+)$/);
  if (mxidMatch?.[1]) {
    return mxidMatch[1];
  }

  try {
    const parsed = new URL(homeserverUrl);
    return parsed.host || undefined;
  } catch {
    return undefined;
  }
}

function extractRetryAfterMs(body: string, attempt: number): number {
  try {
    const parsed = JSON.parse(body) as { retry_after_ms?: unknown };
    if (typeof parsed.retry_after_ms === "number" && Number.isFinite(parsed.retry_after_ms)) {
      return Math.max(250, Math.round(parsed.retry_after_ms));
    }
  } catch {
    // ignore parse errors
  }

  return Math.min(8_000, 500 * attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
