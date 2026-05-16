import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
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
