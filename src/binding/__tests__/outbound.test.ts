/**
 * Outbound envelopes: pin P3 (correlation_id = the request's message_id,
 * and no server message without it), the client properties and mirrors of
 * BINDING §5.2, and the dead-letter copy of §7.4.
 */

import { classifyInbound } from '../inbound';
import { buildClientNotification, buildClientRequest, buildDeadLetter, buildServerMessage } from '../outbound';
import { cancelled, envelope, NAMES, NOW, OPTIONS, toolCall } from './helpers';

const decoder = new TextDecoder();
let seq = 0;
const ids = () => `id-${++seq}`;

describe('P3: correlation_id is the request message_id, byte-identical (I2)', () => {
    it('a response correlates to the message_id binding-core read from the request', () => {
        const decision = classifyInbound(envelope(toolCall(), { properties: { messageId: 'Ünïcode-message-id-\u{1F680}' } }), OPTIONS);
        if (decision.kind !== 'request') throw new Error('expected a request');
        const reply = buildServerMessage('{"jsonrpc":"2.0","id":1,"result":{}}', {
            principal: 'od-server', requestMessageId: decision.messageId, replyTo: decision.replyTo,
        });
        expect(reply.properties.correlationId).toBe('Ünïcode-message-id-\u{1F680}');
        expect(reply.exchange).toBe('');
        expect(reply.routingKey).toBe(decision.replyTo);
        expect(reply.properties.messageId).not.toBe(decision.messageId);
    });

    it.each(['', undefined])('there is no way to build a server message without it (%p)', (value) => {
        expect(() => buildServerMessage('{}', { principal: 's', requestMessageId: value as unknown as string, replyTo: 'q' })).toThrow(/I2/);
    });

    it('nor without a reply_to', () => {
        expect(() => buildServerMessage('{}', { principal: 's', requestMessageId: 'm', replyTo: '' })).toThrow(/I3/);
    });

    it('the body is published as given, not re-serialised', () => {
        const body = new TextEncoder().encode('{ "jsonrpc" : "2.0", "id":1, "result":{} }');
        expect(buildServerMessage(body, { principal: 's', requestMessageId: 'm', replyTo: 'q' }).body).toBe(body);
    });

    it('every server message gets a fresh message_id, its own user_id and mandatory', () => {
        const a = buildServerMessage('{}', { principal: 'od-server', requestMessageId: 'm', replyTo: 'q' });
        const b = buildServerMessage('{}', { principal: 'od-server', requestMessageId: 'm', replyTo: 'q' });
        expect(a.properties.messageId).not.toBe(b.properties.messageId);
        expect(a.properties.userId).toBe('od-server');
        expect(a.mandatory).toBe(true);
        expect(a.properties.deliveryMode).toBe(1);
    });
});

