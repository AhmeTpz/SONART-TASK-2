"use client";

import { CircleAlert, RefreshCw } from "lucide-react";
import { useEffect } from "react";

export default function ErrorPage({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="fatal-error">
      <div><CircleAlert size={30} /></div><span className="eyebrow">Veri işleme hatası</span><h1>Dashboard güvenle oluşturulamadı</h1><p>{error.message}</p>
      <button type="button" onClick={unstable_retry}><RefreshCw size={17} /> Yeniden dene</button>
    </main>
  );
}
