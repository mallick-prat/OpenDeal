"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getNoteDetailAction } from "@/app/actions";
import { NoteTriage, type NoteDetail, type NoteSessionApi } from "./NoteTriage";
import type { SectionInfo } from "@/lib/types";

/**
 * ── Granola triage as a session ─────────────────────────────────────────
 * The open notes load once as a deck; every verdict (ignore, pass, add to
 * pipeline) drops the current note and shows the next from a cache that's
 * always a couple of notes ahead. No navigation, no reload: the URL follows
 * along with history.replaceState so /inbox/note/<id> stays deep-linkable,
 * and the server-rendered rail refreshes quietly behind the swap.
 */
export function NoteSession({
  initial,
  queue: initialQueue,
  sections,
  schoolNames,
}: {
  initial: NoteDetail;
  queue: string[];
  sections: SectionInfo[];
  schoolNames: string[];
}) {
  const router = useRouter();
  const [queue, setQueue] = useState<string[]>(() =>
    initialQueue.includes(initial.id) ? initialQueue : [initial.id, ...initialQueue]
  );
  const [currentId, setCurrentId] = useState(initial.id);
  const [cache, setCache] = useState<ReadonlyMap<string, NoteDetail>>(
    () => new Map([[initial.id, initial]])
  );
  const inflight = useRef<Set<string>>(new Set());
  const turnRef = useRef<HTMLDivElement>(null);

  const fetchNotes = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        if (cache.has(id) || inflight.current.has(id)) continue;
        inflight.current.add(id);
        void getNoteDetailAction(id)
          .then((r) => {
            if (r.ok && r.note) {
              const note = r.note;
              setCache((prev) => new Map(prev).set(id, note));
            }
          })
          .catch(() => {})
          .finally(() => inflight.current.delete(id));
      }
    },
    [cache]
  );

  // Stay two notes ahead and one behind, so a verdict never waits on a fetch.
  useEffect(() => {
    const idx = queue.indexOf(currentId);
    const targets = [currentId];
    for (const off of [1, 2, -1]) {
      const t = queue[idx + off];
      if (t) targets.push(t);
    }
    fetchNotes(targets);
  }, [currentId, queue, fetchNotes]);

  const playTurn = (dir: "next" | "prev") => {
    const el = turnRef.current;
    if (!el) return;
    el.classList.remove("page-turn-next", "page-turn-prev");
    void el.offsetWidth;
    el.classList.add(dir === "next" ? "page-turn-next" : "page-turn-prev");
  };

  const show = (id: string, dir: "next" | "prev") => {
    setCurrentId(id);
    window.history.replaceState(null, "", `/inbox/note/${id}`);
    playTurn(dir);
    window.scrollTo({ top: 0 });
  };

  const idx = queue.indexOf(currentId);
  const prevId = idx > 0 ? queue[idx - 1] : null;
  const nextId = idx >= 0 && idx < queue.length - 1 ? queue[idx + 1] : null;

  const api: NoteSessionApi = {
    prevId,
    nextId,
    position: idx >= 0 ? `${idx + 1} of ${queue.length}` : null,
    turn: (dir) => {
      const t = dir === "next" ? nextId : prevId;
      if (t) show(t, dir);
    },
    done: () => {
      const rest = queue.filter((q) => q !== currentId);
      setQueue(rest);
      if (rest.length === 0) {
        router.push("/inbox?source=granola&handled=1");
        return;
      }
      const next = (idx >= 0 && idx < rest.length ? rest[idx] : null) ?? rest[0];
      show(next, "next");
      // The rail is server-rendered: refresh it once the URL already points
      // at the next note (refreshing a handled note's URL would bounce).
      setTimeout(() => router.refresh(), 400);
    },
  };

  const note = cache.get(currentId);
  return (
    <div ref={turnRef}>
      {note ? (
        <NoteTriage
          key={note.id}
          note={note}
          sections={sections}
          schoolNames={schoolNames}
          session={api}
        />
      ) : (
        <p role="status" aria-live="polite" className="py-10 text-[14px] text-sub">
          Loading…
        </p>
      )}
    </div>
  );
}
