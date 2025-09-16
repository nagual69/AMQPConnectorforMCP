# API Reference

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

- Requests: Published to the topic exchange `${exchangeName}.mcp.routing` with routing key `mcp.request.{category}.{method}`. Each request includes correlationId and replyTo (the client’s exclusive response queue).
- Responses: Received directly on the client’s response queue as raw JSON-RPC 2.0 messages (no envelope), matched by correlationId.
- Notifications/events: Subscribed via `${exchangeName}.mcp.routing` with patterns `mcp.notification.#`, `mcp.event.#`, `discovery.notification.#`, `discovery.event.#`.

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
  - `{sessionId}.*`
  - `mcp.request.#`, `mcp.tools.#`, `mcp.resources.#`, `mcp.prompts.#`
- Routing info (correlationId, replyTo) is stored per requestId to route responses.
- Responses are sent directly to the client replyTo queue with the original correlationId using sendToQueue.
- Notifications are published to `${exchangeName}` using category-based routing keys.

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

Safely parses incoming AMQP messages with error details.

```typescript
function parseMessage(
  content: Buffer | string,
  transportType?: string
): { success: boolean; message: JSONRPCMessage | null; error: Error | null };
```

**Parameters:**

- `content`: Raw message content (Buffer or string)
- `transportType`: Optional label for logs (e.g., 'amqp')

**Returns:**

- Object with `success`, `message`, and `error` fields

**Example:**

```typescript
import { parseMessage } from "amqp-mcp-transport";

const { success, message, error } = parseMessage(buffer, "amqp");
if (!success) {
  console.error("Failed to parse:", error);
} else {
  console.log("Parsed message:", message);
}
```

### getToolCategory

Determines tool category from a method name for routing.

```typescript
function getToolCategory(method: string): string;
```

**Returns:** Category string such as 'network', 'snmp', 'nmap', 'memory', or 'general'.

**Example:**

```typescript
import { getToolCategory } from "amqp-mcp-transport";

console.log(getToolCategory("nmap_scan")); // 'nmap'
console.log(getToolCategory("ping")); // 'network'
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

### testAmqpConnection

Publishes a heartbeat using the provided transport connection to verify broker health.

```typescript
function testAmqpConnection(transport: any): Promise<{
  healthy: boolean;
  reason?: string;
  timestamp: string;
}>;
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
