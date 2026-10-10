import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, useLang } from "../i18n";

export function ZoomableImage({ src, alt = "", className, loading, onError }: {
  src: string; alt?: string; className?: string; loading?: "eager" | "lazy"; onError?: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="image-preview-trigger" aria-label={`${t("thread.viewImage")}${alt ? `: ${alt}` : ""}`} onClick={() => setOpen(true)}>
      <img className={className} src={src} alt={alt} loading={loading} onError={onError} />
    </button>
    {open ? <ImageViewer src={src} name={alt || t("thread.viewImage")} onClose={() => { setOpen(false); trigger.current?.focus(); }} /> : null}
  </>;
}

function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const fit = () => {
    const element = image.current;
    const container = viewport.current;
    if (!element?.naturalWidth || !container) return;
    const scale = Math.min(1, (container.clientWidth - 24) / element.naturalWidth, (container.clientHeight - 24) / element.naturalHeight);
    setSize({ width: Math.max(1, element.naturalWidth * scale), height: Math.max(1, element.naturalHeight * scale) });
  };
  useEffect(() => {
    dialog.current?.showModal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (viewport.current) observer?.observe(viewport.current);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
      dialog.current?.close();
    };
  }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return createPortal(<dialog ref={dialog} className="image-viewer" aria-label={name}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="preview-toolbar">
      <span className="image-viewer-name">{name}</span>
      <button type="button" disabled={zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}>{t("thread.zoomOut")}</button>
      <output>{Math.round(zoom * 100)}%</output>
      <button type="button" disabled={zoom >= 8} onClick={() => setZoom(Math.min(8, zoom + 0.25))}>{t("thread.zoomIn")}</button>
      <button type="button" onClick={() => { setZoom(1); fit(); viewport.current?.scrollTo?.(0, 0); }}>{t("thread.resetZoom")}</button>
      <button type="button" autoFocus onClick={close}>{t("thread.closePreview")}</button>
    </div>
    <div ref={viewport} className="image-viewer-viewport"
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        setZoom((value) => Math.max(0.25, Math.min(8, value + (event.deltaY < 0 ? 0.25 : -0.25))));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
        event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {failed ? <output role="alert">{t("thread.imagePreviewFailed")}</output> : <img ref={image} src={src} alt={name} draggable={false}
        onLoad={fit} onError={() => setFailed(true)}
        style={size.width ? { width: size.width * zoom, height: size.height * zoom } : { maxWidth: "100%", maxHeight: "100%" }} />}
    </div>
  </dialog>, document.body);
}
