/* eslint-disable @typescript-eslint/no-explicit-any */
import SubscriptionClass, {Repositories, SyncStatus} from "../models/subscription";
import {Subscription} from '../models';
import getJiraClient from '../jira/client';
import {getRepositorySummary} from './jobs';
import enhanceOctokit from '../config/enhance-octokit';
import statsd from '../config/statsd';
import getPullRequests from './pull-request';
import getBranches from './branches';
import getCommits from './commits';
import {Application} from 'probot';

const tasks = {
  pull: getPullRequests,
  branch: getBranches,
  commit: getCommits,
};
const taskTypes = Object.keys(tasks);

const updateNumberOfReposSynced = async (repos: Repositories, subscription: SubscriptionClass): Promise<void> => {
  const repoIds = Object.keys(repos);

  const syncedRepos = repoIds.filter((id) => {
    // all 3 statuses need to be complete for a repo to be fully synced
    const {
      pullStatus,
      branchStatus,
      commitStatus
    } = repos[id];
    return pullStatus === 'complete' && branchStatus === 'complete' && commitStatus === 'complete';
  });

  await subscription.update({repoSyncState: {numberOfSyncedRepos: syncedRepos.length}});
};

export const sortedRepos = (repos: Repositories) => Object.entries(repos).sort((a, b) => b[1].repository.updated_at - a[1].repository.updated_at);

// TODO: type Task
const getNextTask = async (subscription: SubscriptionClass) => {
  const {repos} = subscription.repoSyncState;
  await updateNumberOfReposSynced(repos, subscription);

  for (const [repositoryId, repoData] of sortedRepos(repos)) {
    const task = taskTypes.find(taskType => repoData[`${taskType}Status`] !== 'complete');
    if (!task) continue;
    const {
      repository,
      [getCursorKey(task)]: cursor
    } = repoData;
    return {
      task,
      repositoryId,
      repository,
      cursor,
    };
  }
  return undefined;
};

const upperFirst = str => str.substring(0, 1).toUpperCase() + str.substring(1);
const getCursorKey = jobType => `last${upperFirst(jobType)}Cursor`;

const updateJobStatus = async (app: Application, queues, jiraClient, job, edges, task, repositoryId: string) => {
  const {
    installationId,
    jiraHost
  } = job.data;
  // Get a fresh subscription instance
  const subscription = await Subscription.getSingleInstallation(jiraHost, installationId);

  // handle promise rejection when an org is removed during a sync
  if (subscription == null) {
    app.log('Organization has been deleted. Other active syncs will continue.');
    return;
  }

  const status = edges.length > 0 ? 'pending' : 'complete';
  app.log(`Updating job status for installationId=${installationId}, repositoryId=${repositoryId}, task=${task}, status=${status}`);
  subscription.set({
    repoSyncState: {
      repos: {
        [repositoryId]: {
          [`${task}Status`]: status
        }
      }
    }
  });
  if (edges.length > 0) {
    // there's more data to get
    subscription.set({
      repoSyncState: {
        repos: {
          [repositoryId]: {
            [getCursorKey(task)]: edges[edges.length - 1].cursor
          }
        }
      }
    });
    // await subscription.save();

    const {
      removeOnComplete,
      removeOnFail
    } = job.opts;
    const delay = Number(process.env.LIMITER_PER_INSTALLATION) || 1000;
    queues.installation.add(job.data, {
      attempts: 3,
      delay,
      removeOnComplete,
      removeOnFail,
    });
    // no more data (last page was processed of this job type)
  } else if (!(await getNextTask(subscription))) {
    subscription.set({syncStatus: SyncStatus.COMPLETE});
    let message = `Sync status for installationId=${installationId} is complete`;
    if (job.data.startTime !== undefined) {
      const endTime = Date.now();
      const timeDiff = endTime - Date.parse(job.data.startTime);
      message = `${message} startTime=${job.data.startTime} endTime=${endTime} diff=${timeDiff}`;

      // full_sync measures the duration from start to finish of a complete scan and sync of github issues translated to tickets
      // startTime will be passed in when this sync job is queued from the discovery
      statsd.histogram('full_sync', timeDiff);
    }
    app.log(message);

    try {
      await jiraClient.devinfo.migration.complete();
    } catch (err) {
      app.log.warn(err, 'Error sending the `complete` event to JIRA');
    }
  } else {
    app.log(`Sync status for installationId=${installationId} is pending`);
    const {
      removeOnComplete,
      removeOnFail
    } = job.opts;
    queues.installation.add(job.data, {
      attempts: 3,
      removeOnComplete,
      removeOnFail
    });
  }
  await subscription.save();
};

async function getEnhancedGitHub(app: Application, installationId) {
  const github = await app.auth(installationId);
  enhanceOctokit(github, app.log);
  return github;
}

