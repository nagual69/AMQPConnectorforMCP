/**
 * Redelivery and side effects (BINDING §7.2 item 3).
 *
 * MCP's own tool annotations are the idempotency contract. Without a
 * pool-wide dedup store, nothing stronger is available.
 */

export interface ToolAnnotationHints {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
}

/**
 * Whether a redelivered request may be re-executed. Anything other than
 * `tools/call` is re-executed. A `tools/call` is re-executed only when its
 * tool is annotated `readOnlyHint: true` or `idempotentHint: true`; an
 * unknown tool or missing annotations mean refuse.
 */
export function redeliveryAction(
    method: string,
    annotations: ToolAnnotationHints | undefined,
): 're-execute' | 'refuse' {
    if (method !== 'tools/call') return 're-execute';
    return annotations?.readOnlyHint === true || annotations?.idempotentHint === true ? 're-execute' : 'refuse';
}
