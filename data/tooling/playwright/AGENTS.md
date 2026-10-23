<!-- platform:begin — this section is auto-managed by Reasonix+ (overwritten on playwright-tooling-version bumps). Your additions go below the platform:end marker and survive upgrades. -->
<!-- playwright-tooling-version: 5 -->

# Playwright driver: persistent cross-browser control

**Read this file before first use in a session.** `driver.mjs` starts the configured
`mcpServers.playwright` entry over localhost HTTP and reuses that server across
invocations. It supports every connection mode preserved in the config:

- `--browser=chromium|firefox|webkit|msedge`: Playwright-managed persistent browser.
  `chromium` is Playwright's own pinned Chrome for Testing build, downloaded on demand;
  a `--browser=chrome*` flag is rewritten to it, so a managed mode never depends on an
  installed system Chrome. `msedge` is the Edge that ships with Windows.
- `--extension`: existing Chrome or Edge tabs through the official extension relay.
- `--cdp-endpoint=...`: another Chromium browser, such as Brave, Vivaldi, Opera, or
  Chromium, when that browser exposes a Chrome DevTools Protocol endpoint.

Firefox and WebKit do not support the extension relay. Never add `--extension` to
those modes or infer a browser from the user's system default.

## Usage

```sh
node ~/.reasonix/tools/playwright/driver.mjs list
node ~/.reasonix/tools/playwright/driver.mjs open <url>
node ~/.reasonix/tools/playwright/driver.mjs call <tool> '{"args":1}'
node ~/.reasonix/tools/playwright/driver.mjs seq steps.json
node ~/.reasonix/tools/playwright/driver.mjs stop
```

Run `list` first as a cheap connection check. Prefer one `seq` run over many calls.
The driver forwards the configured package version, browser/CDP flags, environment,
and unrelated user options. Stop the persistent server before changing connection
modes so the next invocation starts the newly configured browser.

## Mode-specific failures

- Extension timeout: the optional `PLAYWRIGHT_MCP_EXTENSION_TOKEN` may be wrong, or
  Chrome/Edge may not be running with the extension installed. Tokens are stored as
  bare values without the `KEY=` prefix.
- Managed launch failure: the selected Playwright browser may need its compatible
  browser build installed. Report the actual MCP error rather than switching modes.
- CDP failure: verify the Chromium browser was started with remote debugging and the
  configured HTTP/HTTPS/WS/WSS endpoint is reachable. Never silently fall back.

## Tool behavior

Prefer accessibility snapshots and `browser_find` for locating elements. Tool output
is formatted and can include result, event, and generated-code sections, so parse the
specific result section rather than assuming the final line is data. Treat
`browser_run_code_unsafe` as RCE-equivalent and use it only when necessary with a
trusted page and client.

The local HTTP server is intentionally localhost-only. State lives in `.server.json`
next to this file. Stale state self-heals on the next invocation. Use
`DRIVER_TIMEOUT_MS` and `DRIVER_PORT` only for explicit operational needs, not as
silent recovery mechanisms.

## Rendered pages and lazy content

`web_fetch` cannot run scripts, so a JS-rendered site returns page chrome only: YouTube,
social feeds, and most single-page apps need this browser. Prefer the site's own search
URL (`browser_navigate`), then read the snapshot or `browser_find`.

Sections below the fold mount only after scrolling: press `End` (or
`browser_mouse_wheel`) and re-read, repeating until the section appears. YouTube comments
measured at 5-20 threads in 6-12 s after one to three presses, about ten more per press;
roughly one attempt in three never mounts them, so retry once and then report that the
section did not load rather than that it is empty.
<!-- platform:end -->

## Agent notes (append below — the platform refreshes only the section above)

<!-- Agents: add durable findings here. Keep entries terse; newest at top. -->