# AMQP Transport for Model Context Protocol (MCP)

An AMQP-based transport implementation for the Model Context Protocol, enabling distributed MCP communication over AMQP message queues.

## Project Status

✅ **COMPLETED** - AMQP MCP Transport implementation is ready for use!

### What's Included

- **Client Transport** (`AMQPClientTransport`): Enables MCP clients to connect to servers via AMQP
- **Server Transport** (`AMQPServerTransport`): Allows MCP servers to receive requests through AMQP
- **TypeScript Support**: Full type definitions and compile-time safety
- **Example Code**: Working client and server examples in the `examples/` directory
- **Docker Setup**: `docker-compose.yml` for local RabbitMQ development
- **Test Framework**: Jest configuration ready for unit testing

### Quick Verification

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start RabbitMQ for testing
docker-compose up -d

# Run the example server (in one terminal)
npm run example:server

# Run the example client (in another terminal)
npm run example:client
```

## Getting Started

This project provides an AMQP transport implementation for MCP, allowing MCP clients and servers to communicate through AMQP message queues instead of direct connections. This enables:

- **Distributed Architecture**: Clients and servers can run on different machines
- **Scalability**: Multiple servers can handle requests through load balancing
- **Reliability**: Message persistence and delivery guarantees through AMQP brokers
- **Flexibility**: Pub/sub patterns for notifications and events

## Architecture

The AMQP transport implements the MCP `Transport` interface and uses:

- **Request/Response Queues**: For synchronous MCP method calls
- **Notification Exchanges**: For asynchronous notifications
- **Correlation IDs**: To match responses with requests
- **JSON Serialization**: For message encoding

## Installation

```bash
npm install @modelcontextprotocol/sdk amqplib
```

## Project Structure

```
├── src/
│   ├── transports/
│   │   ├── amqp-client-transport.ts        # Client-side transport
│   │   ├── amqp-server-transport.ts        # Server-side transport
│   │   └── types.ts                        # Shared types
│   └── examples/
│       ├── client.ts                       # Example client
│       └── server.ts                       # Example server
├── package.json
├── tsconfig.json
└── README.md
```

## Key Features

- **Standard MCP Transport**: Implements the official Transport interface
- **Connection Management**: Automatic reconnection and error handling
- **Message Persistence**: Durable queues and exchanges
- **Correlation Tracking**: Proper request/response pairing
- **Type Safety**: Full TypeScript support with proper MCP types

## Usage

### Server Setup

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AMQPServerTransport } from "./transports/amqp-server-transport.js";

const server = new McpServer({
  name: "example-server",
  version: "1.0.0",
});

// Add your tools, resources, and prompts here
server.registerTool(
  "echo",
  {
    description: "Echo back the input",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  })
);

const transport = new AMQPServerTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.exchange",
  queuePrefix: "mcp.server",
});

await server.connect(transport);
```

### Client Setup

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "./transports/amqp-client-transport.js";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  exchangeName: "mcp.exchange",
  serverQueuePrefix: "mcp.server",
});

const client = new Client({
  name: "example-client",
  version: "1.0.0",
});

await client.connect(transport);

// Use the client
const tools = await client.listTools();
const result = await client.callTool({
  name: "echo",
  arguments: { message: "Hello, World!" },
});
```

## Configuration Options

### Common Options

- `amqpUrl`: RabbitMQ connection URL
- `exchangeName`: Exchange name for notifications
- `reconnectDelay`: Delay between reconnection attempts (default: 5000ms)
- `maxReconnectAttempts`: Maximum reconnection attempts (default: 10)

### Server-Specific Options

- `queuePrefix`: Prefix for server queues
- `queueTTL`: Queue time-to-live (optional)
- `messageTTL`: Message time-to-live (optional)

### Client-Specific Options

- `serverQueuePrefix`: Prefix for target server queues
- `responseTimeout`: Timeout for responses (default: 30000ms)

## Development

### Prerequisites

- Node.js 18+
- RabbitMQ server running locally or accessible via URL
- TypeScript

### Building

```bash
npm run build
```

### Testing

```bash
# Start RabbitMQ (using Docker)
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management

# Run tests
npm test
```

### Running Examples

```bash
# Terminal 1: Start the server
npm run example:server

# Terminal 2: Start the client
npm run example:client
```

## Design Decisions

1. **Transport Pattern**: Follows the standard MCP Transport interface rather than creating a custom connector pattern
2. **Message Format**: Uses JSON-RPC 2.0 format as required by MCP specification
3. **Queue Strategy**: Uses separate queues for each server instance with routing keys
4. **Error Handling**: Implements proper error propagation and connection recovery
5. **Type Safety**: Maintains full compatibility with MCP TypeScript types

## Limitations

- Requires RabbitMQ infrastructure
- Adds network latency compared to direct transports
- More complex setup than stdio/WebSocket transports
- Message size limits depend on RabbitMQ configuration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
