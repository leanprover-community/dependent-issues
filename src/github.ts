// Packages
import * as core from '@actions/core';

// Ours
import {
	Comment,
	CommitStatus,
	Dependency,
	GithubClient,
	Issue,
	Repository,
} from './types';

// Read operations go through the GraphQL API so that the state of all
// open issues/PRs (body, labels, comments, commit status) can be
// fetched in a handful of requests, rather than several REST requests
// per issue.

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 5;
const MAX_ATTEMPTS = 3;

// Number of dependencies to look up per request
const RESOLVE_BATCH_SIZE = 100;

export type FetchOptions = {
	signature: string;
	statusContext?: string;
};

const COMMENTS_FIELDS = `
	pageInfo { hasNextPage endCursor }
	nodes { databaseId body }
`;

const ISSUE_FIELDS = `
	id
	number
	body
	author { login }
	labels(first: 100) { nodes { name } }
	comments(first: 100) { ${COMMENTS_FIELDS} }
`;

const PULL_REQUEST_FIELDS = `
	${ISSUE_FIELDS}
	commits(last: 1) @include(if: $withStatus) {
		nodes {
			commit {
				oid
				status { context(name: $statusContext) { state description } }
			}
		}
	}
`;

// Variables used by PULL_REQUEST_FIELDS
const STATUS_VARIABLES =
	', $withStatus: Boolean!, $statusContext: String!';

function statusVariableValues(options: FetchOptions) {
	return {
		withStatus: Boolean(options.statusContext),
		statusContext: options.statusContext || '',
	};
}

type CommentsConnection = {
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: { databaseId: number; body: string }[];
};

type RawIssue = {
	id: string;
	number: number;
	body: string;
	author: { login: string } | null;
	labels: { nodes: { name: string }[] };
	comments: CommentsConnection;
	commits?: {
		nodes: {
			commit: {
				oid: string;
				status: { context: CommitStatus | null } | null;
			};
		}[];
	};
};

function isRetryable(error: any) {
	// Client errors (bad credentials, ...) won't go away
	if (error?.status >= 400 && error?.status < 500) {
		return false;
	}

	// GraphQL errors about the data (NOT_FOUND, FORBIDDEN, ...) carry a
	// `type` and are handled by the caller. Errors without one are
	// server-side failures, which GitHub reports with a 200 status, e.g.
	// "Something went wrong while executing your query. This may be the
	// result of a timeout, or it could be a GitHub bug."
	if (Array.isArray(error?.errors)) {
		return error.errors.some((e: any) => !e?.type);
	}

	return true;
}

// Retries failed requests. `fn` is given the page size to use, which
// is halved on each retry (large pages with many long comments can hit
// GitHub's GraphQL timeout).
async function withRetry<T>(
	fn: (pageSize: number) => Promise<T>,
	pageSize = DEFAULT_PAGE_SIZE
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(pageSize);
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
				throw error;
			}

			pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
			core.info(`Request failed (${error}). Retrying...`);
		}
	}
}

function isSigned(body: string, signature: string) {
	return body.trim().endsWith(signature);
}

function signedComments(
	connection: CommentsConnection,
	signature: string
): Comment[] {
	return connection.nodes
		.filter((comment) => isSigned(comment.body || '', signature))
		.map((comment) => ({ id: comment.databaseId, body: comment.body }));
}

function normalize(
	raw: RawIssue,
	isPullRequest: boolean,
	options: FetchOptions
): Issue {
	const issue: Issue = {
		number: raw.number,
		body: raw.body || '',
		isPullRequest,
		author: raw.author?.login,
		labels: raw.labels.nodes.map((label) => label.name),
		comments: signedComments(raw.comments, options.signature),
	};

	if (isPullRequest && raw.commits) {
		const commit = raw.commits.nodes[0]?.commit;
		issue.headSha = commit?.oid;
		issue.commitStatus = commit?.status?.context || null;
	}

	return issue;
}

// Fetches the remaining comments of issues with more than one page
// of comments (rare, so these are fetched one by one).
async function fetchRemainingComments(
	gh: GithubClient,
	raw: RawIssue,
	options: FetchOptions
) {
	let { pageInfo } = raw.comments;

	while (pageInfo.hasNextPage) {
		const result: any = await withRetry(
			(pageSize) =>
				gh.graphql(
					`query($id: ID!, $cursor: String, $pageSize: Int!) {
					node(id: $id) {
						... on Issue { comments(first: $pageSize, after: $cursor) { ${COMMENTS_FIELDS} } }
						... on PullRequest { comments(first: $pageSize, after: $cursor) { ${COMMENTS_FIELDS} } }
					}
				}`,
					{ id: raw.id, cursor: pageInfo.endCursor, pageSize }
				),
			100
		);

		const connection: CommentsConnection = result.node.comments;
		raw.comments.nodes.push(...connection.nodes);
		pageInfo = connection.pageInfo;
	}

	// Drop the non-signed comments early, we don't need them
	raw.comments.nodes = raw.comments.nodes.filter((comment) =>
		isSigned(comment.body || '', options.signature)
	);
}

