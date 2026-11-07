# omp

T3 Code can use your existing [omp](https://omp.sh) (oh-my-pi) installation. It talks to omp
over ACP, so models, authentication, native sessions, permissions, and MCP tools stay owned by
omp.

## Set Up omp

1. Install omp on the machine running the T3 Code server. T3 Code supports omp 18.17.0 or newer.

   ```sh
   curl -fsSL https://omp.sh/install | sh
   ```

   Homebrew (`brew install can1357/tap/omp`), Bun
   (`bun install -g @oh-my-pi/pi-coding-agent`), and Nix installations also work.

2. Run `omp` in a terminal and use `/login`, or configure a provider API key in omp's settings.
3. Open T3 Code Settings, enable omp, and refresh the provider. Use **Sign in** to verify the
   existing omp credentials or open omp's terminal setup from the settings card.

If `omp` is not on the server's `PATH`, set omp's **Binary path** in its provider settings.
Launch arguments are passed to `omp acp`; T3 Code rejects arguments that select a session,
change the execution mode, or set the approval mode because T3 owns those parts of the process.

Use a **Profile** to isolate an instance's auth, sessions, settings, and caches. A profile named
`work` stores its state under `~/.omp/profiles/work/agent`, while the default profile uses
`~/.omp/agent`. Two T3 Code instances with different profiles do not share accounts or sessions.

On a remote or headless server, authenticate on that machine. The **Sign in** card can open
omp's terminal setup when the server exposes an interactive terminal; otherwise use `omp` in a
terminal on the server.

Update omp with `omp update`, or through the package manager that installed it. T3 Code shows
an update advisory but only runs an update when it can prove which installer owns the binary.

## What Carries Over

T3 Code reads omp's authenticated model catalog and exposes each model's own thinking levels.
The **default** model defers to omp's configured model and role selection.

Threads use omp's native sessions for resume and whole-session forks. T3 Code also offers recent
omp sessions for import during onboarding when the omp instance is enabled. omp runs through its
ACP server, so the composer gets omp's permissions, structured questions, MCP tools, image
prompts, compaction, active steering, and per-turn usage. The context meter follows omp's usage
reporting after the first reply; the usage chart includes omp sessions from the machine's omp
session directory.

The composer's `$` menu lists the skills `omp skill list <workspace> --json` resolves for the
open workspace. The Plan toggle switches the ACP session to omp's native plan mode; plan
approval still appears as a structured question in T3 Code.

T3 Code's own MCP server is offered to each session, so omp can call the `t3-code` tools and
delegate tasks. omp treats MCP tools as write-tier actions: Supervised mode asks before a tool
runs, Auto-accept edits and Full access do not.

Not every omp feature has a T3 Code surface:

- **Proposed plans** from omp's plan mode are not rendered as T3 Code's proposed-plan card. Use
  omp's approval question to accept or refine the plan.
- **Subagents** become T3 Code subagent entries with their prompt, status, and result, but omp
  does not expose the child session transcript over ACP, so the child pane stays empty.
- **Forks** copy the whole native session. T3 Code cannot fork from a selected earlier turn.
- **Rollback** restores workspace files and starts a fresh omp session; omp does not rewind the
  conversation.
- MCP and other non-shell tool approvals that omp raises through its own dialog appear as
  structured questions rather than T3 Code approval cards. Shell, edit, delete, and move calls
  use native approval cards.
- Steering is applied through omp's `_session/steering`; an accepted steer is marked delivered
  when the running turn next emits an update.

## Permission Modes

T3 Code applies the composer mode when it launches `omp acp`:

- **Supervised** starts omp in `always-ask`. Read-only tools run; shell, edit, delete, and move
  calls ask in T3 Code.
- **Auto-accept edits** starts omp in `write`. Reads and writes run; commands still ask.
- **Full access** starts omp in `yolo`.

Changing the mode restarts the omp session and applies the new approval mode. The policy covers
omp tool calls; it is not an operating-system sandbox.

## Troubleshooting

- If omp is unavailable, confirm the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, run `omp` and confirm its `/login` or API-key setup. `omp models --json`
  lists only models whose providers have configured credentials.
- If a profile's sessions or accounts are missing, confirm the profile name in omp's settings
  and that the same profile is used by the terminal and T3 Code.
- If a session cannot start, run `omp acp` from the workspace in a terminal to see omp's own
  stderr output, then check the provider's binary path and launch arguments.
