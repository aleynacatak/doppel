"use client";

import type { Creation, DocumentRef, Run } from "@core/types";
import { type DependencyList, useCallback, useEffect, useState } from "react";
import { doppel, hasBridge } from "./doppel";
import { useApp } from "./store";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/** Loads data from window.doppel; reloads when deps change. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!hasBridge()) return;
    let alive = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/** A run, kept live through onRunProgress. */
export function useRun(runId: string | null) {
  const state = useAsync(() => (runId ? doppel().getRun(runId) : Promise.resolve(null)), [runId]);
  const { setData } = state;
  useEffect(() => {
    if (!runId || !hasBridge()) return;
    return doppel().onRunProgress((run: Run) => {
      if (run.id === runId) setData(run);
    });
  }, [runId, setData]);
  return state;
}

/** A routine creation (or repair), kept live through onCreationProgress. */
export function useCreation(id: string | null) {
  const state = useAsync(() => (id ? doppel().getCreation(id) : Promise.resolve(null)), [id]);
  const { setData } = state;
  useEffect(() => {
    if (!id || !hasBridge()) return;
    return doppel().onCreationProgress((c: Creation) => {
      if (c.id === id) setData(c);
    });
  }, [id, setData]);
  return state;
}

/** How often a shown document list is read again (documents open and close without the app's status changing). */
const DOCUMENTS_REFRESH_MS = 4000;

/** Re-runs `reload` every few seconds while `active`, and when the Doppl window gets focus again. */
export function useLiveReload(reload: () => void, active: boolean, everyMs = DOCUMENTS_REFRESH_MS) {
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(reload, everyMs);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload, active, everyMs]);
}

/** Open documents of an app; reloads when the app connects or disconnects, and every few seconds while shown. */
export function useOpenDocuments(appId: string | undefined) {
  const app = useApp(appId);
  const connected = app?.status === "connected";
  const state = useAsync<DocumentRef[]>(
    () => (appId && connected ? doppel().listOpenDocuments(appId) : Promise.resolve([])),
    [appId, connected, app?.detail],
  );
  useLiveReload(state.reload, connected);
  return { ...state, connected, app };
}
