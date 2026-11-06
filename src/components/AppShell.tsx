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
import { useAppStore } from "../store/AppStore";
import {
  COLAB_STATUS_EVENT,
  emptyColabSummary,
  isTauriRuntime,
  loadColabSummary,
  type OAuthProfileSummary,
} from "../features/colab/connection";
import { BrandMark } from "./BrandMark";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/format";

function isActive(routeName: string, current: string) {
  if (routeName === "dashboard") return current === "dashboard";
  if (routeName === "experiments") return ["new-experiment", "editor", "results"].includes(current);
  return current === routeName;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { route, navigate } = useAppStore();
  const [colabSummary, setColabSummary] = useState<OAuthProfileSummary>(emptyColabSummary);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void loadColabSummary().then(setColabSummary).catch(() => undefined);
    const updateStatus = (event: Event) => {
      setColabSummary((event as CustomEvent<OAuthProfileSummary>).detail);
    };
    window.addEventListener(COLAB_STATUS_EVENT, updateStatus);
    return () => window.removeEventListener(COLAB_STATUS_EVENT, updateStatus);
  }, []);

  const navItems = [
    { id: "dashboard", label: "Visão geral", icon: LayoutDashboard, action: () => navigate({ name: "dashboard" }) },
    { id: "experiments", label: "Experimentos", icon: FlaskConical, action: () => navigate({ name: "dashboard" }) },
    { id: "colab", label: "Processamento", icon: CloudCog, action: () => navigate({ name: "colab" }) },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <BrandMark />
          <div>
            <div className="brand-name">BehaveTracker</div>
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
          <p>Dados locais e revisão auditável. A inferência remota ainda depende do gate P0.</p>
          <button onClick={() => navigate({ name: "colab" })}>
            Ver limitações <ChevronRight size={14} />
          </button>
        </div>

        <div className="sidebar-footer">
          <button><CircleHelp size={17} /> Ajuda e método</button>
          <button><Settings size={17} /> Preferências</button>
          <div className="local-profile">
            <div className="profile-avatar">GS</div>
            <div><strong>Operador local</strong><span>Dados neste dispositivo</span></div>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><BrandMark size={30} /><span>BehaveTracker</span></div>
          <div className="topbar-spacer" />
          <Badge tone="success" dot>Modo local</Badge>
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

