# MCP Server for CAP

A Model Context Protocol server that exposes CAP's CDS model as resources.

It's in an **alpha state**.

## Motivation

The server is supposed to help AI models answer questions like

- _Which CDS services are there in this project?_
- _What are the entities about?_
- _How do they relate?_

On top, [MCP tools](https://modelcontextprotocol.io/docs/concepts/tools) could be provided that can

- Create projects.
- Fill it will content, like adding test data, handler stubs.
- Read the application configuration.

and more.

## Setup

```sh
git clone https://github.com/cap-js/cds-mcp
cd cds-mcp
npm install
npm i -g @cap-js/cds-mcp@.
```

## Usage

Configure your MCP Client (Cline, Codex, opencode, etc.) to use the server with command `cds-mcp`.
It is strongly recommended to use an API docs provider, like `context7`, to get the best results.
The library ID for CAP in `context7` is `/context7/cap_cloud_sap`.
The following rules help to guide the LLM to use the server correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services with the MCP server `cds`, only if it fails you MAY read *.cds files in the project.
- Whenever you want to execute OData requests to the running CAP app, you must first search the cds definition `search_cds_definition` to retrieve the service entity (not the db entity), which contains info about the endpoint
- Whenever you start the cds app, e.g. using `cds serve`, it must be done in the background and afterwards you must check that it runs.

- You MUST consult context7 (library id: `/context7/cap_cloud_sap`) for documentation and guidance EVERY TIME you modify CDS models. Do NOT propose, suggest or make any CDS changes without first checking context7.
- You MUST consult context7 (library id: `/context7/cap_cloud_sap`) for documentation and guidance EVERY TIME you use APIs from SAP Cloud Application Programming Model (CAP). Do NOT propose, suggest or make any CDS changes without first checking context7.
```

## Usage in VS Code

> [!CAUTION]
> At SAP, MCP in VS Code seems to be centrally **disabled** at the moment.
> Error is: _Unable to write chat.mcp.enabled because it is configured in system policy._

**Register the server** once: run command `MCP: Add Server...`. In there:

- Select `command`.
- Set `node <your-repo>/index.js` as command.

**In an application project**, open the _Chat_ panel.
Select the server through the _Select tools_ button.

See the [VS Code docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for more.

## Usage in [opencode](https://github.com/sst/opencode)

Use the following configuration in ~/.config/opencode/opencode.json, it's recommended to use an API docs provider, like `context7`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cds": {
      "type": "local",
      "command": ["cds-mcp"],
      "enabled": true,
      "environment": {}
    },
    "context7": {
      "type": "local",
      "command": ["context7-mcp"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Don't forget to add the rules to ~/.config/opencode/AGENTS.md, or in your project-specific AGENTS.md file.

## Usage in MCP Inspector

You can test the server with the _MCP Inspector tool_:

```sh
cd cds-mcp
npx @modelcontextprotocol/inspector node index.js <projectRoot>
```

See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) for more.
