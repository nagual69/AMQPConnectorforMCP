/**
 * Principal to `authInfo` (BINDING §9.1, §9.2).
 *
 * The shape matches the SDK's `AuthInfo` structurally, so it can be passed
 * to `createMcpHandler().fetch(request, { authInfo })` without binding-core
 * importing the SDK.
 */

export interface AmqpAuthInfo {
    /** No bearer exists on this transport. This is never a credential. */
    token: '[redacted]';
    clientId: string;
    scopes: string[];
    extra: {
        sub: string;
        /** The broker and virtual host that authenticated the principal. */
        iss: string;
        transport: 'amqp';
    };
}

export interface AuthInfoOptions {
    /** Names the broker, for example its cluster name or host. */
    brokerIdentity: string;
    vhost: string;
    /** Server-side mapping from principal to scopes; `[]` when unmapped. */
    scopesFor?: (principal: string) => readonly string[] | undefined;
}

/**
 * Derives `authInfo` from a broker-validated principal. Pass only the
 * consumed message's `user_id` here, never a header or body field
 * (§9.1 item 3).
 */
export function authInfoFor(principal: string, options: AuthInfoOptions): AmqpAuthInfo {
    if (typeof principal !== 'string' || principal.length === 0) {
        throw new Error('authInfoFor needs a non-empty broker-validated principal');
    }
    const scopes = options.scopesFor?.(principal) ?? [];
    return {
        token: '[redacted]',
        clientId: principal,
        scopes: [...scopes],
        extra: {
            sub: principal,
            iss: `amqp://${options.brokerIdentity}/${encodeURIComponent(options.vhost)}`,
            transport: 'amqp',
        },
    };
}
