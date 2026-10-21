/** Pure HTML/JSON readers for the website probe: no browser, no network, so each one is
 *  testable against a fixture. The probe script only navigates and prints. */
import { parse as parseHtml } from "node-html-parser";

export const text = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/** A browser renders `text/plain` responses inside `<html><pre>`, so a JSON or raw file
 *  read through a page needs that wrapper taken off before it can be parsed. */
export function documentText(html: string): string {
  const pre = parseHtml(html).querySelector("pre");
  return pre ? pre.textContent : html;
}

/** Text a challenge page shows. Script bodies carry the same words on healthy pages,
 *  so only rendered text is searched. */
export function visibleText(html: string): string {
  const root = parseHtml(html);
  for (const noise of root.querySelectorAll("script, style, noscript")) {
    noise.parentNode?.removeChild(noise);
  }
  return text(root.querySelector("body")?.textContent ?? root.textContent);
}

const BLOCKED_MARKERS =
  /just a moment|checking your browser|enable javascript and cookies|cf-challenge|js_challenge_value|are you a robot|captcha|access denied|unusual traffic/i;

/** Whether a response is a refusal rather than content: an anti-bot status, a challenge
 *  page, or a wall that navigated away and left nothing readable. */
export function isBlocked(html: string, httpStatus: number | null): boolean {
  if (httpStatus === 403 || httpStatus === 429) return true;
  if (html === "") return (httpStatus ?? 0) >= 400;
  return BLOCKED_MARKERS.test(visibleText(html));
}

/** Role titles that count as 3D/modelling work. */
const MODELING =
  /(?:^|\W)(3d|3-d|modeler|modeller|modeling|modelling|artist|rigger|rigging|animator|animation|texturing|maya|blender|zbrush|substance|houdini|unreal|unity)(?:\W|$)/i;

/** Whether a title or tag says this is 3D/modelling work. */
export function isModeling(value: string): boolean {
  return MODELING.test(value);
}

/** The modelling subset of a listing, with a sample to print. */
export function modelingOf(titles: readonly string[]): { count: number; sample: string[] } {
  const matches = titles.filter((title) => MODELING.test(title));
  return { count: matches.length, sample: matches.slice(0, 8) };
}

export function titleOf(html: string): string {
  return text(parseHtml(html).querySelector("title")?.textContent);
}

export function headingOf(html: string): string {
  return text(parseHtml(html).querySelector("h1")?.textContent);
}

/** `owner/repo`, default branch and the file names at the repository root. */
export function readRepoRoot(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const files = new Set<string>();
  let branch = "";
  for (const link of root.querySelectorAll('a[href*="/blob/"]')) {
    const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^/]+)$/.exec(
      link.getAttribute("href") ?? "",
    );
    if (!match) continue;
    branch = match[3] ?? "";
    const name = match[4] ?? "";
    if (name) files.add(name);
  }
  return {
    title: titleOf(html),
    defaultBranch: branch || null,
    rootFiles: [...files].slice(0, 12),
    rootFileCount: files.size,
  };
}

/** A single file page: path, line count GitHub prints in the header, raw link. */
export function readBlobPage(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const lines = /(\d[\d,]*)\s+lines?\s*(?:\((\d[\d,]*)\s+loc\))?/.exec(
    text(root.querySelector("body")?.textContent).slice(0, 400_000),
  );
  return {
    title: titleOf(html),
    lineCount: lines?.[1] ? Number(lines[1].replace(/,/g, "")) : null,
    codeRows: root.querySelectorAll('[role="row"], .react-code-line-contents, .blob-code').length,
    hasRawLink: Boolean(root.querySelector('a[href*="raw.githubusercontent.com"]')),
  };
}

/** A folder listing page: its immediate children. GitHub links a row with the whole path
 *  (`/owner/repo/tree/main/packages/deps`), so the page's own path is stripped first. */
