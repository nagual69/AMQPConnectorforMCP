/**
 * AMQP Server Transport for Model Context Protocol
 *
 * Implements the MCP Transport interface over AMQP.  Incoming requests and
 * client notifications are consumed from one exclusive queue bound to the
 * `${exchangeName}.mcp.routing` topic exchange; each response is routed
 * directly to the requesting client's reply queue using the `replyTo` /
 * `correlationId` pair that arrived with the request.
 *
 * The normative behaviour is docs/TRANSPORT_CONTRACT.md.  The load-bearing
 * points:
 *  - Wire format is pure JSON-RPC 2.0; the client's own JSON-RPC id is what
 *    goes back on the wire.
 *  - Inside the process each request's id is rewritten to a globally unique
 *    internal id before the SDK sees it, so two clients that both use `id: 1`
 *    can never receive each other's responses.
 *  - Server notifications publish under `mcp.server-notification.*`, a
 *    namespace this server's own queue does not bind (no self-loopback).
 *  - Servers never initiate requests over this transport.
 *  - A broker-side consumer cancel is treated as a connection failure.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type {
    AMQPServerTransportOptions,
    AmqpTransportStatus,
    ConnectionState,
    JSONRPCMessage,
    MessageExtraInfo,
    RequestId,
    Transport,
    TransportLogger,
    TransportSendOptions,
} from "./types.js";
import {
    ROUTING_PATTERNS,
    createDefaultLogger,
    detectMessageType,
    generateSessionId,
    getRoutingKey,
    routingExchangeName,
    sanitizeJsonRpcMessage,
    validateAmqpConfig,
    validateJSONRPC,
} from "./amqp-utils.js";

// Minimal connection interface to align with amqplib Promise API
export interface AMQPConnection {
    createChannel(): Promise<Channel>;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'close', listener: () => void): void;
    close(): Promise<void>;
}

// Routing information stored per incoming request, keyed by internal id
interface RoutingInfo {
    correlationId: string;
    replyTo: string;
    timestamp: number;     // for TTL-based cleanup
    originalId: RequestId; // the client's own JSON-RPC id, restored on the way out
}

const DEFAULT_MESSAGE_TTL = 3_600_000;
const DEFAULT_QUEUE_TTL = 7_200_000;
const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576;

/**
 * AMQP Server Transport for Model Context Protocol
 */
export class AMQPServerTransport implements Transport {
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;

    // Routing store keyed by a globally-unique INTERNAL id (not the client-chosen JSON-RPC id,
    // which is only unique per client and collides across concurrent clients). Each entry also
    // remembers the client's originalId so the outbound response id can be rewritten back.
    private readonly routingInfoStore = new Map<RequestId, RoutingInfo>();
    private internalIdSeq = 0;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly maxMessageSize: number;
    private readonly logger: TransportLogger;
    private closing = false;
    private closeNotified = false;
    // True while connect() is intentionally tearing down the previous connection so the OLD
    // connection's 'close'/'error' listeners do not trigger a spurious reconnect storm.
    private reconnecting = false;
    private readonly connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private _protocolVersion?: string;

    /**
     * Endpoint-instance id.  It names this server's exclusive queue and
     * namespaces internal request ids; it never appears on the wire and is
     * not an MCP session.
     */
    readonly sessionId: string;

    // Transport interface callbacks — the SDK owns these directly
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Fires once when the transport has closed for good (explicit close, or
     * reconnection exhausted), with the last error if there was one.
     * {@link AmqpServerRuntime} uses it to drive background recovery.
     */
    ontransportclosed?: (error?: Error) => void;

    /** @internal Injectable connect function for testing. */
    _connectFn?: (url: string) => Promise<AMQPConnection>;