describe('client requests (§5.2)', () => {
    const base = { names: NAMES, principal: 'alice', replyTo: 'amq.rabbitmq.reply-to', newMessageId: ids, now: () => NOW };

    it('round-trips through classifyInbound as a dispatchable request', () => {
        const out = buildClientRequest(toolCall('nmap_scan', 3), { ...base, deadlineMs: 30_000 });
        const decision = classifyInbound({ ...out, redelivered: false }, OPTIONS);
        expect(decision).toMatchObject({ kind: 'request', principal: 'alice', name: 'nmap_scan', messageId: out.properties.messageId });
    });

    it('sets properties, mirrors and the tool-suffixed key', () => {
        const out = buildClientRequest(toolCall('nmap_scan', 3), { ...base, deadlineMs: 1234.9 });
        expect(out).toMatchObject({
            exchange: 'acme.mcp',
            routingKey: 'req.od.tools.call.nmap_scan',
            mandatory: true,
            properties: { userId: 'alice', replyTo: 'amq.rabbitmq.reply-to', expiration: '1234', deliveryMode: 2, contentType: 'application/json', timestamp: NOW / 1000 },
            headers: { 'mcp-method': 'tools/call', 'mcp-name': 'nmap_scan', 'mcp-protocol-version': '2026-07-28' },
        });
        expect(out.properties.correlationId).toBeUndefined();
        expect(JSON.parse(decoder.decode(out.body))).toEqual(toolCall('nmap_scan', 3));
    });

    it('an expired deadline still publishes a positive expiration', () => {
        expect(buildClientRequest(toolCall(), { ...base, deadlineMs: -5 }).properties.expiration).toBe('1');
    });

    it('mirrors resources/read uri, and traceparent from _meta', () => {
        const message = {
            jsonrpc: '2.0' as const, id: 1, method: 'resources/read',
            params: { uri: 'file:///ü', _meta: { traceparent: '00-abc-def-01', 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
        };
        const out = buildClientRequest(message, { ...base, deadlineMs: 1000 });
        expect(out.routingKey).toBe('req.od.resources.read');
        expect(out.headers).toMatchObject({ 'mcp-name': 'file:///ü', traceparent: '00-abc-def-01' });
        expect(classifyInbound({ ...out, redelivered: false }, OPTIONS).kind).toBe('request');
    });

    it('refuses a method that cannot fit a routing key', () => {
        const message = { jsonrpc: '2.0' as const, id: 1, method: 'x/'.repeat(200) };
        expect(() => buildClientRequest(message, { ...base, deadlineMs: 1000 })).toThrow(/routing key/);
    });
});

describe('client notifications (§5.2, §6.4)', () => {
    it('a cancellation carries mcp-request-message-id and fans out on ntf.', () => {
        const out = buildClientNotification(cancelled(3), { names: NAMES, principal: 'alice', targetMessageId: 'm-3' });
        expect(out).toMatchObject({
            routingKey: 'ntf.od.notifications.cancelled',
            properties: { deliveryMode: 1, expiration: '30000' },
            headers: { 'mcp-request-message-id': 'm-3', 'mcp-method': 'notifications/cancelled' },
        });
        expect(out.properties.replyTo).toBeUndefined();
        const decision = classifyInbound({ ...out, redelivered: false }, OPTIONS);
        expect(decision).toMatchObject({ kind: 'notification', targetMessageId: 'm-3' });
    });

    it('a cancellation without its target message_id is refused (C3)', () => {
        expect(() => buildClientNotification(cancelled(3), { names: NAMES, principal: 'alice' })).toThrow(/6\.4/);
    });
});

describe('dead-letter copy (§7.4)', () => {
    const original = envelope(toolCall(), { headers: { 'x-mcp-original-user-id': 'spoofed', 'x-mcp-reject-reason': 'spoofed' } });

    it('keeps the body and properties, moves user_id, drops expiration', () => {
        const dl = buildDeadLetter(original, { names: NAMES, reason: 'mirror-mismatch', principal: 'od-server' });
        expect(dl).toMatchObject({
            exchange: 'acme.mcp.dlx',
            routingKey: 'dead.od.mirror-mismatch',
            mandatory: true,
            properties: { userId: 'od-server', messageId: 'msg-1', replyTo: original.properties.replyTo },
            headers: { 'x-mcp-reject-reason': 'mirror-mismatch', 'x-mcp-original-user-id': 'alice', 'mcp-method': 'tools/call' },
        });
        expect(dl.body).toBe(original.body);
        expect(dl.properties.expiration).toBeUndefined();
    });

    it('a client cannot plant x-mcp-original-user-id on a principal-less message', () => {
        const noUser = envelope(toolCall(), { omit: ['userId'], headers: { 'x-mcp-original-user-id': 'admin' } });
        const dl = buildDeadLetter(noUser, { names: NAMES, reason: 'principal-required', principal: 'od-server' });
        expect(dl.headers['x-mcp-original-user-id']).toBeUndefined();
    });
});
