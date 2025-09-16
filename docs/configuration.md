# Configuration Guide

## Overview

The AMQP MCP Transport supports both basic request/response and the new bidirectional routing used by the MCP Open Discovery server. Configure the exchange and queue prefixes rather than hardcoding queue names.

## Basic Configuration

### Client (minimal)

```ts
import { AMQPClientTransport } from "amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
  responseTimeout: 30000,
});
```

### Server (minimal)

```ts
import { AMQPServerTransport } from "amqp-mcp-transport";

const transport = new AMQPServerTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  queuePrefix: "mcp.server",
  prefetchCount: 1,
});
```

## Advanced Options

- reconnectDelay: number (ms, default 5000)
- maxReconnectAttempts: number (default 10)
- prefetchCount: number (server default 1, client default 10)
- messageTTL: number (ms) — applied to ephemeral queues
- queueTTL: number (ms) — applied to ephemeral queues
- responseTimeout (client only): number (ms, default 30000)

## Environment-Based Configuration

```ts
const config = {
  amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.notifications",
  queuePrefix: process.env.AMQP_QUEUE_PREFIX || "mcp.server", // server
  serverQueuePrefix: process.env.AMQP_QUEUE_PREFIX || "mcp.server", // client
  responseTimeout: parseInt(process.env.AMQP_RESPONSE_TIMEOUT || "30000"),
};
```

### AMQP_EXCHANGE in examples

- For the included examples, set `AMQP_EXCHANGE` to isolate the demo traffic:

```powershell
$env:AMQP_EXCHANGE = "mcp.examples"
```

## Routing

- The transport uses a topic exchange named `${exchangeName}.mcp.routing` for all requests and notifications.
- Typical routing keys the server binds to include:
  - `mcp.request.{category}` (derived from method name)
  - `mcp.tools.#`, `mcp.resources.#`, `mcp.prompts.#`
- Responses are not published to the routing exchange. Instead, the server uses the original `replyTo` queue and `correlationId` to send JSON-RPC responses directly to the client’s exclusive queue.

## Production Considerations

- Use amqps:// with proper certificates
- Set durable: true for `${exchangeName}`
- Tune prefetchCount (server: 1 for strict order; higher for throughput)
- Enable dead-lettering on your broker if needed
- Monitor heartbeats and enable auto-recovery at the process level if desired

## Validation

Use validateAmqpConfig to check core fields:

```ts
import { validateAmqpConfig } from "amqp-mcp-transport";

const errors = validateAmqpConfig({
  amqpUrl: "amqp://localhost:5672",
  queuePrefix: "mcp.server",
  exchangeName: "mcp.notifications",
});
if (errors.length) throw new Error(errors.join(", "));
```

## Multi-tenant patterns

Prefer separate queuePrefix per tenant: `mcp.server.{tenantId}`. The client uses serverQueuePrefix with the same value.

## Best Practices

1. Prefer `${exchangeName}.mcp.routing` for requests/notifications
2. Keep response queues exclusive, autoDelete, and ephemeral
3. Track correlationId and replyTo for each request on the server
4. Make start() idempotent; let the MCP SDK call it during connect()
5. Use structured logging and monitoring
