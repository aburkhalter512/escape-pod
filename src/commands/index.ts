import { allowGuild } from './allowGuild.js'
import { allowOrganizer } from './allowOrganizer.js'
import { cancelPod } from './cancelPod.js'
import { concludePod } from './concludePod.js'
import { connectPtp } from './connectPtp.js'
import { requestTrust } from './requestTrust.js'
import { startPod } from './startPod.js'
import { subscribeGuild } from './subscribeGuild.js'
import { unsubscribeGuild } from './unsubscribeGuild.js'
import type { CommandHandler } from './types.js'

export const commandHandlers: Record<string, CommandHandler> = {
  'connect-ptp': connectPtp,
  'subscribe-guild': subscribeGuild,
  'unsubscribe-guild': unsubscribeGuild,
  'allow-organizer': allowOrganizer,
  'allow-guild': allowGuild,
  'request-trust': requestTrust,
  'start-pod': startPod,
  'cancel-pod': cancelPod,
  'conclude-pod': concludePod,
}
