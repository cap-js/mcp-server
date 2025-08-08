import fs from "fs/promises";
import { setTimeout } from "timers/promises";
import { createEmbeddings } from "../lib/embeddings.js";
import os from "os";
import path from "path";

main();

const labels = new Set();
const types = new Set();

const getSystemMessage = () => ({
  role: "system",
  content: `You are a chunks creator.
  You are given a documenation snippet and you need to create a list of chunks, specialized to show code samples.
  The result must be a JSON array of objects [{ labels: [<string>], code: <string>, type: "JavaScript/Java/cds/shell/json/...", summary: <string>, source: <string> }], empty array if you cannot provide any.
  For labels: Do not invent too many, only the most important ones, reuse existing ones from ${JSON.stringify(Array.from(labels))} if possible.
  For code: Show the important code snippet.
  For type: Use existing type from ${JSON.stringify(Array.from(types))}, or invent a new one if appropriate.
  For summary: Write a short summary of what that code snippet does and in what context it is used. You can write multiple sentences, keep it technical. Include all important details to make sense of the snippet or to be able to search for it later.
  For source: All headers to this snippet, e.g. Main Header > Sub Header > Sub Sub Heading
`,
});

async function main() {
  // can also run independently, stored/read on file system
  // await createSnippets();
  // await createSnippetsEmbeddings();
  // afterwards, copy ./docs/* to https://github.tools.sap/cap/docs-resources -> public/embeddings/

}

async function createSnippetsEmbeddings() {
  const chunks = JSON.parse(
    await fs.readFile(path.join(os.tmpdir(), "code-snippets.json")),
  );
  await createEmbeddings(
    "code",
    chunks.map((c) => {
      c.content = chunkToText(c);
      return c;
    }),
  );
}

async function createSnippets() {
  const chunks = await getChunks();
  console.log("total ", chunks.length, "chunks");
  const allChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 1) break;
    const chunk = chunks[i];
    let retryCount = 0;
    let success = false;

    while (retryCount < 4 && !success) {
      try {
        console.log(
          "processing chunk",
          i,
          "(" +
            Math.round((i / chunks.length) * 100) +
            "%)" +
            (retryCount > 0 ? ` - retry ${retryCount}` : ""),
        );
        const messages = [
          getSystemMessage(),
          { role: "user", content: chunk.content },
        ];
        const exec = async () =>
          llm.send({ deployment_id: "gpt-4.1", messages });
        const res = await exec();
        const result = JSON.parse(res.choices[0].message.content);
        if (Array.isArray(result) && result.length) {
          for (const x of result) {
            for (const label of x.labels) labels.add(label);
            types.add(x.type);
          }
          allChunks.push(...result);
        }
        success = true;
      } catch (e) {
        retryCount++;
        console.error(
          `Error processing chunk ${i} (attempt ${retryCount}/4):`,
          e.message,
        );
        if (retryCount < 4) {
          await setTimeout(5000);
        } else {
          console.error(
            `Failed to process chunk ${i} after 4 attempts, skipping...`,
          );
        }
      }
    }
  }

  await fs.writeFile(
    path.join(os.tmpdir(), "code-snippets.json"),
    JSON.stringify(allChunks),
  );
}

async function createMarkdown(chunks) {
  let markdown = "";

  for (const chunk of chunks) {
    const headerText = chunk.source
      .replace(/\s*>\s*/g, " > ")
      .replaceAll("#", "");

    markdown += `# ${headerText}\n\n`;

    markdown += "## Summary";
    markdown += `\n${chunk.summary}\n\n`;

    markdown += `\`\`\`${chunk.type}\n${chunk.code}\n\`\`\`\n\n`;

    if (chunk.labels && chunk.labels.length > 0) {
      markdown += `## Labels\n${chunk.labels.join(", ")}`;
    }

    markdown += "\n\n";
  }

  await fs.writeFile("code-snippets.md", markdown);
  return markdown;
}

function chunkToText(chunk) {
  let text = `${chunk.source}\n`;
  if (chunk.labels && chunk.labels.length > 0) {
    text += `${chunk.labels.join(", ")}`;
  }
  text += `\n${chunk.summary}\n\n`;
  text += `\`\`\`${chunk.type}\n${chunk.code}\n\`\`\`\n`;
  return text;
}

