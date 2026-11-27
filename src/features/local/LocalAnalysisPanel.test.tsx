// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAnalysisPanel } from "./LocalAnalysisPanel";
import * as local from "./api";
import * as behavior from "../behavior/api";
import { experimentFixture, jobFixture } from "../../../tests/fixtures/experiment";

const store = vi.hoisted(() => ({ assets: { "ui-open-field": { objectUrl: "blob:fixture" } },
  setAsset: vi.fn(), updateExperiment: vi.fn(), setAnalysisActivity: vi.fn() }));
vi.mock("../../store/AppStore", () => ({ useAppStore: () => store }));
vi.mock("../colab/connection", () => ({ isTauriRuntime: () => true }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(),
  stageLocalOriginal: vi.fn(), getLocalEnvironment: vi.fn(), setupLocalEnvironment: vi.fn(), listLocalJobs: vi.fn(),
  startLocalJob: vi.fn(), startLocalWistar: vi.fn(), cancelLocalJob: vi.fn() }));
vi.mock("../behavior/api", () => ({ getBehaviorModelStatus: vi.fn(), startBehavior: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  // jsdom tests only application state/commands. Visibility, hit testing, focus
  // restoration and native Escape MUST be tested by Playwright, not this shim.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.mocked(local.listLocalJobs).mockResolvedValue([]);
  vi.mocked(local.getLocalEnvironment).mockResolvedValue({ ready: true });
  vi.mocked(local.stageLocalOriginal).mockResolvedValue({ uploadId: "original-01", originalSha256: "a".repeat(64) });
  vi.mocked(local.startLocalJob).mockResolvedValue(jobFixture());
  vi.mocked(behavior.getBehaviorModelStatus).mockResolvedValue({ installed: false, environmentReady: false } as Awaited<ReturnType<typeof behavior.getBehaviorModelStatus>>);
});
afterEach(cleanup);

function mount(colabBusy = false) {
  const selectSource = vi.fn().mockResolvedValue(true);
  render(<LocalAnalysisPanel experiment={experimentFixture()} selectSource={selectSource} colabBusy={colabBusy}>
    {controls => <><button onClick={controls.run}>Analisar</button><details><summary>Histórico</summary>{controls.panel}</details></>}
  </LocalAnalysisPanel>);
  return { user: userEvent.setup(), selectSource };
}

describe("local analysis state and command contracts", () => {
  it("shows only the analysis action and stages nothing before confirmation", async () => {
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getAllByRole("button")).toHaveLength(1);
    expect((dialog.getByRole("button", { name: "Analisar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(dialog.queryByRole("combobox")).toBeNull();
    expect(dialog.queryByRole("checkbox")).toBeNull();
    expect(dialog.queryByText(/Fundo fixo|Python 3|Largura de processamento/)).toBeNull();
    expect(local.stageLocalOriginal).not.toHaveBeenCalled();
    expect(local.setupLocalEnvironment).not.toHaveBeenCalled();
    expect(local.startLocalJob).not.toHaveBeenCalled();
    expect(behavior.getBehaviorModelStatus).not.toHaveBeenCalled();
  });

  it("does not query the optional behavior model to confirm tracking", async () => {
    vi.mocked(behavior.getBehaviorModelStatus).mockReturnValue(new Promise(() => {}));
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Analisar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(behavior.getBehaviorModelStatus).not.toHaveBeenCalled();
  });

  it("refuses opening while Colab is busy even when called directly", async () => {
    const { user } = mount(true);
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    expect(document.querySelector("dialog")?.open).toBe(false);
    expect(behavior.getBehaviorModelStatus).not.toHaveBeenCalled();
  });

  it("refuses opening while a local job is active", async () => {
    vi.mocked(local.listLocalJobs).mockResolvedValue([jobFixture("running")]);
    const { user } = mount();
    await screen.findByRole("button", { name: "Cancelar" });
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    expect(document.querySelector("dialog")?.open).toBe(false);
    expect(behavior.getBehaviorModelStatus).not.toHaveBeenCalled();
  });

  it("submits the defaults and original hash once, then selects the completed result", async () => {
    vi.mocked(local.listLocalJobs).mockResolvedValue([jobFixture()]);
    const { user, selectSource } = mount();
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Analisar" }));
    await waitFor(() => expect(selectSource).toHaveBeenCalledWith({ engine: "opencv", jobId: "tracking-01" }));
    expect(local.startLocalJob).toHaveBeenCalledExactlyOnceWith("ui-open-field", "original-01",
      expect.objectContaining({ protocol: "open_field", strategy: "classical_roi_v1", maxWidth: 640, useOpenCL: false, referenceApproved: false }),
      { optimizeVideo: false, expectedVideoSha256: "a".repeat(64) });
    expect(behavior.startBehavior).not.toHaveBeenCalled();
    expect(local.setupLocalEnvironment).not.toHaveBeenCalled();
  });

  it("failed environment preparation reports the problem and never starts a job", async () => {
    vi.mocked(local.getLocalEnvironment).mockResolvedValue({ ready: false });
    vi.mocked(local.setupLocalEnvironment).mockResolvedValue({ ready: false });
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Analisar" }));
    await screen.findByText("Não foi possível preparar OpenCV local.");
    expect(local.startLocalJob).not.toHaveBeenCalled();
    expect(store.setAnalysisActivity).toHaveBeenLastCalledWith("ui-open-field", { starting: false, videoProgress: null });
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    expect(document.querySelector("dialog")?.open).toBe(true);
  });

  it("a staging failure is visible and clears the busy state for a retry", async () => {
    vi.mocked(local.stageLocalOriginal).mockRejectedValue(new Error("SHA-256 incorreto"));
    const { user } = mount();
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Analisar" }));
    await screen.findByText("SHA-256 incorreto");
    expect(local.startLocalJob).not.toHaveBeenCalled();
    expect(store.setAnalysisActivity).toHaveBeenLastCalledWith("ui-open-field", { starting: false, videoProgress: null });
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    expect(document.querySelector("dialog")?.open).toBe(true);
  });

  it("a completed job whose result cannot open reports failure instead of silent success", async () => {
    vi.mocked(local.listLocalJobs).mockResolvedValue([jobFixture()]);
    const { user, selectSource } = mount();
    selectSource.mockResolvedValue(false);
    await user.click(screen.getByRole("button", { name: "Analisar" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Analisar" }));
    await screen.findByText("O resultado local não pôde ser aberto.");
    expect(behavior.startBehavior).not.toHaveBeenCalled();
    expect(store.setAnalysisActivity).toHaveBeenLastCalledWith("ui-open-field", { starting: false, videoProgress: null });
  });
});
