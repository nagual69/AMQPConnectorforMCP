/**
 * Outbound envelopes (BINDING §4.2, §5.2, §7.4).
 *
 * Builders never touch a body they are given: a server message is published
 * byte for byte as the serving engine produced it (§5.1 item 4). Only
 * client builders serialise, because the client is where a message first
 * becomes octets.
 */

import { randomUUID } from 'node:crypto';
import { deadLetterRoutingKey, exchangeNames, routingKeyFor } from './names.js';
import { ORIGINAL_USER_ID_HEADER, REJECT_REASON_HEADER, type DeadLetterReason } from './errors.js';
import {
    expectedNameMirror,
    HEADER_METHOD,
    HEADER_NAME,
    HEADER_PROTOCOL_VERSION,
    HEADER_REQUEST_MESSAGE_ID,
    HEADER_TRACEPARENT,
    HEADER_TRACESTATE,
    metaString,
    PROTOCOL_VERSION_META_KEY,
} from './mirrors.js';
import type {
    BindingNames,
    EnvelopeProperties,
    HeaderValue,
    InboundEnvelope,
    JsonRpcNotification,
    JsonRpcRequest,
    OutboundEnvelope,
} from './types.js';

export const CONTENT_TYPE = 'application/json';
/** Default `expiration` on client notifications (§5.2: SHOULD, for example 30000). */
export const DEFAULT_NOTIFICATION_EXPIRATION_MS = 30_000;

const encoder = new TextEncoder();

export interface BuildCommon {
    /** The publishing connection's user; RabbitMQ rejects any other value (§9.1 item 2). */
    principal: string;
    /** Injected for tests; a fresh UUID by default (§5.2: never reused). */
    newMessageId?: () => string;
    /** ms since the epoch; for `timestamp`. */
    now?: () => number;
    appId?: string;
}

function nowSeconds(now: (() => number) | undefined): number {
    return Math.floor((now ?? Date.now)() / 1000);
}

function expirationString(ms: number): string {
    if (!Number.isFinite(ms)) throw new Error(`Invalid expiration ${ms}`);
    // RabbitMQ requires a non-negative integer; 0 would expire unless a consumer is ready now.
    return String(Math.max(1, Math.floor(ms)));
}

function traceHeaders(params: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    const traceparent = metaString(params, HEADER_TRACEPARENT);
    const tracestate = metaString(params, HEADER_TRACESTATE);
    if (traceparent !== undefined) out[HEADER_TRACEPARENT] = traceparent;
    if (tracestate !== undefined) out[HEADER_TRACESTATE] = tracestate;
    return out;
}

