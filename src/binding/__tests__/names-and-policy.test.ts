/**
 * Routing keys and topology (§4), mirror edge cases (§8), deadlines (§7.1),
 * authInfo (§9.2) and the redelivery policy (§7.2).
 */

import { authInfoFor } from '../auth';
import { listenLifetimeMs, parseExpiration, requestDeadline } from '../deadline';
import { checkMirrors } from '../mirrors';
import { assertBindingNames, eraOfExchange, isCarriableToolName, routingKeyFor, serverTopology } from '../names';
import { redeliveryAction } from '../redelivery';
import { MODERN } from './helpers';

describe('routing keys (§4.2)', () => {
    it.each([
        ['tools/list', undefined, 'req.od.tools.list'],
        ['server/discover', undefined, 'req.od.server.discover'],
        ['tools/call', { name: 'nmap_scan' }, 'req.od.tools.call.nmap_scan'],
        ['tools/call', { name: 'a.b-c_D9' }, 'req.od.tools.call.a.b-c_D9'],
        ['tools/call', { name: 'has space' }, 'req.od.tools.call'],
        ['tools/call', { name: '' }, 'req.od.tools.call'],
        ['tools/call', { name: 'x'.repeat(129) }, 'req.od.tools.call'],
        ['tools/call', { name: '*' }, 'req.od.tools.call'],
        ['tools/call', { name: 7 }, 'req.od.tools.call'],
        ['tools/call', undefined, 'req.od.tools.call'],
    ])('%s %j -> %s', (method, params, key) => {
        expect(routingKeyFor('request', 'od', method, params as Record<string, unknown> | undefined)).toBe(key);
    });

    it('a 128-character name is carried; the suffix-less fallback fails closed', () => {
        expect(isCarriableToolName('x'.repeat(128), 'od')).toBe(true);
        expect(isCarriableToolName('x'.repeat(129), 'od')).toBe(false);
    });

    it('notifications use ntf. and never a tool suffix', () => {
        expect(routingKeyFor('notification', 'od', 'notifications/cancelled')).toBe('ntf.od.notifications.cancelled');
    });

    it('a key over 255 bytes is undefined, not truncated', () => {
        expect(routingKeyFor('request', 'od', 'x'.repeat(300))).toBeUndefined();
    });

    it.each(['', 'A', 'a.b', '-a', 'a'.repeat(64)])('rejects the name %p', (bad) => {
        expect(() => assertBindingNames({ ns: bad, svc: 'od' })).toThrow();
        expect(() => assertBindingNames({ ns: 'acme', svc: bad })).toThrow();
    });
});

describe('topology (§4.1)', () => {
    const options = { ns: 'acme', svc: 'od', instance: 'i-1', maxQueuedRequests: 1000, deadLetterMaxLength: 10_000, deadLetterTtlMs: 86_400_000 } as const;

    it('declares exactly the §4.1 objects and arguments', () => {
        const t = serverTopology({ ...options, legacy: 'reject' });
        expect(t.exchanges.map((e) => e.name)).toEqual(['acme.mcp', 'acme.mcp.events', 'acme.mcp.dlx']);
        const requests = t.queues.find((q) => q.role === 'requests');
        expect(requests).toEqual({
            role: 'requests', name: 'acme.od.requests', durable: true, exclusive: false, autoDelete: false,
            arguments: {
                'x-queue-type': 'quorum', 'x-delivery-limit': 3, 'x-dead-letter-exchange': 'acme.mcp.dlx',
                'x-max-length': 1000, 'x-overflow': 'reject-publish',
            },
        });
        expect(requests?.arguments).not.toHaveProperty('x-message-ttl');
        expect(t.queues.find((q) => q.role === 'control')).toMatchObject({ name: 'acme.od.ctl.i-1', exclusive: true, autoDelete: true, durable: false });
        expect(t.queues.find((q) => q.role === 'events')).toMatchObject({ name: 'acme.od.evt.i-1', exclusive: true, autoDelete: true });
        expect(t.queues.find((q) => q.role === 'dead')?.arguments).toEqual({ 'x-queue-type': 'quorum', 'x-max-length': 10_000, 'x-message-ttl': 86_400_000 });
        expect(t.bindings).toEqual([
            { queue: 'acme.od.requests', exchange: 'acme.mcp', pattern: 'req.od.#' },
            { queue: 'acme.od.ctl.i-1', exchange: 'acme.mcp', pattern: 'ntf.od.#' },
            { queue: 'acme.od.evt.i-1', exchange: 'acme.mcp.events', pattern: 'evt.od.#' },
            { queue: 'acme.mcp.dead', exchange: 'acme.mcp.dlx', pattern: '#' },
        ]);
    });

    it("legacy 'serve' binds the 1.x keys on the shared request queue; 'reject' binds none", () => {
        const serve = serverTopology({ ...options, legacy: 'serve' });
        expect(serve.exchanges.map((e) => e.name)).toContain('acme.mcp.routing');
        expect(serve.bindings.filter((b) => b.exchange === 'acme.mcp.routing')).toEqual([
            { queue: 'acme.od.requests', exchange: 'acme.mcp.routing', pattern: 'mcp.request.#' },
            { queue: 'acme.od.requests', exchange: 'acme.mcp.routing', pattern: 'mcp.client-notification.#' },
        ]);
        const reject = serverTopology({ ...options, legacy: 'reject' });
        expect(reject.bindings.some((b) => b.exchange === 'acme.mcp.routing')).toBe(false);
    });

    it.each([['maxQueuedRequests', 0], ['deadLetterTtlMs', 1.5], ['deadLetterMaxLength', -1]])('refuses an unbounded %s (I5)', (key, value) => {
        expect(() => serverTopology({ ...options, legacy: 'reject', [key]: value })).toThrow();
    });

    it('the era is the exchange, never the body (§11)', () => {
        expect(eraOfExchange('acme', 'acme.mcp')).toBe('modern');
        expect(eraOfExchange('acme', 'acme.mcp.routing')).toBe('legacy');
        expect(eraOfExchange('acme', 'acme.mcp.events')).toBeUndefined();
    });
});

