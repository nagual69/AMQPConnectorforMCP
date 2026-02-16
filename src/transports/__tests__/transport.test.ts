/**
 * Comprehensive test suite for AMQP MCP Transport
 *
 * All tests run fully in-process with mocked AMQP connections — no
 * RabbitMQ broker required.  The transports accept an injectable
 * `_connectFn` that returns mock connection/channel objects, letting
 * us verify every behaviour without network I/O.
 *
 * Covers:
 *  - Utility functions (detectMessageType, validateJSONRPC, routing, config)
 *  - Transport instantiation & option validation
 *  - Lifecycle (start / close / idempotent start)
 *  - Message sending (request, response, notification routing)
 *  - Incoming message handling & correlation
 *  - Error propagation (onerror, onclose)
 *  - Closing flag prevents reconnection
 *  - Client → Server round-trip (mocked broker)
 */

import { AMQPClientTransport } from "../amqp-client-transport";
import { AMQPServerTransport } from "../amqp-server-transport";
import type { AMQPClientTransportOptions, AMQPServerTransportOptions, JSONRPCMessage } from "../types";
import {
    parseMessage,
    validateAmqpConfig,
    detectMessageType,
    validateJSONRPC,
    isJSONRPCRequest,
    isJSONRPCNotification,
    getRoutingKey,
    defaultRoutingKeyStrategy,
    generateCorrelationId,
    getDefaultConfig,
} from "../amqp-utils";

// ═══════════════════════════════════════════════════════════════════════════
// Mock helpers — simulate an AMQP broker in-process
// ═══════════════════════════════════════════════════════════════════════════

interface MockConsumer {
    queue: string;
    callback: (msg: unknown) => void;
}

function createMockChannel() {
    const consumers: MockConsumer[] = [];
    const published: Array<{ exchange: string; routingKey: string; content: Buffer; options: Record<string, unknown> }> = [];
    const sentToQueue: Array<{ queue: string; content: Buffer; options: Record<string, unknown> }> = [];
    const asserted: { exchanges: string[]; queues: string[] } = { exchanges: [], queues: [] };
    const bindings: Array<{ queue: string; exchange: string; pattern: string }> = [];
    let queueCounter = 0;

    return {
        assertExchange: jest.fn(async (exchange: string) => { asserted.exchanges.push(exchange); }),
        assertQueue: jest.fn(async (name: string) => {
            const q = name || `amq.gen-${++queueCounter}`;
            asserted.queues.push(q);
            return { queue: q, messageCount: 0, consumerCount: 0 };
        }),
        bindQueue: jest.fn(async (queue: string, exchange: string, pattern: string) => {
            bindings.push({ queue, exchange, pattern });
        }),
        consume: jest.fn(async (queue: string, cb: (msg: unknown) => void) => {
            consumers.push({ queue, callback: cb });
        }),
        publish: jest.fn((exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown> = {}) => {
            published.push({ exchange, routingKey, content, options });
            return true;
        }),
        sendToQueue: jest.fn((queue: string, content: Buffer, options: Record<string, unknown> = {}) => {
            sentToQueue.push({ queue, content, options });
            return true;
        }),
        prefetch: jest.fn(async () => {}),
        ack: jest.fn(),
        nack: jest.fn(),
        close: jest.fn(async () => {}),
        on: jest.fn(),
        // ── Test helpers ────────────────────────────────────────────────
        _consumers: consumers,
        _published: published,
        _sentToQueue: sentToQueue,
        _asserted: asserted,
        _bindings: bindings,
        /** Simulate the broker delivering a message to the first consumer on `queue`. */
        _deliver(queue: string, content: Buffer, properties: Record<string, unknown> = {}) {
            const consumer = consumers.find(c => c.queue === queue);
            consumer?.callback({
                content,
                properties,
                fields: { routingKey: '', deliveryTag: 1 },
            });
        },
    };
}

type MockChannel = ReturnType<typeof createMockChannel>;

