import { defineConfig } from '@vscode/test-cli';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Real process tasks need a workspace folder. Keep their test workspace
// isolated from both the extension source and the user's projects.
const testWorkspace = resolve('.vscode-test/workspace');
mkdirSync(testWorkspace, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: [testWorkspace],
	env: { LUIX_TEST_NODE: process.execPath },
	// The e2e suites open real documents and poll for diagnostics; give
	// them headroom over mocha's 2 s default so a slow runner fails on an
	// assertion, not on a timeout.
	mocha: { timeout: 20000 },
});
