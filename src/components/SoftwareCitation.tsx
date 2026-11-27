import { scientificPublication, scientificReference } from "../lib/scientific-publication";

export function SoftwareCitation() {
  return <section className="software-citation" aria-labelledby="software-citation-title">
    <h2 id="software-citation-title">Publicação científica</h2>
    <p className="software-citation-meta">
      Versão científica arquivada: <strong>{scientificPublication.version}</strong>
      <span aria-hidden="true"> · </span>
      Release: <time dateTime={scientificPublication.releasedAt}>{scientificPublication.displayDate}</time>
    </p>
    <blockquote>
      <p>{scientificReference} <a href={scientificPublication.url} target="_blank" rel="noopener noreferrer">{scientificPublication.url}</a></p>
    </blockquote>
    <p className="software-citation-note">Referência para citação do código-fonte. O DOI não estabelece validação científica independente.</p>
  </section>;
}
