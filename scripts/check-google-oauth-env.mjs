import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared by the CI preflight and local development. Never log credential values.
export function validateGoogleOAuthEnvironment(env) {
  const clientId = env.BEHAVETRACKER_GOOGLE_CLIENT_ID ?? "";
  const clientSecret = env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET ?? "";
  const suffix = ".apps.googleusercontent.com";
  if (Buffer.byteLength(clientId) > 512 || clientId.length <= suffix.length
      || !clientId.endsWith(suffix) || /\s/u.test(clientId)) {
    throw new Error("BEHAVETRACKER_GOOGLE_CLIENT_ID ausente ou inválido.");
  }
  if (!clientSecret.trim() || clientSecret !== clientSecret.trim()
      || Buffer.byteLength(clientSecret) > 2048 || /[\r\n]/u.test(clientSecret)) {
    throw new Error("BEHAVETRACKER_GOOGLE_CLIENT_SECRET ausente ou inválido.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateGoogleOAuthEnvironment(process.env);
    console.log("Credenciais Google do build verificadas; valores omitidos.");
  } catch (error) {
    console.error(`${error.message} Configure as credenciais do repositório antes de gerar instaladores.`);
    process.exitCode = 1;
  }
}
