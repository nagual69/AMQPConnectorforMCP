import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ListResourcesRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AMQPServerTransport } from "../src/transports/index.js";

/**
 * Example MCP server using AMQP transport
 *
 * Demonstrates how to create an MCP server that serves tools, resources,
 * and prompts through an AMQP message broker.
 */

async function main() {
    const transport = new AMQPServerTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
        queuePrefix: "mcp.example",
        exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
        prefetchCount: 1,
        reconnectDelay: 5000,
        maxReconnectAttempts: 10
    });

    const server = new Server(
        { name: "amqp-example-server", version: "1.0.0" },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    // ── Tools ───────────────────────────────────────────────────────────

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
            {
                name: "echo",
                description: "Echo back the input text",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string", description: "Text to echo back" } },
                    required: ["text"]
                }
            },
            {
                name: "reverse",
                description: "Reverse the input text",
                inputSchema: {
                    type: "object",
                    properties: { text: { type: "string", description: "Text to reverse" } },
                    required: ["text"]
                }
            }
        ]
    }));

    server.setRequestHandler(CallToolRequestSchema, (request) => {
        const { name, arguments: args } = request.params;
        switch (name) {
            case "echo": {
                const text = typeof args?.text === "string" ? args.text : '';
                return { content: [{ type: "text", text: `Echo: ${text}` }] };
            }
            case "reverse": {
                const text = typeof args?.text === "string" ? args.text : '';
                return { content: [{ type: "text", text: `Reversed: ${text.split('').reverse().join('')}` }] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });

    // ── Resources ───────────────────────────────────────────────────────

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: [
            { uri: "memory://status", name: "Server Status", description: "Current server status", mimeType: "application/json" },
            { uri: "memory://config", name: "Configuration", description: "Server configuration", mimeType: "application/json" }
        ]
    }));

    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
        const { uri } = request.params;
        switch (uri) {
            case "memory://status":
                return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ status: "running", uptime: process.uptime(), transport: "amqp" }, null, 2) }] };
            case "memory://config":
                return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ serverName: "amqp-example-server", version: "1.0.0", transport: "amqp" }, null, 2) }] };
            default:
                throw new Error(`Unknown resource: ${uri}`);
        }
    });

    // ── Prompts ──────────────────────────────────────────────────────────

    server.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: [
            { name: "summarize", description: "Summarize text", arguments: [{ name: "text", description: "Text to summarize", required: true }] },
            { name: "translate", description: "Translate text", arguments: [{ name: "text", required: true }, { name: "target_language", required: true }] }
        ]
    }));

    server.setRequestHandler(GetPromptRequestSchema, (request) => {
        const { name, arguments: args } = request.params;
        const a = args as Record<string, unknown> | undefined;
        switch (name) {
            case "summarize":
                return { messages: [{ role: "user", content: { type: "text", text: `Summarize: ${typeof a?.text === 'string' ? a.text : ''}` } }] };
            case "translate":
                return { messages: [{ role: "user", content: { type: "text", text: `Translate to ${typeof a?.target_language === 'string' ? a.target_language : 'English'}: ${typeof a?.text === 'string' ? a.text : ''}` } }] };
            default:
                throw new Error(`Unknown prompt: ${name}`);
        }
    });

    // ── Start ────────────────────────────────────────────────────────────

    try {
        await server.connect(transport);
        console.log("MCP server started with AMQP transport");
        console.log(`Exchange: ${process.env.AMQP_EXCHANGE || "mcp.examples"}`);
        await new Promise(() => { }); // Run forever
    } catch (error) {
        console.error("Error starting server:", error);
        process.exit(1);
    }
}

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

main().catch(console.error);
