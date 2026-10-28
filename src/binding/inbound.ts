/**
 * Inbound classification: what a server instance does with one consumed
 * modern-era message (BINDING §6.1 items 1–3, §7.1, §7.4, §8).
 *
 * The result is a decision, not an action. `dispatch` means "hand the body
 * to the serving engine"; `reject` carries the error response to publish (if
 * the message is addressable) and the dead-letter reason. Nothing that
 * returns `reject` may reach the engine.
 */

import { requestDeadline, type DeadlineOptions, type RequestDeadline } from './deadline.js';
import {
    errorResponse,
    HEADER_MISMATCH,
    INVALID_REQUEST,
    PARSE_ERROR,
    type DeadLetterReason,
} from './errors.js';
import { checkMirrors, expectedNameMirror, headerString, HEADER_REQUEST_MESSAGE_ID, type MirrorMismatch } from './mirrors.js';
import type { InboundEnvelope, JsonRpcErrorResponse, JsonRpcId, JsonRpcNotification, JsonRpcRequest } from './types.js';

/** Default `maxMessageSize` (§7.4): 1 MiB. */
export const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

export interface ClassifyOptions extends Omit<DeadlineOptions, 'consumedAt'> {
    svc: string;
    /** Consume time, ms since the epoch. */
    consumedAt: number;
    maxMessageSize?: number;
}

/** A request the engine should serve. */
export interface DispatchRequest {
    kind: 'request';
    message: JsonRpcRequest;
    /** The exact body octets (I1). Forward these, not a re-serialisation. */
    body: Uint8Array;
    principal: string;
    messageId: string;
    replyTo: string;
    method: string;
    /** `params.name` or `params.uri`, when the method has one. */
    name: string | undefined;
    deadline: RequestDeadline;
    redelivered: boolean;
}

/** A client notification for the instance to act on (in practice, cancellations). */
export interface DispatchNotification {
    kind: 'notification';
    message: JsonRpcNotification;
    body: Uint8Array;
    principal: string;
    /** Clients MUST set it (§5.2), but a notification lacking it is still actionable. */
    messageId: string | undefined;
    method: string;
    /** `mcp-request-message-id`, on `notifications/cancelled` (§6.4 item 2). */
    targetMessageId: string | undefined;
}

/** A message the instance must not dispatch. */
export interface Rejection {
    kind: 'reject';
    reason: DeadLetterReason;
    /** Every rejection is dead-lettered (§7.4). */
    fate: 'dead-letter';
    /** The error to publish, when the message is addressable and the table gives one. */
    reply: { replyTo: string; correlationId: string; response: JsonRpcErrorResponse } | undefined;
    /** Set for `mirror-mismatch`. */
    mismatch?: MirrorMismatch;
    detail: string;
}

