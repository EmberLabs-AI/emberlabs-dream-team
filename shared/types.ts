// Unique ID for each agent instance (generated on registration)
export type PeerId = string;

// Agent runtime that owns this peer. Drives discovery filters and signals to
// other peers what kind of inbound channel they can expect when sending here.
export type PeerType = "claude" | "codex";

// How this peer wants inbound messages delivered.
//   "auto"             — peer's own MCP server polls the broker and pushes via
//                        notifications/claude/channel (current Claude default).
//   "pull"             — peer drains via check_messages tool only (no auto-push).
//                        Use this when the host can't subscribe to dev channels.
//   "app-server-push"  — peer is Codex; a sidecar adapter watches the broker
//                        and injects upstream via Codex app-server turn/start
//                        or turn/steer.
export type DeliveryMode = "auto" | "pull" | "app-server-push";

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
  // New fields (added with the Codex peer work). Defaults at the broker keep
  // pre-Codex clients working unchanged.
  peer_type: PeerType;
  delivery_mode: DeliveryMode;
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  // Host identifier (os.hostname()). Required for cross-machine peer
  // uniqueness — PIDs alone collide across machines since each host has
  // its own ~15-17 bit PID space. Optional on the wire for backwards compat
  // with pre-fix clients; broker treats missing/empty as "unknown-host".
  machine_id?: string;
  // Optional on the wire for backwards compat. Broker defaults missing
  // values to "claude" / "auto" — the legacy Claude Code MCP behavior.
  peer_type?: PeerType;
  delivery_mode?: DeliveryMode;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface HeartbeatResponse {
  ok: boolean;
  // When true, the broker's heartbeat UPDATE affected 0 rows — the peer id
  // no longer exists in the registry (most likely evicted by another
  // client's /register call with a colliding pid). Client should treat
  // this as a signal to re-run /register with its full context.
  stale?: boolean;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
  // If false, the broker returns undelivered messages WITHOUT marking them
  // delivered. The caller must then call /ack with the message IDs it handled.
  // Default true preserves the original behavior for older clients.
  ack?: boolean;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  id: PeerId;
  ids: number[];
}
