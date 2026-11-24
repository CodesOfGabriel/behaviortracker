import { useState } from "react";
import { Download, LogIn } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { desktopRelease, desktopReleaseUrl, installerUrl } from "./downloads";

function SystemIcon({ system }: { system: "mac" | "windows" | "linux" }) {
  if (system === "mac") return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16.4 3.1c.7-.9 1.2-2.1 1-3.1-1.1.1-2.5.8-3.3 1.7-.7.8-1.3 2-1.1 3.1 1.3.1 2.6-.6 3.4-1.7ZM20.5 17.3c-.5 1.1-.7 1.6-1.3 2.6-.9 1.4-2.1 3.2-3.7 3.2-1.4 0-1.7-.9-3.6-.9s-2.3.9-3.7.9c-1.5 0-2.7-1.6-3.6-3-2.5-3.9-2.8-8.4-1.3-10.7 1.1-1.7 2.7-2.7 4.3-2.7 1.6 0 2.6.9 3.9.9 1.2 0 2-.9 3.9-.9 1.4 0 2.9.8 4 2.1-3.5 1.9-3 6.9 1.1 8.5Z" />
  </svg>;
  if (system === "windows") return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="m1 3 9-1.3v9.8H1V3Zm10.5-1.5L23 0v11.5H11.5v-10ZM1 13h9v9.3L1 21V13Zm10.5 0H23v11l-11.5-1.5V13Z" />
  </svg>;
  return <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M11 11c-2 3-5 7-5 12 0 5 20 5 20 0 0-5-3-9-5-12 1-9-11-9-10 0Z" fill="currentColor" />
    <ellipse cx="16" cy="21" rx="6.5" ry="7" fill="#111a16" />
    <ellipse cx="13.5" cy="10" rx="2" ry="3" fill="#111a16" /><ellipse cx="18.5" cy="10" rx="2" ry="3" fill="#111a16" />
    <circle cx="14" cy="10" r=".8" fill="currentColor" /><circle cx="18" cy="10" r=".8" fill="currentColor" />
    <path d="m12 14 4-2 4 2-4 3-4-3ZM9 23l-6 4 8 2 2-4-4-2Zm14 0 6 4-8 2-2-4 4-2Z" fill="currentColor" />
  </svg>;
}

export function DownloadPage() {
  const [macChip, setMacChip] = useState("silicon");
  return <div className="download-page">
    <a className="download-skip" href="#downloads">Ir para downloads</a>
    <header className="download-header">
      <a className="download-brand" href="#" aria-label="Behavior Tracker, página inicial">
        <img src="/RatLogo_white.png" alt="" width="40" height="40" />
        <span>Behavior Tracker</span>
      </a>
      <a className="download-login" href="#/login"><LogIn size={18} aria-hidden="true" /><span>Entrar</span></a>
    </header>
    <main id="downloads" className="download-main">
      <div className="download-intro">
        <div className="download-logo"><img src="/RatLogo_white.png" alt="Logo do Behavior Tracker" width="112" height="112" /></div>
        <p className="download-eyebrow">Behavior Tracker · Desktop</p>
        <h1>Baixe agora<span>!</span></h1>
        <p className="download-description">Sua pesquisa em movimento.<br />Escolha seu sistema e comece a analisar.</p>
      </div>
      <div className="download-platforms" aria-label="Instaladores por sistema operacional">
        <Card className="download-card">
          <CardHeader className="download-card-heading">
            <span className="download-system-icon"><SystemIcon system="mac" /></span>
            <CardTitle><h2>macOS</h2><p>Escolha o chip do seu Mac</p></CardTitle>
          </CardHeader>
          <CardContent className="download-card-body">
            <Tabs value={macChip} onValueChange={setMacChip} className="download-mac-tabs">
              <TabsList className="download-chip-tabs" aria-label="Processador do Mac">
                <TabsTrigger value="silicon">Apple Silicon</TabsTrigger>
                <TabsTrigger value="intel">Intel</TabsTrigger>
              </TabsList>
              {(["silicon", "intel"] as const).map(chip => <TabsContent key={chip} value={chip}>
                <a className="download-button" href={installerUrl(chip === "intel" ? "mac-intel" : "mac-silicon")}
                  aria-label={`Baixar para macOS ${chip === "intel" ? "Intel" : "Apple Silicon"}`}>
                  <Download size={17} aria-hidden="true" />Baixar para Mac<span>.dmg</span>
                </a>
              </TabsContent>)}
            </Tabs>
            <p className="download-card-note">Veja o chip em <strong> → Sobre Este Mac</strong>.</p>
          </CardContent>
        </Card>
        <Card className="download-card">
          <CardHeader className="download-card-heading">
            <span className="download-system-icon"><SystemIcon system="windows" /></span>
            <CardTitle><h2>Windows</h2><p>Para computadores de 64 bits</p></CardTitle>
          </CardHeader>
          <CardContent className="download-card-body">
            <div className="download-format">Instalador para Windows <span>x64</span></div>
            <a className="download-button" href={installerUrl("windows")} aria-label="Baixar para Windows x64">
              <Download size={17} aria-hidden="true" />Baixar para Windows<span>.exe</span>
            </a>
            <p className="download-card-note">Instale e abra o aplicativo no seu computador.</p>
          </CardContent>
        </Card>
        <Card className="download-card">
          <CardHeader className="download-card-heading">
            <span className="download-system-icon"><SystemIcon system="linux" /></span>
            <CardTitle><h2>Linux</h2><p>Para distribuições de 64 bits</p></CardTitle>
          </CardHeader>
          <CardContent className="download-card-body">
            <div className="download-format">Aplicativo para Linux <span>x64</span></div>
            <a className="download-button" href={installerUrl("linux-appimage")} aria-label="Baixar para Linux x64 AppImage">
              <Download size={17} aria-hidden="true" />Baixar para Linux<span>.AppImage</span>
            </a>
            <p className="download-card-note">Ubuntu ou Debian? <a href={installerUrl("linux-deb")}>Baixar .deb</a></p>
          </CardContent>
        </Card>
      </div>
      <p className="download-release">Versão {desktopRelease.version}<span aria-hidden="true">·</span><a href={desktopReleaseUrl} target="_blank" rel="noopener noreferrer">Notas da versão</a></p>
    </main>
    <footer className="download-footer">
      <span>Análise comportamental de roedores</span>
      <nav aria-label="Documentos legais"><a href="/privacy/">Privacidade</a><a href="/terms/">Termos de serviço</a></nav>
    </footer>
  </div>;
}
