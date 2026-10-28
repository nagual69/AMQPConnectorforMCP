/**
 * Deadlines and listen lifetimes (BINDING §6.3 item 3, §7.1).
 */

/** Requests consumed with less than this remaining are not dispatched (§7.1 item 3; O-6). */
export const DEFAULT_MIN_USEFUL_MS = 250;
/** Listen stream lifetime bound (§6.3 item 3). */
export const DEFAULT_MAX_LISTEN_MS = 900_000;
/**
 * Deadline for a request that carries no usable `expiration`. Clients MUST
 * set one (§7.1 item 1); this keeps the exchange bounded (I5) when one does
 * not. It matches the SDK's DEFAULT_REQUEST_TIMEOUT_MSEC.
 */
export const DEFAULT_REQUEST_MS = 60_000;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Parses an `expiration` property: a non-negative decimal string of
 * milliseconds. Returns `undefined` for anything else.
 */
export function parseExpiration(expiration: string | undefined): number | undefined {
    if (expiration === undefined || !DECIMAL.test(expiration)) return undefined;
    const ms = Number(expiration);
    return Number.isSafeInteger(ms) ? ms : undefined;
}

export interface DeadlineOptions {
    /** Consume time, ms since the epoch. */
    consumedAt: number;
    minUsefulMs?: number;
    /** Used when `expiration` is absent or unusable. */
    defaultRequestMs?: number;
    /** Upper bound on any request deadline the server accepts. */
    maxRequestMs?: number;
}

export interface RequestDeadline {
    /** Absolute deadline, ms since the epoch. */
    deadlineAt: number;
    remainingMs: number;
    /** True when the client set no usable `expiration` and the default applied. */
    defaulted: boolean;
    /** True when less than `minUsefulMs` remains: dead-letter, do not dispatch. */
    tooLate: boolean;
}

/**
 * The exchange deadline for a consumed request (§7.1 item 2).
 *
 * The remaining time is measured from consume time. RabbitMQ does not
 * decrement `expiration` while a message waits in a queue, so this is an
 * upper bound on the client's real remaining wait. That is acceptable
 * because the client's own timeout is authoritative (§7.1 item 4): when it
 * fires, the client sends a cancellation, which aborts the exchange.
 */
export function requestDeadline(expiration: string | undefined, options: DeadlineOptions): RequestDeadline {
    const minUsefulMs = options.minUsefulMs ?? DEFAULT_MIN_USEFUL_MS;
    const parsed = parseExpiration(expiration);
    let remainingMs = parsed ?? options.defaultRequestMs ?? DEFAULT_REQUEST_MS;
    if (options.maxRequestMs !== undefined) remainingMs = Math.min(remainingMs, options.maxRequestMs);
    return {
        deadlineAt: options.consumedAt + remainingMs,
        remainingMs,
        defaulted: parsed === undefined,
        tooLate: remainingMs < minUsefulMs,
    };
}

/**
 * The lifetime of a listen stream: the smaller of the server bound and the
 * client's `expiration`, when the client set one (§6.3 item 3).
 */
export function listenLifetimeMs(expiration: string | undefined, maxListenMs: number = DEFAULT_MAX_LISTEN_MS): number {
    const requested = parseExpiration(expiration);
    return requested === undefined ? maxListenMs : Math.min(requested, maxListenMs);
}
