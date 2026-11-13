"use client";

import { useCallback, useEffect, useState } from "react";
import { Add, Close, Checkmark } from "@carbon/icons-react";

/**
 * A founder's email addresses, managed INSIDE their row in the founders box.
 *
 * Founders routinely have two — a school address they signed up with, a
 * company one they moved to — and an invite might use either, so holding only
 * one quietly loses half the history. The calendar usually already saw the
 * second address under the same display name, so the row proposes it and a
 * tap accepts. Each address is labelled with its scope: only a company domain
 * expands to colleagues; school/personal match that person alone.
 *
 * useFounderEmails owns the data + actions; AddressPanel renders one
 * founder's compact strip (chips · add · suggestions) inside FounderFields.
 */

type Kind = "consumer" | "academic" | "corporate";

interface Address {
  email: string;
  kind: Kind;
  primary: boolean;
}
interface Suggestion {
  email: string;
  kind: Kind;
  seenAs: string;
}
export interface FounderEmailPerson {
  personId: string;
  name: string;
  addresses: Address[];
  suggestions: Suggestion[];
}

const SCOPE: Record<Kind, { label: string; hint: string }> = {
  corporate: { label: "company", hint: "Also matches others at this domain" },
  academic: { label: "school", hint: "Matches this person only" },
  consumer: { label: "personal", hint: "Matches this person only" },
};

export function useFounderEmails(gid: string) {
  const [people, setPeople] = useState<FounderEmailPerson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/deals/${encodeURIComponent(gid)}/founder-emails`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!cancelled) setPeople(res?.founders ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  const act = useCallback(
    async (action: string, personId: string, email: string) => {
      setBusy(`${personId}:${email}`);
      setError("");
      const res = await fetch(`/api/deals/${encodeURIComponent(gid)}/founder-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, personId, email }),
      })
        .then((r) => r.json())
        .catch(() => ({ ok: false, error: "Couldn't reach the server." }));
      setBusy(null);
      if (!res.ok) {
        setError(res.error ?? "That didn't save.");
        return false;
      }
      setPeople(res.founders);
      return true;
    },
    [gid]
  );

  const byName = useCallback(
    (name: string) =>
      people?.find(
        (p) => p.name.trim().toLowerCase() === name.trim().toLowerCase()
      ) ?? null,
    [people]
  );

  return { people, byName, act, busy, error };
}

/** One founder's address strip — lives inside their row in the founders box. */
export function AddressPanel({
  person,
  act,
  busy,
}: {
  person: FounderEmailPerson;
  act: (action: string, personId: string, email: string) => Promise<boolean>;
  busy: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () =>
    void act("add", person.personId, draft).then((ok) => {
      if (ok) {
        setAdding(false);
        setDraft("");
      }
    });

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {person.addresses.length === 0 && !adding && (
          <span className="text-[11px] text-faint">No address yet</span>
        )}
        {person.addresses.map((a) => (
          <span
            key={a.email}
            className={`group inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] ${
              a.primary ? "border-primary text-ink" : "border-line text-sub"
            }`}
            title={SCOPE[a.kind].hint}
          >
            {a.primary && <Checkmark size={12} className="text-primary" />}
            {a.email}
            <span className="text-faint">{SCOPE[a.kind].label}</span>
            {!a.primary && (
              <button
                className="text-faint opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                title="Make this the primary address"
                disabled={busy !== null}
                onClick={() => void act("primary", person.personId, a.email)}
              >
                ↑
              </button>
            )}
            <button
              className="text-faint opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
              title="Remove this address"
              disabled={busy !== null}
              onClick={() => void act("remove", person.personId, a.email)}
            >
              <Close size={12} />
            </button>
          </span>
        ))}

        {adding ? (
          <span className="inline-flex items-center gap-1">
            <input
              className="field !h-auto !py-0.5 !text-[11px]"
              autoFocus
              type="email"
              placeholder="name@company.com"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) submit();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <button
              className="text-[11px] font-medium text-primary disabled:opacity-50"
              disabled={!draft.trim() || busy !== null}
              onClick={submit}
            >
              Add
            </button>
          </span>
        ) : (
          <button
            className="inline-flex items-center gap-0.5 text-[11px] text-faint hover:text-primary"
            onClick={() => {
              setAdding(true);
              setDraft("");
            }}
          >
            <Add size={12} /> add
          </button>
        )}
      </div>

      {/* What the calendar has seen — evidence shown, one tap to accept. */}
      {person.suggestions.map((s) => (
        <div
          key={s.email}
          className="flex flex-wrap items-center gap-1.5 text-[11px] text-sub"
        >
          <span className="text-faint">Also seen as</span>
          <span className="font-medium text-ink">{s.email}</span>
          <span className="text-faint">
            ({SCOPE[s.kind].label}, as &ldquo;{s.seenAs}&rdquo;)
          </span>
          <button
            className="font-medium text-primary hover:text-primary-pressed disabled:opacity-50"
            disabled={busy === `${person.personId}:${s.email}`}
            onClick={() => void act("add", person.personId, s.email)}
          >
            Add
          </button>
          <span className="text-faint">·</span>
          <button
            className="text-faint hover:text-primary disabled:opacity-50"
            disabled={busy === `${person.personId}:${s.email}`}
            onClick={() => void act("dismiss", person.personId, s.email)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
