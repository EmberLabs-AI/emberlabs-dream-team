#!/usr/bin/env bun
/**
 * Codex peer adapter for claude-peers.
 *
 * Modes:
 *   bun codex-server.ts proxy  # WebSocket proxy: Codex TUI -> adapter -> real Codex app-server
 *   bun codex-server.ts mcp    # MCP stdio tools exposed inside Codex
 *
 * The proxy owns the Codex peer registration and automatic inbound delivery.
 * The MCP mode reads the proxy state file and gives the model explicit tools
 * to list peers, send replies, set a summary, and manually drain as fallback.
 */

import { hostname } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AckMessagesRequest,
  HeartbeatResponse,
  Message,
  Peer,
  PeerId,
  PollMessagesResponse,
  RegisterRequest,
  RegisterResponse,
} from "./shared/types.ts";

type AppServerRequest = {
  id: number | string;
  method: string;
  params?: unknown;
};

type AppServerResponse = {
  id?: number | string;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
};

type CodexPeerState = {
  peer_id: PeerId;
  broker_url: string;
  cwd: string;
  git_root: string | null;
  proxy_url: string;
  real_app_server_url: string;
  thread_id: string | null;
  summary: string;
  updated_at: string;
};

const BROKER_PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = process.env.CLAUDE_PEERS_BROKER_URL ?? `http://127.0.0.1:${BROKER_PORT}`;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;
const PROXY_PORT = parseInt(process.env.CODEX_PEERS_PROXY_PORT ?? "7900", 10);
const REAL_APP_SERVER_PORT = parseInt(process.env.CODEX_PEERS_REAL_APP_SERVER_PORT ?? "7901", 10);
const PROXY_URL = `ws://127.0.0.1:${PROXY_PORT}`;
const REAL_APP_SERVER_URL = `ws://127.0.0.1:${REAL_APP_SERVER_PORT}`;
const REAL_READY_URL = `http://127.0.0.1:${REAL_APP_SERVER_PORT}/readyz`;
const STATE_PATH =
  process.env.CODEX_PEERS_STATE ??
  join(process.env.HOME ?? ".", ".claude-peers", "codex-active.json");
const POLL_INTERVAL_MS = parseInt(process.env.CODEX_PEERS_POLL_INTERVAL_MS ?? "1000", 10);
const HEARTBEAT_INTERVAL_MS = 15_000;

function log(msg: string) {
  console.error(`[codex-peers] ${msg}`);
}