export const processInstallation = (app: Application, queues) => async function (job) {
  const {
    installationId,
    jiraHost
  } = job.data;

  job.sentry.setUser({
    gitHubInstallationId: installationId,
    jiraHost
  });

  app.log(`Starting job for installationId=${installationId}`);

  const subscription = await Subscription.getSingleInstallation(jiraHost, installationId);
  if (!subscription) return;

  const jiraClient = await getJiraClient(subscription.jiraHost, installationId, app.log);
  const github = await getEnhancedGitHub(app, installationId);

  const nextTask = await getNextTask(subscription);
  if (!nextTask) {
    await subscription.update({syncStatus: 'COMPLETE'});
    return;
  }

  await subscription.update({syncStatus: 'ACTIVE'});

  const {
    task,
    repositoryId,
    cursor
  } = nextTask;
  let {repository} = nextTask;
  if (!repository) {
    // Old records don't have this info. New ones have it
    const {data: repo} = await github.request('GET /repositories/:id', {id: repositoryId});
    repository = getRepositorySummary(repo);
    await subscription.update({repoSyncState:{repos:{[repository.id]:{repository:repository}}}});
  }
  app.log(`Starting task for installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);

  const processor = tasks[task];

  const pagedProcessor = (perPage) => processor(github, repository, cursor, perPage);

  const handleGitHubError = (err) => {
    if (err.errors) {
      const ignoredErrorTypes = ['MAX_NODE_LIMIT_EXCEEDED'];
      const notIgnoredError = err.errors.filter(error => !ignoredErrorTypes.includes(error.type)).length;

      if (notIgnoredError) {
        throw (err);
      }
    } else {
      throw (err);
    }
  };

  const execute = async () => {
    for (const perPage of [20,
      10,
      5,
      1]) {
      try {
        return await pagedProcessor(perPage);
      } catch (err) {
        handleGitHubError(err);
      }
    }
    throw new Error(`Error processing GraphQL query: installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);
  };

  try {
    const {
      edges,
      jiraPayload
    } = await execute();
    if (jiraPayload) {
      try {
        await jiraClient.devinfo.repository.update(jiraPayload, {preventTransitions: true});
      } catch (err) {
        if (err.response && err.response.status === 400) {
          job.sentry.setExtra('Response body', err.response.data.errorMessages);
          job.sentry.setExtra('Jira payload', err.response.data.jiraPayload);
        }

        if (err.request) {
          job.sentry.setExtra('Request', {
            host: err.request.domain,
            path: err.request.path,
            method: err.request.method
          });
        }

        if (err.response) {
          job.sentry.setExtra('Response', {
            status: err.response.status,
            statusText: err.response.statusText,
            body: err.response.body,
          });
        }

        throw err;
      }
    }
    await updateJobStatus(app, queues, jiraClient, job, edges, task, repositoryId);
  } catch (err) {
    const rateLimit = +(err.headers && err.headers['x-ratelimit-reset']);
    const delay = Math.max(Date.now() - rateLimit * 1000, 0);
    if (delay) { // if not NaN or 0
      app.log(`Delaying job for ${delay}ms installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);
      const {
        removeOnComplete,
        removeOnFail
      } = job.opts;
      queues.installation.add(job.data, {
        delay,
        removeOnComplete,
        removeOnFail
      });
      return;
    }
    if (String(err).includes('connect ETIMEDOUT')) {
      // There was a network connection issue.
      // Add the job back to the queue with a 5 second delay
      app.log(`ETIMEDOUT error, retrying in 5 seconds: installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);
      const {
        removeOnComplete,
        removeOnFail
      } = job.opts;
      queues.installation.add(job.data, {
        delay: 5000,
        removeOnComplete,
        removeOnFail
      });
      return;
    }
    if (String(err.message).includes('You have triggered an abuse detection mechanism')) {
      // Too much server processing time, wait 60 seconds and try again
      app.log(`Abuse detection triggered. Retrying in 60 seconds: installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);
      const {
        removeOnComplete,
        removeOnFail
      } = job.opts;
      queues.installation.add(job.data, {
        delay: 60000,
        removeOnComplete,
        removeOnFail
      });
      return;
    }
    // Checks if parsed error type is NOT_FOUND: https://github.com/octokit/graphql.js/tree/master#errors
    const isNotFoundError = err.errors && err.errors.filter(error => error.type === 'NOT_FOUND').length;
    if (isNotFoundError) {
      app.log.info(`Repository deleted after discovery, skipping initial sync: installationId=${installationId}, repositoryId=${repositoryId}, task=${task}`);

      const edgesLeft = []; // No edges left to process since the repository doesn't exist
      await updateJobStatus(app, queues, jiraClient, job, edgesLeft, task, repositoryId);
      return;
    }

    await subscription.update({syncStatus: 'FAILED'});
    throw err;
  }
};