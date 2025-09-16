# Troubleshooting Guide

This guide targets the current AMQP transport design: bidirectional routing via a topic exchange using correlationId + replyTo for responses, and the MCP SDK-managed lifecycle.

## Quick checks

- Client/server option names must match the new API
  - Client: amqpUrl, serverQueuePrefix, exchangeName, responseTimeout?
  - Server: amqpUrl, queuePrefix, exchangeName, prefetchCount?
- Client and server must agree on both queuePrefix/serverQueuePrefix and exchangeName.
- The routing exchange is `${exchangeName}.mcp.routing` (topic).
- The MCP SDK calls transport.start() during connect(); don’t call start() manually.

## Connection issues

### Can’t reach broker

```typescript
import { AMQPClientTransport, testAmqpConnection } from "amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  serverQueuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
});

const health = await testAmqpConnection(transport);
console.log("AMQP health:", health);
```

Status snapshot

```typescript
import { getAmqpStatus } from "amqp-mcp-transport";

// Example status including auto-recovery metadata
const status = getAmqpStatus(transport as any, {
  enabled: true,
  status: "standby",
  retryCount: 0,
});
console.log("AMQP status:", status);
```

PowerShell helpers (Windows):

```powershell
# RabbitMQ container running?
docker ps --format 'table {{.Names}}\t{{.Ports}}' | Select-String rabbit

# Native service status
rabbitmqctl status
```

### Wrong URL or credentials

```typescript
// Wrong
const bad = { amqpUrl: "amqp://localhost:5673" };

// Right
const ok = { amqpUrl: "amqp://user:pass@localhost:5672" };
```

### Minimal connectivity via SDK

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: "amqp://guest:guest@localhost:5672",
  serverQueuePrefix: "test.app",
  exchangeName: "mcp.notifications",
});

const client = new Client(
  { name: "probe", version: "1.0.0" },
  { capabilities: {} }
);
await client.connect(transport);
await client.close();
```

## Messages not flowing

- Ensure both sides use the same exchangeName and queuePrefix/serverQueuePrefix.
- The server should set prefetchCount to control concurrency.
- Notifications are delivered over the same exchange; no extra queues needed.

Server probe

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "amqp-mcp-transport";

const transport = new AMQPServerTransport({
  amqpUrl: "amqp://localhost:5672",
  queuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
});

const server = new Server(
  { name: "probe-server", version: "1.0.0" },
  { capabilities: {} }
);
await server.connect(transport);
```

## Timeouts

- Increase client responseTimeout for slow operations.

```typescript
const c = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  serverQueuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
  responseTimeout: 60000,
});
```

## TLS (amqps)

- Use amqps:// URLs and provide CA/cert/key as required by your environment. Configure via your process/environment or amqplib connection options.

## Debugging

- Add logging around request/response handling in your app.
- Inspect `${exchangeName}.mcp.routing` and bound queues in RabbitMQ Management UI.
- Verify your broker policies don’t auto-delete transient queues you rely on.

## Common pitfalls

- Mixing old option names (url/requestQueue/responseQueue) with the new API.
- Mismatched exchangeName or prefixes between client and server.
- Manually calling start() instead of using SDK connect().

## Message Handling Issues

### Messages Not Being Received

**Symptoms:**

- Server doesn't receive messages
- Client requests timeout
- Empty response queues

**Diagnosis:**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "amqp-mcp-transport";

const transport = new AMQPServerTransport({
  amqpUrl: "amqp://localhost:5672",
  queuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
});

const server = new Server(
  { name: "diag", version: "1.0.0" },
  { capabilities: {} }
);
await server.connect(transport); // SDK starts the transport
console.log("Server connected and listening");
```

**Solutions:**

1. **Verify prefixes and exchange match:**

```typescript
const clientConfig = {
  serverQueuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
};