async function brokerFetch<T>(path: string, body: unknown, brokerUrl = BROKER_URL): Promise<T> {
  const res = await fetch(`${brokerUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function brokerIsLocal(): boolean {
  try {
    const host = new URL(BROKER_URL).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) return;
  if (!brokerIsLocal()) {
    throw new Error(`Remote broker is not reachable: ${BROKER_URL}`);
  }

  log("Starting local broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    if (await isBrokerAlive()) return;
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

async function ensureRealAppServer(): Promise<void> {
  try {
    const res = await fetch(REAL_READY_URL, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      log(`Real Codex app-server already running at ${REAL_APP_SERVER_URL}`);
      return;
    }
  } catch {
    // start below
  }

  log(`Starting real Codex app-server at ${REAL_APP_SERVER_URL}`);
  const proc = Bun.spawn(["codex", "app-server", "--listen", REAL_APP_SERVER_URL], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200);
    try {
      const res = await fetch(REAL_READY_URL, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // keep waiting
    }
  }
  throw new Error("Failed to start real Codex app-server after 10 seconds");
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

function readState(): CodexPeerState {
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as CodexPeerState;
}

function writeState(state: CodexPeerState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  state.updated_at = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function xmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}

async function peerContext(cwd: string, gitRoot: string | null): Promise<Map<string, Peer>> {
  const peers = await brokerFetch<Peer[]>("/list-peers", {
    scope: "machine",
    cwd,
    git_root: gitRoot,
  });
  return new Map(peers.map((peer) => [peer.id, peer]));
}

function formatPeerMessages(messages: Message[], peers: Map<string, Peer>): string {
  return messages
    .map((message) => {
      const sender = peers.get(message.from_id);
      const summary = sender?.summary ?? "";
      const cwd = sender?.cwd ?? "";
      const type = sender?.peer_type ?? "claude";
      return `<peer_message from="${xmlAttr(message.from_id)}" peer_type="${xmlAttr(type)}" summary="${xmlAttr(summary)}" cwd="${xmlAttr(cwd)}" sent_at="${xmlAttr(message.sent_at)}">\n${message.text}\n</peer_message>`;
    })
    .join("\n\n");
}

async function runProxy() {
  await ensureBroker();
  await ensureRealAppServer();

  const cwd = process.cwd();
  const gitRoot = await getGitRoot(cwd);
  const summary = `Codex peer in ${cwd}`;
  const machineId = hostname();

  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd,
    git_root: gitRoot,
    tty: null,
    summary,
    machine_id: machineId,
    peer_type: "codex",
    delivery_mode: "app-server-push",
  } satisfies RegisterRequest);

  let state: CodexPeerState = {
    peer_id: reg.id,
    broker_url: BROKER_URL,
    cwd,
    git_root: gitRoot,
    proxy_url: PROXY_URL,
    real_app_server_url: REAL_APP_SERVER_URL,
    thread_id: null,
    summary,
    updated_at: new Date().toISOString(),
  };
  writeState(state);
  log(`Registered Codex peer ${reg.id} (broker=${BROKER_URL})`);

  let upstream: WebSocket | null = null;
  let downstream: Bun.ServerWebSocket<unknown> | null = null;
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let turnInFlight = false;
  let pendingTurnStart = false;
  let nextAdapterRequestId = 1_000_000;
  const clientRequests = new Map<number | string, string>();
  const adapterRequests = new Map<number | string, { messageIds: number[]; kind: string }>();
  const claimedMessages = new Set<number>();
  const pendingClientMessages: string[] = [];

  function updateThread(nextThreadId: string | null) {
    threadId = nextThreadId;
    state = { ...state, thread_id: threadId };
    writeState(state);
  }

  function sendUpstream(message: AppServerRequest) {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      throw new Error("Codex upstream app-server is not connected");
    }
    upstream.send(JSON.stringify(message));
  }

  function forwardClientMessage(text: string) {
    try {
      const message = JSON.parse(text) as AppServerRequest;
      if (message.id !== undefined) clientRequests.set(message.id, message.method);
    } catch {
      // Forward opaque bytes if the protocol changes.
    }

    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      pendingClientMessages.push(text);
      return;
    }

    upstream.send(text);
  }

  async function ackMessages(ids: number[]) {
    if (ids.length === 0) return;
    try {
      await brokerFetch("/ack", { id: state.peer_id, ids } satisfies AckMessagesRequest);
    } finally {
      for (const id of ids) claimedMessages.delete(id);
    }
  }

  async function injectMessages(messages: Message[]) {
    if (!threadId || messages.length === 0 || pendingTurnStart) return;

    const peers = await peerContext(cwd, gitRoot);
    const peerPayload = formatPeerMessages(messages, peers);
    const id = nextAdapterRequestId++;
    const messageIds = messages.map((message) => message.id);
    const canSteer = turnInFlight && activeTurnId;

    const request: AppServerRequest = canSteer
      ? {
          id,
          method: "turn/steer",
          params: {
            threadId,
            expectedTurnId: activeTurnId,
            input: [textInput(peerPayload)],
          },
        }
      : {
          id,
          method: "turn/start",
          params: {
            threadId,
            input: [textInput(peerPayload)],
            cwd,
            approvalPolicy: "never",
          },
        };

    if (!canSteer) pendingTurnStart = true;
    adapterRequests.set(id, { messageIds, kind: request.method });
    sendUpstream(request);
    log(`Injected ${messages.length} peer message(s) via ${request.method}`);
  }

  async function pollAndInject() {
    if (!threadId || !upstream || upstream.readyState !== WebSocket.OPEN) return;
    try {
      const result = await brokerFetch<PollMessagesResponse>("/poll-messages", {
        id: state.peer_id,
        ack: false,
      });
      const fresh = result.messages.filter((message) => !claimedMessages.has(message.id));
      if (fresh.length === 0) return;
      for (const message of fresh) claimedMessages.add(message.id);
      await injectMessages(fresh);
    } catch (e) {
      log(`Poll/inject error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const server = Bun.serve({
    port: PROXY_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("codex-peers websocket proxy", { status: 200 });
    },
    websocket: {
      async open(ws) {
        if (downstream) {
          ws.close(1013, "codex-peers supports one Codex TUI connection for now");
          return;
        }
        downstream = ws;
        upstream = new WebSocket(REAL_APP_SERVER_URL);

        upstream.addEventListener("open", () => {
          log(`Proxy connected: TUI -> ${PROXY_URL} -> ${REAL_APP_SERVER_URL}`);
          while (pendingClientMessages.length > 0 && upstream?.readyState === WebSocket.OPEN) {
            upstream.send(pendingClientMessages.shift()!);
          }
        });

        upstream.addEventListener("message", async (event) => {
          const message = JSON.parse(event.data.toString()) as AppServerResponse;

          if (message.id !== undefined && adapterRequests.has(message.id)) {
            const request = adapterRequests.get(message.id)!;
            adapterRequests.delete(message.id);
            if (request.kind === "turn/start") pendingTurnStart = false;
            if (message.error) {
              log(`Adapter ${request.kind} failed: ${JSON.stringify(message.error)}`);
              for (const id of request.messageIds) claimedMessages.delete(id);
            } else {
              await ackMessages(request.messageIds);
            }
            return;
          }

          if (message.id !== undefined && clientRequests.has(message.id)) {
            const method = clientRequests.get(message.id);
            clientRequests.delete(message.id);
            if ((method === "thread/start" || method === "thread/resume") && message.result) {
              const result = message.result as { thread?: { id?: string } };
              if (result.thread?.id) updateThread(result.thread.id);
            }
          }

          if (message.method === "thread/started") {
            const params = message.params as { thread?: { id?: string } };
            if (params.thread?.id) updateThread(params.thread.id);
          } else if (message.method === "turn/started") {
            const params = message.params as { turn?: { id?: string } };
            activeTurnId = params.turn?.id ?? null;
            turnInFlight = Boolean(activeTurnId);
            pendingTurnStart = false;
          } else if (message.method === "turn/completed") {
            activeTurnId = null;
            turnInFlight = false;
            pendingTurnStart = false;
          }

          ws.send(JSON.stringify(message));
        });

        upstream.addEventListener("close", () => {
          log("Upstream app-server websocket closed");
          upstream = null;
          ws.close();
        });

        upstream.addEventListener("error", (e) => {
          log(`Upstream websocket error: ${String(e)}`);
          ws.close();
        });
      },
      message(_ws, raw) {
        forwardClientMessage(raw.toString());
      },
      close() {
        downstream = null;
        upstream?.close();
        upstream = null;
        pendingClientMessages.length = 0;
        activeTurnId = null;
        turnInFlight = false;
        pendingTurnStart = false;
      },
    },
  });

  log(`Listening for Codex TUI at ws://127.0.0.1:${server.port}`);
  log(`Launch Codex with: codex --remote ws://127.0.0.1:${server.port}`);

  const pollTimer = setInterval(pollAndInject, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(async () => {
    try {
      const res = await brokerFetch<HeartbeatResponse>("/heartbeat", { id: state.peer_id });
      if (res.stale) {
        const next = await brokerFetch<RegisterResponse>("/register", {
          pid: process.pid,
          cwd,
          git_root: gitRoot,
          tty: null,
          summary: state.summary,
          machine_id: machineId,
          peer_type: "codex",
          delivery_mode: "app-server-push",
        } satisfies RegisterRequest);
        state = { ...state, peer_id: next.id };
        writeState(state);
        log(`Re-registered as Codex peer ${next.id}`);
      }
    } catch {
      // Broker may be briefly unavailable.
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    try {
      await brokerFetch("/unregister", { id: state.peer_id });
    } catch {
      // best effort
    }
    try {
      rmSync(STATE_PATH);
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

const TOOLS = [
  {
    name: "list_peers",
    description: "List other agent peers by machine, directory, or repo.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to another agent peer by peer ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const },
        message: { type: "string" as const },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description: "Set a short summary for this Codex peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Fallback manual drain for messages if automatic app-server delivery is unavailable.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

async function runMcp() {
  const mcp = new Server(
    { name: "codex-peers", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: `You are connected to the peer network. Incoming peer messages should arrive automatically through Codex app-server injection. Use send_message to reply, list_peers to discover agents, and set_summary to describe your current work.`,
    }
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const state = readState();
    const { name, arguments: args } = req.params;

    switch (name) {
      case "list_peers": {
        const scope = (args as { scope: "machine" | "directory" | "repo" }).scope;
        const peers = await brokerFetch<Peer[]>(
          "/list-peers",
          {
            scope,
            cwd: state.cwd,
            git_root: state.git_root,
            exclude_id: state.peer_id,
          },
          state.broker_url
        );
        if (peers.length === 0) {
          return { content: [{ type: "text" as const, text: `No peers found (scope: ${scope}).` }] };
        }
        const text = peers
          .map((peer) => {
            const parts = [
              `ID: ${peer.id}`,
              `Type: ${peer.peer_type ?? "claude"} (delivery: ${peer.delivery_mode ?? "auto"})`,
              `PID: ${peer.pid}`,
              `CWD: ${peer.cwd}`,
            ];
            if (peer.git_root) parts.push(`Repo: ${peer.git_root}`);
            if (peer.summary) parts.push(`Summary: ${peer.summary}`);
            parts.push(`Last seen: ${peer.last_seen}`);
            return parts.join("\n  ");
          })
          .join("\n\n");
        return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s):\n\n${text}` }] };
      }
      case "send_message": {
        const { to_id, message } = args as { to_id: string; message: string };
        const result = await brokerFetch<{ ok: boolean; error?: string }>(
          "/send-message",
          {
            from_id: state.peer_id,
            to_id,
            text: message,
          },
          state.broker_url
        );
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }] };
      }
      case "set_summary": {
        const { summary } = args as { summary: string };
        await brokerFetch("/set-summary", { id: state.peer_id, summary }, state.broker_url);
        writeState({ ...state, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      }
      case "check_messages": {
        const result = await brokerFetch<PollMessagesResponse>(
          "/poll-messages",
          {
            id: state.peer_id,
            ack: false,
          },
          state.broker_url
        );
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No new messages." }] };
        }
        await brokerFetch(
          "/ack",
          {
            id: state.peer_id,
            ids: result.messages.map((message) => message.id),
          } satisfies AckMessagesRequest,
          state.broker_url
        );
        const lines = result.messages.map(
          (message) => `From ${message.from_id} (${message.sent_at}):\n${message.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");
}

const mode = process.argv[2] ?? "mcp";
if (mode === "proxy") {
  runProxy().catch((e) => {
    log(`Fatal proxy error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
} else if (mode === "mcp") {
  runMcp().catch((e) => {
    log(`Fatal MCP error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
} else {
  console.error("Usage: bun codex-server.ts [proxy|mcp]");
  process.exit(2);
}
