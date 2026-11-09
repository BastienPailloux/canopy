# Linear MCP reference answers

Raw `callTool` results (`{content:[{type:'text',text}], isError?}`) captured from `https://mcp.linear.app/mcp`
with `scripts/linear-capture.mjs` (`capture`, then `patch CAN-1`) on the personal workspace `canopy`, team `CAN`
(key `CAN`, team name `Canopy`). The payload is JSON inside `content[0].text`. Emails other than the owner's are
`user@example.com`; the owner's own email stays in `whoami.json` / `list_users.json`.

Not covered yet: the workspace only had the 4 onboarding issues CAN-1..4, all assigned to the owner, status Todo.
No sub-issues, comments, cycle, project, labels, canceled issue, "In Review" issue, unassigned issue or other priority.
More issues may be captured and added later.

## Files
- `tools.json`: `listTools` (all tool schemas).
- `whoami.json`: `{user:{id,name,email,displayName,isAdmin,isGuest,isActive}, workspace:{id,name,url}, connection}`.
- `list_issues_me.json` (limit 50), `list_issues_me_page1.json` (limit 2), `list_issues_me_page2.json`.
- `get_issue_CAN-n.json`: with the `fields` list of Task 3; `get_issue_CAN-n_default.json`: without `fields`.
- `get_issue_unknown.json`: CAN-9999. `list_comments_CAN-n.json`. `list_issues_children_CAN-3.json`.
- `list_issue_statuses.json`, `list_issue_labels.json`, `list_users.json`.
- `patch-*.json`: results of the `save_issue` `patch` probes on CAN-1 (`patch-<probe>-after.json` = `get_issue` re-read after the probe,
  `patch-original.json` = description before any write, `patch-setup-append.json` = first save, `patch-restore*.json` = final restore).

## Shapes (observed)
- `list_issues` text: `{issues:[...], hasNextPage:boolean, cursor?:string}`. Page 1 (limit 2) had `hasNextPage:true` and `cursor`
  (a UUID); passing `cursor` with the same filters gave page 2 (`hasNextPage:false`, no `cursor` key). Order was CAN-3, CAN-2, CAN-4, CAN-1.
  Params include `limit, cursor, team, state, assignee, label, cycle, project, priority, parentId, query, fields, includeArchived...`
  (`parentId` works: `{issues:[],hasNextPage:false}` for CAN-3, which has no children).
- Issue (list item, `get_issue` default, `save_issue` result): `id` ("CAN-3"), `uuid`, `title`, `description` (Markdown string), `priority` = object
  `{value:0,name:"No priority"}`, `url`, `gitBranchName`, `createdAt`, `updatedAt`, `archivedAt`, `completedAt`, `startedAt`, `canceledAt`, `dueDate`, `sla*`,
  `status` (name string, e.g. "Todo"), `statusType` ("unstarted"), `labels` (array; empty here, so the element shape is UNKNOWN),
  `assignee` (name string, "Bastien") + `assigneeId` (uuid), `team` (name "Canopy") + `teamId`. Default `get_issue` also has `attachments`, `documents`, `stateHistory`.
- `get_issue` with `fields` returns only those keys: `parentId` (null here), `cycleId` (null), `project` (null) appear only when asked.
  Shapes of non-null `parentId`, `cycleId`, `project`, sub-issues and cycle are UNKNOWN (not in captures).
- Unknown issue: `isError:true`, text `{"error":"invalid_request","message":"Could not find referenced Issue.","status":400,"requestId":"..."}`.
- `list_issue_statuses`: bare array (no wrapper) `[{id,type,name}]`, in this order: In Review (started), Done (completed), Canceled (canceled),
  In Progress (started), Todo (unstarted), Duplicate (duplicate), Backlog (backlog). Not sorted by workflow position.
- `list_issue_labels`: `{labels:[{id,name,color,description,archivedAt}], hasNextPage}` (Improvement, Feature, Bug).
- `list_users`: `{users:[{id,name,email,displayName,avatarUrl?,isAdmin,isGuest,isActive,createdAt,updatedAt,status}], hasNextPage}` (includes the "Linear" bot user).
- `list_comments`: `{comments:[],hasNextPage:false}` (empty; comment shape UNKNOWN).

## Creation (replay only)
`CANOPY_FAKE_LINEAR` replays `save_issue` creation too: a call without `id` needs `team` (name or id, else `Error: team is required when creating.`)
and `title`. The new issue gets id `CAN-<max+1>` (max over the current issues), status of the `unstarted` type, no assignee, and the given `parentId`.
Not captured: the real creation answer and a non-null `parentId`; both are assumed to have the same shape as the update answer.

## `save_issue` `patch`
`patch` is a top-level argument of `save_issue` (sibling of `id`; only on update, in place of `description`): array of 1-50 ops, applied in order, atomic.
Ops (from `tools.json`):
- `{op:'replace', old_string (min 1), new_string, replace_all?:boolean}`: `old_string` must match exactly once unless `replace_all`.
- `{op:'insert_before', anchor, text}` / `{op:'insert_after', anchor, text}`: `anchor` matches exactly once; `text` min length 1, include separators.
- `{op:'prepend', text}` / `{op:'append', text}`: at the very start / end.
- `{op:'replace_range', from, to, new_string}`: `from` inclusive, `to` exclusive (stays), each must match once (`to` after `from`). Not probed.

Observed (CAN-1): replace with a unique anchor, `insert_before`, `insert_after`, `replace_all` and `append` all applied.
Failures return `isError:true` and save nothing (`-after` re-reads equal the base):
- Duplicate anchor: `Error: Patch failed, nothing was saved. Operation 1 (replace): \`old_string\` matches 2 locations:` then `1. "…UNIQUE-1 PROBE-UNIQUE-2\n\n«PROBE-DUP» PROBE-DUP…"`, `2. "…"`, then `Add surrounding text to make it unique, or set replace_all to replace every occurrence.`
- Missing anchor: `Error: Patch failed, nothing was saved. Operation 1 (replace): \`old_string\` not found in the current content. Fetch the latest content and copy the text exactly.`
- Two ops, the second failing: same message with `Operation 2 (replace)`; the first op was NOT applied (atomic).

The `save_issue` result is the full updated issue, including the new `description` (identical to a re-read after the save), so no extra `get_issue` is needed.

## Warning for Task 5: Linear re-serializes the whole description on every save
Any successful save (patch or full `description`) normalises the entire description, not only the edited part. Compare `patch-original.json` with
`patch-setup-append.json` / `patch-restore-after.json`:
- trailing spaces at end of lines are stripped (`Welcome to Linear! ` becomes `Welcome to Linear!`);
- adjacent links with different hrefs got merged: the line `[Join a live ](…utm_source=docs)[onboarding](…utm_source=onboarding)[ ](…)[session](…)` became `[Join a live onboarding session](<https://lu.ma/welcome-to-linear>)` (the utm URLs are lost);
- `<linear-image>` and `<linear-embed>` tags came back byte-identical.

Consequences: after any successful save, the new base is the description as Linear returns it (from the save result or a re-read), never the text Canopy sent.
A full-`description` save is not lossless either (the restore of CAN-1 did not bring the original back; CAN-1 now holds the normalised text).
So `patch` limits, but does not remove, collateral changes; comparisons "unchanged upstream" must be done against the normalised base.