export function readTreePage(html: string, url: string): Record<string, unknown> {
  const root = parseHtml(html);
  const pathname = new URL(url).pathname;
  const branch = /^\/[^/]+\/[^/]+\/tree\/([^/]+)/.exec(pathname)?.[1] ?? "";
  const folder =
    /^\/[^/]+\/[^/]+\/tree\/[^/]+\/(.*)$/.exec(pathname)?.[1]?.replace(/\/+$/, "") ?? "";
  const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only rows inside this folder, one segment deep: its own breadcrumb drops out.
  const rows = new RegExp(
    `^/[^/]+/[^/]+/(tree|blob)/${escapeRe(branch)}/${escapeRe(folder)}/([^/?#]+)`,
  );
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const link of root.querySelectorAll('a[href*="/tree/"], a[href*="/blob/"]')) {
    const match = rows.exec((link.getAttribute("href") ?? "").replace(/[?#].*$/, ""));
    if (!match?.[2]) continue;
    (match[1] === "blob" ? files : folders).add(match[2]);
  }
  return {
    title: titleOf(html),
    branch: branch || null,
    folders: [...folders].slice(0, 12),
    folderCount: folders.size,
    files: [...files].slice(0, 12),
    fileCount: files.size,
  };
}

/** Blender's own openings. The card carries the role in `.cards-item-title`; the anchor's
 *  whole text also holds the excerpt, which is not a job title. */
export function readBlenderJobs(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const roles = new Set<string>();
  for (const link of root.querySelectorAll('a[href*="/jobs/"]')) {
    const slug = /\/jobs\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(link.getAttribute("href") ?? "")?.[1];
    if (!slug) continue;
    const card = text(
      link.querySelector(".cards-item-title")?.textContent ??
        link.querySelector("h2, h3")?.textContent,
    );
    roles.add(card || slug);
  }
  const titles = [...roles];
  const modeling = modelingOf(titles);
  return {
    title: titleOf(html),
    openings: titles.length,
    roles: titles.slice(0, 8),
    modeling: modeling.count,
  };
}

/** We Work Remotely lists each posting as a heading with a company link. */
export function readWeWorkRemotely(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const titles = [
    ...new Set(
      root
        .querySelectorAll("li h3, li h4, h3, h4")
        .map((node) => text(node.textContent))
        .filter((title) => title.length > 3),
    ),
  ];
  const modeling = modelingOf(titles);
  return {
    title: titleOf(html),
    listings: titles.length,
    modeling: modeling.count,
    modelingTitles: modeling.sample.slice(0, 6),
  };
}

/** ArtStation ids a posting as `/jobs/<id>`; `/jobs/c/<studio>` is the employer page. */
export function readArtStation(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const jobs = new Map<string, string>();
  for (const link of root.querySelectorAll('a[href*="/jobs/"]')) {
    const href = link.getAttribute("href") ?? "";
    const id = /\/jobs\/([A-Za-z0-9]{3,8})(?:[?#]|$)/.exec(href)?.[1];
    if (!id || ["all", "studios", "resources"].includes(id.toLowerCase())) continue;
    const title = text(link.textContent);
    if (title.length > 3 && !jobs.has(id)) jobs.set(id, title);
  }
  const titles = [...jobs.values()];
  const modeling = modelingOf(titles);
  return {
    title: titleOf(html),
    postings: titles.length,
    sample: titles.slice(0, 6),
    modeling: modeling.count,
  };
}

/** RemoteOK serves its board as one JSON array; the first element is its legal notice. */
export function readRemoteOk(html: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(documentText(html));
  } catch {
    return { parseError: "not JSON", head: documentText(html).slice(0, 120) };
  }
  if (!Array.isArray(payload)) return { parseError: "not an array" };
  const jobs = payload
    .filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === "object")
    .filter((job) => job.position || job.tags)
    .map((job) => ({
      position: String(job.position ?? ""),
      company: String(job.company ?? ""),
      tags: Array.isArray(job.tags) ? (job.tags as string[]) : [],
    }));
  const modeling = jobs.filter((job) => isModeling(`${job.position} ${job.tags.join(" ")}`));
  return {
    postings: jobs.length,
    modeling: modeling.length,
    modelingTitles: modeling.slice(0, 6).map((job) => `${job.position} @ ${job.company}`),
  };
}

/** 80.lv posts game-art roles inline, one heading per opening. */
export function read80Level(html: string): Record<string, unknown> {
  const root = parseHtml(html);
  const titles = [
    ...new Set(
      root
        .querySelectorAll("h2, h3, a")
        .map((node) => text(node.textContent))
        .filter((title) => title.length > 3),
    ),
  ];
  const modeling = modelingOf(titles);
  return {
    title: titleOf(html),
    modeling: modeling.count,
    modelingTitles: modeling.sample.slice(0, 8),
  };
}
