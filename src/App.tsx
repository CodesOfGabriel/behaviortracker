import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./features/auth/LoginPage";
import { About } from "./features/about/About";
import { ColabGate } from "./features/colab/ColabGate";
import {
  COLAB_PROFILE_ID,
  COLAB_STATUS_EVENT,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  publishColabSummary,
  type OAuthProfileSummary,
} from "./features/colab/connection";
import { Dashboard } from "./features/dashboard/Dashboard";
import { NewExperiment } from "./features/experiments/NewExperiment";
import { RadialArmMazeExperimentWizard } from "./features/experiments/RadialArmMazeExperimentWizard";
import { Results } from "./features/results/Results";
import { ForcedSwimResults } from "./features/results/ForcedSwimResults";
import { RadialMazeResults } from "./features/radial-maze/RadialMazeResults";
import { TrackingEditor } from "./features/tracking/TrackingEditor";
import { useAppStore } from "./store/AppStore";

export default function App({ onInitialSessionResolved }: { onInitialSessionResolved?: (authenticated: boolean) => void }) {
  const { route, getExperiment, navigate, analysisActivity } = useAppStore();
  const [session, setSession] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [localAccess, setLocalAccess] = useState(false);
  const [draftVisited, setDraftVisited] = useState(false);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const initialSessionReported = useRef(false);

  useLayoutEffect(() => {
    if (checkingSession || initialSessionReported.current) return;
    initialSessionReported.current = true;
    onInitialSessionResolved?.(session.connected);
  }, [checkingSession, onInitialSessionResolved, session.connected]);

  useEffect(() => {
    if (route.name === "new-experiment") setDraftVisited(true);
  }, [route.name]);

  const refreshSession = useCallback(async () => {
    if (!isTauriRuntime()) {
      setCheckingSession(false);
      return;
    }
    try {
      const current = await loadColabSummary();
      setSession(current);
      setSessionError(null);
      publishColabSummary(current);
    } catch (error) {
      setSessionError(typeof error === "string" ? error : error instanceof Error ? error.message : "Não foi possível verificar a sessão Google.");
    } finally {
      setCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    let revision = 0;
    let disposed = false;
    const onStatus = (event: Event) => {
      revision += 1;
      const current = (event as CustomEvent<OAuthProfileSummary>).detail;
      setSession(current);
      setCheckingSession(false);
    };
    const onFocus = () => {
      if (!isTauriRuntime()) return;
      const requestRevision = ++revision;
      void loadColabSummary().then((current) => {
        if (!disposed && revision === requestRevision) publishColabSummary(current);
      }).catch(() => undefined);
    };
    window.addEventListener(COLAB_STATUS_EVENT, onStatus);
    window.addEventListener("focus", onFocus);
    const unlisten = isTauriRuntime()
      ? listen<OAuthProfileSummary>("google-oauth-status", ({ payload }) => {
        if (!disposed) publishColabSummary(payload);
      }).catch(() => undefined)
      : Promise.resolve(undefined);
    void refreshSession();
    return () => {
      disposed = true;
      window.removeEventListener(COLAB_STATUS_EVENT, onStatus);
      window.removeEventListener("focus", onFocus);
      void unlisten.then((stop) => stop?.());
    };
  }, [refreshSession]);

  function updateSession(current: OAuthProfileSummary) {
    setSession(current);
    setSessionError(null);
    publishColabSummary(current);
  }

  async function logout() {
    navigate({ name: "dashboard" });
    if (session.connected) {
      const disconnected = await invoke<OAuthProfileSummary>("disconnect_google_account", { profileId: COLAB_PROFILE_ID });
      updateSession(disconnected);
    }
    setLocalAccess(false);
  }

  if (checkingSession && isTauriRuntime()) return null;

  if (!session.connected && !localAccess) {
    return <LoginPage summary={session} checking={checkingSession} checkError={sessionError} onSessionChange={updateSession}
      onRetry={() => void refreshSession()} onLocalAccess={() => setLocalAccess(true)} />;
  }
  let content = null;
  switch (route.name) {
    case "colab":
      content = <ColabGate />;
      break;
    case "about":
      content = <About />;
      break;
    case "dashboard":
      content = <Dashboard />;
      break;
    case "validation":
      content = <TrackingEditor experimentId={route.experimentId} mode="reference" />;
      break;
    case "edit-ram": {
      const existing = getExperiment(route.experimentId);
      content = existing?.testType === "radial_arm_maze"
        ? <RadialArmMazeExperimentWizard key={existing.id} existing={existing} onBack={() => navigate({ name: "results", experimentId: existing.id })} />
        : <Dashboard />;
      break;
    }
  }
  const visibleResultId = route.name === "results" ? route.experimentId : null;
  // Mantém a análise ativa montada enquanto o usuário navega por outras páginas.
  const retainedResultIds = [...new Set([
    ...Object.entries(analysisActivity).filter(([id, activity]) => activity.starting && getExperiment(id)).map(([id]) => id),
    ...(visibleResultId ? [visibleResultId] : []),
  ])];
  return <AppShell accountEmail={session.accountEmail} colabSummary={session} onLogout={logout}>
    {content}
    {(draftVisited || route.name === "new-experiment") &&
      <div className="retained-workspace" hidden={route.name !== "new-experiment"}>
        <NewExperiment key={draftGeneration} onComplete={() => { setDraftVisited(false); setDraftGeneration(current => current + 1); }} />
      </div>}
    {retainedResultIds.map(id => <div key={id} className="retained-workspace" hidden={visibleResultId !== id}>
      {getExperiment(id)?.testType === "forced_swim"
        ? <ForcedSwimResults experimentId={id} /> : getExperiment(id)?.testType === "radial_arm_maze"
          ? <RadialMazeResults experimentId={id} /> : <Results experimentId={id} />}
    </div>)}
  </AppShell>;
}

