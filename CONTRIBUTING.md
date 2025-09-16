# Contributing to AMQP MCP Transport

We welcome contributions to the AMQP MCP Transport project! This document provides guidelines for contributing.

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-org/AMQPConnectorforMCP.git
   cd AMQPConnectorforMCP
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the project**

   ```bash
   npm run build
   ```

4. **Run tests**

   ```bash
   npm test
   ```

5. **Start development environment**

   ```bash
   # Start RabbitMQ for testing
   docker-compose up -d

   # Run in watch mode
   npm run dev
   ```

## Project Structure

```
├── src/
│   ├── index.ts                    # Main entry point
│   └── transports/
│       ├── amqp-client-transport.ts # AMQP client transport
│       ├── amqp-server-transport.ts # AMQP server transport
│       ├── amqp-utils.ts           # Utility functions
│       ├── types.ts                # Type definitions
│       ├── index.ts                # Transport exports
│       └── deprecated/             # Legacy implementations
├── examples/                       # Usage examples
├── dist/                          # Compiled output (gitignored)
└── docs/                          # Documentation
```

## Code Style

- Use TypeScript for all source code
- Follow the existing ESLint configuration
- Write comprehensive JSDoc comments
- Use meaningful variable and function names
- Keep functions focused and testable

## Testing

- Write unit tests for new features
- Ensure all tests pass before submitting PR
- Aim for good test coverage
- Test both success and error scenarios

## Pull Request Process

1. **Fork** the repository
2. **Create** a feature branch from `main`
3. **Make** your changes
4. **Add** tests for new functionality
5. **Ensure** all tests pass and code builds
6. **Update** documentation if needed
7. **Submit** a pull request

## Pull Request Guidelines

- Use descriptive commit messages
- Reference issue numbers when applicable
- Keep PRs focused and reasonably sized
- Include tests for new features
- Update documentation for API changes

## Issues

When reporting issues:

- Use a clear, descriptive title
- Provide reproduction steps
- Include environment details
- Add relevant logs or error messages

## Development Guidelines

### Transport Implementation

- Follow the MCP Transport interface exactly
- Ensure proper error handling and cleanup
- Support all MCP message types (request, response, notification)
- Maintain session tracking and correlation

### AMQP Best Practices

- Use appropriate exchange types and routing
- Handle connection failures gracefully
- Implement proper message acknowledgment
- Support message persistence when needed

### TypeScript Guidelines

- Use strict type checking
- Avoid `any` types when possible
- Export proper type definitions
- Follow naming conventions

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag
4. Publish to npm (maintainers only)

## License

By contributing, you agree that your contributions will be licensed under the Apache License, Version 2.0.

## Questions?

Feel free to open an issue for questions or discussions about contributing.
