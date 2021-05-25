import Queue from 'bull';
import Sentry from '@sentry/node';
import Redis from 'ioredis';

import {discovery} from '../sync/discovery';
import {processInstallation} from '../sync/installation';
import {processPush} from '../transforms/push';
import metricsJob from './metrics-job';
import statsd from '../config/statsd';
import getRedisInfo from '../config/redis-info';
import app from './app';
import AxiosErrorEventDecorator from '../models/axios-error-event-decorator';
import SentryScopeProxy from '../models/sentry-scope-proxy';
import newrelic from 'newrelic';

const {CONCURRENT_WORKERS = 1} = process.env;
const client = new Redis(getRedisInfo('client').redisOptions);
const subscriber = new Redis(getRedisInfo('subscriber').redisOptions);

function measureElapsedTime(startTime, tags) {
  const endTime = Date.now();
  const timeDiff = endTime - startTime;
  statsd.histogram('job_duration', timeDiff, tags);
}

const queueOpts = {
  defaultJobOptions: {
    removeOnComplete: true,
  },
  redis: getRedisInfo('bull').redisOptions,
  createClient: (type, redisOpts = {}) => {
    let redisInfo;
    switch (type) {
      case 'client':
        return client;
      case 'subscriber':
        return subscriber;
      default:
        redisInfo = Object.assign({}, redisOpts);
        redisInfo.connectionName = 'bclient';
        return new Redis(redisInfo);
    }
  },
};

// Setup queues
export const queues = {
  discovery: new Queue('Content discovery', queueOpts),
  installation: new Queue('Initial sync', queueOpts),
  push: new Queue('Push transformation', queueOpts),
  metrics: new Queue('Metrics', queueOpts),
};

// Setup error handling for queues
Object.keys(queues).forEach(name => {
  const queue = queues[name];

  queue.on('active', (job) => {
    app.log.info(`Job started name=${name} id=${job.id}`);
    job.meta_time_start = new Date();
  });

  queue.on('completed', (job) => {
    app.log.info(`Job completed name=${name} id=${job.id}`);
    measureElapsedTime(job.meta_time_start, {queue: name, status: 'completed'});
  });

  queue.on('failed', async (job) => {
    app.log.error(`Error occurred while processing job id=${job.id} on queue name=${name}`);
    measureElapsedTime(job.meta_time_start, {queue: name, status: 'failed'});
  });

  queue.on('error', (err) => {
    app.log.error(`Error occurred while processing queue ${name}: ${err}`);

    Sentry.setTag('queue', name);
    Sentry.captureException(err);
  });
});

/**
 * Return an async function that assigns a Sentry hub to `job.sentry` and sends exceptions.
 */
const sentryMiddleware = (jobHandler) => async (job) => {
  job.sentry = new Sentry.Hub(Sentry.getCurrentHub().getClient());
  job.sentry.configureScope(scope => scope.addEventProcessor(AxiosErrorEventDecorator.decorate));
  job.sentry.configureScope(scope => scope.addEventProcessor(SentryScopeProxy.processEvent));

  try {
    await jobHandler(job);
  } catch (err) {
    job.sentry.setExtra('job', {
      id: job.id,
      attemptsMade: job.attemptsMade,
      timestamp: new Date(job.timestamp),
      data: job.data,
    });

    job.sentry.setTag('jiraHost', job.data.jiraHost);
    job.sentry.setTag('queue', job.queue.name);
    job.sentry.captureException(err);

    throw err;
  }
};

/**
 * Return an async function that sends timing data to NewRelic
 */
const newrelicMiddleware = (jobHandler) => async (job) => {
  newrelic.startBackgroundTransaction(`job ${job.queue.name}`, 'worker queue', async () => {
    const transaction = newrelic.getTransaction();
    newrelic.addCustomAttributes({
      Queue: job.queue.name,
      'Job Id': job.id,

      // NewRelic wants 'primitive' types. Sending a hash will be dropped
      'Job Arguments': JSON.stringify(job.data),
      'Job Options': JSON.stringify(job.opts),
    });

    try {
      await jobHandler(job);
    } finally {
      transaction.end();
    }
  });
};

const commonMiddleware = (jobHandler) => sentryMiddleware(newrelicMiddleware(jobHandler));

export const start = (): void => {
  queues.discovery.process(5, commonMiddleware(discovery(app, queues)));
  queues.installation.process(Number(CONCURRENT_WORKERS), commonMiddleware(processInstallation(app, queues)));
  queues.push.process(Number(CONCURRENT_WORKERS), commonMiddleware(processPush(app)));
  queues.metrics.process(1, commonMiddleware(metricsJob));

  app.log(`Worker process started with ${CONCURRENT_WORKERS} CONCURRENT WORKERS`);
};

export const stop = async (): Promise<void> => {
  await Promise.all([
    queues.discovery.close(),
    queues.installation.close(),
    queues.push.close(),
    queues.metrics.close(),
  ]);
}