/** The one declaration of Playwright's managed browser modes, shared by the daemon,
 *  the UI, the installer and the browser search engines. */

export const PLAYWRIGHT_MANAGED_BROWSERS = ["chromium", "firefox", "webkit", "msedge"] as const;

export type PlaywrightManagedBrowser = (typeof PLAYWRIGHT_MANAGED_BROWSERS)[number];

/** Managed builds a search engine may drive. WebKit is the only one Bing answers with a
 *  usable SERP: it hands the Chromium and Firefox builds pages for unrelated queries
 *  (measured 3/4 queries each), so those engines were removed instead of shipped as
 *  always-failing options. msedge is a vendor-installed channel, not a hermetic build. */
export const BROWSER_SEARCH_ENGINES = [
  "webkit",
] as const satisfies readonly PlaywrightManagedBrowser[];

export type SearchEngineBrowser = (typeof BROWSER_SEARCH_ENGINES)[number];
