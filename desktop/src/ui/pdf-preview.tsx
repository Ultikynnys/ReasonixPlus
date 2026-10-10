import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function PdfPreview({ src, name }: { src: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    setDocument(null);
    setPage(1);
    setZoom(1);
    setFailed(false);
    setLoading(true);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        task = pdfjs.getDocument({ url: src, useSystemFonts: true,
          cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
        const pdf = await task.promise;
        if (!disposed) setDocument(pdf);
      } catch {
        if (!disposed) { setFailed(true); setLoading(false); }
      }
    })();
    return () => { disposed = true; void task?.destroy(); };
  }, [src]);
  useEffect(() => {
    if (!document) return;
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (disposed || !canvas.current) return;
        const viewport = pdfPage.getViewport({ scale: zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const element = canvas.current;
        element.width = Math.ceil(viewport.width * ratio);
        element.height = Math.ceil(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        renderTask = pdfPage.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await renderTask.promise;
        if (!disposed) setLoading(false);
      } catch {
        if (!disposed) { setFailed(true); setLoading(false); }
      }
    })();
    return () => { disposed = true; renderTask?.cancel(); };
  }, [document, page, zoom]);
  return <section className="presented-file-document" aria-label={name}>
    <div className="preview-toolbar">
      <button type="button" disabled={!document || page <= 1} onClick={() => setPage(page - 1)}>{t("thread.previousPage")}</button>
      <output>{page} / {document?.numPages ?? "?"}</output>
      <button type="button" disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}>{t("thread.nextPage")}</button>
      <button type="button" disabled={zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}>{t("thread.zoomOut")}</button>
      <output>{Math.round(zoom * 100)}%</output>
      <button type="button" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}>{t("thread.zoomIn")}</button>
    </div>
    {loading ? <output className="presented-file-status">{t("thread.previewLoading")}</output> : null}
    {failed ? <output className="presented-file-status" role="alert">{t("thread.previewFailed")}</output> : null}
    <div className="pdf-page-scroll"><canvas ref={canvas} aria-label={`${name}, ${page}`} hidden={failed} /></div>
  </section>;
}
