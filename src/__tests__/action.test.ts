// Ours
import * as action from '../action';
import { GithubClient } from '../types';

var gh: GithubClient;
var inputs: Record<string, string>;

const signature =
	'<!-- By Dependent Issues (Action) - DO NOT REMOVE -->';

// Mock @actions modules
jest.mock('@actions/core', () => {
	inputs = {};

	return {
		getInput: jest
			.fn()
			.mockImplementation((key: string) => inputs[key]),
		info: jest.fn(),
		warning: jest.fn(),
		error: jest.fn(),
		setFailed: jest.fn(),
		startGroup: jest.fn(),
		endGroup: jest.fn(),
	};
});

jest.mock('@actions/github', () => {
	gh = {
		hook: { wrap: jest.fn() },
		graphql: jest.fn() as any,
		rest: {
			issues: {
				addLabels: jest.fn() as any,
				removeLabel: jest.fn() as any,
				createComment: jest.fn() as any,
				updateComment: jest.fn() as any,
				deleteComment: jest.fn() as any,
			},
			repos: {
				createCommitStatus: jest.fn() as any,
			},
		},
	} as unknown as GithubClient;

	return {
		context: {
			repo: { owner: 'owner', repo: 'repo' },
			issue: {},
		},
		getOctokit: jest.fn().mockReturnValue(gh),
	};
});

const pullRequest = (
	number: number,
	body: string,
	options: { labels?: string[]; comments?: string[] } = {}
) => ({
	id: `PR_${number}`,
	number,
	body,
	author: { login: 'someone' },
	labels: { nodes: (options.labels || []).map((name) => ({ name })) },
	comments: {
		pageInfo: { hasNextPage: false, endCursor: null },
		nodes: (options.comments || []).map((body, i) => ({
			databaseId: number * 100 + i,
			body,
		})),
	},
	commits: {
		nodes: [{ commit: { oid: `<sha-${number}>`, status: null } }],
	},
});

function mockGraphql(pulls: any[], states: Record<string, string>) {
	(gh.graphql as unknown as jest.Mock).mockImplementation(
		async (query: string) => {
			if (query.includes('pullRequests(')) {
				return {
					repository: {
						pullRequests: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: pulls,
						},
					},
				};
			}

			// Dependency lookup: return the state of each requested
			// issue, keyed by alias
			const data: any = {};
			const repoRegex =
				/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{([^}]*(?:\}[^}]*)*?)\}\s*\}\s*\}/g;
			for (const [, alias, owner, repo, items] of query.matchAll(
				repoRegex
			)) {
				data[alias] = {};
				for (const [, number] of items.matchAll(/i(\d+):/g)) {
					const state = states[`${owner}/${repo}#${number}`];
					data[alias][`i${number}`] = state ? { state } : null;
				}
			}

			return data;
		}
	);
}

process.env.GITHUB_TOKEN = '<token>';

beforeEach(() => {
	inputs = {
		label: 'dependent',
		check_issues: 'off',
		commit_status: 'on',
		keywords: 'depends on, blocked by',
		comment: 'This PR/issue depends on:\n\n{{ dependencies }}',
	};
});

test('it works in default config', async () => {
	mockGraphql(
		[
			pullRequest(
				1,
				'This work depends on #2 and blocked by user/another-repo#3'
			),
			pullRequest(2, 'This work does not depend on anything'),
		],
		{ 'user/another-repo#3': 'OPEN' }
	);

	await action.start();

	expect(gh.rest.issues.createComment).toHaveBeenCalledWith({
		issue_number: 1,
		owner: 'owner',
		repo: 'repo',
		body: `This PR/issue depends on:

* owner/repo#2
* user/another-repo#3
${signature}`,
	});

	expect(gh.rest.issues.createComment).toHaveBeenCalledTimes(1);

	expect(gh.rest.issues.addLabels).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		issue_number: 1,
		labels: ['dependent'],
	});

	expect(gh.rest.issues.addLabels).toHaveBeenCalledTimes(1);

	expect(gh.rest.repos.createCommitStatus).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		description: 'Blocked by #2 and 1 more issues',
		state: 'pending',
		context: 'Dependent Issues',
		sha: '<sha-1>',
	});

	expect(gh.rest.repos.createCommitStatus).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		description: 'No dependencies',
		state: 'success',
		context: 'Dependent Issues',
		sha: '<sha-2>',
	});

	expect(gh.rest.repos.createCommitStatus).toHaveBeenCalledTimes(2);

	// One request for the PRs, one for the unknown dependency
	expect(gh.graphql).toHaveBeenCalledTimes(2);
});

test('it only writes when something changed', async () => {
	inputs.commit_status = 'off';

	mockGraphql(
		[
			// Up to date
			pullRequest(1, 'Depends on #2', {
				labels: ['dependent'],
				comments: [
					'Unrelated',
					`This PR/issue depends on:\n\n* owner/repo#2\n${signature}`,
				],
			}),
			// Dependency was closed
			pullRequest(2, 'Depends on #10', {
				labels: ['dependent'],
				comments: [
					`This PR/issue depends on:\n\n* owner/repo#10\n${signature}`,
				],
			}),
			// Dependencies were removed from the body
			pullRequest(3, 'Nothing', {
				comments: [
					`This PR/issue depends on:\n\n* ~~owner/repo#11~~\n${signature}`,
				],
			}),
			// No dependencies, nothing to clean up
			pullRequest(4, 'Nothing'),
		],
		{ 'owner/repo#10': 'MERGED' }
	);

	await action.start();

	// #1: nothing to do

	// #2: label removed, comment re-created
	expect(gh.rest.issues.removeLabel).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		issue_number: 2,
		name: 'dependent',
	});
	expect(gh.rest.issues.deleteComment).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		comment_id: 200,
	});
	expect(gh.rest.issues.createComment).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		issue_number: 2,
		body: `This PR/issue depends on:\n\n* ~~owner/repo#10~~\n${signature}`,
	});

	// #3: comment removed
	expect(gh.rest.issues.deleteComment).toHaveBeenCalledWith({
		owner: 'owner',
		repo: 'repo',
		comment_id: 300,
	});

	expect(gh.rest.issues.removeLabel).toHaveBeenCalledTimes(1);
	expect(gh.rest.issues.deleteComment).toHaveBeenCalledTimes(2);
	expect(gh.rest.issues.createComment).toHaveBeenCalledTimes(1);
	expect(gh.rest.issues.updateComment).not.toHaveBeenCalled();
	expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();
	expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
});
