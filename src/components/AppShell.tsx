import { Activity, CircleHelp, ExternalLink, FlaskConical, LayoutDashboard, LogOut, Plus, RefreshCw, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/AppStore";
import { BrandMark } from "./BrandMark";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/format";
import { COLAB_PROFILE_ID, isTauriRuntime, publishColabSummary, type OAuthProfileSummary } from "../features/colab/connection";
import type { AppRoute } from "../types";

const COLAB_HOME = "https://colab.research.google.com/";

function colabPlan(tier: string | null) {
  switch (tier) {
    case "SUBSCRIPTION_TIER_FREE": return "Colab gratuito";
    case "SUBSCRIPTION_TIER_PRO": return "Colab Pro";
    case "SUBSCRIPTION_TIER_PRO_PLUS": return "Colab Pro+";
    default: return "Plano indisponível";
  }
}

function ColabAccountIndicator({ summary }: { summary: OAuthProfileSummary }) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!summary.connected) return null;
  const plan = colabPlan(summary.subscriptionTier);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      publishColabSummary(await invoke<OAuthProfileSummary>("check_colab_eligibility", { profileId: COLAB_PROFILE_ID }));
    } catch (reason) {
      setError(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "Não foi possível atualizar o plano.");
    } finally {
      setRefreshing(false);
    }
  }

  async function openColab() {
    if (!isTauriRuntime()) {
      window.open(COLAB_HOME, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      await invoke("open_colab_home");
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "Não foi possível abrir o Colab.");
    }
  }

  return (
    <div className="topbar-colab" ref={indicatorRef}>
      <button type="button" className="topbar-colab-trigger" aria-label={`${plan}. Unidades totais e restantes indisponíveis pela API. Abrir detalhes.`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "topbar-colab-details" : undefined} onClick={() => { setOpen(value => !value); setError(null); }}>
        <span className="topbar-colab-plan">{plan}</span>
        <span className="topbar-colab-units">Total — <span aria-hidden="true">·</span> Restante —</span>
      </button>
      {open && <div className="topbar-colab-popover" id="topbar-colab-details" role="dialog" aria-label="Assinatura do Colab">
        <strong>{plan}</strong>
        <dl>
          <div><dt>Unidades totais</dt><dd>—</dd></div>
          <div><dt>Unidades restantes</dt><dd>—</dd></div>
        </dl>
        <p>A API oficial informa o plano, mas não fornece o total nem o saldo de unidades. Confira os valores atuais no Colab.</p>
        {summary.providerError && <p className="topbar-colab-error" role="alert">{summary.providerError}</p>}
        {error && <p className="topbar-colab-error" role="alert">{error}</p>}
        <div className="topbar-colab-actions">
          <button type="button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={13} className={refreshing ? "login-spinner" : undefined} /> {refreshing ? "Atualizando…" : "Atualizar plano"}</button>
          <button type="button" onClick={() => void openColab()}>Abrir Colab <ExternalLink size={13} /></button>
        </div>
      </div>}
    </div>
  );
}

export function experimentsSidebarRoute(draftPreparationActive: boolean, runningAnalysisIds: string[]): AppRoute {
  if (runningAnalysisIds.length > 0) return { name: "results", experimentId: runningAnalysisIds[0] };
  if (draftPreparationActive) return { name: "new-experiment", resumePreparation: true };
  return { name: "dashboard" };
}

function isActive(routeName: string, current: string) {
  if (routeName === "dashboard") return current === "dashboard";
  if (routeName === "experiments") return ["new-experiment", "results"].includes(current);
  return current === routeName;
}

export function AppShell({ children, colabSummary, accountEmail, onLogout }: {
  children: ReactNode;
  colabSummary: OAuthProfileSummary;
  accountEmail: string | null;
  onLogout: () => Promise<void>;
}) {
  const { route, navigate, analysisActivity, draftPreparationActive, getExperiment } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = accountEmail || "Pesquisador";
  const researcherInitials = displayName.trim().split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "P";
  const runningAnalysisIds = Object.entries(analysisActivity)
    .filter(([id, activity]) => activity.starting && getExperiment(id))
    .map(([id]) => id);
  const runningCount = runningAnalysisIds.length + Number(draftPreparationActive);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const navItems = [
    { id: "dashboard", label: "Visão geral", icon: LayoutDashboard, action: () => navigate({ name: "dashboard" }) },
    { id: "experiments", label: "Experimentos", icon: FlaskConical, action: () => navigate(experimentsSidebarRoute(draftPreparationActive, runningAnalysisIds)) },
    { id: "about", label: "Sobre", icon: CircleHelp, action: () => navigate({ name: "about" }) },
  ];

  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await onLogout();
      setMenuOpen(false);
    } catch (error) {
      setLogoutError(typeof error === "string" ? error : error instanceof Error ? error.message : "Não foi possível sair da conta.");
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <BrandMark />
          <div>
            <div className="brand-name">Behavior Tracker</div>
            <div className="brand-caption">Behavioral analysis</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Navegação principal">
          <div className="nav-section-label">Workspace</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const label = item.id === "experiments" && runningCount > 0
              ? `${item.label} · abrir ${runningAnalysisIds.length > 0 ? "análise" : "preparação do vídeo"} em andamento (${runningCount} ${runningCount === 1 ? "processo" : "processos"})`
              : item.label;
            return (
              <button
                key={item.id}
                onClick={item.action}
                className={cn("nav-item", isActive(item.id, route.name) && "nav-item-active")}
                aria-label={label}
                aria-current={isActive(item.id, route.name) ? "page" : undefined}
                title={label}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "experiments" && runningCount > 0 && <span className="nav-analysis-indicator" aria-hidden="true"><Activity size={11} strokeWidth={2.5} /></span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer" ref={menuRef}>
          <div id="profile-menu" className={cn("profile-menu", menuOpen && "profile-menu-open")} inert={!menuOpen}>
            <div className="profile-menu-identity" title={accountEmail ?? undefined}>{displayName}</div>
            <button type="button" onClick={() => { navigate({ name: "colab" }); setMenuOpen(false); }}>
              <Settings size={16} /> Configurações
            </button>
            <button type="button" onClick={() => void logout()} disabled={loggingOut}>
              <LogOut size={16} /> {loggingOut ? "Saindo…" : "Logoff"}
            </button>
            {logoutError && <p className="profile-menu-error" role="alert">{logoutError}</p>}
          </div>
          <button
            type="button"
            className={cn("profile-trigger", menuOpen && "profile-trigger-active")}
            aria-label="Abrir menu do usuário"
            aria-expanded={menuOpen}
            aria-controls="profile-menu"
            onClick={() => { setMenuOpen((open) => !open); setLogoutError(null); }}
          >
            <span className="profile-avatar">{researcherInitials}</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><BrandMark size={30} /><span>Behavior Tracker</span></div>
          <div className="topbar-brand">Behavior Tracker</div>
          <div className="topbar-spacer" />
          <ColabAccountIndicator summary={colabSummary} />
          <Badge tone="success" dot>Dados locais</Badge>
          <button className="topbar-new" onClick={() => navigate({ name: "new-experiment" })}>
            <Plus size={17} /> Novo experimento
          </button>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
