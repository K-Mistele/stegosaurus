import { Context, Effect, Layer } from 'effect';

import { GitHubApiClient } from './api/GitHubApiClient';
import { addIssueLabels } from './api/AddIssueLabels';
import { addPullRequestLabels } from './api/AddPullRequestLabels';
import { addReaction } from './api/AddReaction';
import { closeIssue } from './api/CloseIssue';
import { closePullRequest } from './api/ClosePullRequest';
import { createPullRequest } from './api/CreatePullRequest';
import { deleteComment } from './api/DeleteComment';
import { downloadActionsJobLog } from './api/DownloadActionsJobLog';
import { fetchActionsJob } from './api/FetchActionsJob';
import { fetchCheckRun } from './api/FetchCheckRun';
import { fetchIssue } from './api/FetchIssue';
import { fetchPullRequest } from './api/FetchPullRequest';
import { fetchPullRequestDiff } from './api/FetchPullRequestDiff';
import { fetchUserAccess } from './api/FetchUserAccess';
import { listCheckRunAnnotations } from './api/ListCheckRunAnnotations';
import { listCheckRunsForRef } from './api/ListCheckRunsForRef';
import { listIssueComments } from './api/ListIssueComments';
import { listIssueLabels } from './api/ListIssueLabels';
import { listPullRequestComments } from './api/ListPullRequestComments';
import { listPullRequestCommits } from './api/ListPullRequestCommits';
import { listPullRequestFiles } from './api/ListPullRequestFiles';
import { listPullRequestLabels } from './api/ListPullRequestLabels';
import { listPullRequestReviewComments } from './api/ListPullRequestReviewComments';
import { listPullRequestReviews } from './api/ListPullRequestReviews';
import { listPullRequestsForBranch } from './api/ListPullRequestsForBranch';
import { listRepositoryLabels } from './api/ListRepositoryLabels';
import { mergePullRequest } from './api/MergePullRequest';
import { postIssueComment } from './api/PostIssueComment';
import { postPullRequestComment } from './api/PostPullRequestComment';
import { postPullRequestReviewComment } from './api/PostPullRequestReviewComment';
import { removeAllIssueLabels } from './api/RemoveAllIssueLabels';
import { removeAllPullRequestLabels } from './api/RemoveAllPullRequestLabels';
import { removeIssueLabel } from './api/RemoveIssueLabel';
import { removePullRequestLabel } from './api/RemovePullRequestLabel';
import { removeReaction } from './api/RemoveReaction';
import { reopenIssue } from './api/ReopenIssue';
import { reopenPullRequest } from './api/ReopenPullRequest';
import { replyToReviewComment } from './api/ReplyToReviewComment';
import { resolveActionsJob } from './api/ResolveActionsJob';
import { setIssueLabels } from './api/SetIssueLabels';
import { setPullRequestLabels } from './api/SetPullRequestLabels';
import { updateComment } from './api/UpdateComment';
import type { GitHubApiOperations } from './GitHubApiContract';

export * from './GitHubApiContract';

/** Application-wide GitHub operations. Transport, credentials, pagination, and decoding stay behind this service. */
export class GitHubApi extends Context.Service<GitHubApi, GitHubApiOperations>()(
    '@stegosaurus/channels-github/GitHubApi',
    {
        make: Effect.gen(function* () {
            const services = yield* Effect.context<GitHubApiClient>();

            const run = <A, E>(effect: Effect.Effect<A, E, GitHubApiClient>) => Effect.provide(effect, services);

            return {
                addIssueLabels: (input) => run(addIssueLabels(input)),
                addPullRequestLabels: (input) => run(addPullRequestLabels(input)),
                addReaction: (input) => run(addReaction(input)),
                closeIssue: (input) => run(closeIssue(input)),
                closePullRequest: (input) => run(closePullRequest(input)),
                deleteComment: (input) => run(deleteComment(input)),
                downloadActionsJobLog: (input) => run(downloadActionsJobLog(input)),
                fetchActionsJob: (input) => run(fetchActionsJob(input)),
                fetchCheckRun: (input) => run(fetchCheckRun(input)),
                fetchIssue: (input) => run(fetchIssue(input)),
                fetchPullRequest: (input) => run(fetchPullRequest(input)),
                fetchPullRequestDiff: (input) => run(fetchPullRequestDiff(input)),
                fetchUserAccess: (input) => run(fetchUserAccess(input)),
                listCheckRunAnnotations: (input) => run(listCheckRunAnnotations(input)),
                listCheckRunsForRef: (input) => run(listCheckRunsForRef(input)),
                listIssueComments: (input) => run(listIssueComments(input)),
                listIssueLabels: (input) => run(listIssueLabels(input)),
                listPullRequestComments: (input) => run(listPullRequestComments(input)),
                listPullRequestCommits: (input) => run(listPullRequestCommits(input)),
                listPullRequestFiles: (input) => run(listPullRequestFiles(input)),
                listPullRequestLabels: (input) => run(listPullRequestLabels(input)),
                listPullRequestReviewComments: (input) => run(listPullRequestReviewComments(input)),
                listPullRequestReviews: (input) => run(listPullRequestReviews(input)),
                listRepositoryLabels: (input) => run(listRepositoryLabels(input)),
                mergePullRequest: (input) => run(mergePullRequest(input)),
                listPullRequestsForBranch: (input) => run(listPullRequestsForBranch(input)),
                createPullRequest: (input) => run(createPullRequest(input)),
                postIssueComment: (input) => run(postIssueComment(input)),
                postPullRequestComment: (input) => run(postPullRequestComment(input)),
                postPullRequestReviewComment: (input) => run(postPullRequestReviewComment(input)),
                removeAllIssueLabels: (input) => run(removeAllIssueLabels(input)),
                removeAllPullRequestLabels: (input) => run(removeAllPullRequestLabels(input)),
                removeIssueLabel: (input) => run(removeIssueLabel(input)),
                removePullRequestLabel: (input) => run(removePullRequestLabel(input)),
                removeReaction: (input) => run(removeReaction(input)),
                reopenIssue: (input) => run(reopenIssue(input)),
                reopenPullRequest: (input) => run(reopenPullRequest(input)),
                replyToReviewComment: (input) => run(replyToReviewComment(input)),
                resolveActionsJob: (input) => run(resolveActionsJob(input)),
                setIssueLabels: (input) => run(setIssueLabels(input)),
                setPullRequestLabels: (input) => run(setPullRequestLabels(input)),
                updateComment: (input) => run(updateComment(input)),
            };
        }),
    },
) {
    static readonly layer = Layer.effect(this, this.make);
}
