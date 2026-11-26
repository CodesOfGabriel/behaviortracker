# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: google-login.spec.ts >> failed session lookup cannot disable a valid Google sign-in
- Location: tests/ui/google-login.spec.ts:60:1

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator:  getByRole('button', { name: 'Entrar com Google', exact: true })
Expected: enabled
Received: disabled
Timeout:  7000ms

Call log:
  - Expect "toBeEnabled" getByRole('button', { name: 'Entrar com Google', exact: true }) with timeout 7000ms
  - waiting for getByRole('button', { name: 'Entrar com Google', exact: true })
    17 × locator resolved to <button disabled type="button" class="login-google-button">…</button>
       - unexpected value "disabled"

```

```yaml
- button "Entrar com Google" [disabled]
```

# Test source

```ts
  1  | import { test, expect } from "./desktop";
  2  | import { emptyColabSummary } from "../../src/features/colab/connection";
  3  | 
  4  | type Scenario = "missing" | "load-error" | "slow" | "retry";
  5  | type LoginWindow = Window & { __resolveGoogleConfiguration?: () => void };
  6  | async function openLogin(page: import("@playwright/test").Page, scenario: Scenario) {
  7  |   await page.addInitScript(({ empty, scenario }) => {
  8  |     localStorage.setItem("behavetracker.experiments.v1", "[]");
  9  |     const state = { calls: [] as { command:string;args:Record<string,unknown> }[], unexpected: [] as string[], annotations: [] as Record<string,unknown>[] };
  10 |     window.__desktopTest = state;
  11 |     let summary = { ...empty, clientId:"desktop.apps.googleusercontent.com", hasClientSecret:scenario!=="missing" };
  12 |     let attempts = 0;
  13 |     const invoke = async (command:string,args:Record<string,unknown>={}) => {
  14 |       state.calls.push({command,args});
  15 |       switch(command) {
  16 |         case "get_google_oauth_config":
  17 |           if(scenario==="load-error") throw new Error("Falha de teste ao consultar a sessão.");
  18 |           if(scenario==="slow") return new Promise(resolve=>{(window as LoginWindow).__resolveGoogleConfiguration=()=>resolve({...summary});});
  19 |           return {...summary};
  20 |         case "save_google_oauth_config":
  21 |           summary={...summary,clientId:String(args.clientId),hasClientSecret:true};return {...summary};
  22 |         case "start_google_auth":
  23 |           attempts++;
  24 |           if(!summary.hasClientSecret) throw new Error("A configuração de acesso Google está incompleta. Importe as credenciais para continuar.");
  25 |           if(scenario==="retry"&&attempts===1) throw new Error("Não foi possível abrir o navegador padrão.");
  26 |           return {...summary,connected:true,accountEmail:"researcher@example.test"};
  27 |         case "plugin:event|listen":return 1;
  28 |         case "plugin:event|unlisten":return null;
  29 |         case "plugin:window|is_maximized":case "plugin:window|is_fullscreen":return false;
  30 |         default:state.unexpected.push(command);throw new Error(`Unexpected desktop command: ${command}`);
  31 |       }
  32 |     };
  33 |     Object.assign(window,{
  34 |       __TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},
  35 |       __TAURI_INTERNALS__:{metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}},
  36 |         convertFileSrc:(path:string)=>path,transformCallback:()=>1,unregisterCallback:()=>{},invoke},
  37 |     });
  38 |   },{empty:emptyColabSummary,scenario});
  39 |   await page.goto("/");
  40 | }
  41 | 
  42 | test("missing Google credentials never leave a disabled sign-in button and can be recovered before login",async({page})=>{
  43 |   await openLogin(page,"missing");
  44 |   const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
  45 |   await expect(signIn).toBeVisible();await expect(signIn).toBeEnabled();
  46 |   await signIn.click();
  47 |   await expect(page.getByRole("alert")).toContainText("configuração de acesso Google");
  48 |   const chooser=page.waitForEvent("filechooser");
  49 |   await page.getByRole("button",{name:"Importar credenciais JSON"}).click();
  50 |   await (await chooser).setFiles({name:"google-desktop.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({installed:{client_id:"desktop.apps.googleusercontent.com",client_secret:"test-client-secret"}}))});
  51 |   await expect(page.getByRole("button",{name:"Importar credenciais JSON"})).toHaveCount(0);
  52 |   await signIn.click();
  53 |   await expect(page.getByRole("heading",{name:"Entre na sua conta"})).toHaveCount(0);
  54 |   await expect(page.locator(".app-shell")).toBeVisible();
  55 |   const calls=await page.evaluate(()=>window.__desktopTest.calls);
  56 |   expect(calls.filter(c=>c.command==="start_google_auth")).toHaveLength(2);
  57 |   expect(calls.filter(c=>c.command==="save_google_oauth_config")).toHaveLength(1);
  58 | });
  59 | 
  60 | test("failed session lookup cannot disable a valid Google sign-in",async({page})=>{
  61 |   await openLogin(page,"load-error");
  62 |   const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
  63 |   await expect(page.getByRole("alert")).toContainText("Falha de teste ao consultar");
> 64 |   await expect(signIn).toBeEnabled();await signIn.click();
     |                        ^ Error: expect(locator).toBeEnabled() failed
  65 |   await expect(page.locator(".app-shell")).toBeVisible();
  66 | });
  67 | 
  68 | test("browser-open failure releases sign-in for a real retry",async({page})=>{
  69 |   await openLogin(page,"retry");
  70 |   const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
  71 |   await signIn.click();await expect(page.getByRole("alert")).toContainText("navegador padrão");
  72 |   await expect(signIn).toBeEnabled();await signIn.click();
  73 |   await expect(page.locator(".app-shell")).toBeVisible();
  74 |   expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="start_google_auth"))).toHaveLength(2);
  75 | });
  76 | 
  77 | test("a hung session lookup times out without trapping the login screen",async({page})=>{
  78 |   await page.clock.install();await openLogin(page,"slow");
  79 |   await page.clock.runFor(11_000);
  80 |   const signIn=page.getByRole("button",{name:"Entrar com Google",exact:true});
  81 |   await expect(signIn).toBeVisible();await expect(signIn).toBeEnabled();
  82 |   await expect(page.getByRole("alert")).toContainText("verificação da sessão");
  83 |   await signIn.click();await expect(page.locator(".app-shell")).toBeVisible();
  84 | });
  85 | 
  86 | test("an old disconnected session reply cannot overwrite a successful sign-in",async({page})=>{
  87 |   await openLogin(page,"slow");
  88 |   await expect.poll(()=>page.evaluate(()=>Boolean((window as LoginWindow).__resolveGoogleConfiguration))).toBe(true);
  89 |   await page.evaluate(empty=>window.dispatchEvent(new CustomEvent("behavetracker:colab-status",{detail:empty})),emptyColabSummary);
  90 |   await page.getByRole("button",{name:"Entrar com Google",exact:true}).click();
  91 |   await expect(page.locator(".app-shell")).toBeVisible();
  92 |   await page.evaluate(async()=>{(window as LoginWindow).__resolveGoogleConfiguration?.();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  93 |   await expect(page.locator(".app-shell")).toBeVisible();
  94 |   await expect(page.getByRole("heading",{name:"Entre na sua conta"})).toHaveCount(0);
  95 | });
  96 | 
```