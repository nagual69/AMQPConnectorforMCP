# Getting Started with AMQP MCP Transport

## Installation

### npm

```bash
npm install amqp-mcp-transport
```

### yarn

```bash
yarn add amqp-mcp-transport
```

### pnpm

```bash
pnpm add amqp-mcp-transport
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
import { AMQPClientTransport } from "amqp-mcp-transport";

const client = new AMQPClientTransport({
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
  requestTimeout: 30000,
});

// Connect to the broker
await client.connect();

// Send a message
const response = await client.send({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

console.log("Response:", response);

// Close connection
await client.close();
```

### Server Transport Example

```typescript
import { AMQPServerTransport } from "amqp-mcp-transport";

const server = new AMQPServerTransport({
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
  enableBidirectional: true,
});

// Set up message handler
server.onmessage = async (message) => {
  console.log("Received message:", message);

  // Handle the message and return response
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: {
      tools: [
        {
          name: "example_tool",
          description: "An example tool",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    },
  };
};

// Start the server
await server.start();
console.log("Server started and listening for messages");
```

## Configuration

### Basic Configuration

```typescript
import { AMQPConfig } from "amqp-mcp-transport";

const config: AMQPConfig = {
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
};
```

### Advanced Configuration

```typescript
const advancedConfig: AMQPConfig = {
  url: "amqp://user:pass@broker.example.com:5672/vhost",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
  requestTimeout: 30000,
  enableBidirectional: true,

  // Connection options
  connectionOptions: {
    heartbeat: 60,
    locale: "en_US",
  },

  // Queue options
  queueOptions: {
    durable: true,
    exclusive: false,
    autoDelete: false,
  },

  // Consumer options
  consumerOptions: {
    noAck: false,
    exclusive: false,
  },
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
AMQP_REQUEST_QUEUE=mcp_requests
AMQP_RESPONSE_QUEUE=mcp_responses
AMQP_REQUEST_TIMEOUT=30000
```

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

const client = new AMQPClientTransport({
  url: process.env.AMQP_URL || "amqp://localhost:5672",
  requestQueue: process.env.AMQP_REQUEST_QUEUE || "mcp_requests",
  responseQueue: process.env.AMQP_RESPONSE_QUEUE || "mcp_responses",
  requestTimeout: parseInt(process.env.AMQP_REQUEST_TIMEOUT || "30000"),
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
