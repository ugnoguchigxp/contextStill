# Context Decision NightWorkers Contract

Status: implemented in ContextStill, optional integration for NightWorkers  
Created: 2026-06-09

## Boundary

NightWorkers calls the `context_decision` MCP tool. It does not own ContextStill tables, repository code, scoring logic, or fallback persistence.

ContextStill owns:

- decision persistence
- Knowledge evidence retrieval
- confidence scoring
- coverage traces
- Good / Bad feedback
- system feedback such as PR discard
- feedback effects

NightWorkers owns:

- deciding when to ask ContextStill for a decision
- obeying the returned decision
- attaching `decisionId` to branch / PR / task metadata when available

## Required Call Points

NightWorkers should call `context_decision`:

- before asking the user
- when a Blocker would stop progress
- when Todo/status remains after design docs or TodoList are consumed
- during cron-like wakeup or rerun when unfinished work remains
- before PR creation
- after test failure or review finding
- when repeated retry does not converge

## Input Mapping

Use the generic MCP input. NightWorkers-specific values go into `metadata`.

Required:

- `taskGoal`
- `decisionPoint`

Recommended:

- `proposedAction`
- `options`
- `availableRollback`
- `verificationPlan`
- `autonomyLevel: "high"` by default
- `riskBudget`
- `knowledgePolicy: "required"` for meaningful execution decisions

Metadata examples:

```json
{
  "nightWorkersTaskId": "task-id",
  "todoStatus": "unfinished",
  "blockerSummary": "tests failed after implementation",
  "branch": "codex/example",
  "prUrl": "https://github.com/org/repo/pull/123",
  "headSha": "abc123"
}
```

## Output Handling

NightWorkers should:

- continue on `execute`
- continue with revised action on `revise_and_execute`
- stop the proposed action on `reject`
- discard local work on `discard` when rollback/verification permits
- rollback on `rollback`
- ask the user only on `escalate`

The response is authoritative for the decision point. NightWorkers should not present the returned actions back to the user as a new options list.

## Feedback

Human feedback is only:

- `good`
- `bad`

NightWorkers may pass system/AI outcome feedback through `context_decision_feedback`, but PR discard is also recoverable by ContextStill through `decision:pr-discard-scan` when decision metadata strongly links to a PR.
