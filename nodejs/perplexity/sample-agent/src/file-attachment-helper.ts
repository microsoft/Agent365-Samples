// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";
import mammoth from "mammoth";
import * as pdfParse from "pdf-parse";
import { TurnContext } from "@microsoft/agents-hosting";
import { Attachment } from "@microsoft/agents-activity";

/**
 * Local “view” of a 3rd-party Attachment where we can strongly type `content`.
 * NOTE: This does NOT change the 3rd-party type; it’s just a local helper.
 */
type AttachmentWithContent<C> = Omit<Attachment, "content"> & { content?: C };

const TEAMS_FILE_DOWNLOAD_INFO =
  "application/vnd.microsoft.teams.file.download.info" as const;

type FileAttachmentContent = {
  fileType?: string;
  uniqueId?: string;
};

type TeamsFileAttachment = AttachmentWithContent<FileAttachmentContent> & {
  contentType: typeof TEAMS_FILE_DOWNLOAD_INFO;
};

/**
 * Runtime type guard:
 * Narrows Attachment -> TeamsFileAttachment (so `content?.fileType` is safe).
 */
function isTeamsFileAttachment(att: Attachment): att is TeamsFileAttachment {
  if (att.contentType !== TEAMS_FILE_DOWNLOAD_INFO) return false;

  // content is `unknown` in 3rd party type; validate shape at runtime
  if (att.content == null) return true;
  if (typeof att.content !== "object") return false;

  const c = att.content as Record<string, unknown>;

  if (
    "fileType" in c &&
    c["fileType"] != null &&
    typeof c["fileType"] !== "string"
  ) {
    return false;
  }
  if (
    "uniqueId" in c &&
    c["uniqueId"] != null &&
    typeof c["uniqueId"] !== "string"
  ) {
    return false;
  }

  return true;
}

type DownloadedFile = {
  name: string;
  contentType: string;
  content: Buffer;
  size: number;
};

export type ImageAttachmentOut = {
  name: string;
  base64: string;
  contentType: string;
};

type TextContentOut = {
  fileName: string;
  text: string;
};

type FetchFileAttachmentsResult = {
  textContents: TextContentOut[];
  imageAttachments: ImageAttachmentOut[];
};

/**
 * Normalizes content type to proper MIME type format
 * @param contentType - The content type (may be just extension like 'jpg')
 * @param fileName - The file name to infer type from if needed
 * @returns Proper MIME type
 */
