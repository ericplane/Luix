import { defineConfig } from '@vscode/test-cli';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Process tasks require a workspace folder.
const testWorkspace = resolve('.vscode-test/workspace');
mkdirSync(testWorkspace, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: [testWorkspace],
	env: { LUIX_TEST_NODE: process.execPath },
	// Allow time for asynchronous diagnostics.
	mocha: { timeout: 20000 },
});
