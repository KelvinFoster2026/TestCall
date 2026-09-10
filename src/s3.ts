import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

/**
 * Object storage for the synthesized audio.
 *
 * ElevenLabs hands back raw mp3 bytes and Twilio's <Play> can only fetch a URL,
 * so something has to sit between them. These are the three methods the call
 * path uses out of the source's much larger S3StorageService, ported as-is.
 *
 * Nothing here throws. Storage is best effort: a failure costs a line its nicer
 * voice, never the call.
 */

let client: S3Client | null = null;

function s3(): S3Client {
  if (!config.s3.region || !config.s3.bucket) {
    throw new Error('AWS_REGION and AWS_S3_BUCKET must be set to store call audio');
  }
  if (!client) {
    client = new S3Client({
      region: config.s3.region,
      // Omitted entirely when unset, so the SDK's own credential chain (a
      // profile, an instance role) still works.
      ...(config.s3.accessKeyId && config.s3.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.s3.accessKeyId,
              secretAccessKey: config.s3.secretAccessKey,
            },
          }
        : {}),
    });
  }
  return client;
}

export function isS3Configured(): boolean {
  return Boolean(config.s3.region && config.s3.bucket);
}

export interface UploadResult {
  success: boolean;
  key?: string;
  error?: string;
}

export interface SignedUrlResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Generated call speech. Unlike a user upload this is bytes we produced, so it
 * skips mime validation and is written straight through.
 */
export async function uploadCallAudio(audio: Buffer, fileKey?: string): Promise<UploadResult> {
  const key =
    fileKey ??
    `consult-calls/audio/${Date.now()}-${Math.random().toString(16).slice(2, 18)}.mp3`;
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: audio,
        ContentType: 'audio/mpeg',
      }),
    );
    return { success: true, key };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`Failed to upload call audio: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Whether a previously synthesized clip is still sitting at this key.
 *
 * Answers false on any error, including a missing bucket: a cache that cannot be
 * read is a cache miss, never a failed call.
 */
export async function callAudioExists(fileKey: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: fileKey }));
    return true;
  } catch {
    return false;
  }
}

export async function generateSignedUrl(
  fileKey: string,
  expiresIn = 3600,
): Promise<SignedUrlResult> {
  try {
    const command = new GetObjectCommand({ Bucket: config.s3.bucket, Key: fileKey });
    const url = await getSignedUrl(s3(), command, { expiresIn });
    return { success: true, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown signed URL error';
    return { success: false, error: message };
  }
}
