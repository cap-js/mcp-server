# Welcome to @cap-js/mcp-server

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/mcp-server)](https://api.reuse.software/info/github.com/cap-js/mcp-server)



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
  - [Usage in VS Code](#usage-in-vs-code)
  - [Usage in Claude Code](#usage-in-claude-code)
  - [Usage in OpenAI Codex](#usage-in-openai-codex)
  - [Usage in opencode](#usage-in-opencode)
  - [CLI Usage](#cli-usage)
  - [Environment Variables](#environment-variables)
- [Available Tools](#available-tools)
  - [`search_model`](#search_model)
  - [`search_docs`](#search_docs)
- [Support, Feedback, Contributing](#support-feedback-contributing)
- [Security / Disclosure](#security--disclosure)
- [Code of Conduct](#code-of-conduct)
- [Licensing](#licensing)
- [Acknowledgments](#acknowledgments)



## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.



## Setup

Configure your MCP client (Cline, opencode, Claude Code, GitHub Copilot, etc.) to start the server using the command `npx -y @cap-js/mcp-server` as in the following examples.

### Usage in Claude Code

Register the server with [Claude Code](https://claude.com/claude-code).

**For all projects (user scope):**
```sh
claude mcp add --scope user cds-mcp -- npx -y @cap-js/mcp-server
```

**For the current project only (local scope, not committed):**
```sh
claude mcp add cds-mcp -- npx -y @cap-js/mcp-server
```

**For the current project only (committed to the repository):**
```sh
claude mcp add --scope project cds-mcp -- npx -y @cap-js/mcp-server
```

To set an environment variable, add `--env` before the server name:
```sh
claude mcp add --scope user --env CDS_MCP_MODEL=nomic-ai/nomic-embed-text-v1.5 cds-mcp -- npx -y @cap-js/mcp-server
```

### Usage in VS Code

Example for VS Code extension [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev):
```json
{
  "mcpServers": {
    "cds-mcp": {
      "command": "npx",
      "args": ["-y", "@cap-js/mcp-server"],
      "env": {}
    }
  }
}
```

Example for VS Code global [mcp.json](https://code.visualstudio.com/docs/copilot/customization/mcp-servers):
> Note: GitHub Copilot uses the `mcp.json` file as source for it's Agent mode.
```json
{
  "servers": {
    "cds-mcp": {
      "command": "npx",
      "args": ["-y", "@cap-js/mcp-server"],
      "env": {},
      "type": "stdio"
    },
    "inputs": []
  }
}
```

To set an environment variable, replace the server's empty `env` object with:
```json
"env": {
  "CDS_MCP_MODEL": "nomic-ai/nomic-embed-text-v1.5"
}
```

See [VS Code Marketplace](https://marketplace.visualstudio.com/search?term=tag%3Aagent&target=VSCode&category=All%20categories&sortBy=Relevance) for more agent extensions.

### Usage in OpenAI Codex

Register the server with [OpenAI Codex](https://openai.com/codex):

```sh
codex mcp add cds-mcp -- npx -y @cap-js/mcp-server
```

To set an environment variable, add `--env` before the command:
```sh
codex mcp add cds-mcp --env CDS_MCP_MODEL=nomic-ai/nomic-embed-text-v1.5 -- npx -y @cap-js/mcp-server
```

### Usage in opencode

Add to `opencode.jsonc` in your project, or to `~/.config/opencode/opencode.jsonc` for global use:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cds-mcp": {
      "type": "local",
      "command": ["npx", "-y", "@cap-js/mcp-server"],
      "environment": {
        "CDS_MCP_MODEL": "nomic-ai/nomic-embed-text-v1.5"
      },
      "enabled": true
    }
  }
}
```

This is the [opencode v1](https://opencode.ai/docs/mcp-servers/) format. In [opencode v2](https://opencode.ai/v2/docs/mcp-servers/), use the same config but nest the server under `"servers"` — `"mcp": { "servers": { "cds-mcp": { ... } } }` — or use the CLI instead:

```sh
opencode mcp add --global cds-mcp -- npx -y @cap-js/mcp-server
```

To set an environment variable:
```sh
opencode mcp add --global cds-mcp \
  --env CDS_MCP_MODEL=nomic-ai/nomic-embed-text-v1.5 \
  -- npx -y @cap-js/mcp-server
```

### Environment Variables

> [!WARNING]
> The following environment variables are still experimental.

| Variable | Description |
| --- | --- |
| `CDS_MCP_OFFLINE` | Set to `true` to use locally cached embeddings without checking for updates. Accepts `true` or `false`. |
| `CDS_MCP_MODEL` | Non-empty embedding model name. |
| `CDS_MCP_MANIFEST_TIMEOUT` | Manifest request timeout in positive integer milliseconds. Defaults to `15000`. |
| `CDS_MCP_DOWNLOAD_TIMEOUT` | Bundle response-header timeout in positive integer milliseconds. Defaults to `30000`. |
| `CDS_MCP_GENERIC_EMBEDDINGS` | Set to `true` to skip the runtime filter and search all runtimes. By default `search_docs` keeps only the chunks of the detected project runtime (Node.js or Java) plus the runtime-agnostic chunks. |
| `CDS_MCP_MAX_RESULTS` | Upper limit on the number of `search_docs` results, as a positive integer. Caps the per-call `maxResults`. |
| `CDS_MCP_RERANK_ENABLED` | Set to `true` to rerank `search_docs` results with a local cross-encoder model. Accepts `true` or `false`; disabled by default. |
| `CDS_MCP_RERANK_MODEL` | Non-empty cross-encoder model name used when reranking. Defaults to `Xenova/ms-marco-MiniLM-L-6-v2`. |
| `CDS_MCP_RERANK_DTYPE` | Non-empty data type used to load the reranking model. Defaults to `q8`; set to `fp32` for models without `model_quantized.onnx`. |
| `CDS_MCP_RERANK_EXTERNAL_DATA` | Set to `true` for reranking models whose ONNX weights are stored in external `.onnx_data` files. Accepts `true` or `false`. |
| `CDS_MCP_RERANK_BATCH_SIZE` | Positive integer number of results to process in each reranking batch. Defaults to `1`. |

### Rules

The following rules help the LLM use the server correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services (which include HTTP endpoints) with cds-mcp, only if it fails you MAY read \*.cds files in the project.
- You MUST search for CAP docs with cds-mcp EVERY TIME you create, modify CDS models or when using APIs or the `cds` CLI from CAP. Do NOT propose, suggest or make any changes without first checking it.
```

Add these rules to your existing global or project-specific [`AGENTS.md`](https://agents.md/) (specifics may vary based on respective MCP client).

### CLI Usage

You can also use the tools directly from the command line.

```sh
npm i -g @cap-js/mcp-server
```

> [!WARNING]
> When the package is installed globally, `npx` uses the installed version instead of downloading the latest from npm. You must update the package manually:
> ```sh
> npm update -g @cap-js/mcp-server
> ```

This will provide the command `cds-mcp`, with which you can invoke the tools directly as follows.

```sh
# Search CAP documentation
cds-mcp search_docs "how to add columns to a select statement in CAP Node.js" 1

# Search for CDS model definitions
cds-mcp search_model . Books entity
```

## Available Tools

> [!NOTE]
> Tools are meant to be used by AI models and do not constitute a stable API.

The server provides these tools for CAP development:

### `search_docs`

This tool uses vector embeddings to locally search through preprocessed CAP documentation, stored as embeddings. The process works as follows:

1. **Query processing:** Your search query is converted to an embedding vector.
2. **Similarity search:** The system finds documentation chunks with the highest semantic similarity to your query.

This semantic search approach enables you to find relevant documentation even when your query does not use the exact keywords found in the docs, all locally on your machine.

### `search_model`

This tool performs fuzzy searches against names of definitions from the compiled CDS model (Core Schema Notation).
CDS compiles all your `.cds` files into a unified model representation that includes:
- All definitions and their relationships
- Annotations
- HTTP endpoints

The fuzzy search algorithm matches definition names and allows for partial matches, making it easy to find entities like "Books" even when searching for "book".

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports, and so on, via [GitHub issues](https://github.com/cap-js/mcp-server/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).



## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/cap-js/mcp-server/security/policy) on how to report it. Please don't create GitHub issues for security-related doubts or problems.



## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.



## Licensing

Copyright 2025 SAP SE or an SAP affiliate company and @cap-js/cds-mcp contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/mcp-server).



## Acknowledgments

- **onnxruntime-web** is used for creating embeddings locally.
- **@huggingface/transformers.js** is used to compare the output of the WordPiece tokenizer.
- **@modelcontextprotocol/sdk** provides the SDK for MCP.
