import { Activity, CircleHelp, FlaskConical, LayoutDashboard, LogOut, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../store/AppStore";
import { BrandMark } from "./BrandMark";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/format";

function isActive(routeName: string, current: string) {
  if (routeName === "dashboard") return current === "dashboard";
  if (routeName === "experiments") return ["new-experiment", "results"].includes(current);
  return current === routeName;
}

export function AppShell({ children, accountEmail, onLogout }: {
  children: ReactNode;
  accountEmail: string | null;
  onLogout: () => Promise<void>;
}) {
  const { route, navigate, analysisActivity } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName = accountEmail || "Pesquisador";
  const researcherInitials = displayName.trim().split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "P";
  const runningCount = Object.values(analysisActivity).filter((activity) => activity.starting).length;

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
    { id: "experiments", label: "Experimentos", icon: FlaskConical, action: () => navigate({ name: "dashboard" }) },
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
              ? `${item.label} · ${runningCount} ${runningCount === 1 ? "análise em execução" : "análises em execução"}`
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