    constructor(private readonly options: AMQPServerTransportOptions) {
        for (const field of ['amqpUrl', 'queuePrefix', 'exchangeName'] as const) {
            if (!options[field]) {
                throw new Error(`${field} is required`);
            }
        }
        const errors = validateAmqpConfig(options);
        if (errors.length) {
            throw new Error(`Invalid AMQP server transport configuration: ${errors.join(', ')}`);
        }
        this.maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
        this.logger = options.logger ?? createDefaultLogger('AMQP_SERVER_TRANSPORT');
        this.sessionId = generateSessionId();
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    getStatus(): AmqpTransportStatus {
        return {
            enabled: true,
            connected: this.connectionState.connected,
            exchange: this.options.exchangeName,
            queuePrefix: this.options.queuePrefix,
            error: this.connectionState.lastError?.message,
        };
    }

    /**
     * Start the transport — idempotent as required by MCP SDK.
     */
    async start(): Promise<void> {
        if (this.connectionState.connected) {
            return;
        }

        this.closing = false;
        this.closeNotified = false;
        try {
            await this.connect();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;
            this.connectionState.lastError = undefined;
            this.startRoutingCleanup();
        } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            this.connectionState.lastError = resolved;
            this.onerror?.(resolved);
            throw resolved;
        }
    }

    /**
     * Send a JSON-RPC message.
     *
     * Responses go to the requesting client's reply queue, looked up by
     * `options.relatedRequestId` (falling back to `message.id`).
     * Notifications are published under `mcp.server-notification.*`.
     * Requests are rejected: servers do not initiate requests over this
     * transport, and the request namespace is the one this server consumes.
     */
    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (!this.connectionState.connected || !this.channel) {
            throw new Error('Transport not connected');
        }

        const cleanMessage = sanitizeJsonRpcMessage(message);
        const messageType = detectMessageType(cleanMessage);

        if (messageType === 'response') {
            this.handleResponseMessage(cleanMessage, options);
            return;
        }

        if (messageType === 'request') {
            const method = 'method' in cleanMessage ? cleanMessage.method : 'unknown';
            throw new Error(
                `Server-initiated requests are not supported over the AMQP transport (method '${method}'). ` +
                `See docs/TRANSPORT_CONTRACT.md §5.`
            );
        }

        const exchangeName = routingExchangeName(this.options.exchangeName);
        const routingKey = getRoutingKey(cleanMessage, 'server-notification', this.options.routingKeyStrategy);
        const content = Buffer.from(JSON.stringify(cleanMessage));

