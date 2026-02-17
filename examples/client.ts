import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "../src/transports/index.js";

/**
 * Example MCP client using AMQP transport
 *
 * Demonstrates connecting to an MCP server through an AMQP broker,
 * listing capabilities, and calling tools/resources/prompts.
 */

async function main() {
    const transport = new AMQPClientTransport({
        amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
        serverQueuePrefix: "mcp.example",
        exchangeName: process.env.AMQP_EXCHANGE || "mcp.examples",
        responseTimeout: 30000,
    });

    const client = new Client(
        { name: "amqp-example-client", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.log("Connected to MCP server via AMQP");

        const toolsResult = await client.listTools();
        console.log("Available tools:", toolsResult.tools);

        const resourcesResult = await client.listResources();
        console.log("Available resources:", resourcesResult.resources);

        const promptsResult = await client.listPrompts();
        console.log("Available prompts:", promptsResult.prompts);

        // Call a tool
        if (toolsResult.tools.length > 0) {
            const tool = toolsResult.tools[0]!;
            const args = (tool.name === "echo" || tool.name === "reverse")
                ? { text: "Hello from AMQP client" }
                : {};
            const result = await client.callTool({ name: tool.name, arguments: args });
            console.log("Tool result:", result);
        }

        // Read a resource
        if (resourcesResult.resources.length > 0) {
            const resource = resourcesResult.resources[0]!;
            const result = await client.readResource({ uri: resource.uri });
            console.log("Resource content:", result);
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
        console.log("Client disconnected");
    }
}

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });

main().catch(console.error);
