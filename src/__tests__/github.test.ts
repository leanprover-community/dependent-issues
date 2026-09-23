// Ours
import { GithubClient } from '../types';
import { fetchDependencyStates, fetchOpenIssues } from '../github';

jest.mock('@actions/core', () => ({
	info: jest.fn(),
	warning: jest.fn(),
}));

const repo = { owner: 'owner', repo: 'repo' };
const options = { signature: '<signature>' };

// GitHub reports timeouts (and other server-side failures) with a 200
// status and an untyped error, which @octokit/graphql throws as a
// GraphqlResponseError: no `status`, but `errors` and `data`.
const timeout = () =>
	Object.assign(new Error('Something went wrong'), {
		errors: [
			{
				message:
					'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.',
			},
		],
		data: null,
	});

const page = (numbers: number[]) => ({
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: false, endCursor: null },
			nodes: numbers.map((number) => ({
				id: `PR_${number}`,
				number,
				body: '',
				author: null,
				labels: { nodes: [] },
				comments: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: [],
				},
			})),
		},
	},
});

let graphql: jest.Mock;
let gh: GithubClient;

beforeEach(() => {
	graphql = jest.fn();
	gh = { graphql } as unknown as GithubClient;
});

describe('fetchOpenIssues', () => {
	it('retries timeouts with a smaller page', async () => {
		graphql
			.mockRejectedValueOnce(timeout())
			.mockResolvedValueOnce(page([1, 2]));

		const issues = await fetchOpenIssues(gh, repo, false, options);

		expect(issues.map((issue) => issue.number)).toEqual([1, 2]);
		expect(graphql).toHaveBeenCalledTimes(2);
		expect(graphql.mock.calls[0][1]).toMatchObject({ pageSize: 50 });
		expect(graphql.mock.calls[1][1]).toMatchObject({ pageSize: 25 });
	});

	it('gives up after a few timeouts', async () => {
		graphql.mockRejectedValue(timeout());

		await expect(
			fetchOpenIssues(gh, repo, false, options)
		).rejects.toThrow('Something went wrong');
		expect(graphql).toHaveBeenCalledTimes(3);
	});

	it('does not retry client errors', async () => {
		graphql.mockRejectedValue(
			Object.assign(new Error('Bad credentials'), { status: 401 })
		);

		await expect(
			fetchOpenIssues(gh, repo, false, options)
		).rejects.toThrow('Bad credentials');
		expect(graphql).toHaveBeenCalledTimes(1);
	});

	it('does not retry errors about the data', async () => {
		graphql.mockRejectedValue(
			Object.assign(new Error('Forbidden'), {
				errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }],
				data: null,
			})
		);

		await expect(
			fetchOpenIssues(gh, repo, false, options)
		).rejects.toThrow('Forbidden');
		expect(graphql).toHaveBeenCalledTimes(1);
	});
});

describe('fetchDependencyStates', () => {
	const dep = { ...repo, number: 4 };

	it('retries timeouts', async () => {
		graphql
			.mockRejectedValueOnce(timeout())
			.mockResolvedValueOnce({ r0: { i4: { state: 'CLOSED' } } });

		const states = await fetchDependencyStates(gh, [dep]);

		expect(states.get('owner/repo#4')).toEqual('closed');
		expect(graphql).toHaveBeenCalledTimes(2);
	});

	it('does not retry missing issues', async () => {
		graphql.mockRejectedValue(
			Object.assign(new Error('Not found'), {
				errors: [{ type: 'NOT_FOUND', message: 'Not found' }],
				data: { r0: { i4: null } },
			})
		);

		const states = await fetchDependencyStates(gh, [dep]);

		expect(states.get('owner/repo#4')).toEqual('unknown');
		expect(graphql).toHaveBeenCalledTimes(1);
	});
});
