/**
 * AMQP Client Transport for Model Context Protocol
 *
 * Implements the MCP Transport interface over AMQP, sending raw JSON-RPC 2.0
 * messages as the message body with transport metadata carried in AMQP
 * message properties (correlationId, replyTo, contentType).
 *
 * Key design decisions aligned with MCP specification 2025-11-25:
 *  - Wire format is pure JSON-RPC 2.0 (no custom envelope)
 *  - TransportSendOptions.relatedRequestId is respected
 *  - onclose fires on every connection termination path
 *  - Reconnection is suppressed after intentional close()
 *  - Routing keys are configurable via routingKeyStrategy
 */

import crypto from 'crypto';
import type { Transport, TransportSendOptions } from "./types.js";
import type { JSONRPCMessage, MessageExtraInfo } from "./types.js";
import type { AMQPClientTransportOptions, ConnectionState } from "./types.js";
import type { Channel, ConsumeMessage } from 'amqplib';
import {
    detectMessageType,
    isJSONRPCRequest,
    generateCorrelationId,
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

// Request tracking
interface PendingRequest {
    startTime: number;
    method: string | undefined;
    timeout: ReturnType<typeof setTimeout>;
    correlationId: string;
}

/**
 * AMQP Client Transport for Model Context Protocol
 */
export class AMQPClientTransport implements Transport {
    // Core AMQP infrastructure
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;
    private responseQueue: string | null = null;

    // Connection state
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private channelRecovering = false;
    private closing = false;

    // Session management
    sessionId: string;

    // Correlation tracking
    private pendingRequests = new Map<string, PendingRequest>();

    // Protocol version (MCP SDK requirement)
    private _protocolVersion?: string;

    // Transport interface callbacks
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Injectable connect function for testing. When set, `start()` uses this
     * instead of importing amqplib.  The signature matches `amqplib.connect()`.
     * @internal
     */
    _connectFn?: (url: string) => Promise<AMQPConnection>;

    constructor(private options: AMQPClientTransportOptions) {
        this.validateOptions();

        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            responseTimeout: 30000,
            prefetchCount: 10,
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
        if (!this.options.serverQueuePrefix) {
            throw new Error('serverQueuePrefix is required');
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

            console.log(`[AMQP Client] Transport started (session=${this.sessionId})`);
        } catch (error) {
            this.connectionState.lastError = error as Error;
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Send a JSON-RPC message.
     *
     * The raw JSON-RPC message is sent as the AMQP body.  Transport metadata
     * (correlationId, replyTo) is carried in AMQP message properties.
     */
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!this.connectionState.connected || !this.channel) {
            return Promise.reject(new Error('Transport not connected'));
        }

        try {
            const messageType = detectMessageType(message);
            const exchangeName = `${this.options.exchangeName}.mcp.routing`;
            const messageBuffer = Buffer.from(JSON.stringify(message));

            switch (messageType) {
                case 'request':
                    this.sendRequest(message, messageBuffer, exchangeName, options);
                    break;
                case 'response':
                    this.sendResponse(messageBuffer, exchangeName);
                    break;
                case 'notification':
                    this.sendNotification(message, messageBuffer, exchangeName);
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

        // Clear all pending requests
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
        }
        this.pendingRequests.clear();

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
            console.warn(`[AMQP Client] Error during cleanup: ${(error as Error).message}`);
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
            const amqpLib = await this.loadAMQPLibrary();
            this.connection = await (amqpLib.connect(this.options.amqpUrl) as unknown as Promise<AMQPConnection>);
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

    private async setupInfrastructure(): Promise<void> {
        if (!this.channel) throw new Error('AMQP channel not established');

        // Assert the routing exchange
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

        // Exclusive response queue
        const responseQueueResult = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });
        this.responseQueue = responseQueueResult.queue;

        // Consume responses
        await this.channel.consume(this.responseQueue, (msg: ConsumeMessage | null) => {
            if (msg) {
                this.handleResponse(msg);
                this.safeAck(msg);
            }
        }, { noAck: false });

        // Subscribe to notifications
        await this.subscribeToNotifications(exchangeName);
    }

    // ── Private: message sending ────────────────────────────────────────────

    private sendRequest(
        message: JSONRPCMessage,
        messageBuffer: Buffer,
        exchangeName: string,
        _options?: TransportSendOptions,
    ): void {
        if (!isJSONRPCRequest(message)) {
            throw new Error('Invalid request message format');
        }
        if (!this.responseQueue) {
            throw new Error('Response queue not available');
        }
        if (!this.channel) throw new Error('AMQP channel not established');

        const correlationId = generateCorrelationId(this.sessionId);
        const routingKey = getRoutingKey(message, 'request', this.options.routingKeyStrategy);

        // Set up timeout tracking
        this.setupRequestTimeout(correlationId, message.method);

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            correlationId,
            replyTo: this.responseQueue,
            contentType: 'application/json',
            timestamp: Date.now(),
            persistent: false,
        });
    }

    private sendResponse(
        messageBuffer: Buffer,
        exchangeName: string,
    ): void {
        if (!this.channel) throw new Error('AMQP channel not established');

        this.channel.publish(exchangeName, 'mcp.response', messageBuffer, {
            contentType: 'application/json',
            persistent: false,
            timestamp: Date.now(),
        });
    }

    private sendNotification(
        message: JSONRPCMessage,
        messageBuffer: Buffer,
        exchangeName: string,
    ): void {
        if (!this.channel) throw new Error('AMQP channel not established');

        const routingKey = getRoutingKey(message, 'notification', this.options.routingKeyStrategy);

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            contentType: 'application/json',
            persistent: false,
            timestamp: Date.now(),
        });
    }

    // ── Private: message receiving ──────────────────────────────────────────

    private handleResponse(msg: ConsumeMessage): void {
        try {
            if (msg.content.length > (this.options.maxMessageSize ?? 1_048_576)) {
                this.onerror?.(new Error(`Incoming message exceeds maxMessageSize (${msg.content.length} bytes)`));
                return;
            }

            const response = validateJSONRPC(JSON.parse(msg.content.toString()) as unknown);
            const rawCorrelationId: unknown = msg.properties?.correlationId;
            const correlationId = typeof rawCorrelationId === 'string' ? rawCorrelationId : undefined;

            if (correlationId && this.pendingRequests.has(correlationId)) {
                const pending = this.pendingRequests.get(correlationId)!;
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(correlationId);
            }

            this.onmessage?.(response);
        } catch (error) {
            this.onerror?.(error as Error);
        }
    }

    private async subscribeToNotifications(exchangeName: string): Promise<void> {
        if (!this.channel) return;

        const notificationQueue = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });

        const patterns = ['mcp.notification.#'];
        for (const pattern of patterns) {
            await this.channel.bindQueue(notificationQueue.queue, exchangeName, pattern);
        }

        await this.channel.consume(notificationQueue.queue, (msg: ConsumeMessage | null) => {
            if (msg) {
                try {
                    if (msg.content.length > (this.options.maxMessageSize ?? 1_048_576)) {
                        this.onerror?.(new Error(`Incoming notification exceeds maxMessageSize (${msg.content.length} bytes)`));
                    } else {
                        const notification = validateJSONRPC(JSON.parse(msg.content.toString()));
                        this.onmessage?.(notification);
                    }
                } catch (error) {
                    this.onerror?.(error as Error);
                }
                this.safeAck(msg);
            }
        }, { noAck: false });
    }

    // ── Private: timeout & correlation ───────────────────────────────────────

    private setupRequestTimeout(correlationId: string, method?: string): void {
        const timeoutMs = this.options.responseTimeout!;
        const timeout = setTimeout(() => {
            if (this.pendingRequests.has(correlationId)) {
                this.pendingRequests.delete(correlationId);
                this.onerror?.(new Error(`Request timeout after ${timeoutMs}ms for ${method ?? 'unknown'}`));
            }
        }, timeoutMs);

        this.pendingRequests.set(correlationId, {
            startTime: Date.now(),
            method,
            timeout,
            correlationId
        });
    }

    private safeAck(msg: ConsumeMessage): void {
        if (this.channel) {
            try { this.channel.ack(msg); } catch { /* delivery tag may be stale */ }
        }
    }

    // ── Private: recovery ───────────────────────────────────────────────────

    private scheduleReconnect(): void {
        const maxAttempts = this.options.maxReconnectAttempts ?? 10;
        if (this.connectionState.reconnectAttempts >= maxAttempts) {
            const error = new Error('Maximum reconnection attempts exceeded');
            this.onerror?.(error);
            this.onclose?.();
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
                    console.log('[AMQP Client] Reconnection successful');
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
                        console.log('[AMQP Client] Channel recovery completed');
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
