/**
 * P7: cancellation affinity (BINDING §6.4). A cancel from principal A never
 * aborts principal B's exchange with the same body id; the
 * mcp-request-message-id path hits; the body-id fallback hits for the same
 * principal only.
 */

import { ExchangeRegistry } from '../cancellation';

function registry(now = { t: 0 }, extra: Partial<ConstructorParameters<typeof ExchangeRegistry>[0]> = {}) {
    return new ExchangeRegistry<string>({ pendingTtlMs: 1000, maxPending: 3, now: () => now.t, ...extra });
}

describe('P7: cancellation affinity', () => {
    it('header path: (principal, mcp-request-message-id) finds exactly that exchange', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm-a', requestId: 1 }, 'A');
        r.register({ principal: 'bob', messageId: 'm-b', requestId: 1 }, 'B');
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: 'm-a', requestId: 1 }))
            .toMatchObject({ kind: 'matched', record: 'A', via: 'message-id' });
    });

    it('principal A can never cancel principal B, even naming B\'s message_id', () => {
        const r = registry();
        r.register({ principal: 'bob', messageId: 'm-b', requestId: 1 }, 'B');
        const match = r.matchCancellation({ principal: 'alice', targetMessageId: 'm-b', requestId: 1 });
        expect(match.kind).not.toBe('matched');
        // And the recorded pre-arrival entry is A's, so it cannot drop B's request either.
        expect(r.get('bob', 'm-b')).toBe('B');
    });

    it('fallback path: (principal, params.requestId) hits for the same principal only', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm-a', requestId: 1 }, 'A');
        r.register({ principal: 'bob', messageId: 'm-b', requestId: 1 }, 'B');
        expect(r.matchCancellation({ principal: 'bob', targetMessageId: undefined, requestId: 1 }))
            .toMatchObject({ kind: 'matched', record: 'B', via: 'request-id' });
        expect(r.matchCancellation({ principal: 'carol', targetMessageId: undefined, requestId: 1 }))
            .toEqual({ kind: 'unmatched' });
    });

    it('fallback distinguishes 1 from "1"', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm-a', requestId: '1' }, 'A');
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: undefined, requestId: 1 }).kind).toBe('unmatched');
    });

    it('fallback that names two exchanges of one principal cancels neither', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm-1', requestId: 1 }, 'first');
        r.register({ principal: 'alice', messageId: 'm-2', requestId: 1 }, 'second');
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: undefined, requestId: 1 }))
            .toEqual({ kind: 'ambiguous', count: 2 });
    });

    it('a principal containing the separator cannot collide with another pair', () => {
        const r = registry();
        r.register({ principal: 'a","b', messageId: 'c', requestId: 1 }, 'X');
        expect(r.get('a', 'b","c')).toBeUndefined();
    });
});

describe('cancellation before its request (§6.4 item 5)', () => {
    it('a remembered cancellation drops the request when it arrives', () => {
        const r = registry();
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: 'm-late', requestId: 9 })).toEqual({ kind: 'recorded' });
        expect(r.register({ principal: 'alice', messageId: 'm-late', requestId: 9 }, 'L')).toBe('cancelled');
        expect(r.size).toBe(0);
    });

    it('it is keyed by principal: another principal\'s request with that message_id is served', () => {
        const r = registry();
        r.matchCancellation({ principal: 'alice', targetMessageId: 'm-x', requestId: 9 });
        expect(r.register({ principal: 'bob', messageId: 'm-x', requestId: 9 }, 'B')).toBe('registered');
    });

    it('fallback-keyed cancellations are not remembered', () => {
        const r = registry();
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: undefined, requestId: 9 })).toEqual({ kind: 'unmatched' });
        expect(r.pendingCount).toBe(0);
    });

    it('an entry expires after pendingTtlMs', () => {
        const clock = { t: 0 };
        const r = registry(clock);
        r.matchCancellation({ principal: 'alice', targetMessageId: 'm', requestId: 1 });
        clock.t = 1000;
        expect(r.register({ principal: 'alice', messageId: 'm', requestId: 1 }, 'M')).toBe('registered');
    });

    it('the record is bounded and reports evictions, oldest first', () => {
        const evicted: string[] = [];
        const r = registry({ t: 0 }, { onEvict: (p, m) => evicted.push(`${p}/${m}`) });
        for (const m of ['m1', 'm2', 'm3', 'm4']) r.matchCancellation({ principal: 'alice', targetMessageId: m, requestId: 1 });
        expect(r.pendingCount).toBe(3);
        expect(evicted).toEqual(['alice/m1']);
    });
});

describe('exchange records', () => {
    it('release discards both indexes', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm', requestId: 1 }, 'M');
        expect(r.release('alice', 'm')).toBe(true);
        expect(r.matchCancellation({ principal: 'alice', targetMessageId: undefined, requestId: 1 })).toEqual({ kind: 'unmatched' });
        expect(r.release('alice', 'm')).toBe(false);
    });

    it('a second registration of the same (principal, message_id) is a duplicate', () => {
        const r = registry();
        r.register({ principal: 'alice', messageId: 'm', requestId: 1 }, 'M');
        expect(r.register({ principal: 'alice', messageId: 'm', requestId: 2 }, 'N')).toBe('duplicate');
        expect(r.get('alice', 'm')).toBe('M');
    });

    it('rejects unbounded configuration', () => {
        expect(() => new ExchangeRegistry({ pendingTtlMs: 0, maxPending: 1 })).toThrow();
        expect(() => new ExchangeRegistry({ pendingTtlMs: 1, maxPending: Infinity })).toThrow();
    });
});
