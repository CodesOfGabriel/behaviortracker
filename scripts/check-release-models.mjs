import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "models", "wistar_df_v2");
const mode = process.argv[2] ?? "--installer";
const digest = async file => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

try {
  if (!["--installer", "--local", "--remote"].includes(mode)) throw new Error("Modo esperado: --installer, --local ou --remote");
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  if (manifest.registryVersion !== "model-delivery-2" || manifest.bundleId !== "wistar_df_v2"
    || manifest.keypointCount !== 27 || manifest.releaseTag !== "models-wistar-df-v2-r1") throw new Error("Registro Wistar incompatível");
  const names = ["best_detector.pth", "snapshot-hrnet_w32-001.pt", "pytorch_config.yaml"];
  for (const filename of names) {
    const expected = manifest.files[filename];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.sizeBytes)
      || expected.sizeBytes <= 0 || (filename.endsWith(".yaml") ? expected.source !== "bundled-small-config" : expected.url !== `https://github.com/CodesOfGabriel/behaviortracker/releases/download/${manifest.releaseTag}/${filename}`)) {
      throw new Error(`Registro inválido: ${filename}`);
    }
    if (mode === "--local" || filename.endsWith(".yaml")) {
      const file = path.join(directory, filename);
      if (statSync(file).size !== expected.sizeBytes || await digest(file) !== expected.sha256) throw new Error(`Integridade local inválida: ${filename}`);
    }
    if (mode === "--remote" && expected.url) {
      // Streaming avoids holding checkpoints in memory and never writes to the source tree.
      const response = await fetch(expected.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${filename}`);
      const hash = createHash("sha256"); let received = 0;
      for await (const block of response.body) {
        received += block.length;
        if (received > expected.sizeBytes) throw new Error(`Tamanho remoto excedido: ${filename}`);
        hash.update(block);
      }
      if (received !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) throw new Error(`Integridade remota inválida: ${filename}`);
    }
  }
  const resources = Object.entries(config.bundle.resources);
  if (resources.some(([source, target]) => /\.(pth|pt|onnx)$/i.test(source) || /\.(pth|pt|onnx)$/i.test(target))) throw new Error("Checkpoint incluído no instalador");
  for (const filename of ["pytorch_config.yaml", "manifest.json"]) {
    if (!resources.some(([source]) => source.endsWith(`/wistar_df_v2/${filename}`))) throw new Error(`Recurso pequeno ausente: ${filename}`);
  }
  console.log(`Model Delivery v2 validado (${mode}); instalador sem checkpoints.`);
} catch (error) {
  console.error(`Verificação de modelos interrompida: ${error.message}`);
  process.exitCode = 1;
}
