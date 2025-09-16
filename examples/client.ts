import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "../src/transports/index.js";

/**
 * Example MCP client using AMQP transport
 * 
 * This example demonstrates how to create an MCP client that communicates
 * with an MCP server through AMQP message queues.
 */

async function main() {
    // Create AMQP transport
    const transport = new AMQPClientTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://mcp:discovery@localhost:5672",
        serverQueuePrefix: "mcp.example",
        exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
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

        // List available prompts
        const promptsResult = await client.listPrompts();
        console.log("Available prompts:", promptsResult.prompts);

        // Example: Call a tool if available
        if (toolsResult.tools.length > 0) {
            const firstTool = toolsResult.tools[0];
            if (firstTool) {
                console.log(`Calling tool: ${firstTool.name}`);

                // Provide required arguments if the tool expects them
                const defaultArgs: Record<string, unknown> =
                    firstTool.name === "echo" || firstTool.name === "reverse"
                        ? { text: "Hello from AMQP client" }
                        : {};

                const toolResult = await client.callTool({
                    name: firstTool.name,
                    arguments: defaultArgs
                });

                console.log("Tool result:", toolResult);
            }
        }

        // Example: Read a resource if available
        if (resourcesResult.resources.length > 0) {
            const firstResource = resourcesResult.resources[0];
            if (firstResource) {
                console.log(`Reading resource: ${firstResource.uri}`);

                const resourceResult = await client.readResource({
                    uri: firstResource.uri
                });

                console.log("Resource content:", resourceResult);
            }
        }

        // Example: Get a prompt if available
        if (promptsResult.prompts.length > 0) {
            const firstPrompt = promptsResult.prompts[0];
            if (firstPrompt) {
                console.log(`Getting prompt: ${firstPrompt.name}`);

                const promptResult = await client.getPrompt({
                    name: firstPrompt.name,
                    arguments: {
                        text: "Hello world! This is a test message for the AMQP MCP transport.",
                        style: "brief"
                    }
                });

                console.log("Prompt result:", promptResult);
            }
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
