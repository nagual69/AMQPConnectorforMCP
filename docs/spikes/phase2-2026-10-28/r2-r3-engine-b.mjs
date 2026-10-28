import { McpServer, createMcpHandler, fromJsonSchema, InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { z } from 'zod';

const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };

function factory() {
  const s = new McpServer({ name: 'spike', version: '0.0.0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  s.registerTool('slow', { description: 'emits progress', inputSchema: { n: z.number() } }, async ({ n }, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    for (let i = 1; i <= n; i++) {
      await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: n } });
      await ctx.mcpReq.log('info', `step ${i}`);
    }
    return { content: [{ type: 'text', text: `done ${n}` }] };
  });
  const headerSchema = { type: 'object', properties: {
    region: { type: 'string', 'x-mcp-header': 'Region' },
    count: { type: 'integer', 'x-mcp-header': 'Count' },
    flag: { type: 'boolean', 'x-mcp-header': 'Flag' } } };
  s.registerTool('hdr', { description: 'declares x-mcp-header', inputSchema: fromJsonSchema(headerSchema) }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));
  return s;
}

const stash = new WeakMap();
const b64 = (s) => `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`;
function walk(schema, path = [], out = []) {
  const props = schema?.properties;
  if (props && typeof props === 'object') for (const [k, v] of Object.entries(props)) {
    if (v && typeof v === 'object' && typeof v['x-mcp-header'] === 'string') out.push({ path: [...path, k], header: v['x-mcp-header'] });
    walk(v, [...path, k], out);
  }
  return out;
}
const wrapped = (mode) => async (ctx) => {
  const product = factory();
  const msg = ctx.requestInfo && stash.get(ctx.requestInfo);
  if (mode === 'a' && msg?.method === 'tools/call') {
    const schema = product.toolInputSchemaJson(msg.params.name);
    for (const d of walk(schema)) {
      let v = msg.params.arguments; for (const k of d.path) v = v?.[k];
      if (v === undefined || v === null) continue;
      ctx.requestInfo.headers.set(`Mcp-Param-${d.header}`, b64(typeof v === 'string' ? v : String(v)));
    }
  }
  return product;
};

function req(body, extraHeaders = {}) {
  const r = new Request('http://amqp.invalid/mcp', { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN,
    'mcp-method': body.method, ...(body.params?.name ? { 'mcp-name': body.params.name } : {}), ...extraHeaders } });
  stash.set(r, body);
  return r;
}
async function frames(res) {
  const text = await res.text();
  return { ct: res.headers.get('content-type'), status: res.status, raw: text };
}
function parseSse(raw) {
  const out = []; for (const block of raw.split(/\n\n/)) { if (!block.trim()) continue;
    if (block.startsWith(':')) { out.push({ comment: block }); continue; }
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); if (data) out.push(JSON.parse(data)); }
  return out;
}

const h0 = createMcpHandler(wrapped('none'), { legacy: 'reject', keepAliveMs: 0 });
const hA = createMcpHandler(wrapped('a'), { legacy: 'reject', keepAliveMs: 0 });

// R3: ordering and terminality
{
  const r = await frames(await h0.fetch(req({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { n: 5 }, _meta: { ...meta, progressToken: 'p1' } } })));
  const f = r.ct?.includes('event-stream') ? parseSse(r.raw) : [JSON.parse(r.raw)];
  console.log('R3 status', r.status, r.ct, 'frames', f.length);
  console.log('R3 sequence', f.map(x => x.comment ? 'COMMENT' : x.method ? `${x.method}:${x.params?.progress}` : `response:${x.id}:${x.result?.resultType ?? 'nort'}`).join(' | '));
}
{
  const r = await frames(await h0.fetch(req({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'slow', arguments: { n: 3 }, _meta: { ...meta, progressToken: 'p2', 'io.modelcontextprotocol/logLevel': 'info' } } })));
  const f = r.ct?.includes('event-stream') ? parseSse(r.raw) : [JSON.parse(r.raw)];
  console.log('R3+log sequence', f.map(x => x.comment ? 'COMMENT' : x.method ? `${x.method.replace('notifications/','')}:${x.params?.progress ?? x.params?.data}` : `response:${x.id}:${x.result?.resultType}`).join(' | '));
}
// tools/list sanity + discover
{
  const r = await frames(await h0.fetch(req({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } })));
  const j = JSON.parse(r.raw); console.log('tools/list', r.status, j.result?.tools?.map(t => t.name), 'ttlMs', j.result?.ttlMs, j.result?.cacheScope);
}
// R2 without synthesis
for (const [label, h] of [['R2 none', h0], ['R2 (a)', hA]]) {
  const r = await frames(await h.fetch(req({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hdr', arguments: { region: 'eu-west/ü', count: 42, flag: true }, _meta: meta } })));
  console.log(label, r.status, r.raw.slice(0, 220));
}
// R2 mutation: wrong header supplied by bridge
{
  const r0 = req({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hdr', arguments: { region: 'x' }, _meta: meta } }, { 'Mcp-Param-Region': 'y' });
  const r = await frames(await h0.fetch(r0)); console.log('R2 mutated', r.status, r.raw.slice(0, 160));
}
// Listen: ack first, bus event, abort
{
  const bus = new InMemoryServerEventBus();
  const hl = createMcpHandler(wrapped('none'), { legacy: 'reject', keepAliveMs: 0, bus });
  const ac = new AbortController();
  const lr = new Request('http://amqp.invalid/mcp', { method: 'POST', signal: ac.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true }, _meta: meta } }),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': 'subscriptions/listen' } });
  const res = await hl.fetch(lr);
  console.log('listen', res.status, res.headers.get('content-type'));
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  let pending = null; let ended = false;
  const readFor = async (ms) => { const end = Date.now() + ms; while (!ended && Date.now() < end) { pending ??= reader.read(); const t = await Promise.race([pending, new Promise(r => setTimeout(() => r(null), 50))]); if (t === null) continue; pending = null; if (t.done) { buf += '[[END]]\n\n'; ended = true; return; } buf += dec.decode(t.value); } };
  await readFor(200);
  bus.publish({ kind: 'prompts_list_changed' });
  bus.publish({ kind: 'tools_list_changed' });
  await readFor(200);
  await hl.close();
  await readFor(300);
  console.log('listen frames:', buf.split('\n\n').filter(Boolean).map(b => { const d = b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join(''); try { const j = JSON.parse(d); return j.method ?? `result:${j.result?.resultType}`; } catch { return b.slice(0, 40); } }));
}
