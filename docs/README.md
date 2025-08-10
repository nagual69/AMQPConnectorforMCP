# AMQP MCP Transport Documentation

## Table of Contents

- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [Configuration](./configuration.md)
- [Examples](./examples.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](../src/transports/MIGRATION_SUMMARY.md)

## Overview

The AMQP MCP Transport provides enterprise-grade AMQP-based transport implementations for the Model Context Protocol (MCP), enabling distributed MCP architectures over message queues.

## Key Features

- **Enterprise-Grade Reliability**: Advanced error recovery, connection resilience, and message persistence
- **Bidirectional Communication**: Full pub/sub support for distributed messaging patterns
- **Performance Monitoring**: Request tracking, correlation handling, and response time measurement
- **Intelligent Routing**: Tool category-based routing and session management
- **Type Safety**: Full TypeScript support with strict type checking
- **MCP SDK Compatibility**: Complete implementation of the official MCP Transport interface

## Quick Links

- [Installation & Setup](./getting-started.md#installation)
- [Basic Usage](./getting-started.md#basic-usage)
- [Client Transport](./api-reference.md#amqpclienttransport)
- [Server Transport](./api-reference.md#amqpservertransport)
- [Utility Functions](./api-reference.md#utilities)
- [Configuration Options](./configuration.md)
- [Example Implementations](./examples.md)

## Architecture

```
┌─────────────────┐    AMQP     ┌─────────────────┐
│   MCP Client    │◄──────────►│   MCP Server    │
│                 │             │                 │
│ AMQPClientTransport         AMQPServerTransport │
└─────────────────┘             └─────────────────┘
         │                               │
         └───────────┐       ┌───────────┘
                     ▼       ▼
              ┌─────────────────┐
              │  AMQP Broker    │
              │  (RabbitMQ,     │
              │   ActiveMQ,     │
              │   Apache Qpid)  │
              └─────────────────┘
```

## Support

- [GitHub Issues](https://github.com/your-org/AMQPConnectorforMCP/issues)
- [Contributing Guidelines](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)
