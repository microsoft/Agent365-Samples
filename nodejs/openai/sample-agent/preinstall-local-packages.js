#!/usr/bin/env node

import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Look for *.tgz files two directories above
const tgzDir = join(__dirname, './packages/');

// Define the installation order
const installOrder = [
  'microsoft-agents-a365-runtime-',
  'microsoft-agents-a365-notifications-',
  'microsoft-agents-a365-observability-',
  'microsoft-agents-a365-tooling-',
  'microsoft-agents-a365-tooling-extensions-openai-'
];

async function findTgzFiles() {
  try {
    const files = await readdir(tgzDir);
    return files.filter(file => file.endsWith('.tgz'));
  } catch (error) {
    console.log('No tgz directory found or no files to install');
    return [];
  }
}

function findFileForPattern(files, pattern) {
  return files.find(file => file.startsWith(pattern));
}

async function installPackages() {
  const tgzFiles = await findTgzFiles();

  if (tgzFiles.length === 0) {
    console.log('No .tgz files found in', tgzDir);
    return;
  }

  console.log('Found .tgz files:', tgzFiles);

  for (const pattern of installOrder) {
    const file = findFileForPattern(tgzFiles, pattern);
    if (file) {
      const filePath = join(tgzDir, file);
      console.log(`Installing ${file}...`);
      try {
        execSync(`npm install "${filePath}"`, {
          stdio: 'inherit',
          cwd: __dirname
        });
        console.log(`✓ Successfully installed ${file}`);
      } catch (error) {
        console.error(`✗ Failed to install ${file}:`, error.message);
        process.exit(1);
      }
    } else {
      console.log(`No file found matching pattern: ${pattern}`);
    }
  }
}

// Run the installation
installPackages().catch(error => {
  console.error('Error during package installation:', error);
  process.exit(1);
});