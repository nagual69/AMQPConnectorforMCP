/**
 * AMQP server runtime: owns one {@link AMQPServerTransport} plus the MCP
 * server bound to it, and keeps the pair alive across broker outages.
 *
 * Two recovery layers exist, with different consequences:
 *  - In-transport reconnect (inside AMQPServerTransport): same transport,
 *    same server, same queue name.
 *  - Runtime recovery (here), after the transport has closed for good: a NEW
 *    transport and a NEW server from the factory.  The MCP SDK refuses to bind
 *    one server to a second transport, so a server is never reused across
 *    attaches.  In-flight requests at that point are never answered; clients
 *    own timeout and retry.
 *
 * Recovery retries with exponential backoff and reports its state through
 * {@link AmqpServerRuntime.getStatus} for health endpoints.
 */

import { AMQPServerTransport } from "./amqp-server-transport.js";
import type {
    AMQPServerTransportOptions,
    AmqpRecoveryStatus,
    AmqpRuntimeConfig,
    AmqpRuntimeStartResult,
    AmqpServerFactory,
    AmqpTransportStatus,
    ConnectableServer,
    JSONRPCNotification,
    RequestId,
    TransportLogger,
} from "./types.js";

/** The slice of AMQPServerTransport the runtime depends on (injectable for tests). */
export interface RuntimeManagedTransport {
    ontransportclosed?: ((error?: Error) => void) | undefined;
    start(): Promise<void>;
    close(): Promise<void>;
    getStatus(): AmqpTransportStatus;
    send?(message: JSONRPCNotification, options?: { relatedRequestId?: RequestId }): Promise<void>;
}

export interface AmqpServerRuntimeOptions {
    logger?: TransportLogger | undefined;
}

export class AmqpServerRuntime<TServer extends ConnectableServer = ConnectableServer> {
    private transport: RuntimeManagedTransport | null = null;
    private serverFactory: AmqpServerFactory<TServer> | null = null;
    // The server bound to the current transport. Replaced on every attach: the
    // SDK refuses to rebind one server to a second transport, so reusing it
    // across reconnects fails permanently with "Already connected to a transport".
    private server: TServer | null = null;
    private config: AmqpRuntimeConfig | null = null;
    private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private recoveryAttempt = 0;
    private recoveryDelay = 0;
    private stopping = false;
    private starting = false;
    private recoveryStatus: AmqpRecoveryStatus = {
        enabled: false,
        state: 'disabled',
        retryCount: 0,
    };

    /** @internal Injectable transport factory for testing. */
    _transportFactory?: (options: AMQPServerTransportOptions) => RuntimeManagedTransport;

    constructor(private readonly runtimeOptions: AmqpServerRuntimeOptions = {}) {}

    private getRecoveryConfig(): {
        enabled: boolean;
        retryInterval: number;
        maxRetries: number;
        backoffMultiplier: number;
        maxRetryInterval: number;
    } {
        return {
            enabled: this.config?.autoRecoveryEnabled !== false,
            retryInterval: this.config?.recoveryRetryInterval ?? 30000,
            maxRetries: this.config?.recoveryMaxRetries ?? -1,
            backoffMultiplier: this.config?.recoveryBackoffMultiplier ?? 1.5,
            maxRetryInterval: this.config?.recoveryMaxRetryInterval ?? 300000,
        };
    }

    private clearRecoveryTimer(): void {
        if (!this.recoveryTimer) {
            return;
        }
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
    }

    private createTransport(config: AmqpRuntimeConfig): RuntimeManagedTransport {
        const transportFactory =
            this._transportFactory ?? ((options: AMQPServerTransportOptions) => new AMQPServerTransport(options));
        const transport = transportFactory({
            amqpUrl: config.url,
            exchangeName: config.exchange,
            queuePrefix: config.queuePrefix,
            prefetchCount: config.prefetch,
            reconnectDelay: config.reconnectDelay,
            maxReconnectAttempts: config.maxReconnectAttempts,
            messageTTL: config.messageTTL,
            queueTTL: config.queueTTL,
            maxMessageSize: config.maxMessageSize,
            routingKeyStrategy: config.routingKeyStrategy,
            logger: this.runtimeOptions.logger,
        });

        transport.ontransportclosed = (error?: Error) => {
            if (this.transport === transport) {
                this.transport = null;
            }
            if (this.stopping) {
                return;
            }
            this.scheduleRecovery(error);
        };

        return transport;
    }

    private updateRecoveryStatus(overrides: Partial<AmqpRecoveryStatus>): void {
        const recoveryConfig = this.getRecoveryConfig();
        this.recoveryStatus = {
            ...this.recoveryStatus,
            enabled: recoveryConfig.enabled,
            state: recoveryConfig.enabled ? 'idle' : 'disabled',
            retryCount: this.recoveryAttempt,
            maxRetries: recoveryConfig.maxRetries,
            retryIntervalMs: recoveryConfig.retryInterval,
            maxRetryIntervalMs: recoveryConfig.maxRetryInterval,
            backoffMultiplier: recoveryConfig.backoffMultiplier,
            ...overrides,
        };
    }

    private resetRecoveryState(): void {
        this.recoveryAttempt = 0;
        this.recoveryDelay = this.getRecoveryConfig().retryInterval;
        this.clearRecoveryTimer();
        this.updateRecoveryStatus({
            state: this.getRecoveryConfig().enabled ? 'idle' : 'disabled',
            retryCount: 0,
            nextRetryAt: undefined,
            lastAttemptAt: undefined,
            lastError: undefined,
        });
    }

    private releaseServer(): void {
        if (this.server) {
            this.serverFactory?.release?.(this.server);
            this.server = null;
        }
    }

