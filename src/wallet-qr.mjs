import QRCode from "qrcode";

export function createPhantomBrowseLink(publicAppUrl) {
  let appUrl;
  try {
    appUrl = new URL(publicAppUrl);
  } catch {
    throw new TypeError("PUBLIC_APP_URL must be a valid URL");
  }
  if (appUrl.protocol !== "https:") throw new TypeError("PUBLIC_APP_URL must use HTTPS");

  const encodedUrl = encodeURIComponent(appUrl.href);
  const ref = encodeURIComponent(appUrl.origin);
  return `https://phantom.app/ul/browse/${encodedUrl}?ref=${ref}`;
}

export async function createPhantomQrSvg(publicAppUrl) {
  const deepLink = createPhantomBrowseLink(publicAppUrl);
  return QRCode.toString(deepLink, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: { dark: "#101315", light: "#f4f6f0" }
  });
}
