import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CloudCog,
  KeyRound,
  RefreshCw,
  Save,
  UserRound,
} from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EditorTabs } from "../../components/ui/EditorTabs";
import { useAppStore, type ResearcherProfile } from "../../store/AppStore";
import {
  COLAB_PROFILE_ID,
  COLAB_STATUS_EVENT,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  publishColabSummary,
  type OAuthProfileSummary,
} from "./connection";

type ActiveAction = "load" | "connect" | "check" | null;

function errorMessage(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "A operação não pôde ser concluída.";
}

export function ColabGate() {
  const { researcherProfile, saveResearcherProfile } = useAppStore();
  const [researcher, setResearcher] = useState<ResearcherProfile>(researcherProfile);
  const [researcherNotice, setResearcherNotice] = useState<string | null>(null);
  const [settingsView, setSettingsView] = useState<"colab" | "researcher">("researcher");
  const desktopRuntime = useMemo(isTauriRuntime, []);
  const [summary, setSummary] = useState<OAuthProfileSummary>(emptyColabSummary);
  const [activeAction, setActiveAction] = useState<ActiveAction>(desktopRuntime ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function saveResearcher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!researcher.name.trim() || !researcher.laboratory.trim() || !researcher.university.trim()) {
      setResearcherNotice("Preencha nome, laboratório e universidade.");
      return;
    }
    try {
      saveResearcherProfile(researcher);
      setResearcherNotice("Dados do pesquisador salvos neste dispositivo.");
    } catch (saveError) {
      setResearcherNotice(errorMessage(saveError));
    }
  }

  useEffect(() => {
    if (!desktopRuntime) return;
    let disposed = false;
    let receivedUpdate = false;
    const updateStatus = (event: Event) => {
      receivedUpdate = true;
      const configuration = (event as CustomEvent<OAuthProfileSummary>).detail;
      setSummary(configuration);
    };
    window.addEventListener(COLAB_STATUS_EVENT, updateStatus);
    void loadColabSummary()
      .then((configuration) => {
        if (disposed || receivedUpdate) return;
        setSummary(configuration);
        publishColabSummary(configuration);
      })
      .catch((loadError) => !disposed && setError(errorMessage(loadError)))
      .finally(() => !disposed && setActiveAction(null));
    return () => {
      disposed = true;
      window.removeEventListener(COLAB_STATUS_EVENT, updateStatus);
    };
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
      setNotice(successMessage);
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      void loadColabSummary().then((configuration) => {
        setSummary(configuration);
        publishColabSummary(configuration);
      }).catch(() => undefined);
      return false;
    } finally {
      setActiveAction(null);
    }
  }

  const headingBadge = summary.connected
    ? <Badge tone="success" dot>Conta conectada</Badge>
    : <Badge tone="info" dot>Conectar conta Google</Badge>;

  return (
    <div className="page narrow-page settings-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow">Conta e processamento remoto</div>
          <h1>Configurações</h1>
          <p>Identifique o pesquisador e gerencie a conta Google usada no Colab.</p>
        </div>
        {headingBadge}
      </section>

      {!desktopRuntime && (
        <div className="colab-runtime-warning" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>Configuração disponível somente no aplicativo desktop</strong>
            <span>Feche a prévia web e execute <code>npm run tauri dev</code> para conectar a conta neste dispositivo.</span>
          </div>
        </div>
      )}

      <EditorTabs id="settings-view" label="Áreas das configurações" value={settingsView} onChange={setSettingsView}
        items={[{ id: "researcher", label: "Pesquisador" }, { id: "colab", label: "Google Colab" }]} />
      <div role="tabpanel" id="settings-view-researcher-panel" aria-labelledby="settings-view-researcher-tab" hidden={settingsView !== "researcher"}>
      <section className="panel researcher-card">
        <div className="colab-section-heading">
          <div className="colab-account-icon"><UserRound size={22} /></div>
          <div><h2>Dados do pesquisador</h2><p>Identificação salva neste dispositivo.</p></div>
        </div>
        <form className="researcher-form" onSubmit={saveResearcher}>
          <label><span>Nome completo</span><input autoComplete="name" maxLength={120} onChange={(event) => { setResearcher({ ...researcher, name: event.target.value }); setResearcherNotice(null); }} placeholder="Nome do pesquisador" required value={researcher.name} /></label>
          <label><span>Laboratório</span><input maxLength={120} onChange={(event) => { setResearcher({ ...researcher, laboratory: event.target.value }); setResearcherNotice(null); }} placeholder="Nome do laboratório" required value={researcher.laboratory} /></label>
          <label><span>Universidade</span><input maxLength={120} onChange={(event) => { setResearcher({ ...researcher, university: event.target.value }); setResearcherNotice(null); }} placeholder="Nome da universidade" required value={researcher.university} /></label>
          <div className="researcher-actions"><Button icon={<Save size={16} />} type="submit">Salvar dados</Button>{researcherNotice && <span role="status">{researcherNotice}</span>}</div>
        </form>
      </section>
      </div>

      <div role="tabpanel" id="settings-view-colab-panel" aria-labelledby="settings-view-colab-tab" hidden={settingsView !== "colab"}>
      <section className="colab-hero panel">
        <div className="colab-account-icon"><CloudCog size={25} /></div>
        <div className="colab-hero-content">
          <div className="section-title-row">
            <h2>Conexão Google Colab</h2>
            <Badge tone={summary.connected ? "success" : "neutral"}>{summary.connected ? "Conectada" : "Desconectada"}</Badge>
          </div>
          {summary.connected ? (
            <p><strong>{summary.accountEmail}</strong><br />{summary.eligibleGpuCount > 0 ? `${summary.eligibleGpuCount} opção(ões) de runtime com GPU identificada(s); a alocação depende do Colab` : "GPU ainda não confirmada para esta conta"}</p>
          ) : (
            <p>Conecte a conta Google que será usada no Colab.</p>
          )}
          {summary.providerError && <div className="provider-error"><AlertTriangle size={14} /><span>{summary.providerError}</span></div>}
          <div className="colab-account-actions">
            {!summary.connected ? (
              <>
                <Button
                  disabled={!desktopRuntime || activeAction !== null}
                  icon={<KeyRound size={17} />}
                  loading={activeAction === "connect"}
                  onClick={() => void runAction("connect", "start_google_auth", { profileId: COLAB_PROFILE_ID }, "Conta Google conectada.")}
                >
                  Conectar conta Google
                </Button>
              </>
            ) : (
              <>
                <Button
                  disabled={!desktopRuntime || activeAction !== null}
                  icon={<RefreshCw size={15} />}
                  loading={activeAction === "check"}
                  onClick={() => void runAction("check", "check_colab_eligibility", { profileId: COLAB_PROFILE_ID }, "Elegibilidade atualizada.")}
                  variant="secondary"
                >
                  Atualizar disponibilidade
                </Button>
              </>
            )}
          </div>
          {activeAction === "connect" && <p role="status">Conclua a autorização no navegador. A conexão será confirmada após salvar a sessão.</p>}
          {error && <div className="colab-feedback error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
          {notice && <div className="colab-feedback success" role="status"><Check size={15} /><span>{notice}</span></div>}
        </div>
      </section>

      </div>
    </div>
  );
}
