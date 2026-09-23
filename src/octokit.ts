// Packages
import * as core from '@actions/core';

// Ours
import { GithubClient } from './types';

// GitHub recommends waiting at least a second between requests that
// create content, to avoid secondary rate limits.
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
const MIN_WRITE_INTERVAL = 1000;
const MAX_RETRIES = 3;

// Don't wait longer than this for a rate limit to reset
const MAX_WAIT = 15 * 60 * 1000;

export type HookOptions = {
	dryRun?: boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function isWrite(options: { method: string; url: string }) {
	return options.method !== 'GET' && options.url !== '/graphql';
}

/**
 * Returns how long to wait before retrying a request that failed
 * because of a rate limit, or `undefined` if it shouldn't be retried.
 */
export function retryDelay(
	error: any,
	attempt: number,
	now: number
): number | undefined {
	if (error?.status !== 403 && error?.status !== 429) {
		return undefined;
	}

	const headers = error.response?.headers || {};

	if (headers['retry-after']) {
		return Number(headers['retry-after']) * 1000;
	}

	if (headers['x-ratelimit-remaining'] === '0') {
		const reset = Number(headers['x-ratelimit-reset']) * 1000;
		return Math.max(reset - now, 0) + 1000;
	}

	if (/secondary rate limit/i.test(error.message || '')) {
		return 60 * 1000 * 2 ** attempt;
	}

	return undefined;
}

/**
 * Makes the client:
 * - space out and retry write requests on rate limits
 * - skip (and log) write requests in dry-run mode
 */
export function installHooks(
	gh: GithubClient,
	options: HookOptions = {}
) {
	const sleep = options.sleep || defaultSleep;
	const now = options.now || Date.now;
	let lastWrite = 0;

	gh.hook.wrap('request', async (request, requestOptions) => {
		const write = isWrite(requestOptions);

		if (write && options.dryRun) {
			const { method, url, body } = gh.request.endpoint(requestOptions);
			const details = body ? ` ${JSON.stringify(body)}` : '';
			core.info(`[dry run] Skipped ${method} ${url}${details}`);
			return { status: 200, url, headers: {}, data: {} } as any;
		}

		for (let attempt = 0; ; attempt++) {
			if (write) {
				const wait = lastWrite + MIN_WRITE_INTERVAL - now();
				if (wait > 0) {
					await sleep(wait);
				}
				lastWrite = now();
			}

			try {
				return await request(requestOptions);
			} catch (error) {
				const delay = retryDelay(error, attempt, now());

				if (
					delay === undefined ||
					attempt >= MAX_RETRIES ||
					delay > MAX_WAIT
				) {
					throw error;
				}

				core.warning(
					`Rate limited. Retrying in ${Math.ceil(delay / 1000)}s`
				);
				await sleep(delay);
			}
		}
	});

	return gh;
}