async function fetchAll(
	gh: GithubClient,
	repo: Repository,
	kind: 'issues' | 'pullRequests',
	options: FetchOptions
): Promise<Issue[]> {
	const isPullRequest = kind === 'pullRequests';
	const fields = isPullRequest ? PULL_REQUEST_FIELDS : ISSUE_FIELDS;
	const statusVariables = isPullRequest ? STATUS_VARIABLES : '';

	const issues: Issue[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const result: any = await withRetry((pageSize) =>
			gh.graphql(
				`query($owner: String!, $repo: String!, $cursor: String, $pageSize: Int!${statusVariables}) {
					repository(owner: $owner, name: $repo) {
						${kind}(states: OPEN, first: $pageSize, after: $cursor) {
							pageInfo { hasNextPage endCursor }
							nodes { ${fields} }
						}
					}
				}`,
				{
					...repo,
					cursor,
					pageSize,
					...(isPullRequest && statusVariableValues(options)),
				}
			)
		);

		const connection = result.repository[kind];

		for (const raw of connection.nodes as RawIssue[]) {
			if (raw.comments.pageInfo.hasNextPage) {
				await fetchRemainingComments(gh, raw, options);
			}

			issues.push(normalize(raw, isPullRequest, options));
		}

		hasNextPage = connection.pageInfo.hasNextPage;
		cursor = connection.pageInfo.endCursor;
	}

	return issues;
}

/**
 * Fetches all open pull requests (and issues, if `includeIssues`).
 */
export async function fetchOpenIssues(
	gh: GithubClient,
	repo: Repository,
	includeIssues: boolean,
	options: FetchOptions
): Promise<Issue[]> {
	const pulls = await fetchAll(gh, repo, 'pullRequests', options);

	if (!includeIssues) {
		return pulls;
	}

	const issues = await fetchAll(gh, repo, 'issues', options);

	return [...issues, ...pulls].sort((a, b) => b.number - a.number);
}

/**
 * Fetches a single issue or pull request. Returns `undefined` if it
 * doesn't exist or isn't open.
 */
export async function fetchOpenIssue(
	gh: GithubClient,
	repo: Repository,
	number: number,
	options: FetchOptions
): Promise<Issue | undefined> {
	const result: any = await gh.graphql(
		`query($owner: String!, $repo: String!, $number: Int!${STATUS_VARIABLES}) {
			repository(owner: $owner, name: $repo) {
				issueOrPullRequest(number: $number) {
					__typename
					... on Issue { state ${ISSUE_FIELDS} }
					... on PullRequest { state ${PULL_REQUEST_FIELDS} }
				}
			}
		}`,
		{
			...repo,
			number,
			...statusVariableValues(options),
		}
	);

	const raw = result.repository.issueOrPullRequest;

	if (!raw || raw.state !== 'OPEN') {
		return undefined;
	}

	if (raw.comments.pageInfo.hasNextPage) {
		await fetchRemainingComments(gh, raw, options);
	}

	return normalize(raw, raw.__typename === 'PullRequest', options);
}

export type DependencyState = 'open' | 'closed' | 'unknown';

export function dependencyKey(dep: Dependency) {
	return `${dep.owner}/${dep.repo}#${dep.number}`.toLowerCase();
}

/**
 * Looks up the state of the given issues/PRs, batching many lookups
 * into a single GraphQL request. Dependencies that can't be found (or
 * aren't accessible with the given token) are reported as 'unknown'.
 */
export async function fetchDependencyStates(
	gh: GithubClient,
	deps: Dependency[]
): Promise<Map<string, DependencyState>> {
	const states = new Map<string, DependencyState>();

	for (let i = 0; i < deps.length; i += RESOLVE_BATCH_SIZE) {
		const batch = deps.slice(i, i + RESOLVE_BATCH_SIZE);

		// Group by repository, so that each repository is only
		// queried once per request
		const byRepo = new Map<string, Dependency[]>();
		for (const dep of batch) {
			const key = `${dep.owner}/${dep.repo}`.toLowerCase();
			byRepo.set(key, [...(byRepo.get(key) || []), dep]);
		}

		const repoQueries = [...byRepo.values()].map((repoDeps, r) => {
			const { owner, repo } = repoDeps[0];
			const items = repoDeps
				.map(
					(dep) =>
						`i${dep.number}: issueOrPullRequest(number: ${dep.number}) {
							... on Issue { state }
							... on PullRequest { state }
						}`
				)
				.join('\n');

			return `r${r}: repository(owner: ${JSON.stringify(
				owner
			)}, name: ${JSON.stringify(repo)}) { ${items} }`;
		});

		let data: any;
		try {
			data = await withRetry(() =>
				gh.graphql(`query { ${repoQueries.join('\n')} }`)
			);
		} catch (error: any) {
			// Missing issues/repositories are reported as errors, but
			// the rest of the data is still usable
			if (!error?.data) {
				throw error;
			}

			data = error.data;
		}

		[...byRepo.values()].forEach((repoDeps, r) => {
			for (const dep of repoDeps) {
				const item = data?.[`r${r}`]?.[`i${dep.number}`];

				states.set(
					dependencyKey(dep),
					!item?.state
						? 'unknown'
						: item.state === 'OPEN'
						? 'open'
						: 'closed'
				);
			}
		});
	}

	return states;
}
