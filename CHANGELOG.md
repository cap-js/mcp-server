# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).
The format is based on [Keep a Changelog](http://keepachangelog.com/).

## Version 0.0.7 - 2026-10-07

### Added

- Hybrid search for `search_docs`: semantic cosine similarity combined with BM25 keyword search (SQLite FTS5, with a pure-JS fallback when FTS5 is not compiled into `node:sqlite`) via weighted Reciprocal Rank Fusion
- Optional local cross-encoder reranking of `search_docs` results, opt-in via `RERANK_ENABLED`
- Fall back to the globally installed `cds-dk`'s `@sap/cds` runtime version when the project provides no local CDS

### Changed

- Skip the daily embeddings-bundle re-check when the local files are fresh (within one day), scoped to the detected runtime

### Fixed

- Fall back to local embeddings when the bundle download fails due to a network error
- Read the RFC 9457 `detail` field from non-OK bundle fetch responses for clearer error messages
- Anchor the ONNX model cache to the package root instead of the caller's working directory
- Exclude OData-contained entities from the exposed model by computing the contained set from the compiled model (the runtime `_containedEntities` getter is absent on compiled definitions)

## Version 0.0.6 - 2026-09-21

### Added

- Configurable embedding model per client via the `--model <name>` CLI flag and `CDS_MCP_MODEL` environment variable
- Capire-versioned embeddings with local manifest resolution
- Per-chunk metadata in `searchMarkdownDocs` output

### Changed

- Changed the default embedding model from `Xenova/all-MiniLM-L6-v2` to `sentence-transformers/all-MiniLM-L6-v2`
- Switched to CAP AI SQLite `VECTOR_EMBEDDING`
- Improved `search_docs` query param description
- Replaced background model polling and `CDS_MCP_REFRESH_MS` with request-driven model and configuration refresh

### Fixed

- Blank `Cache-Control`/`Pragma` so conditional GET can 304, avoiding a full re-download of the embeddings bundle on every startup
- Isolated project model caches and CAP compiler/global state across requests
- Preserved transitive model imports for explicitly trusted direct CLI projects
- Prevented rejected MCP model compilations from exposing out-of-root diagnostics
- Refreshed cached models after changes to CAP project configuration
- Restricted MCP model access to advertised workspace roots, including symlink and resolved-source validation

## Version 0.0.5 - 2026-04-27

### Added

- CLI argument management with `--offline` and `--download-embeddings`

## Version 0.0.4 - 2026-03-06

### Added

- Support for MCP Bundles (Claude Desktop), Claude Code CLI plugin, and Claude Code MCP config
- Support for [MCP Registry](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/)

## Version 0.0.3 - 2025-09-22

### Changed

- Slightly different rules to search docs when using `cds` CLI

## Version 0.0.2 - 2025-09-04

### Fixed

- Recompilation after compilation of an empty project

## Version 0.0.1 - 2025-09-03

### Added

- Initial release
