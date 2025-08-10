# Examples

This document provides comprehensive examples of using the AMQP MCP Transport in various scenarios.

## Table of Contents

- [Basic Examples](#basic-examples)
- [Advanced Examples](#advanced-examples)
- [Integration Examples](#integration-examples)
- [Production Examples](#production-examples)

## Basic Examples

### Simple Client-Server Communication

**Client (client.ts)**

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

async function runClient() {
  const client = new AMQPClientTransport({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
  });

  try {
    await client.connect();
    console.log("Client connected");

    // List available tools
    const toolsResponse = await client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    console.log("Available tools:", toolsResponse.result);

    // Call a specific tool
    if (toolsResponse.result?.tools?.length > 0) {
      const toolName = toolsResponse.result.tools[0].name;
      const toolResponse = await client.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {},
        },
      });

      console.log("Tool response:", toolResponse.result);
    }
  } catch (error) {
    console.error("Client error:", error);
  } finally {
    await client.close();
  }
}

runClient();
```

**Server (server.ts)**

```typescript
import { AMQPServerTransport } from "amqp-mcp-transport";

async function runServer() {
  const server = new AMQPServerTransport({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
  });

  // Define available tools
  const tools = [
    {
      name: "echo",
      description: "Echo back the input",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: "math_add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    },
  ];

  // Set up message handler
  server.onmessage = async (message) => {
    console.log("Received message:", message);

    switch (message.method) {
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools },
        };

      case "tools/call":
        const { name, arguments: args } = message.params;

        switch (name) {
          case "echo":
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Echo: ${args.message}`,
                  },
                ],
              },
            };

          case "math_add":
            const sum = args.a + args.b;
            return {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `${args.a} + ${args.b} = ${sum}`,
                  },
                ],
              },
            };

          default:
            return {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32601,
                message: `Tool '${name}' not found`,
              },
            };
        }

      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method '${message.method}' not found`,
          },
        };
    }
  };

  try {
    await server.start();
    console.log("Server started and listening for messages");

    // Keep the server running
    process.on("SIGINT", async () => {
      console.log("Shutting down server...");
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("Server error:", error);
  }
}

runServer();
```

### Bidirectional Communication

**Server with Notifications**

```typescript
import { AMQPServerTransport } from "amqp-mcp-transport";

async function runBidirectionalServer() {
  const server = new AMQPServerTransport({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
    enableBidirectional: true, // Enable bidirectional communication
  });

  let connectedClients = 0;

  server.onmessage = async (message) => {
    if (message.method === "client/connect") {
      connectedClients++;
      console.log(`Client connected. Total: ${connectedClients}`);

      // Send welcome notification to client
      await server.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "info",
          text: `Welcome! You are client #${connectedClients}`,
        },
      });

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { status: "connected", clientId: connectedClients },
      };
    }

    if (message.method === "client/disconnect") {
      connectedClients--;
      console.log(`Client disconnected. Total: ${connectedClients}`);

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { status: "disconnected" },
      };
    }

    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    };
  };

  await server.start();
  console.log("Bidirectional server started");

  // Send periodic heartbeats
  setInterval(async () => {
    if (connectedClients > 0) {
      await server.send({
        jsonrpc: "2.0",
        method: "notifications/heartbeat",
        params: {
          timestamp: new Date().toISOString(),
          activeClients: connectedClients,
        },
      });
    }
  }, 30000);
}

runBidirectionalServer();
```

**Client with Notification Handling**

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

async function runBidirectionalClient() {
  const client = new AMQPClientTransport({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
  });

  // Handle incoming notifications
  client.onmessage = (notification) => {
    console.log("Received notification:", notification);

    if (notification.method === "notifications/message") {
      console.log(`Server message: ${notification.params.text}`);
    } else if (notification.method === "notifications/heartbeat") {
      console.log(`Heartbeat: ${notification.params.timestamp}`);
    }
  };

  await client.connect();

  // Connect to server
  const connectResponse = await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "client/connect",
    params: {},
  });

  console.log("Connected to server:", connectResponse.result);

  // Keep client running for 2 minutes
  setTimeout(async () => {
    await client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "client/disconnect",
      params: {},
    });

    await client.close();
  }, 120000);
}

runBidirectionalClient();
```

