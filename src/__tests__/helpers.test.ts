// Ours
import { ActionContext, GithubClient, Issue } from '../types';
import {
	DependencyExtractor,
	DependencyResolver,
	IssueManager,
	formatDependency,
} from '../helpers';

test('formatDependency', () => {
	const repo = { owner: 'owner', repo: 'repo' };
	const dep = { ...repo, number: 141 };

	expect(formatDependency(dep)).toEqual('owner/repo#141');
	expect(formatDependency(dep, repo)).toEqual('#141');
});

test('DependencyExtractor', () => {
	const repo = {
		owner: 'github',
		repo: 'atom',
	};

	const body = `
	Should match:

	- Plain issue:
		- Depends on #666
		- Blocked by #123
	- From another repository:
		- Depends on another/repo#123
	- Full issue URL:
		- Depends on https://github.com/another/repo/issues/141
		- Depends on http://github.com/another/repo/issues/404
		- Depends on https://github.com/another/repo/pull/142
	- Crazy formatting:
		- Depends on ano-ther.999/re_po#123
	- In brackets:
		- (Depends on #486)
		- [Depends on #3167]
		- <Depends on another/repo#18767>

	Should NOT match:

	- Depends on #0
	- Depends on another/repo#0
	- Depends on nonrepo#123
	- Depends on non/-repo#123
	- Depends on user_repo#123
	- Depends on this/is/not/repo#123
	- Depends on #123hashtag
	- Depends on https://github.com/another/repo/pulls/142
	`;

	const issue = { body } as Issue;

	const expectedDeps = [
		// Depends on #666
		{
			...repo,
			number: 666,
		},
		// Blocked by #123
		{
			...repo,
			number: 123,
		},
		// Depends on another/repo#123
		{
			owner: 'another',
			repo: 'repo',
			number: 123,
		},
		// Depends on https://github.com/another/repo/issues/141
		{
			owner: 'another',
			repo: 'repo',
			number: 141,
		},
		// Depends on http://github.com/another/repo/issues/404
		{
			owner: 'another',
			repo: 'repo',
			number: 404,
		},
		// Depends on https://github.com/another/repo/pull/142
		{
			owner: 'another',
			repo: 'repo',
			number: 142,
		},
		// Depends on ano-ther.999/re_po#123
		{
			owner: 'ano-ther.999',
			repo: 're_po',
			number: 123,
		},
		// (Depends on #486)
		{
			...repo,
			number: 486,
		},
		// [Depends on #3167]
		{
			...repo,
			number: 3167,
		},
		// <Depends on another/repo#18767>
		{
			owner: 'another',
			repo: 'repo',
			number: 18767,
		},
	];

	const extractor = new DependencyExtractor(repo, [
		'  depends On',
		'blocked   by',
	]);

	expect(extractor.fromIssue(issue)).toEqual(expectedDeps);
});

describe('DependencyResolver', () => {
	let gh: GithubClient;
	let graphql: jest.Mock<any, any>;
	let resolver: DependencyResolver;

	const repo = {
		owner: 'facebook',
		repo: 'react',
	};

	const contextIssues = [1, 2, 3].map((number) => ({
		number,
	})) as Issue[];

	beforeEach(() => {
		graphql = jest.fn();
		gh = { graphql: graphql as any } as GithubClient;
		resolver = new DependencyResolver(gh, contextIssues, repo);
	});

	it('resolves context issues as open', async () => {
		expect(await resolver.get({ ...repo, number: 1 })).toEqual('open');
		expect(graphql).not.toHaveBeenCalled();
	});

	it('fetches unknown issues in a single request', async () => {
		graphql.mockResolvedValue({
			r0: { i4: { state: 'CLOSED' }, i5: { state: 'OPEN' } },
			r1: { i6: { state: 'MERGED' } },
		});

		await resolver.prefetch([
			{ ...repo, number: 1 },
			{ ...repo, number: 4 },
			{ ...repo, number: 5 },
			{ ...repo, number: 4 },
			{ owner: 'other', repo: 'repo', number: 6 },
		]);

		expect(graphql).toHaveBeenCalledTimes(1);
		expect(await resolver.get({ ...repo, number: 4 })).toEqual(
			'closed'
		);
		expect(await resolver.get({ ...repo, number: 5 })).toEqual('open');
		expect(
			await resolver.get({ owner: 'other', repo: 'repo', number: 6 })
		).toEqual('closed');
		expect(graphql).toHaveBeenCalledTimes(1);
	});

	it('reports missing issues as unknown', async () => {
		// GraphQL errors come with partial data
		graphql.mockRejectedValue(
			Object.assign(new Error('Not found'), {
				errors: [{ type: 'NOT_FOUND' }],
				data: { r0: { i4: null } },
			})
		);

		expect(await resolver.get({ ...repo, number: 4 })).toEqual(
			'unknown'
		);
	});

	it('rethrows other errors', async () => {
		graphql.mockRejectedValue(
			Object.assign(new Error('Bad credentials'), { status: 401 })
		);

		await expect(resolver.get({ ...repo, number: 4 })).rejects.toThrow(
			'Bad credentials'
		);
	});
});

