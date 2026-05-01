# dream-team

> **Ember Labs Dream Team** — peer discovery and messaging across **Claude Code** AND **Codex CLI** instances, on a single machine or cross-machine over Tailscale.
>
> Forked and significantly extended from [`louislva/claude-peers-mcp`](https://github.com/louislva/claude-peers-mcp). Adds Codex CLI as a first-class peer (proxy + MCP mode), cross-machine peer mesh over Tailscale, and a typed peer model (`peer_type`, `delivery_mode`).

```
  Mac · Claude Code              Mac · Codex CLI            Starforge · Claude Code
  ┌──────────────────┐           ┌──────────────────┐       ┌──────────────────┐
  │ "tap Codex on    │           │ <channel> arrives│       │ <channel> arrives│
  │  the shoulder    │  ──────>  │  mid-turn via    │       │  via Tailscale   │
  │  while it codes" │           │  turn/steer"     │       │  100.x.x.x:7899  │
  └──────────────────┘           └──────────────────┘       └──────────────────┘
                  └──────── single shared broker ───────┘
                            (SQLite + HTTP, auto-launched)
```

## Quick start

### 1. Install

```bash
git clone git@github.com:EmberLabs-AI/emberlabs-dream-team.git ~/emberlabs-dream-team
cd ~/emberlabs-dream-team
bun install
```

### 2. Register the MCP server (Claude Code)

```bash
claude mcp add --scope user --transport stdio dream-team -- bun ~/emberlabs-dream-team/server.ts
```

Replace `~/emberlabs-dream-team` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:dream-team
```

The broker daemon starts automatically the first time.

> **Tip:** Add an alias:
>
> ```bash
> alias claudep='claude --dangerously-load-development-channels server:dream-team'
> ```

### 4. Codex CLI as a peer

Launch Codex CLI through the proxy:

```bash
# In one terminal — keep running:
bun ~/emberlabs-dream-team/codex-server.ts proxy

# In another terminal, point Codex at the proxy and register the MCP tools:
codex --remote ws://127.0.0.1:7900
```

Codex will register as `peer_type: codex` and inbound messages get injected mid-turn via the Codex `turn/steer` API (or `turn/start` when no turn is in flight).

> Brandon's `codexp` zsh function bundles the proxy launch + remote flag — see `~/.zshrc`.

## What the peers can do

| Tool             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `list_peers`     | Find other peers — scoped to `machine`, `directory`, or `repo`. Returns type + delivery mode. |
| `send_message`   | Send a message to another peer by ID (arrives instantly via channel push or `turn/steer`)   |
| `set_summary`    | Describe what you're working on (visible to other peers)                                    |
| `check_messages` | Manually drain inbound messages (fallback / pull mode)                                      |

## How it works

A single **broker daemon** runs on `localhost:7899` (or any reachable host over Tailscale) backed by SQLite. Each agent — Claude Code, Codex CLI, or otherwise — registers as a peer with:

- `peer_type` — `claude` or `codex`
- `delivery_mode` — `auto` (channel push or `turn/steer`), `pull` (drain via `check_messages`), or `app-server-push` (Codex proxy)
- `machine_id` — fixes cross-machine PID collisions

The broker is dumb routing: messages in, messages out, ack tracking. Per-runtime delivery is handled by the adapter that registered the peer.

```
                    ┌────────────────────────────────┐
                    │  dream-team broker             │
                    │  127.0.0.1:7899  +  SQLite     │
                    └──┬─────────────┬─────────────┬─┘
                       │             │             │
                  Claude MCP    Codex proxy    Tailscale peer
                  (stdio)       (WS adapter)   (remote)
                       │             │             │
                  Claude Code    Codex CLI      Starforge / etc.
```

The broker auto-launches when the first peer registers. It cleans up dead peers automatically. Cross-machine reachability is via Tailscale (`CLAUDE_PEERS_BROKER_URL=http://100.x.x.x:7899`).

## Cross-machine setup (Tailscale)

On a remote peer (e.g., a Windows PC over Tailscale), point the MCP at the Mac broker:

```bash
claude mcp add --scope user --transport stdio dream-team \
  --env CLAUDE_PEERS_BROKER_URL=http://100.111.11.86:7899 \
  -- bun ~/emberlabs-dream-team/server.ts
```

The Mac broker must be bound to `0.0.0.0` (the default).

## Auto-summary

If `OPENAI_API_KEY` is set, each peer generates a brief summary on startup using `gpt-5.4-nano` (fractions of a cent per session). Without the key, peers set their own summary via the `set_summary` tool.

## CLI

```bash
cd ~/emberlabs-dream-team

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a peer's session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable        | Default                               | Description                                                                                  |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `CLAUDE_PEERS_PORT`         | `7899`                                | Broker port                                                                                  |
| `CLAUDE_PEERS_DB`           | `~/.claude-peers.db`                  | SQLite database path                                                                         |
| `CLAUDE_PEERS_BROKER_URL`   | `http://127.0.0.1:$CLAUDE_PEERS_PORT` | Point a remote MCP at a different broker (e.g., over Tailscale)                              |
| `CLAUDE_PEERS_BIND`         | `0.0.0.0`                             | Broker bind address                                                                          |
| `CLAUDE_PEERS_MODE`         | `auto`                                | `auto` pushes via channel + polls every 1s. `pull` disables polling — see below.             |
| `CODEX_PEERS_PROXY_PORT`    | `7900`                                | Codex proxy listen port                                                                      |
| `CODEX_PEERS_REAL_APP_SERVER_PORT` | `7901`                         | Real Codex app-server port the proxy fronts                                                  |
| `OPENAI_API_KEY`            | —                                     | Enables auto-summary via gpt-5.4-nano                                                        |

> Env var names retain the `CLAUDE_PEERS_*` / `CODEX_PEERS_*` prefixes for backward compatibility with prior `claude-peers-mcp` configs.

## Pull mode (Desktop App / no channel subscription)

`notifications/claude/channel` only surfaces in sessions launched with `--dangerously-load-development-channels server:dream-team`. If the host can't pass that flag (most commonly the Claude Desktop App), channel pushes evaporate and inbound messages go missing.

Set `CLAUDE_PEERS_MODE=pull` in the MCP server env to disable the poll loop. Messages accumulate in the broker until `check_messages` is called.

```bash
claude mcp add --scope user --transport stdio dream-team \
  --env CLAUDE_PEERS_MODE=pull \
  -- bun ~/emberlabs-dream-team/server.ts
```

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+ (for channel mode)
- Codex CLI (recent — uses `turn/steer`)
- claude.ai login (channels require it — API key auth won't work)
- Tailscale (for cross-machine peers)

## Project history

- **2026-04-30** — renamed `claude-peers-mcp` → `emberlabs-dream-team`. MCP server name `claude-peers` → `dream-team`. Channel source `dream-team`. Repo lives at `EmberLabs-AI/emberlabs-dream-team`.
- **2026-04-30** — Codex CLI integration shipped (proxy + MCP modes). Cross-runtime + cross-machine mesh proven (Mac Claude · Mac Codex · Starforge Claude · Starforge Codex).
- **Earlier** — forked from `louislva/claude-peers-mcp`. Original credit to Louis for the broker + channel-push design.