## Advanced Examples

### Error Handling and Retry Logic

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

class ResilientAMQPClient {
  private client: AMQPClientTransport;
  private maxRetries: number = 3;
  private retryDelay: number = 1000;

  constructor(config: AMQPConfig) {
    this.client = new AMQPClientTransport(config);

    // Set up error handlers
    this.client.onerror = (error) => {
      console.error("Transport error:", error);
    };

    this.client.onclose = () => {
      console.log("Connection closed, attempting to reconnect...");
      this.reconnect();
    };
  }

  async connect(): Promise<void> {
    let attempts = 0;

    while (attempts < this.maxRetries) {
      try {
        await this.client.connect();
        console.log("Connected successfully");
        return;
      } catch (error) {
        attempts++;
        console.error(`Connection attempt ${attempts} failed:`, error);

        if (attempts < this.maxRetries) {
          await this.delay(this.retryDelay * attempts);
        }
      }
    }

    throw new Error(`Failed to connect after ${this.maxRetries} attempts`);
  }

  async sendWithRetry(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    let attempts = 0;

    while (attempts < this.maxRetries) {
      try {
        return await this.client.send(message);
      } catch (error) {
        attempts++;
        console.error(`Send attempt ${attempts} failed:`, error);

        if (attempts < this.maxRetries) {
          await this.delay(this.retryDelay * attempts);
        }
      }
    }

    throw new Error(`Failed to send message after ${this.maxRetries} attempts`);
  }

