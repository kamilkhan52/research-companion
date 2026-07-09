# Claude Code handoff: Figma Console MCP

This handoff is for setting up Claude Code to work on the Research Companion Figma redesign through `figma-console-mcp`.

Use this alongside:

- [Figma workflow for Research Companion](./figma-workflow.md)
- Anthropic Claude Code MCP docs: <https://docs.anthropic.com/en/docs/claude-code/mcp>
- Figma Console MCP repo: <https://github.com/southleft/figma-console-mcp>

## Goal

Claude Code should be able to:

1. Connect to the existing Research Companion Figma file.
2. Run `figma-console-mcp` from Claude Code.
3. Diagnose whether the Figma Desktop Bridge plugin is connected.
4. Use computer control for the required Figma Desktop plugin setup steps.
5. Keep Figma tokens local and out of Git.

## Project Figma target

- **File name:** `Research Companion — UI Redesign Proposal`
- **File key:** `O62BbV7CcCOf3O55HKAjtK`
- **Primary page:** `02 · Mobile Screens`
- **Design-system page:** `01 · Design System`

Expected current proposal structure:

- `01 · Library`
- `02 · Discover`
- `03 · Discussion`
- `04 · Reference Map`
- `05 · Working Notes`
- `06 · Related Works`
- `07 · External Reference`
- `08 · Chat Redesign Proposal`
- `09 · Additional App States`

## Local token handling

The Figma token should be local only.

This repo’s `.gitignore` already ignores `.env`. A local `.env` file should contain:

```sh
FIGMA_ACCESS_TOKEN=<figma-token>
ENABLE_MCP_APPS=true
```

Do not commit `.env`, `.claude.json`, shell history, screenshots containing the token, or any setup transcript that includes the raw token.

Before launching Claude Code or running MCP setup commands from this repo:

```sh
set -a
source .env
set +a
```

Confirm the variable exists without printing it:

```sh
test -n "$FIGMA_ACCESS_TOKEN" && echo "FIGMA_ACCESS_TOKEN is set"
```

## Recommended Claude Code MCP setup

Prefer a user-scoped MCP server because the token is a machine-local credential, not a project artifact.

From the repo root, after sourcing `.env`:

```sh
claude mcp add figma-console -s user \
  -e FIGMA_ACCESS_TOKEN="$FIGMA_ACCESS_TOKEN" \
  -e ENABLE_MCP_APPS=true \
  -- npx -y figma-console-mcp@latest
```

Then verify from Claude Code:

```sh
claude mcp list
```

Inside Claude Code, run:

```text
/mcp
```

Expected result: a `figma-console` server is listed and available.

## Figma Desktop Bridge plugin setup

The MCP server still needs the Figma Desktop Bridge plugin running in Figma Desktop. This is the main step where Claude may need computer control.

Prerequisites:

1. Figma Desktop is installed.
2. The Research Companion file is open in Figma Desktop.
3. Claude Code has access to computer-control tooling, or the user is available to click through the UI.

### Computer-use task checklist

Use computer control for these steps if the user asks Claude to perform the setup:

1. Open Figma Desktop.
2. Open the file `Research Companion — UI Redesign Proposal`.
3. If the Figma Desktop Bridge plugin is already installed:
   - Open Figma’s plugin menu.
   - Run the Figma Desktop Bridge plugin.
4. If the plugin is not installed:
   - Locate the manifest path created by `figma-console-mcp`.
   - In Figma Desktop, choose the development-plugin import flow.
   - Import the plugin manifest.
   - Run the imported Figma Desktop Bridge plugin.
5. Leave the plugin running while Claude Code works.

If the plugin asks for permissions, stop and ask the user to approve the Figma plugin action. Do not bypass the prompt.

## Connection verification

After the MCP server is configured and the Desktop Bridge plugin is running, ask Claude Code to call:

```text
figma_diagnose
```

Expected healthy state:

- Desktop Bridge plugin connected.
- Active file is `Research Companion — UI Redesign Proposal`.
- Current page is usually `02 · Mobile Screens`.
- REST token detected.

Then call:

```text
figma_search_components
```

This is required at the start of every Figma work session. The current file may return no local components; that is acceptable.

## Working rules for Claude

Use the rules from `docs/figma-workflow.md`. The important project-specific constraints are:

- Do not create duplicate pages.
- Do not rely on old node IDs.
- Keep all new screens inside named sections.
- Do not leave helper layers or failed-attempt artifacts.
- Use `Manrope` for UI/body/dense cards.
- Use `Newsreader` for editorial page-level headings only.
- Validate each visual change with `figma_capture_screenshot`.
- Run a final structural audit:
  - frame inventory
  - font families
  - visible text outside frame bounds

Expected font families for current proposal frames:

```text
Manrope
Newsreader
```

## If Claude Code cannot see the MCP tools

Check these in order:

1. Was `.env` sourced before launching Claude Code?
2. Does `claude mcp list` show `figma-console`?
3. Does `/mcp` show the server as connected?
4. Is Figma Desktop open to the correct file?
5. Is the Desktop Bridge plugin running?
6. Does `figma_diagnose` show the expected active file?

If the token appears expired or missing, update the local `.env` file and re-add or restart the MCP server. Do not paste the token into a committed file.

## If Figma actions fail

Common causes:

- The Desktop Bridge plugin is not running.
- Figma Desktop is open to the wrong file.
- Claude Code was launched before the token was available.
- A stale node ID was reused.
- A failed script left no changes because Figma execution is atomic.

Recovery:

1. Run `figma_diagnose`.
2. Rediscover page/frame IDs.
3. Re-run only the smallest safe patch.
4. Capture a screenshot of the affected frame.
5. Stop retrying if screenshot usage limits are hit; continue only with low-risk structural audits.

## Security checklist

- Never commit tokens.
- Never print the token in terminal output.
- Never include the token in docs.
- Prefer user-scoped Claude MCP config for token-backed servers.
- Keep `.env` local and ignored.
- If the token leaks, revoke it in Figma and replace the local `.env` value.

