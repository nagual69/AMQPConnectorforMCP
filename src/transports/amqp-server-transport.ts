/**
 * AMQP Server Transport for Model Context Protocol
 *
 * Implements the MCP Transport interface over AMQP.  Incoming messages are
 * consumed from a single topic-exchange-bound queue; outgoing responses are
 * routed directly to the requesting client's exclusive reply queue using the
 * correlationId / replyTo pair stored at request time.
 *
 * Key design decisions aligned with MCP specification 2025-11-25:
 *  - Wire format is pure JSON-RPC 2.0 (no custom envelope)
 *  - Incoming messages are validated against JSON-RPC 2.0 schema
 *  - TransportSendOptions.relatedRequestId is the primary lookup key
 *  - onclose fires on every connection termination path
 *  - Reconnection is suppressed after intentional close()
 *  - Routing keys are configurable via routingKeyStrategy
 *  - routingInfoStore entries expire after a configurable TTL
 */

import crypto from 'crypto';
import type { Transport, TransportSendOptions } from "./types.js";
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from "./types.js";
import type { AMQPServerTransportOptions, ConnectionState } from "./types.js";
import type { Channel, ConsumeMessage } from 'amqplib';
import {
    detectMessageType,
    isJSONRPCRequest,
    isJSONRPCNotification,
    getRoutingKey,
    validateJSONRPC,
} from "./amqp-utils.js";

// Minimal connection interface to align with amqplib Promise API
interface AMQPConnection {
    createChannel(): Promise<Channel>;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: () => void): void;
    close(): Promise<void>;
}

// Routing information stored per incoming request
interface RoutingInfo {
    correlationId: string;
    replyTo: string;
    timestamp: number;     // for TTL-based cleanup
}

/**
 * AMQP Server Transport for Model Context Protocol
 */
export class AMQPServerTransport implements Transport {
    // Core AMQP infrastructure
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;

    // Connection state
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private channelRecovering = false;
    private closing = false;

    // Session management
    sessionId: string;

    // Response correlation — keyed by RequestId
    private routingInfoStore = new Map<string | number, RoutingInfo>();
    private routingCleanupTimer: ReturnType<typeof setInterval> | null = null;

    // Protocol version (MCP SDK requirement)
    private _protocolVersion?: string;

    // Transport interface callbacks — SDK owns these directly (C6 fix)
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /** @internal Injectable connect function for testing. */
    _connectFn?: (url: string) => Promise<AMQPConnection>;

    constructor(private options: AMQPServerTransportOptions) {
        this.validateOptions();

        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            prefetchCount: 1,
            messageTTL: 60000,
            queueTTL: 300000,
            maxMessageSize: 1_048_576,
            ...options
        };