describe('IssueManager', () => {
	let gh: GithubClient;
	let manager: IssueManager;

	const repo = {
		owner: 'Microsoft',
		repo: 'vscode',
	};

	const config = {
		actionName: 'my-action',
		label: 'my-label',
		commentSignature: '<action-signature>',
		commit_status: 'on',
	} as ActionContext['config'];

	beforeEach(() => {
		gh = {
			rest: {
				issues: {
					addLabels: jest.fn() as any,
					removeLabel: jest.fn() as any,
					deleteComment: jest.fn() as any,
					updateComment: jest.fn() as any,
					createComment: jest.fn() as any,
				},
				repos: {
					createCommitStatus: jest.fn() as any,
				},
			},
		} as unknown as GithubClient;

		manager = new IssueManager(gh, repo, config);
	});

	describe('labels', () => {
		it('only adds missing labels', async () => {
			await manager.addLabel({
				number: 1,
				labels: ['my-label'],
			} as any);
			expect(gh.rest.issues.addLabels).not.toHaveBeenCalled();

			await manager.addLabel({ number: 1, labels: ['other'] } as any);
			expect(gh.rest.issues.addLabels).toHaveBeenCalledWith({
				...repo,
				issue_number: 1,
				labels: ['my-label'],
			});
		});

		it('only removes existing labels', async () => {
			await manager.removeLabel({ number: 1, labels: [] } as any);
			expect(gh.rest.issues.removeLabel).not.toHaveBeenCalled();

			await manager.removeLabel({
				number: 1,
				labels: ['my-label'],
			} as any);
			expect(gh.rest.issues.removeLabel).toHaveBeenCalledWith({
				...repo,
				issue_number: 1,
				name: 'my-label',
			});
		});
	});

	describe('updateCommitStatus', () => {
		const pr = (commitStatus: any = null) =>
			({
				number: 141,
				isPullRequest: true,
				headSha: '<commit-sha>',
				commitStatus,
			} as any);

		it('ignores non-PRs', async () => {
			await manager.updateCommitStatus({ number: 141 } as any, []);
			expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
		});

		it('does nothing when disabled', async () => {
			manager = new IssueManager(gh, repo, {
				...config,
				commit_status: 'off',
			});
			await manager.updateCommitStatus(pr(), []);
			expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
		});

		it('sets the correct status on success', async () => {
			await manager.updateCommitStatus(pr(), []);

			expect(gh.rest.repos.createCommitStatus).toHaveBeenCalledWith({
				...repo,
				description: 'No dependencies',
				state: 'success',
				sha: '<commit-sha>',
				context: config.actionName,
			});
		});

		it('sets the correct status on pending', async () => {
			await manager.updateCommitStatus(pr(), [
				{ repo: 'repo', owner: 'owner', number: 999, blocker: true },
				{ blocker: true } as any,
				{ blocker: true } as any,
			]);

			expect(gh.rest.repos.createCommitStatus).toHaveBeenCalledWith({
				...repo,
				description: 'Blocked by owner/repo#999 and 2 more issues',
				state: 'pending',
				sha: '<commit-sha>',
				context: config.actionName,
			});
		});

		it('skips unchanged statuses', async () => {
			await manager.updateCommitStatus(
				pr({ state: 'SUCCESS', description: 'No dependencies' }),
				[]
			);
			expect(gh.rest.repos.createCommitStatus).not.toHaveBeenCalled();
		});
	});

	describe('writeComment', () => {
		const issue = {
			number: 141,
			comments: [
				{
					id: 2,
					body: `  Existing text\t\n${config.commentSignature}\n\n `,
				},
			],
		} as any;

		it('updates existing comment', async () => {
			const text = ' This is the updated text\n';
			await manager.writeComment(issue, text);

			expect(gh.rest.issues.updateComment).toHaveBeenCalledWith({
				...repo,
				body: text.trim() + '\n' + config.commentSignature,
				comment_id: 2,
			});

			expect(gh.rest.issues.deleteComment).not.toHaveBeenCalled();
			expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
		});

		it('creates a new comment if required', async () => {
			const text = ' This is the updated text\n';
			await manager.writeComment(issue, text, true);

			expect(gh.rest.issues.deleteComment).toHaveBeenCalledWith({
				...repo,
				comment_id: 2,
			});

			expect(gh.rest.issues.createComment).toHaveBeenCalledWith({
				...repo,
				issue_number: issue.number,
				body: text.trim() + '\n' + config.commentSignature,
			});

			expect(gh.rest.issues.updateComment).not.toHaveBeenCalled();
		});

		it('creates a comment if there is none', async () => {
			await manager.writeComment(
				{ number: 1, comments: [] } as any,
				'x'
			);

			expect(gh.rest.issues.createComment).toHaveBeenCalledWith({
				...repo,
				issue_number: 1,
				body: 'x\n' + config.commentSignature,
			});
		});

		it('exits early if the text is the same', async () => {
			const text = 'Existing text';
			await manager.writeComment(issue, text);
			await manager.writeComment(issue, text, true);

			expect(gh.rest.issues.updateComment).not.toHaveBeenCalled();
			expect(gh.rest.issues.deleteComment).not.toHaveBeenCalled();
			expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
		});
	});

	it('removes action comments', async () => {
		await manager.removeActionComments({
			number: 1,
			comments: [{ id: 5 }, { id: 6 }],
		} as any);

		expect(gh.rest.issues.deleteComment).toHaveBeenCalledTimes(2);
	});
});
