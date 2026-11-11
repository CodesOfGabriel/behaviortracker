// Teste visual local com Chrome isolado; não usa Tauri, contas Google ou vídeo real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "behavetracker-arena-ui-"));
const browser = spawn(process.env.BEHAVETRACKER_BROWSER_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`,
], { stdio: "ignore" });
let ws;
let nextId = 0;
const pending = new Map();
const errors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}

async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timeout aguardando: ${expression}`);
}

const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(label)})`;
async function click(label) {
  await waitFor(`${button(label)} && !${button(label)}.disabled`);
  await evaluate(`${button(label)}.click()`);
}

try {
  browser.on("error", (error) => errors.push(error.message));
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { [port] = (await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n"); break; }
    catch { await pause(100); }
  }
  assert.ok(port, "Chrome não disponibilizou a porta de depuração");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", ({ data }) => {
    const value = JSON.parse(data);
    if (value.id && pending.has(value.id)) {
      const callback = pending.get(value.id);
      pending.delete(value.id);
      if (value.error) callback.reject(new Error(JSON.stringify(value.error)));
      else callback.resolve(value.result);
    }
    if (value.method === "Runtime.exceptionThrown") errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: process.env.BEHAVETRACKER_PREVIEW_URL ?? "http://127.0.0.1:1420" });
  await click("Novo experimento");
  await waitFor(`!!document.querySelector('.protocol-option:not(:disabled)')`);
  assert.equal(await evaluate(`document.querySelectorAll('.protocol-option').length`), 2);
  assert.ok(await evaluate(`document.querySelector('.protocol-option-disabled').disabled`));
  assert.ok(await evaluate(`document.querySelector('.brand-mark img').getAttribute('src') === '/RatLogo_white.png'`));
  const picker = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "protocol-picker.png"), Buffer.from(picker.data, "base64"));
  await evaluate(`document.querySelector('.protocol-option:not(:disabled)').click()`);
  await waitFor(`!!document.querySelector('input[placeholder="Ex.: RAT_001"]')`);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="Ex.: RAT_001"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ARENA_UI_TEST'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click("Continuar");
  await click("ou usar uma arena sintética");
  await click("Continuar");
  await waitFor(`!!document.querySelector('.arena-layer-selector')`);
  assert.equal(await evaluate(`document.querySelectorAll('.arena-layer-selector button').length`), 2);
  assert.ok(await evaluate(`${button("Continuar")}.disabled`));
  assert.ok(await evaluate(`document.querySelector('.arena-layer-selector button').getAttribute('aria-pressed') === 'true'`));
  const before = await evaluate(`document.querySelector('.arena-handle').getAttribute('transform')`);
  // Força letterboxing: o arraste precisa usar a transformação SVG, não a caixa CSS.
  const position = await evaluate(`(() => { const svg = document.querySelector('.arena-editor-frame svg'); svg.style.height = '550px'; const g = document.querySelector('.arena-handle'); g.scrollIntoView({block:'center'}); const m = g.getScreenCTM(); const t = g.transform.baseVal.consolidate().matrix; return {x:m.e,y:m.f,a:m.a,d:m.d,originalX:t.e,originalY:t.f}; })()`);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: position.x + 12, y: position.y + 8, button: "left", buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x + 12, y: position.y + 8, button: "left" });
  await waitFor(`document.querySelector('.arena-handle').getAttribute('transform') !== ${JSON.stringify(before)}`);
  const moved = await evaluate(`(() => { const t = document.querySelector('.arena-handle').transform.baseVal.consolidate().matrix; return {x:t.e,y:t.f}; })()`);
  assert.ok(Math.abs(moved.x - position.originalX - 12 / position.a) < .01);
  assert.ok(Math.abs(moved.y - position.originalY - 8 / position.d) < .01);
  await evaluate(`document.querySelector('.arena-editor-frame svg').style.height = ''`);
  await click("Confirmar borda");
  await waitFor(`document.querySelectorAll('.arena-layer-selector button')[1].getAttribute('aria-pressed') === 'true'`);
  assert.ok(await evaluate(`${button("Continuar")}.disabled`));
  await click("Confirmar chão");
  await waitFor(`!${button("Continuar")}.disabled`);
  // Alterar um vértice invalida a confirmação daquela área, não da outra.
  await evaluate(`document.querySelector('.arena-handle').focus()`);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await waitFor(`${button("Continuar")}.disabled`);
  assert.ok(await evaluate(`document.querySelectorAll('.arena-layer-selector button')[0].textContent.includes('Confirmado')`));
  await click("Confirmar chão");
  const desktop = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "desktop.png"), Buffer.from(desktop.data, "base64"));
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await pause(150);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), "Overflow horizontal no celular");
  const mobile = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "mobile.png"), Buffer.from(mobile.data, "base64"));
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await click("Continuar");
  await click("Criar e abrir editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  const experiment = await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0]`);
  assert.equal(experiment.arena.cornersPx.length, 4);
  assert.equal(experiment.arena.rimCornersPx.length, 4);
  assert.notDeepEqual(experiment.arena.cornersPx, experiment.arena.rimCornersPx);
  assert.equal(experiment.subjectId, "ARENA_UI_TEST");
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay polygon[stroke="#f0f0ed"]')`));
  await click("Vídeo do DeepLabCut");
  await waitFor(`!!document.querySelector('.dlc-video-panel')`);
  assert.ok(await evaluate(`!document.querySelector('.tracking-overlay')`), "O vídeo bruto do DLC não pode mostrar correções do editor");
  assert.ok(await evaluate(`document.querySelector('.dlc-video-panel').textContent.includes('sem correções do editor')`));
  assert.ok(await evaluate(`!${button("Confirmar ponto após revisar")}`));
  await click("Editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  assert.equal(await evaluate(`document.querySelectorAll('.tracking-page select').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.speed-options button').length`), 4);
  assert.ok(await evaluate(`!document.querySelector('.tracking-source-bar, .colab-connect-notice, .select-menu-trigger')`));
  const editor = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "editor.png"), Buffer.from(editor.data, "base64"));
  assert.ok(await evaluate(`!document.querySelector('.video-toolbar .segmented-control:not(.video-source-tabs)')`));
  const tabs = await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).map(tab => tab.textContent.trim())`);
  assert.deepEqual(tabs.filter(label => ["Revisar vídeo", "Execuções"].includes(label)), ["Revisar vídeo"]);
  assert.ok(!tabs.some(label => ["Análise local", "Teste híbrido", "Comportamentos", "Ensinar o modelo", "Testar rastreamento"].includes(label)));
  assert.ok(await evaluate(`!document.querySelector('.behavior-review, .local-hybrid-notice, .diagnostic-panel, .training-panel')`));
  await click("Ver resultados");
  await waitFor(`!!document.querySelector('.results-page')`);
  assert.ok(await evaluate(`!document.querySelector('.results-context .segmented-control')`));
  assert.ok(await evaluate(`!document.querySelector('.behavior-results')`));
  await click("Exportar");
  assert.ok(await evaluate(`!document.querySelector('.export-drawer').textContent.includes('behaviors.csv')`));
  await evaluate(`(async () => {
    const image = new Image(); image.src = '/open-field-background.png'; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 480;
    canvas.getContext('2d').drawImage(image, 0, 0, 480, 480);
    const experiments = JSON.parse(localStorage.getItem('behavetracker.experiments.v1'));
    experiments[0].calibrationThumbnailDataUrl = canvas.toDataURL('image/jpeg', .7);
    localStorage.setItem('behavetracker.experiments.v1', JSON.stringify(experiments));
  })()`);
  await command("Page.reload");
  await waitFor(`!!document.querySelector('.experiment-thumb.has-image img')`);
  const thumbnailLayout = await evaluate(`(() => { const card = document.querySelector('.experiment-row').getBoundingClientRect(); const thumb = document.querySelector('.experiment-thumb.has-image').getBoundingClientRect(); const image = document.querySelector('.experiment-thumb.has-image img'); return { card: { width: card.width, height: card.height }, thumb: { width: thumb.width, height: thumb.height }, fit: getComputedStyle(image).objectFit }; })()`);
  assert.ok(Math.abs(thumbnailLayout.thumb.width - thumbnailLayout.card.width) <= 2 && Math.abs(thumbnailLayout.thumb.height - thumbnailLayout.card.height) <= 2 && thumbnailLayout.fit === "cover", JSON.stringify(thumbnailLayout));
  const dashboard = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "dashboard-card.png"), Buffer.from(dashboard.data, "base64"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ arenaSelection: "passed", confirmation: "passed", pointerAndKeyboard: "passed", persistence: "passed", desktopAndMobile: "passed", removedWorkspaces: "passed", resultsWithoutBehaviorPanel: "passed", directory }));
} catch (error) {
  if(ws?.readyState===WebSocket.OPEN){
    const failure=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true}).catch(()=>null);
    if(failure)await writeFile(join(directory,'failure.png'),Buffer.from(failure.data,'base64'));
    console.error('UI failure',directory,await evaluate(`Array.from(document.querySelectorAll('.range-handle')).map(h=>({edge:h.dataset.rangeEdit,time:h.getAttribute('aria-valuenow')}))`).catch(()=>[]));
  }
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => {});
    ws.close();
  }
  if (browser.exitCode == null) browser.kill();
}