const serverConfig = {
  queuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
};
```

2. **Check message handler:**

```typescript
server.onmessage = async (message) => {
  // Always handle the message
  console.log("Processing:", message);

  // Always return a response for requests
  if (message.id !== undefined) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { status: "processed" },
    };
  }

  // Notifications don't need responses
};
```

3. **Verify queue/exchange in broker UI:**

```powershell
# Check bound queues and routing keys in RabbitMQ Management UI
Start-Process http://localhost:15672
# Check RabbitMQ queue status
rabbitmqctl list_queues name messages consumers
```

### Request Timeouts

**Symptoms:**

- `REQUEST_TIMEOUT` errors
- Long response times
- Client hangs waiting for responses

**Diagnosis:**

```typescript
// Measure actual response times
const startTime = Date.now();

try {
  const response = await client.send(message);
  const duration = Date.now() - startTime;
  console.log(`Response received in ${duration}ms`);
} catch (error) {
  if (error.code === "REQUEST_TIMEOUT") {
    console.log("Request timed out after", client.requestTimeout, "ms");
  }
}
```

**Solutions:**

1. **Increase client responseTimeout:**

```typescript
const client = new AMQPClientTransport({
  amqpUrl: "amqp://localhost:5672",
  serverQueuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
  responseTimeout: 60000,
});
```

2. **Optimize server handlers:**

Use the MCP SDK request handlers and implement timeouts within your business logic when needed.

3. **Implement request queuing:**

```typescript
class QueuedAMQPClient {
  private client: AMQPClientTransport;
  private queue: Array<{
    message: JSONRPCMessage;
    resolve: (value: JSONRPCMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  private processing = false;

  async send(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const { message, resolve, reject } = this.queue.shift()!;

      try {
        const response = await this.client.send(message);
        resolve(response);
      } catch (error) {
        reject(error);
      }
    }

    this.processing = false;
  }
}
```

### Message Serialization Errors

**Symptoms:**

- `JSON.parse` errors
- Malformed message errors
- `SyntaxError: Unexpected token`

**Diagnosis:**

```typescript
import { parseMessage } from "amqp-mcp-transport";

// Test message parsing
const testBuffer = Buffer.from('{"invalid": json}');
const parsed = parseMessage(testBuffer);
if (!parsed) {
  console.log("Failed to parse message");
}
```

**Solutions:**

1. **Validate messages before sending:**

```typescript
function validateJsonRpcMessage(message: any): boolean {
  return (
    message &&
    message.jsonrpc === "2.0" &&
    (message.method || message.result || message.error) &&
    (message.id !== undefined || !message.method)
  );
}

// Before sending
if (!validateJsonRpcMessage(message)) {
  throw new Error("Invalid JSON-RPC message");
}
```

2. **Handle parsing errors gracefully:**

```typescript
server.onmessage = async (message) => {
  try {
    // Process message
    return processMessage(message);
  } catch (error) {
    console.error("Message processing error:", error);

    return {
      jsonrpc: "2.0",
      id: message.id || null,
      error: {
        code: -32700,
        message: "Parse error",
        data: error.message,
      },
    };
  }
};
```

## Performance Issues

### High Latency

**Symptoms:**

- Slow response times
- High average response time metrics
- User complaints about sluggishness

**Diagnosis:**

```typescript
// Add performance monitoring
const performanceMetrics = {
  requests: 0,
  totalTime: 0,
  minTime: Infinity,
  maxTime: 0,
};

const originalSend = client.send.bind(client);
client.send = async (message) => {
  const start = Date.now();

  try {
    const result = await originalSend(message);
    const duration = Date.now() - start;

    performanceMetrics.requests++;
    performanceMetrics.totalTime += duration;
    performanceMetrics.minTime = Math.min(performanceMetrics.minTime, duration);
    performanceMetrics.maxTime = Math.max(performanceMetrics.maxTime, duration);

    console.log(`Request completed in ${duration}ms`);
    return result;
  } catch (error) {
    console.log(`Request failed after ${Date.now() - start}ms`);
    throw error;
  }
};

// Log metrics periodically
setInterval(() => {
  if (performanceMetrics.requests > 0) {
    console.log("Performance metrics:", {
      avgTime: performanceMetrics.totalTime / performanceMetrics.requests,
      minTime: performanceMetrics.minTime,
      maxTime: performanceMetrics.maxTime,
      totalRequests: performanceMetrics.requests,
    });
  }
}, 10000);
```

**Solutions:**

1. **Optimize prefetch settings:**

```typescript
const config = {
  // ... other config
  consumerOptions: {
    prefetch: 10, // Process multiple messages concurrently
  },
};
```

2. **Use connection pooling:**

```typescript
class AMQPConnectionPool {
  private pools: AMQPClientTransport[] = [];
  private currentIndex = 0;

