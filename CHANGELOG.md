# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-16

### Fixed - MCP Specification Compliance

**All 28 audit findings have been successfully remediated** — The transport is now fully compliant with MCP specification 2025-11-25 and ready for production use.

#### Critical Fixes (Specification Compliance)

- **Wire Format Compliance (C1)**: Removed custom envelope wrapping. All messages now sent as raw JSON-RPC 2.0 with transport metadata in AMQP properties
- **SDK Contract Compliance (C2)**: Implemented proper handling of `TransportSendOptions.relatedRequestId` for response correlation
- **JSON-RPC Validation (C3)**: Invalid messages are now rejected instead of auto-fixed. Strict validation of `jsonrpc: "2.0"` field
- **Lifecycle Safety (C4)**: Added `closing` flag to prevent reconnection attempts after intentional `close()`
- **onclose Callback (C5)**: `onclose` now fires when max reconnection attempts are exhausted
- **SDK Callback Contract (C6)**: Removed custom getter/setter wrapper for `onmessage` - SDK now owns the callback directly

#### Critical Fixes (Reusability & Separation of Concerns)

- **Removed Application-Specific Logic (C7)**: Eliminated hardcoded tool categories (nmap, snmp, proxmox, etc.)
  - Default routing key format: `mcp.{messageType}.{method}` (e.g., `mcp.request.tools.list`)
  - Added optional `routingKeyStrategy` callback for custom routing implementations
  - Transport is now truly general-purpose and reusable across any MCP project

#### Major Fixes (Protocol & Lifecycle)

- **Single Message Format (M1)**: Removed dual-format detection. Only raw JSON-RPC accepted
- **Consolidated Consumption (M2)**: Single consumer per transport, eliminated duplicate message handling
- **Async Patterns (M3)**: Removed `await Promise.resolve()` anti-patterns
- **Response Routing (M4)**: Use `relatedRequestId` from SDK options for routing lookup
- **Memory Management (M5)**: Implemented TTL-based cleanup for routing info and pending requests
  - Automatic cleanup every 60 seconds prevents memory leaks in long-running sessions
- **Secure Session IDs (M6)**: Use `crypto.randomUUID()` for cryptographically secure session IDs
- **Content Type Headers (M7)**: All AMQP messages now include `contentType: 'application/json'`
- **Consistent Notification Routing (M8)**: Standardized notification routing key format
- **Shared Type Guards (M9)**: Consolidated JSON-RPC type detection in utilities

#### Moderate Fixes (Security & Robustness)

- **Message Size Validation (S1)**: Added configurable `maxMessageSize` (default 1 MB) to prevent memory exhaustion
- **JSON-RPC Schema Validation (S2)**: Strict validation of JSON-RPC 2.0 structure before processing
- **Configuration Factory (S3)**: Converted `DEFAULT_AMQP_CONFIG` to factory function to avoid stale environment reads
- **URL Scheme Validation (S4)**: Only `amqp://` and `amqps://` schemes accepted
- **Secure Defaults (S5)**: Updated examples to use `guest:guest` instead of hardcoded credentials

#### Minor Fixes (Code Quality & Maintenance)

- **Code Deduplication (T1-T3)**: Eliminated duplicate functions across transport files
  - `detectMessageType()`, `generateCorrelationId()`, and utilities consolidated in `amqp-utils.ts`
- **Modern JavaScript (T4)**: Replaced deprecated `String.prototype.substr()` with `.slice()`
- **Consistent Logging (T5)**: Removed emojis from log output for compatibility
- **Separation of Concerns (T6)**: Removed application-level `parseTransportMode()` logic
- **Test Coverage (T7)**: Added comprehensive integration tests for lifecycle and message flow
- **SDK Version (T8)**: Verified compatibility with current MCP SDK version

### Added

- `routingKeyStrategy` configuration option for custom routing key derivation
- `maxMessageSize` configuration option for message size validation
- TTL-based cleanup mechanism for routing information storage
- Comprehensive JSON-RPC 2.0 schema validation
- AMQP URL scheme validation (amqp:// and amqps:// only)
- Integration tests for bidirectional communication patterns

### Changed

- **Breaking**: Default routing key format changed from `mcp.request.{category}.{method}` to `mcp.{messageType}.{method}`
  - To maintain old behavior, provide a custom `routingKeyStrategy` function
- Session IDs now use `crypto.randomUUID()` instead of timestamp-based generation
- All AMQP messages include `contentType: 'application/json'` in properties
- `parseMessage()` utility now throws errors directly instead of returning success/error objects
- Routing info storage includes `timestamp` field for TTL-based cleanup

### Removed

- Custom `AMQPMessage` envelope type (messages sent as raw JSON-RPC 2.0)
- Hardcoded tool category mappings (nmap, snmp, proxmox, zabbix, etc.)
- Dual message format support (envelope vs direct)
- Application-specific `parseTransportMode()` utility
- Custom getter/setter wrapper for `onmessage` callback
- `getToolCategory()` utility function (replaced by configurable routing strategy)

### Documentation

- Added MCP specification 2025-11-25 compliance notes across all documentation
- Updated routing key examples to reflect new default format
- Added security best practices section in configuration guide
- Updated all code examples to use secure defaults (guest:guest credentials)
- Added wire format compliance notes throughout documentation
- Added examples of custom routing strategies for legacy compatibility

## [1.0.0] - 2025-09-15

First public release (curated history) — highlights:

- OD‑aligned AMQP MCP transport (client/server, routing, recovery, session management)
- Documentation overhaul (routing patterns, env mapping, Docker, examples, images)
- License switched to Apache‑2.0 and NOTICE added
- Cleanup of deprecated/bridge code and refined .gitignore
- Examples updated to new transport patterns

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
