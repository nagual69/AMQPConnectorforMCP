/**
 * Transport contract pins, ported from Open Discovery 3.0
 * (testing/test_amqp_transport.js, test_amqp_consumer_cancel.js and the
 * broker-free cases of test_amqp_extension_contract.js).
 *
 * Each `describe` names the docs/TRANSPORT_CONTRACT.md clause it carries.
 * The cross-client leak guard (§2) is the one to read first: a change that
 * weakens it reintroduces a confidentiality defect, so keep its assertions
 * about values the transport produced, not constants.
 *
 * No broker: `_connectFn` replaces amqplib.connect wholesale, so the fixed
 * queue/exchange names below never leave the process.
 */

import { AMQPClientTransport } from "../amqp-client-transport";
import { AMQPServerTransport } from "../amqp-server-transport";
import { AmqpServerRuntime, type RuntimeManagedTransport } from "../amqp-server-runtime";
import type { AmqpRuntimeConfig, AmqpTransportStatus, ConnectableServer, JSONRPCMessage } from "../types";

// ─── Mock broker ────────────────────────────────────────────────────────────

type Handler = (message: unknown) => void;

function createMockChannel() {
    const consumers = new Map<string, Handler>();
    const events = new Map<string, (value?: unknown) => void>();
    let queueSeq = 0;
    return {
        published: [] as Array<{ exchange: string; routingKey: string; content: Buffer; options: Record<string, unknown> }>,
        sentToQueue: [] as Array<{ queue: string; content: Buffer; options: Record<string, unknown> }>,
        assertedExchanges: [] as Array<{ exchange: string; type: string; options: Record<string, unknown> }>,
        assertedQueues: [] as Array<{ queue: string; options: Record<string, unknown> }>,
        bindings: [] as Array<{ queue: string; exchange: string; pattern: string }>,
        acked: [] as unknown[],
        nacked: [] as Array<{ message: unknown; allUpTo: boolean; requeue: boolean }>,
        on(event: string, listener: (value?: unknown) => void) { events.set(event, listener); },
        emit(event: string, value?: unknown) { events.get(event)?.(value); },
        async prefetch() {},
        async assertExchange(exchange: string, type: string, options: Record<string, unknown>) {
            this.assertedExchanges.push({ exchange, type, options });
        },
        async assertQueue(queue: string, options: Record<string, unknown>) {
            const resolved = queue || `amq.gen-${++queueSeq}`;
            this.assertedQueues.push({ queue: resolved, options });
            return { queue: resolved };
        },
        async bindQueue(queue: string, exchange: string, pattern: string) {
            this.bindings.push({ queue, exchange, pattern });
        },
        async consume(queue: string, handler: Handler) {
            consumers.set(queue, handler);
            return { consumerTag: `consumer-${queue}` };
        },
        publish(exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown> = {}) {
            this.published.push({ exchange, routingKey, content, options });
            return true;
        },
        sendToQueue(queue: string, content: Buffer, options: Record<string, unknown> = {}) {
            this.sentToQueue.push({ queue, content, options });
            return true;
        },
        ack(message: unknown) { this.acked.push(message); },
        nack(message: unknown, allUpTo: boolean, requeue: boolean) { this.nacked.push({ message, allUpTo, requeue }); },
        async close() {},
        deliver(queue: string, body: unknown, properties: Record<string, unknown> = {}) {
            const handler = consumers.get(queue);
            if (!handler) throw new Error(`No consumer registered for ${queue}`);
            const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
            handler({ content, properties, fields: { deliveryTag: 1 } });
        },
        cancelConsumer(queue: string) { consumers.get(queue)?.(null); },
    };
}

type MockChannel = ReturnType<typeof createMockChannel>;

function createMockConnection(channel: MockChannel, { emitCloseOnClose = false } = {}) {
    const events = new Map<string, (value?: unknown) => void>();
    return {
        closedCount: 0,
        async createChannel() { return channel; },
        on(event: string, listener: (value?: unknown) => void) { events.set(event, listener); },
        emit(event: string, value?: unknown) { events.get(event)?.(value); },
        async close() {
            this.closedCount += 1;
            if (emitCloseOnClose) this.emit('close');
        },
    };
}

