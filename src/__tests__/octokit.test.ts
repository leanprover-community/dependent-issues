import { getOctokit } from '@actions/github';

// Ours
import { installHooks, retryDelay } from '../octokit';

jest.mock('@actions/core', () => ({
	info: jest.fn(),
	warning: jest.fn(),
}));

const response = (
	status: number,
	headers: Record<string, string> = {}
) =>
	new Response(
		JSON.stringify(
			status < 400
				? {}
				: { message: 'You have exceeded a secondary rate limit' }
		),
		{
			status,
			headers: { 'content-type': 'application/json', ...headers },
		}
	);

function client(fetch: jest.Mock, options = {}) {
	const time = { now: 0 };
	const sleep = jest.fn(async (ms: number) => {
		time.now += ms;
	});

	const gh = installHooks(
		getOctokit('<token>', { request: { fetch } }),
		{
			sleep,
			now: () => time.now,
			...options,
		}
	);

	return { gh, sleep };
}

const addLabel = (gh: any) =>
	gh.rest.issues.addLabels({
		owner: 'o',
		repo: 'r',
		issue_number: 1,
		labels: ['l'],
	});

describe('installHooks', () => {
	it('skips writes in dry-run mode', async () => {
		const fetch = jest
			.fn()
			.mockImplementation(async () => response(200));
		const { gh } = client(fetch, { dryRun: true });

		await addLabel(gh);
		expect(fetch).not.toHaveBeenCalled();

		// Reads still go through
		await gh.rest.issues.get({
			owner: 'o',
			repo: 'r',
			issue_number: 1,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('spaces out writes', async () => {
		const fetch = jest
			.fn()
			.mockImplementation(async () => response(200));
		const { gh, sleep } = client(fetch);

		await addLabel(gh);
		await addLabel(gh);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1000);
	});

	it('retries writes on secondary rate limits', async () => {
		const fetch = jest
			.fn()
			.mockResolvedValueOnce(response(403, { 'retry-after': '30' }))
			.mockImplementation(async () => response(200));
		const { gh, sleep } = client(fetch);

		await addLabel(gh);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(30000);
	});

	it('gives up after a few retries', async () => {
		const fetch = jest
			.fn()
			.mockImplementation(async () =>
				response(403, { 'retry-after': '1' })
			);
		const { gh } = client(fetch);

		await expect(addLabel(gh)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(4);
	});
});

describe('retryDelay', () => {
	const error = (status: number, headers = {}, message = '') => ({
		status,
		message,
		response: { headers },
	});

	it('ignores other errors', () => {
		expect(retryDelay(error(404), 0, 0)).toBeUndefined();
		expect(
			retryDelay(error(403, {}, 'Forbidden'), 0, 0)
		).toBeUndefined();
	});

	it('uses retry-after', () => {
		expect(
			retryDelay(error(429, { 'retry-after': '5' }), 0, 0)
		).toEqual(5000);
	});

	it('waits for the primary rate limit to reset', () => {
		expect(
			retryDelay(
				error(403, {
					'x-ratelimit-remaining': '0',
					'x-ratelimit-reset': '100',
				}),
				0,
				40000
			)
		).toEqual(61000);
	});

	it('backs off exponentially on secondary rate limits', () => {
		const e = error(
			403,
			{},
			'You have exceeded a secondary rate limit'
		);
		expect(retryDelay(e, 0, 0)).toEqual(60000);
		expect(retryDelay(e, 1, 0)).toEqual(120000);
	});
});
