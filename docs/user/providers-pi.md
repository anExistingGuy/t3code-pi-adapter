# Pi

T3 Code can run the Pi coding agent as a provider. Install and configure Pi on the machine running
the T3 Code server, then add or enable **Pi** in Settings. A phone or remote browser does not need
Pi installed: provider processes and files always belong to the server environment.

## Models and resources

The model catalog comes from Pi. T3 groups models by their friendly Pi provider name and keeps the
encoded routing identity internal. Configure custom providers and models through Pi, including
`models.json` and extensions, then refresh the provider in T3 Code. T3 does not maintain a separate
Pi custom-model list.

Pi continues to load its normal resources:

- custom providers and models;
- packages and extensions;
- prompt templates and slash commands;
- user and project skills;
- context files and project resources.

T3 shows discovered commands and skills in the composer. Selecting a slash command sends its exact
`/name` invocation to Pi. Extension dialogs, questions, and permission requests appear in the
conversation using T3's normal controls. Terminal-only widgets and custom TUI rendering are not
reproduced because T3 supplies the interface.

## Profiles and multiple instances

Each Pi provider instance can set a binary path, Pi agent directory, launch arguments, and
environment variables. This allows separate Pi installations or profiles on one server. Paths refer
to the server filesystem, including when you connect through relay, tunnel, web, desktop, or mobile.

The Pi agent directory is the profile and resource root normally selected with
`PI_CODING_AGENT_DIR`. Leaving it blank keeps the environment inherited by the server.

## Sessions and recovery

T3 asks Pi to persist and resume its own sessions. T3 never edits Pi session files directly. A T3
rollback restores the workspace checkpoint and uses Pi's native conversation branching so later
conversation entries are removed without rewriting the session file.

Pi's retry and automatic compaction activity is shown in the thread when relevant. If the server or
provider process stops, T3 resumes from the persisted Pi session cursor when possible.

## Trust and permissions

Pi extensions run as trusted code in the server environment. T3 can gate tool calls according to
the thread's permission mode, but this is an approval boundary rather than an operating-system
sandbox. Review extensions and packages before installing them. See [Permission modes](./permission-modes.md).
