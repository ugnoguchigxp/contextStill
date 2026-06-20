import { Link, Outlet, useRouterState } from "@tanstack/react-router";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/sources", label: "Source" },
  { to: "/vibe-memory", label: "Vibe Memory" },
  { to: "/candidates", label: "Candidates" },
  { to: "/queue", label: "Queue" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/landscape", label: "Landscape" },
  { to: "/graph", label: "Graph" },
  { to: "/compile", label: "Compile" },
  { to: "/decision", label: "Decision" },
  { to: "/audit", label: "Audit" },
  { to: "/doctor", label: "Doctor" },
  { to: "/setting", label: "Settings" },
] as const;

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="brand-block">
          <span className="brand-title">contextStill</span>
        </div>
        <nav className="nav-links" aria-label="main navigation">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-link ${
                item.to === "/setting"
                  ? pathname.startsWith("/setting") || pathname.startsWith("/settings")
                    ? "active"
                    : ""
                  : pathname === item.to
                    ? "active"
                    : ""
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main
        className={`app-content ${
          pathname === "/" ||
          pathname.startsWith("/compile") ||
          pathname.startsWith("/decision") ||
          pathname.startsWith("/vibe-memory") ||
          pathname.startsWith("/sources") ||
          pathname.startsWith("/graph") ||
          pathname.startsWith("/landscape") ||
          pathname.startsWith("/knowledge") ||
          pathname.startsWith("/candidates") ||
          pathname.startsWith("/queue") ||
          pathname.startsWith("/audit") ||
          pathname.startsWith("/doctor") ||
          pathname.startsWith("/setting") ||
          pathname.startsWith("/settings")
            ? "full-width"
            : ""
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
