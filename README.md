# @cap-js/mcp-server

A Model Context Protocol (MCP) server for the [SAP Cloud Application Programming Model (CAP)](https://cap.cloud.sap).
Use it for AI-assisted development of CAP applications (_agentic coding_).

The server helps AI models answer questions like:

- _Which CDS services are there in this project and where are they served?_
- _What are the entities about?_
- _How do they relate?_
- _How do I add columns to a select statement in CAP Node.js?_

> [!NOTE]
> This project is in alpha state. Do not use for production code.

## Available Tools

The server provides these tools for CAP development:

### `search_model`

Search for CDS definitions (entities, services, actions) including:

- Model structure and relationships
- Annotations and metadata
- HTTP endpoints and OData URLs
- File locations

### `search_docs`

Search [CAP documentation](https://cap.cloud.sap) for:

- Code snippets and examples
- API usage patterns
- Best practices
- Implementation guides

## Setup

```sh
git clone https://github.com/cap-js/mcp-server
cd mcp-server
npm ci
npm i -g .
```

## Usage

Configure your MCP client (Cline, Codex, opencode, etc.) to use the server with command `cds-mcp`.
The following rules help guide the LLM to use the server correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services (which include HTTP endpoints) with cds-mcp, only if it fails you MAY read \*.cds files in the project.
- You MUST search for CAP docs with cds-mcp EVERY TIME you modify CDS models or when using APIs from CAP. Do NOT propose, suggest or make any changes without first checking it.
```

### CLI Usage

You can also use the tools directly from the command line:

```sh
# Search for CDS model definitions
cds-mcp search_model . Books entity

# Search CAP documentation
cds-mcp search_docs "how to add columns to a select statement in CAP Node.js" 1
```

### Usage in VS Code

**Register the server** once: run command `MCP: Add Server...`.
In there:

- Select `command`.
- Set `cds-mcp` as command.

**In an application project**, open the _Chat_ panel.
Select the server through the _Select tools_ button.

See the [VS Code docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for more.

### Usage in [opencode](https://github.com/sst/opencode)

Use the following configuration in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cds-mcp": {
      "type": "local",
      "command": ["cds-mcp"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Don't forget to add the rules to `~/.config/opencode/AGENTS.md`, or in your project-specific `AGENTS.md` file.

### Usage in MCP Inspector

You can test the server with the _MCP Inspector tool_:

```sh
npx @modelcontextprotocol/inspector cds-mcp <projectRoot>
```

See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) for more.

## How It Works

The server provides two complementary search mechanisms optimized for different use cases:

### `search_model` - Compiled Model Search

This tool performs fuzzy search against the compiled CDS model (CSN - Core Schema Notation). When you run a CAP project, CDS compiles all your `.cds` files into a unified model representation that includes:

- All entities, services, actions, and their relationships
- Resolved annotations and metadata
- Generated HTTP endpoints and OData URLs
- Cross-references between definitions

The fuzzy search algorithm matches definition names and allows for typos or partial matches, making it easy to find entities like "Books" even when searching for "book" or "boks".

### `search_docs` - Embedding-Based Documentation Search

This tool uses vector embeddings to search through CAP documentation content stored locally. The process works as follows:

1. **Pre-processing**: CAP documentation is chunked into semantic sections and converted to vector embeddings using a local embedding model
2. **Query processing**: Your search query is also converted to an embedding vector
3. **Similarity search**: The system finds documentation chunks with the highest semantic similarity to your query

This approach enables semantic search - you can find relevant documentation even when your query doesn't contain exact keywords from the docs.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/mcp-server/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/cap-js/mcp-server/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2025 SAP SE or an SAP affiliate company and @cap-js/cds-mcp contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/mcp-server).

## Acknowledgments

- **onnxruntime-web** is used for creating embeddings in Node.js
- **@huggingface/transformers.js** for the reference implementation for the WordPiece tokenizer
- **@modelcontextprotocol/sdk** provides the SDK for MCP
