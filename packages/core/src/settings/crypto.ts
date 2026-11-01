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
  readonly account: { readonly id: string; readonly userId: string };
  readonly objectKey: string;
}

interface Frame {
  readonly index: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly isLast: boolean;
}

interface FrameOptions {
  readonly firstFrameSize: number;
  readonly frameSize: number;
  readonly sizeLimit?: number;
}

const firstPlaintextFrameSize = encryptedPartSize - headerLength - tagLength;
const plaintextFrameSize = encryptedPartSize - tagLength;

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
        `vencloud:encryption:v1:${input.account.userId}:${input.account.id}:${input.objectKey}`,
      ),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const cipherParams = (header: Uint8Array<ArrayBuffer>, frame: Frame) => {
  const nonce = new Uint8Array(nonceLength);
  new DataView(nonce.buffer).setUint32(7, frame.index, false);
  nonce[11] = frame.isLast ? 1 : 0;
  return { name: "AES-GCM", iv: nonce, additionalData: header };
};

const createHeader = (salt: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const header = new Uint8Array(headerLength);
  header.set(magic, 0);
  header.set(salt, magic.byteLength);
  return header;
};

const parseHeader = (bytes: Uint8Array<ArrayBuffer>) => {
  if (
    bytes.byteLength < headerLength + tagLength ||
    magic.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error("Invalid encrypted settings header");
  }
  const header = bytes.slice(0, headerLength);
  return { header, salt: header.subarray(magic.byteLength) };
};

export const decryptedSize = (encryptedSize: number): number | undefined => {
  if (encryptedSize < headerLength + tagLength) return undefined;
  const parts = Math.ceil(encryptedSize / encryptedPartSize);
  const finalPart = encryptedSize % encryptedPartSize;
  // non-final parts are full, so the encoder never ends on a tag-only part
  if (finalPart > 0 && finalPart <= tagLength) return undefined;
  return encryptedSize - headerLength - parts * tagLength;
};

async function* readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  { firstFrameSize, frameSize, sizeLimit = Infinity }: FrameOptions,
): AsyncGenerator<Frame> {
  if (!reader) {
    yield { index: 0, bytes: new Uint8Array(0), isLast: true };
    return;
  }

  let completed = false;
  let totalBytes = 0;
  let bufferedBytes = 0;
  let index = 0;
  let buffer = new Uint8Array(firstFrameSize);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > sizeLimit) {
        throw new RequestRejected({ status: 413, message: "Settings are too large" });
      }

      let offset = 0;
      while (offset < value.byteLength) {
        // keep a full frame until we know it isn't the last
        if (bufferedBytes === buffer.byteLength) {
          yield { index, bytes: buffer, isLast: false };
          index += 1;
          buffer = new Uint8Array(frameSize);
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

const sealFrame = async (
  key: CryptoKey,
  header: Uint8Array<ArrayBuffer>,
  frame: Frame,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.encrypt(cipherParams(header, frame), key, frame.bytes));

const openFrame = async (
  key: CryptoKey,
  header: Uint8Array<ArrayBuffer>,
  frame: Frame,
): Promise<Uint8Array<ArrayBuffer>> => {
  const ciphertext = frame.index === 0 ? frame.bytes.subarray(headerLength) : frame.bytes;
  return new Uint8Array(await crypto.subtle.decrypt(cipherParams(header, frame), key, ciphertext));
};

export async function* encryptSettings(
  input: SettingsKeyInput & {
    readonly body: ReadableStream<Uint8Array> | null;
    readonly sizeLimit: number;
  },
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(saltLength));
  const header = createHeader(salt);
  const key = await deriveEncryptionKey(input, salt);
  const frames = readFrames(input.body ? new ReadableStreamDefaultReader(input.body) : undefined, {
    firstFrameSize: firstPlaintextFrameSize,
    frameSize: plaintextFrameSize,
    sizeLimit: input.sizeLimit,
  });

  for await (const frame of frames) {
    const ciphertext = await sealFrame(key, header, frame);
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

const decryptFrames = async function* (
  frames: AsyncGenerator<Frame>,
  key: CryptoKey,
  header: Uint8Array<ArrayBuffer>,
  size: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  let remaining = size;
  for await (const frame of frames) {
    const plaintext = await openFrame(key, header, frame);
    remaining -= plaintext.byteLength;
    if (remaining < 0 || (frame.isLast && remaining !== 0)) {
      throw new Error("Decrypted settings size mismatch");
    }
    yield plaintext;
    if (frame.isLast) return;
  }
  if (remaining !== 0) throw new Error("Unexpected end of encrypted settings stream");
};

const streamFrom = <T>(
  iterable: AsyncGenerator<T>,
  cancel: (reason: unknown) => Promise<void>,
): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await cancel(reason);
      await iterator.return(undefined).catch(() => {});
    },
  });
};

const openSettingsStream = async (
  input: SettingsKeyInput & { readonly stored: StoredSettings },
): Promise<StoredSettings> => {
  const size = decryptedSize(input.stored.size);
  if (size === undefined) {
    await input.stored.body.cancel().catch(() => {});
    throw new Error("Invalid encrypted settings size");
  }

  const reader = new ReadableStreamDefaultReader(input.stored.body);
  const frames = readFrames(reader, {
    firstFrameSize: Math.min(encryptedPartSize, input.stored.size),
    frameSize: encryptedPartSize,
  });

  try {
    const first = await frames.next();
    if (first.done) throw new Error("Encrypted settings stream is empty");

    const { header, salt } = parseHeader(first.value.bytes);
    const key = await deriveEncryptionKey(input, salt);
    const firstPlaintext = await openFrame(key, header, first.value);

    if (first.value.isLast) {
      if (firstPlaintext.byteLength !== size) {
        throw new Error("Decrypted settings size mismatch");
      }
      await frames.return(undefined);
      return { body: new Blob([firstPlaintext]).stream(), size };
    }

    const plaintextFrames = (async function* () {
      try {
        yield firstPlaintext;
        yield* decryptFrames(frames, key, header, size - firstPlaintext.byteLength);
      } finally {
        await frames.return(undefined).catch(() => {});
      }
    })();

    return {
      body: streamFrom(plaintextFrames, (reason) => reader.cancel(reason).catch(() => {})),
      size,
    };
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
