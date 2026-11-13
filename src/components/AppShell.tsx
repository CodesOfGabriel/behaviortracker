import {
  Activity,
  Beaker,
  ChevronRight,
  CircleHelp,
  CloudCog,
  FlaskConical,
  LayoutDashboard,
  Plus,
  Settings,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/AppStore";
import {
  COLAB_STATUS_EVENT,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  publishColabSummary,
  type OAuthProfileSummary,
} from "../features/colab/connection";
import { BrandMark } from "./BrandMark";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/format";

function isActive(routeName: string, current: string) {
  if (routeName === "dashboard") return current === "dashboard";
  if (routeName === "experiments") return ["new-experiment", "results"].includes(current);
  return current === routeName;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { route, navigate, researcherProfile } = useAppStore();
  const researcherInitials = researcherProfile.name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "P";
  const [colabSummary, setColabSummary] = useState<OAuthProfileSummary>(emptyColabSummary);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let revision = 0;
    const updateStatus = (event: Event) => {
      revision += 1;
      setColabSummary((event as CustomEvent<OAuthProfileSummary>).detail);
    };
    window.addEventListener(COLAB_STATUS_EVENT, updateStatus);
    const refresh = () => {
      const requestRevision = ++revision;
      void loadColabSummary().then((summary) => {
        if (!disposed && revision === requestRevision) publishColabSummary(summary);
      }).catch(() => undefined);
    };
    const unlisten = listen<OAuthProfileSummary>("google-oauth-status", ({ payload }) => {
      if (!disposed) publishColabSummary(payload);
    }).catch(() => undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener(COLAB_STATUS_EVENT, updateStatus);
      window.removeEventListener("focus", refresh);
      void unlisten.then((stop) => stop?.());
    };
  }, []);

  const navItems = [
    { id: "dashboard", label: "Visão geral", icon: LayoutDashboard, action: () => navigate({ name: "dashboard" }) },
    { id: "experiments", label: "Experimentos", icon: FlaskConical, action: () => navigate({ name: "dashboard" }) },
    { id: "colab", label: "Processamento", icon: CloudCog, action: () => navigate({ name: "colab" }) },
    { id: "about", label: "Sobre", icon: CircleHelp, action: () => navigate({ name: "about" }) },
  ];

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
            return (
              <button
                key={item.id}
                onClick={item.action}
                className={cn("nav-item", isActive(item.id, route.name) && "nav-item-active")}
                aria-label={item.label}
                aria-current={isActive(item.id, route.name) ? "page" : undefined}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "colab" && (
                  <span
                    className={cn("nav-status-dot", colabSummary.connected && "connected")}
                    title={colabSummary.connected ? `Conectado: ${colabSummary.accountEmail}` : "Não conectado"}
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-card">
          <div className="sidebar-card-icon"><Beaker size={17} /></div>
          <div className="sidebar-card-title">MVP científico</div>
          <p>Analise no Colab com A100/H100 e revise os pontos antes de interpretar as métricas.</p>
          <button onClick={() => navigate({ name: "colab" })}>
            Configurar Colab <ChevronRight size={14} />
          </button>
        </div>

        <div className="sidebar-footer">
          <button><Settings size={17} /> Preferências</button>
          <div className="local-profile">
            <div className="profile-avatar">{researcherInitials}</div>
            <div title={researcherProfile.university}><strong>{researcherProfile.name || "Pesquisador local"}</strong><span>{researcherProfile.laboratory || "Dados neste dispositivo"}</span></div>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><BrandMark size={30} /><span>Behavior Tracker</span></div>
          <div className="topbar-brand">Behavior Tracker</div>
          <div className="topbar-spacer" />
          <Badge tone="success" dot>Dados locais</Badge>
          <div className="topbar-divider" />
          <button
            className={cn("colab-chip", colabSummary.connected && "colab-chip-connected")}
            onClick={() => navigate({ name: "colab" })}
            title={colabSummary.accountEmail ?? undefined}
          >
            <Activity size={15} /> {colabSummary.connected ? "Colab conectado" : "Colab não conectado"}
          </button>
          <button className="topbar-new" onClick={() => navigate({ name: "new-experiment" })}>
            <Plus size={17} /> Novo experimento
          </button>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

