import { z } from "zod";

const jobStates = [
	"queued",
	"running",
	"retry_wait",
	"cancel_requested",
	"completed",
	"failed",
	"cancelled",
	"expired",
	"interrupted",
	"outcome_unknown",
] as const;
export type JobState = (typeof jobStates)[number];
export const openStates: readonly JobState[] = [
	"queued",
	"running",
	"retry_wait",
	"cancel_requested",
];
const lanes = ["interactive", "background"] as const;
export type Lane = (typeof lanes)[number];

export const jobSchema = z.object({
	id: z.string(),
	scope: z.string(),
	kind: z.string(),
	subjectRef: z.string().nullable(),
	parentJobId: z.string().nullable(),
	lane: z.enum(lanes),
	state: z.enum(jobStates),
	attempt: z.number().int(),
	maxAttempts: z.number().int(),
	waitReason: z.string().nullable(),
	errorCode: z.string().nullable(),
	availableAt: z.string(),
	deadlineAt: z.string().nullable(),
	cancelRequestedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	finishedAt: z.string().nullable(),
	revision: z.number().int(),
});
export type JobDto = z.infer<typeof jobSchema>;

export const jobListSchema = z.object({
	items: z.array(jobSchema),
	nextCursor: z.string().nullable(),
});
export type JobList = z.infer<typeof jobListSchema>;

export const attemptSchema = z.object({
	jobId: z.string(),
	attempt: z.number().int(),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	outcome: z.string().nullable(),
	errorCode: z.string().nullable(),
});
export type AttemptDto = z.infer<typeof attemptSchema>;

export const queueStatusSchema = z.object({
	lanes: z.record(
		z.string(),
		z.object({
			queued: z.number().int(),
			running: z.number().int(),
			failed: z.number().int(),
			oldestWaitMs: z.number().int().nullable(),
		}),
	),
	resources: z.record(
		z.string(),
		z.object({ inUse: z.number().int(), capacity: z.number().int() }),
	),
	openJobs: z.number().int(),
	lastScanAt: z.string().nullable(),
});
export type QueueStatus = z.infer<typeof queueStatusSchema>;

export const cancelBodySchema = z.object({
	reason: z.string().max(200).optional(),
});
