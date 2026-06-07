import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "./modules/admin/components/app-shell";

type RouterContext = {
  queryClient: QueryClient;
};

const queryClient = new QueryClient();

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/overview.page"),
    "OverviewPage",
  ),
});

const compileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compile",
  component: lazyRouteComponent(
    () => import("./modules/context-compiler/components/context-compiler.page"),
    "ContextCompilerPage",
  ),
});

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/knowledge.page"),
    "KnowledgePage",
  ),
});

const candidatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/candidates",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/candidates.page"),
    "CandidatesPage",
  ),
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: lazyRouteComponent(() => import("./modules/admin/components/queue.page"), "QueuePage"),
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/sources.page"),
    "SourcesPage",
  ),
});

const vibeMemoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vibe-memory",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/vibe-memory.page"),
    "VibeMemoryPage",
  ),
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  component: lazyRouteComponent(() => import("./modules/admin/components/graph.page"), "GraphPage"),
});

const landscapeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/landscape",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/landscape.page"),
    "LandscapePage",
  ),
});

const doctorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/doctor",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/doctor.page"),
    "DoctorPage",
  ),
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/audit.page"),
    "AuditLogsPage",
  ),
});

const settingsSections = new Set([
  "general",
  "llmprovider",
  "taskrouting",
  "search",
  "embedding",
  "distillation-runtime",
  "advanced",
]);

const settingsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setting",
  beforeLoad: () => {
    throw redirect({
      to: "/setting/$section",
      params: { section: "general" },
      replace: true,
    });
  },
});

const legacySettingsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({
      to: "/setting/$section",
      params: { section: "general" },
      replace: true,
    });
  },
});

const legacySettingsSectionRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/setting/$section",
      params: { section: settingsSections.has(params.section) ? params.section : "general" },
      replace: true,
    });
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setting/$section",
  beforeLoad: ({ params }) => {
    if (!settingsSections.has(params.section)) {
      throw redirect({
        to: "/setting/$section",
        params: { section: "llmprovider" },
        replace: true,
      });
    }
  },
  component: lazyRouteComponent(
    () => import("./modules/admin/components/settings.page"),
    "SettingsPage",
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  compileRoute,
  candidatesRoute,
  queueRoute,
  knowledgeRoute,
  landscapeRoute,
  graphRoute,
  vibeMemoryRoute,
  sourcesRoute,
  auditRoute,
  doctorRoute,
  settingsRedirectRoute,
  legacySettingsRedirectRoute,
  legacySettingsSectionRedirectRoute,
  settingsRoute,
]);

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  );
}