const serverOptions = {
    amqpUrl: 'amqp://guest:guest@localhost:5672',
    exchangeName: 'test.exchange',
    queuePrefix: 'test.queue',
    messageTTL: 60_000,
    queueTTL: 120_000,
};

async function startServer(connectionOptions?: { emitCloseOnClose?: boolean }) {
    const channel = createMockChannel();
    const connection = createMockConnection(channel, connectionOptions);
    const transport = new AMQPServerTransport(serverOptions);
    transport._connectFn = async () => connection as any;
    await transport.start();
    const queueName = `test.queue.requests.${transport.sessionId}`;
    return { transport, channel, connection, queueName };
}

function bodyOf(entry: { content: Buffer }): Record<string, unknown> {
    return JSON.parse(entry.content.toString());
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── §1 Endpoint, not session ───────────────────────────────────────────────

describe('§1 endpoint is one exclusive queue with exactly two bindings', () => {
    it('binds the request and client-notification namespaces, and nothing else', async () => {
        const { transport, channel, queueName } = await startServer();
        expect(channel.assertedQueues).toHaveLength(1);
        expect(channel.assertedQueues[0]).toMatchObject({
            queue: queueName,
            options: { durable: false, exclusive: true, autoDelete: true },
        });
        expect(channel.bindings.map((b) => b.pattern).sort()).toEqual(['mcp.client-notification.#', 'mcp.request.#']);
        expect(channel.bindings.every((b) => b.exchange === 'test.exchange.mcp.routing')).toBe(true);
        await transport.close();
    });

    it('never binds the old shared namespace or its own server-notification namespace', async () => {
        const { transport, channel } = await startServer();
        const patterns = channel.bindings.map((b) => b.pattern);
        expect(patterns).not.toContain('mcp.notification.#');
        expect(patterns.some((p) => p.startsWith('mcp.server-notification'))).toBe(false);
        await transport.close();
    });
});

// ─── §2 Per-request correlation (cross-client leak guard) ───────────────────

describe('§2 per-request correlation', () => {
    it('two concurrent clients using id 1 each get their own response at their own replyTo', async () => {
        const { transport, channel, queueName } = await startServer();
        const received: JSONRPCMessage[] = [];
        transport.onmessage = (message) => { received.push(message); };

        channel.deliver(queueName, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { correlationId: 'c1', replyTo: 'q1' });
        channel.deliver(queueName, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { correlationId: 'c2', replyTo: 'q2' });

        expect(received).toHaveLength(2);
        const internalId1 = (received[0] as { id: string }).id;
        const internalId2 = (received[1] as { id: string }).id;
        expect(internalId1).not.toBe(1);
        expect(internalId1).not.toBe(internalId2);

        // Respond in reverse order: routing must follow the id, not arrival order.
        await transport.send({ jsonrpc: '2.0', id: internalId2, result: { ok: 2 } } as JSONRPCMessage, { relatedRequestId: internalId2 });
        await transport.send({ jsonrpc: '2.0', id: internalId1, result: { ok: 1 } } as JSONRPCMessage, { relatedRequestId: internalId1 });

        expect(channel.sentToQueue).toHaveLength(2);
        const byQueue = new Map(channel.sentToQueue.map((s) => [s.queue, s]));
        expect(byQueue.get('q1')?.options.correlationId).toBe('c1');
        expect(byQueue.get('q2')?.options.correlationId).toBe('c2');
        expect(bodyOf(byQueue.get('q1')!)).toMatchObject({ id: 1, result: { ok: 1 } });
        expect(bodyOf(byQueue.get('q2')!)).toMatchObject({ id: 1, result: { ok: 2 } });
        await transport.close();
    });

    it('the endpoint-instance id never reaches the wire', async () => {
        const { transport, channel, queueName } = await startServer();
        let seen: JSONRPCMessage | undefined;
        transport.onmessage = (message) => { seen = message; };
        channel.deliver(queueName, { jsonrpc: '2.0', id: 'abc', method: 'tools/list' }, { correlationId: 'c', replyTo: 'r' });
        const internalId = (seen as { id: string }).id;
        await transport.send({ jsonrpc: '2.0', id: internalId, result: {} } as JSONRPCMessage, { relatedRequestId: internalId });
        await transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);

        const wire = [...channel.sentToQueue, ...channel.published]
            .map((e) => e.content.toString() + JSON.stringify(e.options))
            .join('\n');
        expect(wire).not.toContain(transport.sessionId);
        expect(wire).not.toContain(internalId);
        await transport.close();
    });

    it('a request without both replyTo and correlationId is delivered but never answerable', async () => {
        const { transport, channel, queueName } = await startServer();
        let seen: JSONRPCMessage | undefined;
        transport.onmessage = (message) => { seen = message; };
        channel.deliver(queueName, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { replyTo: 'r-only' });
        expect(seen).toBeDefined();
        await expect(transport.send({ jsonrpc: '2.0', id: 5, result: {} } as JSONRPCMessage, { relatedRequestId: 5 }))
            .rejects.toThrow(/No routing info/);
        expect(channel.sentToQueue).toHaveLength(0);
        await transport.close();
    });

    it('a routing entry is consumed by exactly one response', async () => {
        const { transport, channel, queueName } = await startServer();
        let seen: JSONRPCMessage | undefined;
        transport.onmessage = (message) => { seen = message; };
        channel.deliver(queueName, { jsonrpc: '2.0', id: 9, method: 'tools/call' }, { correlationId: 'c9', replyTo: 'r9' });
        const internalId = (seen as { id: string }).id;
        await transport.send({ jsonrpc: '2.0', id: internalId, result: {} } as JSONRPCMessage, { relatedRequestId: internalId });
        await expect(transport.send({ jsonrpc: '2.0', id: internalId, result: {} } as JSONRPCMessage, { relatedRequestId: internalId }))
            .rejects.toThrow(/No routing info/);
        expect(channel.sentToQueue).toHaveLength(1);
        await transport.close();
    });
});

