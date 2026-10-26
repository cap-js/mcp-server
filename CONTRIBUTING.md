# Contributing

## Code of Conduct

All members of the project community must abide by the [SAP Open Source Code of Conduct](https://github.com/SAP/.github/blob/main/CODE_OF_CONDUCT.md).
Only by respecting each other we can develop a productive, collaborative community.
Instances of abusive, harassing, or otherwise unacceptable behavior may be reported by contacting [a project maintainer](.reuse/dep5).

## Engaging in Our Project

We use GitHub to manage reviews of pull requests.

* If you are a new contributor, see: [Steps to Contribute](#steps-to-contribute)

* Before implementing your change, create an issue that describes the problem you would like to solve or the code that should be enhanced. Please note that you are willing to work on that issue.

* The team will review the issue and decide whether it should be implemented as a pull request. In that case, they will assign the issue to you. If the team decides against picking up the issue, the team will post a comment with an explanation.

## Steps to Contribute

Should you wish to work on an issue, please claim it first by commenting on the GitHub issue that you want to work on. This is to prevent duplicated efforts from other contributors on the same issue.

If you have questions about one of the issues, please comment on them, and one of the maintainers will clarify.

## Contributing Code or Documentation

You are welcome to contribute code in order to fix a bug or to implement a new feature that is logged as an issue.

The following rule governs code contributions:

* Contributions must be licensed under the [Apache 2.0 License](./LICENSE)
* Due to legal reasons, contributors will be asked to accept a Developer Certificate of Origin (DCO) when they create the first pull request to this project. This happens in an automated fashion during the submission process. SAP uses [the standard DCO text of the Linux Foundation](https://developercertificate.org/).

## Issues and Planning

* We use GitHub issues to track bugs and enhancement requests.

* Please provide as much context as possible when you open an issue. The information you provide must be comprehensive enough to reproduce that issue for the assignee.

## Proposed dependency release policy

This shrinkwrap adoption and maintenance policy is proposed for team review; it does not imply an agreed release commitment.

The published `npm-shrinkwrap.json` selects the dependency graph for each server release. Use `npm ci` (or `npm run setup`) for development; do not delete the shrinkwrap to refresh dependencies. Update it with targeted `npm update <package> --package-lock-only --ignore-scripts` commands, review the graph changes, and run the tests and a production dependency audit before release. Preserve optional dependencies for all supported platforms. Do not maintain a separate `package-lock.json`.

The proposed owner is the release maintainer, who reviews the existing weekly Dependabot updates and checks at least monthly whether a tested dependency-refresh release is needed. Security fixes require a new server release to reach shrinkwrapped installations; prioritize those releases according to the advisory's severity instead of relying on downstream dependency drift. Each release review should confirm there is an owner for outstanding security updates and that the dependency audit is current.

Before adoption, review the internal `docs-resources` consumer, which imports server modules as a library. A published shrinkwrap also controls that consumer's nested server dependencies and can reduce dependency sharing. Confirm compatibility, installation size, and how the consumer receives security fixes; if this conflicts with its library use, consider separating reusable modules from the CLI package.

Shrinkwrap selects npm package versions, not the Node.js version, operating-system DLLs, or embedding model downloads. Installation and native inference still need validation on the supported platforms.
