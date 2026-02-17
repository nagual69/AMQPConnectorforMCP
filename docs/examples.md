# Examples

Practical, up-to-date examples for using the AMQP transport with the MCP TypeScript SDK. These align with the bidirectional routing design using a topic exchange and the SDK-managed lifecycle.

**Wire Format:** All examples use MCP-compliant raw JSON-RPC 2.0 messages on the wire, with transport metadata in AMQP message properties.

## Basic

Environment

- Examples honor the AMQP_EXCHANGE env var to isolate demo traffic:

```powershell
$env:AMQP_EXCHANGE = "mcp.examples"   # default used by the examples
```

Routing overview

- Requests/notifications publish to a topic exchange named `${exchangeName}.mcp.routing`.
- Default routing key format: `mcp.{messageType}.{method}` (e.g., `mcp.request.tools.list`)
- Responses are sent directly to the client's exclusive reply queue via `replyTo`, preserving the original `correlationId`.
- All messages include `contentType: 'application/json'` in AMQP properties.

### Client (with MCP SDK)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "amqp-mcp-transport";

async function main() {
  const transport = new AMQPClientTransport({
    amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
    serverQueuePrefix: "mcp.example",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
    responseTimeout: 30000,
    reconnectDelay: 5000,
    maxReconnectAttempts: 10,
  });

  const client = new Client(
    { name: "amqp-example-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport); // SDK calls transport.start() for you

    const tools = await client.listTools();
    console.log("Tools:", tools.tools);

    if (tools.tools.length) {
      const result = await client.callTool({
        name: tools.tools[0].name,
        arguments: {},
      });
      console.log("Tool result:", result);
    }
  } finally {
    await client.close();
  }
}

main().catch(console.error);
```

### Server (with MCP SDK)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "amqp-mcp-transport";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

async function main() {
  const transport = new AMQPServerTransport({
    amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
    queuePrefix: "mcp.example",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
    prefetchCount: 1,
    reconnectDelay: 5000,
    maxReconnectAttempts: 10,
  });

  const server = new Server(
    { name: "amqp-example-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo back the input text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const text = (request.params as any)?.arguments?.text ?? "";
    return { content: [{ type: "text", text: `Echo: ${text}` }] };
  });

  await server.connect(transport); // SDK calls transport.start() for you
  console.log("Server ready over AMQP");

  await new Promise(() => {}); // keep alive
}

main().catch((err) => {
  console.error("Server failed:", err);
  process.exit(1);
});
```

Notes

- Client option names: amqpUrl, serverQueuePrefix, exchangeName
- Server option names: amqpUrl, queuePrefix, exchangeName
- Routing uses a topic exchange named `${exchangeName}.mcp.routing`; responses return via replyTo using correlationId automatically.

## Notifications

The transport supports JSON-RPC notifications in both directions over the routing exchange. When using the SDK, notifications are delivered through the established session automatically.

Tips

- Ensure both client and server use the same exchangeName value.
- Prefer SDK APIs (listTools, callTool, etc.). The SDK wires up handlers for you.

## Resilience (timeouts, reconnect)

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  serverQueuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
  responseTimeout: 45000, // override default
  reconnectDelay: 5000,
  maxReconnectAttempts: 5,
});

const client = new Client(
  { name: "resilient-client", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);
```

## Production tips

- Use distinct queuePrefix/serverQueuePrefix per application or environment.
- Set prefetchCount on the server to control concurrency.
- Use amqps with proper CA/cert/key in production.
- Monitor the `${exchangeName}.mcp.routing` exchange and bound queues via RabbitMQ Management UI.
