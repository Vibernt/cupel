# Install Cupel locally

Cupel **0.1.2** source is [MIT-licensed](../LICENSE) at
[Vibernt/cupel](https://github.com/Vibernt/cupel). Public GitHub source publication
was authorized by the owner on **2026-10-26**; npm and PyPI remain unpublished. The
[support matrix](support.md) defines JS/TS/Python core ordinary full guard,
bounded Go/Ruby/Rust preview and experimental selective PR commands
outside the supported first release. Installing a package does not expand that
contract.

## Prerequisites

- Node **22+** for the CLI/MCP and Git for comparisons against commits.
- The target project's runner and dependencies, prepared by you. Cupel does not download them.
- For Python: Python **3.12+**, pytest, and the separate `vibernt-cupel` collector in the environment used by `python3`.

See each [runner guide](README.md#runners) for exact tested versions, source and
transform restrictions. Collection executes project tests and configured commands;
Cupel's offline runtime does not constrain their side effects.

## Source CLI

From this checkout's root:

```sh
CUPEL_REPO="$PWD"
node "$CUPEL_REPO/packages/cupel/bin/cupel.mjs" --help
```

There is no JavaScript build step or product dependency installation. From a
target project, use that absolute source entry point for `report`, `guard`, or
`mcp`. For source Python development, expose the collector to the same shell:

```sh
export PYTHONPATH="$CUPEL_REPO/packages/cupel-py/src${PYTHONPATH:+:$PYTHONPATH}"
python3 -m vibernt_cupel --help
```

## Offline npm tarball

From this checkout's root, pack and install the current source into a separate
local prefix:

```sh
CUPEL_REPO="$PWD"
mkdir -p .scratch/local-package
npm pack --offline --ignore-scripts ./packages/cupel \
  --pack-destination .scratch/local-package
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix .scratch/local-install \
  .scratch/local-package/vibernt-cupel-0.1.2.tgz
CUPEL="$CUPEL_REPO/.scratch/local-install/node_modules/.bin/cupel"
"$CUPEL" --version
"$CUPEL" --help
```

This is a local file installation, not a registry install. The archive includes
the CLI, engine, schemas, Go mutation helper, checked-in Ruby runtime and copies
of the root MIT `LICENSE` and `NOTICE`. Parity tests check the legal files and
bundled Ruby paths/bytes against their canonical repository copies.

## Offline Python wheel

Use an existing project environment with Python 3.12+, pytest, pip and the pinned
build backend **setuptools 80.9.0** already prepared. Check the backend first;
if it is absent or differs, stop and prepare the required tools explicitly.
Cupel does not download or substitute build tools.

From the Cupel checkout, with `CUPEL_REPO` set as above:

```sh
python3 -c 'import sys; from importlib.metadata import version; assert sys.version_info >= (3, 12); assert version("setuptools") == "80.9.0"; import pytest'
mkdir -p .scratch/local-package
python3 -m pip --isolated --disable-pip-version-check wheel --no-index \
  --no-build-isolation --no-deps --wheel-dir .scratch/local-package \
  "$CUPEL_REPO/packages/cupel-py"
python3 -m pip --isolated --disable-pip-version-check install --no-index --no-deps \
  "$CUPEL_REPO/.scratch/local-package/vibernt_cupel-0.1.0-py3-none-any.whl"
python3 -m vibernt_cupel --help
```

Use that environment's `bin` first on `PATH` when invoking the npm CLI or MCP;
Cupel launches `python3`. The wheel declares Python 3.12+, carries
`Private :: Do Not Upload`, and includes the root `LICENSE` and `NOTICE`.
Current installed acceptance used Python **3.14.8** / pytest **9.1.1**; other exact
combinations are unverified.

## Verify an installed artifact

The [development guide](development.md#installed-artifact-gates) lists required
fixture preparation and gate flags. `node --test scripts/package-smoke.test.mjs`
packs the actual npm archive, installs offline and exercises CLI/MCP. It also
checks runner fixtures and the Python wheel when their explicit tools are ready.
Missing integrations are blocked/skipped, not evidence of acceptance; the required
gate flags make the relevant missing tools fail.

Each smoke invocation preserves its artifacts and results in a fresh
`.scratch/package-smoke/run-*/`. Manual `.scratch/local-package` builds are
separate. Accepted handoffs under `.scratch/private-candidate/` record exact
hashes, tool versions and provenance; see [installed usage](private-use.md).
