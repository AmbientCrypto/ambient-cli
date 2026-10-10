import { randomUUID } from "node:crypto";
import { type ImageAttachment, toAttachmentRef } from "@amb/protocol";
import { type SessionWriter, saveObject } from "@amb/sessions";

export interface SteeringMessage {
  text: string;
  messageId: string;
}

const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export function assertQueueCapacity(
  queue: readonly { text: string; attachments?: readonly ImageAttachment[] }[],
  text: string,
  attachments: readonly ImageAttachment[],
): void {
  if (queue.length >= MAX_QUEUED_MESSAGES)
    throw new Error("message queue is full; wait for queued messages to be read");
  const bytes = [...queue, { text, attachments }].reduce(
    (sum, message) =>
      sum +
      Buffer.byteLength(message.text) +
      (message.attachments ?? []).reduce(
        (total, image) => total + Buffer.byteLength(image.dataBase64),
        0,
      ),
    0,
  );
  if (bytes > MAX_QUEUED_BYTES)
    throw new Error(
      "message queue exceeds its safe size; shorten the message or remove an attachment",
    );
}

/** Persist before clearing input or waking a wait. A failed write leaves the user's composer intact. */
export function acceptQueuedMessage(
  writer: SessionWriter | null,
  sessionId: string | null,
  text: string,
  attachments: readonly ImageAttachment[],
  messageId: string = randomUUID(),
): SteeringMessage {
  if (!writer || !sessionId) throw new Error("session is not ready to accept queued messages");
  const message = { text, messageId };
  writer.append({
    schemaVersion: 1,
    kind: "steer.queued",
    sessionId,
    ...message,
    ...(attachments.length
      ? {
          attachments: attachments.map((image) => ({
            ...toAttachmentRef(image),
            objectRef: saveObject(sessionId, image.dataBase64),
          })),
        }
      : {}),
  });
  return message;
}
