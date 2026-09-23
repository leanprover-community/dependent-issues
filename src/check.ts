// Packages
import * as core from '@actions/core';

// Ours
import { ActionContext, Dependency, Issue } from './types';
import { isSupported } from './support';

import {
	IssueManager,
	DependencyResolver,
	DependencyExtractor,
	formatDependency,
} from './helpers';

async function checkIssue(
	issue: Issue,
	dependencies: Dependency[],
	context: ActionContext,
	manager: IssueManager,
	resolver: DependencyResolver
) {
	const { config, repo } = context;

	if (dependencies.length === 0) {
		core.info('No dependencies found. Running clean-up');
		await manager.removeLabel(issue);
		await manager.removeActionComments(issue);
		await manager.updateCommitStatus(issue, []);
		return;
	}

	core.info(
		`Depends on: ${dependencies
			.map((dep) => formatDependency(dep, repo))
			.join(', ')}`
	);

	dependencies = await Promise.all(
		dependencies.map(async (dep) => {
			const state = await resolver.get(dep);

			if (state === 'unknown') {
				core.warning(
					`#${issue.number}: could not find ${formatDependency(
						dep,
						repo
					)}. Treating it as a blocker`
				);
			}

			return { ...dep, blocker: state !== 'closed' };
		})
	);

	const isBlocked = dependencies.some((dep) => dep.blocker);

	core.info(
		`Blocked by: ${dependencies
			.filter((dep) => dep.blocker)
			.map((dep) => formatDependency(dep, repo))
			.join(', ')}`
	);

	// Toggle label
	isBlocked
		? await manager.addLabel(issue)
		: await manager.removeLabel(issue);

	await manager.writeComment(
		issue,
		manager.generateComment(dependencies, dependencies, config),
		!isBlocked
	);

	await manager.updateCommitStatus(issue, dependencies);
}

export async function checkIssues(context: ActionContext) {
	const { client, readOnlyClient, config, repo } = context;

	const manager = new IssueManager(client, repo, config);
	const extractor = new DependencyExtractor(repo, config.keywords);
	const resolver = new DependencyResolver(
		readOnlyClient,
		context.issues,
		repo
	);

	const issues = context.issues.filter((issue) => {
		if (!isSupported(config, issue)) {
			core.info(`#${issue.number}: unsupported. Skipped`);
			return false;
		}

		return true;
	});

	const dependencies = new Map(
		issues.map((issue) => [issue, extractor.fromIssue(issue)])
	);

	// Look up the state of all dependencies at once
	await resolver.prefetch([...dependencies.values()].flat());

	const failed: number[] = [];

	for (const issue of issues) {
		core.startGroup(`Checking #${issue.number}`);

		try {
			await checkIssue(
				issue,
				dependencies.get(issue) || [],
				context,
				manager,
				resolver
			);
		} catch (error) {
			// Carry on with the other issues, and fail at the end
			core.error(`#${issue.number}: ${error}`);
			failed.push(issue.number);
		}

		core.endGroup();
	}

	if (failed.length > 0) {
		throw new Error(
			`Failed to update ${failed.length} issue(s): ${failed
				.map((number) => `#${number}`)
				.join(', ')}`
		);
	}
}
