// Dumps Open Discovery's live tools/list (the real builtin set) to JSON, for the R1 benchmark.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const REPO = process.env.OD_REPO ?? process.cwd();
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-dump-'));
  process.env.DATA_DIR = dir; process.env.PLUGIN_DB_PATH = path.join(dir, 'plugin_store.db'); process.env.PLUGINS_ROOT = path.join(dir, 'plugins');
  delete process.env.REQUIRE_SIGNATURES; delete process.env.PLUGIN_REQUIRE_SIGNED;
  process.chdir(REPO);
  const r = (m) => require(require.resolve(m, { paths: [REPO] }));
  const { McpServer } = r('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = r('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = r('@modelcontextprotocol/sdk/inMemory.js');
  const registry = require(path.join(REPO, 'dist-ts/src/plugins/plugin-registry'));
  const manager = require(path.join(REPO, 'dist-ts/src/plugins/plugin-manager'));
  const build = (name) => new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } } });
  await registry.initialize(build('t')); await registry.bootstrapBuiltinPlugins();
  const server = build('dump'); await manager.attachSessionServer(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dump', version: '1' }, { capabilities: {} });
  await server.connect(st); await client.connect(ct);
  const { tools } = await client.listTools();
  fs.writeFileSync(process.env.OUT ?? 'od-tools.json', JSON.stringify(tools, null, 1));
  console.log('tools', tools.length, 'bytes', JSON.stringify(tools).length);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
