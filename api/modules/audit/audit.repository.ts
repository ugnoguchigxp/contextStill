import { listAuditLogs } from "../../../src/modules/audit/audit-log.service.js";

export async function listAuditLogsForApi(params: {
  page: number;
  limit: number;
  eventType?: string;
  actor?: string;
}) {
  return listAuditLogs(params);
}
