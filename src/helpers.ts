// Packages
import { dequal } from 'dequal';
import uniqBy from 'lodash.uniqby';
import IssueRegex from 'issue-regex';

// Ours
import {
	Dependency,
	Issue,
	Repository,
	GithubClient,
	ActionContext,
} from './types';
import {
	DependencyState,
	dependencyKey,
	fetchDependencyStates,
} from './github';

export function formatDependency(dep: Dependency, repo?: Repository) {
	const depRepo = { owner: dep.owner, repo: dep.repo };

	if (dequal(depRepo, repo)) {
		return `#${dep.number}`;
	}

	return `${dep.owner}/${dep.repo}#${dep.number}`;
}

export class DependencyExtractor {
	private regex: RegExp;
	private issueRegex = IssueRegex();
	private urlRegex =
		/https?:\/\/github\.com\/(?:\w[\w-.]+\/\w[\w-.]+|\B)\/(?:issues|pull)\/[1-9]\d*\b/;
	private keywordRegex: RegExp;

	constructor(private repo: Repository, keywords: string[]) {
		this.keywordRegex = new RegExp(
			keywords.map((kw) => kw.trim().replace(/\s+/g, '\\s+')).join('|'),
			'i'
		);

		this.regex = this.buildRegex();
	}

	private buildRegex() {
		const flags = this.issueRegex.flags + 'i';
		const ref = `${this.issueRegex.source}|${this.urlRegex.source}`;

		return new RegExp(
			`(?:${this.keywordRegex.source})\\s+(${ref})`,
			flags
		);
	}

	private deduplicate(deps: Dependency[]) {
		return uniqBy(deps, formatDependency);
	}

