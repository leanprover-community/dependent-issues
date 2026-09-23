// Jest 27's node environment doesn't expose Node's web globals, which
// undici (used by @actions/github) needs.
const NodeEnvironment = require('jest-environment-node');

const WEB_GLOBALS = [
	'ReadableStream',
	'WritableStream',
	'TransformStream',
	'TextEncoderStream',
	'TextDecoderStream',
	'Blob',
	'File',
	'FormData',
	'Headers',
	'Request',
	'Response',
	'fetch',
	'AbortController',
	'AbortSignal',
	'DOMException',
	'MessageChannel',
	'MessagePort',
	'BroadcastChannel',
	'structuredClone',
	'performance',
];

class Environment extends NodeEnvironment {
	async setup() {
		await super.setup();

		for (const name of WEB_GLOBALS) {
			if (globalThis[name] !== undefined) {
				this.global[name] = globalThis[name];
			}
		}
	}
}

module.exports = Environment;
