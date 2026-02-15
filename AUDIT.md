# AMQP MCP Transport — Architectural & Best Practice Audit

**Audit Date:** 2026-02-15
**MCP Specification Reference:** [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
**SDK Reference:** [@modelcontextprotocol/sdk (TypeScript)](https://github.com/modelcontextprotocol/typescript-sdk)
**Codebase:** `amqp-mcp-transport` v1.0.0

---

## Executive Summary

This audit evaluates the AMQP transport implementation against two goals:

1. **MCP specification compliance** — Does the transport conform to the normative requirements of the MCP protocol?
2. **Reusability as a general-purpose transport** — Can any MCP project adopt this transport without modification?

**Overall assessment:** The transport demonstrates strong engineering fundamentals — correlation-based response routing, automatic reconnection, session-based queue management — but has **6 critical** and **9 major** findings that must be addressed before it can be considered spec-compliant and adoptable as a general-purpose MCP transport.

The most impactful issues are: (1) a custom envelope format that violates the JSON-RPC message preservation requirement, (2) hardcoded application-specific routing logic that couples the transport to the MCP Open Discovery project, and (3) the `TransportSendOptions.relatedRequestId` field being silently ignored, which breaks the SDK's response-routing contract.

---

## Table of Contents

1. [Findings Summary](#findings-summary)
2. [CRITICAL — MCP Specification Compliance](#critical--mcp-specification-compliance)
3. [CRITICAL — Reusability & Separation of Concerns](#critical--reusability--separation-of-concerns)
4. [MAJOR — Protocol & Lifecycle Issues](#major--protocol--lifecycle-issues)
5. [MAJOR — Code Quality & Correctness](#major--code-quality--correctness)
6. [MODERATE — Security & Robustness](#moderate--security--robustness)
7. [MINOR — Style, Maintenance & Testing](#minor--style-maintenance--testing)
8. [What's Working Well](#whats-working-well)
9. [Remediation Plan](#remediation-plan)
10. [Appendix: MCP Transport Interface Contract](#appendix-mcp-transport-interface-contract)

---

## Findings Summary

| Severity | Count | Category |
|----------|-------|----------|
| CRITICAL | 6 | Spec violation, reusability blockers |
| MAJOR | 9 | Protocol, lifecycle, correctness |
| MODERATE | 5 | Security, robustness |
| MINOR | 8 | Style, testing, maintenance |

---

## CRITICAL — MCP Specification Compliance

### C1. Envelope Wrapping Violates JSON-RPC Message Preservation

**Files:** `amqp-client-transport.ts:156-163`, `types.ts:68-83`

**Spec Requirement:** *"Implementers who choose to support custom transports MUST ensure they preserve the JSON-RPC message format."* ([MCP Transports Spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports))

**Finding:** The client wraps every JSON-RPC message in a custom `AMQPMessage` envelope:

```typescript
// Current: wraps JSON-RPC inside a custom envelope
const envelope: AMQPMessage = {
    message,          // JSON-RPC buried inside
    timestamp: Date.now(),
    type: messageType,
    correlationId
};
Buffer.from(JSON.stringify(envelope))  // Sent on the wire
```

The server then has to detect and unwrap both formats (lines 456-466, 614-620), adding complexity and fragility. The MCP spec is clear: the **wire format MUST be JSON-RPC**. Transport metadata (correlationId, replyTo, timestamp) belongs in AMQP message properties, not in the message body.

**Fix:** Send raw JSON-RPC as the message body. Use AMQP's built-in message properties for transport metadata:
```typescript
channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(jsonRpcMessage)), {
    correlationId,
    replyTo: responseQueue,
    timestamp: Date.now(),
    contentType: 'application/json'
});
```

---

### C2. `TransportSendOptions.relatedRequestId` Silently Ignored

**Files:** `amqp-client-transport.ts:140`, `amqp-server-transport.ts:202`

**SDK Contract:** The Protocol class passes `relatedRequestId` when sending responses so the transport can correlate outgoing responses with the incoming request that triggered them:
```typescript
// From Protocol.request():
this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken });
```

**Finding:** Both transports accept `_options?: TransportSendOptions` and completely ignore it (the underscore prefix indicates intentional discard). The server's `handleResponseMessage()` at line 540 looks up routing info by `message.id` instead of using `relatedRequestId`.

This works coincidentally because JSON-RPC response IDs match request IDs, but:
- It violates the SDK's explicit contract
- It fails if the SDK ever changes the correlation model
- `resumptionToken` and `onresumptiontoken` are also silently dropped — these are used for long-running request resumption in the 2025-11-25 spec

**Fix:** Use `options.relatedRequestId` as the primary key for routing info lookup in the server. Store routing info keyed by `RequestId`. Pass through `resumptionToken`/`onresumptiontoken` support or clearly document that these are not yet supported.

---

### C3. Server Injects `jsonrpc: '2.0'` Into Malformed Messages

**File:** `amqp-server-transport.ts:469-472`

```typescript
if (!('jsonrpc' in jsonRpcMessage) || !jsonRpcMessage.jsonrpc) {
    const base = jsonRpcMessage as unknown as Record<string, unknown>;
    jsonRpcMessage = { ...base, jsonrpc: '2.0' } as JSONRPCMessage;
}
```

**Finding:** This silently "repairs" invalid messages. If a message lacks the mandatory `jsonrpc: "2.0"` field, it is **not** a valid JSON-RPC 2.0 message and must be rejected. Auto-fixing masks protocol errors and can hide incompatible clients or man-in-the-middle modifications.

**Fix:** Reject messages that don't have `jsonrpc: "2.0"` with an appropriate error. Nack the AMQP message and log the rejection.

---

### C4. Reconnection Fires After Intentional `close()`

**Files:** `amqp-client-transport.ts:250-253`, `amqp-server-transport.ts:304-308`

**Finding:** The connection `'close'` event handler unconditionally calls `scheduleReconnect()`:
```typescript
conn.on('close', () => {
    this.connectionState.connected = false;
    console.log('[AMQP Server] Connection closed, scheduling reconnect...');
    this.scheduleReconnect();
});
```

When `close()` is called intentionally (e.g., during shutdown), this still triggers reconnection attempts. The transport will try to reconnect to a broker it just deliberately disconnected from.

**Fix:** Add a `closing` flag set at the start of `close()`. Check it in the `'close'` event handler:
```typescript
private closing = false;

async close(): Promise<void> {
    this.closing = true;
    // ... existing cleanup
}

conn.on('close', () => {
    if (!this.closing) {
        this.scheduleReconnect();
    }
});
```

---

### C5. `onclose` Not Called When Max Reconnection Attempts Exhausted

**Files:** `amqp-client-transport.ts:559-564`, `amqp-server-transport.ts:776-781`

**SDK Contract:** *"`onclose` — Callback for when the connection is closed for any reason. This should be invoked when close() is called as well."*

**Finding:** When `scheduleReconnect()` exceeds `maxReconnectAttempts`, only `onerror` is called:
```typescript
if (this.connectionState.reconnectAttempts >= maxAttempts) {
    const error = new Error('Maximum reconnection attempts exceeded');
    this.onerror?.(error);
    return;  // onclose never fires!
}
```

The Protocol class relies on `onclose` to clean up response handlers and reject pending requests. Without it, the Protocol enters a permanently stuck state — pending requests never resolve or reject.

**Fix:** Call `this.onclose?.()` after exhausting reconnection attempts.

---

### C6. `onmessage` Getter Returns Wrong Callable for SDK

**File:** `amqp-server-transport.ts:88-91`

```typescript
get onmessage(): (...) => void {
    return this._onmessageUser ?? (() => { });
}
```

**Finding:** The Protocol class in the SDK does this during `connect()`:
```typescript
const _onmessage = this._transport?.onmessage;  // reads the getter
this._transport.onmessage = (message, extra) => {
    _onmessage?.(message, extra);  // chains previous handler
    // ... SDK routing logic
};
```

The getter returns `_onmessageUser`, but the setter wraps the handler in `_onmessageInner` (adding timing/tracking). When the SDK reads `onmessage` to chain it, it gets the raw user handler, not the wrapper. The tracking wrapper's logic will be bypassed for any pre-existing handler. More critically, if no handler was set before `connect()`, the getter returns a no-op, and the SDK chains a no-op — this is correct by accident but fragile.

**Fix:** Remove the custom getter/setter pattern. Let the SDK own the `onmessage` callback directly (it already wraps/chains it). If debug timing is needed, implement it as opt-in middleware, not by intercepting the Transport interface contract.

---

## CRITICAL — Reusability & Separation of Concerns

### C7. Hardcoded Application-Specific Tool Categories

**Files:** `amqp-client-transport.ts:644-654`, `amqp-server-transport.ts:681-691`, `amqp-utils.ts:62-72`

**Finding:** The `getToolCategory()` function is defined **three times** with identical application-specific logic:
```typescript
if (method.startsWith('nmap_')) return 'nmap';
if (method.startsWith('snmp_')) return 'snmp';
if (method.startsWith('proxmox_')) return 'proxmox';
if (method.startsWith('zabbix_')) return 'zabbix';
// ... network tools, memory_, credentials_, registry_
```

These categories (nmap, snmp, proxmox, zabbix, etc.) are specific to the MCP Open Discovery project. A generic AMQP transport should know nothing about what tools exist. This is the **single biggest barrier** to adoption by other projects.

The routing keys are also contaminated: `mcp.request.nmap.nmap_scan` makes no sense for a project that doesn't use nmap.

**Fix:**
1. Remove all hardcoded tool categories from the transport
2. Use the JSON-RPC method name directly in routing keys: `mcp.request.{method}` (with `/` replaced by `.`)
3. If advanced category routing is desired, make it configurable via an optional `routingKeyStrategy` callback:
   ```typescript
   interface AMQPTransportOptions {
       routingKeyStrategy?: (method: string, messageType: string) => string;
   }
   ```
4. Move `TOOL_CATEGORIES` and `getToolCategory()` to the Open Discovery project, not the transport library

---

## MAJOR — Protocol & Lifecycle Issues

### M1. Dual Message Format Creates Interoperability Risk

**Files:** `amqp-server-transport.ts:453-466`, `amqp-server-transport.ts:611-620`

**Finding:** The server accepts two message formats:
1. Envelope: `{ message: {jsonrpc...}, timestamp, type, correlationId }`
2. Direct: `{ jsonrpc: "2.0", id: 1, method: "..." }`

This dual-format support exists because the client sends envelopes (C1) but the server also needs to handle direct JSON-RPC. Once C1 is fixed (sending raw JSON-RPC), the envelope format support should be removed entirely.

**Fix:** After fixing C1, remove all envelope detection/unwrapping logic. Accept only raw JSON-RPC messages.

---

### M2. Duplicate Message Consumption — Two Consumers for Same Requests

**Files:** `amqp-server-transport.ts:342-362`, `amqp-server-transport.ts:367-432`

**Finding:** The server sets up **two** consumers that both handle incoming requests:
1. `setupBasicInfrastructure()` — consumes from `${queuePrefix}.requests` (durable, shared)
2. `setupBidirectionalChannels()` — consumes from `${queuePrefix}.requests.${sessionId}` (exclusive, session-specific)

The bidirectional queue binds to `mcp.request.#` on the routing exchange, but the basic queue is also active. A single request could potentially be consumed twice if it arrives on both queues. This also means messages sent directly to the basic queue (without going through the routing exchange) bypass the bidirectional channel's routing info storage.

**Fix:** Consolidate to a single consumption path. The bidirectional channel approach is superior — remove the basic infrastructure queue consumer or make it a fallback that's only used when bidirectional channels aren't available.

---

### M3. `await Promise.resolve()` Anti-Pattern

**Files:** `amqp-client-transport.ts:370,403,421`, `amqp-server-transport.ts:233`

```typescript
private async handleRequestMessage(envelope: AMQPMessage): Promise<void> {
    await Promise.resolve();  // No-op await
    // ... synchronous code follows
}
```

**Finding:** Multiple methods use `await Promise.resolve()` purely to maintain an async signature. This adds a microtask queue delay for no benefit and obscures whether the method actually performs async work.

**Fix:** If the method is synchronous, make it synchronous. The `send()` method that calls these handlers is already `async` and can call synchronous helpers directly.

---

### M4. Server `send()` Uses `message.id` Instead of `relatedRequestId` for Routing Lookup

**File:** `amqp-server-transport.ts:211`

```typescript
if ('id' in message && message.id && this.pendingRequests.has(message.id)) {
```

**Finding:** Response routing relies on `message.id` matching the request's `id`. While this works for JSON-RPC (response IDs must match request IDs), the SDK explicitly provides `relatedRequestId` in `TransportSendOptions` for this purpose. Relying on `message.id` bypasses the SDK's abstraction and will break if the SDK changes its correlation model.

**Fix:** Use `options?.relatedRequestId ?? message.id` as the lookup key.

---

### M5. `routingInfoStore` and `pendingRequests` Grow Unboundedly

**Files:** `amqp-server-transport.ts:76`, `amqp-server-transport.ts:75`

**Finding:** Both maps grow without bound:
- `routingInfoStore` — entries are only deleted when a response is sent. If the SDK never responds (e.g., method not found handled internally), entries leak.
- `pendingRequests` — entries are only deleted when a response is sent via `send()`. The 10-second warning timer in the `onmessage` wrapper (line 110-119) creates `setTimeout` handles that also leak.
- `requestMetrics` (client, line 65) — same issue.

Over long-running sessions, this causes monotonic memory growth.

**Fix:**
1. Add a TTL-based cleanup for `routingInfoStore` entries (e.g., clean up entries older than `responseTimeout`)
2. Use `WeakRef` or a bounded LRU cache
3. Clear the `setTimeout` handles from the `onmessage` wrapper when entries are cleaned up

---

### M6. `sessionId` Format Not Spec-Aligned

**Files:** `amqp-client-transport.ts:90`, `amqp-server-transport.ts:150`

```typescript
this.sessionId = `amqp-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
```

**Finding:** While the MCP spec doesn't mandate a specific session ID format, the current format:
1. Uses deprecated `String.prototype.substr()` (use `.slice()` instead)
2. Uses `Math.random()` which is not cryptographically random
3. Embeds the transport type (`amqp-client-`/`amqp-server-`) which leaks implementation details

**Fix:** Use `crypto.randomUUID()` (available in Node 18+) for standard UUID v4 session IDs:
```typescript
this.sessionId = crypto.randomUUID();
```

---

### M7. No `contentType` Set on AMQP Messages

**Files:** `amqp-client-transport.ts:391-396`, `amqp-server-transport.ts:551-553`

**Finding:** Published AMQP messages don't set the `contentType` property. Per AMQP best practices and JSON-RPC conventions, all messages should declare `contentType: 'application/json'`. This enables AMQP tooling (management UI, dead-letter handlers) to properly display and handle messages.

**Fix:** Add `contentType: 'application/json'` to all `publish()` and `sendToQueue()` calls.

---

### M8. Notification Routing Keys Inconsistent Between Client and Server

**Files:** `amqp-client-transport.ts:620-626`, `amqp-server-transport.ts:693-699`

**Finding:**
- Client uses: `notifications.{method}` (line 623)
- Server uses: `mcp.notification.{category}` (line 697)

These don't match. A notification sent by the client with routing key `notifications.tools/list_changed` won't be received by anything bound to `mcp.notification.*`. The client subscribes to `mcp.notification.#` patterns (line 488) but publishes to `notifications.*`.

**Fix:** Standardize on a single notification routing key format (recommend `mcp.notification.{method}`).

---

### M9. `isJSONRPCNotification` Defined but Unused in Client

**File:** Client transport does not define or use `isJSONRPCNotification`, but the server transport does (line 50-52).

The client's `detectMessageType()` handles notifications without using a type guard function, while the server uses `isJSONRPCNotification` in `handleNotificationMessage()`. This inconsistency suggests the message type detection was duplicated manually rather than shared.

**Fix:** Share type guards and `detectMessageType()` from a single source (`amqp-utils.ts`). Remove duplicate definitions from both transport files.

---

## MODERATE — Security & Robustness

### S1. No Incoming Message Size Limits

**Finding:** Neither transport validates the size of incoming AMQP messages before parsing. A malicious or misconfigured publisher could send arbitrarily large messages, causing `JSON.parse()` to consume excessive memory.

**Fix:** Check `msg.content.length` before parsing. Reject messages exceeding a configurable maximum (e.g., `maxMessageSize: 1048576` — 1MB default).

---

### S2. No JSON-RPC Schema Validation on Incoming Messages

**Finding:** The server accepts any JSON object that has an `id` or `method` field as a valid JSON-RPC message. There's no validation that `jsonrpc` equals `"2.0"`, that `id` is a string/number/null, that `method` is a string, or that `params` (if present) is an object or array.

**Fix:** Add minimal schema validation before forwarding to the SDK:
```typescript
function isValidJSONRPC(msg: unknown): msg is JSONRPCMessage {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj.jsonrpc !== '2.0') return false;
    // ... validate id, method, result, error shapes
}
```

---

### S3. `DEFAULT_AMQP_CONFIG` Reads `process.env` at Module Load Time

**File:** `amqp-utils.ts:342-351`

```typescript
export const DEFAULT_AMQP_CONFIG = {
    AMQP_URL: process.env.AMQP_URL || 'amqp://localhost:5672',
    // ...
};
```

**Finding:** This executes at import time as a side effect. For a library meant to be imported by other projects:
1. It reads environment variables before the consuming application has a chance to configure them
2. It creates a global singleton with potentially stale values
3. `parseInt()` on undefined env vars can produce `NaN`

**Fix:** Convert to a factory function: `export function getDefaultConfig(): AMQPConfig { ... }`

---

### S4. AMQP URL Validation Accepts Non-AMQP Schemes

**File:** `amqp-utils.ts:136-140`

```typescript
try {
    new URL(config.amqpUrl);
} catch (error) {
    errors.push(`Invalid AMQP URL: ${config.amqpUrl}`);
}
```

**Finding:** `new URL('http://example.com')` passes validation, but `http://` is not a valid AMQP URL. Only `amqp://` and `amqps://` should be accepted.

**Fix:** Validate the URL scheme:
```typescript
const url = new URL(config.amqpUrl);
if (!['amqp:', 'amqps:'].includes(url.protocol)) {
    errors.push(`Invalid AMQP URL scheme: ${url.protocol} (expected amqp:// or amqps://)`);
}
```

---

### S5. Credentials Visible in Example Code and Potentially in Logs

**Files:** `examples/server.ts:22`, `examples/client.ts:14`

```typescript
amqpUrl: process.env.AMQP_URL || "amqp://mcp:discovery@localhost:5672"
```

**Finding:** Hardcoded credentials in example code. While this is just an example, the AMQP URL (which may contain credentials) could also appear in error messages and debug logs throughout the transport.

**Fix:**
1. Use `amqp://guest:guest@localhost:5672` (RabbitMQ default) in examples
2. Redact credentials from any URL that appears in log output
3. Add a note in documentation about credential handling

---

## MINOR — Style, Maintenance & Testing

### T1. Code Duplication — `detectMessageType()` Defined Three Times

**Files:** `amqp-utils.ts:268-288`, `amqp-client-transport.ts:345-363`, `amqp-server-transport.ts:511-529`

The function is copy-pasted in all three files. Additionally, the utils version falls back to `'notification'` for unknown messages (line 287) while the transport versions throw errors — different behavior for the same logic.

**Fix:** Import from `amqp-utils.ts` in both transports. Standardize the fallback behavior (recommend throwing).

---

### T2. Code Duplication — `getToolCategory()` Defined Three Times

Same triplication as T1. Once C7 is fixed (removing hardcoded categories), this duplication resolves itself.

---

### T3. Code Duplication — `generateCorrelationId()` in Utils and Client

**Files:** `amqp-utils.ts:318-321`, `amqp-client-transport.ts:659-661`

Two implementations exist. The utils version uses `.slice()` (correct), the client version uses deprecated `.substr()`.

**Fix:** Import from utils. Delete the duplicate.

---

### T4. Deprecated `String.prototype.substr()`

**Files:** `amqp-client-transport.ts:90,91,660`, `amqp-server-transport.ts:150,151`

`substr()` is deprecated in the ECMAScript spec. The utils file even has a comment acknowledging this (line 319).

**Fix:** Replace all `.substr(2, 9)` with `.slice(2, 11)`.

---

### T5. Emoji in Log Output

**File:** `amqp-server-transport.ts:556`

```typescript
console.log('[AMQP Server] ✅ Response sent to client queue:', replyTo);
```

**Finding:** Emojis in log output can cause encoding issues in some terminal/logging environments and are inconsistent with all other log lines in the codebase.

**Fix:** Remove the emoji: `'[AMQP Server] Response sent to client queue:'`

---

### T6. `parseTransportMode()` Is Application-Level Logic

**File:** `amqp-utils.ts:97-119`

This function parses transport mode strings (`stdio`, `http`, `amqp`) — this is application-level orchestration logic, not transport utility logic. It doesn't belong in a transport library.

**Fix:** Remove from the library. Move to the Open Discovery project.

---

### T7. Test Coverage Is Shallow — No Integration or Message Flow Tests

**File:** `src/transports/__tests__/transport.test.ts`

**Finding:** All 448 lines of tests cover only:
- Constructor instantiation
- Configuration validation/merging
- Utility function unit tests

There are **zero tests** for:
- `start()` / `close()` lifecycle
- `send()` message flow
- Response correlation
- Reconnection behavior
- Error propagation via `onerror`
- `onmessage` callback invocation
- Bidirectional channel setup

**Fix:** Add tests using mocked amqplib connections (e.g., with `jest.mock('amqplib')`) that verify:
1. `start()` creates channels and queues
2. `send(request)` publishes to correct exchange/routing key with correct properties
3. Incoming messages are parsed and forwarded to `onmessage`
4. Response correlation matches by correlationId
5. `close()` cleans up and calls `onclose`
6. Reconnection triggers after connection error (not after intentional close)

---

### T8. `@modelcontextprotocol/sdk` Dependency Version Is Stale

**File:** `package.json:29`

```json
"@modelcontextprotocol/sdk": "^1.0.0"
```

**Finding:** The SDK has evolved significantly. The current version has moved to a monorepo structure with the Transport interface gaining new optional members (`setSupportedProtocolVersions`). The `^1.0.0` range may not include the latest Transport interface changes from the 2025-11-25 spec.

**Fix:** Update to the latest stable SDK version and verify the Transport interface is still fully implemented.

---

## What's Working Well

Despite the findings above, the codebase demonstrates several strong engineering patterns:

1. **Correlation-based response routing** — The `routingInfoStore` pattern that stores `correlationId + replyTo` per request and sends responses directly to the client's exclusive queue is architecturally sound and solves a real problem in async messaging.

2. **Idempotent `start()`** — Both transports correctly handle multiple `start()` calls, which is required since the SDK calls `start()` during `connect()`.

3. **Proper AMQP patterns** — Exclusive auto-delete queues for responses, topic exchanges for routing, prefetch control, message TTLs, and safe ack/nack handling.

4. **Clean Transport interface implementation** — The `start()/send()/close()` and `onclose/onerror/onmessage` contract is correctly structured.

5. **Strong TypeScript configuration** — Strict mode, no implicit any, exact optional properties.

6. **Comprehensive documentation** — Getting started, configuration, API reference, troubleshooting guides.

7. **Docker Compose for development** — Makes it easy to spin up RabbitMQ for testing.

---

## Remediation Plan

### Phase 1: Spec Compliance (Blocking for Adoption)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 1 | C1 | Send raw JSON-RPC as message body; move metadata to AMQP properties | Medium |
| 2 | M1 | Remove dual-format detection after C1 is fixed | Small |
| 3 | C2 | Use `options.relatedRequestId` for response routing lookup in server `send()` | Small |
| 4 | C3 | Reject messages missing `jsonrpc: "2.0"` instead of auto-fixing | Small |
| 5 | C4 | Add `closing` flag to prevent reconnection after intentional `close()` | Small |
| 6 | C5 | Call `onclose` when max reconnection attempts exhausted | Small |
| 7 | C6 | Remove custom `onmessage` getter/setter; let SDK own the callback | Medium |
| 8 | M7 | Add `contentType: 'application/json'` to all published messages | Small |
| 9 | M8 | Standardize notification routing key format | Small |

### Phase 2: Reusability (Blocking for General Adoption)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 10 | C7 | Remove hardcoded tool categories; use method-based routing keys; add optional `routingKeyStrategy` | Medium |
| 11 | T6 | Move `parseTransportMode()` to Open Discovery project | Small |
| 12 | S3 | Convert `DEFAULT_AMQP_CONFIG` to factory function | Small |
| 13 | M2 | Consolidate to single consumption path (bidirectional channel) | Medium |
| 14 | T1-T3 | Eliminate code duplication; single source for shared functions | Small |

### Phase 3: Robustness & Quality

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 15 | M5 | Add TTL-based cleanup for `routingInfoStore` and `pendingRequests` | Medium |
| 16 | M6 | Use `crypto.randomUUID()` for session IDs | Small |
| 17 | S1 | Add configurable `maxMessageSize` validation | Small |
| 18 | S2 | Add JSON-RPC schema validation on incoming messages | Small |
| 19 | S4 | Validate AMQP URL scheme specifically | Small |
| 20 | M3 | Remove `await Promise.resolve()` anti-patterns | Small |
| 21 | T4 | Replace all `.substr()` with `.slice()` | Small |
| 22 | T5 | Remove emoji from log output | Small |

### Phase 4: Testing & Packaging

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 23 | T7 | Add mocked integration tests for lifecycle, message flow, correlation | Large |
| 24 | T8 | Update `@modelcontextprotocol/sdk` to latest stable version | Small |
| 25 | — | Add CI pipeline (lint, test, build) | Medium |
| 26 | — | Publish to npm as a standalone package | Small |

### Priority Order

**Ship blockers (Phase 1 + 2):** Items 1-14 must be completed before the transport can be proposed for MCP spec adoption. These represent spec violations and coupling to the Open Discovery project.

**Quality gates (Phase 3):** Items 15-22 should be completed before v2.0 release. These are correctness and robustness issues.

**Production readiness (Phase 4):** Items 23-26 are needed for the transport to be trusted in production environments.

---

## Appendix: MCP Transport Interface Contract

For reference, the official Transport interface that this library must conform to:

```typescript
interface Transport {
    /** Start processing messages. Only called after callbacks are installed. */
    start(): Promise<void>;

    /** Send a JSON-RPC message. relatedRequestId correlates responses to requests. */
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;

    /** Close the connection. */
    close(): Promise<void>;

    /** Invoked when connection is closed for any reason (including close() calls). */
    onclose?: () => void;

    /** Invoked for non-fatal errors. */
    onerror?: (error: Error) => void;

    /** Invoked when a JSON-RPC message is received. */
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

    /** Session ID for this connection. */
    sessionId?: string;

    /** Called when protocol version is negotiated. */
    setProtocolVersion?: (version: string) => void;
}

type TransportSendOptions = {
    relatedRequestId?: RequestId;
    resumptionToken?: string;
    onresumptiontoken?: (token: string) => void;
};
```

**Key behavioral contracts enforced by the Protocol class:**
1. Protocol **replaces** `onclose`, `onerror`, and `onmessage` callbacks during `connect()` (chains any pre-existing ones)
2. Protocol calls `start()` **after** installing callbacks
3. `onmessage` must deliver **valid JSON-RPC messages** — Protocol routes by type
4. `onclose` must fire when connection is lost — Protocol uses it to reject pending requests
5. `sessionId` is read by Protocol and included in request handler extras

---

## Sources

- [MCP Specification 2025-11-25 — Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Specification 2025-11-25 — Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture)
- [MCP TypeScript SDK — Transport Interface](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification — JSON-RPC Protocol](https://mcpcat.io/guides/understanding-json-rpc-protocol-mcp/)
- [MCP Error Codes Reference](https://www.mcpevals.io/blog/mcp-error-codes)
- [MCP 2025-11-25 Spec Update Summary](https://workos.com/blog/mcp-2025-11-25-spec-update)
