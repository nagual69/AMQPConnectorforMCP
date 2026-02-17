/**
 * AMQP Transport Utilities for Model Context Protocol
 *
 * Shared helpers used by both the client and server AMQP transports.
 * This module is intentionally free of application-specific logic so that
 * the transport library can be adopted by any MCP project.
 */

import type { JSONRPCMessage } from "./types.js";
import type { RoutingKeyStrategy } from "./types.js";

// ─── JSON-RPC type guards ───────────────────────────────────────────────────

/**
 * Returns true when the message is a JSON-RPC 2.0 request (has `id` + `method`).
 */
export function isJSONRPCRequest(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number; method: string } {
    return 'method' in msg && 'id' in msg && msg.id !== undefined && msg.id !== null;
}

/**
 * Returns true when the message is a JSON-RPC 2.0 notification (`method` but no `id`).
 */
export function isJSONRPCNotification(msg: JSONRPCMessage): msg is JSONRPCMessage & { method: string } {
    return 'method' in msg && (!('id' in msg) || msg.id === undefined || msg.id === null);
}

// ─── Message type detection ─────────────────────────────────────────────────

/**
 * Classify a JSON-RPC message as request, response, or notification.
 * Throws if the message cannot be classified.
 */
export function detectMessageType(message: JSONRPCMessage): 'request' | 'response' | 'notification' {
    const hasId = 'id' in message && message.id !== undefined && message.id !== null;

    if (hasId && ('result' in message || 'error' in message)) {
        return 'response';
    }
    if (hasId && 'method' in message) {
        return 'request';
    }
    if ('method' in message && !hasId) {
        return 'notification';
    }

    throw new Error(`Cannot determine message type: ${JSON.stringify(message)}`);
}

// ─── Message validation ─────────────────────────────────────────────────────

/**
 * Validates that a parsed object conforms to the minimal JSON-RPC 2.0 shape.
 * Returns the typed message on success, or throws on failure.
 */
export function validateJSONRPC(obj: unknown): JSONRPCMessage {
    if (typeof obj !== 'object' || obj === null) {
        throw new Error('Message is not an object');
    }
    const rec = obj as Record<string, unknown>;
    if (rec.jsonrpc !== '2.0') {
        throw new Error(`Invalid or missing jsonrpc field: expected "2.0", got ${JSON.stringify(rec.jsonrpc)}`);
    }
    // A valid JSON-RPC message must have either `method` (request/notification) or `id` + (`result`|`error`) (response)
    const hasMethod = typeof rec.method === 'string';
    const hasResult = 'result' in rec;
    const hasError = 'error' in rec;
    if (!hasMethod && !hasResult && !hasError) {
        throw new Error('Message must contain "method" (request/notification) or "result"/"error" (response)');
    }
    return obj as JSONRPCMessage;
}

// ─── Message parsing ────────────────────────────────────────────────────────

export interface ParseResult {
    success: boolean;
    message: JSONRPCMessage | null;
    error: Error | null;
}

/**
 * Safely parse a raw buffer/string into a validated JSON-RPC message.
 */
export function parseMessage(content: Buffer | string): ParseResult {
    try {
        const raw = content.toString();
        const parsed: unknown = JSON.parse(raw);
        const message = validateJSONRPC(parsed);
        return { success: true, message, error: null };
    } catch (err) {
        return { success: false, message: null, error: err as Error };
    }
}

// ─── Routing keys ───────────────────────────────────────────────────────────

/**
 * Default routing key strategy: `mcp.{messageType}.{method}` with `/` → `.`
 */
export function defaultRoutingKeyStrategy(method: string, messageType: 'request' | 'notification'): string {
    const normalised = method.replace(/\//g, '.');
    return `mcp.${messageType}.${normalised}`;
}

/**
 * Derive the AMQP routing key for a message, using the configured strategy
 * or falling back to the default.
 */
export function getRoutingKey(
    message: JSONRPCMessage,
    messageType: 'request' | 'notification',
    strategy?: RoutingKeyStrategy
): string {
    const method = ('method' in message && typeof message.method === 'string')
        ? message.method
        : 'unknown';
    const fn = strategy ?? defaultRoutingKeyStrategy;
    return fn(method, messageType);
}

// ─── Correlation IDs ────────────────────────────────────────────────────────

/**
 * Generate a unique correlation ID for request/response pairing.
 */
export function generateCorrelationId(sessionId: string): string {
    return `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// ─── Configuration validation ───────────────────────────────────────────────

/**
 * Validate an AMQP configuration object.  Returns an array of human-readable
 * error strings (empty when valid).
 */
export function validateAmqpConfig(config: {
    amqpUrl: string;
    queuePrefix: string;
    exchangeName: string;
    reconnectDelay?: number;
    maxReconnectAttempts?: number;
    prefetchCount?: number;
}): string[] {
    const errors: string[] = [];

    // Validate AMQP URL scheme
    try {
        const url = new URL(config.amqpUrl);
        if (!['amqp:', 'amqps:'].includes(url.protocol)) {
            errors.push(`Invalid AMQP URL scheme: ${url.protocol} (expected amqp:// or amqps://)`);
        }
    } catch {
        errors.push(`Invalid AMQP URL: ${config.amqpUrl}`);
    }

    if (!config.queuePrefix || config.queuePrefix.trim() === '') {
        errors.push('Queue prefix cannot be empty');
    }

    if (!config.exchangeName || config.exchangeName.trim() === '') {
        errors.push('Exchange name cannot be empty');
    }

    if (config.reconnectDelay !== undefined && config.reconnectDelay < 1000) {
        errors.push('Reconnect delay must be at least 1000ms');
    }

    if (config.maxReconnectAttempts !== undefined && config.maxReconnectAttempts < 1) {
        errors.push('Max reconnect attempts must be at least 1');
    }

    if (config.prefetchCount !== undefined && config.prefetchCount < 1) {
        errors.push('Prefetch count must be at least 1');
    }

    return errors;
}

