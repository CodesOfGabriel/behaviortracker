import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getStagedVideoSha256, stageVideo } from "../colab/analysis";
import { loadLocalAuditVideo, stageLocalOriginal } from "./api";
import type { VideoMetadata } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: vi.fn() }));
vi.mock("../colab/analysis", () => ({ stageVideo: vi.fn(), getStagedVideoSha256: vi.fn() }));

const video = { filename: "session.mp4", sizeBytes: 12, sha256: "original-sha", width: 320, height: 240 } as VideoMetadata;
const progress = vi.fn();

beforeEach(() => vi.resetAllMocks());

describe("local classical original video staging", () => {
  it("reuses the original cache with the required desktop arguments", async () => {
    vi.mocked(invoke).mockResolvedValue({ originalUploadId: "original", originalSha256: "original-sha" });
    expect(await stageLocalOriginal("experiment", video, undefined, progress)).toEqual({ uploadId: "original", originalSha256: "original-sha" });
    expect(invoke).toHaveBeenCalledWith("get_staged_analysis_video", expect.objectContaining({ adaptive: false, expectedSha256: "original-sha" }));
    expect(stageVideo).not.toHaveBeenCalled();
  });

  it("requires a file if the original cache is absent", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await stageLocalOriginal("experiment", video, undefined, progress)).toBeNull();
    expect(stageVideo).not.toHaveBeenCalled();
  });

  it("rejects a different original hash before starting tracking", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(stageVideo).mockResolvedValue("staged");
    vi.mocked(getStagedVideoSha256).mockResolvedValue("different-sha");
    const file = { name: video.filename, size: video.sizeBytes } as File;
    await expect(stageLocalOriginal("experiment", video, file, progress)).rejects.toThrow("SHA-256");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("local audit video refresh", () => {
  it("forces a render on request and uses a fresh playback URL", async () => {
    vi.mocked(invoke).mockResolvedValue({ videoPath: "/tmp/audit.mp4", videoError: null });
    vi.mocked(convertFileSrc).mockReturnValue("http://asset.localhost/audit.mp4");
    const saved = await loadLocalAuditVideo("job", false);
    const refreshed = await loadLocalAuditVideo("job", true);
    expect(saved.videoUrl).toBe("http://asset.localhost/audit.mp4");
    expect(refreshed.videoUrl).toMatch(/^http:\/\/asset\.localhost\/audit\.mp4\?v=\d+$/);
    expect(invoke).toHaveBeenLastCalledWith("get_local_audit_video", { jobId: "job", render: true });
  });
});
