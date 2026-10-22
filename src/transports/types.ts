/**
 * AMQP Transport Types for Model Context Protocol
 *
 * This module provides type definitions for AMQP-based MCP transports,
 * compatible with the official MCP SDK transport interface.
 */

// Import MCP SDK types to ensure compatibility
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, JSONRPCNotification, MessageExtraInfo, RequestId } from "@modelcontextprotocol/sdk/types.js";

// Re-export for convenience
export type {
    JSONRPCMessage,
    JSONRPCNotification,
    MessageExtraInfo,
    RequestId
};
export type { Transport, TransportSendOptions };

/**
 * The three routing namespaces on the `${exchangeName}.mcp.routing` topic
 * exchange.  The server consumes `request` and `client-notification`; clients
 * consume `server-notification`.  Keeping server- and client-originated
 * notifications in separate namespaces is what stops either side from
 * consuming its own outbound notifications.
 */
export type RoutingMessageType = 'request' | 'client-notification' | 'server-notification';

/**
 * Callback to derive an AMQP routing key for an outbound request or
 * notification.  The default strategy uses `mcp.{routingType}.{method}`
 * (with `/` replaced by `.`).  Projects that need category-based routing
 * (e.g. `mcp.request.nmap.nmap_scan`) can supply their own function.  A
 * custom strategy MUST keep requests and client notifications inside the
 * patterns the server binds (`mcp.request.#`, `mcp.client-notification.#`),
 * and server notifications inside `mcp.server-notification.#`.
 */
export type RoutingKeyStrategy = (message: JSONRPCMessage, routingType: RoutingMessageType) => string;

/**
 * Minimal structured logger.  Defaults to writing warnings and errors to
 * stderr; pass your own to route transport diagnostics into an application
 * logger.
 */
export interface TransportLogger {
    debug(message: string, context?: unknown): void;
    info(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
    error(message: string, context?: unknown): void;
}

/**
 * Base configuration options for AMQP transport
 */
export interface AMQPTransportOptions {
    /** AMQP broker connection URL (e.g., "amqp://localhost:5672") */
    amqpUrl: string;

    /** Exchange name prefix; the routing exchange is `${exchangeName}.mcp.routing` */
    exchangeName: string;

    /** Delay between reconnection attempts in milliseconds */
    reconnectDelay?: number | undefined;

    /** Maximum number of reconnection attempts */
    maxReconnectAttempts?: number | undefined;

    /** Prefetch count for message consumption */
    prefetchCount?: number | undefined;

    /** Message time-to-live in milliseconds */
    messageTTL?: number | undefined;

    /** Queue time-to-live in milliseconds */
    queueTTL?: number | undefined;

    /**
     * Optional callback to derive AMQP routing keys.
     * Defaults to `mcp.{routingType}.{method}` (with `/` → `.`).
     */
    routingKeyStrategy?: RoutingKeyStrategy | undefined;

    /** Maximum incoming message size in bytes (default 1 048 576 = 1 MiB) */
    maxMessageSize?: number | undefined;

    /** Structured logger for transport diagnostics */
    logger?: TransportLogger | undefined;
}

/**
 * Configuration options for AMQP server transport
 */
export interface AMQPServerTransportOptions extends AMQPTransportOptions {
    /** Prefix for server queues */
    queuePrefix: string;
}

/**
 * Configuration options for AMQP client transport
 */
export interface AMQPClientTransportOptions extends AMQPTransportOptions {
    /** Prefix for target server queues */
    serverQueuePrefix: string;

    /** Timeout for responses in milliseconds */
    responseTimeout?: number | undefined;
}

/**
 * Connection state for AMQP transport
 */
export interface ConnectionState {
    connected: boolean;
    reconnectAttempts: number;
    lastError?: Error | undefined;
}

/** State of the server runtime's background recovery loop. */
export type AmqpRecoveryState = 'disabled' | 'idle' | 'waiting' | 'attempting' | 'stopped';

export interface AmqpRecoveryStatus {
    enabled: boolean;
    state: AmqpRecoveryState;
    retryCount: number;
    maxRetries?: number | undefined;
    retryIntervalMs?: number | undefined;
    maxRetryIntervalMs?: number | undefined;
    backoffMultiplier?: number | undefined;
    nextRetryAt?: string | undefined;
    lastAttemptAt?: string | undefined;
    lastError?: string | undefined;
}

/** Health snapshot of an AMQP server transport or runtime. */
export interface AmqpTransportStatus {
    enabled: boolean;
    connected: boolean;
    exchange?: string | undefined;
    queuePrefix?: string | undefined;
    error?: string | undefined;
    recovery?: AmqpRecoveryStatus | undefined;
}

/**
 * Anything that can be bound to a transport.  `McpServer` and the low-level
 * `Server` from the MCP SDK both satisfy this.
 */
export interface ConnectableServer {
    connect(transport: Transport): Promise<void>;
}

/**
 * Supplies a server per transport attach.
 *
 * The MCP SDK refuses to bind one server to a second transport, so the
 * runtime asks for a fresh instance on every (re)attach.  `release` lets the
 * owner stop tracking an instance once its transport has gone.
 */
export interface AmqpServerFactory<TServer extends ConnectableServer = ConnectableServer> {
    create(): Promise<TServer>;
    release?(server: TServer): void;
}

/**
 * Configuration for {@link AmqpServerRuntime}.  Field names match Open
 * Discovery's `AmqpTransportConfig` so its config objects pass through
 * unchanged.
 */
export interface AmqpRuntimeConfig {
    enabled: boolean;
    mode?: 'amqp' | undefined;
    url: string;
    exchange: string;
    queuePrefix: string;
    prefetch?: number | undefined;
    reconnectDelay?: number | undefined;
    maxReconnectAttempts?: number | undefined;
    messageTTL?: number | undefined;
    queueTTL?: number | undefined;
    maxMessageSize?: number | undefined;
    routingKeyStrategy?: RoutingKeyStrategy | undefined;
    autoRecoveryEnabled?: boolean | undefined;
    recoveryRetryInterval?: number | undefined;
    recoveryMaxRetries?: number | undefined;
    recoveryBackoffMultiplier?: number | undefined;
    recoveryMaxRetryInterval?: number | undefined;
}

/** Result of {@link AmqpServerRuntime.start}. */
export interface AmqpRuntimeStartResult {
    mode: 'amqp';
    started: boolean;
    details?: string | undefined;
    error?: string | undefined;
}