// ─── §3 No protocol session ─────────────────────────────────────────────────

describe('§3 no protocol session', () => {
    it('a request with no prior initialize is delivered to the server', async () => {
        const { transport, channel, queueName } = await startServer();
        const seen: JSONRPCMessage[] = [];
        transport.onmessage = (message) => { seen.push(message); };
        channel.deliver(queueName, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { correlationId: 'c', replyTo: 'r' });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: 'tools/list' });
        await transport.close();
    });
});

// ─── §4 Notifications are broadcast ─────────────────────────────────────────

describe('§4 notifications are broadcast, never addressed', () => {
    it('server notifications publish under mcp.server-notification.* on the routing exchange', async () => {
        const { transport, channel } = await startServer();
        await transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        expect(channel.published).toHaveLength(1);
        expect(channel.published[0]).toMatchObject({
            exchange: 'test.exchange.mcp.routing',
            routingKey: 'mcp.server-notification.notifications.tools.list_changed',
            options: { contentType: 'application/json' },
        });
        await transport.close();
    });

    it('a progress notification is not addressed to the requester and leaves its routing entry intact', async () => {
        const { transport, channel, queueName } = await startServer();
        let seen: JSONRPCMessage | undefined;
        transport.onmessage = (message) => { seen = message; };
        channel.deliver(queueName, { jsonrpc: '2.0', id: 3, method: 'tools/call' }, { correlationId: 'c3', replyTo: 'r3' });
        const internalId = (seen as { id: string }).id;

        await transport.send(
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1 } } as JSONRPCMessage,
            { relatedRequestId: internalId },
        );
        expect(channel.sentToQueue).toHaveLength(0);
        expect(channel.published[0]!.routingKey).toBe('mcp.server-notification.notifications.progress');

        await transport.send({ jsonrpc: '2.0', id: internalId, result: {} } as JSONRPCMessage, { relatedRequestId: internalId });
        expect(channel.sentToQueue[0]).toMatchObject({ queue: 'r3', options: { correlationId: 'c3' } });
        await transport.close();
    });
});

