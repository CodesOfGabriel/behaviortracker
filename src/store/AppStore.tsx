import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppRoute, Experiment, PoseSample, VideoAsset } from "../types";
import { makeDemoExperiment, makeDemoPose } from "../lib/demo-data";

const STORAGE_KEY = "behavetracker.experiments.v1";

function migrateExperiment(experiment: Experiment): Experiment {
  return {
    ...experiment,
    schemaVersion: "1.0",
    analysisMethodVersion: experiment.analysisMethodVersion ?? "oft-0.2",
    corrections: (experiment.corrections ?? []).map((event) => ({
      ...event,
      source: "manual",
    })),
  };
}

function loadExperiments(): Experiment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Experiment[]).map(migrateExperiment) : [];
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
  updateExperiment: (id: string, update: Partial<Experiment> | ((current: Experiment) => Partial<Experiment>)) => void;
  deleteExperiment: (id: string) => void;
  openDemo: () => void;
  assets: Record<string, VideoAsset>;
  setAsset: (id: string, asset: VideoAsset) => void;
  trackingData: Record<string, PoseSample[]>;
  setTrackingData: (id: string, samples: PoseSample[]) => void;
  analysisActivity: Record<string, { starting: boolean; message: string; error: string | null }>;
  setAnalysisActivity: (id: string, update: Partial<{ starting: boolean; message: string; error: string | null }>) => void;
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<AppRoute>({ name: "dashboard" });
  const [experiments, setExperiments] = useState<Experiment[]>(loadExperiments);
  const [assets, setAssets] = useState<Record<string, VideoAsset>>({});
  const [trackingData, setTrackingDataState] = useState<Record<string, PoseSample[]>>({});
  const [analysisActivity, setAnalysisActivityState] = useState<AppStoreValue["analysisActivity"]>({});
  const setAnalysisActivity = useCallback((id: string, update: Partial<{ starting: boolean; message: string; error: string | null }>) =>
    setAnalysisActivityState(current => ({ ...current, [id]: { ...(current[id] ?? { starting: false, message: "", error: null }), ...update } })), []);
  const setTrackingData = useCallback((id: string, samples: PoseSample[]) =>
    setTrackingDataState(current => ({ ...current, [id]: samples })), []);

  const persist = useCallback((change: (current: Experiment[]) => Experiment[]) => {
    setExperiments(current => {
      const next=change(current);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const saveExperiment = useCallback(
    (experiment: Experiment, asset?: VideoAsset) => {
      persist(current => [experiment, ...current.filter((item) => item.id !== experiment.id)]);
      if (asset) setAssets((current) => ({ ...current, [experiment.id]: asset }));
    },
    [persist],
  );

  const updateExperiment = useCallback(
    (id: string, update: Partial<Experiment> | ((current: Experiment) => Partial<Experiment>)) => {
      persist(current => current.map((experiment) =>
          experiment.id === id
            ? { ...experiment, ...(typeof update === "function" ? update(experiment) : update), updatedAt: new Date().toISOString() }
            : experiment,
        ));
    },
    [persist],
  );

  const deleteExperiment = useCallback(
    (id: string) => {
      persist(current => current.filter((experiment) => experiment.id !== id));
      setAssets((current) => {
        if (current[id]?.objectUrl) URL.revokeObjectURL(current[id].objectUrl);
        const next = { ...current };
        delete next[id];
        return next;
      });
      setTrackingDataState((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setAnalysisActivityState((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [persist],
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
      setTrackingData,
      analysisActivity,
      setAnalysisActivity,
    }),
    [route, experiments, saveExperiment, updateExperiment, deleteExperiment, openDemo, assets, trackingData, setTrackingData, analysisActivity, setAnalysisActivity],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore precisa estar dentro de AppStoreProvider");
  return store;
}
