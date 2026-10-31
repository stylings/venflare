import { Effect } from "effect";

import { RequestRejected, StorageError } from "#core/errors";
import type { StoredSettings } from "#core/settings/store";

// r2 multipart minimum; the final part can be smaller
export const encryptedPartSize = 5 * 1024 * 1024;

const magic = new Uint8Array([0x56, 0x46, 0x4c, 0x01]); // venflare signature + format version 1
const saltLength = 16;
const headerLength = magic.byteLength + saltLength;
const tagLength = 16;
const nonceLength = 12;

const encoder = new TextEncoder();

export interface SettingsKeyInput {
  readonly pepper: string;
  readonly userId: string;
  readonly accountId: string;
  readonly objectKey: string;
}

interface Frame {
  readonly index: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly isLast: boolean;
}

const deriveEncryptionKey = async (
  input: SettingsKeyInput,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> => {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.pepper),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(
        `vencloud:encryption:v1:${input.userId}:${input.accountId}:${input.objectKey}`,
      ),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const chunkNonce = (index: number, isLast: boolean): Uint8Array<ArrayBuffer> => {
  const nonce = new Uint8Array(nonceLength);
  new DataView(nonce.buffer).setUint32(7, index, false);
  nonce[11] = isLast ? 1 : 0;
  return nonce;
};

const hasMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= magic.byteLength && magic.every((byte, index) => bytes[index] === byte);

export const decryptedSize = (encryptedSize: number): number | undefined => {
  if (encryptedSize < headerLength + tagLength) return undefined;
  const parts = Math.ceil(encryptedSize / encryptedPartSize);
  const remainder = encryptedSize % encryptedPartSize;
  if (parts > 1 && remainder > 0 && remainder <= tagLength) return undefined;
  return encryptedSize - headerLength - parts * tagLength;
};

async function* readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  frameSize: (index: number) => number,
  onBytes?: (totalBytes: number) => void,
): AsyncGenerator<Frame> {
  if (!reader) {
    yield { index: 0, bytes: new Uint8Array(0), isLast: true };
    return;
  }

  let completed = false;
  let totalBytes = 0;
  let bufferedBytes = 0;
  let index = 0;
  let buffer = new Uint8Array(frameSize(0));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      onBytes?.(totalBytes);

      let offset = 0;
      while (offset < value.byteLength) {
        // keep a full frame until we know it isn't the last
        if (bufferedBytes === buffer.byteLength) {
          yield { index, bytes: buffer, isLast: false };
          index += 1;
          buffer = new Uint8Array(frameSize(index));
          bufferedBytes = 0;
        }

        const bytesToCopy = Math.min(buffer.byteLength - bufferedBytes, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + bytesToCopy), bufferedBytes);
        bufferedBytes += bytesToCopy;
        offset += bytesToCopy;
      }
    }

    completed = true;
    yield { index, bytes: buffer.subarray(0, bufferedBytes), isLast: true };
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* encryptSettings(
  input: SettingsKeyInput & {
    readonly body: ReadableStream<Uint8Array> | null;
    readonly sizeLimit: number;
  },
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(saltLength));
  const header = new Uint8Array(headerLength);
  header.set(magic, 0);
  header.set(salt, magic.byteLength);

  const key = await deriveEncryptionKey(input, salt);
  const frames = readFrames(
    input.body ? new ReadableStreamDefaultReader(input.body) : undefined,
    (index) =>
      index === 0 ? encryptedPartSize - headerLength - tagLength : encryptedPartSize - tagLength,
    (totalBytes) => {
      if (totalBytes > input.sizeLimit) {
        throw new RequestRejected({ status: 413, message: "Settings are too large" });
      }
    },
  );

  for await (const frame of frames) {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: chunkNonce(frame.index, frame.isLast), additionalData: header },
        key,
        frame.bytes,
      ),
    );
    if (frame.index === 0) {
      const firstPart = new Uint8Array(headerLength + ciphertext.byteLength);
      firstPart.set(header, 0);
      firstPart.set(ciphertext, headerLength);
      yield firstPart;
    } else {
      yield ciphertext;
    }
  }
}

const openSettingsStream = async (
  input: SettingsKeyInput & { readonly stored: StoredSettings },
): Promise<StoredSettings> => {
  const size = decryptedSize(input.stored.size);
  if (size === undefined) {
    await input.stored.body.cancel().catch(() => {});
    throw new Error("Invalid encrypted settings size");
  }

  const reader = new ReadableStreamDefaultReader(input.stored.body);
  const frames = readFrames(reader, () => encryptedPartSize);
  const firstResult = await frames.next();
  if (firstResult.done) {
    throw new Error("Encrypted settings stream is empty");
  }

  try {
    const firstFrame = firstResult.value;
    if (firstFrame.bytes.byteLength < headerLength + tagLength || !hasMagic(firstFrame.bytes)) {
      throw new Error("Invalid encrypted settings header");
    }

    const header = firstFrame.bytes.subarray(0, headerLength);
    const salt = header.subarray(magic.byteLength, headerLength);
    const key = await deriveEncryptionKey(input, salt);

    const decryptFrame = async (
      frame: Frame,
      ciphertext: Uint8Array<ArrayBuffer>,
    ): Promise<Uint8Array<ArrayBuffer>> =>
      new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: chunkNonce(frame.index, frame.isLast), additionalData: header },
          key,
          ciphertext,
        ),
      );

    const firstPlaintext = await decryptFrame(firstFrame, firstFrame.bytes.subarray(headerLength));

    if (firstFrame.isLast) {
      await frames.return(undefined);
      if (firstPlaintext.byteLength !== size) {
        throw new Error("Decrypted settings size mismatch");
      }
      return { body: new Blob([firstPlaintext]).stream(), size };
    }

    let remainingBytes = size - firstPlaintext.byteLength;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstPlaintext);
      },
      async pull(controller) {
        try {
          const next = await frames.next();
          if (next.done) {
            if (remainingBytes !== 0) {
              throw new Error("Unexpected end of encrypted settings stream");
            }
            controller.close();
            return;
          }

          const plaintext = await decryptFrame(next.value, next.value.bytes);
          remainingBytes -= plaintext.byteLength;
          if (remainingBytes < 0 || (next.value.isLast && remainingBytes !== 0)) {
            throw new Error("Decrypted settings size mismatch");
          }
          controller.enqueue(plaintext);
          if (next.value.isLast) {
            await frames.return(undefined);
            controller.close();
          }
        } catch (error) {
          await frames.return(undefined).catch(() => {});
          throw error;
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
        await frames.return(undefined);
      },
    });

    return { body, size };
  } catch (error) {
    await frames.return(undefined).catch(() => {});
    throw error;
  }
};

export const decryptSettings = Effect.fn("Settings.decrypt")(
  (input: SettingsKeyInput & { readonly stored: StoredSettings }) =>
    Effect.tryPromise({
      try: () => openSettingsStream(input),
      catch: (cause) => new StorageError({ operation: "decrypt settings", cause }),
    }),
);
