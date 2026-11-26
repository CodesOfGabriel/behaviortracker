// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExperimentVideos } from "./ExperimentVideos";
import { loadColabVideo, rebuildColabActivityVideo } from "../colab/analysis";
import { experimentFixture } from "../../../tests/fixtures/experiment";
import type { ForcedSwimExperiment } from "../../types";

vi.mock("../colab/analysis", () => ({ loadColabVideo: vi.fn(), rebuildColabActivityVideo: vi.fn(), loadRamArtifacts: vi.fn() }));
vi.mock("./experiment-runs", () => ({
  useExperimentRuns: () => ({ runs: [{ key: "colab:job", engine: "colab", jobId: "job" }], loading: false, error: null }),
  runLabel: () => "Google Colab",
}));
vi.mock("../local/LocalAuditVideo", () => ({ LocalAuditVideo: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadColabVideo).mockResolvedValue({ jobId: "job", videoPath: "/old.mp4", videoUrl: "asset:old.mp4", videoError: null, needsActivityRebuild: true });
});
afterEach(cleanup);

it("upgrades a saved MP4 with a skeleton and reloads the exported artifact", async () => {
  const experiment = experimentFixture();
  vi.mocked(rebuildColabActivityVideo).mockResolvedValue(undefined);
  render(<ExperimentVideos experiment={experiment} />);
  const button = await screen.findByRole("button", { name: "Atualizar MP4" });
  expect(document.querySelector("video")?.getAttribute("src")).toBe("asset:old.mp4");
  vi.mocked(loadColabVideo).mockResolvedValue({ jobId: "job", videoPath: "/skeleton.mp4", videoUrl: "asset:skeleton.mp4", videoError: null, needsActivityRebuild: false });
  await userEvent.click(button);
  await waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toBe("asset:skeleton.mp4"));
  expect(rebuildColabActivityVideo).toHaveBeenCalledWith(experiment.id, "job", experiment.arena, experiment.video);
  expect(screen.queryByRole("button", { name: "Atualizar MP4" })).toBeNull();
  expect(screen.getByRole("button", { name: "Baixar MP4" })).toBeTruthy();
});

it("retains the playable export and allows retry when an upgrade fails", async () => {
  vi.mocked(rebuildColabActivityVideo).mockRejectedValue(new Error("Renderização interrompida"));
  render(<ExperimentVideos experiment={experimentFixture()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Atualizar MP4" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Renderização interrompida");
  expect(document.querySelector("video")?.getAttribute("src")).toBe("asset:old.mp4");
  expect((screen.getByRole("button", { name: "Atualizar MP4" }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not offer the OFT skeleton upgrade for another protocol", async () => {
  const { id, title, subjectId, status, createdAt, updatedAt, video } = experimentFixture();
  const experiment: ForcedSwimExperiment = { id, title, subjectId, status, createdAt, updatedAt, video,
    testType: "forced_swim", schemaVersion: "1.0", analysisMethodVersion: "fst-0.1",
    analysisEngine: "fst_superanimal_quadruped_v1", subjects: [], tanks: [], annotations: [] };
  render(<ExperimentVideos experiment={experiment} />);
  await screen.findByRole("button", { name: "Baixar MP4" });
  expect(screen.queryByRole("button", { name: "Atualizar MP4" })).toBeNull();
  expect(rebuildColabActivityVideo).not.toHaveBeenCalled();
});
