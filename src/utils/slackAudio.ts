/**
 * Slack audio upload utility.
 *
 * Uploads audio buffers as voice clips to Slack channels/threads.
 */
import { log } from './logger';

const audioLog = log.withScope('slack-audio');

/**
 * Upload an audio buffer to Slack as a file in a thread.
 */
export async function uploadAudioToSlack(
  client: any,
  channelId: string,
  audioBuffer: Buffer,
  phrase: string,
  threadTs?: string,
): Promise<void> {
  try {
    const filename = `pronunciation-${Date.now()}.mp3`;
    const title = `Pronunciation: "${phrase}"`;

    await client.files.uploadV2({
      channel_id: channelId,
      file: audioBuffer,
      filename,
      title,
      initial_comment: `🔊 *${phrase}*`,
      thread_ts: threadTs,
    });

    audioLog.info(`Uploaded pronunciation audio for "${phrase}" to ${channelId}`);
  } catch (err) {
    audioLog.error(`Failed to upload audio: ${err}`);
  }
}
