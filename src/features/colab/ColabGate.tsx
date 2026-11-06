import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CloudCog,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  Unplug,
  UserRound,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import {
  COLAB_PROFILE_ID,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  publishColabSummary,
  type OAuthProfileSummary,
} from "./connection";

type ActiveAction = "load" | "save" | "connect" | "check" | "disconnect" | "delete" | null;

function errorMessage(error: unknown) {
  return typeof error === "string" ? error : "A operação não pôde ser concluída.";
}

export function ColabGate() {
  const desktopRuntime = useMemo(isTauriRuntime, []);
  const [summary, setSummary] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [activeAction, setActiveAction] = useState<ActiveAction>(desktopRuntime ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const configured = Boolean(summary.clientId && summary.hasClientSecret);
  const clientIdChanged = clientId.trim() !== summary.clientId;
  const eligibilityKnown = Boolean(summary.connected && summary.subscriptionTier && !summary.providerError);

  useEffect(() => {
    if (!desktopRuntime) return;

    void loadColabSummary()
      .then((configuration) => {
        setSummary(configuration);
        setClientId(configuration.clientId);
        publishColabSummary(configuration);
      })
      .catch((loadError) => setError(errorMessage(loadError)))
      .finally(() => setActiveAction(null));
  }, [desktopRuntime]);

  async function runAction(
    action: Exclude<ActiveAction, "load" | null>,
    command: string,
    args: Record<string, unknown>,
    successMessage: string,
  ) {
    setActiveAction(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await invoke<OAuthProfileSummary>(command, args);
      setSummary(updated);
      publishColabSummary(updated);
      setClientId(updated.clientId);
      setClientSecret("");
      setNotice(successMessage);
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setActiveAction(null);
    }
  }

  function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction(
      "save",
      "save_google_oauth_config",
      {
        profileId: COLAB_PROFILE_ID,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || null,
      },
      "Credenciais salvas para este perfil local.",
    );
  }

  async function deleteConfiguration() {
    if (!window.confirm("Remover o Client ID, o segredo e a autorização Google deste perfil?")) return;
    setActiveAction("delete");
    setError(null);
    setNotice(null);
    try {
      await invoke("delete_google_oauth_config", { profileId: COLAB_PROFILE_ID });
      setSummary(emptyColabSummary);
      publishColabSummary(emptyColabSummary);
      setClientId("");
      setClientSecret("");
      setNotice("Configuração OAuth removida deste perfil local.");
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setActiveAction(null);
    }
  }

  const headingBadge = summary.connected
    ? <Badge tone="success" dot>Conta conectada</Badge>
    : configured
      ? <Badge tone="info" dot>Credenciais salvas</Badge>
      : <Badge tone="warning" dot>Configuração necessária</Badge>;

  return (
    <div className="page narrow-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Processamento remoto</div>
          <h1>Google Colab</h1>
          <p>Configure o OAuth do projeto Google e valide a elegibilidade desta conta.</p>
        </div>
        {headingBadge}
      </section>

      {!desktopRuntime && (
        <div className="colab-runtime-warning" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>Configuração disponível somente no aplicativo desktop</strong>
            <span>Feche a prévia web e execute <code>npm run tauri dev</code> para acessar SQLite e Keychain.</span>
          </div>
        </div>
      )}

      <section className="colab-config panel">
        <div className="colab-config-heading">
          <div className="colab-hero-icon"><CloudCog size={32} /></div>
          <div>
            <div className="section-title-row"><h2>Credenciais OAuth</h2><Badge>Perfil local</Badge></div>
            <p>Use um cliente OAuth 2.0 do tipo <strong>Desktop app</strong> criado no Google Cloud.</p>
          </div>
        </div>

        <form className="colab-credentials-form" onSubmit={saveCredentials}>
          <label>
            <span>Client ID <b>*</b></span>
            <input
              autoComplete="off"
              disabled={!desktopRuntime || activeAction !== null}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="000000000000-abc.apps.googleusercontent.com"
              spellCheck={false}
              value={clientId}
            />
          </label>
          <label>
            <span>Client secret <b>*</b></span>
            <div className="secret-input">
              <input
                autoComplete="new-password"
                disabled={!desktopRuntime || activeAction !== null}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={summary.hasClientSecret ? "Salvo — deixe vazio para manter" : "Cole o Client secret"}
                spellCheck={false}
                type={showSecret ? "text" : "password"}
                value={clientSecret}
              />
              <button
                aria-label={showSecret ? "Ocultar Client secret" : "Mostrar Client secret"}
                disabled={!clientSecret}
                onClick={() => setShowSecret((visible) => !visible)}
                type="button"
              >
                {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>

          <div className="credential-storage-note">
            <Database size={15} />
            <span><strong>Client ID, Client secret e autorização</strong> ficam no SQLite deste perfil local. O app não acessa o Keychain durante a análise.</span>
          </div>

          <div className="credential-actions">
            <Button
              disabled={!desktopRuntime || !clientId.trim() || (!clientSecret.trim() && (!summary.hasClientSecret || clientIdChanged))}
              icon={<Save size={16} />}
              loading={activeAction === "save"}
              type="submit"
            >
              Salvar credenciais
            </Button>
            {configured && (
              <Button
                disabled={!desktopRuntime || activeAction !== null}
                icon={<Trash2 size={15} />}
                onClick={() => void deleteConfiguration()}
                variant="ghost"
                type="button"
              >
                Remover configuração
              </Button>
            )}
          </div>
        </form>

        {error && <div className="colab-feedback error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
        {notice && <div className="colab-feedback success" role="status"><Check size={15} /><span>{notice}</span></div>}
      </section>

      <section className="colab-hero panel">
        <div className="colab-account-icon"><UserRound size={25} /></div>
        <div className="colab-hero-content">
          <div className="section-title-row">
            <h2>{summary.connected ? summary.accountEmail : "Conta Google não conectada"}</h2>
            <Badge tone={summary.connected ? "success" : "neutral"}>{summary.connected ? "Conectada" : "Desconectada"}</Badge>
          </div>
          {summary.connected ? (
            <div className="colab-account-stats">
              <span><small>Assinatura</small><strong>{summary.subscriptionTier ?? "Não consultada"}</strong></span>
              <span><small>Runtimes elegíveis</small><strong>{summary.eligibleRuntimeCount}</strong></span>
              <span><small>Com GPU</small><strong>{summary.eligibleGpuCount}</strong></span>
            </div>
          ) : (
            <p>Salve as credenciais e autorize o BehaveTracker no navegador. A senha da sua Conta Google nunca passa pelo aplicativo.</p>
          )}
          {summary.providerError && <div className="provider-error"><AlertTriangle size={14} /><span>{summary.providerError}</span></div>}
          <div className="colab-account-actions">
            {!summary.connected ? (
              <Button
                disabled={!desktopRuntime || !configured || activeAction !== null}
                icon={<KeyRound size={17} />}
                loading={activeAction === "connect"}
                onClick={() => void runAction("connect", "start_google_auth", { profileId: COLAB_PROFILE_ID }, "Conta Google conectada.")}
              >
                Conectar conta Google
              </Button>
            ) : (
              <>
                <Button
                  disabled={!desktopRuntime || activeAction !== null}
                  icon={<RefreshCw size={15} />}
                  loading={activeAction === "check"}
                  onClick={() => void runAction("check", "check_colab_eligibility", { profileId: COLAB_PROFILE_ID }, "Elegibilidade atualizada.")}
                  variant="secondary"
                >
                  Verificar elegibilidade
                </Button>
                <Button
                  disabled={!desktopRuntime || activeAction !== null}
                  icon={<Unplug size={15} />}
                  loading={activeAction === "disconnect"}
                  onClick={() => void runAction("disconnect", "disconnect_google_account", { profileId: COLAB_PROFILE_ID }, "Conta Google desconectada.")}
                  variant="ghost"
                >
                  Desconectar
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="colab-grid">
        <section className="panel readiness-card">
          <div className="panel-header compact"><div><h2>Checklist de habilitação</h2><p>Nenhum item é presumido pelo aplicativo.</p></div></div>
          <ul className="readiness-list">
            <li className="done"><Check size={15} /><div><strong>Editor local</strong><span>Disponível sem conta Google</span></div></li>
            <li className={summary.connected ? "done" : undefined}>{summary.connected ? <Check size={15} /> : <LockKeyhole size={15} />}<div><strong>OAuth 2.0 + PKCE</strong><span>{summary.connected ? "Autorização persistente no Keychain" : configured ? "Credenciais prontas para autorização" : "Cliente ainda não configurado"}</span></div></li>
            <li className={eligibilityKnown ? "done" : undefined}>{eligibilityKnown ? <Check size={15} /> : <Cpu size={15} />}<div><strong>Elegibilidade da conta</strong><span>{eligibilityKnown ? `${summary.eligibleRuntimeCount} runtime(s) elegível(is) consultado(s)` : "Subscription e runtime specs ainda não confirmados"}</span></div></li>
            <li><ShieldAlert size={15} /><div><strong>Permissão de uso</strong><span>Execução externa e cenário Free ainda exigem o gate P0</span></div></li>
          </ul>
        </section>

        <section className="panel provider-card">
          <div className="provider-card-top"><AlertTriangle size={20} /><Badge tone="warning">Importante</Badge></div>
          <h2>Gratuidade não é uma garantia</h2>
          <p>
            Uma spec elegível não garante GPU nem alocação. O modo Free também pode restringir interfaces externas.
            O BehaveTracker deve bloquear com motivo claro em vez de contornar cotas ou iniciar cobrança.
          </p>
          <a href="https://research.google.com/colaboratory/faq.html" target="_blank" rel="noreferrer">
            Consultar FAQ oficial <ExternalLink size={14} />
          </a>
        </section>
      </div>

      <section className="panel local-capabilities">
        <div><h2>O que funciona sem Colab</h2><p>O núcleo científico permanece local e independente do provedor.</p></div>
        <div className="capability-pills">
          <span>Calibração da arena</span><span>Importação CSV</span><span>Timeline de QC</span>
          <span>Correções manuais</span><span>Métricas OFT</span><span>Exportações</span>
        </div>
      </section>
    </div>
  );
}
