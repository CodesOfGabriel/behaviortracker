import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BrandMark } from "../../components/BrandMark";
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
      <div className="page-heading">
        <div>
          <span className="eyebrow">APLICATIVO</span>
          <h1>Sobre</h1>
        </div>
      </div>
      <section className="panel about-panel" aria-labelledby="about-title">
        <BrandMark size={48} />
        <div className="about-content">
          <h2 id="about-title">Behavior Tracker</h2>
          <p>
            Desenvolvido por <strong>Gabriel Santos</strong> e <strong>Thiago Vargas</strong>, uma parceria entre o <strong>Laboratório Neurocell</strong> e o <strong>NeuroLab da Universidade Federal de Pelotas (UFPel)</strong>.
          </p>
          <div className="about-version">Versão <strong>{version}</strong></div>
        </div>
      </section>
    </div>
  );
}
