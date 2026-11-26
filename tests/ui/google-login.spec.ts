import { test, expect } from "./desktop";
import { emptyColabSummary } from "../../src/features/colab/connection";

type Scenario = "clean" | "missing-build" | "load-error" | "slow" | "retry" | "invalid-client";
type LoginWindow = Window & { __resolveGoogleConfiguration?: () => void };
async function openLogin(page: import("@playwright/test").Page, scenario: Scenario) {
  await page.addInitScript(({ empty, scenario }) => {
    localStorage.setItem("behavetracker.experiments.v1", "[]");
    const state = { calls: [] as { command:string;args:Record<string,unknown> }[], unexpected: [] as string[], annotations: [] as Record<string,unknown>[] };
    window.__desktopTest = state;
    // A fresh installation gets the application client from the native build;
    // no per-user credentials or token have been imported/saved.
    let summary = { ...empty, clientId:"desktop.apps.googleusercontent.com", managedClient:true, hasClientSecret:scenario!=="missing-build" };
    let attempts = 0;
    const invoke = async (command:string,args:Record<string,unknown>={}) => {
      state.calls.push({command,args});
      switch(command) {
        case "get_google_oauth_config":
          if(scenario==="load-error") throw new Error("Falha de teste ao consultar a sessão.");
          if(scenario==="slow") {
            const snapshot={...summary};
            return new Promise(resolve=>{(window as LoginWindow).__resolveGoogleConfiguration=()=>resolve(snapshot);});
          }
          return {...summary};
        case "start_google_auth":
          attempts++;
          if(!summary.hasClientSecret) throw new Error("Não foi possível iniciar o acesso Google nesta versão do aplicativo. Atualize o aplicativo e tente novamente.");
          if(scenario==="invalid-client") throw new Error("O Google recusou o acesso desta versão do aplicativo. Atualize o aplicativo e tente novamente.");
          if(scenario==="retry"&&attempts===1) throw new Error("Não foi possível abrir o navegador padrão.");
          summary={...summary,connected:true,accountEmail:"researcher@example.test"};
          return {...summary};
        case "plugin:event|listen":return 1;
        case "plugin:event|unlisten":return null;
        case "plugin:window|is_maximized":case "plugin:window|is_fullscreen":return false;
        default:state.unexpected.push(command);throw new Error(`Unexpected desktop command: ${command}`);
      }
    };
    Object.assign(window,{
      __TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},
      __TAURI_INTERNALS__:{metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}},
        convertFileSrc:(path:string)=>path,transformCallback:()=>1,unregisterCallback:()=>{},invoke},
    });
  },{empty:emptyColabSummary,scenario});
  await page.goto("/");
}

async function expectGoogleOnlyLogin(page: import("@playwright/test").Page) {
  await expect(page.getByRole("button",{name:"Entrar com Google",exact:true})).toBeEnabled();
  await expect(page.getByRole("button",{name:/Importar credenciais|Recuperar conexão anterior/})).toHaveCount(0);
  await expect(page.locator('input[type="file"], input[type="password"]')).toHaveCount(0);
  await expect(page.getByText("A configuração de acesso Google está incompleta nesta instalação.",{exact:false})).toHaveCount(0);
}

test("a fresh installation signs in exclusively through Google without importing credentials",async({page})=>{
  await openLogin(page,"clean");
  await expectGoogleOnlyLogin(page);
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  const calls=await page.evaluate(()=>window.__desktopTest.calls);
  expect(calls.filter(c=>c.command==="start_google_auth")).toHaveLength(1);
  expect(calls.filter(c=>/save_google_oauth|restore_legacy/.test(c.command))).toHaveLength(0);
});

test("account settings also use Google without manual application credential fields",async({page})=>{
  await openLogin(page,"clean");
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("button",{name:"Abrir menu do usuário"}).click();
  await page.getByRole("button",{name:"Configurações",exact:true}).click();
  await page.getByRole("tab",{name:"Google Colab",exact:true}).click();
  await expect(page.locator("#settings-view-colab-panel")).toBeVisible();
  await expect(page.getByText("Configuração avançada do acesso Google",{exact:true})).toHaveCount(0);
  await expect(page.locator('input[type="file"], input[name="clientSecret"]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>/save_google_oauth|restore_legacy/.test(c.command)))).toHaveLength(0);
});

test("a defective build cannot bypass Google or ask the user to supply application credentials",async({page})=>{
  await openLogin(page,"missing-build");
  await expectGoogleOnlyLogin(page);
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Atualize o aplicativo");
  await expectGoogleOnlyLogin(page);
  await expect(page.locator(".app-shell")).toHaveCount(0);
});

test("failed session lookup cannot disable a valid Google sign-in",async({page})=>{
  await openLogin(page,"load-error");
  await expect(page.getByRole("alert")).toContainText("Falha de teste ao consultar");
  await expectGoogleOnlyLogin(page);
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("Google rejecting an application client never exposes manual configuration or grants access",async({page})=>{
  await openLogin(page,"invalid-client");
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("O Google recusou");
  await expectGoogleOnlyLogin(page);
  await expect(page.locator(".app-shell")).toHaveCount(0);
});

test("browser-open failure releases Google sign-in for a real retry",async({page})=>{
  await openLogin(page,"retry");
  const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
  await signIn.click();await expect(page.getByRole("alert")).toContainText("navegador padrão");
  await expectGoogleOnlyLogin(page);await signIn.click();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="start_google_auth"))).toHaveLength(2);
});

test("a hung session lookup times out without trapping the login screen",async({page})=>{
  await page.clock.install();await openLogin(page,"slow");
  await expect.poll(()=>page.evaluate(()=>Boolean((window as LoginWindow).__resolveGoogleConfiguration))).toBe(true);
  await page.clock.runFor(11_000);
  await expectGoogleOnlyLogin(page);
  await expect(page.getByRole("alert")).toContainText("verificação da sessão");
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("an old disconnected session reply cannot overwrite a successful sign-in",async({page})=>{
  await openLogin(page,"slow");
  await expect.poll(()=>page.evaluate(()=>Boolean((window as LoginWindow).__resolveGoogleConfiguration))).toBe(true);
  await page.evaluate(empty=>window.dispatchEvent(new CustomEvent("behavetracker:colab-status",{detail:empty})),emptyColabSummary);
  await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.evaluate(async()=>{(window as LoginWindow).__resolveGoogleConfiguration?.();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("heading",{name:"Entre na sua conta"})).toHaveCount(0);
});

for(const viewport of [{width:980,height:620},{width:1440,height:900}]) {
  test(`Google sign-in remains clickable at ${viewport.width} × ${viewport.height}`,async({page},testInfo)=>{
    await page.setViewportSize(viewport);await openLogin(page,"retry");
    const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
    await expect(signIn).toBeInViewport();await signIn.click();
    await expect(page.getByRole("alert")).toContainText("navegador padrão");
    await expectGoogleOnlyLogin(page);
    await page.screenshot({path:`artifacts/google-login-bundled-2026-11-25/${testInfo.project.name}-${viewport.width}x${viewport.height}.png`});
    await signIn.click();await expect(page.locator(".app-shell")).toBeVisible();
  });
}
