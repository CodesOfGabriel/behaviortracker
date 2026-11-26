import { invoke } from "@tauri-apps/api/core";

export const COLAB_PROFILE_ID = "local-default";
export const COLAB_STATUS_EVENT = "behavetracker:colab-status";

export type OAuthProfileSummary = {
  profileId: string;
  clientId: string;
  managedClient: boolean;
  hasClientSecret: boolean;
  connected: boolean;
  accountEmail: string | null;
  subscriptionTier: string | null;
  eligibleRuntimeCount: number;
  eligibleGpuCount: number;
  providerError: string | null;
  updatedAt: string | null;
};

export const emptyColabSummary: OAuthProfileSummary = {
  profileId: COLAB_PROFILE_ID,
  clientId: "",
  managedClient: false,
  hasClientSecret: false,
  connected: false,
  accountEmail: null,
  subscriptionTier: null,
  eligibleRuntimeCount: 0,
  eligibleGpuCount: 0,
  providerError: null,
  updatedAt: null,
};

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const GOOGLE_SESSION_CHECK_TIMEOUT_MS = 10_000;

export async function loadColabSummary() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<OAuthProfileSummary>("get_google_oauth_config", { profileId: COLAB_PROFILE_ID }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("A verificação da sessão Google demorou demais. Você pode tentar entrar novamente.")), GOOGLE_SESSION_CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function publishColabSummary(summary: OAuthProfileSummary) {
  window.dispatchEvent(new CustomEvent<OAuthProfileSummary>(COLAB_STATUS_EVENT, { detail: summary }));
}

export type GoogleDesktopCredentials = { clientId: string; clientSecret: string };

export function parseGoogleDesktopCredentials(text: string, managedClientId?: string): GoogleDesktopCredentials {
  let document: { installed?: { client_id?: unknown; client_secret?: unknown } } | null;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("Selecione o JSON de credenciais baixado do Google Cloud.");
  }

  const clientId = document?.installed?.client_id;
  const clientSecret = document?.installed?.client_secret;
  if (typeof clientId !== "string" || !clientId.trim().endsWith(".apps.googleusercontent.com")
    || typeof clientSecret !== "string" || !clientSecret.trim()) {
    throw new Error("O JSON deve conter o Client ID e o Client Secret de um cliente OAuth do tipo Aplicativo para computador.");
  }
  if (managedClientId && clientId.trim() !== managedClientId) {
    throw new Error("O JSON pertence a outro cliente OAuth. Selecione o arquivo do cliente usado por esta versão do aplicativo.");
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

export function saveGoogleDesktopCredentials(credentials: GoogleDesktopCredentials) {
  return invoke<OAuthProfileSummary>("save_google_oauth_config", { profileId: COLAB_PROFILE_ID, ...credentials });
}
