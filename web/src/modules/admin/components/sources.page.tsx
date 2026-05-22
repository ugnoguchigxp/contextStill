import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Home,
  Monitor,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import mermaid from "mermaid";
import type { ComponentProps, DragEvent, ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  type SourceFolderItem,
  type SourceTreeItem,
  createSourceFolder,
  createSourcePage,
  deleteSourceFolder,
  deleteSourcePage,
  fetchSourceDiff,
  fetchSourceHealth,
  fetchSourceHistory,
  fetchSourcePage,
  fetchSourceTree,
  renameSourceFolder,
  runSourceReindex,
  searchSourcePages,
  updateSourcePage,
} from "../repositories/admin.repository";

const initialBody = "# New Page\n\nWrite your documentation here.\n";
const dragMimeType = "application/x-wiki-explorer-node";

const trimSlug = (slug: string): string =>
  slug
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/")
    .trim();

const joinSlug = (...parts: Array<string | null | undefined>): string =>
  trimSlug(parts.filter((part): part is string => Boolean(part?.trim())).join("/"));

const parentPathOf = (value: string): string => {
  const normalized = trimSlug(value);
  if (!normalized.includes("/")) {
    return "";
  }
  return normalized.split("/").slice(0, -1).join("/");
};

const baseNameOf = (value: string, fallback = "index"): string => {
  const normalized = trimSlug(value);
  if (!normalized) {
    return fallback;
  }
  return normalized.split("/").at(-1) ?? fallback;
};

const pageParentFromPath = (filePath: string): string => parentPathOf(filePath);

const pageNameFromPath = (filePath: string): string => {
  const name = filePath.split("/").at(-1) ?? filePath;
  return name.replace(/\.md$/i, "") || "index";
};

const resolveSiblingPath = (currentPath: string, input: string): string => {
  const normalizedInput = trimSlug(input);
  if (normalizedInput.includes("/")) {
    return normalizedInput;
  }
  return joinSlug(parentPathOf(currentPath), normalizedInput);
};

const shortCommit = (commit: string): string => commit.slice(0, 7);

const formatDate = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const editableMetaKeys = new Set(["title", "showOnMenu", "showOnHome", "sort", "tags"]);
const noop = (): void => {};

const parseMetaBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const integerPattern = /^-?\d+$/;

const parseMetaSort = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (integerPattern.test(trimmed)) {
      return String(Number.parseInt(trimmed, 10));
    }
  }
  return "0";
};

const parseMetaTags = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
      .join(", ");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join(", ");
  }
  return "";
};

const preserveCustomMeta = (meta: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(meta).filter(([key]) => !editableMetaKeys.has(key)));

const parseTagsInput = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 50);

type ExplorerNode =
  | {
      kind: "folder";
      id: string;
      path: string;
      name: string;
      children: ExplorerNode[];
    }
  | {
      kind: "page";
      id: string;
      slug: string;
      path: string;
      name: string;
      title: string;
      children: [];
    };

type DragPayload = { kind: "folder"; path: string } | { kind: "page"; slug: string; path: string };

const sortExplorerNodes = (nodes: ExplorerNode[]): ExplorerNode[] =>
  nodes
    .map((node) =>
      node.kind === "folder" ? { ...node, children: sortExplorerNodes(node.children) } : node,
    )
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

const buildExplorerTree = (
  pages: SourceTreeItem[],
  folders: SourceFolderItem[],
): ExplorerNode[] => {
  const rootNodes: ExplorerNode[] = [];
  const folderMap = new Map<string, Extract<ExplorerNode, { kind: "folder" }>>();

  const ensureFolder = (folderPath: string): Extract<ExplorerNode, { kind: "folder" }> => {
    const normalized = trimSlug(folderPath);
    const existing = folderMap.get(normalized);
    if (existing) {
      return existing;
    }

    const node: Extract<ExplorerNode, { kind: "folder" }> = {
      kind: "folder",
      id: `folder:${normalized}`,
      path: normalized,
      name: baseNameOf(normalized, "pages"),
      children: [],
    };
    folderMap.set(normalized, node);

    const parentPath = parentPathOf(normalized);
    if (parentPath) {
      ensureFolder(parentPath).children.push(node);
    } else {
      rootNodes.push(node);
    }

    return node;
  };

  for (const folder of folders) {
    ensureFolder(folder.path);
  }

  for (const page of pages) {
    const parentPath = pageParentFromPath(page.path);
    const pageNode: ExplorerNode = {
      kind: "page",
      id: `page:${page.path}`,
      slug: page.slug,
      path: page.path,
      name: pageNameFromPath(page.path),
      title: page.title,
      children: [],
    };

    if (parentPath) {
      ensureFolder(parentPath).children.push(pageNode);
    } else {
      rootNodes.push(pageNode);
    }
  }

  return sortExplorerNodes(rootNodes);
};

