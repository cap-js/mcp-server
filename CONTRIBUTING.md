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

## Testing Package Installations

The CLI publishes `npm-shrinkwrap.json` so global and `npx` installations use the tested dependency tree, including native ONNX Runtime packages. Use `npm ci` (or `npm run setup`) for development. Update dependencies with `npm install` and commit the resulting shrinkwrap changes; dependency and security updates reach users through a new server release.

Run `npm run test:package` to pack the checkout and install it globally into a temporary prefix. The check verifies the published shrinkwrap, the ONNX Runtime versions resolved by both runtime consumers, real embedding inference, and the installed `search_docs` CLI against a local documentation fixture. It enables dependency installation scripts and downloads the default model from Hugging Face; all installed packages and model files are removed after the check.

CI and the release workflow run this check on Linux, Windows, and macOS with Node.js 22 and 24, using the bundled CPU runtime without optional CUDA downloads. Hosted Windows runners test Windows Server compatibility, not every desktop DLL configuration; a machine-specific failure still needs its actual DLL load trace.
