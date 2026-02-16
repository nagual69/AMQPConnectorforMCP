/**
 * AMQP Transport for Model Context Protocol (MCP)
 *
 * Provides AMQP-based transport implementations for MCP, enabling
 * distributed MCP architectures over message queues.
 *
 * This library is transport-only and contains no application-specific logic.
 * Routing keys are configurable via the `routingKeyStrategy` option.
 */

export { AMQPClientTransport } from "./amqp-client-transport.js";
export { AMQPServerTransport } from "./amqp-server-transport.js";

export * from "./amqp-utils.js";

export type {
    AMQPClientTransportOptions,
    AMQPServerTransportOptions,
    ConnectionState,
    RoutingKeyStrategy,
    JSONRPCMessage,
    Transport,
    MessageExtraInfo,
    RequestId,
    TransportSendOptions
} from "./types.js";
