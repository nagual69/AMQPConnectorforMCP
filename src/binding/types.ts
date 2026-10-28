/**
 * binding-core types.
 *
 * Everything in src/binding is pure: no amqplib, no SDK, no I/O. A profile
 * (AMQP 0-9.1 today, AMQP 1.0 in Phase 5) translates its client library's
 * message into an {@link InboundEnvelope}, asks binding-core what to do with
 * it, and performs the I/O itself. That split is what lets the wire rules of
 * docs/BINDING.md be tested exhaustively without a broker.
 */

// ─── JSON-RPC (the subset the binding inspects) ────────────────────────────

export type JsonRpcId = string | number;

/** A JSON-RPC request: it has an `id`. */
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
}

/** A JSON-RPC notification: no `id` member at all. */
export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: JsonRpcId | null;
    error: JsonRpcErrorObject;
}

// ─── Envelope ───────────────────────────────────────────────────────────────

/**
 * Header values as a client library hands them over. amqplib decodes AMQP
 * long strings to `string`; other libraries may surface raw bytes.
 */
export type HeaderValue = string | Uint8Array | number | boolean | null | undefined | object;

/**
 * The AMQP message properties binding-core reads or writes (BINDING §5.2).
 * Names follow amqplib's camelCase spelling of the 0-9.1 basic properties.
 */
export interface EnvelopeProperties {
    messageId?: string;
    replyTo?: string;
    correlationId?: string;
    userId?: string;
    /** Remaining deadline in milliseconds, as a decimal string (BINDING §7.1). */
    expiration?: string;
    /** Seconds since the epoch. */
    timestamp?: number;
    contentType?: string;
    contentEncoding?: string;
    deliveryMode?: 1 | 2;
    appId?: string;
}

/** One message as consumed from the broker, in profile-neutral form. */
export interface InboundEnvelope {
    /** The exchange the message was published to. */
    exchange: string;
    routingKey: string;
    /** The body octets, exactly as delivered (I1). */
    body: Uint8Array;
    properties: EnvelopeProperties;
    headers: Readonly<Record<string, HeaderValue>>;
    /** 0-9.1 `redelivered`; 1.0 `delivery-count > 0`. */
    redelivered: boolean;
}

/** One message binding-core wants published. The profile does the publish. */
export interface OutboundEnvelope {
    /** `""` is the default exchange (replies go there, keyed by `reply_to`). */
    exchange: string;
    routingKey: string;
    body: Uint8Array;
    properties: EnvelopeProperties;
    headers: Record<string, HeaderValue>;
    /** Always true on this binding (BINDING §5.2, §7.3). */
    mandatory: true;
}

// ─── Deployment names ───────────────────────────────────────────────────────

/** `{ns}` and `{svc}` of BINDING §2. */
export interface BindingNames {
    ns: string;
    svc: string;
}
