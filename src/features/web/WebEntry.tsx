import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import App from "../../App";
import { DownloadPage } from "./DownloadPage";

export function WebEntry({ onInitialSessionResolved }: { onInitialSessionResolved: (authenticated: boolean) => void }) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => onInitialSessionResolved(false), [onInitialSessionResolved]);

  // Hash navigation works with the static nginx image used by docker-compose.live.
  if (hash === "#/login") return <>
    <a className="web-back-downloads" href="#"><ArrowLeft size={16} aria-hidden="true" />Downloads</a>
    <App onInitialSessionResolved={onInitialSessionResolved} />
  </>;
  return <DownloadPage />;
}
