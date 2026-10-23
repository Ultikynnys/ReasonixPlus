/** A playwright-core page stand-in with the surface web_fetch drives: reads, a driven
 *  session's controls, and the measurements the state line reports. */
export interface PageStubOptions {
  html: string;
  title: string;
  url: string;
  status?: number;
  screenshotError?: Error;
  /** Scroll position after a press, so scrolling is measurable. */
  scrollStep?: number;
  docHeight?: number;
  viewportHeight?: number;
  /** Selector presence, by selector. */
  present?: Record<string, boolean>;
  clickError?: Error;
  /** Text the probed element reports. */
  sectionText?: string;
}

export interface PageStubCalls {
  gotos: string[];
  keys: string[];
  clicks: string[];
  screenshots: Array<{ fullPage?: boolean }>;
}

export function pageStub(options: PageStubOptions) {
  const calls: PageStubCalls = { gotos: [], keys: [], clicks: [], screenshots: [] };
  let scrollY = 0;
  const viewportHeight = options.viewportHeight ?? 1200;
  const docHeight = options.docHeight ?? 2400;
  return {
    calls,
    page: {
      goto: async (url: string) => {
        calls.gotos.push(url);
        return { status: () => options.status ?? 200 };
      },
      waitForSelector: async () => ({}),
      waitForLoadState: async () => undefined,
      addInitScript: async () => undefined,
      content: async () => options.html,
      title: async () => options.title,
      url: () => options.url,
      screenshot: async (opts?: { fullPage?: boolean }) => {
        calls.screenshots.push(opts ?? {});
        if (options.screenshotError) throw options.screenshotError;
        return Buffer.from("page-png");
      },
      evaluate: async (expression: string) => {
        if (expression.includes("innerText")) {
          const selector = /const name = "([^"]*)"/.exec(expression)?.[1] ?? "";
          const there = options.present?.[selector] ?? false;
          return there ? { selector, text: options.sectionText ?? "thread text" } : null;
        }
        if (expression.includes("scrollY")) {
          return {
            url: options.url,
            title: options.title,
            scrollY,
            docHeight,
            viewportHeight,
          };
        }
        const found: Record<string, boolean> = {};
        for (const [selector, there] of Object.entries(options.present ?? {}))
          found[selector] = there;
        return found;
      },
      waitForTimeout: async () => undefined,
      click: async (selector: string) => {
        calls.clicks.push(selector);
        if (options.clickError) throw options.clickError;
      },
      goBack: async () => undefined,
      keyboard: {
        press: async (key: string) => {
          calls.keys.push(key);
          scrollY += options.scrollStep ?? viewportHeight;
        },
      },
    },
  };
}
