import assert from "node:assert";
import { test } from "node:test";
import { searchMarkdownDocs } from "../lib/searchMarkdownDocs.js";

const markdown = [
  "# Section One",
  "Some intro text",
  "",
  "```js",
  "console.log('Hello world')",
  "```",
  "",
  "## Subsection",
  "More text",
  "",
  "```python",
  "def foo():",
  "    return 'bar'",
  "```",
  "",
  "# Section Two",
  "No code here",
].join("\n");

test("searchMarkdownDocs: returns full content by default", async () => {
  const results = await searchMarkdownDocs(markdown, "foo", 2);
  assert(results.includes("Subsection"), "Should include Subsection heading");
  assert(results.includes("def foo()"), "Should include Python code block");
  assert(results.includes("More text"), "Should include non-code text");
});

test("searchMarkdownDocs: returns only code blocks when onlyCodeBlocks=true", async () => {
  const results = await searchMarkdownDocs(markdown, "console", 2, true);
  assert(results.includes("Section One"), "Should include Section One heading");
  assert(results.includes("console.log"), "Should include JS code block");
  assert(
    !results.includes("Some intro text"),
    "Should not include non-code text",
  );
  assert(
    !results.includes("Section Two"),
    "Should not include Section Two (no code)",
  );
});
