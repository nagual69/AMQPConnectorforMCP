/**
 * Enhanced AMQP Client Transport for Model Context Protocol
 * 
 * This implementation provides enterprise-grade AMQP-based transport for MCP clients,
 * incorporating advanced patterns discovered from JavaScript implementation analysis:
 * - Sophisticated correlation handling with timeout management
 * - Bidirectional pub/sub channels for distributed messaging
 * - Advanced error recovery and resilience patterns
 * - Performance monitoring and request tracking
 * - Tool category-based intelligent routing
 */

import type { Transport, TransportSendOptions } from "./types.js";
import type { JSONRPCMessage, MessageExtraInfo } from "./types.js";
import type { AMQPClientTransportOptions, AMQPMessage, ConnectionState } from "./types.js";
import type { Channel, ConsumeMessage } from 'amqplib';

// Minimal connection interface to align with amqplib Promise API
interface AMQPConnection {
    createChannel(): Promise<Channel>;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: () => void): void;
    close(): Promise<void>;
}

// Enhanced request tracking interface (from JS analysis)
interface PendingRequest {
    startTime: number;
    method?: string;
    resolve: (message: JSONRPCMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    correlationId: string;
}

// Helper type guards (enhanced with strict MCP SDK compliance)
function isJSONRPCRequest(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number; method: string } {
    return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

// Note: error detection is handled by consumers of JSON-RPC responses

/**
 * Enterprise-grade AMQP Client Transport for Model Context Protocol
 */
export class AMQPClientTransport implements Transport {
    // Core AMQP infrastructure
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;
    private pubsubChannel: Channel | null = null; // for bidirectional routing
    private responseQueue: string | null = null;

    // Connection state management
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private channelRecovering = false;

    // Session management for distributed routing (key discovery from JS analysis)
    sessionId: string;
    private streamId: string;
    private requestChannelId: string;
    private responseChannelId: string;

    // Enhanced correlation and request management (core enterprise patterns)
    private pendingRequests = new Map<string, PendingRequest>();
    private requestMetrics = new Map<string, { startTime: number; method: string; }>(); // Performance tracking

    // Protocol version support (required by MCP SDK)
    private _protocolVersion?: string;

    // Transport interface callbacks (MCP SDK requirements)
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(private options: AMQPClientTransportOptions) {
        this.validateOptions();

        // Set enterprise-grade defaults with backward compatibility
        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            responseTimeout: 30000,
            prefetchCount: 10,
            messageTTL: 60000, // 1 minute
            queueTTL: 300000, // 5 minutes
            ...options
        };

        // Generate unique session identifiers for distributed routing
        this.sessionId = `amqp-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.requestChannelId = `req.${this.sessionId}`;
        this.responseChannelId = `resp.${this.sessionId}`;
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
     * Start the enhanced transport with bidirectional channels
     */
    async start(): Promise<void> {
        // Idempotent start: SDK may call start() multiple times
        if (this.connectionState.connected) {
            console.log('[AMQP Client] Transport already started, skipping start()');
            return;
        }
        try {
            await this.connect();
            // Setup both basic infrastructure AND advanced bidirectional channels
            await this.setupBidirectionalChannels();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;

            console.log('[AMQP Client] Enhanced transport started with enterprise routing:', {
                sessionId: this.sessionId,
                streamId: this.streamId,
                requestChannel: this.requestChannelId,
                responseChannel: this.responseChannelId
            });
        } catch (error) {
            this.connectionState.lastError = error as Error;
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Enhanced message sending with intelligent routing and performance tracking
     */
    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (!this.connectionState.connected || !this.channel) {
            throw new Error('Transport not connected');
        }

        const messageType = this.detectMessageType(message);
        const correlationId = this.generateCorrelationId();

        // Enhanced performance tracking for requests
        if (messageType === 'request' && isJSONRPCRequest(message)) {
            this.requestMetrics.set(correlationId, {
                startTime: Date.now(),
                method: message.method
            });
        }

        // Create enhanced envelope with bidirectional routing information
        const envelope: AMQPMessage = {
            message,
            timestamp: Date.now(),
            type: messageType,
            correlationId
        };

        // Enhanced routing based on message type
        switch (messageType) {
            case 'request':
                await this.handleRequestMessage(envelope);
                break;
            case 'response':
                await this.handleResponseMessage(envelope);
                break;
            case 'notification':
                await this.handleNotificationMessage(envelope);
                break;
            default:
                throw new Error(`Unknown message type for message: ${JSON.stringify(message)}`);
        }
    }

    /**
     * Enhanced cleanup with bidirectional channels
     */
    async close(): Promise<void> {
        this.connectionState.connected = false;

        // Clear all pending requests with proper cleanup
        for (const [correlationId, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Transport closed"));
            console.warn(`[AMQP Client] Clearing pending request: ${correlationId} (${pending.method})`);
        }
        this.pendingRequests.clear();
        this.requestMetrics.clear();

        try {
            // Enhanced cleanup with bidirectional channels
            if (this.pubsubChannel) {
                await this.pubsubChannel.close();
                this.pubsubChannel = null;
            }

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

    /**
     * Set protocol version (MCP SDK requirement)
     */
    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    /**
     * Get protocol version (MCP SDK requirement)
     */
    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    /**
     * Enhanced connection setup with automatic recovery
     */
    private async connect(): Promise<void> {
    const amqpLib = await this.loadAMQPLibrary();

    // amqplib types aren't exported for Connection directly here; cast narrowly to our AMQPConnection
    this.connection = await (amqpLib.connect(this.options.amqpUrl) as unknown as Promise<AMQPConnection>);

        // Enhanced connection error handling with automatic recovery
        const conn = this.connection;
        conn.on('error', (error: Error) => {
            this.connectionState.connected = false;
            this.connectionState.lastError = error;
            this.onerror?.(error);
            this.scheduleReconnect();
        });

        conn.on('close', () => {
            this.connectionState.connected = false;
            console.log('[AMQP Client] Connection closed, scheduling reconnect...');
            this.scheduleReconnect();
        });

        // Create main channel with enhanced error handling
        this.channel = await conn.createChannel();

        // Enterprise-grade prefetch control for performance
        if (this.options.prefetchCount && this.channel) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        // Advanced channel error handling with recovery
        const ch = this.channel;
        ch.on('error', (error: Error) => {
            console.warn(`[AMQP Client] Channel error: ${error.message}`);
            this.onerror?.(error);

            // Intelligent error detection for channel recovery (from JS analysis)
            if (error.message.includes('PRECONDITION_FAILED') || error.message.includes('delivery tag')) {
                this.scheduleChannelRecovery();
            }
        });

        ch.on('close', () => {
            console.log('[AMQP Client] Channel closed, attempting recovery...');
            this.scheduleChannelRecovery();
        });

        await this.setupBasicInfrastructure();
    }

    /**
     * Setup basic AMQP infrastructure
     */
    private async setupBasicInfrastructure(): Promise<void> {
        // Enhanced exchange and queue setup with enterprise-grade settings
        if (!this.channel) throw new Error('AMQP channel not established');
        await this.channel.assertExchange(this.options.exchangeName, 'topic', {
            durable: true
        });

        // Create exclusive response queue with enhanced configuration
        const responseQueueResult = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });
        this.responseQueue = responseQueueResult.queue;

        // Enhanced response queue consumer with error handling
        await this.channel.consume(this.responseQueue, (msg: ConsumeMessage | null) => {
            if (msg) {
                this.handleResponse(msg);
                this.safeAck(msg);
            }
        }, { noAck: false });

        // Subscribe to notifications with enhanced routing
        await this.subscribeToNotifications();
    }

    /**
     * CRITICAL: Advanced bidirectional channels setup (key discovery from JS analysis)
     */
    private async setupBidirectionalChannels(): Promise<void> {
        console.log('[AMQP Client] Setting up MCP bidirectional pub/sub channels...');

        // Create dedicated pub/sub channel for advanced routing
    if (!this.connection) throw new Error('AMQP connection not established');
    this.pubsubChannel = await this.connection.createChannel();

        // Create bidirectional routing exchange
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        const pub = this.pubsubChannel;
        await pub.assertExchange(exchangeName, 'topic', {
            durable: true,
            autoDelete: false
        });

        console.log('[AMQP Client] Bidirectional channels setup complete:', {
            exchange: exchangeName,
            sessionId: this.sessionId,
            streamId: this.streamId
        });
    }

    /**
     * Enhanced message type detection following JSON-RPC 2.0 spec exactly
     */
    private detectMessageType(message: JSONRPCMessage): 'request' | 'response' | 'notification' {
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

        throw new Error(`Cannot determine message type: ${JSON.stringify(message)}`);
    }

    /**
     * Enhanced request message handling with timeout and correlation
     */
    private async handleRequestMessage(envelope: AMQPMessage): Promise<void> {
        // Keep async signature for symmetry; no awaited operations needed here
        await Promise.resolve();
        if (!isJSONRPCRequest(envelope.message)) {
            throw new Error('Invalid request message format');
        }

        // Setup request timeout and correlation tracking
        this.setupRequestTimeout(envelope.correlationId!, envelope.message.id, envelope.message.method);

        // Set reply-to for bidirectional communication
        if (this.responseQueue) {
            envelope.replyTo = this.responseQueue;
        } else {
            throw new Error('Response queue not available');
        }

        // Publish to MCP bidirectional routing exchange (NEW system)
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        const routingKey = this.getMcpRoutingKey(envelope.message);
        const messageBuffer = Buffer.from(JSON.stringify(envelope));

        if (!this.channel) throw new Error('AMQP channel not established');
        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            correlationId: envelope.correlationId,
            replyTo: envelope.replyTo,
            persistent: false,
            timestamp: envelope.timestamp
        });
    }

    /**
     * Enhanced response message handling
     */
    private async handleResponseMessage(envelope: AMQPMessage): Promise<void> {
        // Keep async signature for symmetry; no awaited operations needed here
        await Promise.resolve();
        // For client transport, responses are typically handled by the response consumer
        // This method is for cases where client needs to send responses (less common)
        const messageBuffer = Buffer.from(JSON.stringify(envelope));

        if (!this.channel) throw new Error('AMQP channel not established');
        this.channel.publish(this.options.exchangeName, 'responses', messageBuffer, {
            persistent: false,
            timestamp: envelope.timestamp
        });
    }

    /**
     * Enhanced notification message handling
     */
    private async handleNotificationMessage(envelope: AMQPMessage): Promise<void> {
        // Keep async signature for symmetry; no awaited operations needed here
        await Promise.resolve();
        const routingKey = this.getNotificationRoutingKey(envelope.message);
        const messageBuffer = Buffer.from(JSON.stringify(envelope));

        // Publish notifications to the MCP routing exchange for consistency
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        if (!this.channel) throw new Error('AMQP channel not established');
        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            persistent: false,
            timestamp: envelope.timestamp
        });
    }

    /**
     * Handle incoming response messages with performance tracking
     */
    private handleResponse(msg: ConsumeMessage): void {
        try {
            const content = msg.content.toString();
            // Server sends direct JSON-RPC response (no envelope)
            const response = JSON.parse(content) as unknown as JSONRPCMessage;
            const rawCorrelationId = (msg.properties as unknown as { correlationId?: unknown }).correlationId;
            const correlationId: string | undefined = typeof rawCorrelationId === 'string' ? rawCorrelationId : undefined;

            if (typeof correlationId === 'string' && this.pendingRequests.has(correlationId)) {
                const pending = this.pendingRequests.get(correlationId)!;
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(correlationId);

                // Enhanced performance tracking
                if (pending.method && this.requestMetrics.has(correlationId)) {
                    const metrics = this.requestMetrics.get(correlationId)!;
                    const responseTime = Date.now() - metrics.startTime;
                    console.log(`[AMQP Client] Response time: ${responseTime}ms for ${metrics.method}`);
                    this.requestMetrics.delete(correlationId);
                }

                // Forward to MCP client
                this.onmessage?.(response);
            } else {
                // Not a response to a pending request, forward anyway
                this.onmessage?.(response);
            }
        } catch (error) {
            this.onerror?.(error as Error);
        }
    }

    /**
     * Enhanced notification subscription with intelligent routing
     */
    private async subscribeToNotifications(): Promise<void> {
        if (!this.channel) return;

        // Create a queue for notifications with enhanced configuration
        const notificationQueue = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });

        // Bind to MCP notification routing keys on bidirectional exchange
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        const patterns = [
            'mcp.notification.#',
            'mcp.event.#',
            'discovery.notification.#',
            'discovery.event.#'
        ];

        for (const pattern of patterns) {
            await this.channel.bindQueue(
                notificationQueue.queue,
                exchangeName,
                pattern
            );
        }

        // Enhanced notification consumer with error handling
        await this.channel.consume(notificationQueue.queue, (msg: ConsumeMessage | null) => {
            if (msg) {
                try {
                    const content = msg.content.toString();
                    const envelope = JSON.parse(content) as unknown as AMQPMessage;
                    this.onmessage?.(envelope.message);
                } catch (error) {
                    this.onerror?.(error as Error);
                }
                this.safeAck(msg);
            }
        }, { noAck: false });
    }

    /**
     * Enhanced request timeout setup with correlation tracking
     */
    private setupRequestTimeout(correlationId: string, _requestId: string | number, method?: string): void {
        const timeoutMs = this.options.responseTimeout!;

        const timeout = setTimeout(() => {
            if (this.pendingRequests.has(correlationId)) {
                const pending = this.pendingRequests.get(correlationId)!;
                this.pendingRequests.delete(correlationId);
                this.requestMetrics.delete(correlationId);
                pending.reject(new Error(`Request timeout after ${timeoutMs}ms for ${method || 'unknown'}`));
            }
        }, timeoutMs);

        // Store the enhanced pending request with full tracking
        this.pendingRequests.set(correlationId, {
            startTime: Date.now(),
            method: method || 'unknown',
            resolve: () => { }, // Will be overwritten when promise is created
            reject: () => { }, // Will be overwritten when promise is created
            timeout,
            correlationId
        });
    }

    /**
     * Enhanced safe message acknowledgment (from JS analysis)
     */
    private safeAck(msg: ConsumeMessage): void {
        if (this.channel) {
            try {
                this.channel.ack(msg);
            } catch (error) {
                console.warn(`[AMQP Client] Failed to ack message: ${(error as Error).message}`);
            }
        }
    }

    /**
     * Enhanced recovery and reconnection logic (from JS analysis)
     */
    private scheduleReconnect(): void {
        if (this.connectionState.reconnectAttempts >= (this.options.maxReconnectAttempts || 10)) {
            const error = new Error('Maximum reconnection attempts exceeded');
            this.onerror?.(error);
            return;
        }

        this.connectionState.reconnectAttempts++;
        const delay = this.options.reconnectDelay || 5000;

        setTimeout(() => {
            void this.connect()
                .then(() => this.setupBidirectionalChannels())
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

    /**
     * Advanced channel recovery (from JS analysis)
     */
    private scheduleChannelRecovery(): void {
        if (this.channelRecovering) return;

        this.channelRecovering = true;

        setTimeout(() => {
            void (async () => {
                try {
                    if (this.connection) {
                        // Recreate channel
                        this.channel = await this.connection.createChannel();

                        if (this.options.prefetchCount && this.channel) {
                            await this.channel.prefetch(this.options.prefetchCount);
                        }

                        // Re-setup infrastructure
                        await this.setupBasicInfrastructure();
                        console.log('[AMQP Client] Channel recovery completed successfully');
                    }
                } catch (error) {
                    console.error('[AMQP Client] Channel recovery failed:', error);
                    this.scheduleReconnect();
                } finally {
                    this.channelRecovering = false;
                }
            })();
        }, 1000);
    }

    /**
     * Get notification routing key based on method
     */
    private getNotificationRoutingKey(message: JSONRPCMessage): string {
        if ('method' in message && message.method) {
            const method = message.method.replace(/\//g, '.');
            return `notifications.${method}`;
        }
        return 'notifications.general';
    }

    // Legacy direct queue method removed in favor of bidirectional routing

    /**
     * Get MCP routing key for bidirectional message routing
     */
    private getMcpRoutingKey(message: JSONRPCMessage): string {
        if ('method' in message && message.method) {
            const toolCategory = this.getToolCategory(message.method);
            return `mcp.request.${toolCategory}.${message.method}`;
        }
        return 'mcp.request.general';
    }

    /**
     * Determine tool category for routing (client-side mirror)
     */
    private getToolCategory(method: string): string {
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
     * Generate unique correlation ID with session tracking
     */
    private generateCorrelationId(): string {
        return `${this.sessionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Dynamic AMQP library loading
     */
    private async loadAMQPLibrary(): Promise<typeof import('amqplib')> {
        try {
            return await import('amqplib');
        } catch (error) {
            throw new Error('amqplib package not found. Please install with: npm install amqplib');
        }
    }
}
