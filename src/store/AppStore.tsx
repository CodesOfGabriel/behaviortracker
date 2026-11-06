import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppRoute, Experiment, PoseSample, VideoAsset } from "../types";
import { makeDemoExperiment, makeDemoPose } from "../lib/demo-data";

const STORAGE_KEY = "behavetracker.experiments.v1";

function loadExperiments(): Experiment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Experiment[]) : [];
  } catch {
    return [];
  }
}

interface AppStoreValue {
  route: AppRoute;
  navigate: (route: AppRoute) => void;
  experiments: Experiment[];
  getExperiment: (id: string) => Experiment | undefined;
  saveExperiment: (experiment: Experiment, asset?: VideoAsset) => void;
  updateExperiment: (id: string, update: Partial<Experiment>) => void;
  deleteExperiment: (id: string) => void;
  openDemo: () => void;
  assets: Record<string, VideoAsset>;
  setAsset: (id: string, asset: VideoAsset) => void;
  trackingData: Record<string, PoseSample[]>;
  setTrackingData: (id: string, samples: PoseSample[]) => void;
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<AppRoute>({ name: "dashboard" });
  const [experiments, setExperiments] = useState<Experiment[]>(loadExperiments);
  const [assets, setAssets] = useState<Record<string, VideoAsset>>({});
  const [trackingData, setTrackingDataState] = useState<Record<string, PoseSample[]>>({});

  const persist = useCallback((next: Experiment[]) => {
    setExperiments(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const saveExperiment = useCallback(
    (experiment: Experiment, asset?: VideoAsset) => {
      persist([experiment, ...experiments.filter((item) => item.id !== experiment.id)]);
      if (asset) setAssets((current) => ({ ...current, [experiment.id]: asset }));
    },
    [experiments, persist],
  );

  const updateExperiment = useCallback(
    (id: string, update: Partial<Experiment>) => {
      persist(
        experiments.map((experiment) =>
          experiment.id === id
            ? { ...experiment, ...update, updatedAt: new Date().toISOString() }
            : experiment,
        ),
      );
    },
    [experiments, persist],
  );

  const deleteExperiment = useCallback(
    (id: string) => {
      persist(experiments.filter((experiment) => experiment.id !== id));
      setAssets((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [experiments, persist],
  );

  const openDemo = useCallback(() => {
    const demo = makeDemoExperiment();
    saveExperiment(demo);
    setTrackingDataState((current) => ({ ...current, [demo.id]: makeDemoPose(demo) }));
    setRoute({ name: "editor", experimentId: demo.id });
  }, [saveExperiment]);

  const value = useMemo<AppStoreValue>(
    () => ({
      route,
      navigate: setRoute,
      experiments,
      getExperiment: (id) => experiments.find((experiment) => experiment.id === id),
      saveExperiment,
      updateExperiment,
      deleteExperiment,
      openDemo,
      assets,
      setAsset: (id, asset) => setAssets((current) => ({ ...current, [id]: asset })),
      trackingData,
      setTrackingData: (id, samples) =>
        setTrackingDataState((current) => ({ ...current, [id]: samples })),
    }),
    [route, experiments, saveExperiment, updateExperiment, deleteExperiment, openDemo, assets, trackingData],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore precisa estar dentro de AppStoreProvider");
  return store;
}