const collectFolderPaths = (nodes: ExplorerNode[]): string[] =>
  nodes.flatMap((node) =>
    node.kind === "folder" ? [node.path, ...collectFolderPaths(node.children)] : [],
  );

type IconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  label: string;
  Icon: LucideIcon;
  size?: ComponentProps<typeof Button>["size"];
};

const IconButton = ({ label, Icon, size = "icon", type = "button", ...props }: IconButtonProps) => (
  <Button type={type} size={size} title={label} aria-label={label} {...props}>
    <Icon className="h-4 w-4" aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </Button>
);

mermaid.initialize({ startOnLoad: false });

export function SourcesPage() {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"view" | "edit">("edit");
  const [isCreating, setIsCreating] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const [draftSlug, setDraftSlug] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState(initialBody);
  const [draftMetaBase, setDraftMetaBase] = useState<Record<string, unknown>>({});
  const [draftShowOnMenu, setDraftShowOnMenu] = useState(true);
  const [draftShowOnHome, setDraftShowOnHome] = useState(true);
  const [draftSort, setDraftSort] = useState("0");
  const [draftTagsText, setDraftTagsText] = useState("");
  const [commitMessage, setCommitMessage] = useState("");

  const [diffFrom, setDiffFrom] = useState("");
  const [diffTo, setDiffTo] = useState("");

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchSourceHealth,
  });

  const treeQuery = useQuery({
    queryKey: ["page-tree"],
    queryFn: fetchSourceTree,
  });

  const treePages = treeQuery.data?.items ?? [];
  const treeFolders = treeQuery.data?.folders ?? [];
  const explorerNodes = useMemo(
    () => buildExplorerTree(treePages, treeFolders),
    [treePages, treeFolders],
  );
  const allFolderPaths = useMemo(() => collectFolderPaths(explorerNodes), [explorerNodes]);
  const existingSlugs = useMemo(() => new Set(treePages.map((page) => page.slug)), [treePages]);

  useEffect(() => {
    if (!isCreating && activeSlug === null && treePages.length > 0) {
      const first = treePages[0];
      if (first) {
        setActiveSlug(first.slug);
      }
    }
  }, [activeSlug, isCreating, treePages]);

  useEffect(() => {
    if (allFolderPaths.length === 0) {
      return;
    }
    setExpandedFolders((current) => {
      if (current.size > 0) {
        return current;
      }
      return new Set(allFolderPaths);
    });
  }, [allFolderPaths]);

  const pageQuery = useQuery({
    queryKey: ["page", activeSlug],
    queryFn: () => fetchSourcePage(activeSlug ?? ""),
    enabled: !isCreating && activeSlug !== null,
  });

  useEffect(() => {
    if (!pageQuery.data || isCreating) {
      return;
    }

    setDraftSlug(pageQuery.data.slug);
    setDraftTitle(pageQuery.data.title);
    setDraftBody(pageQuery.data.body);
    const meta = pageQuery.data.meta ?? {};
    setDraftMetaBase(preserveCustomMeta(meta));
    setDraftShowOnMenu(parseMetaBoolean(meta.showOnMenu, true));
    setDraftShowOnHome(parseMetaBoolean(meta.showOnHome, true));
    setDraftSort(parseMetaSort(meta.sort));
    setDraftTagsText(parseMetaTags(meta.tags));
    setCommitMessage("");
  }, [isCreating, pageQuery.data]);

  const historyQuery = useQuery({
    queryKey: ["history", activeSlug],
    queryFn: () => fetchSourceHistory(activeSlug ?? ""),
    enabled: !isCreating && activeSlug !== null,
  });

  useEffect(() => {
    if (!historyQuery.data || historyQuery.data.length < 2) {
      return;
    }
    const latest = historyQuery.data[0];
    const previous = historyQuery.data[1];

    if (!latest || !previous) {
      return;
    }
    if (!diffTo) {
      setDiffTo(latest.commit);
    }
    if (!diffFrom) {
      setDiffFrom(previous.commit);
    }
  }, [diffFrom, diffTo, historyQuery.data]);

  const searchQuery = useQuery({
    queryKey: ["search", searchText],
    queryFn: () => searchSourcePages(searchText),
    enabled: searchText.trim().length > 0,
  });

  const diffQuery = useQuery({
    queryKey: ["diff", activeSlug, diffFrom, diffTo],
    queryFn: () => fetchSourceDiff(activeSlug ?? "", diffFrom, diffTo),
    enabled: !isCreating && activeSlug !== null && diffFrom !== "" && diffTo !== "",
  });

  const refreshCoreQueries = async (slug: string | null = activeSlug) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["page-tree"] }),
      queryClient.invalidateQueries({ queryKey: ["page", slug] }),
      queryClient.invalidateQueries({ queryKey: ["history", slug] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  };

  const refreshAllContentQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["page-tree"] }),
      queryClient.invalidateQueries({ queryKey: ["page"] }),
      queryClient.invalidateQueries({ queryKey: ["history"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
  };

  const resetDraftState = () => {
    setDraftSlug("");
    setDraftTitle("");
    setDraftBody(initialBody);
    setDraftMetaBase({});
    setDraftShowOnMenu(true);
    setDraftShowOnHome(true);
    setDraftSort("0");
    setDraftTagsText("");
    setCommitMessage("");
    setDiffFrom("");
    setDiffTo("");
  };

  const createMutation = useMutation({
    mutationFn: createSourcePage,
    onSuccess: async (result) => {
      setStatusText(`Created: ${result.slug || "home"} (${shortCommit(result.commit ?? "")})`);
      setIsCreating(false);
      setSelectedFolderPath(null);
      const nextSlug = result.slug ?? null;
      setActiveSlug(nextSlug);
      await refreshCoreQueries(nextSlug);
    },
    onError: (error) => {
      setStatusText(`Create failed: ${String(error)}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      slug,
      payload,
    }: {
      slug: string;
      payload: Parameters<typeof updateSourcePage>[1];
    }) => updateSourcePage(slug, payload),
    onSuccess: async (result, variables) => {
      setStatusText(`Saved: ${result.slug || "home"} (${shortCommit(result.commit ?? "")})`);
      setIsCreating(false);
      setSelectedFolderPath(null);
      const nextSlug = result.slug ?? variables.slug;
      setActiveSlug(nextSlug);
      await Promise.all([
        refreshCoreQueries(nextSlug),
        result.slug !== variables.slug
          ? queryClient.invalidateQueries({ queryKey: ["page", variables.slug] })
          : Promise.resolve(),
        result.slug !== variables.slug
          ? queryClient.invalidateQueries({ queryKey: ["history", variables.slug] })
          : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      setStatusText(`Save failed: ${String(error)}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSourcePage,
    onSuccess: async (result, deletedSlug) => {
      setStatusText(`Deleted: ${result.slug || "home"}`);
      if (activeSlug === deletedSlug) {
        setActiveSlug(null);
        setSelectedFolderPath(null);
        setIsCreating(false);
        resetDraftState();
      }
      await refreshCoreQueries(result.slug);
    },
    onError: (error) => {
      setStatusText(`Delete failed: ${String(error)}`);
    },
  });

  const createFolderMutation = useMutation({
    mutationFn: ({ path }: { path: string }) => createSourceFolder(path),
    onSuccess: async (result) => {
      setStatusText(`Folder created: ${result.path}`);
      const createdPath = result.path ?? "";
      setSelectedFolderPath(createdPath || null);
      if (createdPath) {
        setExpandedFolders(
          (current) => new Set([...current, parentPathOf(createdPath), createdPath]),
        );
      }
      await refreshAllContentQueries();
    },
    onError: (error) => {
      setStatusText(`Folder create failed: ${String(error)}`);
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ path, payload }: { path: string; payload: { path: string } }) =>
      renameSourceFolder(path, payload.path),
    onSuccess: async (result) => {
      setStatusText(`Folder renamed: ${result.from ?? ""} -> ${result.path}`);
      const renamedPath = result.path ?? "";
      setSelectedFolderPath(renamedPath || null);
      if (renamedPath) {
        setExpandedFolders(
          (current) => new Set([...current, parentPathOf(renamedPath), renamedPath]),
        );
      }
      const activeMove = result.movedPages?.find((move) => move.from === activeSlug);
      if (activeMove) {
        setActiveSlug(activeMove.to);
      }
      await refreshAllContentQueries();
    },
    onError: (error) => {
      setStatusText(`Folder rename failed: ${String(error)}`);
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: deleteSourceFolder,
    onSuccess: async (result) => {
      setStatusText(`Folder deleted: ${result.path}`);
      if (selectedFolderPath === result.path || selectedFolderPath?.startsWith(`${result.path}/`)) {
        setSelectedFolderPath(null);
      }
      if (activeSlug && result.deletedSlugs?.includes(activeSlug)) {
        setActiveSlug(null);
        setIsCreating(false);
        resetDraftState();
      }
      await refreshAllContentQueries();
    },
    onError: (error) => {
      setStatusText(`Folder delete failed: ${String(error)}`);
    },
  });

  const reindexMutation = useMutation({
    mutationFn: runSourceReindex,
    onSuccess: async (result) => {
      setStatusText(`Reindex done: indexed=${result.indexed}, removed=${result.removed}`);
      await refreshAllContentQueries();
    },
    onError: (error) => {
      setStatusText(`Reindex failed: ${String(error)}`);
    },
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    createFolderMutation.isPending ||
    renameFolderMutation.isPending ||
    deleteFolderMutation.isPending ||
    reindexMutation.isPending;

  const metaFormError = useMemo(() => {
    if (draftSort.trim() === "") {
      return "";
    }
    if (!integerPattern.test(draftSort.trim())) {
      return "sort must be an integer";
    }
    return "";
  }, [draftSort]);

  const buildDraftMeta = (): Record<string, unknown> => ({
    ...draftMetaBase,
    showOnMenu: draftShowOnMenu,
    showOnHome: draftShowOnHome,
    sort: draftSort.trim() === "" ? 0 : Number.parseInt(draftSort, 10),
    tags: parseTagsInput(draftTagsText),
  });

  const healthText = useMemo(() => {
    if (healthQuery.isLoading) {
      return "API: loading";
    }
    if (healthQuery.isError || !healthQuery.data) {
      return "API: unavailable";
    }

    const git = healthQuery.data.git
      ? `${healthQuery.data.git.branch}@${healthQuery.data.git.commit}`
      : "no-git";
    return `API: ${healthQuery.data.app} ${healthQuery.data.version} (${git})`;
  }, [healthQuery.data, healthQuery.isError, healthQuery.isLoading]);

  const nextDraftSlug = (folderPath: string): string => {
    const baseSlug = joinSlug(folderPath, "untitled");
    if (!existingSlugs.has(baseSlug)) {
      return baseSlug;
    }
    for (let index = 2; index < 100; index += 1) {
      const candidate = joinSlug(folderPath, `untitled-${index}`);
      if (!existingSlugs.has(candidate)) {
        return candidate;
      }
    }
    return joinSlug(folderPath, `untitled-${Date.now()}`);
  };

  const targetFolderForNewItem = (): string => selectedFolderPath ?? parentPathOf(activeSlug ?? "");

  const startCreate = (folderPath = targetFolderForNewItem()) => {
    const draftPath = nextDraftSlug(folderPath);
    setIsCreating(true);
    setMode("edit");
    setActiveSlug(null);
    setSelectedFolderPath(folderPath || null);
    setDraftSlug(draftPath);
    setDraftTitle("Untitled");
    setDraftBody(initialBody);
    setDraftMetaBase({});
    setDraftShowOnMenu(true);
    setDraftShowOnHome(true);
    setDraftSort("0");
    setDraftTagsText("");
    setCommitMessage("");
    setDiffFrom("");
    setDiffTo("");
    setStatusText(`create page: ${draftPath || "home"}`);
  };

  const selectExistingPage = (slug: string) => {
    setIsCreating(false);
    setMode("view");
    setActiveSlug(slug);
    setSelectedFolderPath(null);
    setDiffFrom("");
    setDiffTo("");
    setStatusText(`selected: ${slug || "home"}`);
  };

  const selectFolder = (folderPath: string) => {
    setSelectedFolderPath(folderPath);
    setIsCreating(false);
    setStatusText(`folder: ${folderPath}`);
  };

  const handleSave = async () => {
    const normalizedSlug = trimSlug(draftSlug);

    if (!isCreating && activeSlug === null) {
      setStatusText("no page selected");
      return;
    }

    if (!draftTitle.trim()) {
      setStatusText("title is required");
      return;
    }

    if (metaFormError) {
      setStatusText(metaFormError);
      return;
    }

    const meta = buildDraftMeta();

    if (isCreating) {
      await createMutation.mutateAsync({
        slug: normalizedSlug,
        title: draftTitle.trim(),
        body: draftBody,
        meta,
      });
      return;
    }

    await updateMutation.mutateAsync({
      slug: trimSlug(activeSlug ?? ""),
      payload: {
        slug: normalizedSlug,
        title: draftTitle.trim(),
        body: draftBody,
        meta,
        commitMessage: commitMessage.trim() || undefined,
      },
    });
  };

  const deletePageBySlug = async (slug: string) => {
    const confirmed = window.confirm(`Delete page: ${slug || "home"}?`);
    if (!confirmed) {
      return;
    }
    await deleteMutation.mutateAsync(trimSlug(slug));
  };

  const handleDelete = async () => {
    if (selectedFolderPath) {
      const confirmed = window.confirm(
        `Delete folder recursively: ${selectedFolderPath}?\nAll pages inside it will be removed.`,
      );
      if (confirmed) {
        await deleteFolderMutation.mutateAsync(selectedFolderPath);
      }
      return;
    }

    if (isCreating) {
      startCreate();
      return;
    }

    if (activeSlug === null) {
      setStatusText("no page selected");
      return;
    }

    await deletePageBySlug(activeSlug);
  };

  const promptCreateFolder = async (parentPath = targetFolderForNewItem()) => {
    const suggested = joinSlug(parentPath, "new-folder");
    const input = window.prompt("Folder name or path", suggested);
    if (input === null) {
      return;
    }
    const folderPath = input.includes("/") ? trimSlug(input) : joinSlug(parentPath, input);
    if (!folderPath) {
      setStatusText("folder path is required");
      return;
    }
    await createFolderMutation.mutateAsync({ path: folderPath });
  };

  const promptRenameFolder = async (folderPath: string) => {
    const input = window.prompt("New folder name or path", folderPath);
    if (input === null) {
      return;
    }
    const targetPath = resolveSiblingPath(folderPath, input);
    if (!targetPath || targetPath === folderPath) {
      setStatusText("folder path is unchanged");
      return;
    }
    await renameFolderMutation.mutateAsync({ path: folderPath, payload: { path: targetPath } });
  };

  const pagePayloadForSlug = async (slug: string) => {
    if (slug === activeSlug && !isCreating) {
      if (metaFormError) {
        throw new Error(metaFormError);
      }
      return {
        title: draftTitle.trim() || baseNameOf(slug, "Home"),
        body: draftBody,
        meta: buildDraftMeta(),
      };
    }

    const page = await fetchSourcePage(slug);
    return {
      title: page.title,
      body: page.body,
      meta: page.meta,
    };
  };

  const renamePageToSlug = async (slug: string, targetSlug: string, commitMessageText: string) => {
    const normalizedTarget = trimSlug(targetSlug);
    if (normalizedTarget === slug) {
      setStatusText("page slug is unchanged");
      return;
    }
    const payload = await pagePayloadForSlug(slug);
    await updateMutation.mutateAsync({
      slug,
      payload: {
        slug: normalizedTarget,
        ...payload,
        commitMessage: commitMessageText,
      },
    });
  };

  const promptRenamePage = async (slug: string) => {
    const input = window.prompt("New page name or slug", slug || "index");
    if (input === null) {
      return;
    }
    const targetSlug = resolveSiblingPath(slug, input === "index" ? "" : input);
    await renamePageToSlug(slug, targetSlug, `docs(page): rename ${slug || "home"}`);
  };

  const movePageToFolder = async (slug: string, folderPath: string) => {
    const targetSlug = joinSlug(folderPath, baseNameOf(slug));
    await renamePageToSlug(
      slug,
      targetSlug,
      `docs(page): move ${slug || "home"} to ${folderPath || "root"}`,
    );
  };

  const moveFolderToFolder = async (folderPath: string, targetFolderPath: string) => {
    if (targetFolderPath === folderPath || targetFolderPath.startsWith(`${folderPath}/`)) {
      setStatusText("cannot move a folder into itself");
      return;
    }
    const targetPath = joinSlug(targetFolderPath, baseNameOf(folderPath));
    if (targetPath === folderPath) {
      setStatusText("folder path is unchanged");
      return;
    }
    await renameFolderMutation.mutateAsync({ path: folderPath, payload: { path: targetPath } });
  };

  const parseDragPayload = (event: DragEvent): DragPayload | null => {
    const raw = event.dataTransfer.getData(dragMimeType);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  };

  const handleDragStart = (event: DragEvent, payload: DragPayload) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(dragMimeType, JSON.stringify(payload));
  };

  const handleDropOnFolder = async (event: DragEvent, folderPath: string) => {
    event.preventDefault();
    setDragOverFolder(null);
    const payload = parseDragPayload(event);
    if (!payload) {
      return;
    }
    if (payload.kind === "page") {
      await movePageToFolder(payload.slug, folderPath);
      return;
    }
    await moveFolderToFolder(payload.path, folderPath);
  };

  const handleDragOverFolder = (event: DragEvent, folderPath: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverFolder(folderPath);
  };

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const selectedLabel = selectedFolderPath
    ? `folder: ${selectedFolderPath}`
    : isCreating
      ? "new page"
      : `page: ${activeSlug || "home"}`;
  const activeLabel = isCreating ? "new" : activeSlug || "home";

  const renderExplorerNode = (node: ExplorerNode, depth = 0): ReactElement => {
    if (node.kind === "folder") {
      const isExpanded = expandedFolders.has(node.path);
      const isSelected = selectedFolderPath === node.path;
      const isDropTarget = dragOverFolder === node.path;
      return (
        <div key={node.id}>
          <div
            role="treeitem"
            aria-expanded={isExpanded}
            draggable
            onDragStart={(event) => handleDragStart(event, { kind: "folder", path: node.path })}
            onDragOver={(event) => handleDragOverFolder(event, node.path)}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(event) => void handleDropOnFolder(event, node.path)}
            className={`group flex items-center gap-1 rounded-sm py-1 pr-1 text-sm ${
              isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted"
            } ${isDropTarget ? "ring-2 ring-primary" : ""}`}
            style={{ paddingLeft: depth * 14 + 6 }}
          >
            <button
              type="button"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background/80"
              onClick={() => toggleFolder(node.path)}
              aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
              title={isExpanded ? "Collapse folder" : "Expand folder"}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left font-medium"
              title={node.path}
              onClick={() => selectFolder(node.path)}
            >
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            <div className="ml-auto hidden items-center gap-1 group-hover:flex">
              <IconButton
                label={`New page in ${node.path}`}
                Icon={FilePlus2}
                variant="ghost"
                size="icon-xs"
                className="hover:bg-background"
                onClick={() => startCreate(node.path)}
                disabled={busy}
              />
              <IconButton
                label={`New folder in ${node.path}`}
                Icon={FolderPlus}
                variant="ghost"
                size="icon-xs"
                className="hover:bg-background"
                onClick={() => void promptCreateFolder(node.path)}
                disabled={busy}
              />
              <IconButton
                label={`Rename folder ${node.path}`}
                Icon={Pencil}
                variant="ghost"
                size="icon-xs"
                className="hover:bg-background"
                onClick={() => void promptRenameFolder(node.path)}
                disabled={busy}
              />
              <IconButton
                label={`Delete folder ${node.path}`}
                Icon={Trash2}
                variant="ghost"
                size="icon-xs"
                className="text-red-700 hover:bg-background"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete folder recursively: ${node.path}?\nAll pages inside it will be removed.`,
                    )
                  ) {
                    void deleteFolderMutation.mutateAsync(node.path);
                  }
                }}
                disabled={busy}
              />
            </div>
          </div>
          {isExpanded ? node.children.map((child) => renderExplorerNode(child, depth + 1)) : null}
        </div>
      );
    }

    const isActive = !isCreating && node.slug === activeSlug;
    return (
      <div
        role="treeitem"
        key={node.id}
        draggable
        onDragStart={(event) =>
          handleDragStart(event, { kind: "page", slug: node.slug, path: node.path })
        }
        className={`group flex items-center gap-1 rounded-sm py-1 pr-1 text-sm ${
          isActive ? "bg-primary/10 text-primary" : "hover:bg-muted"
        }`}
        style={{ paddingLeft: depth * 14 + 31 }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
          title={`${node.title} (${node.path})`}
          onClick={() => selectExistingPage(node.slug)}
        >
          {node.slug === "" ? (
            <Home className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="font-mono text-[12px]">{node.name}</span>
          {node.title && node.title !== node.name ? (
            <span className="ml-2 text-xs text-muted-foreground">{node.title}</span>
          ) : null}
        </button>
        <div className="ml-auto hidden items-center gap-1 group-hover:flex">
          <IconButton
            label={`Rename page ${node.slug || "home"}`}
            Icon={Pencil}
            variant="ghost"
            size="icon-xs"
            className="hover:bg-background"
            onClick={() => void promptRenamePage(node.slug)}
            disabled={busy}
          />
          <IconButton
            label={`Delete page ${node.slug || "home"}`}
            Icon={Trash2}
            variant="ghost"
            size="icon-xs"
            className="text-red-700 hover:bg-background"
            onClick={() => void deletePageBySlug(node.slug)}
            disabled={busy}
          />
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-full gap-4 px-4 py-4">
        <aside
          className="sticky top-[80px] flex h-[calc(100vh-6rem)] w-[22rem] shrink-0 flex-col rounded-md border border-border bg-card p-3"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              selectExistingPage("");
            }
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h1 className="text-sm font-semibold">Explorer</h1>
              <p className="text-xs text-muted-foreground">{selectedLabel}</p>
            </div>
            <IconButton
              label="New page"
              Icon={FilePlus2}
              variant="secondary"
              onClick={() => startCreate()}
              disabled={busy}
            />
          </div>

          <button
            type="button"
            onDragOver={(event) => handleDragOverFolder(event, "")}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(event) => void handleDropOnFolder(event, "")}
            onClick={() => selectExistingPage("")}
            className={`mb-3 flex items-center justify-center gap-2 rounded-md border border-dashed px-2 py-2 text-xs ${
              dragOverFolder === "" ? "border-primary bg-accent" : "border-border bg-muted/30"
            }`}
          >
            <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Drop to root</span>
          </button>

          <div className="mb-3 flex items-center gap-1">
            <IconButton
              label="New page"
              Icon={FilePlus2}
              variant="secondary"
              onClick={() => startCreate()}
              disabled={busy}
            />
            <IconButton
              label="New folder"
              Icon={FolderPlus}
              variant="secondary"
              onClick={() => void promptCreateFolder()}
              disabled={busy}
            />
            <IconButton
              label="Rename selected"
              Icon={Pencil}
              variant="ghost"
              onClick={() => {
                if (selectedFolderPath) {
                  void promptRenameFolder(selectedFolderPath);
                  return;
                }
                if (activeSlug !== null) {
                  void promptRenamePage(activeSlug);
                }
              }}
              disabled={busy || (!selectedFolderPath && activeSlug === null)}
            />
            <IconButton
              label="Delete selected"
              Icon={Trash2}
              variant="ghost"
              className="text-red-700"
              onClick={() => void handleDelete()}
              disabled={busy}
            />
          </div>

          <div className="mb-3">
            <div className="relative">
              <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search title/body"
                className="pl-7 text-xs"
              />
            </div>
            {searchQuery.isFetching ? (
              <p className="mt-1 text-xs text-muted-foreground">searching...</p>
            ) : null}
          </div>

          {searchText.trim() ? (
            <div className="mb-4 space-y-1 rounded-md border border-border p-2">
              <p className="text-xs font-medium text-muted-foreground">Search Results</p>
              {(searchQuery.data ?? []).map((item) => (
                <button
                  type="button"
                  key={`search-${item.slug}`}
                  className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => selectExistingPage(item.slug)}
                >
                  <div className="font-medium">{item.slug || "home"}</div>
                  <div className="line-clamp-2 text-muted-foreground">{item.excerpt}</div>
                </button>
              ))}
              {searchQuery.data && searchQuery.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">no result</p>
              ) : null}
            </div>
          ) : null}

          <div
            className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/10 p-1"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                selectExistingPage("");
              }
            }}
          >
            {explorerNodes.map((node) => renderExplorerNode(node))}
            {treeQuery.isLoading ? <div className="px-2 text-muted-foreground">loading</div> : null}
            {treeQuery.isError ? (
              <div className="px-2 text-red-600">failed to load tree</div>
            ) : null}
            {!treeQuery.isLoading && explorerNodes.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No pages yet. Create a folder or page to start.
              </div>
            ) : null}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col rounded-md border border-border bg-card p-3">
          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Slug</p>
              <Input
                value={draftSlug}
                onChange={(event) => setDraftSlug(event.target.value)}
                placeholder="engineering/onboarding"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Title</p>
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Page title"
              />
            </div>
            <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 md:col-span-2 md:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftShowOnMenu}
                  onChange={(event) => setDraftShowOnMenu(event.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                Show on menu
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftShowOnHome}
                  onChange={(event) => setDraftShowOnHome(event.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                Show on home
              </label>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Sort</p>
                <Input
                  type="number"
                  value={draftSort}
                  onChange={(event) => setDraftSort(event.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1 md:col-span-1">
                <p className="text-xs text-muted-foreground">Tags</p>
                <Input
                  value={draftTagsText}
                  onChange={(event) => setDraftTagsText(event.target.value)}
                  placeholder="engineering, onboarding"
                />
              </div>
            </div>
            {!isCreating ? (
              <div className="space-y-1 md:col-span-2">
                <p className="text-xs text-muted-foreground">Commit Message (optional)</p>
                <Input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={`docs(page): update ${activeLabel}`}
                />
              </div>
            ) : null}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <IconButton
              label="Edit"
              Icon={Edit3}
              variant={mode === "edit" ? "default" : "secondary"}
              onClick={() => setMode("edit")}
            />
            <IconButton
              label="View"
              Icon={Eye}
              variant={mode === "view" ? "default" : "secondary"}
              onClick={() => setMode("view")}
            />
            <IconButton
              label="Save"
              Icon={Save}
              onClick={() => void handleSave()}
              disabled={busy || !!metaFormError}
            />
            <IconButton
              label="Screen preview"
              Icon={Monitor}
              variant="secondary"
              onClick={() => setIsPreviewOpen(true)}
            />
            <IconButton
              label="Delete"
              Icon={Trash2}
              variant="secondary"
              onClick={() => void handleDelete()}
              disabled={busy}
            />
            <IconButton
              label="Reindex"
              Icon={RefreshCw}
              variant="ghost"
              onClick={() => void reindexMutation.mutateAsync()}
              disabled={busy}
            />
            <IconButton
              label="Refresh"
              Icon={RefreshCw}
              variant="ghost"
              onClick={() => {
                void healthQuery.refetch();
                void treeQuery.refetch();
                if (!isCreating && activeSlug !== null) {
                  void pageQuery.refetch();
                  void historyQuery.refetch();
                }
              }}
            />
          </div>

          <div className="mb-2 text-xs text-muted-foreground">{healthText}</div>
          <div className="mb-2 text-xs text-muted-foreground">page: {activeLabel}</div>
          {metaFormError ? <div className="mb-2 text-xs text-red-600">{metaFormError}</div> : null}
          {statusText ? (
            <div className="mb-2 text-xs text-muted-foreground">{statusText}</div>
          ) : null}
          {pageQuery.isLoading && !isCreating ? (
            <div className="mb-2 text-xs text-muted-foreground">loading page...</div>
          ) : null}

          <div className="h-[calc(100vh-14rem)] min-h-[500px] overflow-hidden rounded-md border border-border">
            <MarkdownEditor
              value={draftBody}
              onChange={setDraftBody}
              editable={mode === "edit"}
              toolbarMode={mode === "edit" ? "fixed" : "hidden"}
              className="h-full"
              enableVerticalScroll
              enableMermaid
              mermaidLib={mermaid}
            />
          </div>
        </section>

        <aside className="sticky top-[80px] h-[calc(100vh-6rem)] w-96 shrink-0 overflow-auto rounded-md border border-border bg-card p-3">
          <h2 className="mb-2 text-sm font-semibold">History & Diff</h2>

          <div className="mb-3 max-h-60 space-y-1 overflow-auto rounded-md border border-border p-2">
            {(historyQuery.data ?? []).map((item) => (
              <button
                type="button"
                key={item.commit}
                className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                onClick={() => setDiffTo(item.commit)}
              >
                <div className="font-mono">{item.commit.slice(0, 8)}</div>
                <div className="text-muted-foreground">{item.message}</div>
                <div className="text-muted-foreground">{item.author}</div>
                <div className="text-muted-foreground">{formatDate(item.date)}</div>
              </button>
            ))}
            {historyQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">loading history...</p>
            ) : null}
            {!historyQuery.isLoading && (historyQuery.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">no history</p>
            ) : null}
          </div>

          <div className="mb-2 space-y-1">
            <p className="text-xs text-muted-foreground">From commit</p>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={diffFrom}
              onChange={(event) => setDiffFrom(event.target.value)}
            >
              <option value="">Select commit</option>
              {(historyQuery.data ?? []).map((item) => (
                <option key={`from-${item.commit}`} value={item.commit}>
                  {shortCommit(item.commit)} {item.message}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 space-y-1">
            <p className="text-xs text-muted-foreground">To commit</p>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={diffTo}
              onChange={(event) => setDiffTo(event.target.value)}
            >
              <option value="">Select commit</option>
              {(historyQuery.data ?? []).map((item) => (
                <option key={`to-${item.commit}`} value={item.commit}>
                  {shortCommit(item.commit)} {item.message}
                </option>
              ))}
            </select>
          </div>

          <div className="h-[calc(100vh-30rem)] min-h-[220px] overflow-auto rounded-md border border-border bg-muted/30 p-2">
            <pre className="whitespace-pre-wrap break-words text-xs leading-5">
              {diffQuery.data && diffQuery.data.length > 0
                ? diffQuery.data
                : "Select two commits to view diff."}
            </pre>
          </div>
        </aside>
      </div>
      {isPreviewOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Screen Preview</h2>
            <Button type="button" variant="outline" onClick={() => setIsPreviewOpen(false)}>
              Close
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
            <div className="h-full overflow-hidden rounded-md border border-border">
              <MarkdownEditor
                value={draftBody}
                onChange={noop}
                editable={false}
                toolbarMode="hidden"
                className="h-full"
                enableVerticalScroll
                enableMermaid
                mermaidLib={mermaid}
              />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
