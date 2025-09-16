/**
 * Enhanced AMQP Server Transport for Model Context Protocol
 * 
 * This implementation provides enterprise-grade AMQP-based transport for MCP servers,
 * incorporating advanced patterns discovered from JavaScript implementation analysis:
 * - Sophisticated correlation handling for async message routing
 * - Bidirectional pub/sub channels for distributed messaging
 * - Advanced error recovery and resilience patterns
 * - Session-based routing with load balancing support
 * - Performance monitoring and timeout management
 * - Tool category-based intelligent routing
 */

import type { Transport, TransportSendOptions } from "./types.js";
import type { JSONRPCMessage, MessageExtraInfo } from "./types.js";
import type { AMQPServerTransportOptions, ConnectionState } from "./types.js";
import type { Channel, ConsumeMessage } from 'amqplib';

// Minimal connection interface to align with amqplib Promise API without version/type conflicts
interface AMQPConnection {
    createChannel(): Promise<Channel>;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: () => void): void;
    close(): Promise<void>;
}

// Enhanced request tracking interface (from JS analysis)
interface PendingRequest {
    startTime: number;
    method: string;
    correlationId?: string;
    replyTo?: string;
    deliveryTag?: number;
}

// Comprehensive routing information storage (key discovery from JS analysis)
interface RoutingInfo {
    correlationId: string;
    replyTo: string;
    exchangeName: string;
    routingKey: string;
    deliveryTag: number;
}

