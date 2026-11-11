import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "models", "wistar_df_v2");
const filenames = ["best_detector.pth", "snapshot-hrnet_w32-001.pt", "pytorch_config.yaml"];

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

try {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.bundleId !== "wistar_df_v2" || manifest.keypointCount !== 27) {
    throw new Error("manifesto do modelo v2 inválido");
  }
  for (const filename of filenames) {
    const expected = manifest.files?.[filename];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error(`SHA-256 esperado ausente para ${filename}`);
    }
    const file = path.join(directory, filename);
    if (statSync(file).size !== expected.sizeBytes || await sha256(file) !== expected.sha256) {
      throw new Error(`tamanho ou SHA-256 inválido para ${filename}`);
    }
  }
  console.log("Bundle wistar_df_v2 validado para o instalador.");
} catch (error) {
  console.error(`Build interrompido: ${error.message}. Coloque os três arquivos v2 validados em models/wistar_df_v2/.`);
  process.exitCode = 1;
}
