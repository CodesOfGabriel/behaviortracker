import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
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
import { Results } from "./features/results/Results";
import { ForcedSwimResults } from "./features/results/ForcedSwimResults";
import { useAppStore } from "./store/AppStore";

export default function App() {
  const { route, getExperiment, navigate } = useAppStore();
  const [session, setSession] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

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
    const disconnected = await invoke<OAuthProfileSummary>("disconnect_google_account", { profileId: COLAB_PROFILE_ID });
    navigate({ name: "dashboard" });
    updateSession(disconnected);
  }

  if (!session.connected) {
    return <LoginPage summary={session} checking={checkingSession} checkError={sessionError} onSessionChange={updateSession} onRetry={() => void refreshSession()} />;
  }
  let content;
  switch (route.name) {
    case "new-experiment":
      content = <NewExperiment />;
      break;
    case "results":
      content = getExperiment(route.experimentId)?.testType === "forced_swim"
        ? <ForcedSwimResults key={route.experimentId} experimentId={route.experimentId} />
        : <Results key={route.experimentId} experimentId={route.experimentId} />;
      break;
    case "colab":
      content = <ColabGate />;
      break;
    case "about":
      content = <About />;
      break;
    default:
      content = <Dashboard />;
  }
  return <AppShell accountEmail={session.accountEmail} onLogout={logout}>{content}</AppShell>;
}