// ─── §5 No server-initiated requests ────────────────────────────────────────

describe('§5 no server-initiated requests', () => {
    it('the server transport rejects outbound requests instead of looping them into its own queue', async () => {
        const { transport, channel } = await startServer();
        await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' } as JSONRPCMessage))
            .rejects.toThrow(/Server-initiated requests are not supported/);
        expect(channel.published).toHaveLength(0);
        await transport.close();
    });

    it('the runtime accepts only notifications', () => {
        // Compile-time pin: AmqpServerRuntime.send takes a JSONRPCNotification.
        const runtime = new AmqpServerRuntime();
        const send: (m: { jsonrpc: '2.0'; method: string }) => Promise<void> = (m) => runtime.send(m);
        expect(typeof send).toBe('function');
    });
});

// ─── §6 Delivery bounds ─────────────────────────────────────────────────────

describe('§6 delivery bounds', () => {
    it('declares message and queue TTLs and no dead-letter exchange', async () => {
        const { transport, channel } = await startServer();
        const args = channel.assertedQueues[0]!.options.arguments as Record<string, unknown>;
        expect(args).toEqual({ 'x-message-ttl': 60_000, 'x-expires': 120_000 });
        expect(args).not.toHaveProperty('x-dead-letter-exchange');
        await transport.close();
    });

    it.each([
        ['oversize', Buffer.alloc(2 * 1024 * 1024, 'x')],
        ['not JSON', Buffer.from('{nope')],
        ['not JSON-RPC', Buffer.from(JSON.stringify({ id: 1, method: 'x' }))],
    ])('drops an undeliverable %s message without requeue', async (_label, content) => {
        const { transport, channel, queueName } = await startServer();
        const seen: JSONRPCMessage[] = [];
        transport.onmessage = (message) => { seen.push(message); };
        transport.onerror = () => undefined;
        channel.deliver(queueName, content, { correlationId: 'c', replyTo: 'r' });
        expect(seen).toHaveLength(0);
        expect(channel.nacked).toHaveLength(1);
        expect(channel.nacked[0]!.requeue).toBe(false);
        await transport.close();
    });
});

// ─── Connection lifecycle (OD test_amqp_transport.js) ───────────────────────

