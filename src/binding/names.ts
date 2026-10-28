/**
 * Names, routing keys and topology (BINDING §2, §4).
 */

import type { BindingNames } from './types.js';

/** `{ns}` and `{svc}`: no dots, so routing keys parse unambiguously (BINDING §2). */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** A tool name a routing key can carry (BINDING §4.2): the MCP tool-naming guidance. */
export const CARRIABLE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** AMQP 0-9.1 `shortstr`: a routing key, exchange or queue name is at most 255 bytes. */
export const MAX_ROUTING_KEY_BYTES = 255;

const encoder = new TextEncoder();

/** Throws unless `ns` and `svc` both satisfy {@link NAME_PATTERN}. */
export function assertBindingNames(names: BindingNames): void {
    for (const [label, value] of [['ns', names.ns], ['svc', names.svc]] as const) {
        if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
            throw new Error(`Invalid ${label} '${String(value)}': must match ${NAME_PATTERN.source}`);
        }
    }
}

/** `{method}` of BINDING §2: every `/` replaced by `.`. */
export function methodSegment(method: string): string {
    return method.replace(/\//g, '.');
}

function byteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

/** Whether `name` can travel as the `tools/call` routing-key suffix (BINDING §4.2). */
export function isCarriableToolName(name: unknown, svc: string): name is string {
    return typeof name === 'string'
        && CARRIABLE_TOOL_NAME.test(name)
        && byteLength(`req.${svc}.tools.call.${name}`) <= MAX_ROUTING_KEY_BYTES;
}

/**
 * The routing key for a client-to-server message, derived from its body
 * (BINDING §4.2). The server re-derives it on consume and rejects any
 * difference (§8), which is what makes tool authorization by topic
 * permission sound.
 *
 * Returns `undefined` when the key would exceed 255 bytes: such a message
 * cannot be published on this binding at all.
 */
export function routingKeyFor(
    kind: 'request' | 'notification',
    svc: string,
    method: string,
    params?: Record<string, unknown>,
): string | undefined {
    const prefix = kind === 'request' ? 'req' : 'ntf';
    let key = `${prefix}.${svc}.${methodSegment(method)}`;
    if (kind === 'request' && method === 'tools/call' && isCarriableToolName(params?.['name'], svc)) {
        key = `${key}.${params?.['name'] as string}`;
    }
    return byteLength(key) <= MAX_ROUTING_KEY_BYTES ? key : undefined;
}

/** Change-event key (BINDING §4.2, §6.5). */
export function eventRoutingKey(svc: string, kind: string): string {
    return `evt.${svc}.${kind}`;
}

/** Server-side dead-letter key (BINDING §7.4). */
export function deadLetterRoutingKey(svc: string, reason: string): string {
    return `dead.${svc}.${reason}`;
}

// ─── Topology (BINDING §4.1) ────────────────────────────────────────────────

export interface ExchangeDeclaration {
    name: string;
    type: 'topic';
    durable: true;
}

export interface QueueDeclaration {
    /** Purpose within the binding, for logs and tests. */
    role: 'requests' | 'control' | 'events' | 'dead';
    name: string;
    durable: boolean;
    exclusive: boolean;
    autoDelete: boolean;
    arguments: Record<string, string | number>;
}

export interface BindingDeclaration {
    queue: string;
    exchange: string;
    pattern: string;
}

export interface Topology {
    exchanges: ExchangeDeclaration[];
    queues: QueueDeclaration[];
    bindings: BindingDeclaration[];
}

export interface TopologyOptions extends BindingNames {
    /** `{instance}`: unique per process start, opaque (BINDING §2). */
    instance: string;
    /** `x-max-length` of the request queue. */
    maxQueuedRequests: number;
    /** `x-max-length` of `{ns}.mcp.dead`; set by the deployment. */
    deadLetterMaxLength: number;
    /** `x-message-ttl` of `{ns}.mcp.dead` in ms; set by the deployment. */
    deadLetterTtlMs: number;
    /** Serve the legacy era (BINDING §11). `'reject'` binds no legacy keys at all. */
    legacy: 'serve' | 'reject';
}

/** The exchanges of one namespace (BINDING §4.1). Clients need only `exchange`. */
export function exchangeNames(ns: string) {
    return {
        exchange: `${ns}.mcp`,
        eventsExchange: `${ns}.mcp.events`,
        deadLetterExchange: `${ns}.mcp.dlx`,
        legacyExchange: `${ns}.mcp.routing`,
    } as const;
}

/** Exchange and queue names for one server instance (BINDING §4.1). */
export function topologyNames(names: BindingNames, instance: string) {
    const { ns, svc } = names;
    return {
        ...exchangeNames(ns),
        requestQueue: `${ns}.${svc}.requests`,
        controlQueue: `${ns}.${svc}.ctl.${instance}`,
        eventQueue: `${ns}.${svc}.evt.${instance}`,
        deadLetterQueue: `${ns}.mcp.dead`,
    } as const;
}

/** The quorum queue's delivery limit. RabbitMQ 4.x defaults to 20 (BINDING §4.1 rule 3). */
export const REQUEST_DELIVERY_LIMIT = 3;

/**
 * Every object a server instance declares, with exactly the arguments of
 * BINDING §4.1. A profile declares these verbatim and fails to start on
 * `PRECONDITION_FAILED` (rule 1). The request queue deliberately has no
 * `x-message-ttl` (rule 3): per-request deadlines come from `expiration`.
 */
export function serverTopology(options: TopologyOptions): Topology {
    assertBindingNames(options);
    if (typeof options.instance !== 'string' || options.instance.length === 0) {
        throw new Error(`Invalid instance '${String(options.instance)}': must be a non-empty string`);
    }
    for (const key of ['maxQueuedRequests', 'deadLetterMaxLength', 'deadLetterTtlMs'] as const) {
        const value = options[key];
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`Invalid ${key} '${String(value)}': must be a positive integer`);
        }
    }

    const n = topologyNames(options, options.instance);
    const { svc } = options;
    for (const name of Object.values(n)) {
        if (byteLength(name) > MAX_ROUTING_KEY_BYTES) {
            throw new Error(`Object name '${name}' exceeds ${MAX_ROUTING_KEY_BYTES} bytes`);
        }
    }

    const exchanges: ExchangeDeclaration[] = [
        { name: n.exchange, type: 'topic', durable: true },
        { name: n.eventsExchange, type: 'topic', durable: true },
        { name: n.deadLetterExchange, type: 'topic', durable: true },
    ];
    if (options.legacy === 'serve') {
        exchanges.push({ name: n.legacyExchange, type: 'topic', durable: true });
    }

    const queues: QueueDeclaration[] = [
        {
            role: 'requests',
            name: n.requestQueue,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: {
                'x-queue-type': 'quorum',
                'x-delivery-limit': REQUEST_DELIVERY_LIMIT,
                'x-dead-letter-exchange': n.deadLetterExchange,
                'x-max-length': options.maxQueuedRequests,
                'x-overflow': 'reject-publish',
            },
        },
        { role: 'control', name: n.controlQueue, durable: false, exclusive: true, autoDelete: true, arguments: {} },
        { role: 'events', name: n.eventQueue, durable: false, exclusive: true, autoDelete: true, arguments: {} },
        {
            role: 'dead',
            name: n.deadLetterQueue,
            durable: true,
            exclusive: false,
            autoDelete: false,
            arguments: {
                'x-queue-type': 'quorum',
                'x-max-length': options.deadLetterMaxLength,
                'x-message-ttl': options.deadLetterTtlMs,
            },
        },
    ];

    const bindings: BindingDeclaration[] = [
        { queue: n.requestQueue, exchange: n.exchange, pattern: `req.${svc}.#` },
        { queue: n.controlQueue, exchange: n.exchange, pattern: `ntf.${svc}.#` },
        { queue: n.eventQueue, exchange: n.eventsExchange, pattern: `evt.${svc}.#` },
        { queue: n.deadLetterQueue, exchange: n.deadLetterExchange, pattern: '#' },
    ];
    if (options.legacy === 'serve') {
        bindings.push(
            { queue: n.requestQueue, exchange: n.legacyExchange, pattern: 'mcp.request.#' },
            { queue: n.requestQueue, exchange: n.legacyExchange, pattern: 'mcp.client-notification.#' },
        );
    }

    return { exchanges, queues, bindings };
}

/** The era of a consumed message is the exchange it arrived through (BINDING §11). */
export function eraOfExchange(ns: string, exchange: string): 'modern' | 'legacy' | undefined {
    const names = exchangeNames(ns);
    if (exchange === names.exchange) return 'modern';
    if (exchange === names.legacyExchange) return 'legacy';
    return undefined;
}
