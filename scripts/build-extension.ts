import { execSync } from 'child_process';
import fs from 'fs';

execSync('npm run build');

fs.mkdirSync('dist-extension', { recursive: true });

// copy manifest + build output
execSync('cp -r dist/* dist-extension/');
execSync('cp manifest.json dist-extension/');
