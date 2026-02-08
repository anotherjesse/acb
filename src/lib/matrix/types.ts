export type MatrixRelatesTo = {
  rel_type?: string;
  event_id?: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: {
    event_id?: string;
  };
};

export type MatrixSyncEvent = {
  event_id?: string;
  sender?: string;
  type?: string;
  content?: {
    body?: string;
    msgtype?: string;
    "m.relates_to"?: MatrixRelatesTo;
  };
  origin_server_ts?: number;
};

export type MatrixSyncResponse = {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: MatrixSyncEvent[];
        };
      }
    >;
  };
};

export type MatrixCreateRoomResponse = {
  room_id: string;
};

export type MatrixSendMessageResponse = {
  event_id: string;
};

export type MatrixJoinedRoomsResponse = {
  joined_rooms?: string[];
};

export type MatrixRoomMembersResponse = {
  chunk?: Array<{
    state_key?: string;
    content?: {
      membership?: string;
    };
  }>;
};

export type MatrixWhoAmIResponse = {
  user_id: string;
  device_id?: string;
};

export type MatrixLoginResponse = {
  access_token: string;
  user_id: string;
  device_id?: string;
};
