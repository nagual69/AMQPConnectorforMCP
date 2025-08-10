# API Reference

## Table of Contents

- [AMQPClientTransport](#amqpclienttransport)
- [AMQPServerTransport](#amqpservertransport)
- [Types and Interfaces](#types-and-interfaces)
- [Utility Functions](#utility-functions)
- [Error Types](#error-types)

## AMQPClientTransport

Enterprise-grade AMQP client transport for MCP.

### Constructor

```typescript
new AMQPClientTransport(config: AMQPConfig)
```

### Methods

#### `connect(): Promise<void>`

Establishes connection to the AMQP broker and sets up necessary queues and exchanges.

```typescript
await client.connect();
```

#### `send(message: JSONRPCMessage): Promise<JSONRPCMessage>`

Sends a message and waits for a response with correlation handling.

```typescript
const response = await client.send({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});
```

#### `close(): Promise<void>`

Closes the connection and cleans up resources.

```typescript
await client.close();
```

### Properties

#### `onclose?: () => void`

Callback function called when the connection is closed.

```typescript
client.onclose = () => {
  console.log("Connection closed");
};
```

#### `onerror?: (error: Error) => void`

Callback function called when an error occurs.

```typescript
client.onerror = (error) => {
  console.error("Transport error:", error);
};
```

## AMQPServerTransport

Enterprise-grade AMQP server transport for MCP.

### Constructor

```typescript
new AMQPServerTransport(config: AMQPConfig)
```

### Methods

#### `start(): Promise<void>`

Starts the server and begins listening for messages.

```typescript
await server.start();
```

#### `close(): Promise<void>`

Stops the server and closes connections.

```typescript
await server.close();
```

#### `send(message: JSONRPCMessage): Promise<void>`

Sends a message to clients (when bidirectional is enabled).

```typescript
await server.send({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { text: "Hello from server!" },
});
```

### Properties

#### `onmessage?: (message: JSONRPCMessage) => Promise<JSONRPCMessage> | JSONRPCMessage | void`

Message handler function that processes incoming requests.

```typescript
server.onmessage = async (message) => {
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [] },
    };
  }
};
```

#### `onclose?: () => void`

Callback function called when the server connection is closed.

#### `onerror?: (error: Error) => void`

Callback function called when an error occurs.

## Types and Interfaces

### AMQPConfig

Configuration interface for AMQP transports.

```typescript
interface AMQPConfig {
  /** AMQP broker URL */
  url: string;

  /** Queue name for incoming requests */
  requestQueue: string;

  /** Queue name for outgoing responses */
  responseQueue: string;

  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;

  /** Enable bidirectional communication (default: false) */
  enableBidirectional?: boolean;

  /** AMQP connection options */
  connectionOptions?: {
    heartbeat?: number;
    locale?: string;
    [key: string]: any;
  };

  /** Queue declaration options */
  queueOptions?: {
    durable?: boolean;
    exclusive?: boolean;
    autoDelete?: boolean;
    [key: string]: any;
  };

  /** Consumer options */
  consumerOptions?: {
    noAck?: boolean;
    exclusive?: boolean;
    [key: string]: any;
  };
}
```

### JSONRPCMessage

Standard JSON-RPC 2.0 message format.

```typescript
interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}
```

### RoutingInfo

Information about message routing and session state.

```typescript
interface RoutingInfo {
  toolCategory?: string;
  sessionId?: string;
  userId?: string;
  timestamp: number;
  correlationId: string;
}
```

### TransportMetrics

Performance and monitoring metrics.

```typescript
interface TransportMetrics {
  messagesSent: number;
  messagesReceived: number;
  errorsEncountered: number;
  averageResponseTime: number;
  connectionUptime: number;
}
```

## Utility Functions

### parseMessage

Safely parses incoming AMQP messages with error handling.

```typescript
function parseMessage(content: Buffer): JSONRPCMessage | null;
```

**Parameters:**

- `content`: Raw message content buffer

**Returns:**

- Parsed JSON-RPC message or `null` if parsing fails

**Example:**

```typescript
import { parseMessage } from "amqp-mcp-transport";

const message = parseMessage(buffer);
if (message) {
  console.log("Parsed message:", message);
}
```

### getToolCategory

Extracts tool category from message parameters for intelligent routing.

```typescript
function getToolCategory(message: JSONRPCMessage): string;
```

**Parameters:**

- `message`: JSON-RPC message

**Returns:**

- Tool category string ('filesystem', 'network', 'database', etc.)

**Example:**

```typescript
import { getToolCategory } from "amqp-mcp-transport";

const category = getToolCategory({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "read_file" },
});
console.log("Category:", category); // 'filesystem'
```

### validateAmqpConfig

Validates AMQP configuration object.

```typescript
function validateAmqpConfig(config: Partial<AMQPConfig>): string[];
```

**Parameters:**

- `config`: Configuration object to validate

**Returns:**

- Array of validation error messages (empty if valid)

**Example:**

```typescript
import { validateAmqpConfig } from "amqp-mcp-transport";

const errors = validateAmqpConfig({
  url: "amqp://localhost:5672",
  requestQueue: "requests",
  // missing responseQueue
});

if (errors.length > 0) {
  console.error("Config errors:", errors);
}
```

### testAmqpConnection

Tests connectivity to an AMQP broker.

```typescript
function testAmqpConnection(url: string): Promise<boolean>;
```

**Parameters:**

- `url`: AMQP broker URL

**Returns:**

- Promise that resolves to `true` if connection successful

**Example:**

```typescript
import { testAmqpConnection } from "amqp-mcp-transport";

const isConnected = await testAmqpConnection("amqp://localhost:5672");
if (!isConnected) {
  console.error("Cannot connect to AMQP broker");
}
```

### detectMessageType

Analyzes message content to determine its type and purpose.

```typescript
function detectMessageType(
  message: JSONRPCMessage
): "request" | "response" | "notification" | "error";
```

**Parameters:**

- `message`: JSON-RPC message to analyze

**Returns:**

- Message type classification

**Example:**

```typescript
import { detectMessageType } from "amqp-mcp-transport";

const type = detectMessageType({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});
console.log("Message type:", type); // 'request'
```

## Error Types

### AMQPTransportError

Base error class for transport-related errors.

```typescript
class AMQPTransportError extends Error {
  code: string;
  cause?: Error;
}
```

### ConnectionError

Error thrown when connection to AMQP broker fails.

```typescript
class ConnectionError extends AMQPTransportError {
  code: "CONNECTION_FAILED" | "CONNECTION_LOST" | "AUTHENTICATION_FAILED";
}
```

### TimeoutError

Error thrown when requests exceed the configured timeout.

```typescript
class TimeoutError extends AMQPTransportError {
  code: "REQUEST_TIMEOUT";
  timeout: number;
}
```

### ValidationError

Error thrown when configuration or message validation fails.

```typescript
class ValidationError extends AMQPTransportError {
  code: "INVALID_CONFIG" | "INVALID_MESSAGE";
  details: string[];
}
```

## Events

Both client and server transports emit events that can be listened to:

### Connection Events

```typescript
transport.on("connect", () => {
  console.log("Connected to AMQP broker");
});

transport.on("disconnect", () => {
  console.log("Disconnected from AMQP broker");
});

transport.on("reconnect", (attempt: number) => {
  console.log(`Reconnection attempt ${attempt}`);
});
```

### Message Events

```typescript
transport.on("message:sent", (message: JSONRPCMessage) => {
  console.log("Message sent:", message);
});

transport.on("message:received", (message: JSONRPCMessage) => {
  console.log("Message received:", message);
});

transport.on("message:error", (error: Error, message: JSONRPCMessage) => {
  console.error("Message error:", error, message);
});
```

### Performance Events

```typescript
transport.on("metrics:update", (metrics: TransportMetrics) => {
  console.log("Performance metrics:", metrics);
});
```
