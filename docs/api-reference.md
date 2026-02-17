# API Reference

**Wire Format:** This transport is fully compliant with MCP specification 2025-11-25. All messages are sent as raw JSON-RPC 2.0 on the wire, with transport metadata (correlationId, replyTo, contentType) in AMQP message properties. No custom envelope wrapping is used.

## Table of Contents

- [AMQPClientTransport](#amqpclienttransport)
- [AMQPServerTransport](#amqpservertransport)
- [Options](#options)
- [Utility Functions](#utility-functions)
- [Error Types](#error-types)

## AMQPClientTransport

AMQP client transport for MCP with enterprise-grade bidirectional routing. Use it with the MCP SDK client: the SDK will call start() internally when you call client.connect(transport).

### Constructor

```typescript
new AMQPClientTransport(config: AMQPClientTransportOptions)
```

Required options:

- amqpUrl: string
- exchangeName: string
- serverQueuePrefix: string

### Lifecycle

- start(): Promise<void> — Initializes connection, response queue, and subscribes to notifications. Called by the MCP SDK during Client.connect().
- close(): Promise<void> — Closes channels and connection and clears pending requests.
- setProtocolVersion(version: string): void — MCP SDK compatibility.

### Message flow

- Requests: Published to the topic exchange `${exchangeName}.mcp.routing` with routing key `mcp.request.{method}` (with `/` replaced by `.`). Each request includes correlationId and replyTo (the client's exclusive response queue) in AMQP message properties.
- Responses: Received directly on the client's response queue as raw JSON-RPC 2.0 messages (no envelope), matched by correlationId.
- Notifications: Published with routing key `mcp.notification.{method}` and consumed via `mcp.notification.#` binding pattern.
- Custom routing: Use the `routingKeyStrategy` option to implement custom routing key derivation (e.g., category-based routing).

### Callbacks

- onmessage?: (message: JSONRPCMessage) => void — Invoked for responses and notifications.
- onerror?: (error: Error) => void
- onclose?: () => void

## AMQPServerTransport

AMQP server transport for MCP that supports session/stream-based bidirectional routing and response correlation.

### Constructor

```typescript
new AMQPServerTransport(config: AMQPServerTransportOptions)
```

Required options:

- amqpUrl: string
- exchangeName: string
- queuePrefix: string

### Lifecycle

- start(): Promise<void> — Idempotent. Initializes basic queue, and bidirectional pub/sub channels. The MCP SDK will call this when you server.connect(transport).
- close(): Promise<void> — Closes channels and connection.
- setProtocolVersion(version: string): void — MCP SDK compatibility.

### Message flow

- Incoming requests are consumed from a session-specific queue bound to `${exchangeName}.mcp.routing` using patterns like:
  - `{sessionId}.*` for session-specific routing
  - `mcp.request.#` for all request types
- Routing info (correlationId, replyTo, timestamp) is stored per requestId to route responses. Stale entries are automatically cleaned up based on TTL.
- Responses are sent directly to the client replyTo queue with the original correlationId using sendToQueue, with `contentType: 'application/json'`.
- Notifications are published to `${exchangeName}.mcp.routing` with routing key `mcp.notification.{method}`.

### Callbacks

- onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void — The SDK will call transport.send() with the response.
- onerror?: (error: Error) => void
- onclose?: () => void

## Options

```ts
export interface AMQPTransportOptions {
  amqpUrl: string;
  exchangeName: string;
  reconnectDelay?: number; // ms, default 5000
  maxReconnectAttempts?: number; // default 10
  prefetchCount?: number; // default 1 (server), 10 (client)
  messageTTL?: number; // ms
  queueTTL?: number; // ms
  routingKeyStrategy?: (method: string, messageType: 'request' | 'notification') => string;
  maxMessageSize?: number; // bytes, default 1048576 (1 MB)
}

export interface AMQPServerTransportOptions extends AMQPTransportOptions {
  queuePrefix: string; // e.g. "mcp.discovery"
}

export interface AMQPClientTransportOptions extends AMQPTransportOptions {
  serverQueuePrefix: string; // e.g. "mcp.discovery"
  responseTimeout?: number; // ms, default 30000
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

Information about message routing stored per request for response correlation.

```typescript
interface RoutingInfo {
  correlationId: string;
  replyTo: string;
  timestamp: number; // Used for TTL-based cleanup
}
```

**Note:** This is an internal type used by the server transport for managing response routing. The `timestamp` field enables automatic cleanup of stale routing entries.

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

Safely parses incoming AMQP messages. Returns the parsed JSON-RPC message or throws a descriptive error.

```typescript
function parseMessage(content: Buffer | string): JSONRPCMessage;
```

**Parameters:**

- `content`: Raw message content (Buffer or string)

**Returns:**

- Parsed `JSONRPCMessage` object

**Throws:**

- Error with detailed message if parsing or validation fails

**Example:**

```typescript
import { parseMessage } from "amqp-mcp-transport";

try {
  const message = parseMessage(buffer);
  console.log("Parsed message:", message);
} catch (error) {
  console.error("Failed to parse:", error.message);
}
```

### validateJSONRPC

Validates that an object conforms to JSON-RPC 2.0 specification.

```typescript
function validateJSONRPC(obj: unknown): JSONRPCMessage;
```

**Returns:** The validated `JSONRPCMessage`

**Throws:** Error if the message is invalid

**Example:**

```typescript
import { validateJSONRPC } from "amqp-mcp-transport";

try {
  const message = validateJSONRPC(JSON.parse(buffer.toString()));
  // Message is valid JSON-RPC 2.0
} catch (error) {
  console.error("Invalid JSON-RPC message:", error.message);
}
```

### getRoutingKey

Derives an AMQP routing key from a JSON-RPC method name and message type.

```typescript
function getRoutingKey(
  method: string,
  messageType: 'request' | 'notification',
  strategy?: RoutingKeyStrategy
): string;
```

**Parameters:**

- `method`: JSON-RPC method name (e.g., "tools/list")
- `messageType`: Type of message ('request' or 'notification')
- `strategy`: Optional custom routing strategy (uses default if not provided)

**Returns:** Routing key string (e.g., "mcp.request.tools.list")

**Example:**

```typescript
import { getRoutingKey } from "amqp-mcp-transport";

// Default strategy
const key1 = getRoutingKey("tools/list", "request");
console.log(key1); // "mcp.request.tools.list"

// Custom strategy for category-based routing
const customStrategy = (method: string, type: string) => {
  const category = method.startsWith("nmap_") ? "nmap" : "general";
  return `mcp.${type}.${category}.${method.replace(/\//g, ".")}`;
};
const key2 = getRoutingKey("nmap_scan", "request", customStrategy);
console.log(key2); // "mcp.request.nmap.nmap_scan"
```

### validateAmqpConfig

Validates required AMQP configuration values.

```typescript
function validateAmqpConfig(config: {
  amqpUrl: string;
  queuePrefix: string;
  exchangeName: string;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  prefetchCount?: number;
}): string[];
```

**Returns:** Array of validation error messages (empty when valid).

**Example:**

```typescript
import { validateAmqpConfig } from "amqp-mcp-transport";

const errors = validateAmqpConfig({
  amqpUrl: "amqp://localhost:5672",
  queuePrefix: "mcp.server",
  exchangeName: "mcp.notifications",
});

if (errors.length) console.error("Config errors:", errors);
```

### generateCorrelationId

Generates a unique correlation ID for request/response matching.

```typescript
function generateCorrelationId(sessionId: string): string;
```

**Parameters:**

- `sessionId`: Session identifier to include in correlation ID

**Returns:** Unique correlation ID string

**Example:**

```typescript
import { generateCorrelationId } from "amqp-mcp-transport";
import { randomUUID } from "crypto";

const sessionId = randomUUID();
const correlationId = generateCorrelationId(sessionId);
console.log(correlationId); // "{sessionId}-{random}"
```

### getDefaultConfig

Returns default AMQP configuration values from environment variables.

```typescript
function getDefaultConfig(): {
  AMQP_URL: string;
  AMQP_QUEUE_PREFIX: string;
  AMQP_EXCHANGE: string;
  AMQP_RESPONSE_TIMEOUT: number;
  AMQP_PREFETCH: number;
};
```

**Returns:** Configuration object with defaults from environment or hardcoded fallbacks

**Example:**

```typescript
import { getDefaultConfig } from "amqp-mcp-transport";

const defaults = getDefaultConfig();
console.log(defaults.AMQP_URL); // "amqp://guest:guest@localhost:5672"
```

**Example:**

```typescript
import { AMQPClientTransport, testAmqpConnection } from "amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  serverQueuePrefix: "mcp.server",
  exchangeName: "mcp.notifications",
});

const health = await testAmqpConnection(transport);
console.log(health);
```

### detectMessageType

Analyzes a JSON-RPC message to determine its role.

```typescript
function detectMessageType(
  message: JSONRPCMessage
): "request" | "response" | "notification";
```

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

<!-- Events section removed: transports expose callbacks (onmessage, onerror, onclose) rather than an EventEmitter API. Refer to the Callbacks section for each transport. -->