// ─── Default configuration factory ──────────────────────────────────────────

export interface DefaultAMQPConfig {
    AMQP_URL: string;
    AMQP_QUEUE_PREFIX: string;
    AMQP_EXCHANGE: string;
    AMQP_RECONNECT_DELAY: number;
    AMQP_MAX_RECONNECT_ATTEMPTS: number;
    AMQP_PREFETCH_COUNT: number;
    AMQP_MESSAGE_TTL: number;
    AMQP_QUEUE_TTL: number;
}

/**
 * Build an AMQP configuration from environment variables.
 * Call this at runtime rather than import-time so consuming applications
 * can set env vars before the config is read.
 */
export function getDefaultConfig(): DefaultAMQPConfig {
    return {
        AMQP_URL: process.env.AMQP_URL || 'amqp://localhost:5672',
        AMQP_QUEUE_PREFIX: process.env.AMQP_QUEUE_PREFIX || 'mcp',
        AMQP_EXCHANGE: process.env.AMQP_EXCHANGE || 'mcp.notifications',
        AMQP_RECONNECT_DELAY: parseInt(process.env.AMQP_RECONNECT_DELAY || '5000', 10),
        AMQP_MAX_RECONNECT_ATTEMPTS: parseInt(process.env.AMQP_MAX_RECONNECT_ATTEMPTS || '10', 10),
        AMQP_PREFETCH_COUNT: parseInt(process.env.AMQP_PREFETCH_COUNT || '1', 10),
        AMQP_MESSAGE_TTL: parseInt(process.env.AMQP_MESSAGE_TTL || '3600000', 10),
        AMQP_QUEUE_TTL: parseInt(process.env.AMQP_QUEUE_TTL || '7200000', 10),
    };
}

// ─── Structured logging ─────────────────────────────────────────────────────

export interface LogEntry {
    timestamp: string;
    transport: string;
    sessionId: string;
    operation: string;
    [key: string]: unknown;
}

export function createLogEntry(
    transport: string,
    sessionId: string,
    operation: string,
    data: Record<string, unknown> = {}
): LogEntry {
    return { timestamp: new Date().toISOString(), transport, sessionId, operation, ...data };
}

// ─── Health checking ────────────────────────────────────────────────────────

interface AmqpChannel {
    assertExchange(exchange: string, type: string, options: object): Promise<unknown>;
    publish(exchange: string, routingKey: string, content: Buffer): boolean;
    close(): Promise<void>;
}
interface AmqpConnection {
    createChannel(): Promise<AmqpChannel>;
}
interface AmqpTransport {
    connection?: AmqpConnection;
}

export interface HealthCheckResult {
    healthy: boolean;
    reason?: string;
    timestamp: string;
}

export async function testAmqpConnection(transport: AmqpTransport): Promise<HealthCheckResult> {
    if (!transport?.connection) {
        return { healthy: false, reason: 'No transport or connection available', timestamp: new Date().toISOString() };
    }
    try {
        const ch = await transport.connection.createChannel();
        await ch.assertExchange('mcp.heartbeat', 'fanout', { durable: false });
        ch.publish('mcp.heartbeat', '', Buffer.from(JSON.stringify({
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            source: 'mcp-amqp-transport'
        })));
        await ch.close();
        return { healthy: true, timestamp: new Date().toISOString() };
    } catch (error) {
        return { healthy: false, reason: (error as Error).message, timestamp: new Date().toISOString() };
    }
}

export interface AMQPStatus {
    connected: boolean;
    transport: boolean;
    autoRecovery: boolean;
    timestamp: string;
    recovery?: { enabled: boolean; status: string; retryCount?: number; lastAttempt?: string; stopped?: boolean };
}

export interface AutoRecoveryConfig {
    enabled: boolean;
    status?: string;
    retryCount?: number;
    lastAttempt?: string;
    stopped?: boolean;
}

export function getAmqpStatus(transport: AmqpTransport, autoRecoveryConfig?: AutoRecoveryConfig): AMQPStatus {
    const status: AMQPStatus = {
        connected: !!transport,
        transport: !!transport,
        autoRecovery: !!(autoRecoveryConfig?.enabled),
        timestamp: new Date().toISOString()
    };
    if (autoRecoveryConfig) {
        status.recovery = {
            enabled: autoRecoveryConfig.enabled,
            status: autoRecoveryConfig.status ?? 'standby',
            ...(autoRecoveryConfig.retryCount !== undefined && { retryCount: autoRecoveryConfig.retryCount }),
            ...(autoRecoveryConfig.lastAttempt !== undefined && { lastAttempt: autoRecoveryConfig.lastAttempt }),
            ...(autoRecoveryConfig.stopped !== undefined && { stopped: autoRecoveryConfig.stopped }),
        };
    } else {
        status.recovery = { enabled: false, status: 'disabled' };
    }
    return status;
}
