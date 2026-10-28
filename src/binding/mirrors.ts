/**
 * Mirrors and mismatch handling (BINDING §5.2, §8).
 *
 * A mirror is an envelope field copied from the body. Brokers route on the
 * routing key and §9.3 lets a deployment authorize tools by it, so every
 * mirror is re-derived from the body here and compared as an exact string.
 * Authorization never reads a mirror; it reads the principal and the body.
 */

import { routingKeyFor } from './names.js';
import type { HeaderValue, JsonRpcNotification, JsonRpcRequest } from './types.js';

export const HEADER_PROTOCOL_VERSION = 'mcp-protocol-version';
export const HEADER_METHOD = 'mcp-method';
export const HEADER_NAME = 'mcp-name';
export const HEADER_REQUEST_MESSAGE_ID = 'mcp-request-message-id';
export const HEADER_TRACEPARENT = 'traceparent';
export const HEADER_TRACESTATE = 'tracestate';

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

/** `mcp-request-message-id` form bound (BINDING §8 item 1). */
export const MAX_REQUEST_MESSAGE_ID_BYTES = 256;

export type MirrorField = 'routing-key' | typeof HEADER_METHOD | typeof HEADER_NAME | typeof HEADER_PROTOCOL_VERSION | typeof HEADER_REQUEST_MESSAGE_ID;

/** A mirror that disagrees with the body, or a required mirror that is missing. */
export interface MirrorMismatch {
    field: MirrorField;
    /** The value derived from the body; `undefined` when the mirror must be absent. */
    expected: string | undefined;
    /** The value on the envelope; `undefined` when missing. */
    actual: string | undefined;
    /** Human-readable, in the shape of BINDING §8 item 4's example. */
    message: string;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/**
 * A header as an exact string, or `undefined` when absent. A value that is
 * neither a string nor UTF-8 bytes yields `null`: it can never equal a body
 * string, so it is a mismatch rather than a coercion.
 */
export function headerString(headers: Readonly<Record<string, HeaderValue>>, name: string): string | undefined | null {
    const value = headers[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) {
        try {
            return strictUtf8.decode(value);
        } catch {
            return null;
        }
    }
    return null;
}

function metaOf(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const meta = params?.['_meta'];
    return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : undefined;
}

/** `params._meta[key]` when it is a string. */
export function metaString(params: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = metaOf(params)?.[key];
    return typeof value === 'string' ? value : undefined;
}

/** Whether `params._meta` carries `key` at all, whatever its type. */
function metaHas(params: Record<string, unknown> | undefined, key: string): boolean {
    const meta = metaOf(params);
    return meta !== undefined && Object.prototype.hasOwnProperty.call(meta, key);
}

/**
 * The `mcp-name` value the body implies: `params.name` for `tools/call` and
 * `prompts/get`, `params.uri` for `resources/read`, absent otherwise.
 */
export function expectedNameMirror(message: JsonRpcRequest | JsonRpcNotification): string | undefined {
    if (!('id' in message)) return undefined;
    const field = message.method === 'tools/call' || message.method === 'prompts/get'
        ? 'name'
        : message.method === 'resources/read' ? 'uri' : undefined;
    if (field === undefined) return undefined;
    const value = message.params?.[field];
    return typeof value === 'string' ? value : undefined;
}

function describe(value: string | undefined | null): string {
    return value === undefined ? 'absent' : value === null ? 'not a string' : `'${value}'`;
}

function mismatch(field: MirrorField, expected: string | undefined, actual: string | undefined | null, message: string): MirrorMismatch {
    return { field, expected, actual: actual ?? undefined, message };
}

/**
 * Checks every mirror of a consumed client-to-server message (BINDING §8
 * item 1). Returns the first mismatch, or `undefined` when all agree.
 * The message MUST NOT be dispatched when this returns a mismatch.
 */
export function checkMirrors(
    message: JsonRpcRequest | JsonRpcNotification,
    routingKey: string,
    headers: Readonly<Record<string, HeaderValue>>,
    svc: string,
): MirrorMismatch | undefined {
    const isRequest = 'id' in message;

    // Routing key, re-derived from the body.
    const expectedKey = routingKeyFor(isRequest ? 'request' : 'notification', svc, message.method, message.params);
    if (routingKey !== expectedKey) {
        const name = expectedNameMirror(message);
        return mismatch(
            'routing-key',
            expectedKey,
            routingKey,
            `Mirror mismatch: routing key '${routingKey}' does not match body '${message.method}'`
                + (message.method === 'tools/call' && name !== undefined ? ` name '${name}'` : ''),
        );
    }

    // mcp-method: required on every client message.
    const method = headerString(headers, HEADER_METHOD);
    if (method !== message.method) {
        return mismatch(HEADER_METHOD, message.method, method,
            `Mirror mismatch: header ${HEADER_METHOD} is ${describe(method)} but body method is '${message.method}'`);
    }

    // mcp-name: required where the body implies one, absent otherwise.
    const expectedName = expectedNameMirror(message);
    const name = headerString(headers, HEADER_NAME);
    if (name !== expectedName) {
        return mismatch(HEADER_NAME, expectedName, name,
            `Mirror mismatch: header ${HEADER_NAME} is ${describe(name)} but the body implies ${describe(expectedName)}`);
    }

    // mcp-protocol-version: mirrors _meta when the body carries it. A body
    // without the key is not a mismatch (§8 item 3); the engine rejects it.
    const expectedVersion = metaString(message.params, PROTOCOL_VERSION_META_KEY);
    const version = headerString(headers, HEADER_PROTOCOL_VERSION);
    if (expectedVersion === undefined && metaHas(message.params, PROTOCOL_VERSION_META_KEY)) {
        // The body carries the key with a non-string value; no header can equal it.
        if (version !== undefined) {
            return mismatch(HEADER_PROTOCOL_VERSION, undefined, version,
                `Mirror mismatch: header ${HEADER_PROTOCOL_VERSION} is ${describe(version)} but the body's protocol version is not a string`);
        }
    } else if (version !== expectedVersion) {
        return mismatch(HEADER_PROTOCOL_VERSION, expectedVersion, version,
            `Mirror mismatch: header ${HEADER_PROTOCOL_VERSION} is ${describe(version)} but the body carries ${describe(expectedVersion)}`);
    }

    // mcp-request-message-id: not a mirror; form only.
    const target = headerString(headers, HEADER_REQUEST_MESSAGE_ID);
    if (target !== undefined && (target === null || target.length === 0 || encoder.encode(target).byteLength > MAX_REQUEST_MESSAGE_ID_BYTES)) {
        return mismatch(HEADER_REQUEST_MESSAGE_ID, undefined, target,
            `Mirror mismatch: header ${HEADER_REQUEST_MESSAGE_ID} must be a non-empty string of at most ${MAX_REQUEST_MESSAGE_ID_BYTES} bytes`);
    }

    return undefined;
}
