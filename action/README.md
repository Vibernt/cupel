# Cupel GitHub Action

The local M5 wrapper runs the **full** `cupel guard --base <exact commit>` using the Cupel CLI bundled beside this Action. It reads `cupel.json` and optional human approvals from that base commit with `git show`, writes them to private temporary files, and passes the trusted config to both base and head collection. A proposed head can change tests and source, but cannot replace the guard policy or approvals used by this invocation. It exits with Cupel's code: 0 pass, 1 guardrail failure, 2 invalid input, 3 environment error. A bounded, Markdown-escaped result goes to `GITHUB_STEP_SUMMARY` when available. It does not post a comment, upload data, install packages or call the network.

The caller must provide the full 40- or 64-character commit id as `base-commit`. A branch name, short SHA, missing commit, missing base `cupel.json` or missing requested approvals file is an error. The `approvals-path` input is optional and names a repository-relative JSON file **in the base commit**. Omitting it supplies no approvals. Approval entries are `{ "action": "remove" | "downgrade", "id": "<exact unit id>", "by": "<person>" }` per [the spec](../spec/SPEC.md). Do not put approval data only in a PR head.

Use an immutable trusted commit for the Action implementation, for example:

```yaml
steps:
  - name: Checkout proposed commit with its base available
    # Your trusted checkout step must leave the exact base commit in local Git history.
    uses: actions/checkout@<trusted-full-commit>
    with:
      fetch-depth: 0
  - name: Full Cupel guard
    uses: Vibernt/cupel/action@<trusted-full-commit>
    with:
      base-commit: ${{ github.event.pull_request.base.sha }}
      # approvals-path: .cupel/approvals.json
```

Run at the checked-out repository root with Node 22+ and the project's test dependencies already available. The Action itself makes no installation attempt. Its pinned source must be outside the proposed change's write scope; a local `uses: ./action` from an untrusted head does not establish that boundary. Protect the workflow and required check in repository settings before treating its result as enforcement. A private repository may require Action access configuration. Neither live GitHub execution nor branch protection has been verified here.

The wrapper runs the CLI's full base/head collection and mutation path; it does not switch to saved inputs or `--no-mutation` when an environment is missing. If the collector, runner or runtime fails, the job fails. The exact base and head should use the same runtime, as [G1](../spec/SPEC.md) requires. See [extension guidance](../docs/extending/) for custom collectors.
