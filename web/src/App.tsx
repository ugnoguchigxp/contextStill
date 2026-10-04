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

const manualResearchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/research",
  component: lazyRouteComponent(
    () => import("./modules/manual-research/manual-research.page"),
    "ManualResearchPage",
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

const episodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/episodes",
  component: lazyRouteComponent(
    () => import("./modules/admin/components/episodes.page"),
    "EpisodesPage",
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

export const settingsSections = new Set([
  "general",
  "connections",
  "assignments",
  "execution",
  "retrieval",
  "advanced",
]);
export const legacySettingsSections: Record<string, string> = {
  llmprovider: "connections",
  llmpool: "execution",
  taskrouting: "assignments",
  "distillation-runtime": "assignments",
  search: "retrieval",
  embedding: "retrieval",
};
export const legacySettingsAnchors: Record<string, string> = {
  llmpool: "providerPools",
  search: "search",
  embedding: "embedding",
};
export function canonicalSettingsSection(section: string): string {
  return settingsSections.has(section) ? section : (legacySettingsSections[section] ?? "general");
}

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
      params: { section: canonicalSettingsSection(params.section) },
      hash: legacySettingsAnchors[params.section],
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
        params: { section: canonicalSettingsSection(params.section) },
        hash: legacySettingsAnchors[params.section],
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
  manualResearchRoute,
  landscapeRoute,
  graphRoute,
  vibeMemoryRoute,
  episodesRoute,
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
