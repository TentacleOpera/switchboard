const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const iconsDir = path.join(repoRoot, 'icons');
const webviewDir = path.join(repoRoot, 'src', 'webview');

const files = fs.readdirSync(iconsDir).filter(f => f.startsWith('icon-') && f.endsWith('.svg'));

let hasError = false;

files.forEach(file => {
  const iconName = file.replace('icon-', '').replace('.svg', '');
  const svgPath = path.join(iconsDir, file);
  const base64 = fs.readFileSync(svgPath).toString('base64').replace(/[\r\n=+]/g, '');
  
  // Search through html/js files for references
  const targets = ['design.html', 'kanban.html', 'planning.html', 'setup.html', 'implementation.html'];
  targets.forEach(target => {
    const targetPath = path.join(webviewDir, target);
    if (!fs.existsSync(targetPath)) return;
    const content = fs.readFileSync(targetPath, 'utf8');
    
    // If the class name is used, check if the matching base64 substring is present
    if (content.includes(`sb-icon-${iconName}`)) {
      // Remove whitespace/newlines from content before checking substring
      const cleanContent = content.replace(/[\r\n\s]/g, '');
      if (!cleanContent.includes(base64.slice(0, 30))) {
        console.error(`[PARITY MISMATCH] ${target} contains sb-icon-${iconName} but missing matching base64 asset string`);
        hasError = true;
      }
    }
  });
});

if (hasError) {
  process.exit(1);
} else {
  console.log('Icon parity check passed!');
}
