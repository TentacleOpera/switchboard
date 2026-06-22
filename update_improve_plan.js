const fs = require('fs');
const file = '.agents/workflows/improve-plan.md';
let content = fs.readFileSync(file, 'utf8');

const target = '- Ensure the plan has ALL required sections in order: Goal, Metadata (Tags from allowed list, Complexity 1-10, Repo if applicable), User Review Required,';
const replacement = '- Ensure the plan has ALL required sections in order: Goal, Metadata (Tags from allowed list [frontend, backend, authentication, database, UI, UX, devops, infrastructure, bugfix, documentation, reliability, workflow, testing, security, performance, analytics], Complexity 1-10, Repo if applicable), User Review Required,';

if (content.includes(target)) {
    fs.writeFileSync(file, content.replace(target, replacement));
    console.log('Fixed allowed tags list.');
} else {
    console.log('Target string not found in file.');
}
