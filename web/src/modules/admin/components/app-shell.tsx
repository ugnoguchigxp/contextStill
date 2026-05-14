import { Link, Outlet, useRouterState } from "@tanstack/react-router";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/compile", label: "Compile" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/sources", label: "Sources" },
  { to: "/code", label: "Code" },
  { to: "/graph", label: "Graph" },
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
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
