function formatPayloadText(payload) {
  const text = payload.text || "";
  const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
  if (mediaUrls.length === 0) {
    return text;
  }
  const mediaLines = mediaUrls.map((url) => `MEDIA: ${url}`);
  return text ? `${text}\n\n${mediaLines.join("\n")}` : mediaLines.join("\n");
}

export function createFinalReplyDeliverer({ onFinalText }) {
  return async function deliver(payload, info) {
    if (info.kind !== "final") {
      return;
    }
    if (
      !payload.text &&
      !payload.mediaUrl &&
      !(payload.mediaUrls && payload.mediaUrls.length)
    ) {
      return;
    }
    await onFinalText(formatPayloadText(payload));
  };
}