  private async reconnect(): Promise<void> {
    try {
      await this.delay(this.retryDelay);
      await this.connect();
    } catch (error) {
      console.error("Reconnection failed:", error);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// Usage
async function useResilientClient() {
  const client = new ResilientAMQPClient({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
    requestTimeout: 10000,
  });

  try {
    await client.connect();

    const response = await client.sendWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    console.log("Response:", response);
  } catch (error) {
    console.error("Operation failed:", error);
  } finally {
    await client.close();
  }
}
```

### Performance Monitoring

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

class MonitoredAMQPClient {
  private client: AMQPClientTransport;
  private metrics = {
    messagesSent: 0,
    messagesReceived: 0,
    totalResponseTime: 0,
    errors: 0,
    startTime: Date.now(),
  };

  constructor(config: AMQPConfig) {
    this.client = new AMQPClientTransport(config);
    this.setupMonitoring();
  }

  private setupMonitoring(): void {
    const originalSend = this.client.send.bind(this.client);

    this.client.send = async (message: JSONRPCMessage) => {
      const startTime = Date.now();
      this.metrics.messagesSent++;

      try {
        const response = await originalSend(message);
        const responseTime = Date.now() - startTime;
        this.metrics.totalResponseTime += responseTime;
        this.metrics.messagesReceived++;

        console.log(`Message sent in ${responseTime}ms`);
        return response;
      } catch (error) {
        this.metrics.errors++;
        throw error;
      }
    };

    // Log metrics every 30 seconds
    setInterval(() => {
      this.logMetrics();
    }, 30000);
  }

  private logMetrics(): void {
    const uptime = Date.now() - this.metrics.startTime;
    const avgResponseTime =
      this.metrics.messagesReceived > 0
        ? this.metrics.totalResponseTime / this.metrics.messagesReceived
        : 0;

    console.log("AMQP Client Metrics:", {
      uptime: `${Math.round(uptime / 1000)}s`,
      messagesSent: this.metrics.messagesSent,
      messagesReceived: this.metrics.messagesReceived,
      errors: this.metrics.errors,
      avgResponseTime: `${Math.round(avgResponseTime)}ms`,
      errorRate:
        this.metrics.messagesSent > 0
          ? `${Math.round(
              (this.metrics.errors / this.metrics.messagesSent) * 100
            )}%`
          : "0%",
    });
  }

  async connect(): Promise<void> {
    return this.client.connect();
  }

  async send(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    return this.client.send(message);
  }

  async close(): Promise<void> {
    this.logMetrics(); // Final metrics
    return this.client.close();
  }

  getMetrics() {
    return { ...this.metrics };
  }
}
```

### Message Filtering and Routing

```typescript
import { AMQPServerTransport } from "amqp-mcp-transport";
import { getToolCategory } from "amqp-mcp-transport";

class RoutingAMQPServer {
  private server: AMQPServerTransport;
  private handlers = new Map<
    string,
    (message: JSONRPCMessage) => Promise<JSONRPCMessage>
  >();

  constructor(config: AMQPConfig) {
    this.server = new AMQPServerTransport(config);
    this.setupRouting();
  }

  private setupRouting(): void {
    this.server.onmessage = async (message) => {
      try {
        // Route based on method
        if (message.method) {
          const handler = this.handlers.get(message.method);
          if (handler) {
            return await handler(message);
          }
        }

        // Route based on tool category for tool calls
        if (message.method === "tools/call") {
          const category = getToolCategory(message);
          const categoryHandler = this.handlers.get(`category:${category}`);
          if (categoryHandler) {
            return await categoryHandler(message);
          }
        }

        // Default error response
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        };
      } catch (error) {
        console.error("Handler error:", error);
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: error.message,
          },
        };
      }
    };
  }

  // Register method handler
  onMethod(
    method: string,
    handler: (message: JSONRPCMessage) => Promise<JSONRPCMessage>
  ): void {
    this.handlers.set(method, handler);
  }

  // Register category handler
  onCategory(
    category: string,
    handler: (message: JSONRPCMessage) => Promise<JSONRPCMessage>
  ): void {
    this.handlers.set(`category:${category}`, handler);
  }

  async start(): Promise<void> {
    return this.server.start();
  }

  async close(): Promise<void> {
    return this.server.close();
  }
}

// Usage
async function setupRoutingServer() {
  const server = new RoutingAMQPServer({
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
  });

  // Handle tools/list method
  server.onMethod("tools/list", async (message) => {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "read_file", description: "Read a file", inputSchema: {} },
          { name: "write_file", description: "Write a file", inputSchema: {} },
          {
            name: "http_get",
            description: "Make HTTP GET request",
            inputSchema: {},
          },
        ],
      },
    };
  });

  // Handle filesystem tools
  server.onCategory("filesystem", async (message) => {
    const { name, arguments: args } = message.params;

    if (name === "read_file") {
      // Simulate file reading
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `Contents of ${args.path}` }],
        },
      };
    }

    // Handle other filesystem tools...
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Tool not implemented" },
    };
  });

  // Handle network tools
  server.onCategory("network", async (message) => {
    const { name, arguments: args } = message.params;

    if (name === "http_get") {
      // Simulate HTTP request
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: `HTTP GET response from ${args.url}` },
          ],
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Tool not implemented" },
    };
  });

  await server.start();
  console.log("Routing server started");
}
```

## Integration Examples

### Express.js Integration

```typescript
import express from "express";
import { AMQPClientTransport } from "amqp-mcp-transport";

const app = express();
app.use(express.json());

// Initialize AMQP client
const amqpClient = new AMQPClientTransport({
  url: process.env.AMQP_URL || "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
});

// Connect to AMQP broker on startup
amqpClient.connect().catch(console.error);

// API endpoint to list tools
app.get("/api/tools", async (req, res) => {
  try {
    const response = await amqpClient.send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
      params: {},
    });

    if (response.error) {
      return res.status(400).json({ error: response.error });
    }

    res.json(response.result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to call a tool
app.post("/api/tools/:toolName", async (req, res) => {
  try {
    const { toolName } = req.params;
    const { arguments: args } = req.body;

    const response = await amqpClient.send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args || {},
      },
    });

    if (response.error) {
      return res.status(400).json({ error: response.error });
    }

    res.json(response.result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await amqpClient.close();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### WebSocket Bridge

```typescript
import WebSocket from "ws";
import { AMQPClientTransport } from "amqp-mcp-transport";

class AMQPWebSocketBridge {
  private wss: WebSocket.Server;
  private amqpClient: AMQPClientTransport;
  private clients = new Map<WebSocket, string>();

  constructor(wsPort: number, amqpConfig: AMQPConfig) {
    this.wss = new WebSocket.Server({ port: wsPort });
    this.amqpClient = new AMQPClientTransport(amqpConfig);
    this.setupWebSocketServer();
    this.setupAMQPClient();
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws) => {
      const clientId = `client_${Date.now()}`;
      this.clients.set(ws, clientId);
      console.log(`WebSocket client connected: ${clientId}`);

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Forward message to AMQP
          const response = await this.amqpClient.send(message);

          // Send response back to WebSocket client
          ws.send(JSON.stringify(response));
        } catch (error) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700,
                message: "Parse error",
                data: error.message,
              },
            })
          );
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`WebSocket client disconnected: ${clientId}`);
      });
    });
  }

  private setupAMQPClient(): void {
    // Handle incoming notifications from AMQP
    this.amqpClient.onmessage = (notification) => {
      // Broadcast to all connected WebSocket clients
      this.clients.forEach((clientId, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(notification));
        }
      });
    };
  }

  async start(): Promise<void> {
    await this.amqpClient.connect();
    console.log("AMQP-WebSocket bridge started");
  }

  async stop(): Promise<void> {
    this.wss.close();
    await this.amqpClient.close();
    console.log("AMQP-WebSocket bridge stopped");
  }
}

