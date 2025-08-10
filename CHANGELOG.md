# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-08-09

### Added

- Initial release of AMQP MCP Transport
- Enterprise-grade AMQP client transport (`AMQPClientTransport`)
- Enterprise-grade AMQP server transport (`AMQPServerTransport`)
- Comprehensive utility functions extracted from JavaScript implementations
- Full TypeScript support with strict type checking
- MCP SDK v1.0.0 compatibility
- Bidirectional pub/sub channels for distributed messaging
- Sophisticated correlation handling for async message routing
- Advanced error recovery and resilience patterns
- Session-based routing with load balancing support
- Performance monitoring and timeout management
- Tool category-based intelligent routing
- Comprehensive examples for client and server usage
- Docker Compose setup for local development
- Jest testing framework configuration
- ESLint configuration for code quality
- Comprehensive documentation and migration summary

### Features

- **Transport Interface Compliance**: Full implementation of MCP Transport interface
- **Protocol Agnostic**: Clean AMQP implementation (removed RabbitMQ branding)
- **Enterprise Patterns**: Advanced correlation, routing, and error recovery
- **Type Safety**: Complete TypeScript types with compile-time validation
- **Utility Functions**: Extracted enterprise-grade utilities from working implementations
- **Configuration Validation**: Comprehensive AMQP configuration validation
- **Health Checking**: Connection health monitoring and status reporting
- **Message Parsing**: Robust JSON message parsing with error handling
- **Structured Logging**: Enterprise-grade logging utilities for debugging

### Development

- TypeScript 5.4+ support
- Node.js 18+ compatibility
- ESLint configuration for code quality
- Jest testing framework setup
- Docker development environment
- Comprehensive build and development scripts

### Documentation

- Complete README with usage examples
- Migration summary documenting JavaScript to TypeScript transition
- Contributing guidelines
- Comprehensive inline documentation
- Example implementations

### Migration

- Successfully migrated from JavaScript implementations to TypeScript
- Extracted all essential functionality from legacy implementations
- Preserved enterprise patterns discovered through code analysis
- Clean separation of transport vs. application concerns
- Deprecated legacy files with preservation for reference

## [Unreleased]

### Planned

- Additional transport configuration options
- Enhanced monitoring and metrics collection
- Connection pooling support
- Advanced routing strategies
- Performance optimizations
