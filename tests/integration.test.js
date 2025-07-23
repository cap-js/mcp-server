// Integration test for cds-mcp server
import assert from "node:assert";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const sampleProjectPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "sample",
);
const cdsMcpPath = join(dirname(fileURLToPath(import.meta.url)), "../index.js");

test("integration: spawn cds-mcp and call search_cds_definitions tool", async () => {
  // Step 2: Spawn the MCP server in the sample project directory
  const transport = new StdioClientTransport({
    command: "node",
    args: [cdsMcpPath],
    cwd: sampleProjectPath,
  });

  // Step 3: Use the MCP Client API to connect to the server
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(transport);

  // Step 4: Programmatically call a tool and verify output
  const result = await client.callTool({
    name: "search_cds_definitions",
    arguments: {
      projectPath: sampleProjectPath,
      kind: "service",
      topN: 1,
    },
  });

  assert(Array.isArray(result.content), "Tool result should be an array");
  assert(result.content.length > 0, "Should return at least one result");
  const serviceResults = JSON.parse(result.content[0].text);
  assert.equal(
    serviceResults[0].name,
    "AdminService",
    "Should return the AdminService",
  );
  // Step 5: Clean up
  await transport.close();
});
