import { execSync } from 'child_process';
try {
    const status = execSync('git status --short').toString();
    console.log('Git Status:\n', status);
} catch (e) {
    console.error('Git not found or not a repo');
}
