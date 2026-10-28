# pi-autocontinue

`pi-autocontinue` is a bounded keepalive extension for [Pi](https://github.com/badlogic/pi-mono). It resumes the current user-authorized workflow after `agent_settled` without running a second supervisor model or storing a semantic goal.

It is designed for long-running conductor workflows that may stop unexpectedly after a model misunderstanding or transient provider failure. It does not create goals, expand scope, or grant user authorization.

## Fork compatibility

This is the `jijiamoer` fork of `limars874/pi-autocontinue`. It keeps the original Pi `0.83.x` support and additionally supports Pi `1.3.0`, verified by running the extension's existing suite plus a real-SDK integration check (`scripts/sdk-compat.mjs`) against the local Pi `1.3.0` packages. The tested `1.3.0` packages are not yet on the npm registry, so that check resolves them from the local Pi install rather than downloading them; the committed dev lockfile keeps the public `0.83.0` devDependencies so ordinary installs still work. No tool definitions, prompts, or model-facing text were changed. In Lody, the extension must additionally be selected in the Pi agent settings after it is installed.

## Requirements

- Pi `>=0.83.0 <1.0.0 || >=1.3.0 <1.4.0`
- Node.js `>=22.19.0`
- A trusted project when using project-local configuration

Pi packages execute with full local user permissions. Review the source before installing it.

## Upstream install (Pi 0.83)

Install the tested immutable revision globally:

```bash
pi install git:github.com/limars874/pi-autocontinue@13c1255b4dd820e0182367ece1c9e7190d63559d
```

Install it only for the current trusted project:

```bash
pi install -l git:github.com/limars874/pi-autocontinue@13c1255b4dd820e0182367ece1c9e7190d63559d
```

Try the same revision for one Pi process without modifying settings:

```bash
pi -e git:github.com/limars874/pi-autocontinue@13c1255b4dd820e0182367ece1c9e7190d63559d
```

Run `/reload` in an existing Pi session after installation. Newly started sessions load it automatically.

Pinned Git refs do not move during `pi update --extensions` or `pi update --all`. To move to another reviewed revision, install the same repository with the new full commit SHA:

```bash
pi install git:github.com/limars874/pi-autocontinue@<new-full-commit-sha>
```

Remove the package with:

```bash
pi remove git:github.com/limars874/pi-autocontinue
```

## Quick Start

Arm one successful continuation for the next real user task:

```text
/autocontinue 1
```

Then send the task normally. When the first agent run reaches `agent_settled`, the extension injects one procedural continuation. If the workflow is already complete, the agent calls `autocontinue_stop` with `reason: "done"` and the cycle ends.

Expected compact UI flow:

```text
[auto-continue] Auto-continue armed for the next user prompt (1 successful attempts).
[auto-continue] continuation attempt 1/1
autocontinue_stop
Auto-continue stopped (done): <summary>
```

The compact continuation line is only a renderer. The complete provenance and workflow-boundary prompt remains in model context and is visible when the entry is expanded.

## Commands

```text
/autocontinue 10       Arm 10 successful continuations for the next user prompt
/autocontinue now 10   Continue the current workflow immediately when Pi is idle
/autocontinue status    Show the current phase and both budgets
/autocontinue stop      Stop the active cycle
```

`/autocontinue` uses 10 successful continuation attempts by default. The accepted range is 1 through 100.

- `/autocontinue N` arms the next genuine user task.
- `/autocontinue now N` starts against the current task and requires an existing user message in the session.
- A new genuine user input cancels a running cycle.
- Extension-originated input does not cancel it.
- Starting another cycle while one is active is rejected.

Command results are durable UI-only entries. They remain visible in the transcript but are not added to model context.

## Agent Tools

### `autocontinue_start`

A conductor agent can start bounded continuation for the current task with an optional `maxAttempts` integer from 1 through 100. The default is 10.

The tool:

- requires an existing genuine user task
- accepts no model-supplied goal text
- cannot replace an active cycle
- does not create a goal, expand scope, or grant authorization

### `autocontinue_stop`

This tool is active only while a cycle is armed or running. The agent must call it as its final tool call when:

- `reason: "done"`: the current workflow is complete
- `reason: "blocked"`: progress requires genuine user input and no authorized path remains

The tool returns `terminate: true`, preventing another automatic model turn after the stop result.

## Status

When active, the footer reports the current phase:

```text
auto armed 0/10
auto running 1/10
auto retry 2/6 in 30s · cont 1/10
auto recovery 2/6 · cont 1/10
```

The footer tracks two budgets. `cont` counts successful continuations (the budget you arm), while the `N/6` counter tracks consecutive transport recoveries. Recovery states show both budgets together so the continuation budget never disappears from view.

`/autocontinue status` prints a durable transcript entry with the same state. The footer is removed when the cycle stops.

Every stop — `done`, `blocked`, budget exhaustion, recovery exhaustion, abort, external user input, or `/autocontinue stop` — also appends a durable UI-only `[auto-continue]` transcript entry with the stop summary, so an unattended stop stays visible after the notification toast disappears.

When a cycle stops because of a user interruption (`aborted` or a new user input), the extension additionally queues a model-visible note that is delivered with your next prompt (via `nextTurn`, never triggering a turn on its own). The note records that protection stopped and tells the agent to call `autocontinue_start` if you resume the workflow — so a long-running conductor that forgot the original "enable auto-continue" instruction still re-arms after an interruption. Explicit terminal stops (`done`, `blocked`, `/autocontinue stop`, exhausted budgets) do not queue notes.

## Continuation And Recovery Budgets

The normal budget counts successful auto-continuation runs. An attempt is reserved before injection and committed only after the corresponding assistant run succeeds.

Provider and transport failures use a separate six-attempt recovery budget, so a transient failure does not consume a normal continuation attempt. Pi's built-in retries and compaction recovery run before this extension sees the final settled result.

Recovery cooldowns are:

```text
15s, 30s, 1m, 2m, 5m, 10m
```

A valid `Retry-After` response header can extend a cooldown up to 10 minutes.

The following outcomes stop instead of retrying:

- definite quota, account-balance, billing, or subscription exhaustion
- definite credential or authentication blockers
- invalid requests
- context overflow
- aborted runs

Opaque provider errors remain retryable within the bounded recovery budget. Exhausting all six transport recoveries stops the cycle with `recovery_exhausted`.

## Durable State And Restart Recovery

The extension persists state as `autocontinue-state` custom entries. Each injected custom message carries the cycle ID and a unique injection ID in non-context metadata.

Before dispatch, the extension persists a pending injection. On settlement or restart, it reconciles that record against the custom message and subsequent assistant entry. This prevents duplicate settlement handling and recovers these crash windows:

- state persisted before dispatch
- custom message persisted without an assistant result
- assistant result persisted before settlement handling
- successful settlement persisted before the next injection
- transport cooldown interrupted by `/reload`, session replacement, or process restart

Runtime timers are cleared on `session_shutdown`. A persisted `retryAt` is rescheduled on the next `session_start`.

## Supplemental Instructions

The supplemental body is loaded in this order:

1. `<project>/.pi/AUTOCONTINUE.md` for a trusted project
2. `~/.pi/agent/AUTOCONTINUE.md`
3. the built-in supplemental body

The project file fully replaces the global file; they are not merged. Files are limited to 32 KiB and read as plain Markdown without executable interpolation.

A minimal file is:

```md
Use the available tools to make concrete progress.
Do not merely describe the next steps.
```

Templates replace only supplemental instructions. Code always retains:

- `[From auto-continue | procedural, not user authorization | ...]`
- the current valid user-authorized workflow boundary
- completed-milestone non-revival
- no inferred goals or scope expansion
- the `autocontinue_stop` done/blocked protocol

## Troubleshooting

### `/autocontinue` is unknown

Run `/reload` after installation. Confirm the package appears in `pi list`. Project-local packages require the project to be trusted.

### The footer is absent

The footer is intentionally absent while inactive. Run `/autocontinue status` to print the persisted state.

### A continuation prompt looks short

The default renderer shows one compact line. Expand the entry to inspect the full model-facing procedural prompt.

### Recovery does not retry

Quota, billing, credential, invalid-request, context-overflow, and abort outcomes intentionally stop. Use `/autocontinue status` and inspect the stop summary.

### A provider warning appears during `/reload`

Warnings naming another extension are not emitted by `pi-autocontinue`. Diagnose the named extension independently.

## Development

Load the checkout directly:

```bash
pi --no-extensions -e ./src/index.ts
```

Run the release checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The automated suite covers command and tool wiring, the fixed procedural envelope, deferred normal-attempt accounting, six-step transport recovery, Retry-After, durable restart reconciliation, duplicate settlement suppression, command visibility, compact rendering registration, and terminating stop behavior.

## License

MIT
