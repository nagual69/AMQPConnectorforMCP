# Configuration Guide

## Overview

The AMQP MCP Transport is fully compliant with MCP specification 2025-11-25. It sends raw JSON-RPC 2.0 messages on the wire with transport metadata in AMQP message properties.

The transport supports bidirectional routing through topic exchanges. Configure the exchange and queue prefixes rather than hardcoding queue names.

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
- maxMessageSize: number (bytes, default 1048576 = 1 MB) — rejects messages exceeding this size
- routingKeyStrategy: (method: string, messageType: 'request' | 'notification') => string — custom routing key derivation (see Routing section)

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
- Default routing key format: `mcp.{messageType}.{method}` where:
  - `messageType` is either "request" or "notification"
  - `method` is the JSON-RPC method name with `/` replaced by `.` (e.g., "tools/list" → "tools.list")
- Example routing keys:
  - `mcp.request.tools.list` for a tools/list request
  - `mcp.notification.tools.list_changed` for a notification
- Responses are NOT published to the routing exchange. Instead, the server uses the original `replyTo` queue and `correlationId` to send JSON-RPC responses directly to the client's exclusive queue.
- All messages include `contentType: 'application/json'` in AMQP properties.

### Custom Routing Strategy

For advanced use cases (e.g., category-based routing for service discovery), provide a custom `routingKeyStrategy`:

```ts
import { AMQPClientTransport } from "amqp-mcp-transport";

// Example: Category-based routing for tool methods
const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
  routingKeyStrategy: (method, messageType) => {
    // Extract category from method name
    let category = "general";
    if (method.startsWith("nmap_")) category = "nmap";
    else if (method.startsWith("snmp_")) category = "snmp";
    else if (method.includes("/")) category = method.split("/")[0];
    
    return `mcp.${messageType}.${category}.${method.replace(/\//g, ".")}`;
  },
});
```

**Note:** Both client and server must use the same routing strategy for messages to be routed correctly.

## Production Considerations

- Use amqps:// with proper certificates
- Set durable: true for `${exchangeName}`
- Tune prefetchCount (server: 1 for strict order; higher for throughput)
- Enable dead-lettering on your broker if needed
- Monitor heartbeats and enable auto-recovery at the process level if desired

### Security

- **Message Size Validation:** The transport rejects incoming messages exceeding `maxMessageSize` (default 1 MB) before parsing to prevent memory exhaustion attacks.
- **JSON-RPC Schema Validation:** All incoming messages are validated against JSON-RPC 2.0 specification. Invalid messages are rejected with descriptive errors.
- **URL Scheme Validation:** Only `amqp://` and `amqps://` URL schemes are accepted during configuration validation.
- **Credential Handling:** Never hardcode credentials in configuration. Use environment variables or secure credential management systems.

```typescript
// Good: credentials from environment
const transport = new AMQPClientTransport({
  amqpUrl: process.env.AMQP_URL, // Points to amqps:// with proper certs
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
  maxMessageSize: 2097152, // 2 MB limit for your use case
});
```

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