  constructor(config: AMQPConfig, poolSize: number = 5) {
    for (let i = 0; i < poolSize; i++) {
      this.pools.push(new AMQPClientTransport(config));
    }
  }

  async send(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    const client = this.pools[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.pools.length;
    return client.send(message);
  }

  async connect(): Promise<void> {
    await Promise.all(this.pools.map((client) => client.connect()));
  }

  async close(): Promise<void> {
    await Promise.all(this.pools.map((client) => client.close()));
  }
}
```

### Memory Leaks

**Symptoms:**

- Increasing memory usage over time
- Out of memory errors
- Node.js process crashes

**Diagnosis:**

```bash
# Monitor memory usage
node --max-old-space-size=4096 --trace-gc your-app.js

# Or use built-in monitoring
```

```typescript
// Memory monitoring
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log("Memory usage:", {
    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
  });
}, 30000);
```

**Solutions:**

1. **Properly close connections:**

```typescript
// Always close connections
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});
```

2. **Implement connection cleanup:**

```typescript
class ManagedAMQPClient {
  private client: AMQPClientTransport;
  private cleanupTimer: NodeJS.Timeout;

  constructor(config: AMQPConfig) {
    this.client = new AMQPClientTransport(config);

    // Periodic cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 300000); // Every 5 minutes
  }

  private cleanup() {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    console.log("Cleanup completed");
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await this.client.close();
  }
}
```

## Configuration Issues

### Invalid Configuration

**Symptoms:**

- Validation errors on startup
- Transport construction failures
- Runtime configuration errors

**Diagnosis:**

```typescript
import { validateAmqpConfig } from "amqp-mcp-transport";

const errors = validateAmqpConfig({
  amqpUrl: "amqp://localhost:5672",
  queuePrefix: "mcp.example",
  exchangeName: "mcp.notifications",
});
if (errors.length) {
  console.error("Configuration errors:", errors);
}
```

**Solutions:**

1. **Use configuration validation:**

```typescript
function createValidatedClient(config: {
  amqpUrl: string;
  serverQueuePrefix: string;
  exchangeName: string;
  responseTimeout?: number;
}) {
  const errors = validateAmqpConfig({
    amqpUrl: config.amqpUrl,
    queuePrefix: config.serverQueuePrefix,
    exchangeName: config.exchangeName,
  });
  if (errors.length)
    throw new Error(`Configuration invalid: ${errors.join(", ")}`);

  return new AMQPClientTransport(config);
}
```

2. **Provide configuration defaults:**

```typescript
function createClientWithDefaults(
  partial: Partial<{
    amqpUrl: string;
    serverQueuePrefix: string;
    exchangeName: string;
    responseTimeout: number;
  }>
) {
  const defaults = {
    amqpUrl: "amqp://localhost:5672",
    serverQueuePrefix: "mcp.example",
    exchangeName: "mcp.notifications",
    responseTimeout: 30000,
  } as const;

  const config = { ...defaults, ...partial };
  return new AMQPClientTransport(config);
}
```

## Error Codes Reference

### Transport Error Codes

| Code                    | Description              | Typical Cause                  | Solution                                |
| ----------------------- | ------------------------ | ------------------------------ | --------------------------------------- |
| `CONNECTION_FAILED`     | Cannot connect to broker | Broker down, wrong URL         | Check broker status and URL             |
| `CONNECTION_LOST`       | Connection dropped       | Network issues, broker restart | Implement reconnection logic            |
| `AUTHENTICATION_FAILED` | Invalid credentials      | Wrong username/password        | Check credentials                       |
| `REQUEST_TIMEOUT`       | Request timed out        | Slow processing, high load     | Increase timeout or optimize processing |
| `QUEUE_NOT_FOUND`       | Queue doesn't exist      | Queue not declared             | Ensure queue creation                   |
| `PERMISSION_DENIED`     | Insufficient permissions | User lacks queue access        | Check user permissions                  |

### JSON-RPC Error Codes

| Code     | Description      | Meaning                   |
| -------- | ---------------- | ------------------------- |
| `-32700` | Parse error      | Invalid JSON received     |
| `-32600` | Invalid Request  | JSON-RPC format error     |
| `-32601` | Method not found | Unknown method called     |
| `-32602` | Invalid params   | Invalid method parameters |
| `-32603` | Internal error   | Server-side error         |

## Debugging Tools

### Enable Debug Logging

```typescript
// Set environment variable
process.env.DEBUG = "amqp-mcp-transport:*";

