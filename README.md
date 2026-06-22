# pi-agent-extensions

Pi extensions maintained by `hisetu`.

## Install

```bash
pi install git:github.com/hisetu/pi-agent-extensions
```

Or reference this repo directly in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/hisetu/pi-agent-extensions"]
}
```

Or load directly for one run:

```bash
pi -e git:github.com/hisetu/pi-agent-extensions
```

## Included extensions

### `extensions/hostname-footer.ts`

A tiny extension that shows the local machine hostname in Pi's footer using `ctx.ui.setStatus()`.

Example footer text:

- `🖥 my-macbook-pro`

### `extensions/prompt-stash.ts`

An interactive prompt stash manager.

Features:

- adds `/prompt-stash`
- saves the current editor content with `Ctrl+S` inside the stash overlay
- previews saved prompts in an overlay UI
- supports loading into the editor, sending now, sending as steering/follow-up, editing, and deleting

### `extensions/loop.ts`

A follow-up loop extension that adds `/loop` and `signal_loop_success`.

Attribution:
- Adapted from **[`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff)**
- Upstream file: `extensions/loop.ts`
- Upstream license: **Apache-2.0**
- This repository packages and maintains the extension for reuse

Behavior added in this repo:

- Retries AI API errors at most **3 times**
- Shows a **sanitized user-facing error** in the UI
- Keeps the **full raw error** in the session log
- Stops the loop automatically after the retry limit is exceeded

Examples of sanitized errors:

- `413 failed to parse request`
- `input too long`
- `No API key for provider: github-copilot`
- `Connection error`
- `Request timed out`

## Development

After cloning locally, symlink or copy the extension into a Pi extensions directory, or install from the local path:

```bash
pi install /absolute/path/to/pi-agent-extensions
```
