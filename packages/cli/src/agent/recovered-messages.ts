import { createHash } from "node:crypto";
import { type Event, type ImageAttachment, ImageAttachmentSchema } from "@amb/protocol";
import { pendingMessages, readObject } from "@amb/sessions";

export interface RecoveredMessage {
  text: string;
  messageId: string;
  attachments: ImageAttachment[];
}

export function recoverMessages(sessionId: string, events: Event[]): RecoveredMessage[] {
  return pendingMessages(events).map((message) => {
    const attachments = (message.attachments ?? []).map((ref) => {
      if (!ref.objectRef || ref.bytes > 8 * 1024 * 1024)
        throw new Error("queued attachment is unavailable; reattach it before resuming");
      const dataBase64 = readObject(sessionId, ref.objectRef, undefined, 12 * 1024 * 1024);
      if (!dataBase64)
        throw new Error("queued attachment is missing or damaged; reattach it before resuming");
      const bytes = Buffer.from(dataBase64, "base64");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== ref.bytes || digest !== ref.sha256.replace(/^sha256:/, ""))
        throw new Error("queued attachment failed integrity validation");
      return ImageAttachmentSchema.parse({ ...ref, dataBase64 });
    });
    return { text: message.text, messageId: message.messageId, attachments };
  });
}