// Helper type guards (enhanced with strict MCP SDK compliance)
function isJSONRPCRequest(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number; method: string } {
    return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

function isJSONRPCNotification(msg: JSONRPCMessage): msg is JSONRPCMessage & { method: string } {
    return 'method' in msg && (!('id' in msg) || msg.id === undefined);
}

/**
 * Enterprise-grade AMQP Server Transport for Model Context Protocol
 */
export class AMQPServerTransport implements Transport {
    // Core AMQP infrastructure
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;
    private pubsubChannel: Channel | null = null; // for bidirectional routing
    private requestQueue: string | null = null;

    // Connection state management
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private channelRecovering = false;

    // Session management for distributed routing (key discovery from JS analysis)
    sessionId: string;
    private streamId: string;
    private requestChannelId: string;
    private responseChannelId: string;

    // Advanced correlation and routing management (core enterprise patterns)
    private pendingRequests = new Map<string | number, PendingRequest>();
    private routingInfoStore = new Map<string | number, RoutingInfo>();

    // Protocol version support (required by MCP SDK)
    private _protocolVersion?: string;

    // Transport interface callbacks (MCP SDK requirements)
    onclose?: () => void;
    onerror?: (error: Error) => void;
    private _onmessageInner: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined;
    private _onmessageUser: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined;

    // Getter and setter add a debug wrapper to track pending requests
    get onmessage(): (message: JSONRPCMessage, extra?: MessageExtraInfo) => void {
        // Return the original user handler to preserve identity in tests
        return this._onmessageUser ?? (() => { /* no-op until set by SDK */ });
    }

    set onmessage(handler: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void) {
        if (typeof handler === 'function') {
            this._onmessageUser = handler;
            this._onmessageInner = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
                try {
                    // Track this request for timing analysis (avoid duplicate if already tracked)
                    const hasId = 'id' in message && message.id !== undefined && message.id !== null;
                    const id = (message as { id?: string | number }).id;
                    const method = (message as { method?: string }).method ?? 'unknown';

                    if (hasId && id !== undefined && !this.pendingRequests.has(id)) {
                        this.pendingRequests.set(id, {
                            startTime: Date.now(),
                            method
                        });

                        // Log a warning if no response within 10 seconds
                        setTimeout(() => {
                            if (id !== undefined && this.pendingRequests.has(id)) {
                                const req = this.pendingRequests.get(id)!;
                                console.warn('[AMQP Server] No response sent for request within 10 seconds:', {
                                    messageId: id,
                                    method: req.method,
                                    elapsedMs: Date.now() - req.startTime
                                });
                            }
                        }, 10000);
                    }

                    const h = this._onmessageUser;
                    if (h) return h(message, extra);
                } catch (error) {
                    console.error('[AMQP Server] SDK onmessage handler threw error:', error);
                    throw error;
                }
            };
        } else {
            // If cleared, set to a no-op to maintain contract
            this._onmessageUser = undefined;
            this._onmessageInner = () => { /* no-op */ };
        }
    }

    constructor(private options: AMQPServerTransportOptions) {
        this.validateOptions();

        // Set enterprise-grade defaults with backward compatibility
        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            prefetchCount: 1, // Process one request at a time for reliability
            messageTTL: 60000, // 1 minute
            queueTTL: 300000, // 5 minutes
            ...options
        };

        // Generate unique session identifiers for distributed routing
        this.sessionId = `amqp-server-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.requestChannelId = `req.${this.sessionId}`;
        this.responseChannelId = `resp.${this.sessionId}`;

        this.requestQueue = `${this.options.queuePrefix}.requests`;
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
     * Start the enhanced transport with bidirectional channels
     */
    async start(): Promise<void> {
        // Idempotent start: skip if already connected (SDK may call start() multiple times)
        if (this.connectionState.connected) {
            console.log('[AMQP Server] Transport already started, skipping start()');
            return;
        }
        try {
            await this.connect();
            // Setup both basic infrastructure AND advanced bidirectional channels
            await this.setupBidirectionalChannels();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;

            console.log('[AMQP Server] Enhanced transport started with enterprise routing:', {
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

        // Enhanced message type detection and performance tracking
        const messageType = this.detectMessageType(message);

        // Track response timing for performance monitoring (from JS analysis)
        if ('id' in message && message.id && this.pendingRequests.has(message.id)) {
            const req = this.pendingRequests.get(message.id)!;
            const responseTime = Date.now() - req.startTime;
            console.log(`[AMQP Server] Response time: ${responseTime}ms for ${req.method}`);
            this.pendingRequests.delete(message.id);
        }

        // Enhanced message routing based on type
        switch (messageType) {
            case 'response':
                this.handleResponseMessage(message);
                break;
            case 'request':
                this.handleRequestMessage(message);
                break;
            case 'notification':
                this.handleNotificationMessage(message);
                break;
            default:
        throw new Error(`Unknown message type for message: ${JSON.stringify(message)}`);
        }
    // maintain async contract without changing behavior
    await Promise.resolve();
    }

    /**
     * Enhanced cleanup with bidirectional channels
     */
    async close(): Promise<void> {
        this.connectionState.connected = false;

        // Clear pending requests with proper cleanup
        for (const [id, request] of this.pendingRequests) {
            console.warn(`[AMQP Server] Clearing pending request: ${id} (${request.method})`);
        }
        this.pendingRequests.clear();
        this.routingInfoStore.clear();

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
            console.warn(`[AMQP Server] Error during cleanup: ${(error as Error).message}`);
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
        const amqp = await this.loadAMQPLibrary();

        this.connection = await amqp.connect(this.options.amqpUrl) as unknown as AMQPConnection;

        // Enhanced connection error handling with automatic recovery
    const conn = this.connection;
    if (!conn) throw new Error('AMQP connection not established');
        conn.on('error', (error: Error) => {
            this.connectionState.connected = false;
            this.connectionState.lastError = error;
            this.onerror?.(error);
            this.scheduleReconnect();
        });

        conn.on('close', () => {
            this.connectionState.connected = false;
            console.log('[AMQP Server] Connection closed, scheduling reconnect...');
            this.scheduleReconnect();
        });

        // Create main channel with enhanced error handling
    this.channel = await conn.createChannel();

        // Enterprise-grade prefetch control for performance
        if (this.options.prefetchCount && this.channel) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        // Advanced channel error handling with recovery
    const chMain = this.channel;
    if (!chMain) throw new Error('AMQP channel not established');
    chMain.on('error', (error: Error) => {
            console.warn(`[AMQP Server] Channel error: ${error.message}`);
            this.onerror?.(error);

            // Intelligent error detection for channel recovery (from JS analysis)
            if (error.message.includes('PRECONDITION_FAILED') || error.message.includes('delivery tag')) {
                this.scheduleChannelRecovery();
            }
        });

        chMain.on('close', () => {
            console.log('[AMQP Server] Channel closed, attempting recovery...');
            this.scheduleChannelRecovery();
        });

    await this.setupBasicInfrastructure();
    }

    /**
     * Setup basic AMQP infrastructure
     */
    private async setupBasicInfrastructure(): Promise<void> {
        // Enhanced exchange and queue setup with enterprise-grade settings
    const channel = this.channel;
    if (!channel) throw new Error('AMQP channel not established');
    await channel.assertExchange(this.options.exchangeName, 'topic', {
            durable: true
        });

        this.requestQueue = `${this.options.queuePrefix}.requests`;
    await channel.assertQueue(this.requestQueue, {
            durable: true,
            arguments: this.getQueueArguments()
        });

        // Enhanced consumer setup with error handling
    await channel.consume(this.requestQueue, (msg: ConsumeMessage | null) => {
            if (msg) {
                this.handleIncomingRequest(msg);
            }
        }, { noAck: false });
    }

    /**
     * CRITICAL: Advanced bidirectional channels setup (key discovery from JS analysis)
     */
    private async setupBidirectionalChannels(): Promise<void> {
        console.log('[AMQP Server] Setting up MCP bidirectional pub/sub channels...');

        // Create dedicated pub/sub channel for advanced routing
        if (!this.connection) {
            throw new Error('Connection not established');
        }
        this.pubsubChannel = await this.connection.createChannel();

        // Create bidirectional routing exchange
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
    const pub = this.pubsubChannel;
    if (!pub) throw new Error('AMQP pubsub channel not established');
        await pub.assertExchange(exchangeName, 'topic', {
            durable: true,
            autoDelete: false
        });

        // Create session-specific request queue for distributed load balancing
        const requestQueueName = `${this.options.queuePrefix}.requests.${this.sessionId}`;
        const requestQueue = await pub.assertQueue(requestQueueName, {
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });

        // Advanced binding patterns for MCP request routing (from JS analysis)
        const patterns = [
            this.requestChannelId,
            `${this.sessionId}.*`,
            'mcp.request.#',
            'mcp.tools.#',
            'mcp.resources.#',
            'mcp.prompts.#'
        ];

        for (const pattern of patterns) {
            await pub.bindQueue(requestQueue.queue, exchangeName, pattern);
        }

        // Setup advanced bidirectional request consumer
        await pub.consume(requestQueue.queue, (msg: ConsumeMessage | null) => {
            if (msg) {
                try {
                    this.handleBidirectionalRequest(msg, exchangeName);
                } catch (error) {
                    console.error('[AMQP Server] Error in bidirectional request:', error);
                    pub.nack(msg, false, false);
                }
            }
        }, { noAck: false });

        // Register session for distributed routing
        void this.registerSessionOwnership(exchangeName);

        console.log('[AMQP Server] Bidirectional channels setup complete:', {
            exchange: exchangeName,
            requestQueue: requestQueue.queue,
            sessionId: this.sessionId,
            streamId: this.streamId
        });
    }

    /**
     * CRITICAL: Advanced bidirectional request handling (key discovery from JS analysis)
     */
    private handleBidirectionalRequest(msg: ConsumeMessage, exchangeName: string): void {
        const correlationId = typeof msg.properties.correlationId === 'string' ? msg.properties.correlationId : undefined;
        const replyTo = typeof msg.properties.replyTo === 'string' ? msg.properties.replyTo : undefined;
        const routingKey = msg.fields.routingKey;

        let content: unknown;
        try {
            content = JSON.parse(msg.content.toString());
        } catch (error) {
            console.error('[AMQP Server] Invalid JSON in request:', error);
            if (this.pubsubChannel) {
                this.pubsubChannel.nack(msg, false, false);
            }
            return;
        }

        // Extract JSON-RPC message (handle both envelope and direct formats - key discovery)
        let jsonRpcMessage: JSONRPCMessage;
        const obj = content as Record<string, unknown>;
        if (obj && typeof obj === 'object' && obj.message && typeof obj.message === 'object') {
            jsonRpcMessage = obj.message as JSONRPCMessage;
        } else if ('id' in obj || 'method' in obj) {
            jsonRpcMessage = obj as unknown as JSONRPCMessage;
        } else {
            console.error('[AMQP Server] Invalid message format');
            if (this.pubsubChannel) {
                this.pubsubChannel.nack(msg, false, false);
            }
            return;
        }

        // Ensure proper JSON-RPC format
        if (!('jsonrpc' in jsonRpcMessage) || !jsonRpcMessage.jsonrpc) {
            const base = jsonRpcMessage as unknown as Record<string, unknown>;
            jsonRpcMessage = { ...base, jsonrpc: '2.0' } as JSONRPCMessage;
        }

        // CRITICAL: Store routing information for response correlation
        if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined) {
            if (correlationId && replyTo) {
                this.storeRoutingInfo(jsonRpcMessage.id, {
                    correlationId,
                    replyTo,
                    exchangeName,
                    routingKey,
                    deliveryTag: msg.fields.deliveryTag
                });
            }

            // Track request for performance monitoring
            if (isJSONRPCRequest(jsonRpcMessage)) {
                const pending: PendingRequest = {
                    startTime: Date.now(),
                    method: jsonRpcMessage.method
                };
                if (correlationId) pending.correlationId = correlationId;
                if (replyTo) pending.replyTo = replyTo;
                this.pendingRequests.set(jsonRpcMessage.id, pending);
            }
        }

    // Forward to MCP SDK - it will call send() with the response
    const handler = this._onmessageInner ?? this.onmessage;
    handler?.(jsonRpcMessage);

        // Acknowledge receipt
    if (this.pubsubChannel) {
        this.pubsubChannel.ack(msg);
    }
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
     * CRITICAL: Enhanced response message handling (key discovery from JS analysis)
     */
    private handleResponseMessage(message: JSONRPCMessage): void {
        if (!('id' in message) || message.id === undefined) {
            throw new Error('Response message must have an id');
        }

        // Retrieve routing information for correlation
        const routingInfo = this.retrieveRoutingInfo(message.id);
        if (!routingInfo) {
            throw new Error(`No routing info found for response: ${message.id}`);
        }

        const { correlationId, replyTo } = routingInfo;

        // Send response directly to client's reply queue using bidirectional channel
        if (replyTo && this.pubsubChannel) {
            const messageBuffer = Buffer.from(JSON.stringify(message));

            this.pubsubChannel.sendToQueue(replyTo, messageBuffer, {
                correlationId,
                persistent: false
            });

            console.log('[AMQP Server] ✅ Response sent to client queue:', replyTo);
        } else {
            throw new Error('No replyTo queue for response routing');
        }
    }

    /**
     * Enhanced request message handling with tool category routing
     */
    private handleRequestMessage(message: JSONRPCMessage): void {
        if (!isJSONRPCRequest(message)) {
            throw new Error('Invalid request message format');
        }

        // Enhanced routing with tool category detection (from JS analysis)
        const routingKey = `mcp.request.${this.getToolCategory(message.method)}`;
        const messageBuffer = Buffer.from(JSON.stringify(message));

        // Publish to the MCP routing exchange to reach all interested consumers
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        if (!this.channel) throw new Error('AMQP channel not established');
        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            persistent: true,
            timestamp: Date.now(),
            correlationId: message.id?.toString()
        });
    }

    /**
     * Enhanced notification message handling
     */
    private handleNotificationMessage(message: JSONRPCMessage): void {
        if (!isJSONRPCNotification(message)) {
            throw new Error('Invalid notification message format');
        }

        const routingKey = this.getNotificationRoutingKey(message);
        const messageBuffer = Buffer.from(JSON.stringify(message));

        // Publish notifications via the MCP routing exchange for consistency
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        if (!this.channel) throw new Error('AMQP channel not established');
        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            persistent: false,
            timestamp: Date.now()
        });
    }

    /**
     * Handle incoming requests from basic infrastructure
     */
    private handleIncomingRequest(msg: ConsumeMessage): void {
        try {
            const content = JSON.parse(msg.content.toString()) as unknown;

            // Extract JSON-RPC message (handle both envelope and direct formats)
            let jsonRpcMessage: JSONRPCMessage;
            const obj = content as Record<string, unknown>;
            if (obj && typeof obj === 'object' && obj.message && typeof obj.message === 'object') {
                jsonRpcMessage = obj.message as JSONRPCMessage;
            } else if ('id' in obj || 'method' in obj) {
                jsonRpcMessage = obj as unknown as JSONRPCMessage;
            } else {
                throw new Error('Invalid message format');
            }

            // Store routing metadata for response correlation
            if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined) {
                const corr = typeof msg.properties.correlationId === 'string' ? msg.properties.correlationId : undefined;
                const rto = typeof msg.properties.replyTo === 'string' ? msg.properties.replyTo : undefined;
                if (corr && rto) {
                    this.storeRoutingInfo(jsonRpcMessage.id, {
                        correlationId: corr,
                        replyTo: rto,
                        exchangeName: this.options.exchangeName,
                        routingKey: msg.fields.routingKey,
                        deliveryTag: msg.fields.deliveryTag
                    });
                }

                if (isJSONRPCRequest(jsonRpcMessage)) {
                    const pending: PendingRequest = {
                        startTime: Date.now(),
                        method: jsonRpcMessage.method
                    };
                    if (corr) pending.correlationId = corr;
                    if (rto) pending.replyTo = rto;
                    this.pendingRequests.set(jsonRpcMessage.id, pending);
                }
            }

            // Forward to MCP SDK
            const handler = this._onmessageInner ?? this.onmessage;
            handler?.(jsonRpcMessage);

            // Safe acknowledgment
            this.safeAck(msg);

        } catch (error) {
            console.error('[AMQP Server] Error handling request:', error);
            this.onerror?.(error as Error);
            this.safeNack(msg);
        }
    }

    /**
     * CRITICAL: Routing information management (key discovery from JS analysis)
     */
    private storeRoutingInfo(messageId: string | number, info: RoutingInfo): void {
        this.routingInfoStore.set(messageId, info);
        console.log('[AMQP Server] Stored routing info for message ID:', messageId);
    }

    private retrieveRoutingInfo(messageId: string | number): RoutingInfo | undefined {
        const info = this.routingInfoStore.get(messageId);
        if (info) {
            this.routingInfoStore.delete(messageId);
            console.log('[AMQP Server] Retrieved routing info for message ID:', messageId);
        }
        return info;
    }

    /**
     * Enhanced tool category detection for intelligent routing (from JS analysis)
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

    private getNotificationRoutingKey(message: JSONRPCMessage): string {
        if ('method' in message && message.method) {
            const method = message.method;
            const category = this.getToolCategory(method);
            return `mcp.notification.${category}`;
        }
        return 'mcp.notification.general';
    }

    private getQueueArguments(): Record<string, number> {
        const args: Record<string, number> = {};

        if (this.options.messageTTL) {
            args['x-message-ttl'] = this.options.messageTTL;
        }

        if (this.options.queueTTL) {
            args['x-expires'] = this.options.queueTTL;
        }

        return args;
    }

    /**
     * Enhanced safe message acknowledgment (from JS analysis)
     */
    private safeAck(msg: ConsumeMessage): void {
        if (this.channel) {
            try {
                this.channel.ack(msg);
            } catch (error) {
                console.warn(`[AMQP Server] Failed to ack message: ${(error as Error).message}`);
            }
        }
    }

    private safeNack(msg: ConsumeMessage): void {
        if (this.channel) {
            try {
                this.channel.nack(msg, false, false);
            } catch (error) {
                console.warn(`[AMQP Server] Failed to nack message: ${(error as Error).message}`);
            }
        }
    }

    /**
     * Session ownership registration for distributed routing (from JS analysis)
     */
    private registerSessionOwnership(exchangeName: string): void {
        const ownershipMessage = {
            type: 'session_ownership',
            sessionId: this.sessionId,
            streamId: this.streamId,
            nodeId: process.env.NODE_ID || 'default',
            timestamp: Date.now(),
            ownership: 'local'
        };

        const routingKey = `mcp.session.ownership.${this.sessionId}`;

        if (this.pubsubChannel) {
            this.pubsubChannel.publish(
                exchangeName,
                routingKey,
                Buffer.from(JSON.stringify(ownershipMessage)),
                {
                    persistent: false,
                    timestamp: Date.now()
                }
            );

            console.log('[AMQP Server] Session ownership registered:', {
                sessionId: this.sessionId,
                routingKey,
                exchange: exchangeName
            });
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
                    console.log('[AMQP Server] Reconnection successful');
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
                        console.log('[AMQP Server] Channel recovery completed successfully');
                    }
                } catch (error) {
                    console.error('[AMQP Server] Channel recovery failed:', error);
                    this.scheduleReconnect();
                } finally {
                    this.channelRecovering = false;
                }
            })();
        }, 1000);
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
