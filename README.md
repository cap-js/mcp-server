# Welcome to @cap-js/mcp-server

[![REUSE status](https://api.reuse.software/badge/github.com/cap-js/mcp-server)](https://api.reuse.software/info/github.com/cap-js/mcp-server)



> [!WARNING]
> Alpha!



## About this project

MCP server for SAP Cloud Application Programming Model (`@cap-js/mcp-server`) is a Model Context Protocol server for AI-assisted development (_vibe coding_) of CAP applications.

The server is supposed to help AI models answer questions like

- _Which CDS services are there in this project and where are they served?_
- _What are the entities about?_
- _How do they relate?_



## Requirements

See [Getting Started](https://cap.cloud.sap/docs/get-started) on how to jumpstart your development and grow as you go with SAP Cloud Application Programming Model.



## Setup

```sh
git clone https://github.com/cap-js/mcp-server
cd mcp-server
npm install
npm i -g @cap-js/mcp-server@.
```



## Usage

Configure your MCP Client (Cline, Codex, opencode, etc.) to use the server with command `mcp-server`.
It is strongly recommended to use an API docs provider, like `context7`, to get the best results.
The library ID for CAP in `context7` is `/context7/cap_cloud_sap`.
The following rules help to guide the LLM to use the servers correctly:

```markdown
- You MUST search for CDS definitions, like entities, fields and services with the MCP server `cds`, only if it fails you MAY read \*.cds files in the project.
- Whenever you want to execute OData requests to the running CAP app, you must first search the cds definition `search_cds_definition` to retrieve the service entity (not the db entity), which contains info about the endpoint
- Whenever you start the cds app, e.g. using `cds serve`, it must be done in the background and afterwards you must check that it runs.
- You MUST consult context7 (library id: `/context7/cap_cloud_sap`) for documentation and guidance EVERY TIME you modify CDS models. Do NOT propose, suggest or make any CDS changes without first checking context7.
- You MUST consult context7 (library id: `/context7/cap_cloud_sap`) for documentation and guidance EVERY TIME you use APIs from SAP Cloud Application Programming Model (CAP). Do NOT propose, suggest or make any CDS changes without first checking context7.
```


### Usage in VS Code

> [!CAUTION]
> At SAP, MCP in VS Code seems to be centrally **disabled** at the moment.
> Error is: _Unable to write chat.mcp.enabled because it is configured in system policy._

**Register the server** once: run command `MCP: Add Server...`.
In there:
- Select `command`.
- Set `mcp-server` as command.

**In an application project**, open the _Chat_ panel.
Select the server through the _Select tools_ button.

See the [VS Code docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for more.


### Usage in [opencode](https://github.com/sst/opencode)

Use the following configuration in `~/.config/opencode/opencode.json`, it's recommended to use an API docs provider, like `context7`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cds": {
      "type": "local",
      "command": ["mcp-server"],
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

Don't forget to add the rules to `~/.config/opencode/AGENTS.md`, or in your project-specific `AGENTS.md` file.


### Usage in MCP Inspector

You can test the server with the _MCP Inspector tool_:

```sh
cd mcp-server
npx @modelcontextprotocol/inspector node index.js <projectRoot>
```

See the [MCP Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) for more.



## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/cap-js/mcp-server/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).



## Security / Disclosure

If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/cap-js/mcp-server/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.



## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/cap-js/.github/blob/main/CODE_OF_CONDUCT.md) at all times.



## Licensing

Copyright 2025 SAP SE or an SAP affiliate company and mcp-server contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js/mcp-server).
