import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AppShell } from "./modules/admin/components/app-shell";
import { AuditLogsPage } from "./modules/admin/components/audit.page";
import { VibeMemoryPage } from "./modules/admin/components/vibe-memory.page";
import { DoctorPage } from "./modules/admin/components/doctor.page";
import { GraphPage } from "./modules/admin/components/graph.page";
import { KnowledgePage } from "./modules/admin/components/knowledge.page";
import { OverviewPage } from "./modules/admin/components/overview.page";
import { SourcesPage } from "./modules/admin/components/sources.page";
import { ContextCompilerPage } from "./modules/context-compiler/components/context-compiler.page";

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
  component: OverviewPage,
});

const compileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compile",
  component: ContextCompilerPage,
});

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  component: KnowledgePage,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesPage,
});

const vibeMemoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vibe-memory",
  component: VibeMemoryPage,
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  component: GraphPage,
});

const doctorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/doctor",
  component: DoctorPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: AuditLogsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  compileRoute,
  knowledgeRoute,
  graphRoute,
  vibeMemoryRoute,
  sourcesRoute,
  auditRoute,
  doctorRoute,
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
