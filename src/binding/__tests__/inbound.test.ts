/**
 * Inbound classification: the instance-side rows of the BINDING §7.4 fate
 * table, plus pins P2 (body identity), P8 (mirror mismatch is never
 * dispatched) and the unit half of P11 (deadline and unaddressable input).
 *
 * Assertions are about the decision binding-core produced, never about
 * constants copied from the implementation.
 */

import { classifyInbound, type InboundDecision, type Rejection } from '../inbound';
import { cancelled, envelope, NOW, OPTIONS, toolCall, bytes } from './helpers';

function expectReject(decision: InboundDecision): Rejection {
    expect(decision.kind).toBe('reject');
    if (decision.kind !== 'reject') throw new Error('unreachable');
    expect(decision.fate).toBe('dead-letter');
    return decision;
}

describe('a well-formed request is dispatched', () => {
    it('carries principal, addressing and deadline from the envelope', () => {
        const decision = classifyInbound(envelope(toolCall()), OPTIONS);
        expect(decision).toMatchObject({
            kind: 'request',
            principal: 'alice',
            messageId: 'msg-1',
            replyTo: 'amq.rabbitmq.reply-to.g1h2AA',
            method: 'tools/call',
            name: 'ping',
            redelivered: false,
            deadline: { deadlineAt: NOW + 30_000, remainingMs: 30_000, defaulted: false, tooLate: false },
        });
    });

    it('passes redelivered through for the §7.2 policy', () => {
        const decision = classifyInbound(envelope(toolCall(), { redelivered: true }), OPTIONS);
        expect(decision.kind === 'request' && decision.redelivered).toBe(true);
    });

    it('applies the default deadline when expiration is absent, and flags it', () => {
        const decision = classifyInbound(envelope(toolCall(), { omit: ['expiration'] }), { ...OPTIONS, defaultRequestMs: 5000 });
        expect(decision).toMatchObject({ kind: 'request', deadline: { remainingMs: 5000, defaulted: true } });
    });
});

describe('P2: the body is authoritative and travels octet for octet (I1)', () => {
    it('hands the engine the exact delivered bytes, not a re-serialisation', () => {
        // Whitespace and key order a JSON round-trip would not preserve.
        const raw = bytes('{ "params":{"name":"ping","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}},"method":"tools/call","id":  "x-7","jsonrpc":"2.0" }');
        const decision = classifyInbound(envelope(JSON.parse(new TextDecoder().decode(raw)), { raw }), OPTIONS);
        expect(decision.kind).toBe('request');
        if (decision.kind !== 'request') return;
        expect(decision.body).toBe(raw);
        expect(Buffer.from(decision.body).equals(Buffer.from(raw))).toBe(true);
        expect(decision.message.id).toBe('x-7');
    });

    it('never invents an id: an error for an unreadable body uses null', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw: bytes('{"jsonrpc":"2.0","id":4,') }), OPTIONS));
        expect(decision.reply?.response.id).toBeNull();
    });

    it('echoes the body id, byte-identical in type, on a shape error', () => {
        const decision = expectReject(classifyInbound(envelope({ jsonrpc: '2.0', id: '0042', method: 7 }), OPTIONS));
        expect(decision.reply?.response.id).toBe('0042');
    });
});

