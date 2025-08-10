# Configuration Guide

## Overview

The AMQP MCP Transport provides extensive configuration options to accommodate various deployment scenarios, from simple development setups to enterprise production environments.

## Basic Configuration

### Minimal Setup

```typescript
import { AMQPClientTransport } from "amqp-mcp-transport";

const client = new AMQPClientTransport({
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",
});
```

### Environment-Based Configuration

```typescript
const config = {
  url: process.env.AMQP_URL || "amqp://localhost:5672",
  requestQueue: process.env.AMQP_REQUEST_QUEUE || "mcp_requests",
  responseQueue: process.env.AMQP_RESPONSE_QUEUE || "mcp_responses",
  requestTimeout: parseInt(process.env.AMQP_TIMEOUT || "30000"),
};
```

## Advanced Configuration

### Connection Options

Configure low-level AMQP connection parameters:

```typescript
const config: AMQPConfig = {
  url: "amqp://user:pass@broker.example.com:5672/vhost",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",

  connectionOptions: {
    // Heartbeat interval in seconds
    heartbeat: 60,

    // Connection locale
    locale: "en_US",

    // Frame size limit
    frameMax: 131072,

    // Number of channels per connection
    channelMax: 1000,

    // Connection timeout
    connectionTimeout: 10000,

    // Enable/disable Nagle's algorithm
    noDelay: true,

    // Keep-alive settings
    keepAlive: true,
    keepAliveDelay: 60000,
  },
};
```

### Queue Configuration

Customize queue behavior and durability:

```typescript
const config: AMQPConfig = {
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",

  queueOptions: {
    // Queue survives broker restarts
    durable: true,

    // Queue deleted when connection closes
    exclusive: false,

    // Queue deleted when no consumers
    autoDelete: false,

    // Additional queue arguments
    arguments: {
      "x-message-ttl": 300000, // Message TTL (5 minutes)
      "x-max-length": 10000, // Maximum queue length
      "x-max-length-bytes": 104857600, // Maximum queue size (100MB)
      "x-dead-letter-exchange": "dlx", // Dead letter exchange
      "x-dead-letter-routing-key": "failed",
    },
  },
};
```

### Consumer Configuration

Control message consumption behavior:

```typescript
const config: AMQPConfig = {
  url: "amqp://localhost:5672",
  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",

  consumerOptions: {
    // Automatic message acknowledgment
    noAck: false,

    // Exclusive consumer
    exclusive: false,

    // Consumer priority
    priority: 0,

    // Prefetch count for flow control
    prefetch: 1,

    // Consumer tag
    consumerTag: "mcp-consumer",

    // Additional consumer arguments
    arguments: {
      "x-priority": 10,
    },
  },
};
```

## Production Configuration

### High Availability Setup

```typescript
const productionConfig: AMQPConfig = {
  // Multiple broker URLs for failover
  url: "amqp://user:pass@primary.broker.com:5672,amqp://user:pass@secondary.broker.com:5672",

  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",

  // Extended timeout for production loads
  requestTimeout: 60000,

  // Enable bidirectional for real-time updates
  enableBidirectional: true,

  connectionOptions: {
    heartbeat: 30,
    connectionTimeout: 15000,
    frameMax: 262144,
    channelMax: 2000,
  },

  queueOptions: {
    durable: true,
    exclusive: false,
    autoDelete: false,
    arguments: {
      "x-message-ttl": 1800000, // 30 minutes
      "x-max-length": 50000,
      "x-max-length-bytes": 524288000, // 500MB
      "x-dead-letter-exchange": "mcp-dlx",
    },
  },

  consumerOptions: {
    noAck: false,
    exclusive: false,
    prefetch: 10,
    arguments: {
      "x-priority": 5,
    },
  },
};
```

### Security Configuration

```typescript
const secureConfig: AMQPConfig = {
  // SSL/TLS connection
  url: "amqps://user:pass@secure.broker.com:5671",

  requestQueue: "mcp_requests",
  responseQueue: "mcp_responses",

  connectionOptions: {
    // SSL/TLS options
    ca: [fs.readFileSync("ca.pem")],
    cert: fs.readFileSync("client-cert.pem"),
    key: fs.readFileSync("client-key.pem"),
    passphrase: "client-key-passphrase",
    servername: "secure.broker.com",
    rejectUnauthorized: true,
  },
};
```

## Environment-Specific Configurations

### Development Environment

```typescript
const devConfig: AMQPConfig = {
  url: "amqp://localhost:5672",
  requestQueue: "dev_mcp_requests",
  responseQueue: "dev_mcp_responses",
  requestTimeout: 10000,

  queueOptions: {
    durable: false, // Temporary queues for dev
    exclusive: false,
    autoDelete: true, // Clean up automatically
  },

  consumerOptions: {
    noAck: true, // Faster for development
    prefetch: 1,
  },
};
```

### Testing Environment

```typescript
const testConfig: AMQPConfig = {
  url: process.env.TEST_AMQP_URL || "amqp://localhost:5672",
  requestQueue: `test_mcp_requests_${process.env.TEST_SUITE_ID}`,
  responseQueue: `test_mcp_responses_${process.env.TEST_SUITE_ID}`,
  requestTimeout: 5000,

  queueOptions: {
    durable: false,
    exclusive: true, // Isolated test queues
    autoDelete: true,
  },
};
```

### Staging Environment

