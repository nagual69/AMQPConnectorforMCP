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
 * This example demonstrates how to create an MCP server that serves
 * tools and resources through AMQP message queues.
 */

async function main() {
    // Create AMQP transport
    const transport = new AMQPServerTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://mcp:discovery@localhost:5672",
        queuePrefix: "mcp.example",
        exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
        prefetchCount: 1, // Process one request at a time
        reconnectDelay: 5000,
        maxReconnectAttempts: 10
    });

    // Create MCP server with AMQP transport
    const server = new Server(
        {
            name: "amqp-example-server",
            version: "1.0.0"
        },
        {
            capabilities: {
                tools: {},
                resources: {},
                prompts: {}
            }
        }
    );

    // Add example tools via manual handlers
    server.setRequestHandler(ListToolsRequestSchema, () => {
        return {
            tools: [
                {
                    name: "echo",
                    description: "Echo back the input text",
                    inputSchema: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                description: "Text to echo back"
                            }
                        },
                        required: ["text"]
                    }
                },
                {
                    name: "reverse",
                    description: "Reverse the input text",
                    inputSchema: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                description: "Text to reverse"
                            }
                        },
                        required: ["text"]
                    }
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, (request) => {
        const { name, arguments: argsRaw } = request.params;
        const args = argsRaw;

        switch (name) {
            case "echo": {
                const text = typeof args?.text === "string" ? args.text : '';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Echo: ${text}`
                        }
                    ]
                };
            }
            case "reverse": {
                const text = typeof args?.text === "string" ? args.text : '';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Reversed: ${text.split('').reverse().join('')}`
                        }
                    ]
                };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });

    // Add example resources
    server.setRequestHandler(ListResourcesRequestSchema, () => {
        return {
            resources: [
                {
                    uri: "memory://status",
                    name: "Server Status",
                    description: "Current server status information",
                    mimeType: "application/json"
                },
                {
                    uri: "memory://config",
                    name: "Configuration",
                    description: "Server configuration",
                    mimeType: "application/json"
                }
            ]
        };
    });

    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
        const { uri } = request.params;

        switch (uri) {
            case "memory://status":
                return {
                    contents: [
                        {
                            uri,
                            mimeType: "application/json",
                            text: JSON.stringify({
                                status: "running",
                                uptime: process.uptime(),
                                timestamp: new Date().toISOString(),
                                transport: "amqp"
                            }, null, 2)
                        }
                    ]
                };

            case "memory://config":
                return {
                    contents: [
                        {
                            uri,
                            mimeType: "application/json",
                            text: JSON.stringify({
                                serverName: "amqp-example-server",
                                version: "1.0.0",
                                transport: {
                                    type: "amqp",
                                    queuePrefix: "mcp.example",
                                    exchangeName: "mcp.notifications"
                                }
                            }, null, 2)
                        }
                    ]
                };

            default:
                throw new Error(`Unknown resource: ${uri}`);
        }
    });

    // Add example prompts
    server.setRequestHandler(ListPromptsRequestSchema, () => {
        return {
            prompts: [
                {
                    name: "summarize",
                    description: "Summarize the given text",
                    arguments: [
                        {
                            name: "text",
                            description: "Text to summarize",
                            required: true
                        },
                        {
                            name: "style",
                            description: "Summary style (brief, detailed, bullet-points)",
                            required: false
                        }
                    ]
                },
                {
                    name: "translate",
                    description: "Translate text to a specified language",
                    arguments: [
                        {
                            name: "text",
                            description: "Text to translate",
                            required: true
                        },
                        {
                            name: "target_language",
                            description: "Target language for translation",
                            required: true
                        },
                        {
                            name: "source_language",
                            description: "Source language (auto-detect if not specified)",
                            required: false
                        }
                    ]
                }
            ]
        };
    });

    server.setRequestHandler(GetPromptRequestSchema, (request) => {
        const { name, arguments: argsRaw } = request.params;
        const args = argsRaw as Record<string, unknown> | undefined;

        switch (name) {
            case "summarize": {
                const text = typeof args?.text === "string" ? args.text : '';
                const style = typeof args?.style === "string" ? args.style : 'brief';
                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `Please provide a ${style} summary of the following text:\n\n${text}`
                            }
                        }
                    ]
                };
            }
            case "translate": {
                const sourceText = typeof args?.text === "string" ? args.text : '';
                const targetLang = typeof args?.target_language === "string" ? args.target_language : 'English';
                const sourceLang = typeof args?.source_language === "string" ? args.source_language : undefined;
                const languageInstruction = sourceLang
                    ? `from ${sourceLang} to ${targetLang}`
                    : `to ${targetLang}`;

                return {
                    messages: [
                        {
                            role: "user",
                            content: {
                                type: "text",
                                text: `Please translate the following text ${languageInstruction}:\n\n${sourceText}`
                            }
                        }
                    ]
                };
            }
            default:
                throw new Error(`Unknown prompt: ${name}`);
        }
    });

    try {
        // Connect the server
        await server.connect(transport);
        console.log("MCP server started with AMQP transport");
        console.log("Queue prefix: mcp.example");
        console.log(`Exchange: ${process.env.AMQP_EXCHANGE || "mcp.examples"}`);
        console.log("Server is ready to handle requests...");

        // Keep the server running
        await new Promise(() => { }); // Run forever

    } catch (error) {
        console.error("Error starting server:", error);
        process.exit(1);
    }
}

// Handle process signals for graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Run the example
main().catch(console.error);