        this.channel.publish(exchangeName, routingKey, content, {
            persistent: false,
            timestamp: Date.now(),
            contentType: 'application/json',
        });
    }

    /**
     * Close the transport.
     */
    async close(): Promise<void> {
        this.closing = true;
        this.connectionState.connected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        this.routingInfoStore.clear();

        try {
            await this.teardownConnection();
        } finally {
            this.notifyClosed();
        }
    }

    // ── Private: connection setup ───────────────────────────────────────────

    // Best-effort close of the current channel + connection, swallowing errors (a dead broker
    // rejects close()), then null both fields. Shared by close() and connect() so there is one
    // teardown code path. Does NOT call notifyClosed() or set closing — callers own that.
    private async teardownConnection(): Promise<void> {
        const channel = this.channel;
        const connection = this.connection;
        this.channel = null;
        this.connection = null;
        if (channel) {
            try {
                await channel.close();
            } catch (error) {
                this.logger.warn('Error closing AMQP channel during teardown', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                this.logger.warn('Error closing AMQP connection during teardown', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async connect(): Promise<void> {
        // Close any pre-existing connection/channel before opening a new one so a reconnect does
        // not leak the old connection (and its half-open socket) and so the broker releases the
        // old exclusive queue before the new assertQueue runs. The reconnecting flag suppresses
        // the old connection's close/error handlers from scheduling a spurious reconnect.
        if (this.connection || this.channel) {
            this.reconnecting = true;
            try {
                await this.teardownConnection();
            } finally {
                this.reconnecting = false;
            }
        }

        const connectFn = this._connectFn ?? await this.loadConnectFn();
        this.connection = await connectFn(this.options.amqpUrl);
        this.connection.on('error', (error) => this.handleConnectionError(error));
        this.connection.on('close', () => this.handleConnectionClosed());

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (error: unknown) =>
            this.handleConnectionError(error instanceof Error ? error : new Error(String(error))),
        );
        if (this.options.prefetchCount) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        await this.setupInfrastructure();
    }

    private async setupInfrastructure(): Promise<void> {
        if (!this.channel) {
            throw new Error('AMQP channel not established');
        }

        const exchangeName = routingExchangeName(this.options.exchangeName);
        await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

        const queueName = `${this.options.queuePrefix}.requests.${this.sessionId}`;
        await this.channel.assertQueue(queueName, {
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL ?? DEFAULT_MESSAGE_TTL,
                'x-expires': this.options.queueTTL ?? DEFAULT_QUEUE_TTL,
            },
        });

        await this.channel.bindQueue(queueName, exchangeName, ROUTING_PATTERNS.request);
        // Bind to client-originated notifications only. Do NOT bind to the server's own outbound
        // notification namespace (mcp.server-notification.#), or the server would consume its own
        // notifications (self-loopback).
        await this.channel.bindQueue(queueName, exchangeName, ROUTING_PATTERNS.clientNotification);
        await this.channel.consume(
            queueName,
            (message: ConsumeMessage | null) => {
                // A NULL message is not "nothing to do" — it is amqplib telling us the BROKER
                // cancelled our consumer (basic.cancel), which it sends when the queue is deleted
                // or an operator policy removes it. A cancel closes NEITHER the channel nor the
                // connection, so neither 'error' nor 'close' fires; without this branch the
                // transport would keep reporting connected while no request can arrive.
                if (!message) {
                    this.handleConsumerCancelled(queueName);
                    return;
                }
                this.handleIncomingMessage(message);
            },
            { noAck: false },
        );
    }

    /**
     * The broker took our consumer away while leaving the connection up.
     *
     * Routed into the SAME path a connection failure takes: the transport is
     * equally unable to serve requests either way, so it reports itself
     * equally unable and attempts the same recovery.
     */
    private handleConsumerCancelled(queueName: string): void {
        if (this.closing || this.reconnecting) {
            return;
        }
        this.handleConnectionError(
            new Error(
                `AMQP broker cancelled the consumer on '${queueName}'. The connection is still open, but no ` +
                `request can reach this server until the consumer is re-established. This usually means the ` +
                `queue was deleted or removed by an operator policy.`,
            ),
        );
    }

    // ── Private: incoming message handling ───────────────────────────────────

    private handleIncomingMessage(message: ConsumeMessage): void {
        const channel = this.channel;
        if (!channel) {
            return;
        }

        try {
            if (message.content.byteLength > this.maxMessageSize) {
                this.onerror?.(new Error(`Incoming message exceeds maxMessageSize (${message.content.byteLength} bytes)`));
                channel.nack(message, false, false);
                return;
            }

            const jsonRpcMessage = validateJSONRPC(JSON.parse(message.content.toString('utf8')));

            if ('id' in jsonRpcMessage && jsonRpcMessage.id !== undefined && jsonRpcMessage.id !== null) {
                const correlationId =
                    typeof message.properties.correlationId === 'string' ? message.properties.correlationId : undefined;
                const replyTo = typeof message.properties.replyTo === 'string' ? message.properties.replyTo : undefined;
                if (correlationId && replyTo) {
                    // Rewrite the client-chosen id to a globally-unique internal id BEFORE handing the
                    // message to the server, so two clients that both use id=1 do not collide in the
                    // routing store. The response path rewrites the id back to the client's original.
                    const internalId = `amqp-${this.sessionId}-${++this.internalIdSeq}`;
                    this.routingInfoStore.set(internalId, {
                        correlationId,
                        replyTo,
                        timestamp: Date.now(),
                        originalId: jsonRpcMessage.id as RequestId,
                    });
                    (jsonRpcMessage as { id: RequestId }).id = internalId;
                }
            }

            this.onmessage?.(jsonRpcMessage);
            channel.ack(message);
        } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            this.connectionState.lastError = resolved;
            this.onerror?.(resolved);
            try { channel.nack(message, false, false); } catch { /* best-effort */ }
        }
    }

    // ── Private: outgoing message handling ───────────────────────────────────

    private handleResponseMessage(message: JSONRPCMessage, options?: TransportSendOptions): void {
        if (!this.channel) {
            throw new Error('AMQP channel not established');
        }

        // The server echoes back the (internal) id it received on onmessage, via relatedRequestId
        // or message.id. Look up routing by that internal id, then rewrite the outbound response's
        // id back to the client's original id so the client sees the id IT sent.
        const lookupId = options?.relatedRequestId ?? ('id' in message ? message.id as RequestId | undefined : undefined);
        if (lookupId === undefined || lookupId === null) {
            throw new Error('No routing info available for response without request correlation');
        }

        const routingInfo = this.routingInfoStore.get(lookupId);
        if (!routingInfo) {
            throw new Error(`No routing info for related request ${String(lookupId)}`);
        }
        this.routingInfoStore.delete(lookupId);

        const outboundMessage = { ...message, id: routingInfo.originalId } as JSONRPCMessage;
        const content = Buffer.from(JSON.stringify(outboundMessage));
        this.channel.sendToQueue(routingInfo.replyTo, content, {
            correlationId: routingInfo.correlationId,
            contentType: 'application/json',
            persistent: false,
        });
    }

    // ── Private: recovery ───────────────────────────────────────────────────

    private handleConnectionError(error: Error): void {
        // Ignore errors from the old connection while we are intentionally tearing it down.
        if (this.reconnecting) {
            return;
        }
        this.connectionState.connected = false;
        this.connectionState.lastError = error;
        this.onerror?.(error);
        if (!this.closing) {
            this.scheduleReconnect();
        }
    }

    private handleConnectionClosed(): void {
        // Ignore the close event fired by our own intentional teardown during reconnect.
        if (this.reconnecting) {
            return;
        }
        this.connectionState.connected = false;
        if (!this.closing) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        const maxReconnectAttempts = this.options.maxReconnectAttempts ?? 10;
        const reconnectDelay = this.options.reconnectDelay ?? 5000;
        if (this.closing || this.reconnectTimer) {
            return;
        }
        if (this.connectionState.reconnectAttempts >= maxReconnectAttempts) {
            this.connectionState.lastError ??= new Error('Maximum reconnection attempts exceeded');
            this.notifyClosed();
            return;
        }

        this.connectionState.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closing) {
                return;
            }
            void this.connect()
                .then(() => {
                    this.connectionState.connected = true;
                    this.connectionState.reconnectAttempts = 0;
                    this.connectionState.lastError = undefined;
                })
                .catch((error: unknown) => {
                    this.connectionState.lastError = error instanceof Error ? error : new Error(String(error));
                    this.scheduleReconnect();
                });
        }, reconnectDelay);
        this.reconnectTimer.unref?.();
    }

    // ── Private: routing info TTL cleanup ───────────────────────────────────

    private startRoutingCleanup(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        const ttl = this.options.messageTTL ?? DEFAULT_MESSAGE_TTL;
        this.cleanupTimer = setInterval(() => {
            const cutoff = Date.now() - ttl;
            for (const [requestId, routingInfo] of this.routingInfoStore.entries()) {
                if (routingInfo.timestamp < cutoff) {
                    this.routingInfoStore.delete(requestId);
                }
            }
        }, 60_000);
        this.cleanupTimer.unref?.();
    }

    private notifyClosed(): void {
        if (this.closeNotified) {
            return;
        }
        this.closeNotified = true;
        this.ontransportclosed?.(this.connectionState.lastError);
        this.onclose?.();
    }

    private async loadConnectFn(): Promise<(url: string) => Promise<AMQPConnection>> {
        try {
            const amqp = await import('amqplib');
            return async (url: string) => (await amqp.connect(url)) as unknown as AMQPConnection;
        } catch {
            throw new Error('amqplib package not found. Please install with: npm install amqplib');
        }
    }
}

/** Alias matching Open Discovery's class name. */
export { AMQPServerTransport as AmqpServerTransport };
