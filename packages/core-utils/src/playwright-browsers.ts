/** The one declaration of Playwright's managed browser modes, shared by the daemon,
 *  the UI, the installer and the browser search engines. */

export const PLAYWRIGHT_MANAGED_BROWSERS = ["chromium", "firefox", "webkit", "msedge"] as const;

export type PlaywrightManagedBrowser = (typeof PLAYWRIGHT_MANAGED_BROWSERS)[number];

/** Search drives only the hermetic downloads: msedge is a vendor-installed channel, not
 *  a build Playwright can point a fresh context at. */
export type SearchEngineBrowser = Exclude<PlaywrightManagedBrowser, "msedge">;

export const BROWSER_SEARCH_ENGINES: readonly SearchEngineBrowser[] =
  PLAYWRIGHT_MANAGED_BROWSERS.filter(
    (browser): browser is SearchEngineBrowser => browser !== "msedge",
  );
