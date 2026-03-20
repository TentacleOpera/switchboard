# Fix complexity parsing bug

Fix the complexity identification bug where plans that are low complexity are being marked as high complexity. 

For exmaple:

Summary
All 11 plans in the CREATED column have been improved through the /improve-plan workflow. Each plan now includes:

#	Plan	Agent Rec	Complexity
1	Live feed not registering autoban moves	Coder	Routine
2	Autoban needs countdown in UI	Coder	Routine + Moderate
3	Add upper limit of autoban sends	Lead Coder	Complex
4	Add separate column for coder and lead coder	Lead Coder	Complex
5	Refine ticket view (9 changes)	Coder	Routine + Moderate
6	Check backwards move + CLI trigger switch	Coder	Routine (2 bug fixes)
7	Open plans should open a new ticket	Coder	Routine + Moderate
8	Remove text input areas from airlock tab	Coder	Routine
9	Kanban top row buttons are confusing	Coder	Routine + Moderate
10	Plans in reviewed column out of order	Coder	Routine (1-line fix)
11	Add move controls to ticket view	Coder	Routine + Moderate

But all these plans have been marked as high complexity in kanban. Here is an example of text that was treated as high complexity:

## Complexity Audit

### Band A (Routine)
- All changes are text/element deletions in a single file.
- ~50 lines of code removed.
- ~3 lines of text updated.
- ~10 lines of message handler cleanup.

### Band B (Complex/Risky)
- None.

## Goal
- Clarify expected outcome and scope.

## Proposed Changes
- TODO

## Verification Plan
- TODO

## Open Questions
- TODO