function createMockConnection(channel: MockChannel) {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
        createChannel: jest.fn(async () => channel),
        on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
            (listeners[event] ??= []).push(cb);
        }),
        close: jest.fn(async () => {}),
        _listeners: listeners,
        _emit(event: string, ...args: unknown[]) {
            (listeners[event] ?? []).forEach(fn => fn(...args));
        },
    };
}

type MockConnection = ReturnType<typeof createMockConnection>;

function makeConnectFn(conn: MockConnection) {
    return async () => conn as any;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('Utility Functions', () => {
    describe('detectMessageType', () => {
        it('detects a request', () => {
            expect(detectMessageType({ jsonrpc: '2.0', id: 1, method: 'test' } as JSONRPCMessage)).toBe('request');
        });
        it('detects a response with result', () => {
            expect(detectMessageType({ jsonrpc: '2.0', id: 1, result: {} } as JSONRPCMessage)).toBe('response');
        });
        it('detects an error response', () => {
            expect(detectMessageType({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } } as JSONRPCMessage)).toBe('response');
        });
        it('detects a notification', () => {
            expect(detectMessageType({ jsonrpc: '2.0', method: 'notify' } as JSONRPCMessage)).toBe('notification');
        });
        it('throws for unclassifiable messages', () => {
            expect(() => detectMessageType({ jsonrpc: '2.0' } as JSONRPCMessage)).toThrow('Cannot determine');
        });
    });

    describe('validateJSONRPC', () => {
        it('accepts a valid request', () => {
            expect(validateJSONRPC({ jsonrpc: '2.0', id: 1, method: 'test' })).toHaveProperty('jsonrpc', '2.0');
        });
        it('accepts a valid response', () => {
            expect(validateJSONRPC({ jsonrpc: '2.0', id: 1, result: {} })).toHaveProperty('result');
        });
        it('accepts a valid notification', () => {
            expect(validateJSONRPC({ jsonrpc: '2.0', method: 'n' })).toHaveProperty('method', 'n');
        });
        it('rejects non-object', () => expect(() => validateJSONRPC('str')).toThrow('not an object'));
        it('rejects null', () => expect(() => validateJSONRPC(null)).toThrow('not an object'));
        it('rejects missing jsonrpc field', () => expect(() => validateJSONRPC({ id: 1, method: 't' })).toThrow('Invalid or missing jsonrpc'));
        it('rejects wrong jsonrpc version', () => expect(() => validateJSONRPC({ jsonrpc: '1.0', id: 1, method: 't' })).toThrow('expected "2.0"'));
        it('rejects message with no method/result/error', () => expect(() => validateJSONRPC({ jsonrpc: '2.0', id: 1 })).toThrow('must contain'));
    });

    describe('isJSONRPCRequest / isJSONRPCNotification', () => {
        it('identifies requests', () => expect(isJSONRPCRequest({ jsonrpc: '2.0', id: 1, method: 'x' } as JSONRPCMessage)).toBe(true));
        it('notifications are not requests', () => expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'x' } as JSONRPCMessage)).toBe(false));
        it('identifies notifications', () => expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 'x' } as JSONRPCMessage)).toBe(true));
        it('requests are not notifications', () => expect(isJSONRPCNotification({ jsonrpc: '2.0', id: 1, method: 'x' } as JSONRPCMessage)).toBe(false));
    });

    describe('getRoutingKey / defaultRoutingKeyStrategy', () => {
        it('converts / to . in method names', () => expect(defaultRoutingKeyStrategy('tools/list', 'request')).toBe('mcp.request.tools.list'));
        it('creates notification keys', () => expect(defaultRoutingKeyStrategy('cancelled', 'notification')).toBe('mcp.notification.cancelled'));
        it('uses custom strategy', () => {
            const custom = (m: string, t: string) => `x.${t}.${m}`;
            expect(getRoutingKey({ jsonrpc: '2.0', id: 1, method: 'foo' } as JSONRPCMessage, 'request', custom)).toBe('x.request.foo');
        });
        it('falls back to default', () => expect(getRoutingKey({ jsonrpc: '2.0', id: 1, method: 'bar' } as JSONRPCMessage, 'request')).toBe('mcp.request.bar'));
        it('returns unknown for messages without method', () => expect(getRoutingKey({ jsonrpc: '2.0', id: 1, result: {} } as JSONRPCMessage, 'request')).toBe('mcp.request.unknown'));
    });

    describe('parseMessage', () => {
        it('parses valid JSON-RPC', () => {
            const r = parseMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' })));
            expect(r.success).toBe(true);
            expect(r.message).toHaveProperty('method', 'x');
        });
        it('fails on invalid JSON', () => expect(parseMessage(Buffer.from('{bad')).success).toBe(false));
        it('fails on valid JSON but invalid JSON-RPC', () => {
            const r = parseMessage(Buffer.from(JSON.stringify({ foo: 'bar' })));
            expect(r.success).toBe(false);
            expect(r.error?.message).toMatch(/jsonrpc/);
        });
        it('works with string input', () => expect(parseMessage(JSON.stringify({ jsonrpc: '2.0', method: 'x' })).success).toBe(true));
    });

    describe('generateCorrelationId', () => {
        it('includes the session id', () => expect(generateCorrelationId('sess-123')).toMatch(/^sess-123-/));
        it('generates unique ids', () => expect(generateCorrelationId('s')).not.toBe(generateCorrelationId('s')));
    });

    describe('validateAmqpConfig', () => {
        it('accepts valid amqp:// URL', () => expect(validateAmqpConfig({ amqpUrl: 'amqp://localhost:5672', queuePrefix: 't', exchangeName: 'e' })).toHaveLength(0));
        it('accepts valid amqps:// URL', () => expect(validateAmqpConfig({ amqpUrl: 'amqps://localhost', queuePrefix: 't', exchangeName: 'e' })).toHaveLength(0));
        it('rejects http:// scheme (S4)', () => expect(validateAmqpConfig({ amqpUrl: 'http://localhost', queuePrefix: 't', exchangeName: 'e' }).some(e => e.includes('scheme'))).toBe(true));
        it('rejects unparseable URL', () => expect(validateAmqpConfig({ amqpUrl: 'bad', queuePrefix: 't', exchangeName: 'e' }).length).toBeGreaterThan(0));
        it('rejects empty queuePrefix', () => expect(validateAmqpConfig({ amqpUrl: 'amqp://x', queuePrefix: '', exchangeName: 'e' })).toContain('Queue prefix cannot be empty'));
        it('rejects empty exchangeName', () => expect(validateAmqpConfig({ amqpUrl: 'amqp://x', queuePrefix: 'q', exchangeName: '' })).toContain('Exchange name cannot be empty'));
        it('rejects reconnectDelay < 1000', () => expect(validateAmqpConfig({ amqpUrl: 'amqp://x', queuePrefix: 'q', exchangeName: 'e', reconnectDelay: 500 }).some(e => e.includes('1000'))).toBe(true));
    });

    describe('getDefaultConfig', () => {
        it('returns all required keys', () => {
            const cfg = getDefaultConfig();
            expect(cfg).toHaveProperty('AMQP_URL');
            expect(typeof cfg.AMQP_RECONNECT_DELAY).toBe('number');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CLIENT TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════

describe('AMQPClientTransport', () => {
    const opts: AMQPClientTransportOptions = { amqpUrl: 'amqp://localhost:5672', serverQueuePrefix: 'test.mcp', exchangeName: 'test.exchange' };

    describe('Instantiation', () => {
        it('creates an instance', () => expect(new AMQPClientTransport(opts)).toBeInstanceOf(AMQPClientTransport));
        it('generates UUID v4 sessionId (M6)', () => expect(new AMQPClientTransport(opts).sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/));
        it('rejects missing amqpUrl', () => expect(() => new AMQPClientTransport({ ...opts, amqpUrl: '' })).toThrow('amqpUrl'));
        it('rejects missing serverQueuePrefix', () => expect(() => new AMQPClientTransport({ ...opts, serverQueuePrefix: '' } as any)).toThrow('serverQueuePrefix'));
        it('rejects missing exchangeName', () => expect(() => new AMQPClientTransport({ ...opts, exchangeName: '' })).toThrow('exchangeName'));
        it('merges defaults', () => {
            const t = new AMQPClientTransport({ ...opts, responseTimeout: 60000 });
            expect((t as any).options.responseTimeout).toBe(60000);
            expect((t as any).options.maxMessageSize).toBe(1_048_576);
        });
    });

    describe('Callbacks', () => {
        it('onclose is a plain property', () => { const t = new AMQPClientTransport(opts); const fn = jest.fn(); t.onclose = fn; expect(t.onclose).toBe(fn); });
        it('onerror is a plain property', () => { const t = new AMQPClientTransport(opts); const fn = jest.fn(); t.onerror = fn; expect(t.onerror).toBe(fn); });
        it('onmessage is a plain property', () => { const t = new AMQPClientTransport(opts); const fn = jest.fn(); t.onmessage = fn; expect(t.onmessage).toBe(fn); });
    });

    describe('Protocol Version', () => {
        it('stores and retrieves', () => {
            const t = new AMQPClientTransport(opts);
            t.setProtocolVersion('2025-11-25');
            expect(t.protocolVersion).toBe('2025-11-25');
        });
    });

    describe('Lifecycle (mocked)', () => {
        let ch: MockChannel, conn: MockConnection;
        const startedTransports: AMQPClientTransport[] = [];
        beforeEach(() => { ch = createMockChannel(); conn = createMockConnection(ch); });
        afterEach(async () => {
            for (const t of startedTransports) {
                try { await t.close(); } catch { /* already closed */ }
            }
            startedTransports.length = 0;
        });

        async function startTransport(t: AMQPClientTransport): Promise<void> {
            startedTransports.push(t);
            await t.start();
        }

        it('start() sets up exchange, queues, consumers', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            expect(conn.createChannel).toHaveBeenCalled();
            expect(ch.assertExchange).toHaveBeenCalledWith('test.exchange.mcp.routing', 'topic', expect.any(Object));
            expect(ch.assertQueue).toHaveBeenCalled();
            expect(ch.consume).toHaveBeenCalled();
        });

        it('start() is idempotent', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.start();
            expect(conn.createChannel).toHaveBeenCalledTimes(1);
        });

        it('close() calls onclose', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            const onclose = jest.fn();
            t.onclose = onclose;
            await t.close();
            expect(onclose).toHaveBeenCalledTimes(1);
        });

        it('send() throws when not connected', async () => {
            await expect(new AMQPClientTransport(opts).send({ jsonrpc: '2.0', id: 1, method: 't' } as any)).rejects.toThrow('not connected');
        });

        it('send(request) publishes raw JSON-RPC (C1, M7)', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as any);

            const p = ch._published[0]!;
            expect(p.exchange).toBe('test.exchange.mcp.routing');
            expect(p.routingKey).toBe('mcp.request.tools.list');
            expect(p.options.contentType).toBe('application/json');
            expect(p.options.replyTo).toBeDefined();
            const body = JSON.parse(p.content.toString());
            expect(body.jsonrpc).toBe('2.0');
            expect(body.message).toBeUndefined(); // no envelope
        });

        it('send(notification) uses mcp.notification.* routing key (M8)', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.send({ jsonrpc: '2.0', method: 'notifications/cancelled' } as any);
            expect(ch._published[0]!.routingKey).toBe('mcp.notification.notifications.cancelled');
        });

        it('incoming response invokes onmessage', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            const onmsg = jest.fn();
            t.onmessage = onmsg;
            await startTransport(t);

            const rq = ch._asserted.queues.find(q => q.startsWith('amq.gen-'))!;
            ch._deliver(rq, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })), { correlationId: 'c' });
            expect(onmsg).toHaveBeenCalledTimes(1);
            expect(onmsg.mock.calls[0]![0]).toHaveProperty('result');
        });

        it('rejects oversized messages (S1)', async () => {
            const t = new AMQPClientTransport({ ...opts, maxMessageSize: 10 });
            t._connectFn = makeConnectFn(conn);
            const onerr = jest.fn();
            t.onerror = onerr;
            await startTransport(t);
            ch._deliver(ch._asserted.queues.find(q => q.startsWith('amq.gen-'))!, Buffer.alloc(100, 'x'), { correlationId: 'c' });
            expect(onerr).toHaveBeenCalled();
            expect(onerr.mock.calls[0]![0].message).toMatch(/maxMessageSize/);
        });

        it('close() prevents reconnection (C4)', async () => {
            const t = new AMQPClientTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.close();
            conn._emit('close');
            expect((t as any).connectionState.connected).toBe(false);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SERVER TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════

describe('AMQPServerTransport', () => {
    const opts: AMQPServerTransportOptions = { amqpUrl: 'amqp://localhost:5672', queuePrefix: 'test.mcp', exchangeName: 'test.exchange' };

    describe('Instantiation', () => {
        it('creates an instance', () => expect(new AMQPServerTransport(opts)).toBeInstanceOf(AMQPServerTransport));
        it('generates UUID v4 sessionId (M6)', () => expect(new AMQPServerTransport(opts).sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/));
        it('rejects missing amqpUrl', () => expect(() => new AMQPServerTransport({ ...opts, amqpUrl: '' })).toThrow('amqpUrl'));
        it('rejects missing queuePrefix', () => expect(() => new AMQPServerTransport({ ...opts, queuePrefix: '' } as any)).toThrow('queuePrefix'));
        it('rejects missing exchangeName', () => expect(() => new AMQPServerTransport({ ...opts, exchangeName: '' })).toThrow('exchangeName'));
    });

    describe('Callbacks — SDK owns directly (C6)', () => {
        it('onmessage is a plain property', () => {
            const t = new AMQPServerTransport(opts);
            const fn = jest.fn();
            t.onmessage = fn;
            expect(t.onmessage).toBe(fn);
        });
    });

    describe('Lifecycle (mocked)', () => {
        let ch: MockChannel, conn: MockConnection;
        const startedTransports: AMQPServerTransport[] = [];
        beforeEach(() => { ch = createMockChannel(); conn = createMockConnection(ch); });
        afterEach(async () => {
            // Close all transports that were started to clear routingCleanupTimer
            for (const t of startedTransports) {
                try { await t.close(); } catch { /* already closed */ }
            }
            startedTransports.length = 0;
        });

        async function startTransport(t: AMQPServerTransport): Promise<void> {
            startedTransports.push(t);
            await t.start();
        }

        it('start() creates single queue bound to mcp.request.# and mcp.notification.# (M2)', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            expect(ch._asserted.queues.length).toBe(1);
            expect(ch._bindings.map(b => b.pattern)).toContain('mcp.request.#');
            expect(ch._bindings.map(b => b.pattern)).toContain('mcp.notification.#');
        });

        it('close() calls onclose', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            const onclose = jest.fn();
            t.onclose = onclose;
            await t.close();
            expect(onclose).toHaveBeenCalledTimes(1);
        });

        it('incoming request stores routing info and invokes onmessage', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            const onmsg = jest.fn();
            t.onmessage = onmsg;
            await startTransport(t);
            ch._deliver(ch._asserted.queues[0]!, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' })), { correlationId: 'c-42', replyTo: 'reply-q' });
            expect(onmsg).toHaveBeenCalledTimes(1);
            expect((t as any).routingInfoStore.has(42)).toBe(true);
        });

        it('rejects messages missing jsonrpc:"2.0" (C3)', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            const onerr = jest.fn(), onmsg = jest.fn();
            t.onerror = onerr; t.onmessage = onmsg;
            await startTransport(t);
            ch._deliver(ch._asserted.queues[0]!, Buffer.from(JSON.stringify({ id: 1, method: 'test' })), { correlationId: 'c', replyTo: 'r' });
            expect(onmsg).not.toHaveBeenCalled();
            expect(onerr).toHaveBeenCalled();
            expect(onerr.mock.calls[0]![0].message).toMatch(/jsonrpc/);
            expect(ch.nack).toHaveBeenCalled();
        });

        it('rejects oversized messages (S1)', async () => {
            const t = new AMQPServerTransport({ ...opts, maxMessageSize: 10 });
            t._connectFn = makeConnectFn(conn);
            const onerr = jest.fn(); t.onerror = onerr;
            await startTransport(t);
            ch._deliver(ch._asserted.queues[0]!, Buffer.alloc(100, 'x'), {});
            expect(onerr.mock.calls[0]![0].message).toMatch(/maxMessageSize/);
        });

        it('send(response) uses relatedRequestId (C2)', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            t.onmessage = jest.fn();
            await startTransport(t);
            ch._deliver(ch._asserted.queues[0]!, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call' })), { correlationId: 'corr-99', replyTo: 'client-q' });
            await t.send({ jsonrpc: '2.0', id: 99, result: { ok: true } } as any, { relatedRequestId: 99 });
            const sq = ch._sentToQueue[0]!;
            expect(sq.queue).toBe('client-q');
            expect(sq.options.correlationId).toBe('corr-99');
            expect(sq.options.contentType).toBe('application/json');
        });

        it('send(response) falls back to message.id when no relatedRequestId', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            t.onmessage = jest.fn();
            await startTransport(t);
            ch._deliver(ch._asserted.queues[0]!, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'x' })), { correlationId: 'c50', replyTo: 'rq' });
            await t.send({ jsonrpc: '2.0', id: 50, result: {} } as any);
            expect(ch._sentToQueue[0]!.queue).toBe('rq');
        });

        it('send(response) throws when no routing info', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await expect(t.send({ jsonrpc: '2.0', id: 999, result: {} } as any, { relatedRequestId: 999 })).rejects.toThrow('No routing info');
        });

        it('send(notification) uses mcp.notification.* key (M8)', async () => {
            const t = new AMQPServerTransport(opts);
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as any);
            expect(ch._published[0]!.routingKey).toBe('mcp.notification.notifications.tools.list_changed');
        });

        it('custom routingKeyStrategy (C7)', async () => {
            const t = new AMQPServerTransport({ ...opts, routingKeyStrategy: (m, tt) => `x.${tt}.${m}` });
            t._connectFn = makeConnectFn(conn);
            await startTransport(t);
            await t.send({ jsonrpc: '2.0', method: 'foo' } as any);
            expect(ch._published[0]!.routingKey).toBe('x.notification.foo');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. CLIENT → SERVER ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════════

describe('Client → Server round-trip (mocked broker)', () => {
    it('full request-response cycle', async () => {
        const sCh = createMockChannel(), cCh = createMockChannel();
        const sConn = createMockConnection(sCh), cConn = createMockConnection(cCh);

        const server = new AMQPServerTransport({ amqpUrl: 'amqp://x', queuePrefix: 'test', exchangeName: 'ex' });
        server._connectFn = makeConnectFn(sConn);
        server.onmessage = (msg: JSONRPCMessage) => {
            if ('id' in msg && msg.id !== undefined)
                void server.send({ jsonrpc: '2.0', id: msg.id, result: { echoed: true } } as any, { relatedRequestId: msg.id as any });
        };
        await server.start();

        const client = new AMQPClientTransport({ amqpUrl: 'amqp://x', serverQueuePrefix: 'test', exchangeName: 'ex' });
        client._connectFn = makeConnectFn(cConn);
        const received = jest.fn();
        client.onmessage = received;
        await client.start();

        // Client sends request
        await client.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' } as any);

        // Broker: client publish → server consumer
        const pub = cCh._published[0]!;
        sCh._deliver(sCh._asserted.queues[0]!, pub.content, { correlationId: pub.options.correlationId, replyTo: pub.options.replyTo as string });

        // Broker: server sendToQueue → client reply queue
        const resp = sCh._sentToQueue[0]!;
        const replyQ = cCh._asserted.queues.find(q => q.startsWith('amq.gen-'))!;
        cCh._deliver(replyQ, resp.content, { correlationId: resp.options.correlationId });

        expect(received).toHaveBeenCalledTimes(1);
        expect(received.mock.calls[0]![0].result).toEqual({ echoed: true });

        await client.close();
        await server.close();
    });
});
