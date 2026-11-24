"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DG from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, FileUp, Paperclip, X } from "lucide-react";
import { ATTACHMENT_TYPES, attachmentError, attachmentMime } from "@/lib/attachments";
import { useStore } from "@/lib/store";
import { btnGhost, cx, iconBtn, sm } from "./ui";

const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;

export function AttachmentList({ ids = [], inlineWith }: { ids?: string[]; inlineWith?: ReactNode }) {
  const { attachments = [] } = useStore();
  const files = ids.map((id) => attachments.find((file) => file.id === id));
  const images = files.flatMap((file) => file?.mime.startsWith("image/") ? [file] : []);
  const [viewing, setViewing] = useState<number | null>(null);
  if (!ids.length) return <>{inlineWith}</>;

  const inline = inlineWith !== undefined;
  const firstImage = images[0];
  const additionalImages = images.length - 1;
  const links = ids.map((id, i) => {
    const file = files[i];
    if (!file) return <span key={id} className="text-xs text-fg-4">附件不可用</span>;
    const url = attachmentUrl(id);
    const imageIndex = images.findIndex((image) => image.id === id);
    const thumbnail = inline && imageIndex === 0;
    if (inline && imageIndex > 0) return null;
    // 图片在站内预览；按住 ⌘/Ctrl 点击仍可在新标签页打开
    const onClick = imageIndex < 0 ? undefined : (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); setViewing(imageIndex); };
    return (
      <a key={id} href={url} target="_blank" rel="noreferrer" onClick={onClick}
        className={cx("max-w-full overflow-hidden rounded-md border border-line bg-canvas text-xs hover:border-accent", thumbnail && "relative block h-8 w-[52px] shrink-0")}
        aria-label={thumbnail ? `查看截图${additionalImages ? `，共 ${images.length} 张` : ""}：${file.name}` : undefined}
        title={file.name}>
        {imageIndex >= 0 ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权图片不走公开优化缓存 */}
          <img src={url} alt={file.name} loading="lazy" className={thumbnail ? "block h-full w-full object-contain" : "h-24 max-w-48 object-contain"} />
          {thumbnail && additionalImages > 0 && <span aria-hidden="true" className="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-[10px] leading-4 text-white">+{additionalImages}</span>}
        </> : <span className="flex items-center gap-2 px-3 py-2"><Paperclip className="h-4 w-4 shrink-0" /><span className="max-w-44 truncate">{file.name}</span><span className="text-fg-4">{Math.max(1, Math.ceil(file.size / 1024))} KB</span></span>}
      </a>
    );
  });
  const viewer = <ImageViewer images={images} index={viewing} onIndex={setViewing} />;
  if (!inline) return <div className="mt-2 flex flex-wrap gap-2">{links}{viewer}</div>;

  const otherFiles = links.filter((link, i) => link && ids[i] !== firstImage?.id);
  return <>
    <div className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">{inlineWith}</div>
      {firstImage && links[ids.indexOf(firstImage.id)]}
    </div>
    {otherFiles.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{otherFiles}</div>}
    {viewer}
  </>;
}

