# pi-autocontinue

`pi-autocontinue` is a small, bounded keepalive for Pi. It does not run a second supervisor model or store a semantic goal. After the agent reaches `agent_settled`, it asks the current agent to continue the latest real-user-authorized task while continuation budget remains.

## Commands

```text
/autocontinue 10       Arm 10 continuations for the next user prompt
/autocontinue now 10   Continue the current task immediately when Pi is idle
/autocontinue status    Show the current phase and budget
/autocontinue stop      Stop the active cycle
```

`/autocontinue` uses 10 attempts by default. The accepted range is 1 through 100. The `now` form requires an existing user task in the current session; an empty session is rejected. A new real user input cancels a running cycle. Messages sent by extensions do not cancel it.

The cycle stops when the agent calls the active `autocontinue_stop` tool with `done` or `blocked`, or when the attempt budget is exhausted. A transient error is not a stop reason; the agent can continue using the normal workflow. The extension never grants permission or expands the task scope.

## Prompt Override

The continuation body is loaded in this order:

1. `<project>/.pi/AUTOCONTINUE.md` for a trusted project
2. `~/.pi/agent/AUTOCONTINUE.md`
3. The built-in template

The project file replaces the global file; the contents are not merged. The fixed provenance header, attempt count, and budget remain controlled by the extension. Template files are limited to 32 KiB and are read as plain Markdown without executable interpolation.

Example `.pi/AUTOCONTINUE.md`:

```md
Resume the latest real-user-authorized task from its first incomplete step.
Use the available tools and make concrete progress; do not only describe a plan.
Do not repeat completed work or broaden the requested scope.
When complete, call `autocontinue_stop` with reason `done` as your last tool call.
When only real user input can unblock progress, call it with reason `blocked` and explain what is needed.
```

## Install For Testing

From this checkout:

```bash
pi --no-extensions -e ./src/index.ts
```

Or install it as a Pi package from a pinned Git ref after publishing the repository:

```bash
pi install git:github.com/<owner>/pi-autocontinue@<commit>
```

The extension targets Pi `0.83.x` because it relies on the `agent_settled` lifecycle event and custom-message delivery semantics.
