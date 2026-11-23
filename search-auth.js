const fs = require('fs');
const path = require('path');

function searchFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file.startsWith('.') || file === 'node_modules') continue;
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            searchFiles(fullPath);
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('authorizeRequest(')) {
                console.log('FOUND:', fullPath);
            }
        }
    }
}
searchFiles(path.join(process.cwd(), 'app'));
searchFiles(path.join(process.cwd(), 'lib'));
