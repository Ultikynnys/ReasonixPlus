import { type ChangelogRelease, groupSections } from "@reasonix/core-utils";
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { I } from "../icons";
import { activationHandler } from "./keyboard";

export interface ChangelogState {
  releases: ChangelogRelease[];
  /** Running desktop version, marked in the list. */
  version: string;
  error: string | null;
  /** False until the first fetch resolves. */
  loaded: boolean;
}

/** How many release groups are expanded at once. Older ones collapse so the
 *  page opens on what actually shipped recently. */
const INITIAL_EXPANDED = 5;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function PageChangelog({
  changelog,
  onRefresh,
}: {
  changelog: ChangelogState;
  /** `true` bypasses the backend cache. */
  onRefresh: (force?: boolean) => void;
}) {
  // Explicit open/closed choices only. A release with no entry here falls back
  // to the newest-N default, so toggling one release never changes the others.
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [refreshing, setRefreshing] = useState(false);

  // Fetch on mount; the backend cache absorbs repeat visits to this page.
  useEffect(() => {
    if (!changelog.loaded) onRefresh();
  }, [changelog.loaded, onRefresh]);

  const installed = changelog.version.replace(/^v/, "");

  const toggle = useCallback((key: string, currentlyOpen: boolean) => {
    setOverrides((prev) => ({ ...prev, [key]: !currentlyOpen }));
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    onRefresh(true);
  }, [onRefresh]);

  // The first response after a refresh clears the spinner.
  useEffect(() => {
    setRefreshing(false);
  }, [changelog.releases]);

  const isOpen = (key: string, index: number): boolean =>
    overrides[key] ?? index < INITIAL_EXPANDED;

  if (!changelog.loaded) {
    return (
      <section className="section">
        <div className="changelog-status">{t("changelog.loading")}</div>
      </section>
    );
  }

  if (changelog.releases.length === 0) {
    return (
      <section className="section">
        <div className="changelog-status">
          <span>{changelog.error ? t("changelog.failed", { message: changelog.error }) : t("changelog.empty")}</span>
          <button
            type="button"
            className="changelog-retry"
            onClick={refresh}
            disabled={refreshing}
            onKeyDown={activationHandler(refresh)}
          >
            <I.rotate size={12} />
            <span>{refreshing ? t("changelog.refreshing") : t("changelog.retry")}</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="changelog-toolbar">
        <span className="grow" />
        {changelog.error ? <span className="changelog-stale">{t("changelog.stale")}</span> : null}
        <button
          type="button"
          className="changelog-retry"
          onClick={refresh}
          disabled={refreshing}
          onKeyDown={activationHandler(refresh)}
        >
          <I.rotate size={12} />
          <span>{refreshing ? t("changelog.refreshing") : t("changelog.refresh")}</span>
        </button>
      </div>

      {changelog.releases.map((release, index) => {
        const key = release.version ?? "unreleased";
        const open = isOpen(key, index);
        const date = formatDate(release.date);
        const isInstalled = release.version !== null && release.version.replace(/^v/, "") === installed;
        const sections = groupSections(release);
        return (
          <div key={key} className="changelog-release" data-open={open}>
            <div
              className="changelog-head"
              onClick={() => toggle(key, open)}
              onKeyDown={activationHandler(() => toggle(key, open))}
              role="button"
              tabIndex={0}
            >
              <span className="changelog-caret">{open ? <I.chevU size={12} /> : <I.chev size={12} />}</span>
              <span className="changelog-version">
                {release.unreleased ? t("changelog.unreleased") : `v${release.version}`}
              </span>
              {isInstalled ? <span className="changelog-badge">{t("changelog.installed")}</span> : null}
              <span className="grow" />
              {date ? <span className="changelog-date">{date}</span> : null}
              <span className="changelog-count">
                {t("changelog.entryCount", { count: release.entries.length })}
              </span>
            </div>
            {open ? (
              <div className="changelog-body">
                {sections.length === 0 ? (
                  <div className="changelog-empty">{t("changelog.noUserChanges")}</div>
                ) : (
                  sections.map((section) => (
                    <div key={section.kind} className="changelog-section">
                      <div className="changelog-section-title">
                        {t(`changelog.section.${section.kind}` as const)}
                      </div>
                      <ul className="changelog-list">
                        {section.entries.map((entry) => (
                          <li key={entry.hash} className="changelog-entry">
                            {entry.scope ? (
                              <span className="changelog-scope">{entry.scope}</span>
                            ) : null}
                            <span className="changelog-text">{entry.text}</span>
                            {entry.breaking ? (
                              <span className="changelog-breaking">{t("changelog.breaking")}</span>
                            ) : null}
                            <code className="changelog-hash">{entry.hash}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}