# AMQP transport contract (v1.x)

- **Status:** Normative for `amqp-mcp-transport` 1.x. The tests in
  `src/transports/__tests__/contract.test.ts` carry each clause by number.
- **Origin:** This is Open Discovery 3.0's ratified AMQP extension-transport contract
  (`mcp_open_discovery_3_0/docs/AMQP_SESSION_MODEL.md` §6, ratified 2026-08-19), with three
  changes:
  1. It adds the client-side rules that contract did not need, because Open Discovery ships no
     client.
  2. It makes the server transport *reject* outbound requests (§5) rather than relying on its
     callers never to send one.
  3. It records the wire changes from 1.0.0 (§7).
- **Scope:** The 2025-era MCP protocol (`initialize` handshake, SDK v1). Moving to the stateless
  MCP 2026-07-28 protocol is planned in
  [REARCHITECTURE_PLAN_2026-07-28.md](./REARCHITECTURE_PLAN_2026-07-28.md), which proposes
  superseding §1, §4 and §6 below. Until that lands, this document is what the code does.

## Topology

All traffic uses one topic exchange, `${exchangeName}.mcp.routing` (durable). There are three
routing namespaces:

| Namespace | Published by | Consumed by |
|---|---|---|
| `mcp.request.<method>` | clients | the server endpoint |
| `mcp.client-notification.<method>` | clients | the server endpoint |
| `mcp.server-notification.<method>` | the server | every client |

`<method>` is the JSON-RPC method with `/` replaced by `.`. A custom `routingKeyStrategy` may
change the suffix, but it MUST keep each message inside its namespace's binding pattern.

Responses never touch the exchange. They go straight to the requesting client's reply queue.

## 1. Endpoint, not session

The server exposes one AMQP endpoint per transport instance:

- an exclusive, auto-deleting request queue named `${queuePrefix}.requests.<instance-id>`;
- bound to `mcp.request.#` and `mcp.client-notification.#`, and to nothing else.

**Exactly one AMQP-enabled server may serve a given exchange.** A topic exchange copies each
message to every matching queue, so a second server would receive and answer every request too.

`sessionId` on the server transport is an endpoint-instance id. It names the queue and
namespaces internal request ids. It is never negotiated, and it never appears on the wire.

## 2. Per-request correlation

- **Every request MUST carry `replyTo` and `correlationId` message properties.** The response
  is sent to `replyTo` with the same `correlationId` and the client's own JSON-RPC id. A request
  without both properties is delivered to the server, but no response can be routed for it.
- **The server never keys response routing by the client-chosen JSON-RPC id.** Every client
  numbers its requests from the same starting point, so two concurrent clients routinely send
  `id: 1`.
  - Before the SDK sees a request, the transport rewrites its id to a globally unique internal
    id.
  - It stores `{replyTo, correlationId, originalId}` under that internal id.
  - On the way out it restores `originalId`.
  - Each routing entry is consumed by exactly one response.
  - Keying by the raw id leaks one client's results to another. That was the
    `amqp-routing-store-id-collision` defect, live in this package through 1.1.0.

## 3. No protocol session

`initialize` is answered like any request but gates nothing. A request is served regardless of
any prior `initialize` on the endpoint.

All clients share one endpoint, so negotiated state (protocol version, client capabilities) is
last-writer-wins. Clients MUST NOT assume it persists between requests.

## 4. Notifications are broadcast

Server notifications publish under `mcp.server-notification.<method>` to every subscribed
client. This includes `*/list_changed`, `notifications/message` and progress. There is no
per-client addressing. A notification related to a request does not consume that request's
routing entry.

Clients bind only `mcp.server-notification.#`, so they never receive other clients'
notifications.

## 5. No server-initiated requests

Servers do not send JSON-RPC requests over this transport. Sampling and elicitation are
therefore unavailable.

- `AMQPServerTransport.send()` rejects a request instead of publishing it into the request
  namespace, which its own queue consumes.
- `AmqpServerRuntime.send()` accepts notifications only.
- `AMQPClientTransport.send()` rejects JSON-RPC responses, since nothing consumes them.

## 6. Delivery bounds

- **Dropped messages.** A message over `maxMessageSize` (default 1 MiB), one that is not JSON,
  and one that fails JSON-RPC validation is dropped: nack, no requeue, no dead-letter exchange.
  The server reports it through `onerror`.
- **TTLs.** The endpoint queue declares `x-message-ttl` (default 1 h) and `x-expires`
  (default 2 h).
- **Recovery.**
  - *In-transport reconnect* keeps the same instance id and queue name. It tears down the old
    connection first.
  - *Runtime recovery* (`AmqpServerRuntime`), after the transport has closed for good, attaches
    a new transport and a new server from the factory. In-flight requests are never answered;
    clients own timeout and retry.
- **Consumer cancel.** A broker-side consumer cancel (`basic.cancel`, e.g. the queue was deleted)
  is treated as a connection failure. The transport reports itself disconnected and recovers.
  It does not stay silently "connected" while nothing can arrive.

## 7. Wire changes from 1.0.0

The 1.0.0 package used a single `mcp.notification.*` namespace that both sides published to and
bound. This had three effects:

- servers consumed their own notifications;
- every client received every other client's notifications;
- server-initiated requests looped back into the server's own queue.

1.2.0 adopts Open Discovery's namespaces above. A 1.0.0 client and a 1.2.0 server still exchange
requests and responses, but **not notifications**. Upgrade both sides together. Open
Discovery 3.0 already speaks the 1.2.0 wire format.
