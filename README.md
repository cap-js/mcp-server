# Welcome to @sap/cds-mcp

> [!WARNING]
> Alpha!

## About this project

MCP server for SAP Cloud Application Programming Model (`@sap/cds-mcp`) is a Model Context Protocol server for AI-assisted development (_vibe coding_) of CAP applications.

The server is supposed to help AI models answer questions like

- _Which CDS services are there in this project and where are they served?_
- _What are the entities about?_
- _How do they relate?_

## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.

## Setup

```sh
git clone https://github.tools.sap/cap/cds-mcp
cd cds-mcp
npm i
npm i -g @sap/cds-mcp@.
```

## Usage

Configure your MCP Client (Cline, Codex, opencode, etc.) to use the server with command `cds-mcp`.
The following rules help to guide the LLM to use the servers correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services (which include HTTP endpoints) with cds-mcp, only if it fails you MAY read \*.cds files in the project.
- You MUST search for CAP docs with cds-mcp EVERY TIME you modify CDS models or when using APIs from CAP. Do NOT propose, suggest or make any changes without first checking it.
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
cd mcp-server
npx @modelcontextprotocol/inspector node index.js <projectRoot>
```

See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) for more.


## How to Obtain Support

In case you find a bug, please report an [incident](https://cap.cloud.sap/docs/resources/#support-channels) on SAP Support Portal.

## License

This package is provided under the terms of the [SAP Developer License Agreement](https://cap.cloud.sap/resources/license/developer-license-3_2_CAP.txt).

