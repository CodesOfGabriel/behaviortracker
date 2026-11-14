import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WindowChrome } from "./components/WindowChrome";
import { AppStoreProvider } from "./store/AppStore";
import { isTauriRuntime } from "./features/colab/connection";
import "./styles.css";

const rootElement = document.getElementById("root")!;
const splashElement = document.getElementById("startup-splash");
const splashImage = splashElement?.querySelector("img");
// loading.gif tem um ciclo de 7,2 s; exiba pelo menos metade antes da transição.
const minimumGifPlayMs = 3600;
let revealStarted = false;

const splashImageReadyAt = new Promise<number | null>((resolve) => {
  if (!splashImage) {
    resolve(null);
    return;
  }
  if (splashImage.complete) {
    resolve(splashImage.naturalWidth > 0 ? performance.now() : null);
    return;
  }
  let settled = false;
  let timeoutId: number;
  const finish = (readyAt: number | null) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeoutId);
    splashImage.removeEventListener("load", onLoad);
    splashImage.removeEventListener("error", onError);
    resolve(readyAt);
  };
  const onLoad = () => finish(performance.now());
  const onError = () => finish(null);
  splashImage.addEventListener("load", onLoad);
  splashImage.addEventListener("error", onError);
  timeoutId = window.setTimeout(onError, 5000);
});

function revealApp() {
  if (revealStarted) return;
  revealStarted = true;
  void splashImageReadyAt.then((readyAt) => {
    const remainingMs = readyAt == null ? 0 : Math.max(0, readyAt + minimumGifPlayMs - performance.now());
    window.setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!splashElement) {
          rootElement.removeAttribute("inert");
          return;
        }
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          splashElement.remove();
          rootElement.removeAttribute("inert");
          document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#171c18");
        };
        splashElement.addEventListener("transitionend", (event) => {
          if (event.target === splashElement && event.propertyName === "opacity") finish();
        }, { once: true });
        splashElement.classList.add("startup-splash-leaving");
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
        else window.setTimeout(finish, 650);
      }));
    }, remainingMs);
  });
}

const desktop = isTauriRuntime();
if (desktop) document.documentElement.classList.add("desktop-chrome");
if (desktop && /Mac/i.test(navigator.platform)) document.documentElement.classList.add("desktop-chrome-mac");

createRoot(rootElement).render(
  <StrictMode>
    {desktop && <WindowChrome />}
    <AppStoreProvider>
      <App onReady={revealApp} />
    </AppStoreProvider>
  </StrictMode>,
);

