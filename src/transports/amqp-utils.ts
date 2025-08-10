/**
 * AMQP Transport Utilities
 * 
 * This module provides utility functions extracted from the working JavaScript implementations
 * for use with the TypeScript AMQP transports. These utilities provide enterprise-grade
 * functionality including health checking, configuration validation, and structured logging.
 */

import type { JSONRPCMessage } from "./types.js";

/**
 * Parse result interface for message parsing
 */
export interface ParseResult {
    success: boolean;
    message: JSONRPCMessage | null;
    error: Error | null;
}

/**
 * Log entry structure for debugging and monitoring
 */
export interface LogEntry {
    timestamp: string;
    transport: string;
    sessionId: string;
    operation: string;
    [key: string]: any;
}

/**
 * AMQP status information
 */
export interface AMQPStatus {
    connected: boolean;
    transport: boolean;
    autoRecovery: boolean;
    timestamp: string;
    recovery?: {
        enabled: boolean;
        status: string;
        retryCount?: number;
        lastAttempt?: string;
        stopped?: boolean;
    };
}

/**
 * Health check result
 */
export interface HealthCheckResult {
    healthy: boolean;
    reason?: string;
    timestamp: string;
}

/**
 * Determine tool category for routing (matches server-side categories)
 * Extracted from base-amqp-transport.js analysis
 */
export function getToolCategory(method: string): string {
    if (method.startsWith('nmap_')) return 'nmap';
    if (method.startsWith('snmp_')) return 'snmp';
    if (method.startsWith('proxmox_')) return 'proxmox';
    if (method.startsWith('zabbix_')) return 'zabbix';
    if (['ping', 'telnet', 'wget', 'netstat', 'ifconfig', 'arp', 'route', 'nslookup', 'tcp_connect', 'whois'].includes(method)) return 'network';
    if (method.startsWith('memory_') || method.startsWith('cmdb_')) return 'memory';
    if (method.startsWith('credentials_')) return 'credentials';
    if (method.startsWith('registry_')) return 'registry';
    return 'general';
}

/**
 * Validate and parse JSON message with error handling
 * Extracted from base-amqp-transport.js
 */
export function parseMessage(content: Buffer | string, transportType: string = 'amqp'): ParseResult {
    try {
        const message = JSON.parse(content.toString());
        return {
            success: true,
            message,
            error: null
        };
    } catch (parseError) {
        console.error(`[AMQP ${transportType}] Failed to parse message JSON:`, parseError);
        return {
            success: false,
            message: null,
            error: parseError as Error
        };
    }
}

/**
 * Create structured log entry for debugging
 * Extracted from base-amqp-transport.js
 */
export function createLogEntry(
    transport: string,
    sessionId: string,
    operation: string,
    data: Record<string, any> = {}
): LogEntry {
    return {
        timestamp: new Date().toISOString(),
        transport,
        sessionId,
        operation,
        ...data
    };
}

/**
 * Parse transport mode string into array of valid modes
 * Extracted from amqp-transport-integration.js
 */
export function parseTransportMode(mode?: string): string[] {
    if (!mode) return ['stdio']; // Default fallback

    const normalized = mode.toLowerCase().trim();

    // Handle special cases
    if (normalized === 'all') {
        return ['stdio', 'http', 'amqp'];
    }

    // Parse comma-separated modes
    const modes = normalized.split(',').map(m => m.trim()).filter(Boolean);

    // Validate each mode
    const validModes = ['stdio', 'http', 'amqp'];
    const invalidModes = modes.filter(m => !validModes.includes(m));

    if (invalidModes.length > 0) {
        throw new Error(`Invalid transport modes: ${invalidModes.join(', ')}. Valid modes are: ${validModes.join(', ')}`);
    }

    return modes.length > 0 ? modes : ['stdio'];
}

/**
 * Validate AMQP configuration
 * Extracted from amqp-transport-integration.js
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

    // Validate AMQP URL
    try {
        new URL(config.amqpUrl);
    } catch (error) {
        errors.push(`Invalid AMQP URL: ${config.amqpUrl}`);
    }

    // Validate queue prefix
    if (!config.queuePrefix || config.queuePrefix.trim() === '') {
        errors.push('Queue prefix cannot be empty');
    }

    // Validate exchange name
    if (!config.exchangeName || config.exchangeName.trim() === '') {
        errors.push('Exchange name cannot be empty');
    }

    // Validate numeric values
    if (config.reconnectDelay && config.reconnectDelay < 1000) {
        errors.push('Reconnect delay must be at least 1000ms');
    }

    if (config.maxReconnectAttempts && config.maxReconnectAttempts < 1) {
        errors.push('Max reconnect attempts must be at least 1');
    }

    if (config.prefetchCount && config.prefetchCount < 1) {
        errors.push('Prefetch count must be at least 1');
    }

    return errors;
}

/**
 * Test AMQP connection health by sending a heartbeat message
 * Extracted from amqp-transport-integration.js
 */
