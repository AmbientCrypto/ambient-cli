import { useCallback, useRef, useState } from "react";
import { type HistoryNav, IDLE_NAV, navNewer, navOlder, searchHistory } from "./history.js";

/** Persistence for prompt history, supplied by the CLI edge (the App never touches the filesystem). */
export interface HistoryPort {
  load: () => string[];
  append: (text: string) => void;
}

export interface HistorySearch {
  query: string;
  /** The matching entry, if any. */
  match?: string;
  index?: number;
}

/**
 * Prompt recall for the composer: ↑/↓ walk previous prompts (the unsent draft is kept), Ctrl+R searches them.
 * Entries load once from the port; each sent prompt is appended to both the in-memory list and the port.
 */
export function usePromptHistory(port: HistoryPort | undefined) {
  const entriesRef = useRef<string[] | undefined>(undefined);
  const navRef = useRef<HistoryNav>(IDLE_NAV);
  const [search, setSearchState] = useState<HistorySearch | undefined>(undefined);
  const searchRef = useRef<HistorySearch | undefined>(undefined);
  const searchDraftRef = useRef("");

  const entries = useCallback((): string[] => {
    if (entriesRef.current === undefined) {
      try {
        entriesRef.current = port?.load() ?? [];
      } catch {
        entriesRef.current = [];
      }
    }
    return entriesRef.current;
  }, [port]);

  const setSearch = (next: HistorySearch | undefined) => {
    searchRef.current = next;
    setSearchState(next);
  };

  const record = useCallback(
    (text: string) => {
      navRef.current = IDLE_NAV;
      const trimmed = text.trim();
      if (!trimmed) return;
      const list = entries();
      if (list[list.length - 1] !== trimmed) entriesRef.current = [...list, trimmed];
      port?.append(trimmed);
    },
    [entries, port],
  );

  /** ↑ — the text to show, or undefined when there's nothing older. */
  const older = (current: string): string | undefined => {
    const r = navOlder(entries(), navRef.current, current);
    navRef.current = r.nav;
    return r.text;
  };
  /** ↓ — the text to show, or undefined when not browsing. */
  const newer = (): string | undefined => {
    const r = navNewer(entries(), navRef.current);
    navRef.current = r.nav;
    return r.text;
  };
  const browsing = () => navRef.current.index !== undefined;
  /** Typing into a recalled prompt makes it a new draft. */
  const stopBrowsing = () => {
    navRef.current = IDLE_NAV;
  };

  const find = (query: string, before?: number): HistorySearch => {
    const hit = query ? searchHistory(entries(), query, before) : undefined;
    return hit ? { query, match: hit.text, index: hit.index } : { query };
  };
  const startSearch = (current: string) => {
    searchDraftRef.current = current;
    setSearch({ query: "" });
  };
  const searchType = (text: string) => {
    const s = searchRef.current;
    if (s) setSearch(find(s.query + text));
  };
  const searchBackspace = () => {
    const s = searchRef.current;
    if (s) setSearch(find(s.query.slice(0, -1)));
  };
  /** Ctrl+R again: the next older match for the same query (stays put when there is none). */
  const searchOlder = () => {
    const s = searchRef.current;
    if (!s || s.index === undefined) return;
    const next = find(s.query, s.index);
    if (next.match !== undefined) setSearch(next);
  };
  /** Enter: put the match in the composer (the draft when nothing matched) and leave search. */
  const searchAccept = (): string => {
    const s = searchRef.current;
    setSearch(undefined);
    navRef.current = IDLE_NAV;
    return s?.match ?? searchDraftRef.current;
  };
  /** Esc: leave search and give back what was being typed before. */
  const searchCancel = (): string => {
    setSearch(undefined);
    return searchDraftRef.current;
  };

  return {
    record,
    older,
    newer,
    browsing,
    stopBrowsing,
    search,
    searching: () => searchRef.current !== undefined,
    startSearch,
    searchType,
    searchBackspace,
    searchOlder,
    searchAccept,
    searchCancel,
  };
}