describe('§7.4 fate table', () => {
    it('message-too-large: -32600 with id null, before the body is parsed', () => {
        const raw = bytes('x'.repeat(65)); // not JSON either: size must win
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw }), { ...OPTIONS, maxMessageSize: 64 }));
        expect(decision.reason).toBe('message-too-large');
        expect(decision.reply?.response).toEqual({
            jsonrpc: '2.0', id: null,
            error: { code: -32600, message: expect.any(String), data: { reason: 'message-too-large', limit: 64 } },
        });
    });

    it('parse-error: invalid UTF-8 is -32700 even if it would decode leniently', () => {
        const raw = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]); // {"\xff":1}
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw }), OPTIONS));
        expect(decision.reason).toBe('parse-error');
        expect(decision.reply?.response.error.code).toBe(-32700);
        expect(decision.reply?.response.id).toBeNull();
    });

    it('parse-error: not JSON', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw: bytes('not json') }), OPTIONS));
        expect(decision.reason).toBe('parse-error');
    });

    it.each([
        ['a batch', [toolCall()]],
        ['a JSON-RPC response', { jsonrpc: '2.0', id: 1, result: {} }],
        ['a null id', { jsonrpc: '2.0', id: null, method: 'tools/list' }],
        ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 1, method: 'tools/list' }],
        ['non-object params', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1] }],
        ['a scalar', 42],
    ])('invalid-request: %s is -32600', (_label, body) => {
        const decision = expectReject(classifyInbound(envelope(body, {
            routingKey: 'req.od.tools.list',
            // Addressability is a property of the envelope, not the body.
            properties: { messageId: 'msg-1', replyTo: 'reply-q' },
        }), OPTIONS));
        expect(decision.reason).toBe('invalid-request');
        expect(decision.reply?.response.error.code).toBe(-32600);
    });

    it('principal-required: a request without user_id is -32600 with data.reason', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall('ping', 7), { omit: ['userId'] }), OPTIONS));
        expect(decision.reason).toBe('principal-required');
        expect(decision.reply?.response).toMatchObject({ id: 7, error: { code: -32600, data: { reason: 'principal-required' } } });
    });

    it('principal-required: an empty user_id is no principal', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { properties: { userId: '' } }), OPTIONS));
        expect(decision.reason).toBe('principal-required');
    });

    it('invalid-notification: a notification with reply_to, unanswered', () => {
        const decision = expectReject(classifyInbound(envelope(cancelled(1), { properties: { replyTo: 'q' } }), OPTIONS));
        expect(decision.reason).toBe('invalid-notification');
        expect(decision.reply).toBeUndefined();
    });

    it('a principal-less notification is dead-lettered without a reply', () => {
        const decision = expectReject(classifyInbound(envelope(cancelled(1), { omit: ['userId'] }), OPTIONS));
        expect(decision.reason).toBe('principal-required');
        expect(decision.reply).toBeUndefined();
    });

    it('an addressable error goes to reply_to with correlation_id = message_id', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw: bytes('nope') }), OPTIONS));
        expect(decision.reply).toMatchObject({ replyTo: 'amq.rabbitmq.reply-to.g1h2AA', correlationId: 'msg-1' });
    });
});

describe('P11 (unit): expired or unaddressable input is never dispatched', () => {
    it('deadline-exceeded below minUsefulMs, with no response', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { properties: { expiration: '249' } }), OPTIONS));
        expect(decision.reason).toBe('deadline-exceeded');
        expect(decision.reply).toBeUndefined();
    });

    it('exactly minUsefulMs remaining is still served', () => {
        const decision = classifyInbound(envelope(toolCall(), { properties: { expiration: '250' } }), OPTIONS);
        expect(decision.kind).toBe('request');
    });

    it('maxRequestMs caps a client deadline', () => {
        const decision = classifyInbound(envelope(toolCall(), { properties: { expiration: '999999' } }), { ...OPTIONS, maxRequestMs: 1000 });
        expect(decision).toMatchObject({ kind: 'request', deadline: { remainingMs: 1000 } });
    });

    it.each([
        ['message_id', 'messageId'],
        ['reply_to', 'replyTo'],
    ] as const)('unaddressable: a request without %s, with no response', (_label, key) => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { omit: [key] }), OPTIONS));
        expect(decision.reason).toBe('unaddressable');
        expect(decision.reply).toBeUndefined();
    });

    it('an unaddressable message that is also unparseable gets no response either', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), { raw: bytes('nope'), omit: ['replyTo'] }), OPTIONS));
        expect(decision.reason).toBe('parse-error');
        expect(decision.reply).toBeUndefined();
    });
});