const CLIENTS = {
  ollama: class Ollama {
    async send(payload) {
      const { spawn } = require("child_process");

      spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
      }).unref();

      const response = await fetch(
        "http://localhost:11434/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            Object.assign(payload, { model: payload.deployment_id }),
          ),
        },
      );
      const data = await response.json();
      return data;
    }
  },
  http: class HTTPClient {
    async send(payload) {
      if (!this.credentials) {
        try {
          this.credentials = JSON.parse(process.env.LLM_ACCESS_SERVICE_KEY);
        } catch (e) {
          console.error(e);
          throw new Error(
            "You need to provide the service key in environment variable LLM_ACCESS_SERVICE_KEY",
          );
        }
      }
      if (!this.token) {
        const res = await http.get(
          this.credentials.uaa.sburl,
          "/oauth/token?grant_type=client_credentials&response_type=token",
          {
            Authorization:
              "Basic " +
              Buffer.from(
                this.credentials.uaa.clientid +
                  ":" +
                  this.credentials.uaa.clientsecret,
              ).toString("base64"),
            "x-zid": this.credentials.uaa.tenantid,
          },
        );
        this.token = res.body.access_token;
      }
      const res = await http.post(
        this.credentials.url,
        "/api/v1/completions",
        { Authorization: "Bearer " + this.token },
        payload,
      );
      return res.body;
    }
  },
  http_ai_core: class HTTPClient {
    async send(payload) {
      if (!this.credentials) {
        try {
          this.credentials = JSON.parse(process.env.AI_CORE_SERVICE_KEY);
        } catch (e) {
          console.error(e);
          throw new Error(
            "You need to provide the service key in environment variable AI_CORE_SERVICE_KEY",
          );
        }
      }
      if (!this.token) {
        const resp = await fetch(
          this.credentials.url + "/oauth/token?grant_type=client_credentials",
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(
                this.credentials.clientid + ":" + this.credentials.clientsecret,
              ).toString("base64")}`,
            },
          },
        ).then((x) => x.json());
        this.token = resp.access_token;
      }
      if (!this.deploymentUrl) this.deploymentUrl = {};
      if (!this.deploymentUrl[payload.deployment_id]) {
        const configurations = await fetch(
          this.credentials.serviceurls.AI_API_URL + "/v2/lm/configurations",
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              "AI-Resource-Group": "default",
            },
          },
        ).then((x) => x.json());

        const configName = "capGPT-" + payload.deployment_id;
        const config = configurations.resources.find(
          (r) => r.name === configName,
        );
        let configurationId;
        if (!config) {
          const postConfig = await fetch(
            this.credentials.serviceurls.AI_API_URL + "/v2/lm/configurations",
            {
              method: "POST",
              body: JSON.stringify({
                name: configName,
                executableId: "azure-openai",
                scenarioId: "foundation-models",
                parameterBindings: [
                  { key: "modelName", value: payload.deployment_id },
                ],
              }),
              headers: {
                Authorization: `Bearer ${this.token}`,
                "AI-Resource-Group": "default",
                "content-type": "application/json",
              },
            },
          ).then((x) => x.json());
          configurationId = postConfig.id;
        } else {
          configurationId = config.id;
        }

        const deployments = await fetch(
          this.credentials.serviceurls.AI_API_URL + "/v2/lm/deployments",
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              "AI-Resource-Group": "default",
            },
          },
        ).then((x) => x.json());

        const deployment = deployments.resources.find(
          (r) => r.configurationId === configurationId,
        );

        if (!deployment) {
          await fetch(
            this.credentials.serviceurls.AI_API_URL + "/v2/lm/deployments",
            {
              method: "POST",
              body: JSON.stringify({
                configurationId, // name possible?
              }),
              headers: {
                Authorization: `Bearer ${this.token}`,
                "AI-Resource-Group": "default",
                "content-type": "application/json",
              },
            },
          ).then((x) => x.json());
          console.error(
            "Deployment created, please run again in a few minutes.\nReason: The AI Core Service needs a deployment to query LLMs, the deployment was created but it takes a few minutes to complete.",
          );
          process.exit(1);
        }

        if (deployment.status !== "RUNNING") {
          console.error(
            "Deployment not ready, please run again in a few minutes",
          );
          process.exit(1);
        }
        this.deploymentUrl[payload.deployment_id] = deployment.deploymentUrl;
      }

      const res = await fetch(
        this.deploymentUrl[payload.deployment_id] +
          "/chat/completions?api-version=2023-05-15",
        {
          method: "POST",
          body: JSON.stringify({ messages: payload.messages }),
          headers: {
            Authorization: `Bearer ${this.token}`,
            "AI-Resource-Group": "default",
            "content-type": "application/json",
          },
        },
      ).then((x) => x.json());
      return res;
    }
  },
};

class LLM {
  constructor(options = {}) {
    this.options = Object.assign(
      { client: process.env.AI_CORE_SERVICE_KEY ? "http_ai_core" : "http" },
      options,
    );
    const client =
      typeof this.options.client === "string"
        ? CLIENTS[this.options.client]
        : this.options.client;
    if (!client)
      throw new Error(
        "Invalid LLM client, possible values: " +
          Object.keys(CLIENTS).join(","),
      );
    this.client = new client();
  }
  async send(payload) {
    try {
      return await this.client.send(payload);
    } catch (e) {
      const err = new Error(
        e.body?.data?.error || e.body?.error || e.message || e,
      );
      err.code = "LLM";
      throw err;
    }
  }
}

const llm = new LLM();

async function getChunks() {
  const input = await fetch("https://cap.cloud.sap/docs/llms-full.txt").then(
    (x) => x.text(),
  );
  const primaryHeadingRegex = /^(#) (.+)$/gm;
  const primaryIndices = [];
  let match;

  while ((match = primaryHeadingRegex.exec(input)) !== null) {
    primaryIndices.push({
      index: match.index,
      heading: match[2],
      level: match[1].length,
    });
  }

  const chunks = [];
  for (let i = 0; i < primaryIndices.length; i++) {
    const { heading } = primaryIndices[i];
    const start = primaryIndices[i].index;
    const end =
      i + 1 < primaryIndices.length
        ? primaryIndices[i + 1].index
        : input.length;
    const chunkText = input.slice(start, end).trim();

    if (chunkText) {
      // Extract code blocks from the entire chunk (including all subsections)
      const codeBlocks = [...chunkText.matchAll(/```[\s\S]*?```/g)].map(
        (m) => m[0],
      );
      chunks.push({
        id: i,
        heading,
        codeBlocks,
        content: chunkText,
        level: 1,
      });
    }
  }
  return chunks;
}
