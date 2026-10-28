import { McpServer, createMcpHandler, fromJsonSchema, preloadSchemas } from '@modelcontextprotocol/server';
import fs from 'node:fs';
const tools = JSON.parse(fs.readFileSync(process.env.TOOLS ?? 'od-tools.json', 'utf8'));
const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'b', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const target = tools.find(t => !(t.inputSchema?.required?.length)) ?? tools[0];
const N = Number(process.env.N ?? 2000), WARM = 200;
const mode = process.argv[2];
if (mode === 'preload') preloadSchemas();
const hoisted = tools.map(t => ({ t, schema: fromJsonSchema(t.inputSchema) }));
const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });
function factory() {
  const s = new McpServer({ name: 'od-bench', version: '0' }, { capabilities: { tools: { listChanged: true } } });
  const list = mode === 'naive' ? tools.map(t => ({ t, schema: fromJsonSchema(t.inputSchema) })) : hoisted;
  for (const { t, schema } of list) s.registerTool(t.name, { description: t.description, inputSchema: schema, ...(t.annotations ? { annotations: t.annotations } : {}) }, ok);
  return s;
}
const handler = createMcpHandler(factory, { legacy: 'reject', keepAliveMs: 0 });
const mk = (body) => new Request('http://amqp.invalid/mcp', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': body.method, ...(body.params?.name ? { 'mcp-name': body.params.name } : {}) } });
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
async function bench(label, fn) {
  for (let i = 0; i < WARM; i++) await fn(i);
  const xs = [];
  for (let i = 0; i < N; i++) { const t0 = process.hrtime.bigint(); await fn(i); xs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  xs.sort((a, b) => a - b);
  console.log(`${mode.padEnd(8)} ${label.padEnd(28)} p50=${pct(xs, .5).toFixed(2)}ms p95=${pct(xs, .95).toFixed(2)}ms p99=${pct(xs, .99).toFixed(2)}ms max=${xs.at(-1).toFixed(2)}ms`);
}
await bench('factory only', async () => { factory(); });
await bench(`tools/call ${target.name}`, async (i) => { const r = await handler.fetch(mk({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: target.name, arguments: {}, _meta: meta } })); const j = await r.json(); if (!j.result) throw new Error(JSON.stringify(j)); });
await bench('tools/list (81 tools)', async (i) => { const r = await handler.fetch(mk({ jsonrpc: '2.0', id: i, method: 'tools/list', params: { _meta: meta } })); const j = await r.json(); if (j.result?.tools?.length !== tools.length) throw new Error('count'); });
