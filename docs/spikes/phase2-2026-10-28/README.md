# Phase 2 spike: engine B go/no-go (2026-10-28)

- **Question:** can `serveAmqp` bridge each AMQP exchange to `@modelcontextprotocol/server`'s
  `createMcpHandler().fetch()`? That is engine B, decision D-2 of
  [the re-architecture plan](../../REARCHITECTURE_PLAN_2026-07-28.md) §5.2. The alternative is
  engine C, a native serving entry. The plan set four gates: R1–R3, plus open item O-2 of
  [BINDING.md](../../BINDING.md) §14.
- **Answer:** **go for engine B.** All four gates pass. Three findings change how the bridge is
  built (§5).
- **Measured against:** `@modelcontextprotocol/server`, `client` and `core` 2.4.0 (2026-10-23), zod
  4, Node 22.22.0, and RabbitMQ 4.4.0 (`rabbitmq:4-management`). The plan's gates were written
  against SDK 2.3.1, so every claim here was re-read from the 2.4.0 typings and dist source, not
  release notes.

## 1. Does 2.4.0 change D-2?

2.4.0 exports `classifyInboundRequest()`, the era decision as a transport-neutral function, and
`MessageExtraInfo.classification`. With them, any `Transport` can hand a classified message to a
`Server`. That makes engine C's first step free.

The rest of the modern serving path in `createMcpHandler` is still module-private. None of these
are exported or reachable through the package `exports` map:

- `setNegotiatedProtocolVersion`;
- `installModernOnlyHandlers`;
- `seedClientIdentityFromEnvelope`;
- `createListenRouter` (ack-first, filtering, `subscriptionId` stamping, teardown).

Engine C would therefore mean deep-importing hashed dist chunks or re-implementing the listen router.
Both carry more drift risk than engine B's HTTP coupling. **D-2 stays B → C.** The upstream request
narrows accordingly (§6).

## 2. R1: per-request factory cost

- **Inputs:** Open Discovery's live `tools/list`, dumped from the real builtin set by
  `dump-od-tools.cjs`: 81 tools, 63 KB of JSON Schema. Each tool is registered in a v2 `McpServer`
  through `fromJsonSchema`, with a trivial handler. Open Discovery is still on SDK 1.32.1, so its
  plugins cannot be loaded into a v2 server yet. This is the closest proxy for registration cost.
- **Method:** `r1-factory-bench.mjs`, with 200 warm-up iterations followed by N measured ones. The
  "naive" variant builds the schemas inside the factory. The "hoisted" variant builds them once at
  module scope.

| Variant | Measured | p50 | p95 | p99 |
|---|---|---|---|---|
| naive, N = 2000 | factory only | 0.15 ms | 0.33 ms | 5.47 ms |
| naive, N = 2000 | `tools/call` through `fetch` | 0.57 ms | 1.33 ms | 6.56 ms |
| hoisted, N = 5000 | factory only | 0.11 ms | 0.22 ms | 4.54 ms |
| hoisted, N = 5000 | `tools/call` through `fetch` | 0.46 ms | 0.92 ms | 6.04 ms |
| hoisted, N = 5000 | `tools/list` (81 tools) through `fetch` | 1.63 ms | 4.78 ms | 6.73 ms |
| `preloadSchemas()`, N = 2000 | `tools/call` through `fetch` | 0.50 ms | 1.03 ms | 5.95 ms |

- The p99 tail is about 5 ms whatever the variant, which is consistent with GC pauses rather than
  registration work.
- `preloadSchemas()` warms the SDK's own spec schemas, not tool schemas. It makes no material
  difference on a long-lived Node process, as its own documentation predicts.