describe('connection lifecycle', () => {
    it('close() resolves and fires onclose once even when broker close rejects', async () => {
        const channel = createMockChannel();
        channel.close = async () => { throw new Error('channel already dead'); };
        const connection = createMockConnection(channel);
        connection.close = async () => { throw new Error('connection already dead'); };
        const transport = new AMQPServerTransport({ ...serverOptions, logger: silentLogger() });
        transport._connectFn = async () => connection as any;
        await transport.start();
        const onclose = jest.fn();
        transport.onclose = onclose;
        await transport.close();
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    it('explicit close emits onclose once even when the connection fires close', async () => {
        const { transport } = await startServer({ emitCloseOnClose: true });
        const onclose = jest.fn();
        transport.onclose = onclose;
        await transport.close();
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    describe('reconnect', () => {
        beforeEach(() => { jest.useFakeTimers(); });
        afterEach(() => { jest.useRealTimers(); });

        it('closes the old connection exactly once and opens a new one', async () => {
            const connections: Array<ReturnType<typeof createMockConnection>> = [];
            const transport = new AMQPServerTransport({ ...serverOptions, reconnectDelay: 1000, maxReconnectAttempts: 10 });
            transport._connectFn = async () => {
                const conn = createMockConnection(createMockChannel());
                connections.push(conn);
                return conn as any;
            };
            await transport.start();
            expect(connections).toHaveLength(1);

            connections[0]!.emit('close');
            await jest.advanceTimersByTimeAsync(1000);

            expect(connections).toHaveLength(2);
            expect(connections[0]!.closedCount).toBe(1);
            expect(transport.getStatus().connected).toBe(true);
            await transport.close();
        });

        it('an error and a close together schedule only one reconnect', async () => {
            let connects = 0;
            const transport = new AMQPServerTransport({ ...serverOptions, reconnectDelay: 1000 });
            const connection = createMockConnection(createMockChannel());
            transport._connectFn = async () => { connects += 1; return connection as any; };
            transport.onerror = () => undefined;
            await transport.start();

            connection.emit('error', new Error('boom'));
            connection.emit('close');
            await jest.advanceTimersByTimeAsync(1000);

            expect(connects).toBe(2);
            await transport.close();
        });
    });
});

// ─── Broker consumer cancel (OD test_amqp_consumer_cancel.js) ───────────────

describe('broker consumer cancel', () => {
    it('marks the transport not connected and reports why', async () => {
        const { transport, channel, queueName } = await startServer();
        const errors: Error[] = [];
        transport.onerror = (error) => { errors.push(error); };
        expect(transport.getStatus().connected).toBe(true);

        channel.cancelConsumer(queueName);

        expect(transport.getStatus().connected).toBe(false);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toMatch(/cancelled the consumer/i);
        expect(errors[0]!.message).toMatch(/queue was deleted|operator policy/i);
        expect(errors[0]!.message).toMatch(/connection is still open/i);
        await transport.close();
    });

    it('an ordinary delivery does not disconnect the transport', async () => {
        const { transport, channel, queueName } = await startServer();
        transport.onmessage = () => undefined;
        channel.deliver(queueName, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { replyTo: 'r', correlationId: 'c' });
        expect(transport.getStatus().connected).toBe(true);
        await transport.close();
    });

    it('a cancel during intentional shutdown is ignored', async () => {
        const { transport, channel, queueName } = await startServer();
        const errors: Error[] = [];
        transport.onerror = (error) => { errors.push(error); };
        await transport.close();
        channel.cancelConsumer(queueName);
        expect(errors).toEqual([]);
    });
});

// ─── Client wire contract ───────────────────────────────────────────────────

describe('client wire contract', () => {
    const clientOptions = { amqpUrl: 'amqp://localhost', serverQueuePrefix: 'test.queue', exchangeName: 'test.exchange' };

    async function startClient() {
        const channel = createMockChannel();
        const client = new AMQPClientTransport(clientOptions);
        client._connectFn = async () => createMockConnection(channel) as any;
        await client.start();
        return { client, channel };
    }

    it('consumes only server notifications', async () => {
        const { client, channel } = await startClient();
        expect(channel.bindings.map((b) => b.pattern)).toEqual(['mcp.server-notification.#']);
        await client.close();
    });

    it('publishes requests under mcp.request.* and notifications under mcp.client-notification.*', async () => {
        const { client, channel } = await startClient();
        await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } } as JSONRPCMessage);
        expect(channel.published.map((p) => p.routingKey)).toEqual([
            'mcp.request.tools.list',
            'mcp.client-notification.notifications.cancelled',
        ]);
        expect(channel.published[0]!.options).toMatchObject({ replyTo: expect.stringMatching(/^amq\.gen-/), correlationId: expect.any(String) });
        expect(channel.published[1]!.options).not.toHaveProperty('replyTo');
        await client.close();
    });

    it('rejects JSON-RPC responses: servers never initiate requests', async () => {
        const { client, channel } = await startClient();
        await expect(client.send({ jsonrpc: '2.0', id: 1, result: {} } as JSONRPCMessage)).rejects.toThrow(/not supported/);
        expect(channel.published).toHaveLength(0);
        await client.close();
    });

    it('treats a broker consumer cancel as a connection failure', async () => {
        const { client, channel } = await startClient();
        const errors: Error[] = [];
        client.onerror = (error) => { errors.push(error); };
        channel.cancelConsumer(channel.assertedQueues[0]!.queue);
        expect(errors[0]?.message).toMatch(/cancelled the consumer/i);
        await client.close();
    });
});

// ─── Runtime recovery (OD test_amqp_transport.js adapter cases) ─────────────

function silentLogger() {
    return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}

function createMockServer() {
    return {
        connections: [] as unknown[],
        async connect(transport: { start?: () => Promise<void> }) {
            this.connections.push(transport);
            await transport.start?.();
        },
    };
}

const runtimeConfig: AmqpRuntimeConfig = {
    enabled: true,
    mode: 'amqp',
    url: 'amqp://guest:guest@localhost:5672',
    exchange: 'test.exchange',
    queuePrefix: 'test.queue',
    reconnectDelay: 5_000,
    maxReconnectAttempts: 10,
    recoveryRetryInterval: 10,
    recoveryMaxRetries: 2,
    recoveryBackoffMultiplier: 1,
    recoveryMaxRetryInterval: 10,
    autoRecoveryEnabled: true,
};

function fakeStatus(connected: boolean): AmqpTransportStatus {
    return { enabled: true, connected, exchange: 'test.exchange', queuePrefix: 'test.queue', error: connected ? undefined : 'down' };
}

describe('runtime recovery', () => {
    it('recovers in the background after an initial start failure, with a distinct server per attach', async () => {
        const runtime = new AmqpServerRuntime<ReturnType<typeof createMockServer> & ConnectableServer>();
        let creations = 0;
        runtime._transportFactory = () => {
            const instance = ++creations;
            let connected = false;
            const transport: RuntimeManagedTransport = {
                async start() {
                    if (instance === 1) throw new Error('broker unavailable');
                    connected = true;
                },
                async close() { connected = false; },
                getStatus: () => fakeStatus(connected),
            };
            return transport;
        };

        const servers: Array<ReturnType<typeof createMockServer>> = [];
        const result = await runtime.start(
            { create: async () => { const s = createMockServer(); servers.push(s); return s as any; } },
            runtimeConfig,
        );

        expect(result.started).toBe(false);
        expect(result.details).toMatch(/background recovery scheduled/i);

        await wait(40);

        const status = runtime.getStatus();
        expect(status.connected).toBe(true);
        expect(status.recovery?.state).toBe('idle');
        expect(servers).toHaveLength(2);
        expect(servers.every((s) => s.connections.length === 1)).toBe(true);
        expect(new Set(servers).size).toBe(2);
        await runtime.stop();
    });

    it('re-attaches with a new server after the transport closes for good', async () => {
        const runtime = new AmqpServerRuntime();
        const transports: RuntimeManagedTransport[] = [];
        runtime._transportFactory = () => {
            let connected = false;
            const transport: RuntimeManagedTransport = {
                async start() { connected = true; },
                async close() {
                    connected = false;
                    transport.ontransportclosed?.(new Error('closed'));
                },
                getStatus: () => fakeStatus(connected),
            };
            transports.push(transport);
            return transport;
        };

        const servers: Array<ReturnType<typeof createMockServer>> = [];
        const result = await runtime.start(
            { create: async () => { const s = createMockServer(); servers.push(s); return s as any; } },
            runtimeConfig,
        );
        expect(result.started).toBe(true);

        await transports[0]!.close();
        await wait(40);

        expect(runtime.getStatus().connected).toBe(true);
        expect(servers).toHaveLength(2);
        expect(servers.every((s) => s.connections.length === 1)).toBe(true);
        expect(new Set(servers).size).toBe(2);
        await runtime.stop();
    });

    it('reports disabled without connecting when the config is disabled', async () => {
        const runtime = new AmqpServerRuntime();
        const create = jest.fn();
        const result = await runtime.start({ create }, { ...runtimeConfig, enabled: false });
        expect(result).toMatchObject({ started: false, details: 'AMQP transport disabled' });
        expect(create).not.toHaveBeenCalled();
    });
});
