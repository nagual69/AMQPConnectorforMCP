<!-- BEGIN UNIFIED BRAND HEADER (copy/paste to other repos) -->
<div align="center">

  <p>
    <img src="./mcp-open-discovery-logo-white.png" alt="MCP Open Discovery" width="128" height="128" />
    <img src="./CodedwithAI-white-transparent.png" alt="Coded with AI" width="128" height="128" />
  </p>

  <p><em>Forging Intelligent Systems with Purpose</em></p>
  <p><strong>Unified launch: MCP Open Discovery • AMQP Transport • VS Code Bridge</strong></p>
  <p>
    <a href="https://modelcontextprotocol.io/" target="_blank">Model Context Protocol</a>
    ·
    <a href="https://github.com/nagual69/mcp-open-discovery" target="_blank">MCP Open Discovery</a>
    ·
    <a href="https://github.com/nagual69/AMQPConnectorforMCP" target="_blank">AMQP Transport</a>
    ·
    <a href="https://github.com/nagual69/vscode-mcp-open-discovery-amqp-bridge" target="_blank">VS Code AMQP Bridge</a>
    ·
    <a href="https://www.linkedin.com/in/toby-schmeling-2200556/" target="_blank">LinkedIn</a>
  </p>

</div>
<!-- END UNIFIED BRAND HEADER -->

# AMQP Transport for Model Context Protocol (MCP)

An AMQP-based transport implementation for the Model Context Protocol, enabling distributed MCP communication over AMQP message queues.

**✅ Fully compliant with MCP specification 2025-11-25** — All messages are sent as raw JSON-RPC 2.0 on the wire, with transport metadata in AMQP message properties.

## Project Status

✅ Production-ready AMQP MCP Transport with bidirectional routing, fully tested and spec-compliant.

## Use with MCP TypeScript SDK examples

You can plug this AMQP transport into the official MCP TypeScript SDK examples by swapping the transport object. The SDK is transport‑agnostic—any example that constructs a `Client` or an `McpServer`/`Server` can use `AMQPClientTransport`/`AMQPServerTransport` instead of the HTTP, SSE, WebSocket, or in‑memory transports.

- Repository: https://github.com/modelcontextprotocol/typescript-sdk
- Examples directory: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/src/examples

Showcase wiring

- Server (replace the example’s HTTP/SSE transport):
  - Find where the example creates a transport, e.g. `new StreamableHTTPServerTransport(...)` or `new SSEServerTransport(...)`.
  - Replace that with:
    ```ts
    import { AMQPServerTransport } from "amqp-mcp-transport";
    // or: import { AMQPServerTransport } from "../src/transports/index.js"; // if using this repo locally

    const transport = new AMQPServerTransport({
      amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
      exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
      queuePrefix: "mcp.example", // server queue namespace for your app
      prefetchCount: 1,
    });

    await mcpServer.connect(transport); // or: await server.connect(transport)
    ```
  - Many SDK examples wrap the server with Express for HTTP. For AMQP, you don’t need Express—just create your `McpServer`/`Server`, register tools/resources/prompts, and `connect` with the AMQP transport.

- Client (replace the example’s HTTP/SSE/WebSocket transport):
  - Find where the example creates a client transport, e.g. `new StreamableHTTPClientTransport(url)`.
  - Replace that with:
    ```ts
    import { AMQPClientTransport } from "amqp-mcp-transport";

    const transport = new AMQPClientTransport({
      amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
      exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
      serverQueuePrefix: "mcp.example", // should match the server’s queuePrefix
      responseTimeout: 30000,
    });

    await client.connect(transport);
    ```

Tips

- Keep `queuePrefix` (server) and `serverQueuePrefix` (client) aligned. For demos, `mcp.example` keeps traffic isolated from other systems on the same broker.
- Use `AMQP_EXCHANGE` to isolate demo traffic. The routing exchange used is `${exchangeName}.mcp.routing`.
- To point at a broker started via Docker on your local machine, use `amqp://<user>:<pass>@localhost:5672` as AMQP_URL.

Spec alignment (Custom Transports)

This transport implements the MCP `Transport` contract per the spec:
- Methods: `start()`, `send()`, `close()`, `setProtocolVersion(version)`
- Callbacks: `onmessage`, `onerror`, `onclose`, and `sessionId`
- JSON‑RPC messages preserved end‑to‑end; start is idempotent and lifecycle is SDK‑managed (`client.connect()` / `server.connect()` will call `start()`).

Spec reference: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports (see the “Custom Transports” section).

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

# If using the provided docker-compose.yml, RabbitMQ credentials are:
#   username: admin
#   password: admin123
# Set AMQP_URL accordingly in your shell/session:
# PowerShell
#   $env:AMQP_URL = "amqp://admin:admin123@localhost:5672"
# Bash
#   export AMQP_URL="amqp://admin:admin123@localhost:5672"

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

