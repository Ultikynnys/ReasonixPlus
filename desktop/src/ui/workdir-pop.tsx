import { useEffect, useMemo, useRef, useState } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { workspacePickerRows } from "../workspace-rows";
import { Shortcut } from "./shortcut";
import { WorkspaceRowView } from "./workspace-row";

type Anchor = { top?: number; bottom?: number; left: number };

export function WorkdirPop({
  open,
  onClose,
  recent,
  local,
  current,
  anchor,
  onPick,
  onRemove,
  onBrowse,
  locked = false,
}: {
  open: boolean;
  onClose: () => void;
  recent: string[];
  /** Local Reasonix+ workspace dir — pinned above the recents as an always-
   *  available workspace choice, and a workspace of its own: a directory that
   *  merely contains it is a different workspace. */
  local?: string;
  current?: string;
  anchor?: Anchor;
  onPick: (path: string) => void;
  onRemove?: (path: string) => void;
  onBrowse: () => void;
  /** A session is being created or deleted: both switching and forgetting would
   *  interleave with the settle it is waiting for, so the popover turns inert. */
  locked?: boolean;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
  }, [open]);

  const rows = useMemo(
    () => workspacePickerRows({ local, recent, current }),
    [local, recent, current],
  );
  // The local workspace is pinned above the list, so the search narrows only the
  // rows below it.
  const pinned = rows.find((row) => row.local);
  const offered = useMemo(() => {
    const rest = rows.filter((row) => !row.local);
    const needle = query.trim().toLowerCase();
    if (!needle) return rest;
    return rest.filter(
      (row) => row.path.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  if (!open) return null;

  const left = anchor?.left ?? 240;
  const positionStyle =
    anchor?.bottom !== undefined
      ? { bottom: anchor.bottom, left }
      : { top: anchor?.top ?? 56, left };

  return (
    <div className="wd-mask" onMouseDown={onClose}>
      <div className="wd-pop" style={positionStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wd-head">
          <I.folder size={12} />
          <span>{t("workdir.title")}</span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "Geist Mono, monospace",
              fontSize: "var(--fs-10)",
              color: "var(--muted)",
            }}
          >
            <Shortcut keys={["mod", "O"]} />
          </span>
        </div>
        <input
          ref={inputRef}
          className="wd-search"
          placeholder={t("workdir.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter" && offered[0]) {
              e.preventDefault();
              onPick(offered[0].path);
              onClose();
            }
          }}
        />
        <div className="wd-list">
          {pinned ? (
            <WorkspaceRowView
              row={pinned}
              locked={locked}
              onPick={() => {
                onPick(pinned.path);
                onClose();
              }}
            />
          ) : null}
          {offered.length === 0 && !pinned ? (
            <div
              style={{
                padding: "16px 12px",
                fontSize: "var(--fs-11-5)",
                color: "var(--muted)",
                fontFamily: "Geist Mono, monospace",
              }}
            >
              {t("workdir.empty")}
            </div>
          ) : null}
          {offered.map((row) => (
            <WorkspaceRowView
              key={row.key}
              row={row}
              locked={locked}
              onPick={() => {
                onPick(row.path);
                onClose();
              }}
              onRemove={onRemove ? () => onRemove(row.path) : undefined}
            />
          ))}
        </div>
        <div className="wd-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={locked}
            onClick={() => {
              onBrowse();
              onClose();
            }}
          >
            <I.plus size={11} /> {t("workdir.browse")}
          </button>
        </div>
      </div>
    </div>
  );
}
