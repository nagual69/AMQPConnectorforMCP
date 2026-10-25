# AMQP MCP Transport Documentation

## Table of Contents

- [Getting Started](./getting-started.md)
- [API Reference](./api-reference.md)
- [Configuration](./configuration.md)
- [Examples](./examples.md)
- [Troubleshooting](./troubleshooting.md)
- [Transport contract](./TRANSPORT_CONTRACT.md) (normative wire behaviour, 1.x)
- [Binding specification](./BINDING.md) (draft; normative for 2.x once ratified: MCP 2026-07-28 over AMQP 0-9.1, mapped to OASIS AMQP 1.0)
- [Re-architecture plan for MCP 2026-07-28](./REARCHITECTURE_PLAN_2026-07-28.md) (proposed)
- Migration: see `src/transports/deprecated/MIGRATION_SUMMARY.md` for legacy JS to TS notes

## Overview

The AMQP MCP Transport provides enterprise-grade AMQP-based transport implementations for the Model Context Protocol (MCP), enabling distributed MCP architectures over message queues.

**Scope:** the 2025-era MCP protocol (SDK v1). All messages are raw JSON-RPC 2.0 on the wire, with transport metadata in AMQP message properties. The normative wire behaviour is [TRANSPORT_CONTRACT.md](./TRANSPORT_CONTRACT.md); the move to the stateless MCP 2026-07-28 protocol is planned in [REARCHITECTURE_PLAN_2026-07-28.md](./REARCHITECTURE_PLAN_2026-07-28.md).

## Key Features

- **Enterprise-Grade Reliability**: Advanced error recovery, connection resilience, and message persistence
- **Separated notification namespaces**: client and server notifications never loop back to their sender
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

## License

Apache License 2.0 — see the repository root `LICENSE` file for full text.

Why Apache 2.0 here?

- Includes an explicit patent license grant and defensive termination
- Common for infrastructure libraries used in enterprises
- Encourages adoption while protecting contributors and users
- Compatible with many open-source and commercial distributions
