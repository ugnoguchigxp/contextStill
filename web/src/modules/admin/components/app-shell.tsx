import { Link, Outlet, useRouterState } from "@tanstack/react-router";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/compile", label: "Compile" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/graph", label: "Graph" },
  { to: "/vibe-memory", label: "Vibe Memory" },
  { to: "/sources", label: "Sources" },
  { to: "/candidates", label: "Candidates" },
  { to: "/audit", label: "Audit" },
  { to: "/doctor", label: "Doctor" },
] as const;

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="brand-block">
          <span className="brand-title">memory-router</span>
          <span className="brand-subtitle">Context Compiler Control Plane</span>
        </div>
        <nav className="nav-links" aria-label="main navigation">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-link ${pathname === item.to ? "active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main
        className={`app-content ${
          pathname.startsWith("/compile") ||
          pathname.startsWith("/vibe-memory") ||
          pathname.startsWith("/sources") ||
          pathname.startsWith("/graph") ||
          pathname.startsWith("/knowledge") ||
          pathname.startsWith("/candidates") ||
          pathname.startsWith("/audit")
            ? "full-width"
            : ""
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
