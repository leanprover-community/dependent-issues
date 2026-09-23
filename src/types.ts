import { Octokit } from '@octokit/rest';
import * as github from '@actions/github';

export type GithubClient = Octokit;

export type Comment = {
	id: number;
	body: string;
};

export type CommitStatus = {
	state: string;
	description: string | null;
};

// A normalized view of an open issue or pull request, as fetched in
// bulk through the GraphQL API.
export type Issue = {
	number: number;
	body: string;
	isPullRequest: boolean;
	author?: string;
	labels: string[];
	// Comments written by this action (i.e. carrying its signature)
	comments: Comment[];
	// Only set for pull requests, and only when commit statuses are enabled
	headSha?: string;
	// `null` if the head commit has no status for our context
	commitStatus?: CommitStatus | null;
};

export type Dependency = Required<typeof github.context.issue> & {
	blocker?: boolean;
};
export type Repository = Required<typeof github.context.repo>;

export type Config = {
	actionName: string;
	commentBody: string;
	commentSignature: string;
	label: string;
	check_issues: string;
	ignore_dependabot: string;
	commit_status: string;
	keywords: string[];
};

export type ActionContext = {
	client: GithubClient;
	readOnlyClient: GithubClient;
	issues: Issue[];
	repo: Repository;
	config: Config;
};
