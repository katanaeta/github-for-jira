import 'newrelic';
import './config/env';
import initializeSentry from './config/sentry';
import throng from 'throng';
import getRedisInfo from './config/redis-info';
import PrivateKey from 'probot/lib/private-key';
import {createProbot} from 'probot';
import App from './configure-robot';

const {redisOptions} = getRedisInfo('probot');
initializeSentry();

const probot = createProbot({
  id: parseInt(process.env.APP_ID),
  secret: process.env.WEBHOOK_SECRET,
  cert: PrivateKey.findPrivateKey(),
  port: parseInt(process.env.TUNNEL_PORT) || parseInt(process.env.PORT) || 3000,
  webhookPath: '/github/events',
  webhookProxy: process.env.WEBHOOK_PROXY_URL,
  redisConfig: redisOptions,
});

/**
 * Start the probot worker.
 */
function start() {
  // We are always behind a proxy, but we want the source IP
  probot.server.set('trust proxy', true);
  probot.load(App);
  probot.start();
}

// Start clustered server
throng({
  workers: parseInt(process.env.WEB_CONCURRENCY) || 1,
  lifetime: Infinity,
}, start);