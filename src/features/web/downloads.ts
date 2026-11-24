// Keep this version aligned with a published desktop release, not the development package.
export const desktopRelease = {
  version: "0.1.4",
  repository: "https://github.com/CodesOfGabriel/behaviortracker",
};

export type DesktopInstaller = "mac-intel" | "mac-silicon" | "windows" | "linux-appimage" | "linux-deb";

const installerSuffix: Record<DesktopInstaller, string> = {
  "mac-intel": "macOS-Intel.dmg",
  "mac-silicon": "macOS-Apple-Silicon.dmg",
  windows: "Windows-x64.exe",
  "linux-appimage": "Linux-x64.AppImage",
  "linux-deb": "Linux-x64.deb",
};

export function installerUrl(installer: DesktopInstaller) {
  const tag = `v${desktopRelease.version}`;
  return `${desktopRelease.repository}/releases/download/${tag}/BehaviorTracker-${tag}-${installerSuffix[installer]}`;
}

export const desktopReleaseUrl = `${desktopRelease.repository}/releases/tag/v${desktopRelease.version}`;