	private match(text: string) {
		const references = text.match(this.regex) || [];

		return references.map((ref) => {
			// Get rid of keywords now
			ref = ref.replace(this.keywordRegex, '').trim();

			// Remove full URL if found. Should return either '#number' or
			// 'owner/repo#number' format
			return ref
				.replace(/https?:\/\/github\.com\//i, '')
				.replace(/\/(issues|pull)\//i, '#');
		});
	}

	public fromIssue(issue: Issue) {
		const dependencies: Dependency[] = [];

		for (const issueLink of this.match(issue.body || '')) {
			// Can be '#number' or 'owner/repo#number'
			// 1) #number
			if (issueLink.startsWith('#')) {
				const issueNumber = Number(issueLink.slice(1));

				// Prevent self-referencing
				if (issueNumber !== issue.number) {
					dependencies.push({
						...this.repo,
						number: issueNumber,
					});
				}

				continue;
			}

			// 2) owner/repo#number
			const [owner, rest] = issueLink.split('/');
			const [repoName, issueNumber] = rest.split('#');

			dependencies.push({
				owner,
				repo: repoName,
				number: Number(issueNumber),
			});
		}

		return this.deduplicate(dependencies);
	}
}

export class DependencyResolver {
	private states = new Map<string, DependencyState>();

	constructor(
		private gh: GithubClient,
		issues: Issue[],
		repo: Repository
	) {
		// The known issues are all open
		issues.forEach((issue) => {
			this.states.set(
				dependencyKey({ ...repo, number: issue.number }),
				'open'
			);
		});
	}

	/**
	 * Fetches the state of all the given dependencies that aren't
	 * known yet, in as few requests as possible.
	 */
	async prefetch(deps: Dependency[]) {
		const unknown = uniqBy(
			deps.filter((dep) => !this.states.has(dependencyKey(dep))),
			dependencyKey
		);

		if (unknown.length === 0) {
			return;
		}

		const states = await fetchDependencyStates(this.gh, unknown);
		states.forEach((state, key) => this.states.set(key, state));
	}

	async get(dep: Dependency): Promise<DependencyState> {
		await this.prefetch([dep]);

		return this.states.get(dependencyKey(dep)) || 'unknown';
	}
}

export class IssueManager {
	constructor(
		private gh: GithubClient,
		private repo: Repository,
		private config: ActionContext['config']
	) {}

	hasLabel(issue: Issue) {
		return issue.labels.includes(this.config.label);
	}

	async addLabel(issue: Issue) {
		if (!this.hasLabel(issue)) {
			await this.gh.rest.issues.addLabels({
				...this.repo,
				issue_number: issue.number,
				labels: [this.config.label],
			});
		}
	}

	async removeLabel(issue: Issue) {
		if (this.hasLabel(issue)) {
			await this.gh.rest.issues.removeLabel({
				...this.repo,
				issue_number: issue.number,
				name: this.config.label,
			});
		}
	}

	/**
	 * Adds a unique text at the end of the text to distinguish the
	 * action own's comments.
	 */
	private sign(text: string) {
		return text.trim() + '\n' + this.config.commentSignature;
	}

	private originalText(signed?: string) {
		if (!signed) {
			return '';
		}

		return signed
			.trim()
			.slice(0, -1 * this.config.commentSignature.length)
			.trim();
	}

	/**
	 * Renders the comment body, replacing the supported `{{ token }}`s.
	 * Unknown tokens are left as they are.
	 */
	public generateComment(issue: Issue, dependencies: Dependency[]) {
		// e.g:
		// * facebook/react#999
		// * ~~facebook/react#1~~
		const list = (deps: Dependency[], strikeResolved = false) =>
			deps
				.map((dep) => {
					const link = formatDependency(dep);
					return (
						'* ' +
						(strikeResolved && !dep.blocker ? `~~${link}~~` : link)
					);
				})
				.join('\n');

		const blockers = dependencies.filter((dep) => dep.blocker);
		const resolved = dependencies.filter((dep) => !dep.blocker);

		const tokens: Record<string, string> = {
			number: `${issue.number}`,
			dependencies: list(dependencies, true),
			blockers: list(blockers),
			resolved: list(resolved),
			dependency_count: `${dependencies.length}`,
			blocker_count: `${blockers.length}`,
			resolved_count: `${resolved.length}`,
		};

		return this.config.commentBody.replace(
			/\{\{\s*(\w+)\s*\}\}/g,
			(match, name: string) => tokens[name.toLowerCase()] ?? match
		);
	}

	/**
	 * Writes (or updates) the action comment. `issue.comments` must
	 * contain the existing action comments.
	 */
	async writeComment(issue: Issue, text: string, create = false) {
		const signedText = this.sign(text);
		const currentComment = issue.comments[0];

		// Exit early if the content is the same
		if (currentComment) {
			const newContent = text.trim();
			const existingContent = this.originalText(currentComment.body);

			if (existingContent === newContent) {
				return;
			}
		}

		// Delete old comment if necessary
		if (create && currentComment) {
			await this.gh.rest.issues.deleteComment({
				...this.repo,
				comment_id: currentComment.id,
			});
		}

		const commentParams = { ...this.repo, body: signedText };

		// Write comment
		currentComment && !create
			? await this.gh.rest.issues.updateComment({
					...commentParams,
					comment_id: currentComment.id,
			  })
			: await this.gh.rest.issues.createComment({
					...commentParams,
					issue_number: issue.number,
			  });
	}

	async removeActionComments(issue: Issue) {
		for (const comment of issue.comments) {
			await this.gh.rest.issues.deleteComment({
				...this.repo,
				comment_id: comment.id,
			});
		}
	}

	/**
	 * Sets the commit status of a PR's head commit, unless it already
	 * has the right status. Does nothing if commit statuses are
	 * disabled.
	 */
	async updateCommitStatus(issue: Issue, dependencies: Dependency[]) {
		if (
			!issue.isPullRequest ||
			!issue.headSha ||
			this.config.commit_status !== 'on'
		) {
			return;
		}

		const blockers = dependencies.filter((dep) => dep.blocker);
		const isBlocked = blockers.length > 0;
		const firstDependency = isBlocked
			? formatDependency(blockers[0], this.repo)
			: '';

		const description = !isBlocked
			? dependencies.length === 0
				? 'No dependencies'
				: 'All dependencies are resolved'
			: blockers.length == 1
			? `Blocked by ${firstDependency}`
			: `Blocked by ${firstDependency} and ${
					blockers.length - 1
			  } more issues`;

		const state = isBlocked ? 'pending' : 'success';

		if (
			issue.commitStatus?.state.toLowerCase() === state &&
			issue.commitStatus?.description === description
		) {
			return;
		}

		await this.gh.rest.repos.createCommitStatus({
			...this.repo,
			description,
			sha: issue.headSha,
			context: this.config.actionName,
			state,
		});
	}
}
