import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../colab/connection";
import { version as packageVersion } from "../../../package.json";

export function About() {
  const [version, setVersion] = useState(packageVersion);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    void invoke<{ app_version: string }>("app_info")
      .then((info) => {
        if (active && info.app_version) setVersion(info.app_version);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  return (
    <div className="page narrow-page about-page">
      <header className="about-intro">
        <div className="about-intro-copy">
          <span className="about-overline">SOBRE</span>
          <h1>Behavior Tracker</h1>
          <p>Aplicativo para organização de experimentos e análise de comportamento animal em vídeo.</p>
          <div className="about-version"><span>VERSÃO</span><strong>{version}</strong></div>
        </div>
        <div className="about-intro-mark">
          <img src="/RatLogo_white.png" alt="Logo do Behavior Tracker" />
        </div>
      </header>

      <section className="about-authorship" aria-labelledby="about-authors-title">
        <h2 id="about-authors-title">Desenvolvido por</h2>
        <div className="about-author-list">
          <p>Gabriel Santos</p>
          <p>Thiago Vargas</p>
        </div>
      </section>

      <section className="about-partnership" aria-labelledby="about-partners-title">
        <h2 id="about-partners-title">Parceria institucional</h2>
        <div className="about-institutions">
          <div className="about-logo-frame"><img className="about-logo-neurocell" src="/neurocell.png" alt="Laboratório Neurocell" /></div>
          <div className="about-logo-frame"><img className="about-logo-neurolab" src="/neurolab.png" alt="NeuroLab" /></div>
          <div className="about-logo-frame"><img className="about-logo-ufpel" src="/ufpel.png" alt="Universidade Federal de Pelotas (UFPel)" /></div>
        </div>
      </section>
    </div>
  );
}