- **Bidirectional Topic Exchange**: `${exchangeName}.mcp.routing` for requests, events, and notifications
- **Session/Stream IDs**: Session-aware routing with correlation storage for responses
- **Correlation IDs**: To match responses with requests
- **JSON Serialization**: For message encoding

Routing & replies

- Requests/notifications are published to the topic exchange `${exchangeName}.mcp.routing` using routing keys like `mcp.request.{method}` (e.g., `mcp.request.tools.list`), where the method name has `/` replaced by `.`.
- The server replies directly to the client's exclusive reply queue using `replyTo` and preserves the original `correlationId` for JSON‑RPC responses—responses are not sent via the routing exchange.
- All messages include `contentType: 'application/json'` in AMQP properties for proper serialization.
- For advanced routing (e.g., category-based routing), use the `routingKeyStrategy` configuration option.

SDK lifecycle

- The MCP SDK manages the transport lifecycle. Prefer `client.connect(transport)` and `server.connect(transport)`. The SDK will call `transport.start()`; you shouldn’t call it yourself.

Environment

- To avoid crosstalk across shared brokers in demos, the examples honor `AMQP_EXCHANGE`:
  - PowerShell:
    ```powershell
    $env:AMQP_EXCHANGE = "mcp.examples"
    ```
  - Defaults to `mcp.examples` in the examples; for production pick a stable name like `mcp.notifications`.

## Environment mapping (what each var means)

- AMQP_URL: Broker connection URL. Use localhost when running the examples on your machine; use the service name (e.g., `rabbitmq`) when running inside Docker Compose.
  - Host example (PowerShell): `$env:AMQP_URL = "amqp://user:pass@localhost:5672"`
  - Docker Compose (app container): `AMQP_URL=amqp://user:pass@rabbitmq:5672`
- AMQP_EXCHANGE: Base exchange name. The transport publishes requests/notifications to the topic exchange `${AMQP_EXCHANGE}.mcp.routing`.
  - Examples often use `mcp.examples` for isolation. Production might use `mcp.notifications`.
- queuePrefix / serverQueuePrefix: Queue namespace for the server implementation. These are code-level options, not environment variables in the examples by default.
  - In examples: server uses `queuePrefix: "mcp.example"`; client uses `serverQueuePrefix: "mcp.example"` to match.
  - If you need to talk to an existing server that uses `mcp.discovery` queues, change those literals in `examples/server.ts` and `examples/client.ts` to `"mcp.discovery"`.

Docker vs host networking

- Running examples directly on your host machine: use `localhost` in AMQP_URL.
- Running code inside Docker Compose: use the service name `rabbitmq` in AMQP_URL.
- The routing exchange is always derived from AMQP_EXCHANGE as `${AMQP_EXCHANGE}.mcp.routing`.

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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "./transports/amqp-server-transport.js";

const server = new Server(
  {
    name: "example-server",
    version: "1.0.0",
  },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

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
  amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
  queuePrefix: "mcp.server",
});

await server.connect(transport); // SDK calls transport.start()
```

### Client Setup

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "./transports/amqp-client-transport.js";

const transport = new AMQPClientTransport({
  amqpUrl: process.env.AMQP_URL || "amqp://localhost:5672",
  exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
  serverQueuePrefix: "mcp.server",
});

const client = new Client(
  { name: "example-client", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport); // SDK calls transport.start()

const tools = await client.listTools();
const result = await client.callTool({
  name: "echo",
  arguments: { message: "Hello" },
});
```

## Configuration Options

### Common Options

- amqpUrl: RabbitMQ connection URL
- exchangeName: Base exchange name (routing uses `${exchangeName}.mcp.routing`)
- reconnectDelay: Delay between reconnection attempts (default: 5000ms)
- maxReconnectAttempts: Maximum reconnection attempts (default: 10)
- prefetchCount: Channel prefetch (server default 1, client default 10)
- messageTTL, queueTTL: TTLs for ephemeral queues

### Server-Specific Options

- queuePrefix: Prefix for server queues (e.g., `mcp.server`)

### Client-Specific Options

- serverQueuePrefix: Prefix for target server queues (should match server’s queuePrefix)
- responseTimeout: Timeout for responses (default: 30000ms)

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

# Run unit + integration tests
npm test
```

### Running Examples

```bash
# Terminal 1: Start the server (optional env isolation)
$env:AMQP_EXCHANGE = "mcp.examples"
npm run example:server

# Terminal 2: Start the client (uses same exchange)
$env:AMQP_EXCHANGE = "mcp.examples"
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

Apache License 2.0 — see `LICENSE` and `NOTICE` for full terms and attributions.

Why Apache 2.0 for this transport?

- Explicit patent grant and defensive termination provide clarity for enterprises
- Widely adopted for infrastructure components and connectors
- Encourages adoption while preserving contributor protections
- Compatible with many open-source and commercial ecosystems

