# stop session files being created from db

## Goal
The plan file watcher in taskviewerprovider suddenly created 118 session files (on another machine) where they did not exists.

I believe this is because:
1. it checks if a runsheet already exists for a plan
2. if not, it auto creates a new session file

But we removed the need for session files, it exists in the db now. so why is the plugin still spam creating these?

## Proposed Changes
- TODO

## Verification Plan
- TODO

## Open Questions
- TODO
