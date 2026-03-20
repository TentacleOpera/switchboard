
const { deriveKanbanColumn } = require('./src/services/kanbanColumnDerivation');

const events1 = [
    {
      "workflow": "initiate-plan",
      "timestamp": "2026-03-12T19:37:52.618Z",
      "action": "start"
    },
    {
      "workflow": "challenge",
      "action": "complete",
      "timestamp": "2026-03-13T09:38:39.281Z"
    }
];

const events9 = [
    {
      "workflow": "initiate-plan",
      "timestamp": "2026-03-13T02:55:45.770Z",
      "action": "start"
    },
    {
      "workflow": "challenge",
      "action": "complete",
      "timestamp": "2026-03-13T09:38:39.296Z"
    }
];

console.log('Result for Events 1:', deriveKanbanColumn(events1));
console.log('Result for Events 9:', deriveKanbanColumn(events9));
