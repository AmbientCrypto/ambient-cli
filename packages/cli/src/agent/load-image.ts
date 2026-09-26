import { IMAGE_EDGE_HIGH } from "@amb/context";
import type { ImageAttachment } from "@amb/protocol";
import { saveObject } from "@amb/sessions";
import { downscaleForWindow, readImageFile } from "../tui/capture.js";

/** Load an image file for the conversation (`view_image`): checked, sized like an attachment, and stored
 *  with the session so a resume can bring it back. */
export function makeImageLoader(sessionId: string): (absPath: string) => Promise<ImageAttachment> {
  return async (absPath) => {
    // The exact path view_image checked — never re-cleaned into a different one.
    const res = await readImageFile(absPath, "file");
    if (!res.ok) throw new Error(res.reason);
    const sized = await downscaleForWindow(res.attachment, IMAGE_EDGE_HIGH);
    saveObject(sessionId, sized.dataBase64);
    return sized;
  };
}
