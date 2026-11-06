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

const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
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
  await click("Continuar");
  await click("Criar e abrir editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  const experiment = await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0]`);
  assert.equal(experiment.arena.cornersPx.length, 4);
  assert.equal(experiment.arena.rimCornersPx.length, 4);
  assert.notDeepEqual(experiment.arena.cornersPx, experiment.arena.rimCornersPx);
  assert.equal(experiment.subjectId, "ARENA_UI_TEST");
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay polygon[stroke="#bb9aff"]')`));
  await waitFor(`!!document.querySelector('.behavior-review')`);
  // Episódios precisos, erros de intervalo e undo auditável, sem contas externas.
  await click("Confirmar episódio");
  await waitFor(`!!document.querySelector('.behavior-review [role="alert"]')`);
  const setField = async (selector, value, kind = "input") => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${kind === "select" ? "HTMLSelectElement" : "HTMLInputElement"}.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event(${JSON.stringify(kind === "select" ? "change" : "input")}, {bubbles:true}));
  })()`);
  await setField('[aria-label="Comportamento"]', "grooming", "select");
  await setField('[aria-label="Início do comportamento"]', .125);
  await setField('[aria-label="Fim do comportamento"]', 2.25);
  await click("Confirmar episódio");
  await waitFor(`document.querySelector('.behavior-summary').textContent.includes('Grooming · 1 episódio(s) · 2.13 s')`);
  await click("Desfazer");
  await waitFor(`document.querySelector('.behavior-summary').textContent.includes('Grooming · não anotado')`);
  for (const label of ["rearing", "grooming", "freezing"]) {
    await setField('[aria-label="Comportamento"]', label, "select");
    await click("Confirmar episódio");
    await waitFor(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.filter(e => e.type === 'ANNOTATE_BEHAVIOR' && e.label === ${JSON.stringify(label)}).length >= 1`);
  }
  await click("Bruto");
  assert.ok(await evaluate(`${button("Confirmar episódio")}.disabled`));
  await click("Revisado");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  const reviewScreen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "behavior-editor.png"), Buffer.from(reviewScreen.data, "base64"));
  await click("Ver resultados");
  await waitFor(`document.querySelectorAll('.behavior-result-grid article').length === 3`);
  assert.ok(await evaluate(`document.querySelectorAll('.behavior-result-grid article')[2].textContent.includes('1 episódio(s)')`));
  assert.ok(await evaluate(`document.querySelector('.behavior-results').textContent.includes('Revisão parcial')`));
  const resultsScreen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "behavior-results.png"), Buffer.from(resultsScreen.data, "base64"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ dualSelection: "passed", confirmation: "passed", pointerAndKeyboard: "passed", persistence: "passed", desktopAndMobile: "passed", behaviorIntervalsUndoAndResults: "passed", directory }));
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => {});
    ws.close();
  }
  if (browser.exitCode == null) browser.kill();
}
