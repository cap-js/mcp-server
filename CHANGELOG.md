# Change Log

All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).
The format is based on [Keep a Changelog](http://keepachangelog.com/).

## Version 0.0.6 - tbd

### Added

- Capire-versioned embeddings with local manifest resolution
- Per-chunk metadata in `searchMarkdownDocs` output

### Changed

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

### Removed

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
