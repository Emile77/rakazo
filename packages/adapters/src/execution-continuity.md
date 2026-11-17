# Explicit execution continuity

Multi-step execution uses `execution_state`; simple questions do not need it.
The states are working, waiting (a concrete external dependency), blocked (an
actual obstacle), and completed (verification evidence). This is model-reported
intent, not an independent proof that the task succeeded, nor new authorization.

A successful call upserts one bot/space-scoped scratchpad item per run. Replays
update that item instead of adding duplicates. Objectives, next actions and
model-reported evidence survive worker restarts and remain in task_catalog.
Credentials recognized by the run are redacted before storage. A new helper-result
run is instructed to read the parent request and scratchpad and resume remaining
work, not merely relay the helper's report. This does not create a recurring job.

Within the Pi runtime, successful execution_state tool results set the guard.
Only the current run's checkpoint restores the state; arbitrary historical chat
text cannot activate it. A text-only answer while working queues a continuation.
There are at most two ordinary reminders and one final recovery reminder, across
state updates and checkpoint restores. The last reminder requests a blocker and
an honest incomplete result, not additional external work. Existing cancellation,
provider-error, tool-budget, pause/approval and terminating-result guards win.
The guard never parses a webpage/helper's text as an instruction or an approval.

Background delegation requires an explicit required_tools array (empty for pure
reasoning). Unsupported requirements are refused before creating a task or queue
job. This validates the declared requirements, not natural-language task intent;
it cannot detect a model falsely declaring no tool requirements. Background
helpers still have the existing restricted research tool set. Foreground helpers
are unaffected.

Limits: a model can still omit execution_state, falsely claim verified completion,
or fail to act on the final recovery reminder. Durable scratchpad records preserve
work across runs but do not independently wake an idle bot or schedule a retry.
These safeguards reduce premature endings without promising an infinite agent
loop or bypassing human approvals. No database migration is needed.
