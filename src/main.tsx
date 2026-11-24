import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WebEntry } from "./features/web/WebEntry";
import { WindowChrome } from "./components/WindowChrome";
import { AppStoreProvider } from "./store/AppStore";
import { isTauriRuntime } from "./features/colab/connection";
import "./styles.css";

const rootElement = document.getElementById("root")!;
const splashElement = document.getElementById("startup-splash");
const splashImage = splashElement?.querySelector("img");
// loading.gif tem um ciclo de 7,2 s; exiba pelo menos metade antes da transição.
const minimumGifPlayMs = 3600;
let initialSessionHandled = false;

function finishStartup() {
  splashElement?.remove();
  rootElement.removeAttribute("inert");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#171c18");
}

function revealApp(authenticated: boolean) {
  if (initialSessionHandled) return;
  initialSessionHandled = true;
  if (!authenticated || !splashElement || !splashImage) {
    finishStartup();
    return;
  }

  rootElement.setAttribute("inert", "");
  splashElement.classList.add("startup-splash-visible");
  const splashImageReadyAt = new Promise<number | null>((resolve) => {
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
    splashImage.src = splashImage.dataset.src ?? "";
  });

  void splashImageReadyAt.then((readyAt) => {
    const remainingMs = readyAt == null ? 0 : Math.max(0, readyAt + minimumGifPlayMs - performance.now());
    window.setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          finishStartup();
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
      {desktop ? <App onInitialSessionResolved={revealApp} /> : <WebEntry onInitialSessionResolved={revealApp} />}
    </AppStoreProvider>
  </StrictMode>,
);

