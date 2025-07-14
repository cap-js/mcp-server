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

## Usage in MCP Inspector

You can test the server with the _MCP Inspector tool_:
```sh
cd cds-mcp
npx @modelcontextprotocol/inspector node index.js <projectRoot>
```

See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) for more.
