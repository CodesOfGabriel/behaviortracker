import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {COLAB_PROFILE_ID,emptyColabSummary,GOOGLE_SESSION_CHECK_TIMEOUT_MS,loadColabSummary} from "./connection";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();});
describe("Google session lookup recovery",()=>{
 it("returns the native summary without leaving a timeout behind",async()=>{
  const summary={...emptyColabSummary,clientId:"desktop.apps.googleusercontent.com",hasClientSecret:true};
  vi.mocked(invoke).mockResolvedValue(summary);
  await expect(loadColabSummary()).resolves.toEqual(summary);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_google_oauth_config",{profileId:COLAB_PROFILE_ID});
  expect(vi.getTimerCount()).toBe(0);
 });
 it("reports a stalled native lookup and ignores its late reply",async()=>{
  let resolve!:(value:typeof emptyColabSummary)=>void;
  vi.mocked(invoke).mockReturnValue(new Promise(done=>{resolve=done;}));
  const response=loadColabSummary();
  const rejected=expect(response).rejects.toThrow("verificação da sessão Google demorou demais");
  await vi.advanceTimersByTimeAsync(GOOGLE_SESSION_CHECK_TIMEOUT_MS);
  await rejected;resolve({...emptyColabSummary,connected:true});
  await expect(response).rejects.toThrow("verificação da sessão");
  expect(vi.getTimerCount()).toBe(0);
 });
});
