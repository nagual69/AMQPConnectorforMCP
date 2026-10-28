# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `amqp-mcp-transport/binding`: binding-core, the first piece of 2.0.0. It is the wire rules of [docs/BINDING.md](./docs/BINDING.md) as pure functions, with no amqplib, no SDK and no I/O. It covers routing keys and topology (§4), inbound classification against the §7.4 fate table, mirror checks (§8), deadlines (§7.1), cancellation affinity with the bounded pre-arrival record (§6.4), the outbound property builders and dead-letter copy (§5.2, §7.4), `authInfo` derivation (§9.2) and the redelivery policy (§7.2). Pins P2, P3, P7, P8 and the unit half of P11 are named tests, and each is mutation-verified. The 1.x exports and behaviour are unchanged.

### Documentation
- [docs/spikes/phase2-2026-10-28](./docs/spikes/phase2-2026-10-28/README.md): the engine-B spike for 2.0.0, against SDK 2.4.0 and RabbitMQ 4.4.0, with its scripts.
  - Engine B passed every gate:
    - R1: an 81-tool per-request factory plus `fetch` costs 0.46 ms at p50 and 6.0 ms at p99;
    - R2: `Mcp-Param-*` synthesis works;
    - R3: the SSE relay keeps order and terminality.
  - O-2 is resolved: RabbitMQ 4.4.0 silently drops a publish to a stale direct reply-to address. BINDING §7.3 and §14 now record this, and D-2 and D-3 in the plan carry the results.
- BINDING.md corrections found while building binding-core:
  - §7.4: the dead-letter copy carries the server's `user_id`, moves the client's to `x-mcp-original-user-id` and drops `expiration`. RabbitMQ would reject a copy that kept the client's `user_id`.
  - §7.1: the deadline is an upper bound, because RabbitMQ does not decrement `expiration` in the queue. A request without a usable `expiration` gets a default deadline.
  - §6.4 item 3: a fallback-keyed cancellation that names more than one exchange cancels none, and is never remembered.
  - §9.2: the vhost in `iss` is percent-encoded.
  - §5.2: a notification lacking `message_id` is still acted on.
- [docs/BINDING.md](./docs/BINDING.md): the draft binding specification for MCP 2026-07-28 over AMQP. It covers the 0-9.1 topology, the message mapping, mirror checking with its mismatch rule, the cancellation-affinity mechanism, delivery and dead-letter policy, the principal model, dual-era serving, and the mapping to OASIS AMQP 1.0 CSD01. Decision D-1 was ratified on 2026-10-28, so it is the design 2.0.0 is built against. It becomes normative when 2.0.0 implements it; 1.x behaviour is unchanged.

## [1.2.0] - 2026-10-22

Consolidates the AMQP transport that Open Discovery 3.0 runs in production into this package, which is now its canonical home. The normative wire behaviour is [docs/TRANSPORT_CONTRACT.md](./docs/TRANSPORT_CONTRACT.md).

### Security
- **Cross-client response leak fix** (first shipped in 1.1.1, below). The server keyed response routing by the client-chosen JSON-RPC id, so two concurrent clients that both sent `id: 1` could receive each other's responses. Request ids are now rewritten to a unique internal id before the SDK sees them, and the client's id is restored on the way out (ported from Open Discovery `7ba522f`).
- Clients no longer receive other clients' notifications. They bind only the server-notification namespace.

### Changed (wire)
- Notifications are split into `mcp.client-notification.*` (consumed by the server) and `mcp.server-notification.*` (consumed by clients), replacing the shared `mcp.notification.*`. Servers no longer consume their own notifications. **A 1.0/1.1 client and a 1.2 server still exchange requests and responses, but not notifications: upgrade both together.** Open Discovery 3.0 already uses the 1.2 wire format.
- The server transport rejects outbound requests. Previously they looped back into its own queue. The client transport rejects outbound responses. Previously they were published to an unbound routing key and dropped.

### Changed (API)
- `routingKeyStrategy` is now `(message, routingType) => string`, with `routingType` one of `request`, `client-notification` or `server-notification`. It was `(method, messageType)`.
- Default server `messageTTL` / `queueTTL` are now 1 h / 2 h, matching Open Discovery. The server no longer sets a default `prefetchCount`.
- `@modelcontextprotocol/sdk` moved to `peerDependencies` (`>=1.17.1 <2`).

### Added
- `AmqpServerRuntime` (alias `NativeAmqpRuntimeAdapter`). It owns the transport/server pair and recovers after the transport closes for good, attaching a fresh server from a factory each time with exponential backoff. It reports recovery state via `getStatus()`.
- A broker consumer cancel (`basic.cancel`) is treated as a connection failure on both transports, instead of leaving them silently "connected".
- Reconnect tears down the old connection first, at most one reconnect is scheduled at a time, and `onclose` fires exactly once.
- `ontransportclosed`, `getStatus()` and a `logger` option on the server transport. `AmqpServerTransport` / `AmqpClientTransport` are exported as aliases.
- Contract tests (`contract.test.ts`), ported from Open Discovery, and an end-to-end test through the real MCP SDK with two concurrent clients reusing request ids (`sdk-e2e.test.ts`).
- `docs/TRANSPORT_CONTRACT.md` and `docs/REARCHITECTURE_PLAN_2026-07-28.md`.

### Fixed (packaging)
- The build now emits `dist/index.js`, which `main` pointed at but which previously did not exist. The package also has an `exports` map, and a `prepare` script so `npm install github:nagual69/AMQPConnectorforMCP#<ref>` builds on install.
- Examples build separately to `dist-examples/` (`npm run build:examples`).
- `npm run lint` works again: the ESLint config extended a non-existent config name.
- Removed the "fully compliant with 2025-11-25" and "bidirectional" claims. Servers cannot initiate requests over this transport.

## [1.1.1] - 2026-10-22

### Security
- **Fixed a cross-client response leak in `AMQPServerTransport`.** Response routing was keyed by the client-chosen JSON-RPC `id`. Every client numbers its requests from the same start, so when two clients had a request with the same id in flight, the second overwrote the first's `{replyTo, correlationId}` and a response could reach the wrong client. Request ids are now rewritten to a server-minted internal id before the SDK sees them, and the client's own id is restored on the response. The wire format is unchanged. Ported from Open Discovery 3.0 (`7ba522f`).
- Added a two-clients-same-id regression test, and an end-to-end test through the real MCP SDK with two concurrent clients (`sdk-e2e.test.ts`).

### Fixed (build/CI)
- `npm run build` now emits `dist/index.js` and `dist/index.d.ts`, which `main` and `types` point at. Before this, the build wrote them under `dist/src/`. Examples build separately to `dist-examples/` with `npm run build:examples`.
- `npm run lint` runs again. The ESLint config extended a config name that does not exist.

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
