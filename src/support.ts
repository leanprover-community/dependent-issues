// Ours
import { Issue } from './types';

/**
 * Workflows triggered by Dependabot PRs will run with read-only
 * permissions. We need to ignore them.
 *
 * https://bit.ly/2NDzjUM
 */
function isDependabotPR(issue: Issue) {
	// GraphQL reports bot logins without the `[bot]` suffix
	return ['dependabot', 'dependabot[bot]'].includes(issue.author || '');
}

export function isSupported(
	config: { ignore_dependabot: string },
	issue: Issue
) {
	return !(config.ignore_dependabot === 'on' && isDependabotPR(issue));
}