function common(options: BuildCommon): Pick<EnvelopeProperties, 'messageId' | 'userId' | 'timestamp' | 'contentType' | 'appId'> {
    return {
        messageId: (options.newMessageId ?? randomUUID)(),
        userId: options.principal,
        timestamp: nowSeconds(options.now),
        contentType: CONTENT_TYPE,
        ...(options.appId !== undefined && { appId: options.appId }),
    };
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface ClientRequestOptions extends BuildCommon {
    names: BindingNames;
    /** Direct reply-to or the client's exclusive reply queue. */
    replyTo: string;
    /** The client's remaining wait (§7.1 item 1). */
    deadlineMs: number;
}

/**
 * A request as a client publishes it: properties and mirrors per §5.2 and
 * the routing key per §4.2. Throws if the key would exceed 255 bytes.
 */
export function buildClientRequest(message: JsonRpcRequest, options: ClientRequestOptions): OutboundEnvelope {
    const routingKey = routingKeyFor('request', options.names.svc, message.method, message.params);
    if (routingKey === undefined) {
        throw new Error(`Method '${message.method}' does not fit an AMQP routing key`);
    }
    const headers: Record<string, HeaderValue> = { [HEADER_METHOD]: message.method, ...traceHeaders(message.params) };
    const name = expectedNameMirror(message);
    if (name !== undefined) headers[HEADER_NAME] = name;
    const version = metaString(message.params, PROTOCOL_VERSION_META_KEY);
    if (version !== undefined) headers[HEADER_PROTOCOL_VERSION] = version;

    return {
        exchange: exchangeNames(options.names.ns).exchange,
        routingKey,
        body: encoder.encode(JSON.stringify(message)),
        properties: {
            ...common(options),
            replyTo: options.replyTo,
            expiration: expirationString(options.deadlineMs),
            deliveryMode: 2,
        },
        headers,
        mandatory: true,
    };
}

export interface ClientNotificationOptions extends BuildCommon {
    names: BindingNames;
    /** For `notifications/cancelled`: the cancelled request's `message_id` (§6.4 item 2). */
    targetMessageId?: string;
    expirationMs?: number;
}

/** A client notification: no `reply_to`, fans out to every instance (§4.1 rule 5). */
export function buildClientNotification(message: JsonRpcNotification, options: ClientNotificationOptions): OutboundEnvelope {
    const routingKey = routingKeyFor('notification', options.names.svc, message.method, message.params);
    if (routingKey === undefined) {
        throw new Error(`Method '${message.method}' does not fit an AMQP routing key`);
    }
    const headers: Record<string, HeaderValue> = { [HEADER_METHOD]: message.method, ...traceHeaders(message.params) };
    const version = metaString(message.params, PROTOCOL_VERSION_META_KEY);
    if (version !== undefined) headers[HEADER_PROTOCOL_VERSION] = version;
    if (message.method === 'notifications/cancelled') {
        if (options.targetMessageId === undefined || options.targetMessageId.length === 0) {
            throw new Error('notifications/cancelled needs the cancelled request\'s message_id (BINDING §6.4 item 2)');
        }
        headers[HEADER_REQUEST_MESSAGE_ID] = options.targetMessageId;
    }

    return {
        exchange: exchangeNames(options.names.ns).exchange,
        routingKey,
        body: encoder.encode(JSON.stringify(message)),
        properties: {
            ...common(options),
            expiration: expirationString(options.expirationMs ?? DEFAULT_NOTIFICATION_EXPIRATION_MS),
            deliveryMode: 1,
        },
        headers,
        mandatory: true,
    };
}

// ─── Server ─────────────────────────────────────────────────────────────────

export interface ServerMessageOptions extends BuildCommon {
    /** The request's `message_id`; becomes `correlation_id` byte for byte (I2). */
    requestMessageId: string;
    /** The request's `reply_to`, verbatim. */
    replyTo: string;
    /** Optional `expiration` (§5.2: MAY on listen stream messages). */
    expirationMs?: number;
    /** `traceparent`/`tracestate` propagated from the request (§10 item 1). */
    trace?: Readonly<Record<string, string>>;
}

/**
 * A server message about one request: a response or a request-scoped
 * notification. It goes to the default exchange keyed by the request's
 * `reply_to`, and nowhere else (I3). There is deliberately no way to build
 * one without the request's `message_id` (P3).
 */
export function buildServerMessage(body: Uint8Array | string, options: ServerMessageOptions): OutboundEnvelope {
    if (typeof options.requestMessageId !== 'string' || options.requestMessageId.length === 0) {
        throw new Error('A server message needs the request\'s message_id as correlation_id (BINDING I2)');
    }
    if (typeof options.replyTo !== 'string' || options.replyTo.length === 0) {
        throw new Error('A server message needs the request\'s reply_to (BINDING I3)');
    }
    const headers: Record<string, HeaderValue> = {};
    for (const name of [HEADER_TRACEPARENT, HEADER_TRACESTATE]) {
        const value = options.trace?.[name];
        if (value !== undefined) headers[name] = value;
    }
    return {
        exchange: '',
        routingKey: options.replyTo,
        body: typeof body === 'string' ? encoder.encode(body) : body,
        properties: {
            ...common(options),
            correlationId: options.requestMessageId,
            deliveryMode: 1,
            ...(options.expirationMs !== undefined && { expiration: expirationString(options.expirationMs) }),
        },
        headers,
        mandatory: true,
    };
}

export interface DeadLetterOptions {
    names: BindingNames;
    reason: DeadLetterReason;
    /** The server instance's own principal. */
    principal: string;
}

/**
 * The copy a server publishes to `{ns}.mcp.dlx` before acking the original
 * (§7.4). The body and the other properties are kept, with three changes:
 *
 * - `user_id` becomes the server's own, because RabbitMQ rejects any other.
 *   The original principal moves to `x-mcp-original-user-id`.
 * - `expiration` is dropped, so the evidence outlives the request deadline.
 *   The dead queue's own `x-message-ttl` bounds it instead.
 * - `x-mcp-reject-reason` carries the reason.
 */
export function buildDeadLetter(original: InboundEnvelope, options: DeadLetterOptions): OutboundEnvelope {
    const properties: EnvelopeProperties = { ...original.properties, userId: options.principal };
    delete properties.expiration;
    const userId = original.properties.userId;
    const headers: Record<string, HeaderValue> = { ...original.headers, [REJECT_REASON_HEADER]: options.reason };
    if (userId !== undefined) headers[ORIGINAL_USER_ID_HEADER] = userId;
    else delete headers[ORIGINAL_USER_ID_HEADER];
    return {
        exchange: exchangeNames(options.names.ns).deadLetterExchange,
        routingKey: deadLetterRoutingKey(options.names.svc, options.reason),
        body: original.body,
        properties,
        headers,
        mandatory: true,
    };
}
