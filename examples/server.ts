import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AMQPServerTransport } from "../src/index.js";

/**
 * Example MCP server using AMQP transport
 * 
 * This example demonstrates how to create an MCP server that serves
 * tools and resources through AMQP message queues.
 */

async function main() {
    // Create AMQP transport
    const transport = new AMQPServerTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://localhost",
        queuePrefix: "mcp.example",
        exchangeName: "mcp.notifications",
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
                resources: {}
            }
        }
    );

    // Add example tools
    server.setRequestHandler("tools/list", async () => {
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

    server.setRequestHandler("tools/call", async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {
            case "echo":
                return {
                    content: [
                        {
                            type: "text",
                            text: `Echo: ${args.text}`
                        }
                    ]
                };

            case "reverse":
                return {
                    content: [
                        {
                            type: "text",
                            text: `Reversed: ${args.text.split('').reverse().join('')}`
                        }
                    ]
                };

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });

    // Add example resources
    server.setRequestHandler("resources/list", async () => {
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

    server.setRequestHandler("resources/read", async (request) => {
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

    try {
        // Connect the server
        await server.connect(transport);
        console.log("MCP server started with AMQP transport");
        console.log("Queue prefix: mcp.example");
        console.log("Exchange: mcp.notifications");
        console.log("Server is ready to handle requests...");

        // Keep the server running
        await new Promise(() => { }); // Run forever

    } catch (error) {
        console.error("Error starting server:", error);
        process.exit(1);
    }
}

// Handle process signals for graceful shutdown
process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Run the example
main().catch(console.error);