describe('mirror edge cases (§8)', () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN };

    it('accepts UTF-8 bytes as a header value and compares them exactly', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'prompts/get', params: { name: 'résumé', _meta: meta } };
        const headers = { 'mcp-method': 'prompts/get', 'mcp-name': Buffer.from('résumé'), 'mcp-protocol-version': MODERN };
        expect(checkMirrors(message, 'req.od.prompts.get', headers, 'od')).toBeUndefined();
    });

    it('applies no Unicode normalisation: NFC and NFD differ', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'prompts/get', params: { name: 'résumé', _meta: meta } };
        const headers = { 'mcp-method': 'prompts/get', 'mcp-name': 'résumé', 'mcp-protocol-version': MODERN };
        expect(checkMirrors(message, 'req.od.prompts.get', headers, 'od')?.field).toBe('mcp-name');
    });

    it('a non-string header value is a mismatch, not a coercion', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: { _meta: meta } };
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list', 'mcp-protocol-version': 20260728 }, 'od')?.field)
            .toBe('mcp-protocol-version');
    });

    it('mcp-name on a method without one is a mismatch', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: { _meta: meta } };
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list', 'mcp-name': 'x', 'mcp-protocol-version': MODERN }, 'od')?.field)
            .toBe('mcp-name');
    });

    it('a body without the protocol-version key is not a mismatch; a header without a body value is', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list' }, 'od')).toBeUndefined();
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN }, 'od')?.field)
            .toBe('mcp-protocol-version');
    });

    it('a non-string protocol version in the body cannot be mirrored', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 1 } } };
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list' }, 'od')).toBeUndefined();
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': 'tools/list', 'mcp-protocol-version': '1' }, 'od')?.field)
            .toBe('mcp-protocol-version');
    });

    it('invalid UTF-8 bytes in a mirror are a mismatch', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
        expect(checkMirrors(message, 'req.od.tools.list', { 'mcp-method': new Uint8Array([0xff]) }, 'od')?.field).toBe('mcp-method');
    });
});

describe('deadlines (§6.3, §7.1)', () => {
    it.each([['30000', 30000], ['0', 0], ['007', undefined], ['-1', undefined], ['1.5', undefined], ['', undefined], [undefined, undefined]])(
        'parseExpiration(%p) = %p', (input, expected) => {
            expect(parseExpiration(input)).toBe(expected);
        });

    it('listen lifetime is the smaller of the server bound and the client expiration', () => {
        expect(listenLifetimeMs(undefined)).toBe(900_000);
        expect(listenLifetimeMs('60000')).toBe(60_000);
        expect(listenLifetimeMs('9999999')).toBe(900_000);
        expect(listenLifetimeMs('60000', 30_000)).toBe(30_000);
    });

    it('a custom minUsefulMs applies', () => {
        expect(requestDeadline('900', { consumedAt: 0, minUsefulMs: 1000 }).tooLate).toBe(true);
    });
});

describe('authInfo (§9.2)', () => {
    it('derives the exact shape from the principal', () => {
        expect(authInfoFor('alice', { brokerIdentity: 'rabbit-1', vhost: '/', scopesFor: (p) => (p === 'alice' ? ['od:read'] : undefined) }))
            .toEqual({
                token: '[redacted]',
                clientId: 'alice',
                scopes: ['od:read'],
                extra: { sub: 'alice', iss: 'amqp://rabbit-1/%2F', transport: 'amqp' },
            });
    });

    it('an unmapped principal has no scopes', () => {
        expect(authInfoFor('bob', { brokerIdentity: 'b', vhost: 'prod' }).scopes).toEqual([]);
    });

    it('two brokers\' guest users are different issuers', () => {
        expect(authInfoFor('guest', { brokerIdentity: 'a', vhost: 'v' }).extra.iss)
            .not.toBe(authInfoFor('guest', { brokerIdentity: 'b', vhost: 'v' }).extra.iss);
    });

    it('refuses an empty principal', () => {
        expect(() => authInfoFor('', { brokerIdentity: 'b', vhost: 'v' })).toThrow();
    });
});

describe('redelivery policy (§7.2 item 3)', () => {
    it.each([
        ['tools/list', undefined, 're-execute'],
        ['tools/call', { readOnlyHint: true }, 're-execute'],
        ['tools/call', { idempotentHint: true }, 're-execute'],
        ['tools/call', { readOnlyHint: false }, 'refuse'],
        ['tools/call', {}, 'refuse'],
        ['tools/call', undefined, 'refuse'],
    ] as const)('%s %j -> %s', (method, annotations, action) => {
        expect(redeliveryAction(method, annotations)).toBe(action);
    });
});
