import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [resolve(__dirname, 'src/cli.js')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: resolve(__dirname, 'dist/pac-preflight.mjs'),
	loader: {
		'.css': 'empty',
		'.scss': 'empty',
	},
	banner: {
		// Runs before any bundled module evaluates. We need jsdom globals live
		// before @wordpress/block-editor's module-top-level `var { setTimeout } = window`
		// executes. Because ESM bundle order is not the source import order,
		// doing this in the banner (synchronously, via require) is the only
		// reliable placement.
		js: [
			'import { createRequire } from "node:module";',
			'const require = createRequire(import.meta.url);',
			'const { JSDOM, VirtualConsole } = require("jsdom");',
			'const __vc = new VirtualConsole();',
			'const __dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true, virtualConsole: __vc });',
			'const __w = __dom.window;',
			'for (const k of ["window","document","navigator","HTMLElement","HTMLAnchorElement","HTMLInputElement","Element","Node","Text","DocumentFragment","NodeFilter","getComputedStyle","CSS","MutationObserver","requestAnimationFrame","cancelAnimationFrame","DOMParser","XMLSerializer","Event","CustomEvent","KeyboardEvent","MouseEvent","FocusEvent","InputEvent","ClipboardEvent"]) { if (__w[k] !== undefined && globalThis[k] === undefined) { globalThis[k] = __w[k]; } }',
			'if (typeof globalThis.window === "undefined") globalThis.window = __w;',
			'if (typeof globalThis.document === "undefined") globalThis.document = __w.document;',
			'if (typeof globalThis.self === "undefined") globalThis.self = __w;',
		].join('\n'),
	},
	external: ['jsdom', 'canvas'],
	logLevel: 'info',
});
