import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://:RedisTest12345@172.236.224.19:6380';

// Publisher client (for sending cancel signals)
export const redisPub = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

// Subscriber client (dedicated connection, cannot be used for commands)
export const redisSub = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

redisPub.on('error', (err) => console.error('[redis-pub] error:', err.message));
redisSub.on('error', (err) => console.error('[redis-sub] error:', err.message));

const CANCEL_CHANNEL_PREFIX = 'supermodel:cancel:';

/**
 * Publish a cancel signal for an execution.
 * All replicas subscribed to this channel will abort the execution if they hold it.
 */
export async function publishCancel(executionId: string): Promise<void> {
  try {
    await redisPub.publish(`${CANCEL_CHANNEL_PREFIX}${executionId}`, '1');
  } catch (err: any) {
    console.error('[redis] publishCancel failed:', err.message);
    // Non-fatal: local abort already handled by caller
  }
}

/**
 * Subscribe to cancel signals for an execution.
 * Returns an unsubscribe function to clean up when execution finishes.
 */
export function subscribeCancel(executionId: string, onCancel: () => void): () => void {
  const channel = `${CANCEL_CHANNEL_PREFIX}${executionId}`;

  const handler = (_ch: string, _msg: string) => {
    onCancel();
  };

  redisSub.subscribe(channel).catch((err) =>
    console.error('[redis] subscribe error:', err.message)
  );
  redisSub.on('message', handler);

  // Return cleanup function
  return () => {
    redisSub.unsubscribe(channel).catch(() => {});
    redisSub.off('message', handler);
  };
}

export async function connectRedis(): Promise<void> {
  await Promise.all([redisPub.connect(), redisSub.connect()]);
  console.log('[redis] connected (pub + sub)');
}
