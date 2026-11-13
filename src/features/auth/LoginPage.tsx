import { invoke } from "@tauri-apps/api/core";
import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import {
  COLAB_PROFILE_ID,
  isTauriRuntime,
  type OAuthProfileSummary,
} from "../colab/connection";

function errorMessage(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Não foi possível entrar com o Google.";
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="18" height="18">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.27 5.48-4.8 7.18l7.73 6C44.38 38.03 46.98 31.87 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.6.27-3.15.76-4.59l-7.98-6.2A23.87 23.87 0 0 0 0 24c0 3.87.93 7.5 2.56 10.78l7.97-6.19Z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.92-2.13 15.89-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

export function LoginPage({ summary, checking, checkError, onSessionChange, onRetry }: {
  summary: OAuthProfileSummary;
  checking: boolean;
  checkError: string | null;
  onSessionChange: (summary: OAuthProfileSummary) => void;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const desktop = isTauriRuntime();

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const connected = await invoke<OAuthProfileSummary>("start_google_auth", { profileId: COLAB_PROFILE_ID });
      if (!connected.connected) throw new Error("A conta Google não foi conectada. Tente novamente.");
      onSessionChange(connected);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function saveClientId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await invoke<OAuthProfileSummary>("save_google_oauth_config", {
        profileId: COLAB_PROFILE_ID,
        clientId: clientId.trim(),
        clientSecret: null,
      });
      onSessionChange(updated);
      setClientId("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-content">
        <div className="login-brand">
          <span className="login-brand-icon"><img src="/RatLogo_white.png" alt="" /></span>
          <span>Behavior Tracker</span>
        </div>
        <div className="login-center">
          <div className="login-form">
            <div className="login-intro">
              <h1>Entre na sua conta</h1>
              <p>Use a conta Google para entrar e processar vídeos no Colab.</p>
            </div>
            <button
              className="login-google-button"
              type="button"
              disabled={checking || busy || !desktop || !summary.clientId}
              onClick={() => void signIn()}
            >
              {busy ? <LoaderCircle size={18} className="login-spinner" /> : <GoogleMark />}
              {busy ? "Aguardando autorização…" : checking ? "Verificando sessão…" : "Entrar com Google"}
              {!busy && !checking && <ArrowRight size={16} className="login-arrow" />}
            </button>
            {busy && <p className="login-hint" role="status">Conclua a autorização na janela do navegador.</p>}
            {!desktop && <p className="login-error" role="alert">O login Google está disponível no aplicativo desktop.</p>}
            {(error || checkError) && <div className="login-error" role="alert">{error || checkError}{checkError && <button type="button" onClick={onRetry}>Tentar novamente</button>}</div>}
            {desktop && !checking && !summary.clientId && (
              <details className="login-setup">
                <summary>Configurar acesso Google neste build</summary>
                <p>Informe o Client ID OAuth de um aplicativo para computador.</p>
                <form onSubmit={(event) => void saveClientId(event)}>
                  <label htmlFor="login-client-id">Client ID</label>
                  <input id="login-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} required autoComplete="off" placeholder="…apps.googleusercontent.com" />
                  <button type="submit" disabled={busy || !clientId.trim()}>Salvar configuração</button>
                </form>
              </details>
            )}
          </div>
        </div>
        <p className="login-footer">Análise comportamental de roedores</p>
      </div>
      <div className="login-image" aria-hidden="true">
        <video autoPlay loop muted playsInline>
          <source src="/rats_background.mp4" type="video/mp4" />
        </video>
        <span className="login-image-caption">BEHAVIOR TRACKER <span>·</span> RESEARCH WORKSPACE</span>
      </div>
    </div>
  );
}
