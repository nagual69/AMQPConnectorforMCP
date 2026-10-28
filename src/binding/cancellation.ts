/**
 * Exchange records and cancellation affinity (BINDING §6.1 item 3, §6.4).
 *
 * Every key here includes the principal, because a body `requestId` alone is
 * not safe: every client numbers its ids from the same start. Client A can
 * never cancel client B's `id: 1`.
 *
 * Pure state, no I/O. The clock is injected so the bounded pre-arrival
 * record can be tested deterministically.
 */

import type { JsonRpcId } from './types.js';

export interface ExchangeKey {
    principal: string;
    /** The request's `message_id`. */
    messageId: string;
    /** The request's JSON-RPC `id`, for the OASIS-only fallback. */
    requestId: JsonRpcId;
}

/** What a cancellation names. */
export interface CancellationTarget {
    /** The cancellation's broker-validated `user_id`. */
    principal: string;
    /** `mcp-request-message-id`, when the client set it. */
    targetMessageId: string | undefined;
    /** `params.requestId` of the `notifications/cancelled` body. */
    requestId: unknown;
}

export type CancellationMatch<T> =
    | { kind: 'matched'; key: ExchangeKey; record: T; via: 'message-id' | 'request-id' }
    /** Header present, no record yet: remembered in case the request arrives later (§6.4 item 5). */
    | { kind: 'recorded' }
    /** Fallback key matched more than one exchange of this principal: nothing is cancelled. */
    | { kind: 'ambiguous'; count: number }
    | { kind: 'unmatched' };

export interface ExchangeRegistryOptions {
    /**
     * How long an unmatched header-keyed cancellation is remembered: the
     * longest request deadline the server accepts (§6.4 item 5).
     */
    pendingTtlMs: number;
    /** Bound on remembered cancellations (§6.4 item 5 MUST). */
    maxPending: number;
    /** Reports an eviction before its TTL (§6.4 item 5 SHOULD). */
    onEvict?: (principal: string, messageId: string) => void;
    now?: () => number;
}

function key2(principal: string, part: string): string {
    // Principals and message ids are arbitrary strings; JSON keeps the pair unambiguous.
    return JSON.stringify([principal, part]);
}

function requestIdKey(id: JsonRpcId): string {
    return `${typeof id}:${String(id)}`;
}

export class ExchangeRegistry<T> {
    private readonly byMessageId = new Map<string, { key: ExchangeKey; record: T }>();
    private readonly byRequestId = new Map<string, Set<string>>();
    /** Insertion-ordered, so the oldest entry is evicted first. Value: expiry. */
    private readonly pending = new Map<string, number>();
    private readonly now: () => number;

    constructor(private readonly options: ExchangeRegistryOptions) {
        if (!(options.pendingTtlMs > 0) || !Number.isSafeInteger(options.maxPending) || options.maxPending <= 0) {
            throw new Error('ExchangeRegistry needs a positive pendingTtlMs and maxPending');
        }
        this.now = options.now ?? Date.now;
    }

    get size(): number {
        return this.byMessageId.size;
    }

    get pendingCount(): number {
        this.expirePending();
        return this.pending.size;
    }

    /**
     * Registers an exchange before dispatch. Returns `'cancelled'` when a
     * cancellation for it already arrived: the request is then acked and
     * dropped with no response (§6.4 item 5), and nothing is registered.
     */
    register(key: ExchangeKey, record: T): 'registered' | 'cancelled' | 'duplicate' {
        const id = key2(key.principal, key.messageId);
        this.expirePending();
        if (this.pending.delete(id)) return 'cancelled';
        if (this.byMessageId.has(id)) return 'duplicate';
        this.byMessageId.set(id, { key, record });
        const rid = key2(key.principal, requestIdKey(key.requestId));
        let set = this.byRequestId.get(rid);
        if (set === undefined) {
            set = new Set();
            this.byRequestId.set(rid, set);
        }
        set.add(id);
        return 'registered';
    }

    get(principal: string, messageId: string): T | undefined {
        return this.byMessageId.get(key2(principal, messageId))?.record;
    }

    /** Discards an exchange record once the engine has released it. */
    release(principal: string, messageId: string): boolean {
        const id = key2(principal, messageId);
        const entry = this.byMessageId.get(id);
        if (entry === undefined) return false;
        this.byMessageId.delete(id);
        const rid = key2(principal, requestIdKey(entry.key.requestId));
        const set = this.byRequestId.get(rid);
        set?.delete(id);
        if (set?.size === 0) this.byRequestId.delete(rid);
        return true;
    }

    /**
     * Matches a cancellation (§6.4 item 3). With the header, the lookup is
     * exact. Without it, the body `requestId` is used within the principal;
     * if that names more than one exchange, nothing is cancelled, because
     * cancelling the wrong exchange is worse than a missed best-effort
     * cancellation.
     */
    matchCancellation(target: CancellationTarget): CancellationMatch<T> {
        if (target.targetMessageId !== undefined) {
            const id = key2(target.principal, target.targetMessageId);
            const entry = this.byMessageId.get(id);
            if (entry !== undefined) return { kind: 'matched', key: entry.key, record: entry.record, via: 'message-id' };
            this.remember(id);
            return { kind: 'recorded' };
        }
        const requestId = target.requestId;
        if (typeof requestId !== 'string' && !(typeof requestId === 'number' && Number.isFinite(requestId))) {
            return { kind: 'unmatched' };
        }
        const set = this.byRequestId.get(key2(target.principal, requestIdKey(requestId)));
        if (set === undefined || set.size === 0) return { kind: 'unmatched' };
        if (set.size > 1) return { kind: 'ambiguous', count: set.size };
        const [only] = set;
        const entry = this.byMessageId.get(only as string);
        return entry === undefined
            ? { kind: 'unmatched' }
            : { kind: 'matched', key: entry.key, record: entry.record, via: 'request-id' };
    }

    private remember(id: string): void {
        this.expirePending();
        this.pending.delete(id);
        this.pending.set(id, this.now() + this.options.pendingTtlMs);
        while (this.pending.size > this.options.maxPending) {
            const [oldest] = this.pending.keys();
            if (oldest === undefined) break;
            this.pending.delete(oldest);
            if (this.options.onEvict !== undefined) {
                const [p, m] = JSON.parse(oldest) as [string, string];
                this.options.onEvict(p, m);
            }
        }
    }

    private expirePending(): void {
        const now = this.now();
        for (const [id, expiresAt] of this.pending) {
            if (expiresAt > now) break; // insertion order == expiry order (constant TTL)
            this.pending.delete(id);
        }
    }
}