- **Proposed D-3 budget (maintainer's call):** bridge overhead p99 ≤ 10 ms per exchange, excluding
  tool work, on Node 22. That is the factory, the in-process `fetch` and response parsing. The
  measured worst case is 6.7 ms. Re-measure with Open Discovery's real plugins in Phase 3. Sandbox
  tiers and validation wrappers add cost this proxy cannot see.
- **Pattern to adopt:** hoist schema construction to module scope (the "hoisted" row), so the
  factory only registers.

## 3. R2: `Mcp-Param-*` synthesis

BINDING §5.2 says an AMQP server MUST NOT require parameter mirrors. But `createMcpHandler` rejects
a `tools/call` with `-32020` when a tool declares `x-mcp-header` and the matching `Mcp-Param-{Name}`
header is missing or disagrees. It does this after `factory()` and before dispatch. Verified with
`r2-r3-engine-b.mjs`:

| Case | Result |
|---|---|
| No synthesis, tool declares `x-mcp-header` on string, integer and boolean properties | 400, `-32020`, "the `Mcp-Param-Region` header is absent" |
| Synthesis, approach (a), with a non-ASCII string, an integer and a boolean | 200, served |
| A wrong header value | 400, `-32020` |

Approach (a) wraps the factory:

1. On `tools/call`, read `product.toolInputSchemaJson(name)` from the instance just built.
2. Walk the properties-only chain for `x-mcp-header`.
3. Set `Mcp-Param-{Name}` on `ctx.requestInfo.headers`, always base64-sentinel encoded, because the
   sentinel always decodes. A script-constructed `Request` has mutable headers.

The headers come from the schema of the very instance that will serve the call, so there is no
staleness. **Decision: approach (a).** It relies on `toolInputSchemaJson`, which is marked
`@internal`, so the serveAmqp task carries a contract test that fails loudly if the method's name
or call timing changes. Approach (b), a schema map refreshed on `tools_list_changed`, is the
fallback.

None of Open Discovery's 81 tools declares `x-mcp-header` today, so R2 is for generality rather
than for Open Discovery.

## 4. R3: SSE relay order and terminality

Also verified with `r2-r3-engine-b.mjs`, using `keepAliveMs: 0` and `responseMode: 'auto'`.

- **Progress.** A tool emitting five progress notifications produces six SSE frames in emission
  order. The single terminal response is last, and nothing follows it. No comment frames appear.
- **Log gating (P4's MUST NOT).** With `_meta["io.modelcontextprotocol/logLevel"]` set, progress and
  `notifications/message` interleave in emission order. Without it, the handler's `log()` calls
  produce no `notifications/message` at all.
- **No mid-call messages.** The response is a single JSON body, not SSE. The relay must handle both
  content types.
- **Listen.**
  - The first frame is `notifications/subscriptions/acknowledged`.
  - `prompts_list_changed`, which the client did not opt into, is filtered out.
  - `tools_list_changed`, which it did opt into, is delivered stamped.
  - `handler.close()` ends the stream with the `complete` result.

## 5. O-2: stale direct reply-to on RabbitMQ 4.4.0

`o2-direct-reply-to.cjs` publishes `mandatory: true` on a confirm channel:

| Reply address | Confirm | `basic.return` |
|---|---|---|
| Live direct reply-to | ack | none (delivered) |
| Direct reply-to after the client **channel** closed | ack | **none: silently dropped** |
| Direct reply-to after the client **connection** closed | ack | **none: silently dropped** |
| Forged direct reply-to name | ack | 312 `NO_ROUTE` |
| Exclusive queue after its owner disconnected | ack | 312 `NO_ROUTE` |
| A queue that never existed | ack | 312 `NO_ROUTE` |

**O-2 is resolved: RabbitMQ 4.4.0 does not return a publish to a stale direct reply-to address.**
A server cannot learn that a direct-reply-to client has gone.

- For ordinary requests that is harmless. The reply is lost with the channel, which is the
  no-resumability semantics the binding wants.
- For a listen stream, it means the server keeps the stream until its lifetime bound. So the
  BINDING §7.3 item 3 SHOULD (use a named exclusive reply queue for listen) stays, now on evidence.
- D-7 stands as recommended.

## 6. Findings that shape the bridge

1. **The bridge owns listen teardown framing.**
   - The SDK's listen router has two endings:
     - graceful (`handler.close()`) writes only the `complete` result, with no
       `notifications/cancelled` before it;
     - abort (the request signal) writes nothing.
   - There is no per-stream graceful close.
   - BINDING §6.3 item 4 needs `notifications/cancelled` then `complete`, per stream, on lifetime
     expiry, an undeliverable reply address, or shutdown.
   - So the bridge aborts the stream's request signal, which makes the SDK write nothing, and
     publishes both messages itself.
   - On client cancel, the abort alone is right: no result.
   - Whether the HTTP entry's graceful close should also send `notifications/cancelled` is worth
     raising upstream, after checking the 2026-07-28 cancellation page's exact wording.
2. **Default cache hints.** `tools/list` from a default `McpServer` carries `ttlMs: 0` and
   `cacheScope: "private"`. Open Discovery's own conformance task should set a deliberate `ttlMs`.
3. **Redelivery exposure in Open Discovery.**
   - Of 81 tools, 59 are `readOnlyHint` and 42 are `idempotentHint`.
   - 15 carry neither, so a redelivered call to any of them is refused under §7.2:
     - `mcp_od_credentials_add`, `_update` and `_rotate_key`;
     - `mcp_od_store_install`;
     - `mcp_od_memory_set`, `_merge`, `_rotate_key`, `_save` and `_migrate_from_filesystem`;
     - `mcp_od_registry_install`, `_activate`, `_enable_capability`, `_update` and
       `_add_signing_key`;
     - `mcp_od_snmp_create_session`.
   - Some of these, such as `memory_set` and `registry_activate`, may be idempotent in fact.
     Auditing their annotations belongs to Phase 3.
4. **Every Open Discovery tool name is carriable** in a routing key (§4.2), so broker-level tool
   authorization works for the whole set.

## 7. Upstream request (draft, for the maintainer to file)

> **Transport-neutral per-request serving for 2026-07-28 custom transports.**
>
> `createMcpHandler` is the only supported way to serve a 2026-07-28 request with SDK-owned
> semantics:
>
> - era negotiation;
> - modern-only handlers;
> - envelope identity seeding;
> - the listen router's ack-first, filtering and stamping.
>
> It is HTTP-shaped, though. A broker or socket transport must synthesise a web `Request`, including
> `Mcp-Param-*` headers that its own binding does not use, and parse SSE back into messages.
> `classifyInboundRequest` (2.4.0) exposes the first step. Please consider exporting one of these:
>
> - a `serveMessage(factory, route, { authInfo, signal })` that yields the related messages and the
>   terminal response as JSON-RPC objects; or
> - `createListenRouter` together with a per-subscription graceful close.
>
> Please also consider making the `x-mcp-header` pre-dispatch check opt-out for non-HTTP entries.
> Related: the listen router's graceful close writes the `complete` result without a preceding
> `notifications/cancelled`. Please confirm whether that matches the cancellation pattern's
> requirement for a server-ended request.

## 8. Reproducing

The scripts need a scratch install of the v2 SDK, because this repository still develops against
SDK 1.x until the scaffolding task lands:

```sh
mkdir /tmp/sdk2 && cd /tmp/sdk2 && npm init -y
npm i @modelcontextprotocol/server@2.4.0 @modelcontextprotocol/client@2.4.0 @modelcontextprotocol/core@2.4.0 zod@4 amqplib
cp /path/to/AMQPConnectorforMCP/docs/spikes/phase2-2026-10-28/*.{mjs,cjs} .
# R1. First dump od-tools.json from an Open Discovery checkout after
# `npm run build:ts && npm run build:plugins`:
OD_REPO=/path/to/mcp_open_discovery_3_0 OUT=$PWD/od-tools.json node dump-od-tools.cjs
TOOLS=od-tools.json N=2000 node r1-factory-bench.mjs hoisted   # or: naive | preload
# R2 and R3:
node r2-r3-engine-b.mjs
# O-2, against RabbitMQ 4.x on localhost:
AMQP_URL=amqp://test:test@127.0.0.1:5672 node o2-direct-reply-to.cjs
```

The scripts resolve packages relative to their own location, so run them from the scratch install.
`dump-od-tools.cjs` resolves the SDK 1.x and Open Discovery modules from `OD_REPO`.
