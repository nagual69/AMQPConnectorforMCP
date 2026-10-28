import type { HeaderValue, InboundEnvelope, EnvelopeProperties } from '../types';

export const NAMES = { ns: 'acme', svc: 'od' } as const;
export const MODERN = '2026-07-28';
export const NOW = 1_800_000_000_000;

const encoder = new TextEncoder();

export function bytes(value: unknown): Uint8Array {
    return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
}

/** A well-formed modern tools/call as a conforming client would publish it. */
export function toolCall(name = 'ping', id: string | number = 1) {
    return {
        jsonrpc: '2.0' as const,
        id,
        method: 'tools/call',
        params: {
            name,
            arguments: { host: 'localhost' },
            _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN },
        },
    };
}

export function cancelled(requestId: string | number) {
    return {
        jsonrpc: '2.0' as const,
        method: 'notifications/cancelled',
        params: { requestId, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
    };
}

export function envelope(
    body: unknown,
    overrides: {
        routingKey?: string;
        headers?: Record<string, HeaderValue>;
        properties?: Partial<EnvelopeProperties>;
        redelivered?: boolean;
        raw?: Uint8Array;
        omit?: ReadonlyArray<keyof EnvelopeProperties>;
        omitHeaders?: readonly string[];
    } = {},
): InboundEnvelope {
    const message = body as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const isRequest = typeof message === 'object' && message !== null && 'id' in message;
    const method = typeof message?.method === 'string' ? message.method : 'tools/call';
    const segment = method.replace(/\//g, '.');
    const name = message?.params?.['name'];
    const defaultKey = isRequest
        ? `req.od.${segment}${method === 'tools/call' && typeof name === 'string' ? `.${name}` : ''}`
        : `ntf.od.${segment}`;
    const headers: Record<string, HeaderValue> = { 'mcp-method': method };
    if (isRequest && (method === 'tools/call' || method === 'prompts/get') && typeof name === 'string') headers['mcp-name'] = name;
    if (isRequest && method === 'resources/read' && typeof message.params?.['uri'] === 'string') headers['mcp-name'] = message.params['uri'] as string;
    const version = (message?.params?.['_meta'] as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/protocolVersion'];
    if (typeof version === 'string') headers['mcp-protocol-version'] = version;

    const properties: EnvelopeProperties = isRequest
        ? { messageId: 'msg-1', replyTo: 'amq.rabbitmq.reply-to.g1h2AA', userId: 'alice', expiration: '30000', contentType: 'application/json' }
        : { messageId: 'msg-n1', userId: 'alice', expiration: '30000', contentType: 'application/json' };

    const finalProperties: EnvelopeProperties = { ...properties, ...overrides.properties };
    for (const key of overrides.omit ?? []) delete finalProperties[key];
    const finalHeaders: Record<string, HeaderValue> = { ...headers, ...overrides.headers };
    for (const key of overrides.omitHeaders ?? []) delete finalHeaders[key];

    return {
        exchange: 'acme.mcp',
        routingKey: overrides.routingKey ?? defaultKey,
        body: overrides.raw ?? bytes(body),
        properties: finalProperties,
        headers: finalHeaders,
        redelivered: overrides.redelivered ?? false,
    };
}

export const OPTIONS = { svc: 'od', consumedAt: NOW } as const;
