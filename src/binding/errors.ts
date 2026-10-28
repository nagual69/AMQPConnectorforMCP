/**
 * Error codes and dead-letter reasons (BINDING §7.4, §8).
 */

import type { JsonRpcErrorResponse, JsonRpcId } from './types.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INTERNAL_ERROR = -32603;
/**
 * MCP 2026-07-28 `HeaderMismatch`, reused for an AMQP mirror mismatch.
 * Provisional: BINDING §8 item 4 and open item O-1.
 */
export const HEADER_MISMATCH = -32020;

/** The reasons a server instance dead-letters a message (BINDING §7.4). */
export type DeadLetterReason =
    | 'message-too-large'
    | 'parse-error'
    | 'invalid-request'
    | 'unaddressable'
    | 'invalid-notification'
    | 'principal-required'
    | 'mirror-mismatch'
    | 'deadline-exceeded';

/** `data.reason` of the redelivery refusal (BINDING §7.2 item 3). */
export const REDELIVERED_NON_IDEMPOTENT = 'redelivered-non-idempotent';

/** Header carrying the reason on a server-side dead letter (BINDING §7.4). */
export const REJECT_REASON_HEADER = 'x-mcp-reject-reason';
/**
 * Header carrying the original publisher's `user_id` on a dead letter. The
 * copy cannot keep `user_id` itself: RabbitMQ rejects a publish whose
 * `user_id` is not the publishing connection's user.
 */
export const ORIGINAL_USER_ID_HEADER = 'x-mcp-original-user-id';

export function errorResponse(
    id: JsonRpcId | null,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcErrorResponse {
    return {
        jsonrpc: '2.0',
        id,
        error: data === undefined ? { code, message } : { code, message, data },
    };
}

/** The refusal for a redelivered `tools/call` whose tool is not idempotent. */
export function redeliveredNonIdempotentResponse(id: JsonRpcId): JsonRpcErrorResponse {
    return errorResponse(id, INTERNAL_ERROR, 'Request was redelivered; the tool is not idempotent', {
        reason: REDELIVERED_NON_IDEMPOTENT,
    });
}
