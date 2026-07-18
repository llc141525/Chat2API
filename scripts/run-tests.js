// Cross-platform test runner — works on Windows (cmd.exe) and Linux
// Uses Node.js built-in fs.globSync (available since Node 22)
const fs = require('fs');
const { execSync } = require('child_process');

const testFiles = fs.globSync('tests/**/*.test.ts');
testFiles.sort();

const cmd = 'node --test ' + testFiles.join(' ');
process.stdout.write('Running ' + testFiles.length + ' test files...\n');

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (e) {
  // execSync throws on non-zero exit — propagate the status
  process.exitCode = e.status || 1;
}
