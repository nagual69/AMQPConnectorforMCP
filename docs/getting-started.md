# Getting Started with AMQP MCP Transport

## Compliance

This transport is **fully compliant with MCP specification 2025-11-25**. All messages are sent as raw JSON-RPC 2.0 on the wire, with transport metadata (correlationId, replyTo, contentType) in AMQP message properties. No custom envelope wrapping is used.

## Installation

### npm

```bash
npm install amqp-mcp-transport @modelcontextprotocol/sdk amqplib
```

### yarn

```bash
yarn add amqp-mcp-transport @modelcontextprotocol/sdk amqplib
```

### pnpm

```bash
pnpm add amqp-mcp-transport @modelcontextprotocol/sdk amqplib
```

## Prerequisites

- Node.js 18 or higher
- An AMQP broker (RabbitMQ, ActiveMQ, Apache Qpid, etc.)
- TypeScript 5.0+ (for TypeScript projects)

## Basic Usage

### Setting up an AMQP Broker

For development, you can quickly start a RabbitMQ instance using Docker:

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

This will start RabbitMQ with:

- AMQP port: 5672
- Management UI: http://localhost:15672 (guest/guest)

### Client Transport Example

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
  responseTimeout: 30000,
});

const client = new Client(
  { name: "example", version: "1.0.0" },
  { capabilities: {} }
);

// Connect: the SDK will call transport.start() internally
await client.connect(transport);

// Use the MCP client API
const tools = await client.listTools();
console.log("Tools:", tools.tools);

await client.close();
```

### Server Transport Example

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "amqp-mcp-transport";

const transport = new AMQPServerTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  queuePrefix: "mcp.server",
});

const server = new Server(
  { name: "example-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// Define handlers with the MCP SDK schemas (omitted for brevity)

// Connect: the SDK will call transport.start() internally
await server.connect(transport);
console.log("Server started over AMQP");
```

## Configuration

### Basic Configuration

```typescript
import type { AMQPClientTransportOptions } from "amqp-mcp-transport";

const config: AMQPClientTransportOptions = {
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
};
```

### Advanced Configuration

```typescript
import type { AMQPClientTransportOptions } from "amqp-mcp-transport";

const advancedConfig: AMQPClientTransportOptions = {
  amqpUrl: "amqp://user:pass@broker.example.com:5672/vhost",
  exchangeName: "mcp.notifications",
  serverQueuePrefix: "mcp.server",
  responseTimeout: 30000,
  prefetchCount: 10,
  reconnectDelay: 5000,
  maxReconnectAttempts: 10,
};
```

## Error Handling

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

const client = new AMQPClientTransport(config);

try {
  await client.connect();

  const response = await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
} catch (error) {
  if (error.code === "ECONNREFUSED") {
    console.error("Failed to connect to AMQP broker");
  } else if (error.code === "REQUEST_TIMEOUT") {
    console.error("Request timed out");
  } else {
    console.error("Unexpected error:", error);
  }
} finally {
  await client.close();
}
```

## Environment Variables

You can configure the transport using environment variables:

```bash
# .env file
AMQP_URL=amqp://localhost:5672
AMQP_EXCHANGE=mcp.notifications
AMQP_QUEUE_PREFIX=mcp.server
AMQP_RESPONSE_TIMEOUT=30000
```

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

const client = new AMQPClientTransport({
  amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.notifications",
  serverQueuePrefix: process.env.AMQP_QUEUE_PREFIX || "mcp.server",
  responseTimeout: parseInt(process.env.AMQP_RESPONSE_TIMEOUT || "30000"),
});
```

## Docker Compose Setup

For a complete development environment:

```yaml
# docker-compose.dev.yml
version: "3.8"
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: dev
      RABBITMQ_DEFAULT_PASS: dev123
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  app:
    build: .
    environment:
      AMQP_URL: amqp://dev:dev123@rabbitmq:5672
    depends_on:
      - rabbitmq

volumes:
  rabbitmq_data:
```

## Next Steps

- [API Reference](./api-reference.md) - Detailed API documentation
- [Configuration Guide](./configuration.md) - Complete configuration options
- [Examples](./examples.md) - More complex usage examples
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
