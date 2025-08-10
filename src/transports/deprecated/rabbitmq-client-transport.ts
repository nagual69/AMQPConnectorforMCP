import {
    RabbitMQClientTransportOptions,
    RabbitMQMessage,
    ConnectionState,
    JSONRPCMessage,
    Transport
} from "./types.js";

/**
 * RabbitMQ client transport implementation for MCP
 * 
 * This implementation uses RabbitMQ to enable distributed MCP communication.
 * It handles request/response patterns as well as notifications through AMQP.
 */
export class RabbitMQClientTransport implements Transport {
    private connection?: any; // Will be amqplib.Connection
    private channel?: any; // Will be amqplib.Channel
    private responseQueue?: string;
    private pendingRequests = new Map<string, (response: JSONRPCMessage) => void>();
    private connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };

    // Transport interface callbacks
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(private options: RabbitMQClientTransportOptions) {
        // Set default values
        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            responseTimeout: 30000,
            prefetchCount: 10,
            ...options
        };
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
     * Send a message through the transport
     */
    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.channel) {
            throw new Error("Transport not connected");
        }

        const envelope: RabbitMQMessage = {
            message,
            timestamp: Date.now(),
            type: this.getMessageType(message),
            correlationId: this.generateCorrelationId()
        };

        // Only set replyTo if we have a response queue
        if (this.responseQueue) {
            envelope.replyTo = this.responseQueue;
        }

        // For requests, set up response handling
        if (envelope.type === 'request' && envelope.correlationId) {
            this.setupRequestTimeout(envelope.correlationId);
        }

        const queueName = this.getTargetQueueName(message);
        const messageBuffer = this.createBuffer(JSON.stringify(envelope));

        await this.channel.sendToQueue(queueName, messageBuffer, {
            correlationId: envelope.correlationId,
            replyTo: envelope.replyTo,
            persistent: true,
            timestamp: envelope.timestamp
        });
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

        // Create exclusive response queue
        const responseQueueResult = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true
        });
        this.responseQueue = responseQueueResult.queue;

        // Set up response queue consumer
        await this.channel.consume(this.responseQueue, (msg: any) => {
            if (msg) {
                this.handleResponse(msg);
                this.channel?.ack(msg);
            }
        }, { noAck: false });

        // Subscribe to notifications
        await this.subscribeToNotifications();
    }

    /**
     * Handle incoming response messages
     */
    private handleResponse(msg: any): void {
        try {
            const envelope: RabbitMQMessage = JSON.parse(msg.content.toString());
            const correlationId = msg.properties.correlationId;

            if (correlationId && this.pendingRequests.has(correlationId)) {
                const resolver = this.pendingRequests.get(correlationId);
                this.pendingRequests.delete(correlationId);
                resolver?.(envelope.message);
            } else if (envelope.type === 'notification') {
                this.onmessage?.(envelope.message);
            }
        } catch (error) {
            this.onerror?.(error as Error);
        }
    }

    /**
     * Subscribe to notification exchanges
     */
    private async subscribeToNotifications(): Promise<void> {
        if (!this.channel) return;

        // Create a queue for notifications
        const notificationQueue = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true
        });

        // Bind to notification routing keys
        await this.channel.bindQueue(
            notificationQueue.queue,
            this.options.exchangeName,
            'notifications.*'
        );

        // Consume notifications
        await this.channel.consume(notificationQueue.queue, (msg: any) => {
            if (msg) {
                this.handleResponse(msg);
                this.channel?.ack(msg);
            }
        }, { noAck: false });
    }

    /**
     * Set up timeout for request responses
     */
    private setupRequestTimeout(correlationId: string): void {
        const timeoutHandle = setTimeout(() => {
            if (this.pendingRequests.has(correlationId)) {
                this.pendingRequests.delete(correlationId);
                this.onerror?.(new Error(`Request timeout for correlation ID: ${correlationId}`));
            }
        }, this.options.responseTimeout);

        // Store resolver for the request
        this.pendingRequests.set(correlationId, (response) => {
            clearTimeout(timeoutHandle);
            this.onmessage?.(response);
        });
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
     * Get target queue name based on message
     */
    private getTargetQueueName(_message: JSONRPCMessage): string {
        // For this implementation, route all messages to the server queue
        // In a more sophisticated setup, you might route based on method name
        return `${this.options.serverQueuePrefix}.requests`;
    }

    /**
     * Generate unique correlation ID
     */
    private generateCorrelationId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Convert string to Buffer (Node.js compatible)
     */
    private createBuffer(str: string): Buffer {
        return Buffer.from(str);
    }
}
