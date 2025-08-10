import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "../src/index.js";

/**
 * Example MCP client using AMQP transport
 * 
 * This example demonstrates how to create an MCP client that communicates
 * with an MCP server through AMQP message queues.
 */

async function main() {
    // Create AMQP transport
    const transport = new AMQPClientTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://localhost",
        serverQueuePrefix: "mcp.example",
        exchangeName: "mcp.notifications",
        responseTimeout: 30000,
        reconnectDelay: 5000,
        maxReconnectAttempts: 10
    });

    // Create MCP client with AMQP transport
    const client = new Client(
        {
            name: "amqp-example-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    try {
        // Connect to transport - this handles initialization automatically
        await client.connect(transport);
        console.log("Connected to MCP server via AMQP");

        // List available tools
        const toolsResult = await client.listTools();
        console.log("Available tools:", toolsResult.tools);

        // List available resources  
        const resourcesResult = await client.listResources();
        console.log("Available resources:", resourcesResult.resources);

        // Example: Call a tool if available
        if (toolsResult.tools.length > 0) {
            const firstTool = toolsResult.tools[0];
            console.log(`Calling tool: ${firstTool.name}`);

            const toolResult = await client.callTool({
                name: firstTool.name,
                arguments: {}
            });

            console.log("Tool result:", toolResult);
        }

        // Example: Read a resource if available
        if (resourcesResult.resources.length > 0) {
            const firstResource = resourcesResult.resources[0];
            console.log(`Reading resource: ${firstResource.uri}`);

            const resourceResult = await client.readResource({
                uri: firstResource.uri
            });

            console.log("Resource content:", resourceResult);
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        // Clean up
        await client.close();
        console.log("Client disconnected");
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
