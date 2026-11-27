export function publishedDesktopRelease(version = "9.8.7") {
  const repository = "https://github.com/CodesOfGabriel/behaviortracker";
  const tag = `v${version}`;
  return {
    tag_name: tag,
    html_url: `${repository}/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: ["macOS-Intel.dmg", "macOS-Apple-Silicon.dmg", "Windows-x64.exe", "Linux-x64.AppImage", "Linux-x64.deb"].map(suffix => {
      const name = `BehaviorTracker-${tag}-${suffix}`;
      return { name, state: "uploaded", size: 1024, browser_download_url: `${repository}/releases/download/${tag}/${name}` };
    }),
  };
}
