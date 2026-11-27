export type DesktopInstaller = "mac-intel" | "mac-silicon" | "windows" | "linux-appimage" | "linux-deb";
export type DesktopRelease = {
  version: string;
  releaseUrl: string;
  installers: Record<DesktopInstaller, string>;
};

const repository = "https://github.com/CodesOfGabriel/behaviortracker";
export const latestReleaseApi = "https://api.github.com/repos/CodesOfGabriel/behaviortracker/releases/latest";

const installerSuffix: Record<DesktopInstaller, string> = {
  "mac-intel": "macOS-Intel.dmg",
  "mac-silicon": "macOS-Apple-Silicon.dmg",
  windows: "Windows-x64.exe",
  "linux-appimage": "Linux-x64.AppImage",
  "linux-deb": "Linux-x64.deb",
};

function releaseForVersion(version: string): DesktopRelease {
  const tag = `v${version}`;
  return {
    version,
    releaseUrl: `${repository}/releases/tag/${tag}`,
    installers: Object.fromEntries(Object.entries(installerSuffix).map(([installer, suffix]) => [
      installer, `${repository}/releases/download/${tag}/BehaviorTracker-${tag}-${suffix}`,
    ])) as Record<DesktopInstaller, string>,
  };
}

// Public v0.1.6 and its five installers were verified on 2026-11-27.
// This keeps downloads available if GitHub cannot answer, without claiming freshness.
export const fallbackDesktopRelease = releaseForVersion("0.1.6");

export function parseDesktopRelease(value: unknown): DesktopRelease {
  if (!value || typeof value !== "object") throw new Error("Release inválida.");
  const data = value as Record<string, unknown>;
  const version = typeof data.tag_name === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(data.tag_name)?.[1] : undefined;
  if (!version || data.draft !== false || data.prerelease !== false || !Array.isArray(data.assets)) {
    throw new Error("A release precisa ser uma versão estável publicada.");
  }
  const release = releaseForVersion(version);
  if (data.html_url !== release.releaseUrl) throw new Error("Repositório da release inválido.");
  for (const [installer, url] of Object.entries(release.installers)) {
    const name = `BehaviorTracker-v${version}-${installerSuffix[installer as DesktopInstaller]}`;
    const matches = data.assets.filter((asset: unknown) => asset && typeof asset === "object" && (asset as Record<string, unknown>).name === name);
    const asset = matches[0] as Record<string, unknown> | undefined;
    if (matches.length !== 1 || !asset || asset.state !== "uploaded" || typeof asset.size !== "number" || !Number.isFinite(asset.size) || asset.size <= 0 || asset.browser_download_url !== url) {
      throw new Error(`Instalador publicado ausente ou inválido: ${installer}.`);
    }
  }
  return release;
}

export async function fetchLatestDesktopRelease(signal?: AbortSignal): Promise<DesktopRelease> {
  const response = await fetch(latestReleaseApi, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`Não foi possível consultar a release (${response.status}).`);
  return parseDesktopRelease(await response.json());
}