        this.sessionId = crypto.randomUUID();
    }

    private validateOptions(): void {
        if (!this.options.amqpUrl) {
            throw new Error('amqpUrl is required');
        }
        if (!this.options.queuePrefix) {
            throw new Error('queuePrefix is required');
        }
        if (!this.options.exchangeName) {
            throw new Error('exchangeName is required');
        }
    }

    /**
     * Start the transport — idempotent as required by MCP SDK.
     */
    async start(): Promise<void> {
        if (this.connectionState.connected) {
            return;
        }
        this.closing = false;
        try {
            await this.connect();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;

            // Start periodic cleanup of stale routing info (M5)
            this.startRoutingCleanup();

            console.log(`[AMQP Server] Transport started (session=${this.sessionId})`);
        } catch (error) {
            this.connectionState.lastError = error as Error;
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Send a JSON-RPC message.
     *
     * For responses, uses `options.relatedRequestId` (falling back to
     * `message.id`) to look up the stored routing info so the response is
     * delivered to the correct client reply queue.
     */
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!this.connectionState.connected || !this.channel) {
            return Promise.reject(new Error('Transport not connected'));
        }

        try {
            const messageType = detectMessageType(message);

            switch (messageType) {
                case 'response':
                    this.handleResponseMessage(message, options);
                    break;
                case 'request':
                    this.handleRequestMessage(message);
                    break;
                case 'notification':
                    this.handleNotificationMessage(message);
                    break;
            }
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(error);
        }
    }

    /**
     * Close the transport.
     */
    async close(): Promise<void> {
        this.closing = true;
        this.connectionState.connected = false;

        // Stop routing cleanup timer
        if (this.routingCleanupTimer) {
            clearInterval(this.routingCleanupTimer);
            this.routingCleanupTimer = null;
        }

        this.routingInfoStore.clear();

        try {
            if (this.channel) {
                await this.channel.close();
                this.channel = null;
            }
            if (this.connection) {
                await this.connection.close();
                this.connection = null;
            }
        } catch (error) {
            console.warn(`[AMQP Server] Error during cleanup: ${(error as Error).message}`);
        }

        this.onclose?.();
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    // ── Private: connection setup ───────────────────────────────────────────

    private async connect(): Promise<void> {
        if (this._connectFn) {
            this.connection = await this._connectFn(this.options.amqpUrl);
        } else {
            const amqp = await this.loadAMQPLibrary();
            this.connection = await amqp.connect(this.options.amqpUrl) as unknown as AMQPConnection;
        }

        const conn = this.connection;
        conn.on('error', (error: Error) => {
            this.connectionState.connected = false;
            this.connectionState.lastError = error;
            this.onerror?.(error);
            if (!this.closing) {
                this.scheduleReconnect();
            }
        });

        conn.on('close', () => {
            this.connectionState.connected = false;
            if (!this.closing) {
                this.scheduleReconnect();
            }
        });

        this.channel = await conn.createChannel();

        if (this.options.prefetchCount && this.channel) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        const ch = this.channel;
        ch.on('error', (error: Error) => {
            this.onerror?.(error);
            if (error.message.includes('PRECONDITION_FAILED') || error.message.includes('delivery tag')) {
                this.scheduleChannelRecovery();
            }
        });

        ch.on('close', () => {
            if (!this.closing) {
                this.scheduleChannelRecovery();
            }
        });

        await this.setupInfrastructure();
    }

    /**
     * Single consumption path via the routing exchange (M2 consolidation).
     */
    private async setupInfrastructure(): Promise<void> {
        if (!this.channel) throw new Error('AMQP channel not established');

        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

        // Session-specific request queue
        const queueName = `${this.options.queuePrefix}.requests.${this.sessionId}`;
        const queue = await this.channel.assertQueue(queueName, {
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });

        // Bind to MCP request and notification patterns
        const patterns = [
            'mcp.request.#',
            'mcp.notification.#',
        ];
        for (const pattern of patterns) {
            await this.channel.bindQueue(queue.queue, exchangeName, pattern);
        }

        // Single consumer
        await this.channel.consume(queue.queue, (msg: ConsumeMessage | null) => {
            if (msg) {
                this.handleIncomingMessage(msg);
            }
        }, { noAck: false });
    }

    // ── Private: incoming message handling ───────────────────────────────────

    private handleIncomingMessage(msg: ConsumeMessage): void {
        try {
            // S1: message size check
            if (msg.content.length > (this.options.maxMessageSize ?? 1_048_576)) {
                this.onerror?.(new Error(`Incoming message exceeds maxMessageSize (${msg.content.length} bytes)`));
                this.safeNack(msg);
                return;
            }

            // S2 + C3: parse and validate JSON-RPC (rejects missing jsonrpc:"2.0")
            const jsonRpcMessage = validateJSONRPC(JSON.parse(msg.content.toString()));

            // Store routing info for request messages so we can route responses back
            if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined && jsonRpcMessage.id !== null) {
                const correlationId = typeof msg.properties.correlationId === 'string'
                    ? msg.properties.correlationId : undefined;
                const replyTo = typeof msg.properties.replyTo === 'string'
                    ? msg.properties.replyTo : undefined;

                if (correlationId && replyTo) {
                    this.routingInfoStore.set(jsonRpcMessage.id as RequestId, {
                        correlationId,
                        replyTo,
                        timestamp: Date.now(),
                    });
                }
            }

            // Forward to MCP SDK
            this.onmessage?.(jsonRpcMessage);
            this.safeAck(msg);

        } catch (error) {
            console.error('[AMQP Server] Error handling message:', (error as Error).message);
            this.onerror?.(error as Error);
            this.safeNack(msg);
        }
    }

    // ── Private: outgoing message handling ───────────────────────────────────

    /**
     * Route a response back to the requesting client's exclusive reply queue.
     * Uses `options.relatedRequestId` as the primary lookup key (C2 fix),
     * falling back to `message.id`.
     */
    private handleResponseMessage(message: JSONRPCMessage, options?: TransportSendOptions): void {
        // C2: prefer relatedRequestId from SDK, fall back to message.id
        const lookupId: RequestId | undefined =
            options?.relatedRequestId ??
            (('id' in message && message.id !== undefined) ? message.id as RequestId : undefined);

        if (lookupId === undefined) {
            throw new Error('Response message must have an id or relatedRequestId');
        }

        const routingInfo = this.routingInfoStore.get(lookupId);
        if (!routingInfo) {
            throw new Error(`No routing info found for response id=${String(lookupId)}`);
        }
        this.routingInfoStore.delete(lookupId);

        if (!this.channel) throw new Error('AMQP channel not established');

        const messageBuffer = Buffer.from(JSON.stringify(message));
        this.channel.sendToQueue(routingInfo.replyTo, messageBuffer, {
            correlationId: routingInfo.correlationId,
            contentType: 'application/json',
            persistent: false,
        });
    }

    private handleRequestMessage(message: JSONRPCMessage): void {
        if (!isJSONRPCRequest(message)) {
            throw new Error('Invalid request message format');
        }
        if (!this.channel) throw new Error('AMQP channel not established');

        const routingKey = getRoutingKey(message, 'request', this.options.routingKeyStrategy);
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        const messageBuffer = Buffer.from(JSON.stringify(message));

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            contentType: 'application/json',
            persistent: true,
            timestamp: Date.now(),
        });
    }

    private handleNotificationMessage(message: JSONRPCMessage): void {
        if (!isJSONRPCNotification(message)) {
            throw new Error('Invalid notification message format');
        }
        if (!this.channel) throw new Error('AMQP channel not established');

        const routingKey = getRoutingKey(message, 'notification', this.options.routingKeyStrategy);
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        const messageBuffer = Buffer.from(JSON.stringify(message));

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            contentType: 'application/json',
            persistent: false,
            timestamp: Date.now(),
        });
    }

    // ── Private: routing info TTL cleanup (M5) ──────────────────────────────

    private startRoutingCleanup(): void {
        // Clean up stale routing entries every 30 seconds
        const ttl = this.options.messageTTL ?? 60000;
        this.routingCleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [id, info] of this.routingInfoStore) {
                if (now - info.timestamp > ttl) {
                    this.routingInfoStore.delete(id);
                }
            }
        }, 30_000);
        // Allow the process to exit even if the timer is running
        if (this.routingCleanupTimer.unref) {
            this.routingCleanupTimer.unref();
        }
    }

    // ── Private: message ack helpers ────────────────────────────────────────

    private safeAck(msg: ConsumeMessage): void {
        if (this.channel) {
            try { this.channel.ack(msg); } catch { /* delivery tag may be stale */ }
        }
    }

    private safeNack(msg: ConsumeMessage): void {
        if (this.channel) {
            try { this.channel.nack(msg, false, false); } catch { /* best-effort */ }
        }
    }

    // ── Private: recovery ───────────────────────────────────────────────────

    private scheduleReconnect(): void {
        const maxAttempts = this.options.maxReconnectAttempts ?? 10;
        if (this.connectionState.reconnectAttempts >= maxAttempts) {
            const error = new Error('Maximum reconnection attempts exceeded');
            this.onerror?.(error);
            this.onclose?.();   // C5: always signal closure
            return;
        }

        this.connectionState.reconnectAttempts++;
        const delay = this.options.reconnectDelay ?? 5000;

        setTimeout(() => {
            if (this.closing) return;
            void this.connect()
                .then(() => {
                    this.connectionState.connected = true;
                    this.connectionState.reconnectAttempts = 0;
                    console.log('[AMQP Server] Reconnection successful');
                })
                .catch((error) => {
                    this.connectionState.lastError = error as Error;
                    this.scheduleReconnect();
                });
        }, delay);
    }

    private scheduleChannelRecovery(): void {
        if (this.channelRecovering || this.closing) return;
        this.channelRecovering = true;

        setTimeout(() => {
            void (async () => {
                try {
                    if (this.connection) {
                        this.channel = await this.connection.createChannel();
                        if (this.options.prefetchCount && this.channel) {
                            await this.channel.prefetch(this.options.prefetchCount);
                        }
                        await this.setupInfrastructure();
                        console.log('[AMQP Server] Channel recovery completed');
                    }
                } catch {
                    this.scheduleReconnect();
                } finally {
                    this.channelRecovering = false;
                }
            })();
        }, 1000);
    }

    private async loadAMQPLibrary(): Promise<typeof import('amqplib')> {
        try {
            return await import('amqplib');
        } catch {
            throw new Error('amqplib package not found. Please install with: npm install amqplib');
        }
    }
}