function normalizeContentType(contentType: string, fileName: string): string {
  // If it already looks like a proper MIME type, return it
  if (contentType && contentType.includes("/")) {
    return contentType;
  }

  // Map common extensions to MIME types
  const ext = (contentType || fileName.split(".").pop() || "").toLowerCase();
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Gets a Microsoft Graph client using the provided access token.
 * @param accessToken - The access token for Graph API
 * @returns A configured Graph client
 */
function getGraphClient(accessToken: string | null) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

/**
 * Fetches file attachment content from Microsoft Graph API using app-only auth.
 * Handles token acquisition internally using PRESENCE app credentials.
 */
export async function fetchFileAttachments(
  context: TurnContext
): Promise<FetchFileAttachmentsResult> {
  const attachments = context.activity?.attachments;

  if (!attachments || attachments.length === 0) {
    return { textContents: [], imageAttachments: [] };
  }

  // ✅ Type-safe filter + narrowing
  const fileAttachments = attachments.filter(isTeamsFileAttachment);

  if (fileAttachments.length === 0) {
    return { textContents: [], imageAttachments: [] };
  }

  console.log(`📎 Fetching ${fileAttachments.length} file attachment(s)...`);

  // Get tenant ID and user AAD Object ID
  const tenantId: string | undefined =
    context.activity.channelData?.tenant?.id ||
    context.activity.conversation?.tenantId;

  const userAadObjectId: string | undefined =
    context.activity.from?.aadObjectId;

  if (!tenantId) {
    console.error("⚠️ Missing tenant ID");
    return { textContents: [], imageAttachments: [] };
  }

  if (!userAadObjectId) {
    console.error("⚠️ Missing user AAD Object ID");
    return { textContents: [], imageAttachments: [] };
  }

  // Get Graph token using PRESENCE app credentials (has Files.Read.All Application permission)
  let graphToken: string | null = null;
  try {
    const credential = new ClientSecretCredential(
      tenantId,
      process.env["PRESENCE_CLIENTID"] || "unknown-bot",
      process.env["PRESENCE_CLIENTSECRET"] || "unknown-secret"
    );

    const tokenResponse = await credential.getToken([
      "https://graph.microsoft.com/.default",
    ]);

    graphToken = tokenResponse?.token ?? null;

    if (!graphToken) {
      console.error("⚠️ Failed to acquire Graph token");
      return { textContents: [], imageAttachments: [] };
    }
  } catch (tokenError) {
    console.error("⚠️ Token acquisition error:", (tokenError as Error).message);
    return { textContents: [], imageAttachments: [] };
  }

  const graphClient = getGraphClient(graphToken);
  const results: DownloadedFile[] = [];

  for (const attachment of fileAttachments) {
    try {
      const contentUrl = attachment.contentUrl;
      const fileName = attachment.name ?? "unknown";
      const fileType = attachment.content?.fileType;

      console.log(`   Processing: ${fileName}`);

      if (contentUrl) {
        // Try downloading directly from contentUrl with Graph token
        try {
          const headers = {
            Authorization: `Bearer ${graphToken}`,
          };

          const response = await fetch(contentUrl, { headers });

          if (response.ok) {
            const content = await response.arrayBuffer();

            results.push({
              name: fileName,
              contentType: fileType || "application/octet-stream",
              content: Buffer.from(content),
              size: content.byteLength,
            });

            console.log(`   ✅ ${fileName} (${content.byteLength} bytes)`);
            continue; // Success, move to next attachment
          }
        } catch {
          // Direct download failed, fall back to Graph API below
        }

        // Fallback to Graph API with app-only auth
        const uniqueId = attachment.content?.uniqueId;

        if (!uniqueId) {
          console.error(`   ⚠️ Missing uniqueId for ${fileName}`);
          continue;
        }

        // Get the drive item using app-only auth with Files.Read.All permission
        const driveItem = (await graphClient
          .api(`/users/${userAadObjectId}/drive/items/${uniqueId}`)
          .get()) as Record<string, unknown>;

        // Get the download URL
        const downloadUrl = driveItem["@microsoft.graph.downloadUrl"];

        if (typeof downloadUrl === "string" && downloadUrl) {
          // Download the file content using the authenticated download URL
          const response = await fetch(downloadUrl);

          if (response.ok) {
            const content = await response.arrayBuffer();

            results.push({
              name: fileName,
              contentType: fileType || "application/octet-stream",
              content: Buffer.from(content),
              size: content.byteLength,
            });

            console.log(`   ✅ ${fileName} (${content.byteLength} bytes)`);
          } else {
            console.error(`   ⚠️ Download failed: HTTP ${response.status}`);
          }
        } else {
          console.error(`   ⚠️ Missing downloadUrl for ${fileName}`);
        }
      } else {
        console.error(`   ⚠️ Missing contentUrl for ${fileName}`);
      }
    } catch (error) {
      console.error(
        `   ⚠️ Failed: ${attachment.name ?? "unknown"} - ${
          (error as Error).message
        }`
      );
    }
  }

  if (results.length > 0) {
    console.log(`✅ Downloaded ${results.length} file(s)`);
  }

  // Process files: extract text from documents, prepare images
  const textContents: TextContentOut[] = [];
  const imageAttachments: ImageAttachmentOut[] = [];

  for (const file of results) {
    // Check if it's an image file
    const isImage =
      file.contentType?.startsWith("image/") ||
      /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.name);

    if (isImage) {
      // Send images as base64 attachments
      imageAttachments.push({
        name: file.name,
        base64: file.content.toString("base64"),
        contentType: normalizeContentType(file.contentType, file.name),
      });
      console.log(`🖼️ Added image: ${file.name}`);
      continue;
    }

    // Check if it's a DOCX file
    const isDocx = /\.docx?$/i.test(file.name);
    // Check if it's a PDF file
    const isPdf = /\.pdf$/i.test(file.name);

    try {
      let extractedText = "";

      if (isDocx) {
        // Extract text from DOCX
        console.log(`📄 Extracting text from DOCX: ${file.name}`);
        const result = await mammoth.extractRawText({
          buffer: file.content,
        });
        extractedText = result.value;
        console.log(
          `✅ Extracted ${extractedText.length} characters from ${file.name}`
        );
      } else if (isPdf) {
        // Extract text from PDF
        console.log(`📄 Extracting text from PDF: ${file.name}`);
        const data = await (pdfParse as any).default(file.content);
        extractedText = data.text;
        console.log(
          `✅ Extracted ${extractedText.length} characters from ${file.name}`
        );
      } else {
        // Try as plain text
        extractedText = file.content.toString("utf-8");
        console.log(`📄 Added text content: ${file.name}`);
      }

      if (extractedText.trim()) {
        textContents.push({
          fileName: file.name,
          text: extractedText,
        });
      }
    } catch (err) {
      console.log(
        `⚠️ Could not extract text from file: ${file.name}`,
        (err as Error).message
      );
    }
  }

  return {
    textContents,
    imageAttachments,
  };
}