export async function testAmqpConnection(transport: any): Promise<HealthCheckResult> {
    if (!transport || !transport.connection) {
        return {
            healthy: false,
            reason: 'No transport or connection available',
            timestamp: new Date().toISOString()
        };
    }

    try {
        // Try to send a simple test message to verify connection
        const testChannel = await transport.connection.createChannel();
        await testChannel.assertExchange('mcp.heartbeat', 'fanout', { durable: false });
        await testChannel.publish('mcp.heartbeat', '', Buffer.from(JSON.stringify({
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            source: 'mcp-amqp-transport'
        })));
        await testChannel.close();

        return {
            healthy: true,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        return {
            healthy: false,
            reason: (error as Error).message,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Get AMQP connection status including auto-recovery information
 * Extracted from amqp-transport-integration.js
 */
export function getAmqpStatus(transport: any, autoRecoveryConfig?: any): AMQPStatus {
    const status: AMQPStatus = {
        connected: !!transport,
        transport: !!transport,
        autoRecovery: !!(autoRecoveryConfig && autoRecoveryConfig.enabled),
        timestamp: new Date().toISOString()
    };

    // Include auto-recovery configuration if available
    if (autoRecoveryConfig) {
        status.recovery = {
            enabled: autoRecoveryConfig.enabled,
            status: 'standby' // Default status
        };
    } else {
        status.recovery = { enabled: false, status: 'disabled' };
    }

    return status;
}

/**
 * Enhanced message type detection following MCP v2025-06-18 specification
 * Extracted from base-amqp-transport.js
 */
export function detectMessageType(message: JSONRPCMessage): 'request' | 'response' | 'notification' {
    // Priority 1: Check for response (id + result/error)
    if ('id' in message && message.id !== undefined && message.id !== null &&
        ('result' in message || 'error' in message)) {
        return 'response';
    }

    // Priority 2: Check for request (id + method, but no result/error)
    if ('id' in message && message.id !== undefined && message.id !== null && 'method' in message) {
        return 'request';
    }

    // Priority 3: Check for notification (method only, no id)
    if ('method' in message && (!('id' in message) || message.id === undefined || message.id === null)) {
        return 'notification';
    }

    // Fallback for malformed messages
    console.warn(`[AMQP Util] Unknown message type, treating as notification:`, message);
    return 'notification';
}

/**
 * Generate correlation ID for message tracking
 * Extracted from base-amqp-transport.js
 */
export function generateCorrelationId(sessionId: string): string {
    return `${sessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Tool category mappings for enterprise platform
 * Extracted from amqp-transport-integration.js
 */
export const TOOL_CATEGORIES = {
    memory: ['memory_', 'cmdb_'],
    network: ['ping', 'telnet', 'wget', 'netstat', 'ifconfig', 'arp', 'route', 'nslookup'],
    nmap: ['nmap_'],
    proxmox: ['proxmox_'],
    snmp: ['snmp_'],
    zabbix: ['zabbix_'],
    credentials: ['creds_', 'credentials_'],
    registry: ['registry_', 'tool_']
};

/**
 * Enhanced AMQP configuration with defaults
 * Extracted from amqp-transport-integration.js
 */
export const DEFAULT_AMQP_CONFIG = {
    AMQP_URL: process.env.AMQP_URL || 'amqp://localhost:5672',
    AMQP_QUEUE_PREFIX: process.env.AMQP_QUEUE_PREFIX || 'mcp',
    AMQP_EXCHANGE: process.env.AMQP_EXCHANGE || 'mcp.notifications',
    AMQP_RECONNECT_DELAY: parseInt(process.env.AMQP_RECONNECT_DELAY || '5000'),
    AMQP_MAX_RECONNECT_ATTEMPTS: parseInt(process.env.AMQP_MAX_RECONNECT_ATTEMPTS || '10'),
    AMQP_PREFETCH_COUNT: parseInt(process.env.AMQP_PREFETCH_COUNT || '1'),
    AMQP_MESSAGE_TTL: parseInt(process.env.AMQP_MESSAGE_TTL || '3600000'), // 1 hour
    AMQP_QUEUE_TTL: parseInt(process.env.AMQP_QUEUE_TTL || '7200000'), // 2 hours
};
