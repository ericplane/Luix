import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The e2e suites open real documents and poll for diagnostics; give
	// them headroom over mocha's 2 s default so a slow runner fails on an
	// assertion, not on a timeout.
	mocha: { timeout: 20000 },
});
