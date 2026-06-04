import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  type DeadZoneKnowledgeMaintenanceAction,
  type DeadZoneKnowledgeReviewBadge,
  type DeadZoneKnowledgeReviewReason,
  type DeadZoneKnowledgeReviewSortBy,
  fetchDeadZoneKnowledgeReview,
  maintainDeadZoneKnowledge,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { DeadZoneReviewPanel } from "./deadzone-review-panel";

const badgeOptions: Array<DeadZoneKnowledgeReviewBadge | "all"> = [
  "all",
  "Strong merge candidate",
  "Canonical candidate",
  "Likely duplicate",
  "Scope differs",
  "Evidence thin",
  "Stale",
  "Niche but valid",
  "Needs embedding",
  "Similarity unavailable",
];

export function LandscapePage() {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<DeadZoneKnowledgeReviewReason>("all");
  const [badge, setBadge] = useState<DeadZoneKnowledgeReviewBadge | "all">("all");
  const [minSimilarity, setMinSimilarity] = useState(0.9);
  const [sortBy, setSortBy] = useState<DeadZoneKnowledgeReviewSortBy>("deadZoneScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [actionError, setActionError] = useState<string | null>(null);

  const resetToFirstPage = () => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  };

  const updateSort = (nextSortBy: DeadZoneKnowledgeReviewSortBy) => {
    setSortBy((current) => {
      if (current === nextSortBy) {
        setSortDir((currentDir) => (currentDir === "asc" ? "desc" : "asc"));
        return current;
      }
      setSortDir(nextSortBy === "title" ? "asc" : "desc");
      return nextSortBy;
    });
    resetToFirstPage();
  };

  const deadZoneKnowledgeReview = useQuery({
    queryKey: [
      "landscape-dead-zone-knowledge",
      30,
      pagination.pageSize,
      pagination.pageIndex + 1,
      reason,
      badge,
      minSimilarity,
      sortBy,
      sortDir,
    ],
    queryFn: () =>
      fetchDeadZoneKnowledgeReview({
        windowDays: 30,
        limit: pagination.pageSize,
        page: pagination.pageIndex + 1,
        status: "active",
        reason,
        minSimilarity,
        similarTopK: 5,
        relationAxes: ["session", "project", "source"],
        badge,
        sortBy,
        sortDir,
      }),
    staleTime: 60_000,
  });

  const items = deadZoneKnowledgeReview.data?.items ?? [];
  const total = deadZoneKnowledgeReview.data?.itemCount ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const currentPage = pagination.pageIndex + 1;
  const pageStart = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(pagination.pageIndex * pagination.pageSize + items.length, total);

  useEffect(() => {
    setPagination((current) => {
      const maxPageIndex = Math.max(0, totalPages - 1);
      return current.pageIndex > maxPageIndex ? { ...current, pageIndex: maxPageIndex } : current;
    });
  }, [totalPages]);

  const maintenance = useMutation({
    mutationFn: (input: {
      action: DeadZoneKnowledgeMaintenanceAction;
      deadZoneKnowledgeId: string;
      similarKnowledgeId?: string;
    }) => maintainDeadZoneKnowledge(input),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["landscape-dead-zone-knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const summaryItems = useMemo(
    () => [
      `Showing ${pageStart} to ${pageEnd} of ${total} items | Page ${currentPage} / ${totalPages}`,
    ],
    [currentPage, pageEnd, pageStart, total, totalPages],
  );

  return (
    <div className="landscape-page">
      <AdminPageHeader
        title="Landscape"
        checkedAtText={deadZoneKnowledgeReview.data?.generatedAt ?? undefined}
        refreshDisabled={deadZoneKnowledgeReview.isFetching}
        onRefresh={() => void deadZoneKnowledgeReview.refetch()}
        status={deadZoneKnowledgeReview.error ? "failed" : "ok"}
        statusLabel={deadZoneKnowledgeReview.error ? "load failed" : "DeadZone review"}
      />

      <section className="landscape-toolbar">
        <div className="landscape-toolbar-group">
          <label>
            Reason
            <Select
              value={reason}
              onChange={(event) => {
                setReason(event.target.value as DeadZoneKnowledgeReviewReason);
                resetToFirstPage();
              }}
            >
              <option value="all">all reasons</option>
              <option value="dead_zone_reachability_risk">reachability risk</option>
              <option value="dead_zone_stale">stale</option>
            </Select>
          </label>
          <label>
            Badge
            <Select
              value={badge}
              onChange={(event) => {
                setBadge(event.target.value as DeadZoneKnowledgeReviewBadge | "all");
                resetToFirstPage();
              }}
            >
              {badgeOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "all badges" : option}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Similarity
            <Select
              value={String(minSimilarity)}
              onChange={(event) => {
                setMinSimilarity(Number(event.target.value));
                resetToFirstPage();
              }}
            >
              <option value="0.95">0.95+</option>
              <option value="0.9">0.90+</option>
              <option value="0.85">0.85+</option>
            </Select>
          </label>
        </div>
      </section>

      <section className="landscape-content">
        <div className="landscape-list-header">
          <div>
            <h2>DeadZone Score Queue</h2>
          </div>
          <div className="landscape-list-badges">
            {actionError ? <span className="landscape-action-error">{actionError}</span> : null}
          </div>
        </div>
        <DeadZoneReviewPanel
          data={deadZoneKnowledgeReview.data}
          isLoading={deadZoneKnowledgeReview.isLoading}
          errorMessage={
            deadZoneKnowledgeReview.error instanceof Error
              ? deadZoneKnowledgeReview.error.message
              : null
          }
          sortBy={sortBy}
          sortDir={sortDir}
          onSortChange={updateSort}
          actionPending={maintenance.isPending}
          onMaintenanceAction={(input) => maintenance.mutate(input)}
        />
        <AdminPaginationFooter
          keyPrefix="landscape-deadzone"
          currentPage={currentPage}
          totalPages={totalPages}
          canPreviousPage={pagination.pageIndex > 0}
          canNextPage={currentPage < totalPages}
          onPreviousPage={() =>
            setPagination((current) => ({
              ...current,
              pageIndex: Math.max(0, current.pageIndex - 1),
            }))
          }
          onNextPage={() =>
            setPagination((current) => ({
              ...current,
              pageIndex: Math.min(totalPages - 1, current.pageIndex + 1),
            }))
          }
          onPageSelect={(pageNumber) =>
            setPagination((current) => ({ ...current, pageIndex: pageNumber - 1 }))
          }
          summaryItems={summaryItems}
        />
        <div className="landscape-footer-actions">
          <Button variant="outline" onClick={() => void deadZoneKnowledgeReview.refetch()}>
            Refresh DeadZone Queue
          </Button>
        </div>
      </section>
    </div>
  );
}
