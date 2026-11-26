// @vitest-environment jsdom
import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {LoginPage} from "./LoginPage";
import {emptyColabSummary} from "../colab/connection";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("../colab/connection",async original=>({...await original<typeof import("../colab/connection")>(),isTauriRuntime:()=>true}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("starts only one authorization when two clicks arrive before rendering pending state",async()=>{
 let resolve!:(summary:typeof emptyColabSummary)=>void;
 vi.mocked(invoke).mockReturnValue(new Promise(done=>{resolve=done;}));
 const onSessionChange=vi.fn();
 render(<LoginPage summary={{...emptyColabSummary,clientId:"desktop.apps.googleusercontent.com",hasClientSecret:true}}
  checking={false} checkError={null} onRetry={vi.fn()} onSessionChange={onSessionChange}/>);
 const button=screen.getByRole("button",{name:"Entrar com Google"});
 act(()=>{button.click();button.click();});
 expect(invoke).toHaveBeenCalledExactlyOnceWith("start_google_auth",{profileId:"local-default"});
 expect((button as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>{resolve({...emptyColabSummary,connected:true});});
 expect(onSessionChange).toHaveBeenCalledTimes(1);
});

it.each([false,true])("offers only Google sign-in when hasClientSecret is %s",async hasClientSecret=>{
 vi.mocked(invoke).mockResolvedValue({...emptyColabSummary,connected:true});
 const onSessionChange=vi.fn();
 render(<LoginPage summary={{...emptyColabSummary,hasClientSecret}} checking={false} checkError={null}
  onRetry={vi.fn()} onSessionChange={onSessionChange}/>);
 expect(screen.queryByText(/configuração de acesso Google está incompleta/i)).toBeNull();
 expect(screen.queryByRole("button",{name:/Importar|Recuperar/})).toBeNull();
 expect(document.querySelector('input[type="file"], input[type="password"]')).toBeNull();
 await act(async()=>{screen.getByRole("button",{name:"Entrar com Google"}).click();});
 expect(invoke).toHaveBeenCalledExactlyOnceWith("start_google_auth",{profileId:"local-default"});
 expect(onSessionChange).toHaveBeenCalledTimes(1);
});

it("does not grant access when Google authorization is incomplete and permits retry",async()=>{
 vi.mocked(invoke).mockResolvedValueOnce(emptyColabSummary).mockResolvedValueOnce({...emptyColabSummary,connected:true});
 const onSessionChange=vi.fn();
 render(<LoginPage summary={emptyColabSummary} checking={false} checkError={null}
  onRetry={vi.fn()} onSessionChange={onSessionChange}/>);
 await act(async()=>{screen.getByRole("button",{name:"Entrar com Google"}).click();});
 expect(onSessionChange).not.toHaveBeenCalled();
 expect(screen.getByRole("alert").textContent).toContain("não foi conectada");
 await act(async()=>{screen.getByRole("button",{name:"Entrar com Google"}).click();});
 expect(onSessionChange).toHaveBeenCalledTimes(1);
 expect(invoke).toHaveBeenCalledTimes(2);
});
