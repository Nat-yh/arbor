"use client";

import { useState } from "react";

export default function AvatarPhoto({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  // Feishu supplies the image URL, and the photo fits over the letter avatar.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
    className="absolute inset-0 h-full w-full rounded-full object-cover" onError={() => setFailed(true)} />;
}
