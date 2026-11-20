import {configFor} from './config';
import {DatabaseConnection} from './db/client';
import {purgeExpiredData} from './store/housekeeping';
import {sendDueReminders} from './store/push';

/**
 * Fires every minute and sends the reminders that have come due. Keep it in
 * sync with `triggers.crons` in wrangler.jsonc.
 */
export const REMINDER_CRON = '* * * * *';
/** Fires hourly at :17 and purges sessions and trash that expired. */
export const HOUSEKEEPING_CRON = '17 * * * *';

/** Sends due reminders every minute and purges expired data hourly. */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const config = configFor(env);
  const connection = new DatabaseConnection(env.HYPERDRIVE.connectionString);
  try {
    const db = await connection.get();
    const now = Date.now();
    switch (controller.cron) {
      case REMINDER_CRON:
        await sendDueReminders(db, env, config, now);
        break;
      case HOUSEKEEPING_CRON:
        await purgeExpiredData(db, config, now);
        break;
      default:
        console.error(
          JSON.stringify({msg: 'unknown cron', cron: controller.cron}),
        );
    }
  } finally {
    await connection.close();
  }
}