describe('P8: a mirror mismatch is -32020 and dead-lettered, never dispatched (I6)', () => {
    it('the §8 example: a ping key carrying an nmap_scan body', () => {
        const decision = expectReject(classifyInbound(envelope(toolCall('nmap_scan', 7), { routingKey: 'req.od.tools.call.ping' }), OPTIONS));
        expect(decision.reason).toBe('mirror-mismatch');
        expect(decision.reply?.response).toEqual({
            jsonrpc: '2.0',
            id: 7,
            error: {
                code: -32020,
                message: "Mirror mismatch: routing key 'req.od.tools.call.ping' does not match body 'tools/call' name 'nmap_scan'",
                data: {
                    reason: 'mirror-mismatch',
                    mismatch: { field: 'routing-key', envelope: 'req.od.tools.call.ping', body: 'req.od.tools.call.nmap_scan' },
                },
            },
        });
    });

    it.each([
        ['mcp-method disagrees', { headers: { 'mcp-method': 'tools/list' } }, 'mcp-method'],
        ['mcp-method missing', { omitHeaders: ['mcp-method'] }, 'mcp-method'],
        ['mcp-name disagrees', { headers: { 'mcp-name': 'other' } }, 'mcp-name'],
        ['mcp-name missing', { omitHeaders: ['mcp-name'] }, 'mcp-name'],
        ['mcp-protocol-version disagrees', { headers: { 'mcp-protocol-version': '2025-11-25' } }, 'mcp-protocol-version'],
        ['mcp-protocol-version missing while the body carries it', { omitHeaders: ['mcp-protocol-version'] }, 'mcp-protocol-version'],
        ['a request key on the wrong svc', { routingKey: 'req.other.tools.call.ping' }, 'routing-key'],
        ['a notification key for a request', { routingKey: 'ntf.od.tools.call' }, 'routing-key'],
    ] as const)('%s', (_label, overrides, field) => {
        const decision = expectReject(classifyInbound(envelope(toolCall(), overrides), OPTIONS));
        expect(decision.reason).toBe('mirror-mismatch');
        expect(decision.mismatch?.field).toBe(field);
        expect(decision.reply?.response.error.code).toBe(-32020);
    });

    it('a mismatched notification is dead-lettered with no reply', () => {
        const decision = expectReject(classifyInbound(envelope(cancelled(1), { headers: { 'mcp-method': 'x' } }), OPTIONS));
        expect(decision.reason).toBe('mirror-mismatch');
        expect(decision.reply).toBeUndefined();
    });

    it('the mismatch check runs before the deadline check, so it is reported', () => {
        const decision = expectReject(classifyInbound(
            envelope(toolCall(), { headers: { 'mcp-name': 'other' }, properties: { expiration: '1' } }), OPTIONS));
        expect(decision.reason).toBe('mirror-mismatch');
    });
});

describe('client notifications', () => {
    it('a cancellation is dispatched with its mcp-request-message-id target', () => {
        const decision = classifyInbound(envelope(cancelled(1), { headers: { 'mcp-request-message-id': 'msg-1' } }), OPTIONS);
        expect(decision).toMatchObject({ kind: 'notification', principal: 'alice', method: 'notifications/cancelled', targetMessageId: 'msg-1' });
    });

    it('a cancellation without the header (an OASIS-only client) is still dispatched', () => {
        const decision = classifyInbound(envelope(cancelled(1)), OPTIONS);
        expect(decision).toMatchObject({ kind: 'notification', targetMessageId: undefined });
    });

    it('a malformed mcp-request-message-id is a mismatch', () => {
        const decision = expectReject(classifyInbound(envelope(cancelled(1), { headers: { 'mcp-request-message-id': '' } }), OPTIONS));
        expect(decision.mismatch?.field).toBe('mcp-request-message-id');
    });
});