    private async attachTransport(config: AmqpRuntimeConfig): Promise<void> {
        if (!this.serverFactory) {
            throw new Error('AMQP transport has no server factory');
        }

        this.starting = true;
        try {
            const transport = this.createTransport(config);
            // Inside the try: a throw from create() would otherwise leave `starting`
            // set, and attemptRecovery early-returns on it — permanently wedging
            // recovery with no error surfaced anywhere.
            const server = await this.serverFactory.create();

            try {
                await server.connect(transport as unknown as AMQPServerTransport);

                // stop() may have run while connect() was in flight. Adopting this
                // transport now would leave a live broker channel and an unreleasable
                // server behind after shutdown, since nothing holds a handle any more.
                if (this.stopping) {
                    await transport.close().catch(() => undefined);
                    this.serverFactory.release?.(server);
                    return;
                }

                // Only drop the previous server once the new one is connected, so a
                // failed reconnect leaves the existing endpoint untouched.
                this.releaseServer();
                this.server = server;
                this.transport = transport;
                this.resetRecoveryState();
            } catch (error) {
                this.transport = null;
                await transport.close().catch(() => undefined);
                this.serverFactory.release?.(server);
                throw error;
            }
        } finally {
            this.starting = false;
        }
    }

    private async attemptRecovery(): Promise<void> {
        if (this.stopping || this.starting || !this.serverFactory || !this.config) {
            return;
        }

        const recoveryConfig = this.getRecoveryConfig();
        if (recoveryConfig.maxRetries >= 0 && this.recoveryAttempt >= recoveryConfig.maxRetries) {
            this.updateRecoveryStatus({ state: 'stopped', nextRetryAt: undefined });
            return;
        }

        this.recoveryAttempt += 1;
        this.updateRecoveryStatus({
            state: 'attempting',
            retryCount: this.recoveryAttempt,
            lastAttemptAt: new Date().toISOString(),
            nextRetryAt: undefined,
        });

        try {
            await this.attachTransport(this.config);
        } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            this.updateRecoveryStatus({ lastError: resolved.message });

            if (recoveryConfig.maxRetries >= 0 && this.recoveryAttempt >= recoveryConfig.maxRetries) {
                this.updateRecoveryStatus({ state: 'stopped', nextRetryAt: undefined });
                return;
            }

            this.recoveryDelay = Math.min(
                Math.max(this.recoveryDelay, recoveryConfig.retryInterval) * recoveryConfig.backoffMultiplier,
                recoveryConfig.maxRetryInterval,
            );
            this.scheduleRecovery(resolved);
        }
    }

    private scheduleRecovery(error?: Error): void {
        const recoveryConfig = this.getRecoveryConfig();
        if (!recoveryConfig.enabled || this.stopping || this.recoveryTimer) {
            if (!recoveryConfig.enabled) {
                this.updateRecoveryStatus({ state: 'disabled' });
            }
            return;
        }

        const nextRetryAt = new Date(Date.now() + this.recoveryDelay).toISOString();
        this.updateRecoveryStatus({
            state: 'waiting',
            nextRetryAt,
            lastError: error?.message ?? this.recoveryStatus.lastError,
        });

        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            void this.attemptRecovery();
        }, this.recoveryDelay);
        this.recoveryTimer.unref?.();
    }

    /**
     * Attach a transport and a fresh server.  When the broker is unavailable
     * the result reports `started: false` and, unless auto-recovery is
     * disabled, recovery continues in the background.
     */
    async start(serverFactory: AmqpServerFactory<TServer>, config: AmqpRuntimeConfig): Promise<AmqpRuntimeStartResult> {
        if (!config.enabled) {
            return { mode: 'amqp', started: false, details: 'AMQP transport disabled' };
        }

        this.serverFactory = serverFactory;
        this.config = config;
        this.stopping = false;
        this.recoveryDelay = this.getRecoveryConfig().retryInterval;
        this.updateRecoveryStatus({});

        try {
            await this.attachTransport(config);

            // attachTransport resolves normally when it aborts because stop() ran
            // mid-connect. Reporting started:true then would claim a transport
            // that does not exist.
            if (!this.transport) {
                return { mode: 'amqp', started: false, details: 'AMQP transport start aborted during shutdown' };
            }

            return { mode: 'amqp', started: true, details: 'AMQP transport started' };
        } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            this.scheduleRecovery(resolved);
            return {
                mode: 'amqp',
                started: false,
                details: this.getRecoveryConfig().enabled
                    ? 'AMQP transport start failed; background recovery scheduled'
                    : undefined,
                error: resolved.message,
            };
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.clearRecoveryTimer();
        this.updateRecoveryStatus({
            state: this.getRecoveryConfig().enabled ? 'stopped' : 'disabled',
            nextRetryAt: undefined,
        });
        try {
            await this.transport?.close();
        } finally {
            // close() can reject. Releasing in finally keeps a failed close from
            // silently leaking the server as well.
            this.transport = null;
            this.releaseServer();
        }
    }

    getStatus(): AmqpTransportStatus {
        const transportStatus = this.transport?.getStatus() ?? { enabled: Boolean(this.config?.enabled), connected: false };
        return {
            ...transportStatus,
            recovery: this.recoveryStatus,
        };
    }

    /**
     * Publish a server notification (e.g. `notifications/tools/list_changed`)
     * through the current transport.  Server-initiated requests are not
     * supported, so only notifications are accepted.
     */
    async send(message: JSONRPCNotification, options?: { relatedRequestId?: RequestId }): Promise<void> {
        if (!this.transport?.send) {
            throw new Error('AMQP transport not initialized');
        }
        await this.transport.send(message, options);
    }
}

/** Alias matching Open Discovery's class name. */
export { AmqpServerRuntime as NativeAmqpRuntimeAdapter };