// Usage
async function startBridge() {
  const bridge = new AMQPWebSocketBridge(8080, {
    url: "amqp://localhost:5672",
    requestQueue: "mcp_requests",
    responseQueue: "mcp_responses",
  });

  await bridge.start();

  process.on("SIGINT", async () => {
    await bridge.stop();
    process.exit(0);
  });
}

startBridge();
```

## Production Examples

### Load Balancing with Multiple Workers

```typescript
import cluster from "cluster";
import os from "os";
import { AMQPServerTransport } from "amqp-mcp-transport";

if (cluster.isPrimary) {
  // Master process - spawn workers
  const numWorkers = os.cpus().length;
  console.log(`Starting ${numWorkers} workers`);

  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork(); // Restart worker
  });
} else {
  // Worker process
  async function startWorker() {
    const server = new AMQPServerTransport({
      url: process.env.AMQP_URL || "amqp://localhost:5672",
      requestQueue: "mcp_requests",
      responseQueue: "mcp_responses",

      consumerOptions: {
        prefetch: 1, // Process one message at a time
      },
    });

    server.onmessage = async (message) => {
      const workerId = process.pid;
      console.log(`Worker ${workerId} processing message:`, message.id);

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 100));

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          processedBy: workerId,
          timestamp: new Date().toISOString(),
        },
      };
    };

    await server.start();
    console.log(`Worker ${process.pid} started`);
  }

  startWorker().catch(console.error);
}
```

### Health Monitoring and Circuit Breaker

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

class CircuitBreakerAMQPClient {
  private client: AMQPClientTransport;
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private failureThreshold = 5;
  private resetTimeout = 60000; // 1 minute
  private resetTimer?: NodeJS.Timeout;

  constructor(config: AMQPConfig) {
    this.client = new AMQPClientTransport(config);
  }

  async send(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    if (this.state === CircuitState.OPEN) {
      throw new Error("Circuit breaker is OPEN");
    }

    try {
      const response = await this.client.send(message);
      this.onSuccess();
      return response;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      console.log("Circuit breaker closed");
    }
  }

  private onFailure(): void {
    this.failureCount++;

    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      console.log("Circuit breaker opened");

      this.resetTimer = setTimeout(() => {
        this.state = CircuitState.HALF_OPEN;
        console.log("Circuit breaker half-open");
      }, this.resetTimeout);
    }
  }

  async connect(): Promise<void> {
    return this.client.connect();
  }

  async close(): Promise<void> {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    return this.client.close();
  }

  getState(): string {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }
}
```

These examples demonstrate the flexibility and power of the AMQP MCP Transport. They show how to handle common scenarios like error recovery, performance monitoring, routing, and integration with other systems. Use them as starting points for your own implementations.
