/**
 * Enhanced AMQP Transport for Model Context Protocol (MCP)
 * 
 * This package provides enterprise-grade AMQP-based transport implementations for MCP,
 * enabling distributed MCP architectures over message queues with sophisticated
 * patterns discovered from working JavaScript implementations:
 * 
 * - Bidirectional pub/sub channels for distributed messaging
 * - Advanced correlation handling and timeout management
 * - Performance monitoring and request tracking
 * - Tool category-based intelligent routing
 * - Enterprise-grade error recovery and resilience
 * 
 * This implementation follows MCP transport specification requirements
 * and is compatible with the official MCP TypeScript SDK.
 */

// Enhanced versions with enterprise patterns from JS analysis
export { AMQPClientTransport } from "./amqp-client-transport.js";
export { AMQPServerTransport } from "./amqp-server-transport.js";

// Utility functions extracted from JavaScript implementations
export * from "./amqp-utils.js";

export type {
    AMQPClientTransportOptions,
    AMQPServerTransportOptions,
    AMQPMessage,
    ConnectionState,
    JSONRPCMessage,
    Transport,
    MessageExtraInfo,
    RequestId,
    TransportSendOptions
} from "./types";