export type InboundDecision = DispatchRequest | DispatchNotification | Rejection;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function nonEmpty(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/** The body's `id`, when it can be read as a JSON-RPC id; otherwise `null` (OASIS JSON-RPC-AMQP §6.5). */
function readableId(parsed: unknown): JsonRpcId | null {
    return isPlainObject(parsed) && isId(parsed['id']) ? parsed['id'] : null;
}

/**
 * Narrows a parsed body to a JSON-RPC request or notification as MCP
 * 2026-07-28 accepts them: `jsonrpc: "2.0"`, a string `method`, `params`
 * absent or an object, and either a string/number `id` (request) or no
 * `id` member at all (notification). A `null` id, a response object and a
 * batch are all invalid requests.
 */
function asClientMessage(parsed: unknown): JsonRpcRequest | JsonRpcNotification | undefined {
    if (!isPlainObject(parsed)) return undefined;
    if (parsed['jsonrpc'] !== '2.0' || typeof parsed['method'] !== 'string') return undefined;
    if ('result' in parsed || 'error' in parsed) return undefined;
    if ('params' in parsed && !isPlainObject(parsed['params'])) return undefined;
    if ('id' in parsed) {
        return isId(parsed['id']) ? parsed as unknown as JsonRpcRequest : undefined;
    }
    return parsed as unknown as JsonRpcNotification;
}

/**
 * Classifies one message consumed from `{ns}.mcp` (the modern era).
 *
 * Checks run in the order of the §7.4 fate table, so a message failing
 * several is rejected for the first: size, then parse, then shape, then
 * addressability, then principal, then mirrors, then deadline.
 */
export function classifyInbound(envelope: InboundEnvelope, options: ClassifyOptions): InboundDecision {
    const { properties, body } = envelope;
    const messageId = nonEmpty(properties.messageId);
    const replyTo = nonEmpty(properties.replyTo);
    const addressable = messageId !== undefined && replyTo !== undefined;

    const reject = (
        reason: DeadLetterReason,
        detail: string,
        response?: JsonRpcErrorResponse,
        mismatch?: MirrorMismatch,
    ): Rejection => ({
        kind: 'reject',
        reason,
        fate: 'dead-letter',
        reply: addressable && response !== undefined
            ? { replyTo: replyTo as string, correlationId: messageId as string, response }
            : undefined,
        ...(mismatch !== undefined && { mismatch }),
        detail,
    });

    // 1. Size, before anything is parsed.
    const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
    if (body.byteLength > maxMessageSize) {
        return reject('message-too-large', `body is ${body.byteLength} bytes; the limit is ${maxMessageSize}`,
            errorResponse(null, INVALID_REQUEST, 'Invalid Request: message too large', {
                reason: 'message-too-large',
                limit: maxMessageSize,
            }));
    }

    // 2. UTF-8 and JSON.
    let parsed: unknown;
    try {
        parsed = JSON.parse(strictUtf8.decode(body));
    } catch {
        return reject('parse-error', 'body is not UTF-8 JSON',
            errorResponse(null, PARSE_ERROR, 'Parse error', { reason: 'parse-error' }));
    }

    // 3. JSON-RPC shape. Batches are not supported by MCP 2026-07-28 (§5.1 item 3).
    const message = asClientMessage(parsed);
    if (message === undefined) {
        const detail = Array.isArray(parsed) ? 'body is a batch' : 'body is not a JSON-RPC request or notification';
        return reject('invalid-request', detail,
            errorResponse(readableId(parsed), INVALID_REQUEST, 'Invalid Request', { reason: 'invalid-request' }));
    }
    const isRequest = 'id' in message;

    // 4. Addressability.
    if (isRequest && !addressable) {
        return reject('unaddressable', 'request lacks message_id or reply_to');
    }
    if (!isRequest && replyTo !== undefined) {
        return reject('invalid-notification', 'notification carries reply_to');
    }

    // 5. Principal: only ever the broker-validated user_id (§9.1 item 3).
    const principal = nonEmpty(properties.userId);
    if (principal === undefined) {
        return reject('principal-required', 'user_id is absent',
            isRequest
                ? errorResponse(message.id, INVALID_REQUEST, 'Invalid Request: user_id is required', { reason: 'principal-required' })
                : undefined);
    }

    // 6. Mirrors (§8). A mismatch is never dispatched.
    const mismatch = checkMirrors(message, envelope.routingKey, envelope.headers, options.svc);
    if (mismatch !== undefined) {
        return reject('mirror-mismatch', mismatch.message,
            isRequest
                ? errorResponse(message.id, HEADER_MISMATCH, mismatch.message, {
                    reason: 'mirror-mismatch',
                    mismatch: { field: mismatch.field, envelope: mismatch.actual ?? null, body: mismatch.expected ?? null },
                })
                : undefined,
            mismatch);
    }

    if (!isRequest) {
        const target = headerString(envelope.headers, HEADER_REQUEST_MESSAGE_ID);
        return {
            kind: 'notification',
            message,
            body,
            principal,
            messageId,
            method: message.method,
            targetMessageId: typeof target === 'string' ? target : undefined,
        };
    }

    // 7. Deadline (§7.1 item 3). The client has given up: no response.
    const deadline = requestDeadline(properties.expiration, options);
    if (deadline.tooLate) {
        return reject('deadline-exceeded', `${deadline.remainingMs} ms remaining`);
    }

    return {
        kind: 'request',
        message,
        body,
        principal,
        messageId: messageId as string,
        replyTo: replyTo as string,
        method: message.method,
        name: expectedNameMirror(message),
        deadline,
        redelivered: envelope.redelivered,
    };
}
