### send-team-message.test.js
**File:** `src/test/send-team-message.test.js`
#### fan-out delivers to all team members
- **fan-out delivers to all team members** - Passes when team message is delivered to all configured team members and inbox files are created.

#### persona injection applies correct persona per role
- **persona injection applies correct persona per role** - Passes when agents get the correct persona file based on their assigned role and original payload is preserved.

#### planner and task runner personas both resolve without regression
- **planner and task runner personas both resolve without regression** - Passes when planner and task runner roles correctly resolve to their respective persona files.

#### agent with no role gets no persona injection
- **agent with no role gets no persona injection** - Passes when an agent with no defined role receives the raw payload without persona injection.

#### role_filter sends only to matching members
- **role_filter sends only to matching members** - Passes when filtering by role successfully restricts message delivery to members with that role.

#### role_filter with no matches returns error
- **role_filter with no matches returns error** - Passes when attempting to send to a role filter that has no matching team members results in an error.

#### composite team single-member constraint (state-level check)
- **composite team single-member constraint (state-level check)** - Passes when the logic correctly identifies composite teams and blocks adding additional members.