// Or use console logging
const client = new AMQPClientTransport(config);

client.onerror = (error) => {
  console.error("Transport error:", error);
};

client.onclose = () => {
  console.log("Transport closed");
};
```

### Message Tracing

```typescript
class TracingAMQPClient {
  private client: AMQPClientTransport;
  private messageLog: Array<{
    id: any;
    direction: "sent" | "received";
    timestamp: number;
    message: JSONRPCMessage;
  }> = [];

  constructor(config: AMQPConfig) {
    this.client = new AMQPClientTransport(config);
    this.setupTracing();
  }

  private setupTracing() {
    const originalSend = this.client.send.bind(this.client);

    this.client.send = async (message) => {
      this.messageLog.push({
        id: message.id,
        direction: "sent",
        timestamp: Date.now(),
        message: { ...message },
      });

      try {
        const response = await originalSend(message);

        this.messageLog.push({
          id: response.id,
          direction: "received",
          timestamp: Date.now(),
          message: { ...response },
        });

        return response;
      } catch (error) {
        console.error("Send failed:", error);
        throw error;
      }
    };
  }

  getMessageLog() {
    return this.messageLog;
  }

  clearMessageLog() {
    this.messageLog = [];
  }
}
```

### Health Checks

```typescript
class HealthCheckAMQPClient {
  private client: AMQPClientTransport;

  async healthCheck(): Promise<{
    status: "healthy" | "unhealthy";
    details: any;
  }> {
    try {
      const start = Date.now();

      // Send a simple ping message
      const response = await this.client.send({
        jsonrpc: "2.0",
        id: "health-check",
        method: "ping",
        params: {},
      });

      const latency = Date.now() - start;

      return {
        status: "healthy",
        details: {
          latency,
          lastCheck: new Date().toISOString(),
          response: response.result,
        },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        details: {
          error: error.message,
          lastCheck: new Date().toISOString(),
        },
      };
    }
  }
}
```

## Common Patterns

### Graceful Shutdown

```typescript
class GracefulAMQPService {
  private server: AMQPServerTransport;
  private isShuttingDown = false;

  constructor(config: AMQPConfig) {
    this.server = new AMQPServerTransport(config);
    this.setupShutdownHandlers();
  }

  private setupShutdownHandlers() {
    const gracefulShutdown = async (signal: string) => {
      if (this.isShuttingDown) return;

      console.log(`Received ${signal}, starting graceful shutdown...`);
      this.isShuttingDown = true;

      try {
        // Stop accepting new messages
        await this.server.close();
        console.log("AMQP server closed");

        // Give time for in-flight requests to complete
        await new Promise((resolve) => setTimeout(resolve, 5000));

        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  }
}
```

### Retry with Exponential Backoff

```typescript
async function sendWithRetry(
  client: AMQPClientTransport,
  message: JSONRPCMessage,
  maxRetries: number = 3
): Promise<JSONRPCMessage> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.send(message);
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
```

If you're still experiencing issues after trying these solutions, please [open an issue](https://github.com/your-org/AMQPConnectorforMCP/issues) with:

1. Your configuration
2. Error messages and stack traces
3. Steps to reproduce the issue
4. Environment details (Node.js version, AMQP broker version, etc.)