```typescript
const stagingConfig: AMQPConfig = {
  url: process.env.STAGING_AMQP_URL,
  requestQueue: "staging_mcp_requests",
  responseQueue: "staging_mcp_responses",
  requestTimeout: 30000,
  enableBidirectional: true,

  queueOptions: {
    durable: true,
    exclusive: false,
    autoDelete: false,
    arguments: {
      "x-message-ttl": 600000, // 10 minutes
      "x-max-length": 25000,
    },
  },

  consumerOptions: {
    noAck: false,
    prefetch: 5,
  },
};
```

## Configuration Validation

### Automatic Validation

The transport automatically validates configuration:

```typescript
import { AMQPClientTransport, validateAmqpConfig } from "amqp-mcp-transport";

const config = {
  url: "amqp://localhost:5672",
  requestQueue: "requests",
  // Missing responseQueue
};

// Manual validation
const errors = validateAmqpConfig(config);
if (errors.length > 0) {
  console.error("Configuration errors:", errors);
  process.exit(1);
}

// Automatic validation during construction
try {
  const client = new AMQPClientTransport(config);
} catch (error) {
  console.error("Invalid configuration:", error.message);
}
```

### Custom Validation

```typescript
function validateProductionConfig(config: AMQPConfig): string[] {
  const errors: string[] = [];

  // Ensure SSL in production
  if (!config.url.startsWith("amqps://")) {
    errors.push("Production environment requires SSL/TLS connection");
  }

  // Ensure durability
  if (!config.queueOptions?.durable) {
    errors.push("Production queues must be durable");
  }

  // Ensure reasonable timeout
  if ((config.requestTimeout || 30000) < 10000) {
    errors.push("Production timeout should be at least 10 seconds");
  }

  return errors;
}
```

## Dynamic Configuration

### Runtime Configuration Updates

```typescript
class ConfigurableAMQPTransport extends AMQPClientTransport {
  async updateConfig(newConfig: Partial<AMQPConfig>) {
    // Validate new configuration
    const errors = validateAmqpConfig({ ...this.config, ...newConfig });
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join(", ")}`);
    }

    // Close existing connection
    await this.close();

    // Update configuration
    this.config = { ...this.config, ...newConfig };

    // Reconnect with new configuration
    await this.connect();
  }
}
```

### Configuration from External Sources

```typescript
import { readFileSync } from "fs";
import { load } from "js-yaml";

// Load from YAML file
function loadConfigFromFile(path: string): AMQPConfig {
  const yamlContent = readFileSync(path, "utf8");
  return load(yamlContent) as AMQPConfig;
}

// Load from environment with defaults
function loadConfigFromEnv(): AMQPConfig {
  return {
    url: process.env.AMQP_URL || "amqp://localhost:5672",
    requestQueue: process.env.AMQP_REQUEST_QUEUE || "mcp_requests",
    responseQueue: process.env.AMQP_RESPONSE_QUEUE || "mcp_responses",
    requestTimeout: parseInt(process.env.AMQP_TIMEOUT || "30000"),
    enableBidirectional: process.env.AMQP_BIDIRECTIONAL === "true",

    connectionOptions: {
      heartbeat: parseInt(process.env.AMQP_HEARTBEAT || "60"),
      connectionTimeout: parseInt(
        process.env.AMQP_CONNECTION_TIMEOUT || "10000"
      ),
    },

    queueOptions: {
      durable: process.env.AMQP_DURABLE !== "false",
      exclusive: process.env.AMQP_EXCLUSIVE === "true",
      autoDelete: process.env.AMQP_AUTO_DELETE === "true",
    },
  };
}
```

## Configuration Examples

### Microservices Architecture

```typescript
// Service A Configuration
const serviceAConfig: AMQPConfig = {
  url: "amqp://messagebus.internal:5672",
  requestQueue: "service_a_requests",
  responseQueue: "service_a_responses",
  enableBidirectional: true,

  queueOptions: {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "service-dlx",
      "x-dead-letter-routing-key": "service-a-failed",
    },
  },
};

// Service B Configuration
const serviceBConfig: AMQPConfig = {
  url: "amqp://messagebus.internal:5672",
  requestQueue: "service_b_requests",
  responseQueue: "service_b_responses",
  enableBidirectional: true,

  queueOptions: {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "service-dlx",
      "x-dead-letter-routing-key": "service-b-failed",
    },
  },
};
```

### Multi-Tenant Configuration

```typescript
function createTenantConfig(tenantId: string): AMQPConfig {
  return {
    url: process.env.AMQP_URL!,
    requestQueue: `tenant_${tenantId}_requests`,
    responseQueue: `tenant_${tenantId}_responses`,
    requestTimeout: 30000,

    queueOptions: {
      durable: true,
      exclusive: false,
      autoDelete: false,
      arguments: {
        "x-message-ttl": 1800000,
        "x-max-length": 10000,
      },
    },
  };
}
```

## Best Practices

1. **Use Environment Variables**: Store sensitive configuration in environment variables
2. **Validate Configuration**: Always validate configuration before using
3. **Use SSL/TLS in Production**: Never use plain connections in production
4. **Configure Dead Letter Exchanges**: Set up DLX for failed message handling
5. **Set Appropriate Timeouts**: Balance responsiveness with reliability
6. **Use Durable Queues**: Ensure message persistence in production
7. **Configure Prefetch**: Optimize throughput with appropriate prefetch values
8. **Monitor Configuration**: Log configuration changes and validate them
