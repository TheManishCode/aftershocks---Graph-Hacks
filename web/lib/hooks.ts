"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError } from "./api";

/** The repo in view, from the `/r/[repo]` route. */
export function useRepo(): string {
  const p = useParams<{ repo?: string }>();
  return p.repo ? decodeURIComponent(p.repo) : "";
}

export interface Query<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(String(e), 0));

/** Minimal fetch hook: refetches when `key` changes, optional polling, keeps old data while reloading. */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, refreshMs?: number): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(key !== null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => live && (setData(d), setError(undefined)))
      .catch((e) => live && setError(asApiError(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [key, tick]);

  useEffect(() => {
    if (!refreshMs || key === null) return;
    const t = setInterval(() => setTick((x) => x + 1), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, key]);

  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

/** A user-triggered request (run an analysis): latest call wins, earlier in-flight results are dropped. */
export function useAction<A extends unknown[], T>(fn: (...a: A) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...a: A) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const d = await fnRef.current(...a);
      if (mine === seq.current) setData(d);
      return d;
    } catch (e) {
      if (mine === seq.current) setError(asApiError(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  const reset = useCallback(() => {
    seq.current++;
    setData(undefined);
    setError(undefined);
    setLoading(false);
  }, []);
  return { data, error, loading, run, reset };
}

/** Value that only changes after `ms` of quiet: search-as-you-type without a request per keystroke. */
export function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A CSS media query's live result; false on the server and before hydration. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The shortcut modifier label for this OS: ⌘ on Apple devices, Ctrl elsewhere (Ctrl until hydrated). */
export function useModKey(): string {
  return useSyncExternalStore(
    () => () => {},
    () => (isApple() ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}
