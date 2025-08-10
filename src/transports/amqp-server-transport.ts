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
    private connection?: any; // amqplib.Connection
    private channel?: any; // amqplib.Channel
    private pubsubChannel?: any; // amqplib.Channel for bidirectional routing
    private requestQueue?: string;

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
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

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
                await this.handleResponseMessage(message);
                break;
            case 'request':
                await this.handleRequestMessage(message);
                break;
            case 'notification':
                await this.handleNotificationMessage(message);
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

        this.connection = await amqp.connect(this.options.amqpUrl);

        // Enhanced connection error handling with automatic recovery
        this.connection.on('error', (error: Error) => {
            this.connectionState.connected = false;
            this.connectionState.lastError = error;
            this.onerror?.(error);
            this.scheduleReconnect();
        });

        this.connection.on('close', () => {
            this.connectionState.connected = false;
            console.log('[AMQP Server] Connection closed, scheduling reconnect...');
            this.scheduleReconnect();
        });

        // Create main channel with enhanced error handling
        this.channel = await this.connection.createChannel();

        // Enterprise-grade prefetch control for performance
        if (this.options.prefetchCount) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        // Advanced channel error handling with recovery
        this.channel.on('error', (error: Error) => {
            console.warn(`[AMQP Server] Channel error: ${error.message}`);
            this.onerror?.(error);

            // Intelligent error detection for channel recovery (from JS analysis)
            if (error.message.includes('PRECONDITION_FAILED') || error.message.includes('delivery tag')) {
                this.scheduleChannelRecovery();
            }
        });

        this.channel.on('close', () => {
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
        await this.channel.assertExchange(this.options.exchangeName, 'topic', {
            durable: true
        });

        this.requestQueue = `${this.options.queuePrefix}.requests`;
        await this.channel.assertQueue(this.requestQueue, {
            durable: true,
            arguments: this.getQueueArguments()
        });

        // Enhanced consumer setup with error handling
        await this.channel.consume(this.requestQueue, (msg: any) => {
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
        this.pubsubChannel = await this.connection.createChannel();

        // Create bidirectional routing exchange
        const exchangeName = `${this.options.exchangeName}.mcp.routing`;
        await this.pubsubChannel.assertExchange(exchangeName, 'topic', {
            durable: true,
            autoDelete: false
        });

        // Create session-specific request queue for distributed load balancing
        const requestQueueName = `${this.options.queuePrefix}.requests.${this.sessionId}`;
        const requestQueue = await this.pubsubChannel.assertQueue(requestQueueName, {
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
            await this.pubsubChannel.bindQueue(requestQueue.queue, exchangeName, pattern);
        }

        // Setup advanced bidirectional request consumer
        await this.pubsubChannel.consume(requestQueue.queue, async (msg: any) => {
            if (msg) {
                try {
                    await this.handleBidirectionalRequest(msg, exchangeName);
                } catch (error) {
                    console.error('[AMQP Server] Error in bidirectional request:', error);
                    this.pubsubChannel.nack(msg, false, false);
                }
            }
        }, { noAck: false });

        // Register session for distributed routing
        await this.registerSessionOwnership(exchangeName);

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
    private async handleBidirectionalRequest(msg: any, exchangeName: string): Promise<void> {
        const correlationId = msg.properties.correlationId;
        const replyTo = msg.properties.replyTo;
        const routingKey = msg.fields.routingKey;

        let content: any;
        try {
            content = JSON.parse(msg.content.toString());
        } catch (error) {
            console.error('[AMQP Server] Invalid JSON in request:', error);
            this.pubsubChannel.nack(msg, false, false);
            return;
        }

        // Extract JSON-RPC message (handle both envelope and direct formats - key discovery)
        let jsonRpcMessage: JSONRPCMessage;
        if (content.message && typeof content.message === 'object') {
            jsonRpcMessage = content.message;
        } else if (content.id !== undefined || content.method !== undefined) {
            jsonRpcMessage = content;
        } else {
            console.error('[AMQP Server] Invalid message format');
            this.pubsubChannel.nack(msg, false, false);
            return;
        }

        // Ensure proper JSON-RPC format
        if (!jsonRpcMessage.jsonrpc) {
            (jsonRpcMessage as any).jsonrpc = '2.0';
        }

        // CRITICAL: Store routing information for response correlation
        if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined) {
            this.storeRoutingInfo(jsonRpcMessage.id, {
                correlationId,
                replyTo,
                exchangeName,
                routingKey,
                deliveryTag: msg.fields.deliveryTag
            });

            // Track request for performance monitoring
            if (isJSONRPCRequest(jsonRpcMessage)) {
                this.pendingRequests.set(jsonRpcMessage.id, {
                    startTime: Date.now(),
                    method: jsonRpcMessage.method,
                    correlationId,
                    replyTo
                });
            }
        }

        // Forward to MCP SDK - it will call send() with the response
        this.onmessage?.(jsonRpcMessage, {
            replyTo,
            routingKey,
            sessionId: this.sessionId,
            streamId: this.streamId
        } as any);

        // Acknowledge receipt
        this.pubsubChannel.ack(msg);
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
    private async handleResponseMessage(message: JSONRPCMessage): Promise<void> {
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

            await this.pubsubChannel.sendToQueue(replyTo, messageBuffer, {
                correlationId,
                persistent: false
            });

            console.log('[AMQP Server] Response sent to client queue:', replyTo);
        } else {
            throw new Error('No replyTo queue for response routing');
        }
    }

    /**
     * Enhanced request message handling with tool category routing
     */
    private async handleRequestMessage(message: JSONRPCMessage): Promise<void> {
        if (!isJSONRPCRequest(message)) {
            throw new Error('Invalid request message format');
        }

        // Enhanced routing with tool category detection (from JS analysis)
        const routingKey = `mcp.request.${this.getToolCategory(message.method)}`;
        const messageBuffer = Buffer.from(JSON.stringify(message));

        await this.channel.publish(this.options.exchangeName, routingKey, messageBuffer, {
            persistent: true,
            timestamp: Date.now(),
            correlationId: message.id?.toString()
        });
    }

    /**
     * Enhanced notification message handling
     */
    private async handleNotificationMessage(message: JSONRPCMessage): Promise<void> {
        if (!isJSONRPCNotification(message)) {
            throw new Error('Invalid notification message format');
        }

        const routingKey = this.getNotificationRoutingKey(message);
        const messageBuffer = Buffer.from(JSON.stringify(message));

        await this.channel.publish(this.options.exchangeName, routingKey, messageBuffer, {
            persistent: false,
            timestamp: Date.now()
        });
    }

    /**
     * Handle incoming requests from basic infrastructure
     */
    private async handleIncomingRequest(msg: any): Promise<void> {
        try {
            const content = JSON.parse(msg.content.toString());

            // Extract JSON-RPC message (handle both envelope and direct formats)
            let jsonRpcMessage: JSONRPCMessage;
            if (content.message && typeof content.message === 'object') {
                jsonRpcMessage = content.message;
            } else if (content.id !== undefined || content.method !== undefined) {
                jsonRpcMessage = content;
            } else {
                throw new Error('Invalid message format');
            }

            // Store routing metadata for response correlation
            if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined) {
                this.storeRoutingInfo(jsonRpcMessage.id, {
                    correlationId: msg.properties.correlationId,
                    replyTo: msg.properties.replyTo,
                    exchangeName: this.options.exchangeName,
                    routingKey: msg.fields.routingKey,
                    deliveryTag: msg.fields.deliveryTag
                });

                if (isJSONRPCRequest(jsonRpcMessage)) {
                    this.pendingRequests.set(jsonRpcMessage.id, {
                        startTime: Date.now(),
                        method: jsonRpcMessage.method,
                        correlationId: msg.properties.correlationId,
                        replyTo: msg.properties.replyTo
                    });
                }
            }

            // Forward to MCP SDK
            this.onmessage?.(jsonRpcMessage);

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

    private getQueueArguments(): Record<string, any> {
        const args: Record<string, any> = {};

        if (this.options.queueTTL) {
            args['x-message-ttl'] = this.options.queueTTL;
        }

        if (this.options.messageTTL) {
            args['x-expires'] = this.options.messageTTL;
        }

        return args;
    }

    /**
     * Enhanced safe message acknowledgment (from JS analysis)
     */
    private safeAck(msg: any): void {
        if (this.channel && !this.channel.closing) {
            try {
                this.channel.ack(msg);
            } catch (error) {
                console.warn(`[AMQP Server] Failed to ack message: ${(error as Error).message}`);
            }
        }
    }

    private safeNack(msg: any): void {
        if (this.channel && !this.channel.closing) {
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
    private async registerSessionOwnership(exchangeName: string): Promise<void> {
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
            await this.pubsubChannel.publish(
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

        setTimeout(async () => {
            try {
                await this.connect();
                await this.setupBidirectionalChannels();
                this.connectionState.connected = true;
                this.connectionState.reconnectAttempts = 0;
                console.log('[AMQP Server] Reconnection successful');
            } catch (error) {
                this.connectionState.lastError = error as Error;
                this.scheduleReconnect();
            }
        }, delay);
    }

    /**
     * Advanced channel recovery (from JS analysis)
     */
    private scheduleChannelRecovery(): void {
        if (this.channelRecovering) return;

        this.channelRecovering = true;

        setTimeout(async () => {
            try {
                if (this.connection && !this.connection.closing) {
                    // Recreate channel
                    this.channel = await this.connection.createChannel();

                    if (this.options.prefetchCount) {
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
        }, 1000);
    }

    /**
     * Dynamic AMQP library loading
     */
    private async loadAMQPLibrary(): Promise<any> {
        try {
            return await import('amqplib');
        } catch (error) {
            throw new Error('amqplib package not found. Please install with: npm install amqplib');
        }
    }
}
