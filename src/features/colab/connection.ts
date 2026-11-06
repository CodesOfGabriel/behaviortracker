import { invoke } from "@tauri-apps/api/core";

export const COLAB_PROFILE_ID = "local-default";
export const COLAB_STATUS_EVENT = "behavetracker:colab-status";

export type OAuthProfileSummary = {
  profileId: string;
  clientId: string;
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

export function loadColabSummary() {
  return invoke<OAuthProfileSummary>("get_google_oauth_config", { profileId: COLAB_PROFILE_ID });
}

export function publishColabSummary(summary: OAuthProfileSummary) {
  window.dispatchEvent(new CustomEvent<OAuthProfileSummary>(COLAB_STATUS_EVENT, { detail: summary }));
}
