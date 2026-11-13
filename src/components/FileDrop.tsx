"use client";

import { useRef, useState } from "react";
import { Document, TrashCan } from "@carbon/icons-react";

export const MAX_FILES = 10;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Drag-and-drop attachment picker shared by the create and edit forms. */
export function FileDrop({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) break;
      if (!next.some((x) => x.name === f.name && x.size === f.size))
        next.push(f);
    }
    onChange(next);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop files here or click to browse"
        className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 border border-dashed px-4 py-8 text-center transition-colors ${
          dragOver
            ? "border-primary bg-red-50"
            : "border-line-strong bg-bg-soft hover:border-primary"
        }`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) =>
          (e.key === "Enter" || e.key === " ") && inputRef.current?.click()
        }
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <Document size={24} className={dragOver ? "text-primary" : "text-sub"} />
        <span className="text-[14px] font-medium text-ink">
          {dragOver ? "Drop to attach" : "Drag files here"}
        </span>
        <span className="text-[12px] text-faint">or click to browse</span>
      </div>
      {files.length > 0 && (
        <div className="mt-2 flex flex-col">
          {files.map((f, i) => (
            <div
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-0"
            >
              <span className="truncate text-[13px] text-ink">{f.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-[12px] text-faint">
                  {prettySize(f.size)}
                </span>
                <button
                  className="p-1 text-sub hover:text-primary"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                >
                  <TrashCan size={16} />
                </button>
              </span>
            </div>
          ))}
          <span
            className={`mt-1 text-[12px] ${
              totalBytes > MAX_TOTAL_BYTES ? "text-primary" : "text-faint"
            }`}
          >
            {prettySize(totalBytes)} of 4 MB
          </span>
        </div>
      )}
    </div>
  );
}