function ImageViewer({ images, index, onIndex }: { images: { id: string; name: string }[]; index: number | null; onIndex: (i: number | null) => void }) {
  const file = index === null ? undefined : images[index];
  const [lastFile, setLastFile] = useState(file);
  if (file && file !== lastFile && file.id !== lastFile?.id) setLastFile(file);
  const preview = file ?? lastFile;
  const many = images.length > 1;
  const go = (d: number) => index !== null && onIndex((index + d + images.length) % images.length);
  const tool = "inline-flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white [&_svg]:h-4 [&_svg]:w-4";
  return (
    <DG.Root open={!!file} onOpenChange={(v) => { if (!v) onIndex(null); }}>
      <DG.Portal>
        <DG.Overlay className="fixed inset-0 z-50 arbor-overlay bg-black/80" />
        <DG.Content
          aria-describedby={undefined}
          onKeyDown={(e) => { if (!many) return; if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); }}
          className="fixed inset-0 z-50 flex flex-col outline-none arbor-image-viewer"
          onClick={(e) => { if (e.target === e.currentTarget) onIndex(null); }}
        >
          {preview && <>
            <div className="flex h-12 shrink-0 items-center gap-2 px-3 text-white">
              <DG.Title className="min-w-0 flex-1 truncate text-[13px]">{preview.name}{many && index !== null && <span className="ml-2 text-white/60">{index + 1} / {images.length}</span>}</DG.Title>
              <a href={attachmentUrl(preview.id)} download={preview.name} className={tool} aria-label="下载"><Download /></a>
              <DG.Close className={tool} aria-label="关闭预览"><X /></DG.Close>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4 md:px-14" onClick={(e) => { if (e.target === e.currentTarget) onIndex(null); }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 鉴权图片不走公开优化缓存 */}
              <img key={preview.id} src={attachmentUrl(preview.id)} alt={preview.name} className="max-h-full max-w-full rounded object-contain shadow-pop" />
              {many && <>
                <button type="button" onClick={() => go(-1)} className={cx(tool, "absolute left-2 top-1/2 -translate-y-1/2 bg-black/30")} aria-label="上一张"><ChevronLeft /></button>
                <button type="button" onClick={() => go(1)} className={cx(tool, "absolute right-2 top-1/2 -translate-y-1/2 bg-black/30")} aria-label="下一张"><ChevronRight /></button>
              </>}
            </div>
          </>}
        </DG.Content>
      </DG.Portal>
    </DG.Root>
  );
}

export function AttachmentComposer({ itemId, ids, onChange, onBusyChange, children }: { itemId: string; ids: string[]; onChange: (ids: string[]) => void; onBusyChange: (busy: boolean) => void; children: ReactNode }) {
  const { uploadAttachment, attachments = [] } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const selected = useRef(ids);
  useEffect(() => { selected.current = ids; }, [ids]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    // 附件存放在工作项下，没选工作项时先提示，避免拖入/粘贴没有任何反应
    if (!itemId) { setError("请先选择关联的工作项，再添加附件"); return; }
    if (busy.current) return;
    busy.current = true; setUploading(true); onBusyChange(true); setError("");
    try {
      for (const file of files) {
        if (selected.current.length >= 10) { setError("每条记录最多 10 个附件"); break; }
        const invalid = attachmentError({ name: file.name, mime: attachmentMime(file.name, file.type), size: file.size });
        if (invalid) { setError(`${file.name}：${invalid}`); continue; }
        const result = await uploadAttachment(itemId, file);
        if (!result.ok || !result.id) { setError(result.reason ?? "上传失败，请重新选择或拖入重试"); continue; }
        selected.current = [...selected.current, result.id];
        onChange(selected.current);
      }
    } finally { busy.current = false; setUploading(false); onBusyChange(false); }
  };
  return <div className={cx("min-w-0 rounded-lg", dragging && "ring-2 ring-accent")} onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void upload(Array.from(e.clipboardData.files)); } }} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); void upload(Array.from(e.dataTransfer.files)); } }}>
    {children}
    <div className="flex flex-wrap items-center gap-2 px-2 py-2"><button type="button" disabled={!itemId || uploading} onClick={() => input.current?.click()} className={cx(btnGhost, sm)}><FileUp />{uploading ? "正在上传…" : "添加附件"}</button><span className="text-[11px] text-fg-4">{itemId ? "可粘贴或拖入 · 每个 ≤10MB" : "先选择关联任务，再添加附件"}</span><input ref={input} type="file" multiple accept={Object.entries(ATTACHMENT_TYPES).flatMap(([mime, ext]) => [mime, ...ext.map((e) => `.${e}`)]).join(",")} hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></div>
    {ids.length > 0 && <div className="flex flex-wrap gap-1 px-2 pb-2">{ids.map((id) => <span key={id} className="flex max-w-full items-center gap-1 rounded bg-sunken pl-2 text-xs"><span className="max-w-48 truncate">{attachments.find((a) => a.id === id)?.name ?? "附件"}</span><button type="button" disabled={uploading} aria-label="移除待发布附件" className={iconBtn} onClick={() => onChange(ids.filter((i) => i !== id))}><X /></button></span>)}</div>}
    {error && <p role="alert" className="px-2 pb-2 text-xs text-danger">{error}</p>}
  </div>;
}
