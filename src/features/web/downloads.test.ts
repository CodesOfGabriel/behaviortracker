import { afterEach, expect, it, vi } from "vitest";
import { publishedDesktopRelease } from "../../../tests/fixtures/desktop-release";
import { fetchLatestDesktopRelease, latestReleaseApi, parseDesktopRelease } from "./downloads";

afterEach(() => vi.unstubAllGlobals());

it("uses the published version for all five installers independently of the development version", () => {
  const release = parseDesktopRelease(publishedDesktopRelease("9.8.7"));
  expect(release.version).toBe("9.8.7");
  expect(release.releaseUrl).toBe("https://github.com/CodesOfGabriel/behaviortracker/releases/tag/v9.8.7");
  expect(Object.values(release.installers)).toHaveLength(5);
  for (const url of Object.values(release.installers)) expect(url).toContain("/v9.8.7/BehaviorTracker-v9.8.7-");
  expect(release.installers["mac-intel"]).toMatch(/-macOS-Intel\.dmg$/);
  expect(release.installers["mac-silicon"]).toMatch(/-macOS-Apple-Silicon\.dmg$/);
  expect(release.installers.windows).toMatch(/-Windows-x64\.exe$/);
  expect(release.installers["linux-appimage"]).toMatch(/-Linux-x64\.AppImage$/);
  expect(release.installers["linux-deb"]).toMatch(/-Linux-x64\.deb$/);
});

it.each([
  null,
  { ...publishedDesktopRelease(), draft: true },
  { ...publishedDesktopRelease(), prerelease: true },
  { ...publishedDesktopRelease(), tag_name: "models-wistar-df-v2-r1" },
  { ...publishedDesktopRelease(), tag_name: "v9.8.7-beta.1" },
  { ...publishedDesktopRelease(), html_url: "https://example.test/releases/tag/v9.8.7" },
  { ...publishedDesktopRelease(), assets: [] },
])("rejects an unpublished, incomplete or unrelated release: %j", input => {
  expect(() => parseDesktopRelease(input)).toThrow();
});

for (let index = 0; index < 5; index++) {
  it(`requires installer ${index + 1} to exist, be uploaded and have a valid download URL`, () => {
    const release = publishedDesktopRelease();
    expect(() => parseDesktopRelease({ ...release, assets: release.assets.filter((_, i) => i !== index) })).toThrow();
    for (const change of [{ state: "new" }, { size: 0 }, { size: Number.NaN }, { browser_download_url: "https://example.test/installer.exe" }]) {
      expect(() => parseDesktopRelease({ ...release, assets: release.assets.map((asset, i) => i === index ? { ...asset, ...change } : asset) })).toThrow();
    }
  });
}

it("queries the latest public release without credentials or a stale browser cache", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => publishedDesktopRelease() });
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect((await fetchLatestDesktopRelease(signal)).version).toBe("9.8.7");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(latestReleaseApi, {
    headers: { Accept: "application/vnd.github+json" }, cache: "no-store", signal,
  });
});

it.each([403, 404, 500])("rejects an unavailable GitHub response (%i)", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
  await expect(fetchLatestDesktopRelease()).rejects.toThrow(String(status));
});

it("propagates cancellation so an obsolete request cannot update the page", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_, { signal }: RequestInit) => {
    expect(signal).toBe(controller.signal);
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }));
  await expect(fetchLatestDesktopRelease(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
