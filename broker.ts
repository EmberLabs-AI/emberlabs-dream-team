#!/usr/bin/env bun
/**
 * dream-team broker daemon (formerly claude-peers)
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.DREAM_TEAM_PORT ?? "7899", 10);
const DB_PATH = process.env.DREAM_TEAM_DB ?? `${process.env.HOME}/.dream-team.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    machine_id TEXT NOT NULL DEFAULT '',
    peer_type TEXT NOT NULL DEFAULT 'claude',
    delivery_mode TEXT NOT NULL DEFAULT 'auto'
  )
`);

// Idempotent migrations — only ALTER if the column is missing.
// SQLite ALTER TABLE has no IF NOT EXISTS, so we guard on current schema.
const peerCols = db.query("PRAGMA table_info(peers)").all() as { name: string }[];
const hasCol = (name: string) => peerCols.some((c) => c.name === name);

// EMB-591: cross-machine PID dedup
if (!hasCol("machine_id")) {
  db.run("ALTER TABLE peers ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''");
}

// Codex peer work: peer_type + delivery_mode. Existing rows backfill via DEFAULT
// to 'claude' / 'auto' so the live Claude Code mesh keeps working unchanged.
if (!hasCol("peer_type")) {
  db.run("ALTER TABLE peers ADD COLUMN peer_type TEXT NOT NULL DEFAULT 'claude'");
}
if (!hasCol("delivery_mode")) {
  db.run("ALTER TABLE peers ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'auto'");
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Stale peers are determined by heartbeat freshness, not PID existence —
// process.kill(pid, 0) only works for local PIDs and wrongly prunes cross-machine peers.
const STALE_PEER_MS = 60_000;

function cleanStalePeers() {
  const cutoff = new Date(Date.now() - STALE_PEER_MS).toISOString();
  const stale = db.query("SELECT id FROM peers WHERE last_seen < ?").all(cutoff) as { id: string }[];
  for (const peer of stale) {
    db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
    db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, machine_id, peer_type, delivery_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

const markDeliveredForPeer = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  // Backwards compat: older clients omit machine_id. Treat as empty string
  // so their peers share a single "unknown-host" bucket, which keeps the
  // legacy single-machine behavior intact for same-host PID collisions
  // while no longer evicting peers on OTHER hosts.
  const machineId = body.machine_id ?? "";
  // Codex peer work: pre-Codex Claude Code clients omit these. Defaults
  // match the legacy behavior so the live Claude mesh keeps working.
  const peerType = body.peer_type ?? "claude";
  const deliveryMode = body.delivery_mode ?? "auto";

  // Dedup only within the SAME host. Previously the broker dedup'd on pid
  // alone, which silently evicted cross-machine peers whenever two macOS
  // hosts happened to produce the same ~15-17 bit pid — the root cause of
  // EMB-591.
  const existing = db
    .query("SELECT id FROM peers WHERE pid = ? AND machine_id = ?")
    .get(body.pid, machineId) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(
    id,
    body.pid,
    body.cwd,
    body.git_root,
    body.tty,
    body.summary,
    now,
    now,
    machineId,
    peerType,
    deliveryMode
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean; stale?: boolean } {
  const result = updateLastSeen.run(new Date().toISOString(), body.id);
  // Zero rows affected means the client's peer id no longer exists —
  // typically because another /register call from a colliding pid evicted
  // it. Signal stale so the client can re-register instead of sending
  // heartbeats into the void forever. The client-side recovery path was
  // the missing half of the EMB-591 fix.
  if (result.changes === 0) {
    return { ok: false, stale: true };
  }
  return { ok: true };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Filter by heartbeat freshness (works for local and cross-machine peers)
  const cutoff = Date.now() - STALE_PEER_MS;
  return peers.filter((p) => {
    if (new Date(p.last_seen).getTime() >= cutoff) return true;
    deletePeer.run(p.id);
    return false;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Default behavior (ack !== false) marks delivered immediately — preserves
  // backwards compatibility with older server.ts clients that don't call /ack.
  // New clients pass ack: false and call /ack explicitly after they've
  // surfaced each message to the LLM, so failed channel pushes don't evaporate
  // queue entries.
  if (body.ack !== false) {
    for (const msg of messages) {
      markDelivered.run(msg.id);
    }
  }

  return { messages };
}

function handleAckMessages(body: AckMessagesRequest, peerId: string): { ok: boolean; acked: number } {
  // Scope ACKs to the peer's own inbox to prevent cross-peer tampering.
  let acked = 0;
  for (const id of body.ids) {
    const result = markDeliveredForPeer.run(id, peerId);
    if (result.changes > 0) acked++;
  }
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: process.env.DREAM_TEAM_BIND ?? "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("dream-team broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          return Response.json(handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack": {
          const ackBody = body as AckMessagesRequest;
          if (!ackBody.id || !Array.isArray(ackBody.ids)) {
            return Response.json({ error: "invalid ack request" }, { status: 400 });
          }
          return Response.json(handleAckMessages(ackBody, ackBody.id));
        }
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[dream-team broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
