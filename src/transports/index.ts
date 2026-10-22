/**
 * AMQP Transport for Model Context Protocol (MCP)
 *
 * Provides AMQP-based transport implementations for MCP, enabling
 * distributed MCP architectures over message queues.
 *
 * This library is transport-only and contains no application-specific logic.
 * Routing keys are configurable via the `routingKeyStrategy` option.
 */

export { AMQPClientTransport, AmqpClientTransport } from "./amqp-client-transport.js";
export { AMQPServerTransport, AmqpServerTransport } from "./amqp-server-transport.js";
export { AmqpServerRuntime, NativeAmqpRuntimeAdapter } from "./amqp-server-runtime.js";

export * from "./amqp-utils.js";

export type { AMQPConnection } from "./amqp-server-transport.js";
export type { AmqpServerRuntimeOptions, RuntimeManagedTransport } from "./amqp-server-runtime.js";
export type {
    AMQPClientTransportOptions,
    AMQPServerTransportOptions,
    AMQPTransportOptions,
    AmqpRecoveryState,
    AmqpRecoveryStatus,
    AmqpRuntimeConfig,
    AmqpRuntimeStartResult,
    AmqpServerFactory,
    AmqpTransportStatus,
    ConnectableServer,
    ConnectionState,
    RoutingKeyStrategy,
    RoutingMessageType,
    TransportLogger,
    JSONRPCMessage,
    JSONRPCNotification,
    Transport,
    MessageExtraInfo,
    RequestId,
    TransportSendOptions
} from "./types.js";
