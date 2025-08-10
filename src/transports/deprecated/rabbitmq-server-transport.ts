import {
    RabbitMQServerTransportOptions,
    RabbitMQMessage,
    ConnectionState,
    JSONRPCMessage,
    Transport
} from "./types.js";

/**
 * RabbitMQ server transport implementation for MCP
 * 
 * This implementation allows MCP servers to receive requests and send responses
 * through RabbitMQ queues, enabling distributed server architectures.
 */
export class RabbitMQServerTransport implements Transport {
    private connection?: any; // Will be amqplib.Connection
    private channel?: any; // Will be amqplib.Channel
    private requestQueue?: string;
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };

    // Transport interface callbacks
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(private options: RabbitMQServerTransportOptions) {
        // Set default values
        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            prefetchCount: 1, // Process one request at a time by default
            ...options
        };

        this.requestQueue = `${this.options.queuePrefix}.requests`;
    }

    /**
     * Start the transport connection
     */
    async start(): Promise<void> {
        try {
            await this.connect();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;
        } catch (error) {
            this.connectionState.lastError = error as Error;
            this.onerror?.(error as Error);
            throw error;
        }
    }

    /**
     * Send a message through the transport (responses and notifications)
     */
    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.channel) {
            throw new Error("Transport not connected");
        }

        const envelope: RabbitMQMessage = {
            message,
            timestamp: Date.now(),
            type: this.getMessageType(message)
        };

        // Handle different message types
        if (envelope.type === 'response') {
            await this.sendResponse(envelope);
        } else if (envelope.type === 'notification') {
            await this.sendNotification(envelope);
        } else {
            throw new Error(`Unexpected message type from server: ${envelope.type}`);
        }
    }

    /**
     * Close the transport connection
     */
    async close(): Promise<void> {
        this.connectionState.connected = false;

        try {
            if (this.channel) {
                await this.channel.close();
                this.channel = undefined;
            }

            if (this.connection) {
                await this.connection.close();
                this.connection = undefined;
            }
        } catch (error) {
            // Ignore errors during cleanup
        }

        this.onclose?.();
    }

    /**
     * Establish connection to RabbitMQ
     */
    private async connect(): Promise<void> {
        // Dynamic import to avoid compile-time dependency
        const amqp = await import('amqplib');

        // Create connection
        this.connection = await amqp.connect(this.options.amqpUrl);

        // Set up connection error handling
        this.connection.on('error', (error: Error) => {
            this.connectionState.connected = false;
            this.connectionState.lastError = error;
            this.onerror?.(error);
            this.scheduleReconnect();
        });

        this.connection.on('close', () => {
            this.connectionState.connected = false;
            this.scheduleReconnect();
        });

        // Create channel
        this.channel = await this.connection.createChannel();

        if (this.options.prefetchCount) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        // Set up channel error handling
        this.channel.on('error', (error: Error) => {
            this.onerror?.(error);
        });

        // Create exchange for notifications
        await this.channel.assertExchange(this.options.exchangeName, 'topic', {
            durable: true
        });

        // Create request queue
        await this.channel.assertQueue(this.requestQueue!, {
            durable: true,
            arguments: this.getQueueArguments()
        });

        // Set up request queue consumer
        await this.channel.consume(this.requestQueue!, (msg: any) => {
            if (msg) {
                this.handleRequest(msg);
            }
        }, { noAck: false });
    }

    /**
     * Handle incoming request messages
     */
    private handleRequest(msg: any): void {
        try {
            const envelope: RabbitMQMessage = JSON.parse(msg.content.toString());

            // Store correlation ID and reply-to for response routing
            if (envelope.message && typeof envelope.message === 'object') {
                (envelope.message as any)._rabbitMQCorrelationId = msg.properties.correlationId;
                (envelope.message as any)._rabbitMQReplyTo = msg.properties.replyTo;
            }

            this.onmessage?.(envelope.message);
            this.channel?.ack(msg);
        } catch (error) {
            this.onerror?.(error as Error);
            this.channel?.nack(msg, false, false); // Reject and don't requeue
        }
    }

    /**
     * Send response back to client
     */
    private async sendResponse(envelope: RabbitMQMessage): Promise<void> {
        if (!this.channel) return;

        // Extract routing information from the original request
        const correlationId = (envelope.message as any)?._rabbitMQCorrelationId;
        const replyTo = (envelope.message as any)?._rabbitMQReplyTo;

        if (!correlationId || !replyTo) {
            this.onerror?.(new Error("Cannot send response: missing correlation ID or reply-to queue"));
            return;
        }

        // Clean up the routing metadata
        delete (envelope.message as any)._rabbitMQCorrelationId;
        delete (envelope.message as any)._rabbitMQReplyTo;

        const messageBuffer = this.createBuffer(JSON.stringify(envelope));

        await this.channel.sendToQueue(replyTo, messageBuffer, {
            correlationId,
            persistent: false // Responses don't need to be persistent
        });
    }

    /**
     * Send notification to exchange
     */
    private async sendNotification(envelope: RabbitMQMessage): Promise<void> {
        if (!this.channel) return;

        const messageBuffer = this.createBuffer(JSON.stringify(envelope));
        const routingKey = this.getNotificationRoutingKey(envelope.message);

        await this.channel.publish(
            this.options.exchangeName,
            routingKey,
            messageBuffer,
            { persistent: true }
        );
    }

    /**
     * Schedule reconnection attempt
     */
    private scheduleReconnect(): void {
        if (this.connectionState.reconnectAttempts >= (this.options.maxReconnectAttempts ?? 10)) {
            this.onerror?.(new Error("Maximum reconnection attempts exceeded"));
            return;
        }

        this.connectionState.reconnectAttempts++;

        setTimeout(async () => {
            try {
                await this.connect();
                this.connectionState.connected = true;
                this.connectionState.reconnectAttempts = 0;
            } catch (error) {
                this.connectionState.lastError = error as Error;
                this.scheduleReconnect();
            }
        }, this.options.reconnectDelay);
    }

    /**
     * Determine message type from JSON-RPC message
     */
    private getMessageType(message: JSONRPCMessage): 'request' | 'response' | 'notification' {
        if ('method' in message && 'id' in message) {
            return 'request';
        } else if ('result' in message || 'error' in message) {
            return 'response';
        } else {
            return 'notification';
        }
    }

    /**
     * Get queue arguments for request queue
     */
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
     * Get routing key for notifications
     */
    private getNotificationRoutingKey(message: JSONRPCMessage): string {
        // Extract method name for routing
        if ('method' in message && message.method) {
            // Convert method name to routing key format
            // e.g., "notifications/tools/list_changed" -> "notifications.tools.list_changed"
            return message.method.replace(/\//g, '.');
        }

        return 'notifications.general';
    }

    /**
     * Convert string to Buffer (Node.js compatible)
     */
    private createBuffer(str: string): Buffer {
        return Buffer.from(str);
    }
}
