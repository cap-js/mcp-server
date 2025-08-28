# Welcome to @cap-js/mcp-server

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/mcp-server)](https://api.reuse.software/info/github.com/cap-js/mcp-server)



> [!NOTE]
> This project is in alpha state. Don't use it for production code.



## About This Project

A Model Context Protocol (MCP) server for the [SAP Cloud Application Programming Model (CAP)](https://cap.cloud.sap).
Use it for AI-assisted development of CAP applications (_agentic coding_).

The server helps AI models answer questions such as:
- _Which CDS services are in this project, and where are they served?_
- _What are the entities about and how do they relate?_
- _How do I add columns to a select statement in CAP Node.js?_



## Table of Contents

- [About This Project](#about-this-project)
- [Requirements](#requirements)
- [Setup](#setup)
- [Available Tools](#available-tools)
  - [`search_model`](#search_model)
  - [`search_docs`](#search_docs)
- [Usage](#usage)
  - [Usage in VS Code](#usage-in-vs-code)
  - [Usage in opencode](#usage-in-opencode)
  - [CLI UsageI](#cli-usage)
- [How It Works](#how-it-works)
- [Support, Feedback, Contributing](#support-feedback-contributing)
- [Security / Disclosure](#security--disclosure)
- [Code of Conduct](#code-of-conduct)
- [Licensing](#licensing)
- [Acknowledgments](#acknowledgments)



## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.



## Setup

```sh
npm i -g @cap-js/mcp-server
```

This will provide the command `cds-mcp` to start the CAP MCP server.

Configure your MCP client (Cline, opencode, Claude Code, etc.) to start the server using the `cds-mcp` command.

### Usage in VS Code

Example for VS Code extension [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev):
```json
{
  "mcpServers": {
    "cds-mcp": {
      "command": "cds-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

See [VS Code Marketplace](https://marketplace.visualstudio.com/search?term=tag%3Aagent&target=VSCode&category=All%20categories&sortBy=Relevance) for more agent extensions.

### Usage in opencode

Example for [opencode](https://github.com/sst/opencode):
```json
{
  "mcp": {
    "cds-mcp": {
      "type": "local",
      "command": ["cds-mcp"],
      "enabled": true
    }
  }
}
```

### Rules

The following rules help the LLM use the server correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services (which include HTTP endpoints) with cds-mcp, only if it fails you MAY read \*.cds files in the project.
- You MUST search for CAP docs with cds-mcp EVERY TIME you modify CDS models or when using APIs from CAP. Do NOT propose, suggest or make any changes without first checking it.
```

Add these rules to your existing global or project-specific [`AGENTS.md`](https://agents.md/) (specifics may vary based on respective MCP client).

### CLI Usage

For experimental purposes, you can also use the tools directly from the command line:

```sh
# Search for CDS model definitions
cds-mcp search_model . Books entity

# Search CAP documentation
cds-mcp search_docs "how to add columns to a select statement in CAP Node.js" 1
```

## Available Tools

> [!NOTE]
> Tools are meant to be used by AI models and do not constitute a stable API.

The server provides these tools for CAP development:

### `search_model`

Search for CDS definitions (entities, services, actions), including:
- Model structure and relationships
- Annotations and metadata
- HTTP endpoints and OData URLs
- File locations

### `search_docs`

Search [CAP documentation](https://cap.cloud.sap) for:
- Code snippets and examples
- API usage patterns





## How It Works

The server provides two complementary search mechanisms, optimized for different use cases:

### `search_model` - Compiled Model Search

This tool performs fuzzy searches against the compiled CDS model (Core Schema Notation).
When you run a CAP project, CDS compiles all your `.cds` files into a unified model representation that includes:
- All entities, services, actions, and their relationships
- Annotations and metadata
- Generated HTTP endpoints

The fuzzy search algorithm matches definition names and allows for partial matches, making it easy to find entities like "Books" even when searching for "book".

### `search_docs` - Embedding-Based Documentation Search

This tool uses vector embeddings to search through preprocessed CAP documentation stored locally. The process works as follows:

1. **Pre-processing:** CAP documentation is split into semantic sections and converted to vector embeddings.
2. **Query processing:** Your search query is also converted to an embedding vector.
3. **Similarity search:** The system finds documentation chunks with the highest semantic similarity to your query.

This semantic search approach enables you to find relevant documentation even when your query does not use the exact keywords found in the docs, all locally on your machine.


## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports, and so on, via [GitHub issues](https://github.com/cap-js/mcp-server/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).



## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/cap-js/mcp-server/security/policy) on how to report it. Please don't create GitHub issues for security-related doubts or problems.



## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.



## Licensing

Copyright 2025 SAP SE or an SAP affiliate company and @cap-js/cds-mcp contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/mcp-server).



## Acknowledgments

- **onnxruntime-web** is used for creating embeddings in Node.js.
- **@huggingface/transformers.js** for the reference implementation for the WordPiece tokenizer.
- **@modelcontextprotocol/sdk** provides the SDK for MCP.
