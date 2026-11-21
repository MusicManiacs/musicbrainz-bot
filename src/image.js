// Baja la imagen del poster. El tipo se decide por los bytes, no por el
// Content-Type que declare el servidor.

export class ImageError extends Error {}

const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
];

export function sniffImage(buffer) {
  return SIGNATURES.find(({ magic }) => magic.every((b, i) => buffer[i] === b)) ?? null;
}

export async function downloadImage(rawUrl, { maxBytes, timeoutMs = 30000, userAgent, fetchImpl = fetch }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageError('"image_url" is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImageError('"image_url" must be http(s)');
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    throw new ImageError(`could not download the image: ${error.message}`);
  }
  if (!response.ok) throw new ImageError(`could not download the image: HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new ImageError(`the image is larger than ${maxBytes} bytes`);

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new ImageError(`the image is larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const type = sniffImage(buffer);
  if (!type) throw new ImageError('the image is not a JPEG, PNG or GIF');
  return { buffer, mimeType: type.mime, name: `poster.${type.ext}` };
}
