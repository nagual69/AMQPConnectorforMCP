/**
 * AMQP Transport Types for Model Context Protocol
 * 
 * This module provides type definitions for AMQP-based MCP transports,
 * compatible with the official MCP SDK transport interface.
 */

// Import MCP SDK types to ensure compatibility
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from "@modelcontextprotocol/sdk/types.js";

// Re-export for convenience
export type {
    JSONRPCMessage,
    MessageExtraInfo,
    RequestId
};
export type { Transport, TransportSendOptions };

/**
 * Base configuration options for AMQP transport
 */
export interface AMQPTransportOptions {
    /** AMQP broker connection URL (e.g., "amqp://localhost:5672") */
    amqpUrl: string;

    /** Exchange name for pub/sub messaging */
    exchangeName: string;

    /** Delay between reconnection attempts in milliseconds */
    reconnectDelay?: number;

    /** Maximum number of reconnection attempts */
    maxReconnectAttempts?: number;

    /** Prefetch count for message consumption */
    prefetchCount?: number;

    /** Message time-to-live in milliseconds */
    messageTTL?: number;

    /** Queue time-to-live in milliseconds */
    queueTTL?: number;
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
    responseTimeout?: number;
}

/**
 * Internal message envelope for AMQP transport
 */
export interface AMQPMessage {
    /** JSON-RPC message payload */
    message: JSONRPCMessage;

    /** Message timestamp */
    timestamp: number;

    /** Message type for routing */
    type: 'request' | 'response' | 'notification';

    /** Optional correlation ID for request/response pairing */
    correlationId?: string;

    /** Optional reply-to queue name */
    replyTo?: string;
}

/**
 * Connection state for AMQP transport
 */
export interface ConnectionState {
    connected: boolean;
    reconnectAttempts: number;
    lastError?: Error;
}
