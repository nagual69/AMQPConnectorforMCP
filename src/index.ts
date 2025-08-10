/**
 * AMQP Connector for Model Context Protocol (MCP)
 * 
 * This package provides AMQP-based transport implementations for MCP,
 * enabling distributed MCP server and client architectures through message queues.
 * 
 * Compatible with the official MCP TypeScript SDK and follows MCP transport specifications.
 * 
 * @example Client Usage:
 * ```typescript
 * import { AMQPClientTransport } from "amqp-mcp-transport";
 * 
 * const transport = new AMQPClientTransport({
 *   amqpUrl: "amqp://localhost",
 *   serverQueuePrefix: "mcp.myapp",
 *   exchangeName: "mcp.notifications"
 * });
 * 
 * await transport.start();
 * // Use with MCP Client
 * ```
 * 
 * @example Server Usage:
 * ```typescript
 * import { AMQPServerTransport } from "amqp-mcp-transport";
 * 
 * const transport = new AMQPServerTransport({
 *   amqpUrl: "amqp://localhost", 
 *   queuePrefix: "mcp.myapp",
 *   exchangeName: "mcp.notifications"
 * });
 * 
 * await transport.start();
 * // Use with MCP Server
 * ```
 */

export * from "./transports/index.js";
